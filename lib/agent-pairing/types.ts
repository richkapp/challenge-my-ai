import type { AgentProtocolOperation, AgentProtocolScope, AgentRuntimeKind } from "@/lib/agent-protocol/constants";
import type { AgentProtocolErrorCode } from "@/lib/agent-protocol/errors";

export const PAIRING_STATE_SCHEMA_VERSION = 1 as const;
export const MAX_PAIRING_RATE_LIMIT_BUCKETS_TOTAL = 60_000;
export const MAX_AUTHORIZED_READ_REQUEST_RECEIPTS = 10_000;
export const MAX_AUTHORIZED_SUBMISSION_REQUEST_RECEIPTS = 50_000;
export const MAX_AUTHORIZED_SUBMISSION_REQUEST_RECEIPTS_PER_PAIRING = 5_000;
export const MAX_AUTHORIZED_REQUEST_RECEIPTS_TOTAL = MAX_AUTHORIZED_READ_REQUEST_RECEIPTS + MAX_AUTHORIZED_SUBMISSION_REQUEST_RECEIPTS;

export type PairingCodeRecord = {
  id: string;
  ownerId: string;
  codeHash: string;
  expectedRuntime: AgentRuntimeKind;
  expectedDisplayName: string;
  allowedScopes: AgentProtocolScope[];
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  cancelledAt?: string;
  pairingId?: string;
};

export type PairingKeyRecord = {
  keyId: string;
  algorithm: "ed25519";
  generation: number;
  publicKey: string;
  status: "active" | "retired" | "revoked";
  activatedAt: string;
  retiredAt?: string;
  revokedAt?: string;
};

export type StoredAgentPairing = {
  pairingId: string;
  ownerId: string;
  device: {
    deviceId: string;
    displayName: string;
    runtime: AgentRuntimeKind;
    runtimeVersion?: string;
    adapterName: string;
    adapterVersion: string;
  };
  status: "active" | "revoked";
  grantedScopes: AgentProtocolScope[];
  keys: PairingKeyRecord[];
  createdAt: string;
  updatedAt: string;
  revokedAt?: string;
};

export type PairingAuditAction =
  | "pairing_code_issued"
  | "pairing_created"
  | "device_renamed"
  | "key_rotated"
  | "key_revoked"
  | "pairing_revoked";

export type PairingAuditEvent = {
  eventId: string;
  ownerId: string;
  pairingId?: string;
  action: PairingAuditAction;
  actor: "owner_session" | "paired_client" | "system_policy";
  runtime: AgentRuntimeKind;
  reason?: "user_requested" | "security_rotation" | "account_deleted" | "moderation";
  createdAt: string;
};

export type PairingMutationStoredError = {
  kind: "error";
  source: "protocol";
  code: AgentProtocolErrorCode;
  message: string;
  status: number;
  retryable: boolean;
  field?: string;
  retryAfterSeconds?: number;
} | {
  kind: "error";
  source: "platform";
  code: string;
  message: string;
  status: number;
  retryable: boolean;
  retryAfterSeconds?: number;
};

export type PairingMutationReceipt = {
  pairingId: string;
  requestId: string;
  operation: Extract<AgentProtocolOperation, "pairing.rotate_key" | "pairing.revoke">;
  requestHash: string;
  outcome: { kind: "success"; pairingState: AgentPairingProtocolState } | PairingMutationStoredError;
  createdAt: string;
};

export type PairingAuthorizedRequestReceipt = {
  pairingId: string;
  requestId: string;
  operation: Extract<AgentProtocolOperation, "feed.list" | "challenge.get" | "contribution.submit">;
  requestHash: string;
  createdAt: string;
  expiresAt: string;
};

export type PairingRateLimitBucket = {
  bucketHash: string;
  capacityClass?: string;
  count: number;
  resetAt: string;
};

export type PairingPlatformState = {
  schemaVersion: typeof PAIRING_STATE_SCHEMA_VERSION;
  codes: PairingCodeRecord[];
  pairings: StoredAgentPairing[];
  auditEvents: PairingAuditEvent[];
  mutationReceipts: PairingMutationReceipt[];
  authorizedRequestReceipts: PairingAuthorizedRequestReceipt[];
  rateLimitBuckets: PairingRateLimitBucket[];
};

export type AgentPairingProtocolState = {
  pairing_id: string;
  device_id: string;
  status: "active" | "revoked";
  granted_scopes: AgentProtocolScope[];
  keys: Array<{
    key_id: string;
    generation: number;
    status: "active" | "retired" | "revoked";
    activated_at: string;
    retired_at?: string;
    revoked_at?: string;
  }>;
  created_at: string;
  updated_at: string;
  revoked_at?: string;
};

export type OwnerPairingView = AgentPairingProtocolState & {
  device: {
    display_name: string;
    runtime: AgentRuntimeKind;
    runtime_version?: string;
    adapter_name: string;
    adapter_version: string;
  };
};

export type OwnerPairingAuditView = Omit<PairingAuditEvent, "ownerId">;
