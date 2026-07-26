import {
  AGENT_PROTOCOL_MAX_CLOCK_SKEW_MS,
  type AgentProtocolOperation,
  type AgentProtocolScope,
} from "@/lib/agent-protocol/constants";
import { hashAgentProtocolPayload } from "@/lib/agent-protocol/canonical";
import { AgentProtocolError } from "@/lib/agent-protocol/errors";

export const requiredScopeByOperation = {
  "pair.create": null,
  "pairing.rotate_key": "pairing:manage",
  "pairing.revoke": "pairing:manage",
  "feed.list": "challenge:read",
  "challenge.get": "challenge:run",
  "contribution.submit": "contribution:submit",
} as const satisfies Record<AgentProtocolOperation, AgentProtocolScope | null>;

export function assertAgentProtocolScope(operation: AgentProtocolOperation, grantedScopes: readonly AgentProtocolScope[]): void {
  const required = requiredScopeByOperation[operation];
  if (required && !grantedScopes.includes(required)) {
    throw new AgentProtocolError("scope_unauthorized", `${operation} requires ${required}.`, 403, false, "$.operation");
  }
}

export function assertAgentRequestTime(sentAt: string, now = new Date(), maxSkewMs = AGENT_PROTOCOL_MAX_CLOCK_SKEW_MS): void {
  const sentAtMs = Date.parse(sentAt);
  if (!Number.isFinite(sentAtMs) || Math.abs(now.getTime() - sentAtMs) > maxSkewMs) {
    throw new AgentProtocolError("request_time_skew", `Signed requests must be within ${maxSkewMs}ms of server time.`, 401, true, "$.sent_at", 1);
  }
}

type PairingKeyStatus = "active" | "retired" | "revoked";
type PairingStatus = "active" | "revoked";

type PairingKeyRecord = {
  keyId: string;
  generation: number;
  status: PairingKeyStatus;
  activatedAt: string;
  retiredAt?: string;
  revokedAt?: string;
};

type PairingRecord = {
  pairingId: string;
  deviceId: string;
  status: PairingStatus;
  grantedScopes: AgentProtocolScope[];
  keys: Map<string, PairingKeyRecord>;
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
};

export const DEFAULT_IN_MEMORY_PROTOCOL_RECORD_LIMIT = 10_000;
export const MAX_PAIRING_KEY_HISTORY = 20;

export class InMemoryPairingKeyRing {
  private readonly pairings = new Map<string, PairingRecord>();

  constructor(private readonly maxPairings = DEFAULT_IN_MEMORY_PROTOCOL_RECORD_LIMIT) {}

  register(input: {
    pairingId: string;
    deviceId: string;
    keyId: string;
    grantedScopes: AgentProtocolScope[];
    activatedAt: string;
  }): void {
    if (this.pairings.has(input.pairingId)) throw new Error(`Pairing ${input.pairingId} already exists.`);
    if (this.pairings.size >= this.maxPairings) throw new RangeError("In-memory pairing reference capacity exceeded.");
    this.pairings.set(input.pairingId, {
      pairingId: input.pairingId,
      deviceId: input.deviceId,
      status: "active",
      grantedScopes: [...input.grantedScopes],
      keys: new Map([[input.keyId, {
        keyId: input.keyId,
        generation: 1,
        status: "active",
        activatedAt: input.activatedAt,
      }]]),
      createdAt: input.activatedAt,
      updatedAt: input.activatedAt,
    });
  }

  assertActiveKey(pairingId: string, keyId: string): PairingKeyRecord {
    const pairing = this.pairings.get(pairingId);
    if (!pairing) throw new AgentProtocolError("pairing_not_found", "Pairing was not found.", 401, false, "$.auth.pairing_id");
    if (pairing.status === "revoked") throw new AgentProtocolError("pairing_revoked", "Pairing has been revoked.", 401, false, "$.auth.pairing_id");
    const key = pairing.keys.get(keyId);
    if (!key) throw new AgentProtocolError("pairing_key_inactive", "Pairing key is not active.", 401, false, "$.auth.key_id");
    if (key.status === "revoked") throw new AgentProtocolError("pairing_key_revoked", "Pairing key has been revoked.", 401, false, "$.auth.key_id");
    if (key.status !== "active") throw new AgentProtocolError("pairing_key_inactive", "Pairing key is no longer active.", 401, false, "$.auth.key_id");
    return { ...key };
  }

  rotate(input: { pairingId: string; replacesKeyId: string; newKeyId: string; generation: number; rotatedAt: string }): void {
    const pairing = this.pairings.get(input.pairingId);
    this.assertActiveKey(input.pairingId, input.replacesKeyId);
    if (!pairing) return;
    if (pairing.keys.has(input.newKeyId)) throw new Error(`Pairing key ${input.newKeyId} already exists.`);
    if (pairing.keys.size >= MAX_PAIRING_KEY_HISTORY) throw new RangeError("Pairing key history capacity exceeded.");
    const previous = pairing.keys.get(input.replacesKeyId);
    if (!previous || input.generation <= previous.generation) throw new Error("Rotated key generation must increase.");
    previous.status = "retired";
    previous.retiredAt = input.rotatedAt;
    pairing.keys.set(input.newKeyId, {
      keyId: input.newKeyId,
      generation: input.generation,
      status: "active",
      activatedAt: input.rotatedAt,
    });
    pairing.updatedAt = input.rotatedAt;
  }

  revokeKey(input: { pairingId: string; keyId: string; revokedAt: string }): void {
    const pairing = this.pairings.get(input.pairingId);
    if (!pairing) throw new AgentProtocolError("pairing_not_found", "Pairing was not found.", 401, false, "$.auth.pairing_id");
    const key = pairing.keys.get(input.keyId);
    if (!key) throw new AgentProtocolError("pairing_key_inactive", "Pairing key is not active.", 401, false, "$.auth.key_id");
    const wasActive = key.status === "active";
    key.status = "revoked";
    key.revokedAt = input.revokedAt;
    pairing.updatedAt = input.revokedAt;
    if (wasActive) {
      pairing.status = "revoked";
      pairing.revokedAt = input.revokedAt;
    }
  }

  revokePairing(input: { pairingId: string; revokedAt: string }): void {
    const pairing = this.pairings.get(input.pairingId);
    if (!pairing) throw new AgentProtocolError("pairing_not_found", "Pairing was not found.", 401, false, "$.auth.pairing_id");
    pairing.status = "revoked";
    pairing.revokedAt = input.revokedAt;
    pairing.updatedAt = input.revokedAt;
    for (const key of pairing.keys.values()) {
      if (key.status !== "revoked") {
        key.status = "revoked";
        key.revokedAt = input.revokedAt;
      }
    }
  }

  snapshot(pairingId: string): {
    pairing_id: string;
    device_id: string;
    status: PairingStatus;
    granted_scopes: AgentProtocolScope[];
    keys: Array<{
      key_id: string;
      generation: number;
      status: PairingKeyStatus;
      activated_at: string;
      retired_at?: string;
      revoked_at?: string;
    }>;
    created_at: string;
    updated_at: string;
    revoked_at?: string;
  } {
    const pairing = this.pairings.get(pairingId);
    if (!pairing) throw new AgentProtocolError("pairing_not_found", "Pairing was not found.", 401, false, "$.auth.pairing_id");
    return {
      pairing_id: pairing.pairingId,
      device_id: pairing.deviceId,
      status: pairing.status,
      granted_scopes: [...pairing.grantedScopes],
      keys: [...pairing.keys.values()]
        .sort((left, right) => left.generation - right.generation)
        .map((key) => ({
          key_id: key.keyId,
          generation: key.generation,
          status: key.status,
          activated_at: key.activatedAt,
          ...(key.retiredAt ? { retired_at: key.retiredAt } : {}),
          ...(key.revokedAt ? { revoked_at: key.revokedAt } : {}),
        })),
      created_at: pairing.createdAt,
      updated_at: pairing.updatedAt,
      ...(pairing.revokedAt ? { revoked_at: pairing.revokedAt } : {}),
    };
  }
}

type RunNonceRecord = {
  nonce: string;
  pairingId: string;
  challengeId: string;
  challengeRevision: number;
  issuedAt: string;
  expiresAt: string;
  consumedAt?: string;
};

export class InMemoryRunNonceStore {
  private readonly nonces = new Map<string, RunNonceRecord>();

  constructor(private readonly maxNonces = DEFAULT_IN_MEMORY_PROTOCOL_RECORD_LIMIT) {}

  issue(input: RunNonceRecord): void {
    if (this.nonces.has(input.nonce)) throw new AgentProtocolError("run_nonce_replayed", "Run nonce has already been issued.", 409, false, "$.payload.run_nonce");
    if (Date.parse(input.expiresAt) <= Date.parse(input.issuedAt)) throw new AgentProtocolError("malformed_request", "Run nonce expiry must be after issue time.", 400, false, "$.payload.expires_at");
    if (this.nonces.size >= this.maxNonces) throw new RangeError("In-memory nonce reference capacity exceeded.");
    this.nonces.set(input.nonce, { ...input });
  }

  consume(input: { nonce: string; pairingId: string; challengeId: string; challengeRevision: number; now: Date }): RunNonceRecord {
    const nonce = this.nonces.get(input.nonce);
    if (!nonce) throw new AgentProtocolError("run_nonce_unknown", "Run nonce was not found.", 409, false, "$.payload.run_nonce");
    if (nonce.pairingId !== input.pairingId || nonce.challengeId !== input.challengeId || nonce.challengeRevision !== input.challengeRevision) {
      throw new AgentProtocolError("run_nonce_mismatch", "Run nonce does not match this pairing, challenge, or revision.", 409, false, "$.payload.run_nonce");
    }
    if (input.now.getTime() >= Date.parse(nonce.expiresAt)) {
      throw new AgentProtocolError("run_nonce_expired", "Run nonce has expired.", 409, true, "$.payload.run_nonce", 1);
    }
    if (nonce.consumedAt) throw new AgentProtocolError("run_nonce_replayed", "Run nonce has already been consumed.", 409, false, "$.payload.run_nonce");
    nonce.consumedAt = input.now.toISOString();
    return { ...nonce };
  }
}

export type SubmissionReplayRecord = {
  submissionId: string;
  pairingId: string;
  challengeId: string;
  challengeRevision: number;
  idempotencyKey: string;
  requestHash: string;
  cardHash: string;
  runNonce: string;
  acceptedAt: string;
};

export class InMemorySubmissionReplayGuard {
  private readonly byIdempotency = new Map<string, SubmissionReplayRecord>();
  private readonly byCard = new Map<string, SubmissionReplayRecord>();

  constructor(
    private readonly nonceStore: InMemoryRunNonceStore,
    private readonly maxRecords = DEFAULT_IN_MEMORY_PROTOCOL_RECORD_LIMIT,
  ) {}

  submit(input: {
    pairingId: string;
    challengeId: string;
    challengeRevision: number;
    idempotencyKey: string;
    runNonce: string;
    requestPayload: unknown;
    normalizedCard: unknown;
    now: Date;
  }): { kind: "accepted" | "replayed"; record: SubmissionReplayRecord } {
    if (!input.idempotencyKey) throw new AgentProtocolError("idempotency_key_required", "Contribution submission requires an idempotency key.", 422, false, "$.payload.idempotency_key");

    const requestHash = hashAgentProtocolPayload(input.requestPayload);
    const cardHash = hashAgentProtocolPayload(input.normalizedCard);
    const idempotencyScope = `${input.pairingId}:${input.idempotencyKey}`;
    const existing = this.byIdempotency.get(idempotencyScope);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new AgentProtocolError("idempotency_conflict", "Idempotency key was already used with a different payload.", 409, false, "$.payload.idempotency_key");
      return { kind: "replayed", record: { ...existing } };
    }

    const cardScope = `${input.pairingId}:${input.challengeId}:${cardHash}`;
    const duplicate = this.byCard.get(cardScope);
    if (duplicate) throw new AgentProtocolError("duplicate_submit", "This contribution card was already submitted with a different idempotency key.", 409, false, "$.payload.card");
    if (this.byIdempotency.size >= this.maxRecords) throw new RangeError("In-memory submission replay reference capacity exceeded.");

    this.nonceStore.consume({
      nonce: input.runNonce,
      pairingId: input.pairingId,
      challengeId: input.challengeId,
      challengeRevision: input.challengeRevision,
      now: input.now,
    });

    const record: SubmissionReplayRecord = {
      submissionId: `sub_${requestHash.slice(0, 24)}`,
      pairingId: input.pairingId,
      challengeId: input.challengeId,
      challengeRevision: input.challengeRevision,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      cardHash,
      runNonce: input.runNonce,
      acceptedAt: input.now.toISOString(),
    };
    this.byIdempotency.set(idempotencyScope, record);
    this.byCard.set(cardScope, record);
    return { kind: "accepted", record: { ...record } };
  }
}
