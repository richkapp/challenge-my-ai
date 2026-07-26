import { describe, expect, it } from "vitest";
import {
  agentChallengeGetRequestSchema,
  agentContributionSubmitRequestSchema,
  agentFeedListRequestSchema,
  agentPairingRevokeRequestSchema,
  agentPairingRotateKeyRequestSchema,
} from "@/lib/agent-protocol/schemas";
import { validContributionSubmitRequestFixture } from "@/lib/agent-protocol/fixtures";
import {
  AGENT_PROTOCOL_MAX_CLOCK_SKEW_MS,
  agentProtocolPreviewScopes,
  type AgentProtocolScope,
} from "@/lib/agent-protocol/constants";
import { AgentProtocolError } from "@/lib/agent-protocol/errors";
import {
  PairingPlatformError,
  PairingService,
  PAIRING_CODE_ISSUE_LIMIT,
  PAIRING_CODE_ISSUE_WINDOW_MS,
  MAX_PAIRING_RATE_LIMIT_BUCKETS,
  MAX_PAIRING_RATE_LIMIT_BUCKETS_TOTAL,
  MAX_AUTHORIZED_SUBMISSION_REQUEST_RECEIPTS_PER_PAIRING,
  authenticatedAgentOperationRateLimits,
  agentProtocolNetworkRateLimits,
  AUTHORIZED_REQUEST_RECEIPT_RETENTION_MS,
  hashPairingCode,
} from "@/lib/agent-pairing/service";
import {
  MemoryPairingStateBackend,
  POSTGRES_PAIRING_STATE_ROW_ID,
  POSTGRES_PAIRING_STATE_TABLE,
  PostgresPairingStateBackend,
  assertPairingPlatformStateV1,
  normalizePairingPlatformState,
  type PairingStateBackend,
  type MemoryPairingTransactionCoordinator,
} from "@/lib/agent-pairing/storage";
import {
  AGENT_PAIRING_STATE_V1_MIGRATION_ID,
  AGENT_PAIRING_STATE_V1_ROLLBACK_SQL,
  AGENT_PAIRING_STATE_V1_SQL,
} from "@/db/migrations/agent-pairing-state-v1";
import { CmaiPairingTelemetrySink } from "@/lib/agent-pairing/telemetry";
import { LocalTelemetryCollector } from "@/lib/telemetry/collector";
import {
  generatePairingTestKey,
  pairCreateRequest,
  signAgentRequest,
  signedPairingRequest,
  type PairingTestKey,
} from "@/lib/agent-pairing/testUtils";

function mutableClock(iso = "2026-07-15T12:00:00.000Z") {
  let nowMs = Date.parse(iso);
  return {
    now: () => new Date(nowMs),
    advance: (ms: number) => { nowMs += ms; },
    iso: () => new Date(nowMs).toISOString(),
  };
}

async function pairDevice(input: {
  service: PairingService;
  ownerId?: string;
  label?: string;
  deviceId?: string;
  key?: PairingTestKey;
  runtime?: "hermes" | "openclaw";
  requestId?: string;
  rateLimitKey?: string;
  requestedScopes?: AgentProtocolScope[];
  sentAt: string;
}) {
  const ownerId = input.ownerId || "owner-a";
  const label = input.label || "Test Agent";
  const key = input.key || generatePairingTestKey();
  const runtime = input.runtime || "hermes";
  const issued = await input.service.issuePairingCode({ ownerId, displayName: label, runtime });
  const request = pairCreateRequest({
    pairingCode: issued.pairing_code,
    key,
    sentAt: input.sentAt,
    ownerLabel: label,
    deviceId: input.deviceId,
    runtime,
    requestId: input.requestId,
    requestedScopes: input.requestedScopes,
  });
  const pairing = await input.service.redeemPairing(request, { rateLimitKey: input.rateLimitKey || "198.51.100.10" });
  return { ownerId, label, key, issued, request, pairing };
}

function feedRequest(input: { pairingId: string; key: PairingTestKey; sentAt: string; requestId: string; limit?: number }) {
  return agentFeedListRequestSchema.parse(signedPairingRequest({
    operation: "feed.list",
    requestId: input.requestId,
    sentAt: input.sentAt,
    pairingId: input.pairingId,
    key: input.key,
    payload: { limit: input.limit ?? 10 },
  }));
}

function contributionRequest(input: { pairingId: string; key: PairingTestKey; sentAt: string; requestId: string }) {
  const fixture = JSON.parse(JSON.stringify(validContributionSubmitRequestFixture));
  const request = {
    ...fixture,
    request_id: input.requestId,
    sent_at: input.sentAt,
    auth: {
      pairing_id: input.pairingId,
      key_id: input.key.keyId,
      signature: { algorithm: "ed25519" as const, value: "A".repeat(86) },
    },
  };
  return agentContributionSubmitRequestSchema.parse(signAgentRequest(request, input.key.privateKey));
}

describe("platform pairing service", () => {
  it("stores only a hash and atomically accepts one concurrent redemption", async () => {
    const clock = mutableClock();
    const backend = new MemoryPairingStateBackend();
    const service = new PairingService(backend, { clock: clock.now });
    const key = generatePairingTestKey();
    const issued = await service.issuePairingCode({ ownerId: "owner-a", runtime: "hermes", displayName: "Desk Agent" });
    expect(issued.pairing_code).toMatch(/^CMAI-(?:[A-F0-9]{8}-){4}[A-F0-9]{8}$/);

    const storedBefore = await backend.read();
    expect(storedBefore.codes[0].codeHash).toBe(hashPairingCode(issued.pairing_code));
    expect(JSON.stringify(storedBefore)).not.toContain(issued.pairing_code);

    const request = pairCreateRequest({ pairingCode: issued.pairing_code, key, sentAt: clock.iso(), ownerLabel: "Desk Agent" });
    const attempts = await Promise.allSettled([
      service.redeemPairing(request, { rateLimitKey: "203.0.113.1" }),
      service.redeemPairing(request, { rateLimitKey: "203.0.113.1" }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "pairing_not_found" } });

    const owner = await service.listOwnerPairings("owner-a");
    expect(owner.pairings).toHaveLength(1);
    expect(owner.pairings[0].device.display_name).toBe("Desk Agent");
    expect(JSON.stringify(owner.audit)).not.toContain(issued.pairing_code);
    expect(JSON.stringify(owner.audit)).not.toContain(key.publicKey);
    expect(JSON.stringify(attempts.find((attempt) => attempt.status === "fulfilled"))).not.toContain("owner-a");
  });

  it("collapses expired, consumed, cancelled, and label-mismatched codes into one error", async () => {
    const clock = mutableClock();
    const service = new PairingService(new MemoryPairingStateBackend(), { clock: clock.now });
    const key = generatePairingTestKey();

    const expired = await service.issuePairingCode({ ownerId: "owner-a", runtime: "hermes", displayName: "Agent A", ttlMs: 1_000 });
    clock.advance(1_000);
    await expect(service.redeemPairing(pairCreateRequest({ pairingCode: expired.pairing_code, key, sentAt: clock.iso(), ownerLabel: "Agent A" }), { rateLimitKey: "ip-a" }))
      .rejects.toMatchObject({ code: "pairing_not_found", message: "Pairing code is invalid or unavailable." });

    const mismatched = await service.issuePairingCode({ ownerId: "owner-a", runtime: "hermes", displayName: "Agent A" });
    await expect(service.redeemPairing(pairCreateRequest({ pairingCode: mismatched.pairing_code, key, sentAt: clock.iso(), ownerLabel: "Agent B" }), { rateLimitKey: "ip-a" }))
      .rejects.toMatchObject({ code: "pairing_not_found", message: "Pairing code is invalid or unavailable." });
    await expect(service.redeemPairing(pairCreateRequest({ pairingCode: mismatched.pairing_code, key, sentAt: clock.iso(), ownerLabel: "Agent A" }), { rateLimitKey: "ip-a" }))
      .rejects.toMatchObject({ code: "pairing_not_found", message: "Pairing code is invalid or unavailable." });

    const cancelled = await service.issuePairingCode({ ownerId: "owner-a", runtime: "hermes", displayName: "Agent A" });
    await service.issuePairingCode({ ownerId: "owner-a", runtime: "hermes", displayName: "Agent A" });
    await expect(service.redeemPairing(pairCreateRequest({ pairingCode: cancelled.pairing_code, key, sentAt: clock.iso(), ownerLabel: "Agent A" }), { rateLimitKey: "ip-a" }))
      .rejects.toMatchObject({ code: "pairing_not_found", message: "Pairing code is invalid or unavailable." });
  });

  it("keeps listing, renaming, revocation, and duplicate-device handling owner-bound", async () => {
    const clock = mutableClock();
    const service = new PairingService(new MemoryPairingStateBackend(), { clock: clock.now });
    const paired = await pairDevice({ service, sentAt: clock.iso(), label: "Owner Agent", deviceId: "device-owner-a" });

    expect((await service.listOwnerPairings("owner-b")).pairings).toEqual([]);
    await expect(service.renamePairing({ ownerId: "owner-b", pairingId: paired.pairing.pairing_id, displayName: "Stolen" }))
      .rejects.toMatchObject({ status: 404, code: "pairing_not_found" });
    await expect(service.revokeByOwner({ ownerId: "owner-b", pairingId: paired.pairing.pairing_id, reason: "user_requested" }))
      .rejects.toMatchObject({ status: 404, code: "pairing_not_found" });

    const renamed = await service.renamePairing({ ownerId: "owner-a", pairingId: paired.pairing.pairing_id, displayName: "Renamed Agent" });
    expect(renamed.device.display_name).toBe("Renamed Agent");

    const duplicateCode = await service.issuePairingCode({ ownerId: "owner-a", runtime: "hermes", displayName: "Renamed Agent" });
    const duplicateRequest = pairCreateRequest({
      pairingCode: duplicateCode.pairing_code,
      key: generatePairingTestKey("key_duplicate"),
      sentAt: clock.iso(),
      ownerLabel: "Renamed Agent",
      deviceId: "device-owner-a",
    });
    await expect(service.redeemPairing(duplicateRequest, { rateLimitKey: "ip-a-duplicate" })).rejects.toMatchObject({ code: "malformed_request", status: 400 });
    await expect(service.redeemPairing(duplicateRequest, { rateLimitKey: "ip-a-duplicate" })).rejects.toMatchObject({ code: "pairing_not_found" });
  });

  it("rotates atomically, rejects the retired key, accepts the new key, and records exact retries", async () => {
    const clock = mutableClock();
    const service = new PairingService(new MemoryPairingStateBackend(), { clock: clock.now });
    const first = generatePairingTestKey("key_rotation_1", 1);
    const paired = await pairDevice({ service, sentAt: clock.iso(), key: first });
    const second = generatePairingTestKey("key_rotation_2", 2);
    const rotation = agentPairingRotateKeyRequestSchema.parse(signedPairingRequest({
      operation: "pairing.rotate_key",
      requestId: "req_rotation_1",
      sentAt: clock.iso(),
      pairingId: paired.pairing.pairing_id,
      key: first,
      payload: {
        replaces_key_id: first.keyId,
        new_public_key: { algorithm: "ed25519", key_id: second.keyId, generation: 2, value: second.publicKey },
      },
    }));

    const rotated = await service.rotateKey(rotation);
    expect(rotated.keys).toMatchObject([
      { key_id: first.keyId, status: "retired" },
      { key_id: second.keyId, status: "active" },
    ]);
    await expect(service.rotateKey(rotation)).resolves.toEqual(rotated);
    clock.advance(AGENT_PROTOCOL_MAX_CLOCK_SKEW_MS + 1);
    await expect(service.rotateKey(rotation)).resolves.toEqual(rotated);
    await expect(service.authorizeAndExecute(feedRequest({ pairingId: paired.pairing.pairing_id, key: first, sentAt: clock.iso(), requestId: "req_old_key" }), () => "ok"))
      .rejects.toMatchObject({ code: "pairing_key_inactive" });
    await expect(service.authorizeAndExecute(feedRequest({ pairingId: paired.pairing.pairing_id, key: second, sentAt: clock.iso(), requestId: "req_new_key" }), () => "ok"))
      .resolves.toBe("ok");

    const rogue = generatePairingTestKey("key_rotation_rogue", 2);
    const forgedConflict = agentPairingRotateKeyRequestSchema.parse(signedPairingRequest({
      operation: "pairing.rotate_key",
      requestId: "req_rotation_1",
      sentAt: clock.iso(),
      pairingId: paired.pairing.pairing_id,
      key: { ...rogue, keyId: second.keyId },
      payload: {
        replaces_key_id: second.keyId,
        new_public_key: { algorithm: "ed25519", key_id: "key_rotation_forged", generation: 3, value: rogue.publicKey },
      },
    }));
    await expect(service.rotateKey(forgedConflict)).rejects.toMatchObject({ code: "signature_invalid" });

    const changedRetry = agentPairingRotateKeyRequestSchema.parse(signedPairingRequest({
      operation: "pairing.rotate_key",
      requestId: "req_rotation_1",
      sentAt: clock.iso(),
      pairingId: paired.pairing.pairing_id,
      key: second,
      payload: {
        replaces_key_id: second.keyId,
        new_public_key: { algorithm: "ed25519", key_id: "key_rotation_3", generation: 3, value: generatePairingTestKey("key_rotation_3", 3).publicKey },
      },
    }));
    await expect(service.rotateKey(changedRetry)).rejects.toMatchObject({ code: "idempotency_conflict" });

    const revokeRetired = agentPairingRevokeRequestSchema.parse(signedPairingRequest({
      operation: "pairing.revoke",
      requestId: "req_revoke_retired",
      sentAt: clock.iso(),
      pairingId: paired.pairing.pairing_id,
      key: second,
      payload: { revoke: "key", key_id: first.keyId, reason: "rotation_cleanup" },
    }));
    const cleaned = await service.revokeFromClient(revokeRetired);
    expect(cleaned.status).toBe("active");
    expect(cleaned.keys.find((key) => key.key_id === first.keyId)?.status).toBe("revoked");
    clock.advance(AGENT_PROTOCOL_MAX_CLOCK_SKEW_MS + 1);
    await expect(service.revokeFromClient(revokeRetired)).resolves.toEqual(cleaned);

    await service.revokeByOwner({ ownerId: "owner-a", pairingId: paired.pairing.pairing_id, reason: "user_requested" });
    await expect(service.rotateKey(rotation)).rejects.toMatchObject({ code: "pairing_revoked" });
  });

  it("persists authenticated pairing mutation failures for exact stale replay", async () => {
    const clock = mutableClock();
    const backend = new MemoryPairingStateBackend();
    const service = new PairingService(backend, { clock: clock.now });
    const first = generatePairingTestKey("key_failure_replay_1", 1);
    const paired = await pairDevice({ service, sentAt: clock.iso(), key: first });
    const replacement = generatePairingTestKey("key_failure_replay_2", 1);
    const invalid = agentPairingRotateKeyRequestSchema.parse(signedPairingRequest({
      operation: "pairing.rotate_key",
      requestId: "req_rotation_failure_replay",
      sentAt: clock.iso(),
      pairingId: paired.pairing.pairing_id,
      key: first,
      payload: {
        replaces_key_id: first.keyId,
        new_public_key: { algorithm: "ed25519", key_id: replacement.keyId, generation: 1, value: replacement.publicKey },
      },
    }));

    await expect(service.rotateKey(invalid)).rejects.toMatchObject({
      code: "malformed_request",
      status: 400,
      message: "Replacement key generation must increase.",
    });
    const stored = await backend.read();
    expect(stored.mutationReceipts).toHaveLength(1);
    expect(stored.mutationReceipts[0]?.outcome).toMatchObject({
      kind: "error",
      source: "protocol",
      code: "malformed_request",
      status: 400,
      retryable: false,
    });

    clock.advance(AGENT_PROTOCOL_MAX_CLOCK_SKEW_MS + 1);
    await expect(service.rotateKey(invalid)).rejects.toMatchObject({
      code: "malformed_request",
      status: 400,
      message: "Replacement key generation must increase.",
    });
    expect((await backend.read()).mutationReceipts).toHaveLength(1);
  });

  it("enforces a durable per-principal pairing-mutation rate without charging exact failure replays", async () => {
    const clock = mutableClock();
    const backend = new MemoryPairingStateBackend();
    const service = new PairingService(backend, { clock: clock.now });
    const key = generatePairingTestKey("key_mutation_rate_1", 1);
    const paired = await pairDevice({ service, sentAt: clock.iso(), key });
    let limitedRequest!: ReturnType<typeof agentPairingRotateKeyRequestSchema.parse>;
    for (let index = 0; index <= 12; index += 1) {
      const replacement = generatePairingTestKey(`key_mutation_rate_${index + 2}`, 1);
      const request = agentPairingRotateKeyRequestSchema.parse(signedPairingRequest({
        operation: "pairing.rotate_key",
        requestId: `req_mutation_rate_${index}`,
        sentAt: clock.iso(),
        pairingId: paired.pairing.pairing_id,
        key,
        payload: {
          replaces_key_id: key.keyId,
          new_public_key: { algorithm: "ed25519", key_id: replacement.keyId, generation: 1, value: replacement.publicKey },
        },
      }));
      if (index < 12) {
        await expect(service.rotateKey(request)).rejects.toMatchObject({ code: "malformed_request", status: 400 });
      } else {
        limitedRequest = request;
        await expect(service.rotateKey(request)).rejects.toMatchObject({ code: "rate_limited", status: 429 });
      }
    }
    const beforeReplay = await backend.read();
    expect(beforeReplay.mutationReceipts).toHaveLength(13);
    expect(beforeReplay.rateLimitBuckets.find((bucket) => bucket.capacityClass === "principal:pairing.rotate_key")?.count).toBe(13);
    clock.advance(AGENT_PROTOCOL_MAX_CLOCK_SKEW_MS + 1);
    await expect(service.rotateKey(limitedRequest)).rejects.toMatchObject({ code: "rate_limited", status: 429 });
    const afterReplay = await backend.read();
    expect(afterReplay.mutationReceipts).toHaveLength(13);
    expect(afterReplay.rateLimitBuckets.find((bucket) => bucket.capacityClass === "principal:pairing.rotate_key")).toBeUndefined();
  });

  it("resets durable issue limits after the window", async () => {
    const clock = mutableClock();
    const service = new PairingService(new MemoryPairingStateBackend(), { clock: clock.now });
    for (let index = 0; index < PAIRING_CODE_ISSUE_LIMIT; index += 1) {
      await service.issuePairingCode({ ownerId: "owner-rate", runtime: "hermes", displayName: `Agent ${index}` });
    }
    await expect(service.issuePairingCode({ ownerId: "owner-rate", runtime: "hermes", displayName: "Blocked Agent" }))
      .rejects.toBeInstanceOf(PairingPlatformError);
    clock.advance(PAIRING_CODE_ISSUE_WINDOW_MS);
    await expect(service.issuePairingCode({ ownerId: "owner-rate", runtime: "hermes", displayName: "Allowed Again" }))
      .resolves.toMatchObject({ runtime: "hermes" });
  });

  it("fails closed before attacker-controlled rate-limit buckets can grow without bound", async () => {
    const clock = mutableClock();
    const resetAt = new Date(clock.now().getTime() + PAIRING_CODE_ISSUE_WINDOW_MS).toISOString();
    const initialBuckets = Array.from({ length: MAX_PAIRING_RATE_LIMIT_BUCKETS }, (_, index) => ({
      bucketHash: index.toString(16).padStart(64, "0"),
      capacityClass: "network:pair_create",
      count: 1,
      resetAt,
    }));
    const backend = new MemoryPairingStateBackend({ rateLimitBuckets: initialBuckets });
    const service = new PairingService(backend, { clock: clock.now });
    const key = generatePairingTestKey("rate_bucket_capacity_key");
    const request = pairCreateRequest({
      pairingCode: "CMAI-00000000-00000000-00000000-00000000-00000000",
      key,
      sentAt: clock.iso(),
      ownerLabel: "Capacity Probe",
    });

    await expect(service.redeemPairing(request, { rateLimitKey: "new-network-identity" }))
      .rejects.toMatchObject({ code: "pairing_capacity_exceeded", status: 503 });

    const stored = await backend.read();
    expect(stored.rateLimitBuckets).toHaveLength(MAX_PAIRING_RATE_LIMIT_BUCKETS);
    expect(stored.codes).toEqual([]);
    expect(stored.pairings).toEqual([]);
  });

  it("reserves read replay capacity when one pairing exhausts its submission receipt quota", async () => {
    const clock = mutableClock();
    const seedBackend = new MemoryPairingStateBackend();
    const seedService = new PairingService(seedBackend, { clock: clock.now });
    const paired = await pairDevice({ service: seedService, sentAt: clock.iso() });
    const initialState = await seedBackend.read();
    initialState.authorizedRequestReceipts = Array.from(
      { length: MAX_AUTHORIZED_SUBMISSION_REQUEST_RECEIPTS_PER_PAIRING },
      (_, index) => ({
        pairingId: paired.pairing.pairing_id,
        operation: "contribution.submit" as const,
        requestId: `submission_capacity_${index}`,
        requestHash: index.toString(16).padStart(64, "0"),
        createdAt: clock.iso(),
        expiresAt: new Date(clock.now().getTime() + 30 * 24 * 60 * 60_000).toISOString(),
      }),
    );
    const persistedPerPairingOverflow = structuredClone(initialState);
    persistedPerPairingOverflow.authorizedRequestReceipts.push({
      pairingId: paired.pairing.pairing_id,
      operation: "contribution.submit",
      requestId: "submission_capacity_overflow",
      requestHash: "f".repeat(64),
      createdAt: clock.iso(),
      expiresAt: new Date(clock.now().getTime() + 30 * 24 * 60 * 60_000).toISOString(),
    });
    expect(() => assertPairingPlatformStateV1(persistedPerPairingOverflow)).toThrow(/missing or incompatible/i);
    const persistedRetentionOverflow = structuredClone(initialState);
    persistedRetentionOverflow.authorizedRequestReceipts[0]!.expiresAt = new Date(clock.now().getTime() + 30 * 24 * 60 * 60_000 + 1).toISOString();
    expect(() => assertPairingPlatformStateV1(persistedRetentionOverflow)).toThrow(/missing or incompatible/i);

    const backend = new MemoryPairingStateBackend(initialState);
    const service = new PairingService(backend, { clock: clock.now });

    await expect(service.authorizeAndExecute(feedRequest({
      pairingId: paired.pairing.pairing_id,
      key: paired.key,
      sentAt: clock.iso(),
      requestId: "read_capacity_reserved",
    }), () => ({ ok: true }))).resolves.toEqual({ ok: true });

    let submissionActionRan = false;
    await expect(service.authorizeAndExecute(contributionRequest({
      pairingId: paired.pairing.pairing_id,
      key: paired.key,
      sentAt: clock.iso(),
      requestId: "submission_capacity_blocked",
    }), () => {
      submissionActionRan = true;
      return { ok: true };
    })).rejects.toMatchObject({ code: "capacity_exceeded", status: 503 });
    expect(submissionActionRan).toBe(false);
    const stored = await backend.read();
    expect(stored.authorizedRequestReceipts.filter((receipt) => receipt.operation === "feed.list")).toHaveLength(1);
    expect(stored.authorizedRequestReceipts.filter((receipt) => receipt.operation === "contribution.submit"))
      .toHaveLength(MAX_AUTHORIZED_SUBMISSION_REQUEST_RECEIPTS_PER_PAIRING);
  });

  it("always releases the local backend queue after coordinator and action failures", async () => {
    const stages = ["begin", "initial_coherence", "action", "final_coherence", "commit"] as const;
    for (const stage of stages) {
      let failed = false;
      const coordinator: MemoryPairingTransactionCoordinator = {
        begin() {
          if (stage === "begin" && !failed) {
            failed = true;
            throw new Error("injected begin failure");
          }
          let coherenceCalls = 0;
          return {
            agentFeedStore: {
              transactAgentFeedRequest() { throw new Error("unused request transaction"); },
              submitAgentFeedContribution() { throw new Error("unused submission transaction"); },
            },
            assertCoherence() {
              coherenceCalls += 1;
              if (stage === "initial_coherence" && coherenceCalls === 1 && !failed) {
                failed = true;
                throw new Error("injected initial coherence failure");
              }
              if (stage === "final_coherence" && coherenceCalls === 2 && !failed) {
                failed = true;
                throw new Error("injected final coherence failure");
              }
            },
            commit() {
              if (stage === "commit" && !failed) {
                failed = true;
                throw new Error("injected coordinator commit failure");
              }
            },
          };
        },
      };
      const backend = new MemoryPairingStateBackend({}, coordinator);
      await expect(backend.transact((state) => {
        state.rateLimitBuckets.push({
          bucketHash: "a".repeat(64),
          capacityClass: "queue-release-proof",
          count: 1,
          resetAt: "2030-01-01T00:00:00.000Z",
        });
        if (stage === "action" && !failed) {
          failed = true;
          throw new Error("injected action failure");
        }
      })).rejects.toThrow(/injected/);

      const readAfterFailure = await Promise.race([
        backend.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`queue remained wedged after ${stage}`)), 250)),
      ]);
      expect(readAfterFailure.rateLimitBuckets).toEqual([]);
      await expect(backend.transact(() => "released")).resolves.toBe("released");
    }
  });

  it("fails closed at the aggregate persisted rate-bucket bound across capacity classes", async () => {
    const clock = mutableClock();
    const resetAt = new Date(clock.now().getTime() + PAIRING_CODE_ISSUE_WINDOW_MS).toISOString();
    const initialBuckets = Array.from({ length: MAX_PAIRING_RATE_LIMIT_BUCKETS_TOTAL }, (_, index) => ({
      bucketHash: index.toString(16).padStart(64, "0"),
      capacityClass: `capacity_class_${Math.floor(index / MAX_PAIRING_RATE_LIMIT_BUCKETS)}`,
      count: 1,
      resetAt,
    }));
    const backend = new MemoryPairingStateBackend({ rateLimitBuckets: initialBuckets });
    const service = new PairingService(backend, { clock: clock.now });

    await expect(service.issuePairingCode({ ownerId: "owner-aggregate-capacity", runtime: "hermes", displayName: "Aggregate Capacity" }))
      .rejects.toMatchObject({ code: "pairing_capacity_exceeded", status: 503 });
    expect((await backend.read()).rateLimitBuckets).toHaveLength(MAX_PAIRING_RATE_LIMIT_BUCKETS_TOTAL);
  });

  it("isolates unauthenticated Agent-feed bucket exhaustion from pairing and principal capacity", async () => {
    const clock = mutableClock();
    const resetAt = new Date(clock.now().getTime() + 60_000).toISOString();
    const backend = new MemoryPairingStateBackend({
      rateLimitBuckets: Array.from({ length: MAX_PAIRING_RATE_LIMIT_BUCKETS }, (_, index) => ({
        bucketHash: index.toString(16).padStart(64, "0"),
        capacityClass: "network:agent_feed",
        count: 1,
        resetAt,
      })),
    });
    const service = new PairingService(backend, { clock: clock.now });

    await expect(service.assertAgentFeedNetworkRateLimit({ identity: "new-feed-network" }))
      .rejects.toMatchObject({ code: "capacity_exceeded", status: 503 });
    await expect(service.issuePairingCode({
      ownerId: "owner-capacity-isolated",
      runtime: "hermes",
      displayName: "Capacity Isolated Agent",
    })).resolves.toMatchObject({ runtime: "hermes" });
  });

  it("checks fresh revocation state and linearizes revoke-versus-submit", async () => {
    const clock = mutableClock();
    const service = new PairingService(new MemoryPairingStateBackend(), { clock: clock.now });
    const paired = await pairDevice({ service, sentAt: clock.iso(), ownerId: "owner-race", requestId: "req_pair_race" });
    const submission = contributionRequest({ pairingId: paired.pairing.pairing_id, key: paired.key, sentAt: clock.iso(), requestId: "req_submit_race_1" });

    await expect(service.authorizeAndExecute(submission, () => "authorized")).resolves.toBe("authorized");
    await service.revokeByOwner({ ownerId: "owner-race", pairingId: paired.pairing.pairing_id, reason: "device_lost" });
    await expect(service.authorizeAndExecute(submission, () => "stale-cache-bypass"))
      .rejects.toMatchObject({ code: "pairing_revoked" });

    const second = await pairDevice({
      service,
      sentAt: clock.iso(),
      ownerId: "owner-race-2",
      deviceId: "device-race-2",
      requestId: "req_pair_race_2",
      rateLimitKey: "ip-race-2",
    });
    const secondSubmission = contributionRequest({ pairingId: second.pairing.pairing_id, key: second.key, sentAt: clock.iso(), requestId: "req_submit_race_2" });
    const revokeFirst = service.revokeByOwner({ ownerId: "owner-race-2", pairingId: second.pairing.pairing_id, reason: "suspected_compromise" });
    const submitSecond = service.authorizeAndExecute(secondSubmission, () => "submitted");
    const [revokeResult, submitResult] = await Promise.allSettled([revokeFirst, submitSecond]);
    expect(revokeResult.status).toBe("fulfilled");
    expect(submitResult).toMatchObject({ status: "rejected", reason: { code: "pairing_revoked" } });

    const third = await pairDevice({
      service,
      sentAt: clock.iso(),
      ownerId: "owner-race-3",
      deviceId: "device-race-3",
      requestId: "req_pair_race_3",
      rateLimitKey: "ip-race-3",
    });
    const thirdSubmission = contributionRequest({ pairingId: third.pairing.pairing_id, key: third.key, sentAt: clock.iso(), requestId: "req_submit_race_3" });
    let releaseAction!: () => void;
    let actionEntered!: () => void;
    const actionGate = new Promise<void>((resolve) => { releaseAction = resolve; });
    const entered = new Promise<void>((resolve) => { actionEntered = resolve; });
    const submitFirst = service.authorizeAndExecute(thirdSubmission, async () => {
      actionEntered();
      await actionGate;
      return "submitted-before-revoke";
    });
    await entered;
    const revokeSecond = service.revokeByOwner({ ownerId: "owner-race-3", pairingId: third.pairing.pairing_id, reason: "user_requested" });
    releaseAction();
    await expect(submitFirst).resolves.toBe("submitted-before-revoke");
    await expect(revokeSecond).resolves.toMatchObject({ status: "revoked" });
  });

  it("emits only telemetry-contract allowlisted pseudonyms", async () => {
    const clock = mutableClock();
    const collector = new LocalTelemetryCollector({ mode: "local", environment: "test", provider: "disabled" });
    const sink = new CmaiPairingTelemetrySink(collector, "pairing-telemetry-test-only".repeat(2));
    const service = new PairingService(new MemoryPairingStateBackend(), { clock: clock.now, telemetry: sink });
    const paired = await pairDevice({ service, sentAt: clock.iso(), ownerId: "owner-private", label: "Private Label" });
    await service.revokeByOwner({ ownerId: "owner-private", pairingId: paired.pairing.pairing_id, reason: "user_requested" });

    const serialized = JSON.stringify(collector.list());
    expect(collector.list().map((event) => event.event)).toEqual(["pairing.created", "pairing.revoked"]);
    expect(serialized).not.toContain("owner-private");
    expect(serialized).not.toContain(paired.pairing.pairing_id);
    expect(serialized).not.toContain(paired.issued.pairing_code);
    expect(serialized).not.toContain("Private Label");
    expect(collector.list()[0]?.properties.pairing_scope).toBe("read_run_submit_manage");
  });

  it("derives preview-only pairing telemetry from the actual granted scopes", async () => {
    const clock = mutableClock();
    const collector = new LocalTelemetryCollector({ mode: "local", environment: "test", provider: "disabled" });
    const sink = new CmaiPairingTelemetrySink(collector, "pairing-telemetry-test-only".repeat(2));
    const service = new PairingService(new MemoryPairingStateBackend(), { clock: clock.now, telemetry: sink });

    await pairDevice({
      service,
      sentAt: clock.iso(),
      ownerId: "owner-preview-private",
      requestedScopes: [...agentProtocolPreviewScopes],
    });

    expect(collector.list()).toHaveLength(1);
    expect(collector.list()[0]?.properties.pairing_scope).toBe("read_run_manage");
  });

  it("rolls back pairing authorization state when the protected action fails", async () => {
    const clock = mutableClock();
    const backend = new MemoryPairingStateBackend();
    const service = new PairingService(backend, { clock: clock.now });
    const paired = await pairDevice({ service, sentAt: clock.iso(), ownerId: "owner-action-rollback", requestId: "req_pair_action_rollback" });
    const request = feedRequest({
      pairingId: paired.pairing.pairing_id,
      key: paired.key,
      sentAt: clock.iso(),
      requestId: "req_action_rollback",
    });
    await expect(service.authorizeAndExecute(request, () => {
      throw new AgentProtocolError("challenge_unavailable", "Projection failed.", 404, false);
    })).rejects.toMatchObject({ code: "challenge_unavailable", status: 404 });
    const afterFailure = await backend.read();
    expect(afterFailure.authorizedRequestReceipts).toEqual([]);
    expect(afterFailure.rateLimitBuckets.some((bucket) => bucket.capacityClass === "principal:feed.list")).toBe(false);
    await expect(service.authorizeAndExecute(request, (authorization) => authorization.requestReplay)).resolves.toBe("new");
    const afterRetry = await backend.read();
    expect(afterRetry.authorizedRequestReceipts).toHaveLength(1);
    expect(afterRetry.rateLimitBuckets.find((bucket) => bucket.capacityClass === "principal:feed.list")?.count).toBe(1);
  });

  it("persists bounded signed-request receipts, marks exact replay, and rejects conflicting reuse", async () => {
    const clock = mutableClock();
    const backend = new MemoryPairingStateBackend();
    const service = new PairingService(backend, { clock: clock.now });
    const paired = await pairDevice({ service, sentAt: clock.iso(), ownerId: "owner-receipt", deviceId: "device-receipt" });
    const request = feedRequest({ pairingId: paired.pairing.pairing_id, key: paired.key, sentAt: clock.iso(), requestId: "req_feed_receipt" });

    await expect(service.authorizeAndExecute(request, (context) => context.requestReplay)).resolves.toBe("new");
    await expect(service.authorizeAndExecute(request, (context) => context.requestReplay)).resolves.toBe("exact");
    clock.advance(AGENT_PROTOCOL_MAX_CLOCK_SKEW_MS + 1);
    await expect(service.authorizeAndExecute(request, (context) => context.requestReplay)).resolves.toBe("exact");
    const staleNewRequest = feedRequest({
      pairingId: paired.pairing.pairing_id,
      key: paired.key,
      sentAt: request.sent_at,
      requestId: "req_feed_stale_new",
    });
    await expect(service.authorizeAndExecute(staleNewRequest, () => "forbidden"))
      .rejects.toMatchObject({ code: "request_time_skew" });

    const conflict = feedRequest({ pairingId: paired.pairing.pairing_id, key: paired.key, sentAt: clock.iso(), requestId: "req_feed_receipt", limit: 11 });
    await expect(service.authorizeAndExecute(conflict, () => "forbidden")).rejects.toMatchObject({ code: "idempotency_conflict", field: "$.request_id" });

    const stored = await backend.read();
    expect(stored.authorizedRequestReceipts).toHaveLength(1);
    expect(stored.rateLimitBuckets.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...stored.rateLimitBuckets.map((bucket) => bucket.count))).toBe(1);
    const serialized = JSON.stringify(stored.authorizedRequestReceipts);
    expect(serialized).not.toContain(request.auth.signature.value);
    expect(serialized).not.toContain("cursor");

    clock.advance(AUTHORIZED_REQUEST_RECEIPT_RETENTION_MS);
    const fresh = feedRequest({ pairingId: paired.pairing.pairing_id, key: paired.key, sentAt: clock.iso(), requestId: "req_feed_after_expiry" });
    await service.authorizeAndExecute(fresh, (context) => context.requestReplay);
    const pruned = await backend.read();
    expect(pruned.authorizedRequestReceipts.map((receipt) => receipt.requestId)).toEqual(["req_feed_after_expiry"]);
  });

  it("enforces a bounded durable pre-auth network limit", async () => {
    const clock = mutableClock();
    const backend = new MemoryPairingStateBackend();
    const service = new PairingService(backend, { clock: clock.now });
    const policy = agentProtocolNetworkRateLimits["challenge.get"];
    for (let index = 0; index < policy.limit; index += 1) {
      await service.assertProtocolNetworkRateLimit({ identity: "198.51.100.90", operation: "challenge.get" });
    }
    await expect(service.assertProtocolNetworkRateLimit({ identity: "198.51.100.90", operation: "challenge.get" })).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
      retryAfterSeconds: 60,
    });
    const stored = await backend.read();
    expect(JSON.stringify(stored.rateLimitBuckets)).not.toContain("198.51.100.90");
    expect(Math.max(...stored.rateLimitBuckets.map((bucket) => bucket.count))).toBe(policy.limit + 1);
  });

  it("normalizes pairing-backend outages to retryable Protocol service_unavailable errors", async () => {
    const backend: PairingStateBackend = {
      read: async () => { throw new Error("database unavailable"); },
      transact: async () => { throw new Error("database unavailable"); },
    };
    const clock = mutableClock();
    const service = new PairingService(backend, { clock: clock.now });
    const request = feedRequest({
      pairingId: "pairing_backend_outage",
      key: generatePairingTestKey("backend_outage_key"),
      sentAt: clock.iso(),
      requestId: "req_backend_outage",
    });

    await expect(service.assertAgentFeedNetworkRateLimit({ identity: "outage-network" }))
      .rejects.toMatchObject({ code: "service_unavailable", status: 503, retryable: true, retryAfterSeconds: 1 });
    await expect(service.authorizeAndExecute(request, () => "forbidden"))
      .rejects.toMatchObject({ code: "service_unavailable", status: 503, retryable: true, retryAfterSeconds: 1 });

    const outageKey = generatePairingTestKey("backend_outage_mutation_key", 1);
    await expect(service.redeemPairing(pairCreateRequest({
      pairingCode: "CMAI-00000000-00000000-00000000-00000000-00000000",
      key: outageKey,
      sentAt: clock.iso(),
    }), { rateLimitKey: "outage-network" }))
      .rejects.toMatchObject({ code: "service_unavailable", status: 503, retryable: true, retryAfterSeconds: 1 });
    const rotatedKey = generatePairingTestKey("backend_outage_mutation_key_2", 2);
    const rotation = agentPairingRotateKeyRequestSchema.parse(signedPairingRequest({
      operation: "pairing.rotate_key",
      requestId: "req_backend_outage_rotate",
      sentAt: clock.iso(),
      pairingId: "pairing_backend_outage",
      key: outageKey,
      payload: {
        replaces_key_id: outageKey.keyId,
        new_public_key: { algorithm: "ed25519", key_id: rotatedKey.keyId, generation: 2, value: rotatedKey.publicKey },
      },
    }));
    await expect(service.rotateKey(rotation))
      .rejects.toMatchObject({ code: "service_unavailable", status: 503, retryable: true, retryAfterSeconds: 1 });
    const revocation = agentPairingRevokeRequestSchema.parse(signedPairingRequest({
      operation: "pairing.revoke",
      requestId: "req_backend_outage_revoke",
      sentAt: clock.iso(),
      pairingId: "pairing_backend_outage",
      key: outageKey,
      payload: { revoke: "pairing", reason: "user_requested" },
    }));
    await expect(service.revokeFromClient(revocation))
      .rejects.toMatchObject({ code: "service_unavailable", status: 503, retryable: true, retryAfterSeconds: 1 });
  });

  it("enforces durable per-pairing operation limits without charging exact replays", async () => {
    const clock = mutableClock();
    const backend = new MemoryPairingStateBackend();
    const service = new PairingService(backend, { clock: clock.now });
    const paired = await pairDevice({ service, sentAt: clock.iso(), ownerId: "owner-rate", deviceId: "device-rate" });
    const first = feedRequest({ pairingId: paired.pairing.pairing_id, key: paired.key, sentAt: clock.iso(), requestId: "req_feed_rate_0" });
    await service.authorizeAndExecute(first, () => true);
    for (let index = 0; index < 10; index += 1) {
      await service.authorizeAndExecute(first, (context) => context.requestReplay);
    }
    for (let index = 1; index < authenticatedAgentOperationRateLimits["feed.list"].limit; index += 1) {
      const request = feedRequest({ pairingId: paired.pairing.pairing_id, key: paired.key, sentAt: clock.iso(), requestId: `req_feed_rate_${index}` });
      await service.authorizeAndExecute(request, () => true);
    }
    const blocked = feedRequest({ pairingId: paired.pairing.pairing_id, key: paired.key, sentAt: clock.iso(), requestId: "req_feed_rate_blocked" });
    await expect(service.authorizeAndExecute(blocked, () => true)).rejects.toMatchObject({
      code: "rate_limited",
      status: 429,
      retryable: true,
      retryAfterSeconds: 60,
    });

    const stored = await backend.read();
    expect(stored.authorizedRequestReceipts).toHaveLength(authenticatedAgentOperationRateLimits["feed.list"].limit);
    expect(Math.max(...stored.rateLimitBuckets.map((bucket) => bucket.count))).toBe(authenticatedAgentOperationRateLimits["feed.list"].limit + 1);
  });

  it("keeps one shared state contract for local and Postgres backends", () => {
    expect(POSTGRES_PAIRING_STATE_TABLE).toBe("cmai_agent_pairing_state");
    expect(POSTGRES_PAIRING_STATE_ROW_ID).toBe("default");
    expect(typeof PostgresPairingStateBackend.prototype.read).toBe("function");
    expect(typeof PostgresPairingStateBackend.prototype.transact).toBe("function");
    expect(AGENT_PAIRING_STATE_V1_MIGRATION_ID).toBe("2026-07-15-agent-pairing-state-v1");
    expect(AGENT_PAIRING_STATE_V1_SQL).toMatch(/CREATE TABLE IF NOT EXISTS cmai_agent_pairing_state/i);
    expect(AGENT_PAIRING_STATE_V1_SQL).toMatch(/INSERT INTO cmai_agent_pairing_state/i);
    expect(AGENT_PAIRING_STATE_V1_ROLLBACK_SQL).toContain("refusing to roll back non-empty Agent pairing state");
    expect(AGENT_PAIRING_STATE_V1_ROLLBACK_SQL).toContain("unexpected rows");
    expect(PostgresPairingStateBackend.prototype.read.toString()).not.toMatch(/CREATE TABLE|INSERT INTO/i);
    expect(normalizePairingPlatformState({})).toEqual({
      schemaVersion: 1,
      codes: [],
      pairings: [],
      auditEvents: [],
      mutationReceipts: [],
      authorizedRequestReceipts: [],
      rateLimitBuckets: [],
    });
    expect(() => normalizePairingPlatformState({ schemaVersion: 2 as 1 })).toThrow("Unsupported pairing state schema version");
    expect(assertPairingPlatformStateV1(normalizePairingPlatformState({}))).toEqual(normalizePairingPlatformState({}));
    expect(() => assertPairingPlatformStateV1({ schemaVersion: 1, codes: [] })).toThrow("missing or incompatible");
    expect(() => assertPairingPlatformStateV1({
      ...normalizePairingPlatformState({}),
      codes: [{
        id: "code_nested_malformed",
        ownerId: "owner_nested_malformed",
        codeHash: "not-a-sha256-hash",
        expectedRuntime: "hermes",
        expectedDisplayName: "Malformed",
        allowedScopes: ["challenge:read"],
        createdAt: "not-a-date",
        expiresAt: "not-a-date",
      }],
    })).toThrow("missing or incompatible");
    expect(() => assertPairingPlatformStateV1({ ...normalizePairingPlatformState({}), schemaVersion: 2 })).toThrow("missing or incompatible");
  });

  it("rejects dangling pairing references, mismatched mutation snapshots, and invalid receipt chronology", async () => {
    const clock = mutableClock();
    const backend = new MemoryPairingStateBackend();
    const service = new PairingService(backend, { clock: clock.now });
    const paired = await pairDevice({
      service,
      sentAt: clock.iso(),
      ownerId: "owner-persisted-invariants",
      requestId: "req_pair_persisted_invariants",
    });
    const valid = await backend.read();
    expect(() => assertPairingPlatformStateV1(valid)).not.toThrow();

    const danglingReceipt = structuredClone(valid);
    danglingReceipt.authorizedRequestReceipts.push({
      pairingId: "pairing_missing",
      requestId: "req_dangling_receipt",
      operation: "feed.list",
      requestHash: "4".repeat(64),
      createdAt: clock.iso(),
      expiresAt: new Date(clock.now().getTime() - 1).toISOString(),
    });
    expect(() => assertPairingPlatformStateV1(danglingReceipt)).toThrow("missing or incompatible");

    const mismatchedMutation = structuredClone(valid);
    mismatchedMutation.mutationReceipts.push({
      pairingId: paired.pairing.pairing_id,
      requestId: "req_mismatched_mutation",
      operation: "pairing.revoke",
      requestHash: "5".repeat(64),
      outcome: {
        kind: "success",
        pairingState: { ...paired.pairing, pairing_id: "pairing_other" },
      },
      createdAt: clock.iso(),
    });
    expect(() => assertPairingPlatformStateV1(mismatchedMutation)).toThrow("missing or incompatible");

    const crossAudienceAudit = structuredClone(valid);
    const pairedAudit = crossAudienceAudit.auditEvents.find((event) => event.pairingId);
    expect(pairedAudit).toBeDefined();
    if (pairedAudit) pairedAudit.ownerId = "owner_other";
    expect(() => assertPairingPlatformStateV1(crossAudienceAudit)).toThrow("missing or incompatible");
  });

  it("rejects invalid signatures and scopes without widening authority", async () => {
    const clock = mutableClock();
    const service = new PairingService(new MemoryPairingStateBackend(), { clock: clock.now });
    const key = generatePairingTestKey();
    const issued = await service.issuePairingCode({ ownerId: "owner-scope", runtime: "hermes", displayName: "Scoped Agent" });
    const subset = pairCreateRequest({ pairingCode: issued.pairing_code, key, sentAt: clock.iso(), ownerLabel: "Scoped Agent" });
    subset.payload.requested_scopes = ["challenge:read"];
    await expect(service.redeemPairing(subset, { rateLimitKey: "ip-scope" })).rejects.toMatchObject({ code: "scope_unauthorized" });

    const previewIssued = await service.issuePairingCode({ ownerId: "owner-preview", runtime: "hermes", displayName: "Preview Agent" });
    const previewRequest = pairCreateRequest({ pairingCode: previewIssued.pairing_code, key, sentAt: clock.iso(), ownerLabel: "Preview Agent" });
    previewRequest.payload.requested_scopes = ["challenge:read", "challenge:run", "pairing:manage"];
    const previewPaired = await service.redeemPairing(previewRequest, { rateLimitKey: "ip-preview" });
    expect(previewPaired.granted_scopes).toEqual(["challenge:read", "challenge:run", "pairing:manage"]);
    const unauthorizedSubmission = contributionRequest({
      pairingId: previewPaired.pairing_id,
      key,
      sentAt: clock.iso(),
      requestId: "req_preview_submit_denied",
    });
    await expect(service.authorizeAndExecute(unauthorizedSubmission, () => "forbidden"))
      .rejects.toMatchObject({ code: "scope_unauthorized" });

    const paired = await pairDevice({ service, sentAt: clock.iso(), ownerId: "owner-sig", deviceId: "device-sig", requestId: "req_pair_sig" });
    const request = feedRequest({ pairingId: paired.pairing.pairing_id, key: paired.key, sentAt: clock.iso(), requestId: "req_bad_sig" });
    request.auth.signature.value = request.auth.signature.value.replace(/^./, request.auth.signature.value[0] === "A" ? "B" : "A");
    await expect(service.authorizeAndExecute(request, () => "forbidden")).rejects.toBeInstanceOf(AgentProtocolError);
    await expect(service.authorizeAndExecute(request, () => "forbidden")).rejects.toMatchObject({ code: "signature_invalid" });
  });
});
