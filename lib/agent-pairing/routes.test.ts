import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as issuePairingCode } from "@/app/api/agent/pair/code/route";
import { GET as listPairings, POST as redeemPairing } from "@/app/api/agent/pair/route";
import { PATCH as renamePairing } from "@/app/api/agent/pair/[id]/route";
import { POST as rotatePairingKey } from "@/app/api/agent/pair/rotate/route";
import { POST as revokePairing } from "@/app/api/agent/revoke/route";
import { POST as revokePairingByOwner } from "@/app/api/agent/revoke/[id]/route";
import { agentPairingRevokeRequestSchema, agentPairingRotateKeyRequestSchema } from "@/lib/agent-protocol/schemas";
import { AgentProtocolError } from "@/lib/agent-protocol/errors";
import { PairingPlatformError, PairingService } from "@/lib/agent-pairing/service";
import { setPlatformPairingServiceForTests } from "@/lib/agent-pairing/runtime";
import { MemoryPairingStateBackend } from "@/lib/agent-pairing/storage";
import { generatePairingTestKey, pairCreateRequest, signedPairingRequest } from "@/lib/agent-pairing/testUtils";
import { resetRateLimitsForTests } from "@/lib/security/rateLimit";

const now = "2026-07-15T12:00:00.000Z";

function ownerRequest(url: string, method = "GET", body?: unknown, ownerId = "route-owner") {
  return new Request(url, {
    method,
    headers: {
      "x-cmai-user-id": ownerId,
      "x-cmai-user-name": "Route Owner",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function issueCode(input: { ownerId?: string; displayName?: string; runtime?: "hermes" | "openclaw" } = {}) {
  const response = await issuePairingCode(ownerRequest(
    "http://test.local/api/agent/pair/code",
    "POST",
    { runtime: input.runtime || "hermes", display_name: input.displayName || "Route Agent" },
    input.ownerId || "route-owner",
  ));
  expect(response.status).toBe(201);
  return await response.json() as { pairing_code: string; display_name: string };
}

async function pairThroughRoute(input: { ownerId?: string; displayName?: string; deviceId?: string } = {}) {
  const key = generatePairingTestKey("route_key_1");
  const code = await issueCode({ ownerId: input.ownerId, displayName: input.displayName });
  const envelope = pairCreateRequest({
    pairingCode: code.pairing_code,
    key,
    sentAt: now,
    ownerLabel: input.displayName || "Route Agent",
    deviceId: input.deviceId || "route_device_1",
    requestId: "req_route_pair_1",
  });
  const response = await redeemPairing(new Request("http://test.local/api/agent/pair", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.80" },
    body: JSON.stringify(envelope),
  }));
  expect(response.status).toBe(201);
  const payload = await response.json() as { result: { pairing: { pairing_id: string; status: string } } };
  return { key, code, envelope, pairing: payload.result.pairing };
}

let service: PairingService;

describe("pairing HTTP routes", () => {
  beforeEach(() => {
    resetRateLimitsForTests();
    service = new PairingService(new MemoryPairingStateBackend(), { clock: () => new Date(now) });
    setPlatformPairingServiceForTests(service);
  });

  afterEach(() => {
    setPlatformPairingServiceForTests(undefined);
    vi.restoreAllMocks();
  });

  it("charges the pairing pre-auth bucket before reading any pairing mutation body", async () => {
    vi.spyOn(service, "assertPairingNetworkRateLimit").mockRejectedValue(new AgentProtocolError(
      "rate_limited",
      "Too many Agent protocol requests from this network.",
      429,
      true,
      undefined,
      1,
    ));
    for (const handler of [redeemPairing, rotatePairingKey, revokePairing]) {
      let bodyRead = false;
      const request = {
        headers: new Headers(),
        method: "POST",
        url: "http://test.local/api/agent/protocol",
        get body() {
          bodyRead = true;
          throw new Error("body must not be read");
        },
      } as unknown as Request;
      const response = await handler(request);
      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toMatchObject({
        protocol: "CMAI_AGENT_PROTOCOL_V1",
        protocol_version: "1.2",
        error: { code: "rate_limited", retryable: true, retry_after_seconds: 1 },
      });
      expect(bodyRead).toBe(false);
    }
  });

  it("normalizes pairing initialization and pre-auth outages to strict retryable Protocol errors", async () => {
    vi.spyOn(service, "assertPairingNetworkRateLimit").mockRejectedValue(new Error("backend unavailable"));
    const response = await rotatePairingKey(new Request("http://test.local/api/agent/pair/rotate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }));
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      protocol: "CMAI_AGENT_PROTOCOL_V1",
      protocol_version: "1.2",
      error: { code: "service_unavailable", retryable: true, retry_after_seconds: 1 },
    });
  });

  it("normalizes every pairing platform status to canonical Protocol status and retry metadata", async () => {
    const key = generatePairingTestKey("route_platform_error_key", 1);
    const replacement = generatePairingTestKey("route_platform_error_replacement", 2);
    const envelope = agentPairingRotateKeyRequestSchema.parse(signedPairingRequest({
      operation: "pairing.rotate_key",
      requestId: "req_route_platform_error",
      sentAt: now,
      pairingId: "pairing_route_platform_error",
      key,
      payload: {
        replaces_key_id: key.keyId,
        new_public_key: { algorithm: "ed25519", key_id: replacement.keyId, generation: 2, value: replacement.publicKey },
      },
    }));
    const rotate = vi.spyOn(service, "rotateKey");
    const cases = [
      { error: new PairingPlatformError(409, "pairing_key_history_full", "Pairing key history is full."), status: 400, code: "malformed_request", retryable: false },
      { error: new PairingPlatformError(422, "invalid_pairing_state", "Pairing state is invalid."), status: 400, code: "malformed_request", retryable: false },
      { error: new PairingPlatformError(503, "pairing_capacity_exceeded", "Pairing capacity is exhausted."), status: 503, code: "capacity_exceeded", retryable: true },
    ];
    for (const [index, item] of cases.entries()) {
      rotate.mockRejectedValueOnce(item.error);
      const response = await rotatePairingKey(new Request("http://test.local/api/agent/pair/rotate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...envelope, request_id: `${envelope.request_id}_${index}` }),
      }));
      expect(response.status).toBe(item.status);
      const body = await response.json();
      expect(body).toMatchObject({
        protocol: "CMAI_AGENT_PROTOCOL_V1",
        protocol_version: "1.2",
        error: { code: item.code, retryable: item.retryable },
      });
      if (item.retryable) {
        expect(response.headers.get("retry-after")).toBe("1");
        expect(body.error.retry_after_seconds).toBe(1);
      }
    }
  });

  it("creates and redeems a body-only code without a user session on the signed client route", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const paired = await pairThroughRoute();
    expect(paired.pairing.status).toBe("active");
    expect(JSON.stringify(log.mock.calls)).not.toContain(paired.code.pairing_code);
    expect(JSON.stringify(error.mock.calls)).not.toContain(paired.code.pairing_code);

    const listed = await listPairings(ownerRequest("http://test.local/api/agent/pair"));
    expect(listed.status).toBe(200);
    const payload = await listed.json() as { pairings: unknown[]; audit: unknown[] };
    expect(payload.pairings).toHaveLength(1);
    expect(JSON.stringify(payload)).not.toContain("route-owner");
    expect(JSON.stringify(payload.audit)).not.toContain(paired.code.pairing_code);
  });

  it("rejects pairing codes in GET query strings before account lookup", async () => {
    const response = await listPairings(ownerRequest("http://test.local/api/agent/pair?pairing_code=CMAI-NOT-ALLOWED"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "pairing_code_query_forbidden" });
  });

  it("enforces same-origin CSRF for cookie-backed code issuance", async () => {
    const response = await issuePairingCode(new Request("http://test.local/api/agent/pair/code", {
      method: "POST",
      headers: {
        origin: "http://test.local",
        cookie: "cmai_user_id=cookie-owner; cmai_user_name=Cookie%20Owner",
        "content-type": "application/json",
      },
      body: JSON.stringify({ runtime: "hermes", display_name: "Cookie Agent" }),
    }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ code: "csrf_required" });
  });

  it("keeps rename and owner revocation indistinguishable for foreign and unknown IDs", async () => {
    const paired = await pairThroughRoute();
    const foreignRename = await renamePairing(
      ownerRequest(`http://test.local/api/agent/pair/${paired.pairing.pairing_id}`, "PATCH", { display_name: "Foreign Rename" }, "other-owner"),
      { params: Promise.resolve({ id: paired.pairing.pairing_id }) },
    );
    const unknownRename = await renamePairing(
      ownerRequest("http://test.local/api/agent/pair/missing", "PATCH", { display_name: "Unknown Rename" }),
      { params: Promise.resolve({ id: "missing" }) },
    );
    expect(foreignRename.status).toBe(404);
    expect(unknownRename.status).toBe(404);
    expect(await foreignRename.json()).toEqual(await unknownRename.json());

    const foreignRevoke = await revokePairingByOwner(
      ownerRequest(`http://test.local/api/agent/revoke/${paired.pairing.pairing_id}`, "POST", { reason: "user_requested" }, "other-owner"),
      { params: Promise.resolve({ id: paired.pairing.pairing_id }) },
    );
    expect(foreignRevoke.status).toBe(404);

    const renamed = await renamePairing(
      ownerRequest(`http://test.local/api/agent/pair/${paired.pairing.pairing_id}`, "PATCH", { display_name: "Authorized Rename" }),
      { params: Promise.resolve({ id: paired.pairing.pairing_id }) },
    );
    expect(renamed.status).toBe(200);
    await expect(renamed.json()).resolves.toMatchObject({ pairing: { device: { display_name: "Authorized Rename" } } });
  });

  it("rotates and revokes through strict signed protocol responses", async () => {
    const paired = await pairThroughRoute();
    const replacement = generatePairingTestKey("route_key_2", 2);
    const rotation = agentPairingRotateKeyRequestSchema.parse(signedPairingRequest({
      operation: "pairing.rotate_key",
      requestId: "req_route_rotate_1",
      sentAt: now,
      pairingId: paired.pairing.pairing_id,
      key: paired.key,
      payload: {
        replaces_key_id: paired.key.keyId,
        new_public_key: { algorithm: "ed25519", key_id: replacement.keyId, generation: 2, value: replacement.publicKey },
      },
    }));
    const rotated = await rotatePairingKey(new Request("http://test.local/api/agent/pair/rotate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rotation),
    }));
    expect(rotated.status).toBe(200);
    await expect(rotated.json()).resolves.toMatchObject({ result: { pairing: { keys: [{ status: "retired" }, { status: "active" }] } } });

    const revocation = agentPairingRevokeRequestSchema.parse(signedPairingRequest({
      operation: "pairing.revoke",
      requestId: "req_route_revoke_1",
      sentAt: now,
      pairingId: paired.pairing.pairing_id,
      key: replacement,
      payload: { revoke: "pairing", reason: "user_requested" },
    }));
    const revoked = await revokePairing(new Request("http://test.local/api/agent/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(revocation),
    }));
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toMatchObject({ result: { pairing: { status: "revoked" } } });
  });

  it("rejects provider credential fields before pairing and returns no reflected secret", async () => {
    const code = await issueCode();
    const key = generatePairingTestKey("route_credential_key");
    const envelope = pairCreateRequest({ pairingCode: code.pairing_code, key, sentAt: now, ownerLabel: "Route Agent" }) as unknown as Record<string, any>;
    envelope.payload.provider_api_key = "[REDACTED]";
    const response = await redeemPairing(new Request("http://test.local/api/agent/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    }));
    expect(response.status).toBe(422);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain("credential_field_forbidden");
    expect(serialized).not.toContain(envelope.payload.provider_api_key);
  });

  it("lets the authenticated owner revoke without exposing a client credential", async () => {
    const paired = await pairThroughRoute();
    const response = await revokePairingByOwner(
      ownerRequest(`http://test.local/api/agent/revoke/${paired.pairing.pairing_id}`, "POST", { reason: "device_lost" }),
      { params: Promise.resolve({ id: paired.pairing.pairing_id }) },
    );
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({ pairing: { status: "revoked" } });
    expect(JSON.stringify(payload)).not.toContain("route-owner");
    expect(JSON.stringify(payload)).not.toContain(paired.code.pairing_code);
  });
});
