import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CmaiAgentClient } from "../../cmai-agent-client/src/client";
import type {
  CmaiAgentRuntimeAdapter,
  CmaiAgentRunInput,
  CmaiAgentRunResult,
  CmaiAgentSigner,
  CmaiAgentTransport,
  CmaiAgentTransportOptions,
  CmaiAgentTransportRequest,
  CmaiAgentTransportResponse,
} from "../../cmai-agent-client/src/types";
import { hashAgentProtocolPayload } from "../../../lib/agent-protocol/canonical";
import type { AgentProtocolOperation } from "../../../lib/agent-protocol/constants";
import {
  backwardCompatiblePairCreateFixture,
  fixtureSignature,
  fixtureTimestamp,
  validChallengeGetResponseFixture,
  validContributionCardV1,

  validFeedListResponseFixture,
  validPairingStateFixture,
} from "../../../lib/agent-protocol/fixtures";
import { agentPairCreateRequestSchema, pairingStateSchema } from "../../../lib/agent-protocol/schemas";
import { evaluateHermesCompatibility } from "./constants";
import { CmaiHermesController } from "./controller";
import type { HermesPairingMaterial } from "./cryptoSigner";
import type { HermesPendingRun, HermesPersistedPreview } from "./stateStore";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

class RecordingTransport implements CmaiAgentTransport {
  readonly operations: AgentProtocolOperation[] = [];
  private challengeGets = 0;

  async send<TOperation extends AgentProtocolOperation>(
    request: CmaiAgentTransportRequest<TOperation>,
    _options: CmaiAgentTransportOptions,
  ): Promise<CmaiAgentTransportResponse> {
    this.operations.push(request.operation);
    const requestId = request.envelope.request_id;
    if (request.operation === "pair.create") {
      const pairing = { ...clone(validPairingStateFixture), granted_scopes: ["challenge:read", "challenge:run", "pairing:manage"] as const };
      return { status: 201, body: { protocol: "CMAI_AGENT_PROTOCOL_V1", protocol_version: "1.2", request_id: requestId, server_time: fixtureTimestamp, result: { pairing } } };
    }
    if (request.operation === "feed.list") {
      return { status: 200, body: { ...clone(validFeedListResponseFixture), request_id: requestId } };
    }
    if (request.operation === "challenge.get") {
      this.challengeGets += 1;
      const response = { ...clone(validChallengeGetResponseFixture), request_id: requestId };
      const body = this.challengeGets > 1
        ? {
            ...response,
            result: {
              ...response.result,
              challenge: {
                ...response.result.challenge,
                run_grant: { ...response.result.challenge.run_grant, run_nonce: "z".repeat(43) },
              },
            },
          }
        : response;
      return { status: 200, body };
    }

    if (request.operation === "pairing.revoke") {
      const pairing = pairingStateSchema.parse(validPairingStateFixture);
      pairing.status = "revoked";
      pairing.revoked_at = fixtureTimestamp;
      pairing.updated_at = fixtureTimestamp;
      pairing.keys[0] = { ...pairing.keys[0], status: "revoked", revoked_at: fixtureTimestamp };
      return { status: 200, body: { protocol: "CMAI_AGENT_PROTOCOL_V1", protocol_version: "1.2", request_id: requestId, server_time: fixtureTimestamp, result: { pairing } } };
    }
    throw new Error(`Unexpected operation ${request.operation}`);
  }
}

const signer: CmaiAgentSigner = {
  keyId: "key_1",
  sign: async () => fixtureSignature,
};

function successfulRuntimeAdapter(execute = vi.fn(async (input: CmaiAgentRunInput): Promise<CmaiAgentRunResult> => ({
  identity: { runtime: "hermes", runtimeVersion: "0.18.2", adapterName: "cmai-hermes", adapterVersion: "0.1.0" },
  localRunId: "local_run_bounded_1",
  card: { ...clone(validContributionCardV1), challenge_id: input.challenge.challenge_id },
  providerClaim: "host-selected-provider",
  modelClaim: "host-selected-model",
  startedAt: fixtureTimestamp,
  completedAt: fixtureTimestamp,
  structuredOutputValidated: true,
}))): CmaiAgentRuntimeAdapter & { execute: typeof execute } {
  return {
    identity: { runtime: "hermes", runtimeVersion: "0.18.2", adapterName: "cmai-hermes", adapterVersion: "0.1.0" },
    execute,
  };
}

function material(): HermesPairingMaterial {
  const fixturePayload = agentPairCreateRequestSchema.parse(backwardCompatiblePairCreateFixture).payload;
  return {
    signer,
    payload: { ...fixturePayload, requested_scopes: ["challenge:read", "challenge:run", "pairing:manage"] },
    persistence: { signingKeyPkcs8: "A".repeat(64) },
  };
}

function pendingRun(overrides: Partial<HermesPendingRun> = {}): HermesPendingRun {
  const grant = validChallengeGetResponseFixture.result.challenge.run_grant;
  return {
    pairing_id: validPairingStateFixture.pairing_id,
    challenge_hash: hashAgentProtocolPayload(validChallengeGetResponseFixture.result.challenge),
    challenge_id: validChallengeGetResponseFixture.result.challenge.challenge_id,
    challenge_revision: validChallengeGetResponseFixture.result.challenge.revision,
    run_grant: clone(grant),
    prompt_version: grant.prompt_version,
    profile_name: "test-profile",
    max_output_bytes: grant.max_output_bytes,
    max_tokens: 4096,
    timeout_seconds: 45,
    prepared_at: fixtureTimestamp,
    approval_expires_at: grant.expires_at,
    ...overrides,
  };
}

function consumedRun(run: HermesPendingRun): HermesPendingRun {
  return {
    ...run,
    consumed_at: fixtureTimestamp,
    consumer: {
      owner_kind: "process",
      pid: process.pid,
      token: randomUUID(),
      created_at: fixtureTimestamp,
      process_identity: { boot_id: "123e4567-e89b-42d3-a456-426614174001", start_ticks: "12345" },
      process_time_origin: 1,
    },
  };
}

function harness(overrides: {
  persistPairing?: () => Promise<boolean>;
  clearPairing?: (expectedPairingId?: string) => Promise<"cleared" | "active" | "changed">;
  persistPendingRun?: (pendingRun: HermesPendingRun) => Promise<boolean>;
  consumePendingRun?: (pendingRun: HermesPendingRun) => Promise<HermesPendingRun | "changed" | "identity_unavailable">;
  clearPendingRun?: (pendingRun: HermesPendingRun) => Promise<"cleared" | "active" | "changed">;
  persistPreview?: (preview: HermesPersistedPreview, consumed: HermesPendingRun) => Promise<boolean>;
  clearPreview?: (expectedPreviewId: string) => Promise<boolean>;
  pendingRun?: HermesPendingRun;
  previewId?: string;
  runtimeAdapter?: CmaiAgentRuntimeAdapter;
  profileName?: string;
  now?: () => Date;
} = {}) {
  const transport = new RecordingTransport();
  const client = new CmaiAgentClient({
    transport,
    now: () => new Date(fixtureTimestamp),
    requestId: (operation) => `req_${operation.replaceAll(".", "_")}_adapter`,
  });
  const persistPairing = vi.fn(overrides.persistPairing ?? (async () => true));
  const clearPairing = vi.fn(overrides.clearPairing ?? (async () => "cleared" as const));
  const persistPendingRun = vi.fn(overrides.persistPendingRun ?? (async () => true));
  const consumePendingRun = vi.fn(overrides.consumePendingRun ?? (async (run: HermesPendingRun) => consumedRun(run)));
  const clearPendingRun = vi.fn(overrides.clearPendingRun ?? (async () => "cleared" as const));
  const persistPreview = vi.fn(overrides.persistPreview ?? (async () => true));
  const clearPreview = vi.fn(overrides.clearPreview ?? (async () => true));
  const controller = new CmaiHermesController({
    client,
    compatibility: evaluateHermesCompatibility("0.18.2"),
    runtimeVersion: "0.18.2",
    profileName: overrides.profileName ?? "test-profile",
    pendingRun: overrides.pendingRun,
    runtimeAdapter: overrides.runtimeAdapter,
    now: overrides.now ?? (() => new Date(fixtureTimestamp)),
    createPairingMaterial: material,
    persistPairing,
    clearPairing,
    persistPendingRun,
    consumePendingRun,
    clearPendingRun,
    persistPreview,
    clearPreview,
    previewId: overrides.previewId ?? "preview_adapter_test_1",
    previewIdFactory: () => "preview_adapter_test_1",
  });
  return { transport, client, controller, persistPairing, clearPairing, persistPendingRun, consumePendingRun, clearPendingRun, persistPreview, clearPreview };
}

async function pair(controller: CmaiHermesController): Promise<void> {
  const result = await controller.execute("pair PAIR-123456 Test Hermes");
  expect(result.code).toBe("paired");
}

describe("CMAI Hermes command controller", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("keeps help and status local and explicit", async () => {
    const { controller, transport } = harness();
    const help = await controller.execute("help");
    const status = await controller.execute("status");
    expect(help.text).toContain("/cmai submit (reserved; unavailable until Card 08)");
    expect(help.text).toContain("Every model call requires exact revision approval");
    expect(status.text).toContain("Unpaired");
    expect(transport.operations).toEqual([]);
  });

  it("fails incompatible Hermes versions before starting client work", async () => {
    const { client, transport } = harness();
    const controller = new CmaiHermesController({
      client,
      compatibility: evaluateHermesCompatibility("0.20.0"),
      runtimeVersion: "0.20.0",
      createPairingMaterial: material,
      profileName: "test-profile",
      persistPairing: async () => true,
      clearPairing: async () => "cleared",
      persistPendingRun: async () => true,
      consumePendingRun: async (run) => consumedRun(run),
      clearPendingRun: async () => "cleared",
      persistPreview: async () => true,
      clearPreview: async () => true,
    });
    const result = await controller.execute("feed");
    expect(result).toMatchObject({ ok: false, code: "hermes_version_incompatible" });
    expect(result.text).toContain("No network or model call");
    expect(transport.operations).toEqual([]);
  });

  it("delegates pairing and stores only adapter-owned pairing material", async () => {
    const { controller, client, transport, persistPairing } = harness();
    const result = await controller.execute("pair PAIR-123456 Test Hermes");
    expect(result).toMatchObject({ ok: true, code: "paired" });
    expect(result.text).not.toContain("PAIR-123456");
    expect(result.text).toContain("Provider credentials were not sent");
    expect(transport.operations).toEqual(["pair.create"]);
    expect(persistPairing).toHaveBeenCalledOnce();
    expect(material().payload.requested_scopes).toEqual(["challenge:read", "challenge:run", "pairing:manage"]);
    expect(client.status().pairing?.granted_scopes).toEqual(["challenge:read", "challenge:run", "pairing:manage"]);
  });

  it("revokes a newly created pairing when local key persistence fails", async () => {
    const { controller, transport, clearPairing } = harness({
      persistPairing: async () => { throw new Error("local write refused"); },
    });
    const result = await controller.execute("pair PAIR-123456 Test Hermes");
    expect(result).toMatchObject({ ok: false, code: "local_pairing_state_failed" });
    expect(result.text).toContain("server pairing was revoked");
    expect(transport.operations).toEqual(["pair.create", "pairing.revoke"]);
    expect(clearPairing).toHaveBeenCalledOnce();
  });

  it("revokes a concurrently redeemed pairing without clearing the winning local pairing", async () => {
    const { controller, transport, clearPairing } = harness({
      persistPairing: async () => false,
    });
    const result = await controller.execute("pair PAIR-123456 Test Hermes");
    expect(result).toMatchObject({ ok: false, code: "local_pairing_state_failed" });
    expect(transport.operations).toEqual(["pair.create", "pairing.revoke"]);
    expect(clearPairing).toHaveBeenCalledWith(validPairingStateFixture.pairing_id);
  });

  it("delegates feed and persists challenge preparation without inference", async () => {
    const runtimeAdapter = successfulRuntimeAdapter();
    const { controller, transport, persistPendingRun } = harness({ runtimeAdapter });
    await pair(controller);
    const feed = await controller.execute("feed protocol reliability");
    const run = await controller.execute("run challenge_protocol_1");
    expect(feed.text).toContain("Freeze the protocol");
    expect(run).toMatchObject({ ok: false, code: "run_confirmation_required" });
    expect(run.text).toContain("Nothing was inferred or submitted");
    expect(run.text).toContain("Canonical challenge SHA-256:");
    expect(run.text).toContain('"problem_statement": "What is the minimum stable protocol?"');
    expect(run.text).toContain('"run_nonce":');
    expect(persistPendingRun).toHaveBeenCalledOnce();
    expect(runtimeAdapter.execute).not.toHaveBeenCalled();
    expect(transport.operations).toEqual(["pair.create", "feed.list", "challenge.get"]);
  });

  it("does not overwrite durable run or preview state when preparation loses the race", async () => {
    const runtimeAdapter = successfulRuntimeAdapter();
    const { controller, transport } = harness({
      runtimeAdapter,
      persistPendingRun: async () => false,
    });
    await pair(controller);

    const result = await controller.execute("run challenge_protocol_1");

    expect(result).toMatchObject({ ok: false, code: "run_state_pending" });
    expect(result.text).toContain("No model call occurred");
    expect(runtimeAdapter.execute).not.toHaveBeenCalled();
    expect(transport.operations).toEqual(["pair.create", "challenge.get"]);
  });

  it("refuses to replace an already loaded run preparation", async () => {
    const runtimeAdapter = successfulRuntimeAdapter();
    const { controller, transport, persistPendingRun } = harness({ runtimeAdapter, pendingRun: pendingRun() });
    await pair(controller);

    const result = await controller.execute("run challenge_protocol_1");

    expect(result).toMatchObject({ ok: false, code: "run_approval_pending" });
    expect(persistPendingRun).not.toHaveBeenCalled();
    expect(runtimeAdapter.execute).not.toHaveBeenCalled();
    expect(transport.operations).toEqual(["pair.create"]);
  });

  it("consumes one persisted exact-grant approval before exactly one bounded call", async () => {
    const runtimeAdapter = successfulRuntimeAdapter();
    const { controller, transport, consumePendingRun, persistPreview } = harness({ runtimeAdapter });
    await pair(controller);

    const prepared = await controller.execute("run challenge_protocol_1");
    expect(prepared.code).toBe("run_confirmation_required");
    expect(runtimeAdapter.execute).not.toHaveBeenCalled();

    const confirmed = await controller.execute("run challenge_protocol_1 confirm 1");
    expect(confirmed).toMatchObject({ ok: true, code: "run_preview_ready" });
    expect(runtimeAdapter.execute).toHaveBeenCalledOnce();
    expect(runtimeAdapter.execute.mock.calls[0]?.[0].challenge.run_grant.run_nonce)
      .toBe(validChallengeGetResponseFixture.result.challenge.run_grant.run_nonce);
    expect(runtimeAdapter.execute.mock.calls[0]?.[0].challenge.run_grant.run_nonce).not.toBe("z".repeat(43));
    expect(consumePendingRun).toHaveBeenCalledOnce();
    expect(persistPreview).toHaveBeenCalledWith(
      expect.objectContaining({ preview_id: "preview_adapter_test_1" }),
      expect.objectContaining({ consumed_at: fixtureTimestamp, pairing_id: "pairing_1" }),
    );
    expect(persistPreview.mock.calls[0]?.[0]).not.toHaveProperty("idempotency_key");
    expect(transport.operations).toEqual(["pair.create", "challenge.get", "challenge.get"]);

    const repeated = await controller.execute("run challenge_protocol_1 confirm 1");
    expect(repeated.code).toBe("preview_pending");
    expect(runtimeAdapter.execute).toHaveBeenCalledOnce();
    expect(transport.operations).toEqual(["pair.create", "challenge.get", "challenge.get"]);
  });

  it("discards a completed model output when preview persistence loses the race", async () => {
    const runtimeAdapter = successfulRuntimeAdapter();
    const { controller, client } = harness({
      runtimeAdapter,
      pendingRun: pendingRun(),
      persistPreview: async () => false,
    });
    await pair(controller);

    const result = await controller.execute("run challenge_protocol_1 confirm 1");

    expect(result).toMatchObject({ ok: false, code: "preview_state_conflict" });
    expect(result.text).toContain("nothing was submitted");
    expect(runtimeAdapter.execute).toHaveBeenCalledOnce();
    expect(client.status().preview).toBeUndefined();
  });

  it("refuses a concurrently consumed approval before provider dispatch", async () => {
    const runtimeAdapter = successfulRuntimeAdapter();
    const { controller, consumePendingRun } = harness({
      runtimeAdapter,
      pendingRun: pendingRun(),
      consumePendingRun: async () => "changed",
    });
    await pair(controller);
    const result = await controller.execute("run challenge_protocol_1 confirm 1");
    expect(result.code).toBe("run_approval_consumed");
    expect(consumePendingRun).toHaveBeenCalledOnce();
    expect(runtimeAdapter.execute).not.toHaveBeenCalled();
  });

  it("refuses mismatched, expired, stale-grant, and profile-drift confirmations with zero model calls", async () => {
    for (const scenario of [
      { pending: pendingRun(), command: "run challenge_protocol_1 confirm 2", expected: "run_approval_mismatch", profileName: "test-profile", now: fixtureTimestamp },
      { pending: pendingRun(), command: "run challenge_protocol_1 confirm 1", expected: "run_approval_expired", profileName: "test-profile", now: validChallengeGetResponseFixture.result.challenge.run_grant.expires_at },
      { pending: pendingRun({ prompt_version: "cmai_contribution_v0", run_grant: { ...clone(validChallengeGetResponseFixture.result.challenge.run_grant), prompt_version: "cmai_contribution_v0" } }), command: "run challenge_protocol_1 confirm 1", expected: "run_approval_stale", profileName: "test-profile", now: fixtureTimestamp },
      { pending: pendingRun({ max_output_bytes: 32768, run_grant: { ...clone(validChallengeGetResponseFixture.result.challenge.run_grant), max_output_bytes: 32768 } }), command: "run challenge_protocol_1 confirm 1", expected: "run_approval_stale", profileName: "test-profile", now: fixtureTimestamp },
      { pending: pendingRun(), command: "run challenge_protocol_1 confirm 1", expected: "run_approval_context_changed", profileName: "other-profile", now: fixtureTimestamp },
    ]) {
      const runtimeAdapter = successfulRuntimeAdapter();
      const { controller } = harness({
        runtimeAdapter,
        pendingRun: scenario.pending,
        profileName: scenario.profileName,
        now: () => new Date(scenario.now),
      });
      await pair(controller);
      const result = await controller.execute(scenario.command);
      expect(result.code).toBe(scenario.expected);
      expect(result.text).toContain("No model call occurred");
      expect(runtimeAdapter.execute).not.toHaveBeenCalled();
    }
  });

  it("rechecks grant expiry after challenge refresh and before atomic consumption", async () => {
    const runtimeAdapter = successfulRuntimeAdapter();
    const expiry = validChallengeGetResponseFixture.result.challenge.run_grant.expires_at;
    const now = vi.fn()
      .mockReturnValueOnce(new Date(fixtureTimestamp))
      .mockReturnValueOnce(new Date(expiry));
    const { controller, consumePendingRun } = harness({ runtimeAdapter, pendingRun: pendingRun(), now });
    await pair(controller);

    const result = await controller.execute("run challenge_protocol_1 confirm 1");

    expect(result.code).toBe("run_approval_expired");
    expect(consumePendingRun).not.toHaveBeenCalled();
    expect(runtimeAdapter.execute).not.toHaveBeenCalled();
  });

  it("shows the complete validated preview and keeps submission fail-closed", async () => {
    const { controller, client, transport } = harness();
    await pair(controller);
    await client.fetchChallenge("challenge_protocol_1");
    client.prepareRun();
    client.preview({
      identity: { runtime: "hermes", runtimeVersion: "0.18.2", adapterName: "cmai-hermes", adapterVersion: "0.1.0" },
      localRunId: "local_run_1",
      card: clone(validContributionCardV1),
      providerClaim: "runtime-reported-provider",
      modelClaim: "runtime-reported-model",
      modelDisplayNameClaim: "Runtime-reported model",
      startedAt: fixtureTimestamp,
      completedAt: fixtureTimestamp,
      structuredOutputValidated: true,
    }, { userApprovedRun: true });
    const preview = await controller.execute("preview");
    expect(preview.text).toContain(JSON.stringify(validContributionCardV1.verdict));
    const refused = await controller.execute("submit");
    expect(refused.code).toBe("submission_unavailable");
    expect(transport.operations).not.toContain("contribution.submit");
    const reserved = await controller.execute("submit confirm");
    expect(reserved).toMatchObject({ ok: false, code: "submission_unavailable" });
    expect(reserved.text).toContain("Card 08");
    expect(transport.operations).not.toContain("contribution.submit");
  });

  it("discards locally and revokes only after explicit confirmation", async () => {
    const { controller, client, transport, clearPairing } = harness();
    await pair(controller);
    await client.fetchChallenge("challenge_protocol_1");
    client.prepareRun();
    client.preview({
      identity: { runtime: "hermes", adapterName: "cmai-hermes", adapterVersion: "0.1.0" },
      localRunId: "local_run_2",
      card: clone(validContributionCardV1),
      startedAt: fixtureTimestamp,
      completedAt: fixtureTimestamp,
      structuredOutputValidated: true,
    }, { userApprovedRun: true });
    expect((await controller.execute("discard")).code).toBe("discarded");
    expect((await controller.execute("revoke")).code).toBe("revocation_confirmation_required");
    expect(transport.operations).not.toContain("pairing.revoke");
    expect((await controller.execute("revoke confirm")).code).toBe("revoked");
    expect(transport.operations).toContain("pairing.revoke");
    expect(clearPairing).toHaveBeenCalledOnce();
  });

  it("preserves a newer durable preview when discard loses its identity CAS", async () => {
    const { controller, client, clearPreview } = harness({ clearPreview: async () => false });
    await pair(controller);
    await client.fetchChallenge("challenge_protocol_1");
    client.prepareRun();
    client.preview({
      identity: { runtime: "hermes", adapterName: "cmai-hermes", adapterVersion: "0.1.0" },
      localRunId: "local_run_cas",
      card: clone(validContributionCardV1),
      startedAt: fixtureTimestamp,
      completedAt: fixtureTimestamp,
      structuredOutputValidated: true,
    }, { userApprovedRun: true });

    expect(await controller.execute("discard")).toMatchObject({ ok: false, code: "preview_state_changed" });
    expect(clearPreview).toHaveBeenCalledWith("preview_adapter_test_1");
    expect(client.status().preview).toBeDefined();
  });

  it("keeps update local and refuses submission without a preview", async () => {
    const { controller, transport } = harness();
    expect((await controller.execute("submit confirm")).code).toBe("submission_unavailable");
    const update = await controller.execute("update");
    expect(update.text).toContain("does not self-update");
    expect(transport.operations).toEqual([]);
  });
});
