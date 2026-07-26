import { describe, expect, it, vi } from "vitest";
import { verifyHermesRunReceipt } from "@/lib/provenance/receipts";
import { SandboxRunPolicyError } from "@/lib/sandbox/broker";
import { createRailwaySandboxBroker, DEFAULT_RAILWAY_SANDBOX_CHECKPOINT, RAILWAY_RUN_CELL_CHALLENGE_BUNDLE_LIMIT_BYTES, RAILWAY_RUN_CELL_CONFIG_LIMIT_BYTES, RailwaySandboxExecutionError, type RailwaySandboxExecResult, type RailwaySandboxHandle, type RailwaySandboxSdk } from "@/lib/sandbox/railwayBroker";
import type { ContributionCard } from "@/lib/types";

const signingKey = { keyId: "railway-adapter-test", secret: "railway-adapter-secret" };

const validCard: ContributionCard = {
  schema_version: "1.0",
  challenge_id: "challenge-railway",
  contribution_mode: "critique",
  contributor_ai_label: "Railway Runner Model",
  skills_or_context_used: [],
  verdict: "Mixed",
  original_answer_grade: { score_0_to_10: 6, grade_label: "mixed", why: "It misses constraints." },
  answer_to_challenge_poster: "Tighten the implementation boundary before shipping.",
  reasoning_summary: "The answer is directionally useful but lacks safety details.",
  strongest_objections: ["No teardown proof"],
  missing_assumptions_or_context: [],
  alternative_recommendation: "Use a broker-owned receipt path.",
  risks_and_failure_modes: [],
  claims_to_verify: [],
  confidence: { level: "medium", why: "Synthetic test evidence." },
  what_would_change_my_mind: [],
  suggested_follow_up_questions: [],
  safety_or_scope_notes: [],
  abuse_or_prompt_injection_flags: [],
  raw_output_summary: "Railway adapter critique",
};

const request = {
  runId: "run-railway",
  challengeId: "challenge-railway",
  contributorId: "user-railway",
  contributionMode: "critique" as const,
  challengeBundle: { title: "Railway live adapter", original_ai_answer: "Just trust the sandbox." },
  provider: "user-provider",
  requestedModel: "frontier-model",
  agentConnection: {
    delegation_id: "del_railway",
    connection_id: "conn_railway",
    agent_connection_id: "conn_railway",
    provider: "user-provider",
    allowed_model: "frontier-model",
    allowed_request_class: "contribution_card",
    expires_at: "2026-06-28T01:00:00.000Z",
    max_requests: 1,
  },
  childRunConfig: {
    run_id: "run-railway",
    delegation_id: "del_railway",
    agent_connection_id: "conn_railway",
    provider: "user-provider",
    allowed_model: "frontier-model",
    allowed_request_class: "contribution_card",
    expires_at: "2026-06-28T01:00:00.000Z",
    max_requests: 1,
    max_spend_cents: 25,
    model_proxy_url: "https://broker.example.test/model-proxy",
  },
};

type MockRailwaySandbox = RailwaySandboxHandle & {
  written: Record<string, string>;
  execMock: ReturnType<typeof vi.fn>;
  destroyMock: ReturnType<typeof vi.fn>;
  readMock: ReturnType<typeof vi.fn>;
};

function mockRailwaySdk(options: {
  execResult?: Partial<RailwaySandboxExecResult>;
  cardText?: string;
  transcript?: string;
  readErrorPath?: string;
  createError?: Error;
  destroyError?: Error;
} = {}): { sdk: RailwaySandboxSdk; sandbox: MockRailwaySandbox; createMock: ReturnType<typeof vi.fn> } {
  const written: Record<string, string> = {};
  const execResult: RailwaySandboxExecResult = {
    exitCode: 0,
    stdout: "runner ok",
    stderr: "",
    timedOut: false,
    truncated: false,
    ...options.execResult,
  };
  const readMock = vi.fn(async (path: string) => {
    if (path === options.readErrorPath) throw new Error(`missing ${path}`);
    if (path.endsWith("contribution-card.json")) return options.cardText ?? JSON.stringify(validCard);
    if (path.endsWith("transcript.jsonl")) return options.transcript ?? '{"event":"done"}\n';
    throw new Error(`unexpected read ${path}`);
  });
  const execMock = vi.fn(async () => execResult);
  const destroyMock = vi.fn(async () => {
    if (options.destroyError) throw options.destroyError;
  });
  const sandbox: MockRailwaySandbox = {
    id: "sbx_test_123",
    networkIsolation: "ISOLATED",
    written,
    files: {
      write: vi.fn(async (path: string, data: string) => {
        written[path] = data;
      }),
      read: readMock,
    },
    exec: execMock,
    destroy: destroyMock,
    execMock,
    destroyMock,
    readMock,
  };
  const createMock = vi.fn(async () => {
    if (options.createError) throw options.createError;
    return sandbox;
  });
  return { sdk: { create: createMock }, sandbox, createMock };
}

describe("Railway sandbox SDK adapter", () => {
  it("creates an isolated sandbox, writes bounded inputs, reads artifacts, destroys, and signs a railway receipt", async () => {
    const transcript = [
      { event: "runner_started", run_id: "run-railway", challenge_id: "challenge-railway" },
      { event: "model_proxy_response", run_id: "run-railway", delegation_id: "del_railway", agent_connection_id: "conn_railway", provider: "user-provider", request_class: "contribution_card", requested_model: "frontier-model", returned_model: "frontier-model-2026-07", model_display_name: "Frontier Model 2026-07", provider_response_id: "provider_resp_123", provider_model_verified: true, remaining_requests: 0 },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n";
    const { sdk, sandbox, createMock } = mockRailwaySdk({ transcript });
    const broker = createRailwaySandboxBroker({ token: "railway-token", environmentId: "env_123", sdk }, signingKey);

    const outcome = await broker.run(request);

    expect(createMock).toHaveBeenCalledWith(DEFAULT_RAILWAY_SANDBOX_CHECKPOINT, expect.objectContaining({
      token: "railway-token",
      environmentId: "env_123",
      networkIsolation: "ISOLATED",
      idleTimeoutMinutes: 5,
    }));
    expect(sandbox.written["/cmai/input/challenge.json"]).toContain("Railway live adapter");
    const runConfig = JSON.parse(sandbox.written["/cmai/input/run-config.json"] || "{}");
    expect(runConfig.child_run_config).toMatchObject({
      run_id: "run-railway",
      delegation_id: "del_railway",
      agent_connection_id: "conn_railway",
      provider: "user-provider",
      allowed_model: "frontier-model",
      allowed_request_class: "contribution_card",
      max_requests: 1,
      max_spend_cents: 25,
      model_proxy_url: "https://broker.example.test/model-proxy",
    });
    expect(sandbox.written["/cmai/input/run-config.json"]).toContain(DEFAULT_RAILWAY_SANDBOX_CHECKPOINT);
    expect(sandbox.written["/cmai/input/run-config.json"]).not.toContain("railway-token");
    expect(sandbox.execMock).toHaveBeenCalledWith("cmai-blank-slate-runner", { timeoutSec: 120 });
    expect(sandbox.destroyMock).toHaveBeenCalledTimes(1);
    expect(outcome.card.model_provenance?.source).toBe("hermes_sandbox_run");
    expect(outcome.card.model_provenance?.sandbox_provider).toBe("railway");
    expect(outcome.card.model_provenance?.provider_model_verified).toBe(true);
    expect(outcome.card.model_provenance?.verification_status).toBe("metadata_verified");
    expect(outcome.card.model_provenance?.returned_model).toBe("frontier-model-2026-07");
    expect(outcome.card.model_provenance?.provider_response_id).toBe("provider_resp_123");
    expect(outcome.receipt.provider).toMatchObject({
      requested_model: "frontier-model",
      returned_model: "frontier-model-2026-07",
      model_display_name: "Frontier Model 2026-07",
      provider_response_id: "provider_resp_123",
      provider_model_verified: true,
    });
    expect(outcome.receipt.sandbox.provider).toBe("railway");
    expect(outcome.receipt.sandbox.network_isolation).toBe("ISOLATED");
    expect(outcome.destroyed).toBe(true);
    expect(verifyHermesRunReceipt(outcome.receipt, signingKey)).toBe(true);
  });

  it("uses an async token provider for Railway OAuth refreshed access tokens", async () => {
    const { sdk, createMock } = mockRailwaySdk();
    const tokenProvider = vi.fn(async () => "railway-oauth-access-token");
    const broker = createRailwaySandboxBroker({ tokenProvider, environmentId: "env_123", sdk }, signingKey);

    await broker.run(request);

    expect(tokenProvider).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith(DEFAULT_RAILWAY_SANDBOX_CHECKPOINT, expect.objectContaining({
      token: "railway-oauth-access-token",
      environmentId: "env_123",
      networkIsolation: "ISOLATED",
    }));
  });

  it("rejects oversized run-cell inputs before creating a Railway sandbox", async () => {
    const oversizedBundle = mockRailwaySdk();
    const broker = createRailwaySandboxBroker({ token: "railway-token", environmentId: "env_123", sdk: oversizedBundle.sdk }, signingKey);

    await expect(broker.run({
      ...request,
      challengeBundle: { title: "too large", body: "x".repeat(RAILWAY_RUN_CELL_CHALLENGE_BUNDLE_LIMIT_BYTES) },
    })).rejects.toMatchObject({
      code: "RAILWAY_SANDBOX_EXECUTION_FAILED",
      details: {
        label: "challenge bundle",
        limit: RAILWAY_RUN_CELL_CHALLENGE_BUNDLE_LIMIT_BYTES,
        actualBytes: expect.any(Number),
      },
    });
    expect(oversizedBundle.createMock).not.toHaveBeenCalled();

    const oversizedConfig = mockRailwaySdk();
    const configBroker = createRailwaySandboxBroker({ token: "railway-token", environmentId: "env_123", sdk: oversizedConfig.sdk }, signingKey);

    await expect(configBroker.run({
      ...request,
      childRunConfig: { ...request.childRunConfig, notes: "x".repeat(RAILWAY_RUN_CELL_CONFIG_LIMIT_BYTES) },
    })).rejects.toMatchObject({
      code: "RAILWAY_SANDBOX_EXECUTION_FAILED",
      details: {
        label: "run config",
        limit: RAILWAY_RUN_CELL_CONFIG_LIMIT_BYTES,
        actualBytes: expect.any(Number),
      },
    });
    expect(oversizedConfig.createMock).not.toHaveBeenCalled();
  });

  it("ignores model-proxy transcript metadata that does not match the scoped run", async () => {
    const transcript = [
      { event: "model_proxy_response", run_id: "run-railway", delegation_id: "del_railway", agent_connection_id: "conn_railway", provider: "user-provider", request_class: "contribution_card", requested_model: "wrong-model", returned_model: "wrong-model", provider_response_id: "provider_resp_wrong", provider_model_verified: true, remaining_requests: 0 },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n";
    const { sdk } = mockRailwaySdk({ transcript });
    const broker = createRailwaySandboxBroker({ token: "railway-token", environmentId: "env_123", sdk }, signingKey);

    const outcome = await broker.run(request);

    expect(outcome.receipt.provider).toMatchObject({
      requested_model: "frontier-model",
      model_display_name: "frontier-model",
      provider_model_verified: false,
    });
    expect(outcome.receipt.provider.returned_model).toBeUndefined();
    expect(outcome.receipt.provider.provider_response_id).toBeUndefined();
    expect(outcome.card.model_provenance?.provider_model_verified).toBe(false);
    expect(outcome.card.model_provenance?.verification_status).toBe("sandbox_recorded");
  });

  it("rejects non-zero runner exits before signing and still destroys the sandbox", async () => {
    const { sdk, sandbox } = mockRailwaySdk({ execResult: { exitCode: 2, stderr: "boom" } });
    const broker = createRailwaySandboxBroker({ token: "railway-token", environmentId: "env_123", sdk }, signingKey);

    await expect(broker.run(request)).rejects.toBeInstanceOf(RailwaySandboxExecutionError);
    expect(sandbox.destroyMock).toHaveBeenCalledTimes(1);
    expect(sandbox.readMock).not.toHaveBeenCalled();
  });

  it("rejects timed-out runner exits before signing and still destroys the sandbox", async () => {
    const { sdk, sandbox } = mockRailwaySdk({ execResult: { exitCode: null, timedOut: true } });
    const broker = createRailwaySandboxBroker({ token: "railway-token", environmentId: "env_123", sdk }, signingKey);

    await expect(broker.run(request)).rejects.toMatchObject({ code: "RAILWAY_SANDBOX_EXECUTION_FAILED" });
    expect(sandbox.destroyMock).toHaveBeenCalledTimes(1);
  });

  it("rejects truncated runner output before signing and still destroys the sandbox", async () => {
    const { sdk, sandbox } = mockRailwaySdk({ execResult: { exitCode: 0, stdout: "partial", truncated: true } });
    const broker = createRailwaySandboxBroker({ token: "railway-token", environmentId: "env_123", sdk }, signingKey);

    await expect(broker.run(request)).rejects.toMatchObject({ code: "RAILWAY_SANDBOX_EXECUTION_FAILED" });
    expect(sandbox.destroyMock).toHaveBeenCalledTimes(1);
    expect(sandbox.readMock).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid JSON", "not-json"],
    ["invalid contribution card schema", JSON.stringify({ schema_version: "1.0" })],
  ])("rejects %s output cards before returning a signed contribution", async (_label, cardText) => {
    const { sdk, sandbox } = mockRailwaySdk({ cardText });
    const broker = createRailwaySandboxBroker({ token: "railway-token", environmentId: "env_123", sdk }, signingKey);

    await expect(broker.run(request)).rejects.toMatchObject({ code: "RAILWAY_SANDBOX_EXECUTION_FAILED" });
    expect(sandbox.destroyMock).toHaveBeenCalledTimes(1);
    expect(sandbox.readMock).toHaveBeenCalled();
  });

  it("rejects missing output artifacts before signing and still destroys the sandbox", async () => {
    const { sdk, sandbox } = mockRailwaySdk({ readErrorPath: "/cmai/output/transcript.jsonl" });
    const broker = createRailwaySandboxBroker({ token: "railway-token", environmentId: "env_123", sdk }, signingKey);

    await expect(broker.run(request)).rejects.toBeInstanceOf(RailwaySandboxExecutionError);
    expect(sandbox.destroyMock).toHaveBeenCalledTimes(1);
  });

  it("maps Railway SDK auth, Sandboxes access, and checkpoint/template blockers to unavailable errors", async () => {
    const auth = mockRailwaySdk({ createError: new Error("Not authenticated with Railway API token") });
    const access = mockRailwaySdk({ createError: new Error("project_sandboxes feature is not enabled for this workspace") });
    const checkpoint = mockRailwaySdk({ createError: new Error(`Checkpoint ${DEFAULT_RAILWAY_SANDBOX_CHECKPOINT} not found for environment env_123`) });

    await expect(createRailwaySandboxBroker({ token: "railway-token", environmentId: "env_123", sdk: auth.sdk }, signingKey).run(request)).rejects.toMatchObject({ code: "RAILWAY_SANDBOX_UNAVAILABLE" });
    await expect(createRailwaySandboxBroker({ token: "railway-token", environmentId: "env_123", sdk: access.sdk }, signingKey).run(request)).rejects.toMatchObject({ code: "RAILWAY_SANDBOX_UNAVAILABLE" });
    await expect(createRailwaySandboxBroker({ token: "railway-token", environmentId: "env_123", sdk: checkpoint.sdk }, signingKey).run(request)).rejects.toMatchObject({
      code: "RAILWAY_SANDBOX_UNAVAILABLE",
      message: expect.not.stringContaining("env_123"),
    });
  });

  it("records teardown failure in a signed receipt when validated evidence exists", async () => {
    const { sdk, sandbox } = mockRailwaySdk({ destroyError: new Error("destroy failed") });
    const broker = createRailwaySandboxBroker({ token: "railway-token", environmentId: "env_123", sdk }, signingKey);

    const outcome = await broker.run(request);

    expect(sandbox.destroyMock).toHaveBeenCalledTimes(1);
    expect(outcome.destroyed).toBe(false);
    expect(outcome.receipt.sandbox.teardown_completed).toBe(false);
    expect(outcome.receipt.sandbox.teardown_error).toContain("destroy failed");
    expect(verifyHermesRunReceipt(outcome.receipt, signingKey)).toBe(true);
  });

  it("rejects broker/provider secrets before creating a Railway sandbox", async () => {
    const { sdk, createMock } = mockRailwaySdk();
    const broker = createRailwaySandboxBroker({ token: "railway-token", environmentId: "env_123", sdk }, signingKey);

    await expect(broker.run({
      ...request,
      config: { env: { DATABASE_URL: "postgres://secret", RECEIPT_SIGNING_SECRET: "secret" } },
    })).rejects.toBeInstanceOf(SandboxRunPolicyError);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("rejects child-run secrets before creating a Railway sandbox", async () => {
    const { sdk, createMock } = mockRailwaySdk();
    const broker = createRailwaySandboxBroker({ token: "railway-token", environmentId: "env_123", sdk }, signingKey);

    await expect(broker.run({
      ...request,
      childRunConfig: { ...request.childRunConfig, refresh_token: "refresh-secret" },
    })).rejects.toBeInstanceOf(SandboxRunPolicyError);
    expect(createMock).not.toHaveBeenCalled();
  });
});
