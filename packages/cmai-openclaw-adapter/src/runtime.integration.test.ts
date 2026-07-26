import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fixtureTimestamp,
  validChallengeGetResponseFixture,
  validContributionCardV1,
  validPairingStateFixture,
} from "../../../lib/agent-protocol/fixtures";
import type { OpenClawLlmCompleteBridge } from "./inference";
import { allowsExactOpenClawLlmTarget, executeOpenClawCommand, type OpenClawCommandRuntimeContext } from "./runtime";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function responseForEnvelope(envelope: Record<string, unknown>): Response {
  const operation = envelope.operation;
  const requestId = String(envelope.request_id);
  if (operation === "pair.create") {
    const payload = envelope.payload as Record<string, unknown>;
    const publicKey = payload.public_key as Record<string, unknown>;
    return Response.json({
      protocol: "CMAI_AGENT_PROTOCOL_V1",
      protocol_version: "1.2",
      request_id: requestId,
      server_time: fixtureTimestamp,
      result: {
        pairing: {
          ...validPairingStateFixture,
          device_id: (payload.device as Record<string, unknown>).device_id,
          granted_scopes: payload.requested_scopes,
          keys: [{
            key_id: publicKey.key_id,
            generation: publicKey.generation,
            status: "active",
            activated_at: fixtureTimestamp,
          }],
        },
      },
    }, { status: 201 });
  }
  if (operation === "pairing.revoke") {
    return Response.json({
      protocol: "CMAI_AGENT_PROTOCOL_V1",
      protocol_version: "1.2",
      request_id: requestId,
      server_time: fixtureTimestamp,
      result: {
        pairing: {
          ...validPairingStateFixture,
          status: "revoked",
          revoked_at: fixtureTimestamp,
          updated_at: fixtureTimestamp,
          keys: validPairingStateFixture.keys.map((key) => ({
            ...key,
            status: "revoked",
            revoked_at: fixtureTimestamp,
          })),
        },
      },
    }, { status: 200 });
  }
  if (operation === "challenge.get") {
    const nowMs = Date.now();
    const issuedAt = new Date(nowMs - 1_000).toISOString();
    const expiresAt = new Date(nowMs + (9 * 60_000)).toISOString();
    return Response.json({
      ...validChallengeGetResponseFixture,
      request_id: requestId,
      server_time: issuedAt,
      result: {
        challenge: {
          ...validChallengeGetResponseFixture.result.challenge,
          run_grant: {
            ...validChallengeGetResponseFixture.result.challenge.run_grant,
            issued_at: issuedAt,
            expires_at: expiresAt,
          },
        },
      },
    }, { status: 200 });
  }
  throw new Error(`Unexpected protocol operation ${String(operation)}`);
}

function fakeApi(stateRoot: string, llm?: OpenClawLlmCompleteBridge): OpenClawPluginApi {
  return {
    pluginConfig: { baseUrl: "http://127.0.0.1:3999", displayName: "Integration Agent" },
    runtime: {
      version: "2026.7.1",
      state: { resolveStateDir: () => stateRoot },
      ...(llm ? { llm } : {}),
    },
  } as unknown as OpenClawPluginApi;
}

function commandContext(llm: OpenClawLlmCompleteBridge): OpenClawCommandRuntimeContext {
  return {
    agentId: "agent-test",
    llm,
    config: {
      agents: {
        defaults: { model: { primary: "test-provider/test-model" } },
        list: [{ id: "agent-test" }],
      },
      plugins: {
        entries: {
          "cmai-openclaw": {
            llm: {
              allowModelOverride: true,
              allowAgentIdOverride: true,
              allowedModels: ["test-provider/test-model"],
            },
          },
        },
      },
    },
  };
}

describe("OpenClaw runtime command continuity", () => {
  it("requires exact non-wildcard per-plugin LLM policy before any CMAI fetch", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "cmai-openclaw-runtime-policy-"));
    directories.push(stateRoot);
    const fetchFn = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchFn);
    const llmComplete = vi.fn<OpenClawLlmCompleteBridge["complete"]>();
    const approvedContext = commandContext({ complete: llmComplete });
    expect(allowsExactOpenClawLlmTarget(approvedContext.config, "test-provider/test-model")).toBe(true);
    const missingPolicyContext: OpenClawCommandRuntimeContext = {
      agentId: "agent-test",
      llm: { complete: llmComplete },
      config: { agents: { defaults: { model: { primary: "test-provider/test-model" } }, list: [{ id: "agent-test" }] } },
    };
    expect(allowsExactOpenClawLlmTarget(missingPolicyContext.config, "test-provider/test-model")).toBe(false);
    expect(allowsExactOpenClawLlmTarget({
      ...approvedContext.config as Record<string, unknown>,
      plugins: { entries: { "cmai-openclaw": { llm: {
        allowModelOverride: true,
        allowAgentIdOverride: true,
        allowedModels: ["*"],
      } } } },
    }, "test-provider/test-model")).toBe(false);

    const api = fakeApi(stateRoot, { complete: llmComplete });
    const result = await executeOpenClawCommand(api, "run challenge_protocol_1", missingPolicyContext);
    expect(result).toMatchObject({ ok: false, code: "bounded_inference_policy_required" });
    expect(result.text).toContain('allowedModels=["test-provider/test-model"]');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(llmComplete).not.toHaveBeenCalled();

    const slashWithoutScopedLlm = { ...approvedContext, llm: undefined };
    const genericLlmComplete = vi.fn<OpenClawLlmCompleteBridge["complete"]>();
    const genericApi = fakeApi(stateRoot, { complete: genericLlmComplete });
    expect(await executeOpenClawCommand(genericApi, "run challenge_protocol_1", slashWithoutScopedLlm))
      .toMatchObject({ ok: false, code: "bounded_inference_policy_required" });
    expect(fetchFn).not.toHaveBeenCalled();
    expect(genericLlmComplete).not.toHaveBeenCalled();
  });

  it("persists preparation across command instances, runs one explicitly allowlisted Agent/model call, and restores preview", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "cmai-openclaw-runtime-"));
    directories.push(stateRoot);
    const protocolOperations: string[] = [];
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => {
      const envelope = JSON.parse(String(init?.body)) as Record<string, unknown>;
      protocolOperations.push(String(envelope.operation));
      return responseForEnvelope(envelope);
    });
    vi.stubGlobal("fetch", fetchFn);
    const llmComplete = vi.fn<OpenClawLlmCompleteBridge["complete"]>(async (_params) => ({
      text: JSON.stringify(validContributionCardV1),
      provider: "test-provider",
      model: "test-model",
      agentId: "agent-test",
      usage: { inputTokens: 123, outputTokens: 456, totalTokens: 579 },
      audit: {
        caller: { kind: "plugin", id: "cmai-openclaw", name: "Challenge My AI" },
        purpose: "cmai_challenge_contribution",
      },
    }));
    const context = commandContext({ complete: llmComplete });
    const genericLlmComplete = vi.fn<OpenClawLlmCompleteBridge["complete"]>();
    const api = fakeApi(stateRoot, { complete: genericLlmComplete });

    expect(await executeOpenClawCommand(api, "pair PAIR-123456 Integration")).toMatchObject({ ok: true, code: "paired" });
    const prepared = await executeOpenClawCommand(api, "run challenge_protocol_1", context);
    expect(prepared).toMatchObject({ ok: false, code: "run_confirmation_required" });
    expect(prepared.text).toContain("test-provider/test-model");
    expect(llmComplete).not.toHaveBeenCalled();

    const revision = validChallengeGetResponseFixture.result.challenge.revision;
    const completed = await executeOpenClawCommand(api, `run challenge_protocol_1 confirm ${revision}`, context);
    expect(completed).toMatchObject({ ok: true, code: "run_preview_ready" });
    expect(llmComplete).toHaveBeenCalledOnce();
    expect(genericLlmComplete).not.toHaveBeenCalled();
    const request = llmComplete.mock.calls[0]?.[0];
    expect(request).toMatchObject({
      maxTokens: 4_096,
      purpose: "cmai_challenge_contribution",
      model: "test-provider/test-model",
      agentId: "agent-test",
    });

    const restored = await executeOpenClawCommand(api, "preview", context);
    expect(restored).toMatchObject({ ok: true, code: "preview" });
    expect(restored.text).toContain(validContributionCardV1.challenge_id);
    expect(protocolOperations).toEqual(["pair.create", "challenge.get", "challenge.get"]);
    expect(protocolOperations).not.toContain("contribution.submit");

    const statePath = join(stateRoot, "cmai-openclaw", "state.json");
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown> & {
      schema_version: number;
      preview: { result: { card: { model_provenance: { verification_notes: string } } } };
    };
    expect(state).toMatchObject({ schema_version: 5 });
    expect(state).not.toHaveProperty("pending_run");
    expect(state).toHaveProperty("preview");

    state.schema_version = 3;
    state.preview.result.card.model_provenance.verification_notes = String(
      state.preview.result.card.model_provenance.verification_notes,
    ).replace("adapter produced this schema-valid card", "adapter submitted this schema-valid card");
    await writeFile(statePath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    const migratedPreview = await executeOpenClawCommand(api, "preview", context);
    expect(migratedPreview).toMatchObject({ ok: true, code: "preview" });
    expect(migratedPreview.text).toContain("adapter produced this schema-valid card");
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({ schema_version: 5 });
  });

  it("uses the generic plugin LLM facade only for CLI/default-Agent execution", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "cmai-openclaw-runtime-cli-"));
    directories.push(stateRoot);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => (
      responseForEnvelope(JSON.parse(String(init?.body)) as Record<string, unknown>)
    )));
    const genericLlmComplete = vi.fn<OpenClawLlmCompleteBridge["complete"]>(async (_params) => ({
      text: JSON.stringify(validContributionCardV1),
      provider: "test-provider",
      model: "test-model",
      agentId: "agent-test",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      audit: { caller: { kind: "plugin" as const, id: "cmai-openclaw", name: "Challenge My AI" }, purpose: "cmai_challenge_contribution" },
    }));
    const api = fakeApi(stateRoot, { complete: genericLlmComplete });
    (api as unknown as { config: unknown }).config = commandContext({ complete: genericLlmComplete }).config;

    expect((await executeOpenClawCommand(api, "pair PAIR-123456 CLI")).code).toBe("paired");
    expect((await executeOpenClawCommand(api, "run challenge_protocol_1")).code).toBe("run_confirmation_required");
    const revision = validChallengeGetResponseFixture.result.challenge.revision;
    expect((await executeOpenClawCommand(api, `run challenge_protocol_1 confirm ${revision}`)).code).toBe("run_preview_ready");
    expect(genericLlmComplete).toHaveBeenCalledOnce();
    expect(genericLlmComplete.mock.calls[0]?.[0]).toMatchObject({
      agentId: "agent-test",
      model: "test-provider/test-model",
    });
  });

  it("fails before network and model use when no trusted session context exists", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "cmai-openclaw-runtime-"));
    directories.push(stateRoot);
    const api = fakeApi(stateRoot);
    const result = await executeOpenClawCommand(api, "run challenge_protocol_1");
    expect(result).toMatchObject({ ok: false, code: "bounded_inference_unavailable" });
  });

  it("binds CLI runs to the configured default Agent and root LLM capability", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "cmai-openclaw-runtime-cli-"));
    directories.push(stateRoot);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
      const envelope = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return responseForEnvelope(envelope);
    }));
    const llmComplete = vi.fn<OpenClawLlmCompleteBridge["complete"]>(async () => ({
      text: JSON.stringify(validContributionCardV1),
      provider: "test-provider",
      model: "test-model",
      agentId: "agent-test",
      usage: { inputTokens: 123, outputTokens: 456, totalTokens: 579 },
      audit: {
        caller: { kind: "plugin", id: "cmai-openclaw", name: "Challenge My AI" },
        purpose: "cmai_challenge_contribution",
      },
    }));
    const api = fakeApi(stateRoot) as OpenClawPluginApi & {
      config: Record<string, unknown>;
      runtime: OpenClawPluginApi["runtime"] & { llm: OpenClawLlmCompleteBridge };
    };
    api.config = {
      agents: {
        list: [
          { id: "other-agent", model: "other-provider/other-model" },
          { id: "agent-test", default: true, model: "test-provider/test-model" },
        ],
      },
      plugins: {
        entries: {
          "cmai-openclaw": {
            llm: {
              allowModelOverride: true,
              allowAgentIdOverride: true,
              allowedModels: ["test-provider/test-model"],
            },
          },
        },
      },
    };
    api.runtime.llm = { complete: llmComplete };

    expect((await executeOpenClawCommand(api, "pair PAIR-123456 CLI")).code).toBe("paired");
    expect(await executeOpenClawCommand(api, "run challenge_protocol_1"))
      .toMatchObject({ ok: false, code: "run_confirmation_required" });
    const revision = validChallengeGetResponseFixture.result.challenge.revision;
    expect(await executeOpenClawCommand(api, `run challenge_protocol_1 confirm ${revision}`))
      .toMatchObject({ ok: true, code: "run_preview_ready" });
    expect(llmComplete).toHaveBeenCalledOnce();
    expect(llmComplete.mock.calls[0]?.[0]).toMatchObject({
      agentId: "agent-test",
      model: "test-provider/test-model",
    });
  });

  it("allows only one model call when two command instances confirm the same approval", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "cmai-openclaw-runtime-race-"));
    directories.push(stateRoot);
    const protocolOperations: string[] = [];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
      const envelope = JSON.parse(String(init?.body)) as Record<string, unknown>;
      protocolOperations.push(String(envelope.operation));
      return responseForEnvelope(envelope);
    }));
    const llmComplete = vi.fn<OpenClawLlmCompleteBridge["complete"]>(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        text: JSON.stringify(validContributionCardV1),
        provider: "test-provider",
        model: "test-model",
        agentId: "agent-test",
        usage: { inputTokens: 123, outputTokens: 456, totalTokens: 579 },
        audit: {
          caller: { kind: "plugin", id: "cmai-openclaw", name: "Challenge My AI" },
          purpose: "cmai_challenge_contribution",
        },
      };
    });
    const context = commandContext({ complete: llmComplete });
    const api = fakeApi(stateRoot, { complete: llmComplete });
    expect((await executeOpenClawCommand(api, "pair PAIR-123456 Race")).code).toBe("paired");
    expect((await executeOpenClawCommand(api, "run challenge_protocol_1", context)).code).toBe("run_confirmation_required");

    const revision = validChallengeGetResponseFixture.result.challenge.revision;
    const outcomes = await Promise.all([
      executeOpenClawCommand(api, `run challenge_protocol_1 confirm ${revision}`, context),
      executeOpenClawCommand(api, `run challenge_protocol_1 confirm ${revision}`, context),
    ]);

    expect(outcomes.filter((outcome) => outcome.code === "run_preview_ready")).toHaveLength(1);
    expect(outcomes.filter((outcome) => ["run_approval_consumed", "preview_pending"].includes(outcome.code))).toHaveLength(1);
    expect(llmComplete).toHaveBeenCalledOnce();
    expect(protocolOperations).not.toContain("contribution.submit");
  });

  it("revokes the server pairing without deleting a live inference marker", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "cmai-openclaw-runtime-revoke-race-"));
    directories.push(stateRoot);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
      const envelope = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return responseForEnvelope(envelope);
    }));
    let releaseInference!: () => void;
    const inferenceBlocked = new Promise<void>((resolve) => { releaseInference = resolve; });
    const llmComplete = vi.fn<OpenClawLlmCompleteBridge["complete"]>(async () => {
      await inferenceBlocked;
      return {
        text: JSON.stringify(validContributionCardV1),
        provider: "test-provider",
        model: "test-model",
        agentId: "agent-test",
        usage: { inputTokens: 123, outputTokens: 456, totalTokens: 579 },
        audit: {
          caller: { kind: "plugin", id: "cmai-openclaw", name: "Challenge My AI" },
          purpose: "cmai_challenge_contribution",
        },
      };
    });
    const context = commandContext({ complete: llmComplete });
    const api = fakeApi(stateRoot, { complete: llmComplete });
    expect((await executeOpenClawCommand(api, "pair PAIR-123456 Revoke Race")).code).toBe("paired");
    expect((await executeOpenClawCommand(api, "run challenge_protocol_1", context)).code).toBe("run_confirmation_required");

    const revision = validChallengeGetResponseFixture.result.challenge.revision;
    const confirmation = executeOpenClawCommand(api, `run challenge_protocol_1 confirm ${revision}`, context);
    await vi.waitFor(() => expect(llmComplete).toHaveBeenCalledOnce());
    expect(await executeOpenClawCommand(api, "revoke confirm", context))
      .toMatchObject({ ok: true, code: "revoked_recovery_preserved" });
    const stateDuringCall = JSON.parse(await readFile(join(stateRoot, "cmai-openclaw", "state.json"), "utf8")) as Record<string, unknown>;
    expect(stateDuringCall).toHaveProperty("pending_run.consumed_at");
    expect(stateDuringCall).toHaveProperty("pending_run.consumer.owner_kind", "process");
    expect(llmComplete).toHaveBeenCalledOnce();

    releaseInference();
    expect(await confirmation).toMatchObject({ ok: true, code: "run_preview_ready" });
    expect(llmComplete).toHaveBeenCalledOnce();
  });

  it("retains a process-owned consumed marker after inference failure and refuses live recovery", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "cmai-openclaw-runtime-interrupted-"));
    directories.push(stateRoot);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (_url, init) => {
      const envelope = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return responseForEnvelope(envelope);
    }));
    const llmComplete = vi.fn<OpenClawLlmCompleteBridge["complete"]>(async () => {
      throw new Error("provider failed");
    });
    const context = commandContext({ complete: llmComplete });
    const api = fakeApi(stateRoot, { complete: llmComplete });
    expect((await executeOpenClawCommand(api, "pair PAIR-123456 Interrupted")).code).toBe("paired");
    expect((await executeOpenClawCommand(api, "run challenge_protocol_1", context)).code).toBe("run_confirmation_required");

    const revision = validChallengeGetResponseFixture.result.challenge.revision;
    expect(await executeOpenClawCommand(api, `run challenge_protocol_1 confirm ${revision}`, context))
      .toMatchObject({ ok: false, code: "inference_failed" });
    expect(llmComplete).toHaveBeenCalledOnce();
    const stateAfterFailure = JSON.parse(await readFile(join(stateRoot, "cmai-openclaw", "state.json"), "utf8")) as Record<string, unknown>;
    expect(stateAfterFailure).toHaveProperty("pending_run.consumed_at");
    expect(stateAfterFailure).toHaveProperty("pending_run.consumer.pid", process.pid);
    expect(stateAfterFailure).toHaveProperty("pending_run.consumer.process_identity");

    expect(await executeOpenClawCommand(api, `run challenge_protocol_1 confirm ${revision}`, context))
      .toMatchObject({ ok: false, code: "run_approval_consumed" });
    expect(llmComplete).toHaveBeenCalledOnce();
    expect(await executeOpenClawCommand(api, "discard", context)).toMatchObject({ ok: false, code: "run_inference_active" });
    expect(await executeOpenClawCommand(api, "run challenge_protocol_1", context))
      .toMatchObject({ ok: false, code: "run_in_flight_or_interrupted" });

    const statePath = join(stateRoot, "cmai-openclaw", "state.json");
    const pending = stateAfterFailure.pending_run as Record<string, unknown>;
    const { consumer: _legacyMissingOwner, ...ownerlessPending } = pending;
    await writeFile(statePath, `${JSON.stringify({ ...stateAfterFailure, schema_version: 3, pending_run: ownerlessPending })}\n`, { mode: 0o600 });
    expect(await executeOpenClawCommand(api, "discard", context))
      .toMatchObject({ ok: false, code: "run_inference_active" });
    expect(llmComplete).toHaveBeenCalledOnce();
    const migrated = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    expect(migrated).toHaveProperty("schema_version", 5);
    expect(migrated).toHaveProperty("pending_run.consumer.owner_kind", "legacy_unknown");
  });
});
