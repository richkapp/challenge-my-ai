import {
  createHash,
  createPublicKey,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import { Buffer } from "node:buffer";
import {
  agentProtocolPreviewScopes,
  agentProtocolScopes,
  type AgentProtocolScope,
  type AgentRuntimeKind,
} from "@/lib/agent-protocol/constants";
import { canonicalAgentSigningBytes, hashAgentProtocolPayload } from "@/lib/agent-protocol/canonical";
import { AgentProtocolError } from "@/lib/agent-protocol/errors";
import { assertAgentProtocolScope, assertAgentRequestTime } from "@/lib/agent-protocol/state";
import type {
  AgentChallengeGetRequest,
  AgentContributionSubmitRequest,
  AgentFeedListRequest,
  AgentPairCreateRequest,
  AgentPairingRevokeRequest,
  AgentPairingRotateKeyRequest,
} from "@/lib/agent-protocol/schemas";
import type { PairingStateBackend } from "@/lib/agent-pairing/storage";
import { AGENT_FEED_SUBMISSION_RETENTION_MS, AgentFeedStoreError, type AgentFeedTransactionalStore } from "@/lib/store/agentFeed";
import type { PairingTelemetrySink } from "@/lib/agent-pairing/telemetry";
import {
  MAX_AUTHORIZED_READ_REQUEST_RECEIPTS,
  MAX_AUTHORIZED_REQUEST_RECEIPTS_TOTAL,
  MAX_AUTHORIZED_SUBMISSION_REQUEST_RECEIPTS,
  MAX_AUTHORIZED_SUBMISSION_REQUEST_RECEIPTS_PER_PAIRING,
  MAX_PAIRING_RATE_LIMIT_BUCKETS_TOTAL as MAX_PAIRING_RATE_LIMIT_BUCKETS_TOTAL_VALUE,
  type AgentPairingProtocolState,
  type OwnerPairingAuditView,
  type OwnerPairingView,
  type PairingAuditAction,
  type PairingAuditEvent,
  type PairingCodeRecord,
  type PairingMutationReceipt,
  type PairingMutationStoredError,
  type PairingPlatformState,
  type StoredAgentPairing,
} from "@/lib/agent-pairing/types";

export const PAIRING_CODE_TTL_MS = 5 * 60_000;
export const PAIRING_CODE_ENTROPY_BYTES = 20;
export const PAIRING_CODE_ISSUE_LIMIT = 5;
export const PAIRING_CODE_ISSUE_WINDOW_MS = 10 * 60_000;
export const PAIRING_CODE_REDEEM_NETWORK_LIMIT = 20;
export const PAIRING_CODE_REDEEM_NETWORK_WINDOW_MS = 60_000;
export const PAIRING_CODE_REDEEM_CODE_LIMIT = 5;
export const PAIRING_CODE_REDEEM_CODE_WINDOW_MS = 5 * 60_000;
export const MAX_PAIRING_KEY_HISTORY = 20;
export const MAX_PAIRING_RATE_LIMIT_BUCKETS = 10_000;
export { MAX_PAIRING_RATE_LIMIT_BUCKETS_TOTAL } from "@/lib/agent-pairing/types";
export {
  MAX_AUTHORIZED_READ_REQUEST_RECEIPTS,
  MAX_AUTHORIZED_REQUEST_RECEIPTS_TOTAL,
  MAX_AUTHORIZED_SUBMISSION_REQUEST_RECEIPTS,
  MAX_AUTHORIZED_SUBMISSION_REQUEST_RECEIPTS_PER_PAIRING,
} from "@/lib/agent-pairing/types";
export const AUTHORIZED_REQUEST_RECEIPT_RETENTION_MS = 30 * 60_000;
export const authenticatedAgentOperationRateLimits = {
  "feed.list": { limit: 120, windowMs: 60_000 },
  "challenge.get": { limit: 60, windowMs: 60_000 },
  "contribution.submit": { limit: 30, windowMs: 60_000 },
} as const;
export const agentProtocolNetworkRateLimits = {
  "feed.list": { limit: 300, windowMs: 60_000 },
  "challenge.get": { limit: 180, windowMs: 60_000 },
  "contribution.submit": { limit: 90, windowMs: 60_000 },
} as const;
export const agentFeedNetworkPreauthRateLimit = { limit: 180, windowMs: 60_000 } as const;
export const pairingNetworkPreauthRateLimit = { limit: 120, windowMs: 60_000 } as const;
export const authenticatedPairingMutationRateLimits = {
  "pairing.rotate_key": { limit: 12, windowMs: 60_000 },
  "pairing.revoke": { limit: 12, windowMs: 60_000 },
} as const;

const PAIRING_CODE_RETENTION_MS = 24 * 60 * 60_000;
const MUTATION_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const AUDIT_RETENTION_MS = 365 * 24 * 60 * 60_000;
const MAX_CODES = 10_000;
const MAX_PAIRINGS = 10_000;
const MAX_AUDIT_EVENTS = 50_000;
const MAX_MUTATION_RECEIPTS = 50_000;
const FULL_PAIRING_SCOPES = [...agentProtocolScopes] as AgentProtocolScope[];
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const UNSAFE_LABEL_PATTERN = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u;

type SignedAgentProtocolRequest =
  | AgentPairingRotateKeyRequest
  | AgentPairingRevokeRequest
  | AgentFeedListRequest
  | AgentChallengeGetRequest
  | AgentContributionSubmitRequest;

type AuthorizedAgentProtocolRequest = AgentFeedListRequest | AgentChallengeGetRequest | AgentContributionSubmitRequest;

export type PairingAuthorizationContext = {
  pairingId: string;
  ownerId: string;
  deviceId: string;
  runtime: AgentRuntimeKind;
  grantedScopes: AgentProtocolScope[];
  keyId: string;
  requestReplay: "new" | "exact";
  requestAuthorizedAt: string;
  requestReceiptExpiresAt: string;
  agentFeedStore?: AgentFeedTransactionalStore;
};

export class PairingPlatformError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "PairingPlatformError";
  }
}

export type PairingServiceOptions = {
  clock?: () => Date;
  randomBytes?: (size: number) => Buffer;
  telemetry?: PairingTelemetrySink;
  onTelemetryError?: (error: unknown) => void;
};

type TransactionResult<T> = { ok: true; value: T } | { ok: false; error: Error };

class PairingProtectedActionAbort extends Error {
  constructor(readonly originalError: Error) {
    super("Protected Agent action aborted the shared transaction.");
    this.name = "PairingProtectedActionAbort";
  }
}

function success<T>(value: T): TransactionResult<T> {
  return { ok: true, value };
}

function failure<T>(error: Error): TransactionResult<T> {
  return { ok: false, error };
}

function unwrap<T>(result: TransactionResult<T>): T {
  if (!result.ok) throw result.error;
  return result.value;
}

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function opaqueHash(domain: string, value: string): string {
  return createHash("sha256").update(`${domain}\0${value}`, "utf8").digest("hex");
}

export function hashPairingCode(code: string): string {
  return opaqueHash("CMAI_PAIRING_CODE_V1", code);
}

function findPairingCodeByHash(codes: PairingCodeRecord[], expectedHash: string): PairingCodeRecord | undefined {
  const expected = Buffer.from(expectedHash, "hex");
  let match: PairingCodeRecord | undefined;
  for (const candidate of codes) {
    const candidateHash = Buffer.from(candidate.codeHash, "hex");
    if (candidateHash.length === expected.length && timingSafeEqual(candidateHash, expected)) match = candidate;
  }
  return match;
}

function randomOpaqueId(prefix: string, bytes: Buffer): string {
  return `${prefix}_${bytes.toString("base64url")}`;
}

function normalizeDisplayName(value: string): string {
  const normalized = value.normalize("NFKC").trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 80 || UNSAFE_LABEL_PATTERN.test(normalized)) {
    throw new PairingPlatformError(422, "invalid_device_label", "Device label must be 1-80 visible characters.");
  }
  return normalized;
}

function protocolPairingState(pairing: StoredAgentPairing): AgentPairingProtocolState {
  return {
    pairing_id: pairing.pairingId,
    device_id: pairing.device.deviceId,
    status: pairing.status,
    granted_scopes: [...pairing.grantedScopes],
    keys: [...pairing.keys]
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

function ownerPairingView(pairing: StoredAgentPairing): OwnerPairingView {
  return {
    ...protocolPairingState(pairing),
    device: {
      display_name: pairing.device.displayName,
      runtime: pairing.device.runtime,
      ...(pairing.device.runtimeVersion ? { runtime_version: pairing.device.runtimeVersion } : {}),
      adapter_name: pairing.device.adapterName,
      adapter_version: pairing.device.adapterVersion,
    },
  };
}

function ownerAuditView(event: PairingAuditEvent): OwnerPairingAuditView {
  const { ownerId: _ownerId, ...view } = event;
  return view;
}

function validatePairingScopes(
  requestedScopes: readonly AgentProtocolScope[],
  allowedScopes: readonly AgentProtocolScope[],
): AgentProtocolScope[] {
  const requested = new Set(requestedScopes);
  const allowed = new Set(allowedScopes);
  if (
    requested.size !== requestedScopes.length
    || agentProtocolPreviewScopes.some((scope) => !requested.has(scope))
    || requestedScopes.some((scope) => !allowed.has(scope))
  ) {
    throw new AgentProtocolError(
      "scope_unauthorized",
      "Pairing requires challenge read, challenge run, and pairing management scopes; requested scopes must be unique and allowed by the one-time code.",
      403,
      false,
      "$.payload.requested_scopes",
    );
  }
  return [...requestedScopes];
}

function verifyEd25519Request(request: SignedAgentProtocolRequest, publicKey: string): boolean {
  try {
    const rawPublicKey = Buffer.from(publicKey, "base64url");
    const signature = Buffer.from(request.auth.signature.value, "base64url");
    if (rawPublicKey.length !== 32 || signature.length !== 64) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey]),
      format: "der",
      type: "spki",
    });
    const signingBytes = canonicalAgentSigningBytes({
      protocol: request.protocol,
      protocol_version: request.protocol_version,
      operation: request.operation,
      request_id: request.request_id,
      sent_at: request.sent_at,
      pairing_id: request.auth.pairing_id,
      key_id: request.auth.key_id,
      payload: request.payload,
    });
    return verifySignature(null, Buffer.from(signingBytes, "utf8"), key, signature);
  } catch {
    return false;
  }
}

function pruneState(state: PairingPlatformState, nowMs: number): void {
  state.codes = state.codes.filter((record) => nowMs - Date.parse(record.expiresAt) <= PAIRING_CODE_RETENTION_MS);
  state.mutationReceipts = state.mutationReceipts.filter((record) => nowMs - Date.parse(record.createdAt) <= MUTATION_RECEIPT_RETENTION_MS);
  state.authorizedRequestReceipts = state.authorizedRequestReceipts.filter((record) => Date.parse(record.expiresAt) > nowMs);
  state.auditEvents = state.auditEvents.filter((record) => nowMs - Date.parse(record.createdAt) <= AUDIT_RETENTION_MS);
  state.rateLimitBuckets = state.rateLimitBuckets.filter((bucket) => Date.parse(bucket.resetAt) > nowMs);
}

function consumeRateLimit(
  state: PairingPlatformState,
  input: { bucket: string; capacityClass: string; limit: number; windowMs: number; now: Date },
): { allowed: boolean; retryAfterMs: number } {
  const bucketHash = opaqueHash("CMAI_PAIRING_RATE_LIMIT_V1", input.bucket);
  const nowMs = input.now.getTime();
  let record = state.rateLimitBuckets.find((candidate) => candidate.bucketHash === bucketHash);
  if (!record || Date.parse(record.resetAt) <= nowMs) {
    state.rateLimitBuckets = state.rateLimitBuckets.filter((candidate) => candidate.bucketHash !== bucketHash);
    const classBucketCount = state.rateLimitBuckets.filter((candidate) => candidate.capacityClass === input.capacityClass).length;
    if (classBucketCount >= MAX_PAIRING_RATE_LIMIT_BUCKETS || state.rateLimitBuckets.length >= MAX_PAIRING_RATE_LIMIT_BUCKETS_TOTAL_VALUE) {
      throw new PairingPlatformError(503, "pairing_capacity_exceeded", "Pairing rate-limit capacity is exhausted.");
    }
    record = {
      bucketHash,
      capacityClass: input.capacityClass,
      count: 1,
      resetAt: new Date(nowMs + input.windowMs).toISOString(),
    };
    state.rateLimitBuckets.push(record);
  } else {
    record.capacityClass ??= input.capacityClass;
    record.count += 1;
  }
  return {
    allowed: record.count <= input.limit,
    retryAfterMs: Math.max(0, Date.parse(record.resetAt) - nowMs),
  };
}

function authorizedRequestReceiptRetentionMs(operation: AuthorizedAgentProtocolRequest["operation"]): number {
  return operation === "contribution.submit" ? AGENT_FEED_SUBMISSION_RETENTION_MS : AUTHORIZED_REQUEST_RECEIPT_RETENTION_MS;
}

function assertSubmissionRequestReplayClassification(
  operation: AuthorizedAgentProtocolRequest["operation"],
  expectedReplay: boolean,
  value: unknown,
): void {
  if (operation !== "contribution.submit" || !value || typeof value !== "object" || Array.isArray(value)) return;
  const result = value as { requestReplayed?: unknown };
  if (typeof result.requestReplayed !== "boolean" || result.requestReplayed !== expectedReplay) {
    throw new AgentFeedStoreError("store_not_ready", "Pairing and submission request replay evidence disagree.");
  }
}

function mapRevokeReason(reason: AgentPairingRevokeRequest["payload"]["reason"] | "account_deleted" | "moderation"):
  "user_requested" | "security_rotation" | "account_deleted" | "moderation" {
  if (reason === "account_deleted" || reason === "moderation") return reason;
  return reason === "user_requested" ? "user_requested" : "security_rotation";
}

function consumePairingMutationRateLimit(
  state: PairingPlatformState,
  input: { pairingId: string; operation: keyof typeof authenticatedPairingMutationRateLimits; now: Date },
): void {
  const policy = authenticatedPairingMutationRateLimits[input.operation];
  let rate: { allowed: boolean; retryAfterMs: number };
  try {
    rate = consumeRateLimit(state, {
      bucket: `authorized:${input.pairingId}:${input.operation}`,
      capacityClass: `principal:${input.operation}`,
      limit: policy.limit,
      windowMs: policy.windowMs,
      now: input.now,
    });
  } catch (error) {
    if (error instanceof PairingPlatformError && error.status === 503) {
      throw new AgentProtocolError("capacity_exceeded", "Request capacity is temporarily exhausted.", 503, true, undefined, 1);
    }
    throw error;
  }
  if (!rate.allowed) {
    throw new AgentProtocolError(
      "rate_limited",
      "Too many authenticated pairing mutations.",
      429,
      true,
      undefined,
      Math.max(1, Math.ceil(rate.retryAfterMs / 1_000)),
    );
  }
}

function storedMutationError(error: unknown): PairingMutationStoredError | undefined {
  if (error instanceof AgentProtocolError) {
    return {
      kind: "error",
      source: "protocol",
      code: error.code,
      message: error.message,
      status: error.status,
      retryable: error.retryable,
      ...(error.field ? { field: error.field } : {}),
      ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    };
  }
  if (error instanceof PairingPlatformError) {
    return {
      kind: "error",
      source: "platform",
      code: error.code,
      message: error.message,
      status: error.status,
      retryable: error.status === 429 || error.status >= 500,
      ...(error.retryAfterMs !== undefined ? { retryAfterSeconds: Math.max(1, Math.ceil(error.retryAfterMs / 1_000)) } : {}),
    };
  }
  return undefined;
}

function replayMutationError(error: PairingMutationStoredError): Error {
  if (error.source === "platform") {
    return new PairingPlatformError(
      error.status,
      error.code,
      error.message,
      error.retryAfterSeconds === undefined ? undefined : error.retryAfterSeconds * 1_000,
    );
  }
  return new AgentProtocolError(
    error.code,
    error.message,
    error.status,
    error.retryable,
    error.field,
    error.retryAfterSeconds,
  );
}

export class PairingService {
  private readonly clock: () => Date;
  private readonly random: (size: number) => Buffer;
  private readonly telemetry?: PairingTelemetrySink;
  private readonly onTelemetryError?: (error: unknown) => void;

  constructor(readonly backend: PairingStateBackend, options: PairingServiceOptions = {}) {
    this.clock = options.clock ?? (() => new Date());
    this.random = options.randomBytes ?? nodeRandomBytes;
    this.telemetry = options.telemetry;
    this.onTelemetryError = options.onTelemetryError;
  }

  private async protocolTransact<T>(operation: (state: PairingPlatformState) => T | Promise<T>): Promise<T> {
    try {
      return await this.backend.transact(operation);
    } catch (error) {
      if (error instanceof AgentProtocolError || error instanceof PairingPlatformError) throw error;
      throw new AgentProtocolError("service_unavailable", "Pairing service is temporarily unavailable.", 503, true, undefined, 1);
    }
  }

  private emit(event: Parameters<PairingTelemetrySink["emit"]>[0]): void {
    if (!this.telemetry) return;
    try {
      this.telemetry.emit(event);
    } catch (error) {
      this.onTelemetryError?.(error);
    }
  }

  private appendAudit(
    state: PairingPlatformState,
    input: Omit<PairingAuditEvent, "eventId" | "createdAt"> & { createdAt: string },
  ): PairingAuditEvent {
    if (state.auditEvents.length >= MAX_AUDIT_EVENTS) {
      throw new PairingPlatformError(503, "pairing_capacity_exceeded", "Pairing audit capacity is exhausted.");
    }
    const event: PairingAuditEvent = {
      ...input,
      eventId: randomOpaqueId("pair_event", this.random(16)),
    };
    state.auditEvents.unshift(event);
    return event;
  }

  private generateCode(): string {
    const hex = this.random(PAIRING_CODE_ENTROPY_BYTES).toString("hex").toUpperCase();
    return `CMAI-${hex.match(/.{1,8}/g)?.join("-") || hex}`;
  }

  async issuePairingCode(input: {
    ownerId: string;
    runtime: AgentRuntimeKind;
    displayName: string;
    rateLimitKey?: string;
    ttlMs?: number;
  }): Promise<{ pairing_code: string; expires_at: string; runtime: AgentRuntimeKind; display_name: string; scopes: AgentProtocolScope[] }> {
    if (!input.ownerId.trim()) throw new PairingPlatformError(401, "unauthenticated", "Authentication required.");
    const displayName = normalizeDisplayName(input.displayName);
    const ttlMs = input.ttlMs ?? PAIRING_CODE_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > PAIRING_CODE_TTL_MS) {
      throw new PairingPlatformError(422, "invalid_pairing_ttl", "Pairing code TTL is outside the allowed range.");
    }
    const now = this.clock();
    const code = this.generateCode();
    const codeHash = hashPairingCode(code);
    const result = await this.backend.transact<TransactionResult<{ event: PairingAuditEvent; expiresAt: string }>>((state) => {
      pruneState(state, now.getTime());
      const rate = consumeRateLimit(state, {
        bucket: `issue:${input.rateLimitKey || input.ownerId}`,
        capacityClass: "principal:pairing_code_issue",
        limit: PAIRING_CODE_ISSUE_LIMIT,
        windowMs: PAIRING_CODE_ISSUE_WINDOW_MS,
        now,
      });
      if (!rate.allowed) {
        return failure(new PairingPlatformError(429, "pairing_rate_limited", "Too many pairing codes requested. Try again after the cooldown.", rate.retryAfterMs));
      }
      if (state.codes.length >= MAX_CODES) {
        return failure(new PairingPlatformError(503, "pairing_capacity_exceeded", "Pairing code capacity is exhausted."));
      }
      const createdAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
      for (const existing of state.codes) {
        if (existing.ownerId === input.ownerId && existing.expectedRuntime === input.runtime && !existing.consumedAt && !existing.cancelledAt) {
          existing.cancelledAt = createdAt;
        }
      }
      state.codes.push({
        id: randomOpaqueId("pair_code", this.random(16)),
        ownerId: input.ownerId,
        codeHash,
        expectedRuntime: input.runtime,
        expectedDisplayName: displayName,
        allowedScopes: [...FULL_PAIRING_SCOPES],
        createdAt,
        expiresAt,
      });
      const event = this.appendAudit(state, {
        ownerId: input.ownerId,
        action: "pairing_code_issued",
        actor: "owner_session",
        runtime: input.runtime,
        createdAt,
      });
      return success({ event, expiresAt });
    });
    const { expiresAt } = unwrap(result);
    return {
      pairing_code: code,
      expires_at: expiresAt,
      runtime: input.runtime,
      display_name: displayName,
      scopes: [...FULL_PAIRING_SCOPES],
    };
  }

  async redeemPairing(
    request: AgentPairCreateRequest,
    input: { rateLimitKey: string },
  ): Promise<AgentPairingProtocolState> {
    const now = this.clock();
    const codeHash = hashPairingCode(request.payload.pairing_code);
    const normalizedClientLabel = normalizeDisplayName(request.payload.device.display_name);
    const result = await this.protocolTransact<TransactionResult<{ pairing: StoredAgentPairing; event: PairingAuditEvent }>>((state) => {
      pruneState(state, now.getTime());
      const networkRate = consumeRateLimit(state, {
        bucket: `redeem-network:${input.rateLimitKey}`,
        capacityClass: "network:pair_create",
        limit: PAIRING_CODE_REDEEM_NETWORK_LIMIT,
        windowMs: PAIRING_CODE_REDEEM_NETWORK_WINDOW_MS,
        now,
      });
      const codeRate = consumeRateLimit(state, {
        bucket: `redeem-code:${codeHash}`,
        capacityClass: "credential:pairing_code",
        limit: PAIRING_CODE_REDEEM_CODE_LIMIT,
        windowMs: PAIRING_CODE_REDEEM_CODE_WINDOW_MS,
        now,
      });
      if (!networkRate.allowed || !codeRate.allowed) {
        return failure(new PairingPlatformError(
          429,
          "pairing_rate_limited",
          "Too many pairing attempts. Try again after the cooldown.",
          Math.max(networkRate.retryAfterMs, codeRate.retryAfterMs),
        ));
      }
      const code = findPairingCodeByHash(state.codes, codeHash);
      if (!code || code.consumedAt || code.cancelledAt || now.getTime() >= Date.parse(code.expiresAt)) {
        return failure(new AgentProtocolError("pairing_not_found", "Pairing code is invalid or unavailable.", 401, false, "$.payload.pairing_code"));
      }

      code.consumedAt = now.toISOString();
      if (code.expectedRuntime !== request.payload.device.runtime || code.expectedDisplayName !== normalizedClientLabel) {
        return failure(new AgentProtocolError("pairing_not_found", "Pairing code is invalid or unavailable.", 401, false, "$.payload.pairing_code"));
      }
      let grantedScopes: AgentProtocolScope[];
      try {
        grantedScopes = validatePairingScopes(request.payload.requested_scopes, code.allowedScopes);
      } catch (error) {
        return failure(error instanceof Error ? error : new Error("Scope validation failed."));
      }
      if (state.pairings.length >= MAX_PAIRINGS) {
        return failure(new PairingPlatformError(503, "pairing_capacity_exceeded", "Pairing capacity is exhausted."));
      }
      const duplicate = state.pairings.find((pairing) => pairing.status === "active" && (
        (pairing.ownerId === code.ownerId && pairing.device.deviceId === request.payload.device.device_id)
        || pairing.keys.some((key) => key.publicKey === request.payload.public_key.value)
      ));
      if (duplicate) {
        return failure(new AgentProtocolError("malformed_request", "This device or public key is already paired.", 400, false, "$.payload.device.device_id"));
      }

      const at = now.toISOString();
      const pairing: StoredAgentPairing = {
        pairingId: randomOpaqueId("pairing", this.random(18)),
        ownerId: code.ownerId,
        device: {
          deviceId: request.payload.device.device_id,
          displayName: normalizedClientLabel,
          runtime: request.payload.device.runtime,
          ...(request.payload.device.runtime_version ? { runtimeVersion: request.payload.device.runtime_version } : {}),
          adapterName: request.payload.device.adapter_name,
          adapterVersion: request.payload.device.adapter_version,
        },
        status: "active",
        grantedScopes,
        keys: [{
          keyId: request.payload.public_key.key_id,
          algorithm: "ed25519",
          generation: 1,
          publicKey: request.payload.public_key.value,
          status: "active",
          activatedAt: at,
        }],
        createdAt: at,
        updatedAt: at,
      };
      state.pairings.push(pairing);
      code.pairingId = pairing.pairingId;
      const event = this.appendAudit(state, {
        ownerId: pairing.ownerId,
        pairingId: pairing.pairingId,
        action: "pairing_created",
        actor: "paired_client",
        runtime: pairing.device.runtime,
        createdAt: at,
      });
      return success({ pairing, event });
    });

    if (!result.ok) {
      this.emit({
        name: "pairing.failed",
        eventId: randomOpaqueId("pair_fail", this.random(16)),
        subjectId: input.rateLimitKey,
        runtime: request.payload.device.runtime,
        failureBucket: result.error instanceof PairingPlatformError && result.error.status === 429
          ? "policy"
          : result.error instanceof AgentProtocolError && result.error.code === "pairing_not_found"
            ? "authorization"
            : "conflict",
      });
      throw result.error;
    }
    this.emit({
      name: "pairing.created",
      eventId: result.value.event.eventId,
      ownerId: result.value.pairing.ownerId,
      pairingId: result.value.pairing.pairingId,
      runtime: result.value.pairing.device.runtime,
      grantedScopes: [...result.value.pairing.grantedScopes],
    });
    return protocolPairingState(result.value.pairing);
  }

  async listOwnerPairings(ownerId: string): Promise<{ pairings: OwnerPairingView[]; audit: OwnerPairingAuditView[] }> {
    const state = await this.backend.read();
    return {
      pairings: state.pairings
        .filter((pairing) => pairing.ownerId === ownerId)
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .map(ownerPairingView),
      audit: state.auditEvents
        .filter((event) => event.ownerId === ownerId)
        .slice(0, 100)
        .map(ownerAuditView),
    };
  }

  async renamePairing(input: { ownerId: string; pairingId: string; displayName: string }): Promise<OwnerPairingView> {
    const displayName = normalizeDisplayName(input.displayName);
    const now = this.clock().toISOString();
    const result = await this.backend.transact<TransactionResult<OwnerPairingView>>((state) => {
      const pairing = state.pairings.find((candidate) => candidate.pairingId === input.pairingId && candidate.ownerId === input.ownerId);
      if (!pairing) return failure(new PairingPlatformError(404, "pairing_not_found", "Pairing not found."));
      if (pairing.status !== "active") return failure(new PairingPlatformError(409, "pairing_revoked", "Pairing has been revoked."));
      pairing.device.displayName = displayName;
      pairing.updatedAt = now;
      this.appendAudit(state, {
        ownerId: pairing.ownerId,
        pairingId: pairing.pairingId,
        action: "device_renamed",
        actor: "owner_session",
        runtime: pairing.device.runtime,
        createdAt: now,
      });
      return success(ownerPairingView(pairing));
    });
    return unwrap(result);
  }

  private authorizeInState(
    state: PairingPlatformState,
    request: SignedAgentProtocolRequest,
    now: Date,
    options: {
      allowExpiredSentAt?: boolean;
      allowRetiredKey?: boolean;
      allowRevokedPairing?: boolean;
      allowRevokedKey?: boolean;
    } = {},
  ): PairingAuthorizationContext {
    if (!options.allowExpiredSentAt) assertAgentRequestTime(request.sent_at, now);
    const pairing = state.pairings.find((candidate) => candidate.pairingId === request.auth.pairing_id);
    if (!pairing) throw new AgentProtocolError("pairing_not_found", "Pairing was not found.", 401, false, "$.auth.pairing_id");
    if (pairing.status !== "active" && !options.allowRevokedPairing) throw new AgentProtocolError("pairing_revoked", "Pairing has been revoked.", 401, false, "$.auth.pairing_id");
    const key = pairing.keys.find((candidate) => candidate.keyId === request.auth.key_id);
    if (!key) throw new AgentProtocolError("pairing_key_inactive", "Pairing key is not active.", 401, false, "$.auth.key_id");
    if (key.status === "revoked" && !options.allowRevokedKey) throw new AgentProtocolError("pairing_key_revoked", "Pairing key has been revoked.", 401, false, "$.auth.key_id");
    if (
      key.status !== "active"
      && !(key.status === "retired" && options.allowRetiredKey)
      && !(key.status === "revoked" && options.allowRevokedKey)
    ) throw new AgentProtocolError("pairing_key_inactive", "Pairing key is no longer active.", 401, false, "$.auth.key_id");
    if (!verifyEd25519Request(request, key.publicKey)) {
      throw new AgentProtocolError("signature_invalid", "Request signature is invalid.", 401, false, "$.auth.signature");
    }
    assertAgentProtocolScope(request.operation, pairing.grantedScopes);
    return {
      pairingId: pairing.pairingId,
      ownerId: pairing.ownerId,
      deviceId: pairing.device.deviceId,
      runtime: pairing.device.runtime,
      grantedScopes: [...pairing.grantedScopes],
      keyId: key.keyId,
      requestReplay: "new",
      requestAuthorizedAt: now.toISOString(),
      requestReceiptExpiresAt: new Date(now.getTime() + (request.operation === "contribution.submit" ? AGENT_FEED_SUBMISSION_RETENTION_MS : AUTHORIZED_REQUEST_RECEIPT_RETENTION_MS)).toISOString(),
    };
  }

  private async assertNetworkRateLimit(input: {
    identity: string;
    bucketName: string;
    capacityClass: string;
    limit: number;
    windowMs: number;
  }): Promise<void> {
    const now = this.clock();
    let result: TransactionResult<void>;
    try {
      result = await this.backend.transact<TransactionResult<void>>((state) => {
        pruneState(state, now.getTime());
        try {
          const rate = consumeRateLimit(state, {
            bucket: `${input.bucketName}:${input.identity}`,
            capacityClass: input.capacityClass,
            limit: input.limit,
            windowMs: input.windowMs,
            now,
          });
          if (!rate.allowed) {
            return failure(new AgentProtocolError(
              "rate_limited",
              "Too many Agent protocol requests from this network.",
              429,
              true,
              undefined,
              Math.max(1, Math.ceil(rate.retryAfterMs / 1_000)),
            ));
          }
          return success(undefined);
        } catch (error) {
          if (error instanceof PairingPlatformError && error.status === 503) {
            return failure(new AgentProtocolError("capacity_exceeded", "Network request capacity is temporarily exhausted.", 503, true, undefined, 1));
          }
          return failure(error instanceof Error ? error : new Error("Network rate limit failed."));
        }
      });
    } catch {
      throw new AgentProtocolError("service_unavailable", "Pairing persistence is temporarily unavailable.", 503, true, undefined, 1);
    }
    unwrap(result);
  }

  async assertPairingNetworkRateLimit(input: { identity: string }): Promise<void> {
    await this.assertNetworkRateLimit({
      identity: input.identity,
      bucketName: "protocol-network:pairing",
      capacityClass: "network:pairing_protocol",
      ...pairingNetworkPreauthRateLimit,
    });
  }

  async assertAgentFeedNetworkRateLimit(input: { identity: string }): Promise<void> {
    await this.assertNetworkRateLimit({
      identity: input.identity,
      bucketName: "protocol-network:agent-feed",
      capacityClass: "network:agent_feed",
      ...agentFeedNetworkPreauthRateLimit,
    });
  }

  async assertProtocolNetworkRateLimit(input: {
    identity: string;
    operation: AuthorizedAgentProtocolRequest["operation"];
  }): Promise<void> {
    const policy = agentProtocolNetworkRateLimits[input.operation];
    await this.assertNetworkRateLimit({
      identity: input.identity,
      bucketName: `protocol-network:${input.operation}`,
      capacityClass: `network:${input.operation}`,
      ...policy,
    });
  }

  async authorizeAndExecute<T>(
    request: AuthorizedAgentProtocolRequest,
    action: (authorization: PairingAuthorizationContext) => T | Promise<T>,
  ): Promise<T> {
    const now = this.clock();
    let result: TransactionResult<T>;
    try {
      result = await this.backend.transact<TransactionResult<T>>(async (state, transactionContext) => {
        pruneState(state, now.getTime());
        let actionStarted = false;
        try {
          const requestHash = hashAgentProtocolPayload({
            sent_at: request.sent_at,
            key_id: request.auth.key_id,
            payload: request.payload,
          });
          const existing = state.authorizedRequestReceipts.find((receipt) =>
            receipt.pairingId === request.auth.pairing_id
            && receipt.requestId === request.request_id,
          );
          const authorization = this.authorizeInState(state, request, now, {
            allowExpiredSentAt: existing !== undefined,
          });
          if (existing && (existing.operation !== request.operation || existing.requestHash !== requestHash)) {
            throw new AgentProtocolError("idempotency_conflict", "Request ID was already used with a different signed request.", 409, false, "$.request_id");
          }
          if (existing) {
            actionStarted = true;
            const value = await action({
              ...authorization,
              requestReplay: "exact",
              requestAuthorizedAt: existing.createdAt,
              requestReceiptExpiresAt: existing.expiresAt,
              ...(transactionContext.agentFeedStore ? { agentFeedStore: transactionContext.agentFeedStore } : {}),
            });
            assertSubmissionRequestReplayClassification(request.operation, true, value);
            return success(value);
          }

        const policy = authenticatedAgentOperationRateLimits[request.operation];
        let rate: { allowed: boolean; retryAfterMs: number };
        try {
          rate = consumeRateLimit(state, {
            bucket: `authorized:${authorization.pairingId}:${request.operation}`,
            capacityClass: `principal:${request.operation}`,
            limit: policy.limit,
            windowMs: policy.windowMs,
            now,
          });
        } catch (error) {
          if (error instanceof PairingPlatformError && error.status === 503) {
            throw new AgentProtocolError("capacity_exceeded", "Request capacity is temporarily exhausted.", 503, true, undefined, 1);
          }
          throw error;
        }
        if (!rate.allowed) {
          throw new AgentProtocolError(
            "rate_limited",
            "Too many authenticated Agent requests.",
            429,
            true,
            undefined,
            Math.max(1, Math.ceil(rate.retryAfterMs / 1_000)),
          );
        }
        const submissionReceipts = state.authorizedRequestReceipts.filter((receipt) => receipt.operation === "contribution.submit");
        const readReceiptCount = state.authorizedRequestReceipts.length - submissionReceipts.length;
        if (
          state.authorizedRequestReceipts.length >= MAX_AUTHORIZED_REQUEST_RECEIPTS_TOTAL
          || (request.operation === "contribution.submit" && (
            submissionReceipts.length >= MAX_AUTHORIZED_SUBMISSION_REQUEST_RECEIPTS
            || submissionReceipts.filter((receipt) => receipt.pairingId === authorization.pairingId).length >= MAX_AUTHORIZED_SUBMISSION_REQUEST_RECEIPTS_PER_PAIRING
          ))
          || (request.operation !== "contribution.submit" && readReceiptCount >= MAX_AUTHORIZED_READ_REQUEST_RECEIPTS)
        ) {
          throw new AgentProtocolError("capacity_exceeded", "Request receipt capacity is temporarily exhausted.", 503, true, undefined, 1);
        }

        actionStarted = true;
        const value = await action({
          ...authorization,
          ...(transactionContext.agentFeedStore ? { agentFeedStore: transactionContext.agentFeedStore } : {}),
        });
        assertSubmissionRequestReplayClassification(request.operation, false, value);
        state.authorizedRequestReceipts.unshift({
          pairingId: authorization.pairingId,
          operation: request.operation,
          requestId: request.request_id,
          requestHash,
          createdAt: authorization.requestAuthorizedAt,
          expiresAt: authorization.requestReceiptExpiresAt,
        });
        return success(value);
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error("Pairing authorization failed.");
          if (actionStarted) throw new PairingProtectedActionAbort(normalized);
          return failure(normalized);
        }
      });
    } catch (error) {
      if (error instanceof PairingProtectedActionAbort) throw error.originalError;
      const unavailable = new AgentProtocolError("service_unavailable", "Pairing persistence is temporarily unavailable.", 503, true, undefined, 1);
      (unavailable as Error & { cause?: unknown }).cause = error;
      throw unavailable;
    }
    return unwrap(result);
  }

  private mutationReceipt(
    state: PairingPlatformState,
    request: AgentPairingRotateKeyRequest | AgentPairingRevokeRequest,
  ): { status: "none" } | { status: "exact" | "conflict"; receipt: PairingMutationReceipt } {
    const receipt = state.mutationReceipts.find((candidate) => candidate.pairingId === request.auth.pairing_id && candidate.requestId === request.request_id);
    if (!receipt) return { status: "none" };
    const requestHash = hashAgentProtocolPayload(request);
    if (receipt.operation !== request.operation || receipt.requestHash !== requestHash) {
      return { status: "conflict", receipt };
    }
    return { status: "exact", receipt };
  }

  private recordMutationReceipt(
    state: PairingPlatformState,
    request: AgentPairingRotateKeyRequest | AgentPairingRevokeRequest,
    outcome: PairingMutationReceipt["outcome"],
    createdAt: string,
  ): void {
    if (state.mutationReceipts.length >= MAX_MUTATION_RECEIPTS) {
      throw new PairingPlatformError(503, "pairing_capacity_exceeded", "Pairing mutation receipt capacity is exhausted.");
    }
    state.mutationReceipts.unshift({
      pairingId: request.auth.pairing_id,
      requestId: request.request_id,
      operation: request.operation,
      requestHash: hashAgentProtocolPayload(request),
      outcome: clone(outcome),
      createdAt,
    });
  }

  async rotateKey(request: AgentPairingRotateKeyRequest): Promise<AgentPairingProtocolState> {
    const now = this.clock();
    const result = await this.protocolTransact<TransactionResult<AgentPairingProtocolState>>((state) => {
      pruneState(state, now.getTime());
      let authenticated = false;
      let replayStatus: "none" | "exact" | "conflict" = "none";
      let mutationBaseline: PairingPlatformState | undefined;
      try {
        const replay = this.mutationReceipt(state, request);
        replayStatus = replay.status;
        const replayPairingState = replay.status === "none" || replay.receipt.outcome.kind !== "success"
          ? undefined
          : replay.receipt.outcome.pairingState;
        const authorization = this.authorizeInState(state, request, now, replay.status === "none" ? {} : {
          allowExpiredSentAt: true,
          allowRetiredKey: replayPairingState?.keys.some((key) => key.key_id === request.auth.key_id && key.status === "retired") === true,
        });
        authenticated = true;
        if (replay.status === "exact") {
          return replay.receipt.outcome.kind === "success"
            ? success(clone(replay.receipt.outcome.pairingState))
            : failure(replayMutationError(replay.receipt.outcome));
        }
        if (replay.status === "conflict") {
          throw new AgentProtocolError("idempotency_conflict", "Request ID was already used for a different pairing mutation.", 409, false, "$.request_id");
        }
        consumePairingMutationRateLimit(state, {
          pairingId: authorization.pairingId,
          operation: request.operation,
          now,
        });
        mutationBaseline = clone(state);
        const pairing = state.pairings.find((candidate) => candidate.pairingId === authorization.pairingId);
        if (!pairing) throw new AgentProtocolError("pairing_not_found", "Pairing was not found.", 401, false, "$.auth.pairing_id");
        const current = pairing.keys.find((key) => key.keyId === request.payload.replaces_key_id && key.status === "active");
        if (!current || current.keyId !== request.auth.key_id) {
          throw new AgentProtocolError("pairing_key_inactive", "Rotation must replace the signing active key.", 401, false, "$.payload.replaces_key_id");
        }
        if (pairing.keys.some((key) => key.keyId === request.payload.new_public_key.key_id)) {
          throw new AgentProtocolError("malformed_request", "Replacement key ID already exists.", 400, false, "$.payload.new_public_key.key_id");
        }
        if (pairing.keys.length >= MAX_PAIRING_KEY_HISTORY) {
          throw new PairingPlatformError(409, "pairing_key_history_full", "Pairing key history is full; revoke and re-pair this device.");
        }
        if (request.payload.new_public_key.generation <= current.generation) {
          throw new AgentProtocolError("malformed_request", "Replacement key generation must increase.", 400, false, "$.payload.new_public_key.generation");
        }
        const at = now.toISOString();
        current.status = "retired";
        current.retiredAt = at;
        pairing.keys.push({
          keyId: request.payload.new_public_key.key_id,
          algorithm: "ed25519",
          generation: request.payload.new_public_key.generation,
          publicKey: request.payload.new_public_key.value,
          status: "active",
          activatedAt: at,
        });
        pairing.updatedAt = at;
        this.appendAudit(state, {
          ownerId: pairing.ownerId,
          pairingId: pairing.pairingId,
          action: "key_rotated",
          actor: "paired_client",
          runtime: pairing.device.runtime,
          reason: "security_rotation",
          createdAt: at,
        });
        const snapshot = protocolPairingState(pairing);
        this.recordMutationReceipt(state, request, { kind: "success", pairingState: snapshot }, at);
        return success(snapshot);
      } catch (error) {
        const stored = authenticated && replayStatus === "none" ? storedMutationError(error) : undefined;
        if (stored) {
          if (mutationBaseline) Object.assign(state, mutationBaseline);
          this.recordMutationReceipt(state, request, stored, now.toISOString());
        }
        return failure(error instanceof Error ? error : new Error("Key rotation failed."));
      }
    });
    return unwrap(result);
  }

  async revokeFromClient(request: AgentPairingRevokeRequest): Promise<AgentPairingProtocolState> {
    const now = this.clock();
    const result = await this.protocolTransact<TransactionResult<{ snapshot: AgentPairingProtocolState; revokedPairing?: StoredAgentPairing; event?: PairingAuditEvent }>>((state) => {
      pruneState(state, now.getTime());
      let authenticated = false;
      let replayStatus: "none" | "exact" | "conflict" = "none";
      let mutationBaseline: PairingPlatformState | undefined;
      try {
        const replay = this.mutationReceipt(state, request);
        replayStatus = replay.status;
        const replayPairingState = replay.status === "none" || replay.receipt.outcome.kind !== "success"
          ? undefined
          : replay.receipt.outcome.pairingState;
        const replaySigningKey = replayPairingState?.keys.find((key) => key.key_id === request.auth.key_id);
        const authorization = this.authorizeInState(state, request, now, replay.status === "none" ? {} : {
          allowExpiredSentAt: true,
          allowRevokedPairing: replayPairingState?.status === "revoked",
          allowRevokedKey: replaySigningKey?.status === "revoked",
        });
        authenticated = true;
        if (replay.status === "exact") {
          return replay.receipt.outcome.kind === "success"
            ? success({ snapshot: clone(replay.receipt.outcome.pairingState) })
            : failure(replayMutationError(replay.receipt.outcome));
        }
        if (replay.status === "conflict") {
          throw new AgentProtocolError("idempotency_conflict", "Request ID was already used for a different pairing mutation.", 409, false, "$.request_id");
        }
        consumePairingMutationRateLimit(state, {
          pairingId: authorization.pairingId,
          operation: request.operation,
          now,
        });
        mutationBaseline = clone(state);
        const pairing = state.pairings.find((candidate) => candidate.pairingId === authorization.pairingId);
        if (!pairing) throw new AgentProtocolError("pairing_not_found", "Pairing was not found.", 401, false, "$.auth.pairing_id");
        const at = now.toISOString();
        const reason = mapRevokeReason(request.payload.reason);
        let event: PairingAuditEvent;
        if (request.payload.revoke === "pairing") {
          for (const key of pairing.keys) {
            if (key.status !== "revoked") {
              key.status = "revoked";
              key.revokedAt = at;
            }
          }
          pairing.status = "revoked";
          pairing.revokedAt = at;
          pairing.updatedAt = at;
          event = this.appendAudit(state, {
            ownerId: pairing.ownerId,
            pairingId: pairing.pairingId,
            action: "pairing_revoked",
            actor: "paired_client",
            runtime: pairing.device.runtime,
            reason,
            createdAt: at,
          });
        } else {
          const target = pairing.keys.find((key) => key.keyId === request.payload.key_id);
          if (!target) throw new AgentProtocolError("pairing_key_inactive", "Pairing key was not found.", 401, false, "$.payload.key_id");
          const wasActive = target.status === "active";
          target.status = "revoked";
          target.revokedAt = at;
          if (wasActive) {
            pairing.status = "revoked";
            pairing.revokedAt = at;
          }
          pairing.updatedAt = at;
          event = this.appendAudit(state, {
            ownerId: pairing.ownerId,
            pairingId: pairing.pairingId,
            action: wasActive ? "pairing_revoked" : "key_revoked",
            actor: "paired_client",
            runtime: pairing.device.runtime,
            reason,
            createdAt: at,
          });
        }
        const snapshot = protocolPairingState(pairing);
        this.recordMutationReceipt(state, request, { kind: "success", pairingState: snapshot }, at);
        return success({ snapshot, ...(pairing.status === "revoked" ? { revokedPairing: clone(pairing), event } : {}) });
      } catch (error) {
        const stored = authenticated && replayStatus === "none" ? storedMutationError(error) : undefined;
        if (stored) {
          if (mutationBaseline) Object.assign(state, mutationBaseline);
          this.recordMutationReceipt(state, request, stored, now.toISOString());
        }
        return failure(error instanceof Error ? error : new Error("Pairing revocation failed."));
      }
    });
    const value = unwrap(result);
    if (value.revokedPairing && value.event) {
      this.emit({
        name: "pairing.revoked",
        eventId: value.event.eventId,
        ownerId: value.revokedPairing.ownerId,
        pairingId: value.revokedPairing.pairingId,
        runtime: value.revokedPairing.device.runtime,
        reason: value.event.reason || "user_requested",
        authority: "user",
      });
    }
    return value.snapshot;
  }

  async revokeByOwner(input: {
    ownerId: string;
    pairingId: string;
    reason: "user_requested" | "device_lost" | "suspected_compromise" | "account_deleted" | "moderation";
    authority?: "user" | "moderator" | "system_policy";
  }): Promise<OwnerPairingView> {
    const now = this.clock().toISOString();
    const reason = mapRevokeReason(input.reason);
    const result = await this.backend.transact<TransactionResult<{ pairing: StoredAgentPairing; event: PairingAuditEvent }>>((state) => {
      const pairing = state.pairings.find((candidate) => candidate.pairingId === input.pairingId && candidate.ownerId === input.ownerId);
      if (!pairing) return failure(new PairingPlatformError(404, "pairing_not_found", "Pairing not found."));
      if (pairing.status === "revoked") return success({ pairing: clone(pairing), event: state.auditEvents.find((event) => event.pairingId === pairing.pairingId && event.action === "pairing_revoked") || {
        eventId: randomOpaqueId("pair_event", this.random(16)),
        ownerId: pairing.ownerId,
        pairingId: pairing.pairingId,
        action: "pairing_revoked" as PairingAuditAction,
        actor: "owner_session",
        runtime: pairing.device.runtime,
        reason,
        createdAt: pairing.revokedAt || now,
      } });
      for (const key of pairing.keys) {
        if (key.status !== "revoked") {
          key.status = "revoked";
          key.revokedAt = now;
        }
      }
      pairing.status = "revoked";
      pairing.revokedAt = now;
      pairing.updatedAt = now;
      const event = this.appendAudit(state, {
        ownerId: pairing.ownerId,
        pairingId: pairing.pairingId,
        action: "pairing_revoked",
        actor: input.authority === "system_policy" ? "system_policy" : "owner_session",
        runtime: pairing.device.runtime,
        reason,
        createdAt: now,
      });
      return success({ pairing: clone(pairing), event });
    });
    const { pairing, event } = unwrap(result);
    this.emit({
      name: "pairing.revoked",
      eventId: event.eventId,
      ownerId: pairing.ownerId,
      pairingId: pairing.pairingId,
      runtime: pairing.device.runtime,
      reason,
      authority: input.authority || "user",
    });
    return ownerPairingView(pairing);
  }
}
