import { agentFeedListRequestSchema } from "@/lib/agent-protocol/schemas";
import { PairingService } from "@/lib/agent-pairing/service";
import { PostgresPairingStateBackend } from "@/lib/agent-pairing/storage";
import { generatePairingTestKey, pairCreateRequest, signedPairingRequest } from "@/lib/agent-pairing/testUtils";

export async function runPostgresPairingSmoke(databaseUrl: string) {
  const now = new Date("2026-07-15T12:00:00.000Z");
  const backend = new PostgresPairingStateBackend(databaseUrl);
  try {
    await backend.resetForTests?.();
    const service = new PairingService(backend, { clock: () => new Date(now) });
    const key = generatePairingTestKey("postgres_smoke_key_1");
    const issued = await service.issuePairingCode({
      ownerId: "postgres-smoke-owner",
      runtime: "openclaw",
      displayName: "Postgres Smoke Agent",
    });
    const request = pairCreateRequest({
      pairingCode: issued.pairing_code,
      key,
      sentAt: now.toISOString(),
      requestId: "req_postgres_pair_1",
      ownerLabel: "Postgres Smoke Agent",
      deviceId: "postgres_smoke_device_1",
      runtime: "openclaw",
    });
    const attempts = await Promise.allSettled([
      service.redeemPairing(request, { rateLimitKey: "postgres-smoke-a" }),
      service.redeemPairing(request, { rateLimitKey: "postgres-smoke-b" }),
    ]);
    const accepted = attempts.find((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<PairingService["redeemPairing"]>>> => attempt.status === "fulfilled");
    if (!accepted) throw new Error("Postgres pairing smoke accepted no redemption.");
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    const rejectedCode = rejected?.status === "rejected" && rejected.reason && typeof rejected.reason === "object" && "code" in rejected.reason
      ? String(rejected.reason.code)
      : "unknown";
    if (attempts.filter((attempt) => attempt.status === "fulfilled").length !== 1 || rejectedCode !== "pairing_not_found") {
      throw new Error("Postgres row lock did not enforce one successful redemption.");
    }

    const feed = agentFeedListRequestSchema.parse(signedPairingRequest({
      operation: "feed.list",
      requestId: "req_postgres_feed_1",
      sentAt: now.toISOString(),
      pairingId: accepted.value.pairing_id,
      key,
      payload: { limit: 1 },
    }));
    await service.authorizeAndExecute(feed, () => true);
    await service.revokeByOwner({
      ownerId: "postgres-smoke-owner",
      pairingId: accepted.value.pairing_id,
      reason: "user_requested",
    });
    let postRevoke = "unexpected_success";
    try {
      await service.authorizeAndExecute(feed, () => true);
    } catch (error) {
      postRevoke = error && typeof error === "object" && "code" in error ? String(error.code) : "unknown_error";
    }
    if (postRevoke !== "pairing_revoked") throw new Error("Postgres authoritative revocation check failed.");
    const stored = await backend.read();
    if (JSON.stringify(stored).includes(issued.pairing_code)) throw new Error("Raw pairing code reached Postgres state.");

    return {
      ok: true,
      backend: "postgres_jsonb_row_lock",
      schema_version: stored.schemaVersion,
      concurrent_redemptions: { accepted: 1, rejected: 1, rejected_code: rejectedCode },
      pairing_status: stored.pairings[0]?.status,
      post_revoke_authorization: postRevoke,
      raw_pairing_code_in_state: false,
      audit_event_count: stored.auditEvents.length,
    };
  } finally {
    await backend.close?.();
  }
}

if (import.meta.main) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: "DATABASE_URL is required for the disposable Postgres pairing smoke." })}\n`);
    process.exitCode = 2;
  } else {
    runPostgresPairingSmoke(databaseUrl)
      .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
      .catch((error) => {
        process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Unknown Postgres smoke error." })}\n`);
        process.exitCode = 1;
      });
  }
}
