import { agentFeedListRequestSchema, agentPairingRotateKeyRequestSchema } from "@/lib/agent-protocol/schemas";
import { PairingService } from "@/lib/agent-pairing/service";
import { MemoryPairingStateBackend } from "@/lib/agent-pairing/storage";
import { generatePairingTestKey, pairCreateRequest, signedPairingRequest } from "@/lib/agent-pairing/testUtils";

export async function runLocalPairingSmoke() {
  const now = new Date("2026-07-15T12:00:00.000Z");
  const backend = new MemoryPairingStateBackend();
  const service = new PairingService(backend, { clock: () => new Date(now) });
  const firstKey = generatePairingTestKey("smoke_key_1", 1);
  const issued = await service.issuePairingCode({
    ownerId: "smoke-owner",
    runtime: "hermes",
    displayName: "Smoke Agent",
  });
  const paired = await service.redeemPairing(pairCreateRequest({
    pairingCode: issued.pairing_code,
    key: firstKey,
    sentAt: now.toISOString(),
    ownerLabel: "Smoke Agent",
    deviceId: "smoke_device_1",
    requestId: "req_smoke_pair_1",
  }), { rateLimitKey: "local-smoke" });
  const renamed = await service.renamePairing({
    ownerId: "smoke-owner",
    pairingId: paired.pairing_id,
    displayName: "Smoke Agent Renamed",
  });

  const secondKey = generatePairingTestKey("smoke_key_2", 2);
  const rotation = agentPairingRotateKeyRequestSchema.parse(signedPairingRequest({
    operation: "pairing.rotate_key",
    requestId: "req_smoke_rotate_1",
    sentAt: now.toISOString(),
    pairingId: paired.pairing_id,
    key: firstKey,
    payload: {
      replaces_key_id: firstKey.keyId,
      new_public_key: { algorithm: "ed25519", key_id: secondKey.keyId, generation: 2, value: secondKey.publicKey },
    },
  }));
  const rotated = await service.rotateKey(rotation);
  const feed = agentFeedListRequestSchema.parse(signedPairingRequest({
    operation: "feed.list",
    requestId: "req_smoke_feed_1",
    sentAt: now.toISOString(),
    pairingId: paired.pairing_id,
    key: secondKey,
    payload: { limit: 1 },
  }));
  const authorization = await service.authorizeAndExecute(feed, (context) => ({
    pairing_id: context.pairingId,
    runtime: context.runtime,
    scope_count: context.grantedScopes.length,
  }));
  const revoked = await service.revokeByOwner({
    ownerId: "smoke-owner",
    pairingId: paired.pairing_id,
    reason: "user_requested",
  });
  let postRevokeCode = "unexpected_success";
  try {
    await service.authorizeAndExecute(feed, () => true);
  } catch (error) {
    postRevokeCode = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown_error";
  }
  const stored = await backend.read();
  const owner = await service.listOwnerPairings("smoke-owner");
  const serialized = JSON.stringify(stored);
  if (serialized.includes(issued.pairing_code)) throw new Error("Pairing code leaked into stored state.");
  if (postRevokeCode !== "pairing_revoked") throw new Error("Revocation did not stop authoritative authorization.");

  return {
    ok: true,
    pairing_id: paired.pairing_id,
    pair_status: paired.status,
    renamed_label: renamed.device.display_name,
    active_key_generation: rotated.keys.find((key) => key.status === "active")?.generation,
    authorized_runtime: authorization.runtime,
    granted_scope_count: authorization.scope_count,
    revoke_status: revoked.status,
    post_revoke_authorization: postRevokeCode,
    stored_code_material: "sha256_hash_only",
    audit_actions: owner.audit.map((event) => event.action),
    raw_pairing_code_in_state: false,
  };
}

if (import.meta.main) {
  runLocalPairingSmoke()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Unknown smoke error." })}\n`);
      process.exitCode = 1;
    });
}
