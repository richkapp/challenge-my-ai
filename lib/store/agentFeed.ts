import { z } from "zod";
import { AGENT_PROTOCOL_DEFAULT_NONCE_TTL_MS, type AgentProtocolOperation } from "@/lib/agent-protocol/constants";
import { hashAgentProtocolPayload } from "@/lib/agent-protocol/canonical";
import {
  agentChallengeGetResponseSchema,
  agentFeedListResponseSchema,
  agentProtocolErrorResponseSchema,
  type AgentChallengeGetResponse,
  type AgentFeedListResponse,
  type AgentProtocolErrorResponse,
} from "@/lib/agent-protocol/schemas";
import type { AgentFeedNormalizedFilters } from "@/lib/agent-feed/cursor";
import { normalizeAgentFeedFilters } from "@/lib/agent-feed/cursor";
import { assertAgentProtocolResponseSize, utf8JsonBytes } from "@/lib/agent-feed/egress";
import { resolveEligibleAgentChallenge } from "@/lib/store/challengeEligibility";
import { challengeCriteriaStatusSchema, type ChallengeCriteriaStatus } from "@/lib/challenges/intent";
import type { PairingPlatformState } from "@/lib/agent-pairing/types";
import { createContributionRecordInState } from "@/lib/store/contributionTransaction";
import type {
  Challenge,
  ChallengeCriteriaQuarantineRecord,
  ChallengeCriteriaVersionRecord,
  Contribution,
  ContributionCard,
  Rating,
} from "@/lib/types";

export const AGENT_FEED_STORE_SCHEMA_VERSION = 2 as const;
export const AGENT_FEED_REQUEST_RETENTION_MS = 30 * 60_000;
export const AGENT_FEED_SNAPSHOT_TTL_MS = 10 * 60_000;
export const AGENT_FEED_GRANT_RETENTION_MS = 24 * 60 * 60_000;
export const AGENT_FEED_SUBMISSION_RETENTION_MS = 30 * 24 * 60 * 60_000;
export const MAX_AGENT_FEED_REQUEST_RECEIPTS = 10_000;
export const MAX_AGENT_FEED_RESPONSE_CACHE = 10_000;
export const MAX_AGENT_FEED_RESPONSE_CACHE_BYTES = 32 * 1024 * 1024;
export const MAX_AGENT_FEED_RESPONSE_CACHE_PER_PAIRING = 500;
export const MAX_AGENT_FEED_RESPONSE_CACHE_BYTES_PER_PAIRING = 1024 * 1024;
export const MAX_AGENT_FEED_SNAPSHOTS = 5_000;
export const MAX_AGENT_FEED_SNAPSHOT_IDS = 100_000;
export const MAX_AGENT_FEED_SNAPSHOT_CHALLENGES = 1_000;
export const MAX_AGENT_RUN_GRANTS = 50_000;
export const MAX_AGENT_SUBMISSION_RECEIPTS = 50_000;

export type AgentFeedProtocolOperation = Extract<AgentProtocolOperation, "feed.list" | "challenge.get">;
export type AgentFeedJsonValue = string | number | boolean | null | AgentFeedJsonValue[] | { [key: string]: AgentFeedJsonValue };

export type AgentFeedRequestReceipt = {
  pairingId: string;
  operation: AgentFeedProtocolOperation;
  requestId: string;
  requestHash: string;
  responseCacheId: string;
  createdAt: string;
  expiresAt: string;
};

export type AgentFeedResponseCacheRecord = {
  cacheId: string;
  pairingId: string;
  operation: AgentFeedProtocolOperation;
  requestId: string;
  response: AgentFeedJsonValue;
  serializedBytes: number;
  createdAt: string;
  expiresAt: string;
};

export type AgentFeedSnapshotRecord = {
  snapshotId: string;
  filtersHash: string;
  audienceHash: string;
  challengeIds: string[];
  createdAt: string;
  expiresAt: string;
};

export type AgentRunGrantRecord = {
  grantId: string;
  nonceHash: string;
  pairingId: string;
  requestId: string;
  challengeId: string;
  challengeRevision: number;
  requestClass: "challenge_contribution";
  promptVersion: string;
  maxOutputBytes: number;
  issuedAt: string;
  expiresAt: string;
  consumedAt?: string;
  submissionId?: string;
};

export type AgentSubmissionReceiptRecord = {
  pairingId: string;
  contributorId?: string;
  challengeId: string;
  challengeRevision: number;
  criteriaStatusAtSubmission: ChallengeCriteriaStatus;
  idempotencyKeyHash: string;
  cardHash: string;
  nonceHash: string;
  submissionId: string;
  contributionId: string;
  acceptedAt: string;
  expiresAt: string;
} & (
  | { payloadIdentity: "canonical_payload_v1"; payloadHash: string }
  | { payloadIdentity: "legacy_request_v1"; legacyRequestHash: string }
);

export type AgentSubmissionTerminalKind =
  | "idempotency_conflict"
  | "duplicate_submit"
  | "run_nonce_unknown"
  | "run_nonce_expired"
  | "run_nonce_replayed"
  | "run_nonce_mismatch"
  | "challenge_unavailable";

export type AgentSubmissionTerminalResult = {
  kind: AgentSubmissionTerminalKind;
  requestReplayed: boolean;
  originalSubmissionId?: string;
};

export type AgentSubmissionRequestReceiptRecord = {
  pairingId: string;
  requestId: string;
  requestHash: string;
  createdAt: string;
  expiresAt: string;
  outcome:
    | { kind: "submission"; submissionId: string }
    | { kind: "terminal"; result: Omit<AgentSubmissionTerminalResult, "requestReplayed"> };
};

export type AgentFeedPersistedState = {
  schemaVersion: typeof AGENT_FEED_STORE_SCHEMA_VERSION;
  requestReceipts: AgentFeedRequestReceipt[];
  responseCache: AgentFeedResponseCacheRecord[];
  snapshots: AgentFeedSnapshotRecord[];
  runGrants: AgentRunGrantRecord[];
  submissionReceipts: AgentSubmissionReceiptRecord[];
  submissionRequestReceipts: AgentSubmissionRequestReceiptRecord[];
};

export type AgentFeedTransactionRoot = {
  challenges: Challenge[];
  challengeCriteriaVersions: ChallengeCriteriaVersionRecord[];
  challengeCriteriaQuarantine: ChallengeCriteriaQuarantineRecord[];
  contributions: Contribution[];
  ratings: Rating[];
  agentFeedState: AgentFeedPersistedState;
};

export type AgentFeedPageResult = {
  challenges: Challenge[];
  criteria: ChallengeCriteriaVersionRecord[];
  resumeOffsets: number[];
  snapshotId: string;
  nextOffset?: number;
  expiresAt: string;
};

export type AgentFeedRequestLookup =
  | { kind: "none" }
  | { kind: "conflict" }
  | { kind: "exact"; response: unknown };

export type AgentGrantIssueResult =
  | { kind: "issued"; grant: AgentRunGrantRecord; challenge: Challenge; criteria: ChallengeCriteriaVersionRecord }
  | { kind: "challenge_unavailable" }
  | { kind: "nonce_conflict" }
  | { kind: "capacity_exceeded" };

export type AgentSubmissionAcceptResult =
  | { kind: "accepted"; submissionId: string; contribution: Contribution; replayed: false; requestReplayed: false }
  | { kind: "replayed"; submissionId: string; contribution: Contribution; replayed: true; requestReplayed: boolean }
  | AgentSubmissionTerminalResult;

export class AgentFeedStoreError extends Error {
  constructor(readonly code: "store_not_ready" | "schema_unsupported" | "snapshot_invalid" | "response_invalid" | "request_conflict" | "capacity_exceeded", message: string) {
    super(message);
    this.name = "AgentFeedStoreError";
  }
}

export type AgentFeedStoreReadiness =
  | { ready: true; schemaVersion: typeof AGENT_FEED_STORE_SCHEMA_VERSION }
  | {
      ready: false;
      reason: "state_table_missing" | "state_row_missing" | "migration_required" | "schema_version_unsupported" | "store_unavailable";
      observedSchemaVersion?: number;
    };

export type AgentFeedReadResponse = AgentFeedListResponse | AgentChallengeGetResponse | AgentProtocolErrorResponse;
export type AgentFeedRequestTransactionInput = {
  pairingId: string;
  operation: AgentFeedProtocolOperation;
  requestId: string;
  requestHash: string;
  responseCacheId: string;
  requestAuthorizedAt: string;
  requestReceiptExpiresAt: string;
};
export type AgentFeedRequestTransactionResult = {
  replayed: boolean;
  response: AgentFeedReadResponse;
};
export type AgentFeedRequestExecutor = (transaction: AgentFeedTransaction) => AgentFeedReadResponse;
export type AgentFeedTransactionalStore = {
  transactAgentFeedRequest(
    input: AgentFeedRequestTransactionInput,
    execute: AgentFeedRequestExecutor,
    transactionTime?: Date,
  ): Promise<AgentFeedRequestTransactionResult> | AgentFeedRequestTransactionResult;
  submitAgentFeedContribution(
    input: AgentFeedSubmissionInput,
    transactionTime?: Date,
  ): Promise<AgentSubmissionAcceptResult> | AgentSubmissionAcceptResult;
};
export type AgentFeedQueryInput = {
  filters: AgentFeedNormalizedFilters;
  limit: number;
};
export type AgentFeedQueryResult = {
  challenges: Challenge[];
  hasMore: boolean;
};

const persistedIdentifierSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/u);
const persistedHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const persistedBoundHashSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/u);
const persistedDateSchema = z.string().datetime({ offset: true });

const requestReceiptSchema = z.object({
  pairingId: persistedIdentifierSchema,
  operation: z.enum(["feed.list", "challenge.get"]),
  requestId: persistedIdentifierSchema,
  requestHash: persistedHashSchema,
  responseCacheId: persistedIdentifierSchema,
  createdAt: persistedDateSchema,
  expiresAt: persistedDateSchema,
}).strict().superRefine((record, context) => {
  if (Date.parse(record.expiresAt) - Date.parse(record.createdAt) !== AGENT_FEED_REQUEST_RETENTION_MS) {
    context.addIssue({ code: "custom", message: "Request receipt must use the authoritative read retention window.", path: ["expiresAt"] });
  }
});

const responseCacheRecordSchema = z.object({
  cacheId: persistedIdentifierSchema,
  pairingId: persistedIdentifierSchema,
  operation: z.enum(["feed.list", "challenge.get"]),
  requestId: persistedIdentifierSchema,
  response: z.unknown(),
  serializedBytes: z.number().int().positive(),
  createdAt: persistedDateSchema,
  expiresAt: persistedDateSchema,
}).strict().superRefine((record, context) => {
  const responseSchema = record.operation === "feed.list"
    ? z.union([agentFeedListResponseSchema, agentProtocolErrorResponseSchema])
    : z.union([agentChallengeGetResponseSchema, agentProtocolErrorResponseSchema]);
  if (!responseSchema.safeParse(record.response).success) {
    context.addIssue({ code: "custom", message: "Cached Agent protocol response is invalid.", path: ["response"] });
  }
  const responseRequestId = record.response && typeof record.response === "object" && !Array.isArray(record.response)
    ? (record.response as { request_id?: unknown }).request_id
    : undefined;
  if (responseRequestId !== record.requestId) {
    context.addIssue({ code: "custom", message: "Cached Agent protocol response belongs to another request.", path: ["response"] });
  }
  if (utf8JsonBytes(record.response) !== record.serializedBytes) {
    context.addIssue({ code: "custom", message: "Cached Agent protocol response byte count is invalid.", path: ["serializedBytes"] });
  }
  try {
    assertAgentProtocolResponseSize(record.operation, record.response);
  } catch {
    context.addIssue({ code: "custom", message: "Cached Agent protocol response exceeds the operation egress limit.", path: ["response"] });
  }
  if (Date.parse(record.expiresAt) - Date.parse(record.createdAt) !== AGENT_FEED_REQUEST_RETENTION_MS) {
    context.addIssue({ code: "custom", message: "Cached response must use the authoritative read retention window.", path: ["expiresAt"] });
  }
});

export function assertAgentFeedPersistedReadEvidenceV1(
  rawRequestReceipts: unknown,
  rawResponseCache: unknown,
): Pick<AgentFeedPersistedState, "requestReceipts" | "responseCache"> {
  const parsedReceipts = z.array(requestReceiptSchema).max(MAX_AGENT_FEED_REQUEST_RECEIPTS).safeParse(rawRequestReceipts);
  const parsedCache = z.array(responseCacheRecordSchema).max(MAX_AGENT_FEED_RESPONSE_CACHE).safeParse(rawResponseCache);
  if (!parsedReceipts.success || !parsedCache.success) {
    const detail = !parsedReceipts.success
      ? parsedReceipts.error.issues[0]?.message
      : !parsedCache.success
        ? parsedCache.error.issues[0]?.message
        : undefined;
    throw new AgentFeedStoreError("store_not_ready", `Legacy Agent feed read evidence is malformed; v2 migration refused${detail ? `: ${detail}` : "."}`);
  }
  const requestReceipts = parsedReceipts.data;
  const responseCache = parsedCache.data;
  if (new Set(requestReceipts.map((record) => `${record.pairingId}\0${record.requestId}`)).size !== requestReceipts.length) {
    throw new AgentFeedStoreError("store_not_ready", "Legacy Agent feed request receipt identities are not unique; v2 migration refused.");
  }
  const cacheById = new Map<string, (typeof responseCache)[number]>();
  for (const record of responseCache) {
    if (cacheById.has(record.cacheId)) {
      throw new AgentFeedStoreError("store_not_ready", "Legacy Agent feed response cache identities are not unique; v2 migration refused.");
    }
    cacheById.set(record.cacheId, record);
  }
  const ownerCount = new Map<string, number>();
  for (const receipt of requestReceipts) {
    const cached = cacheById.get(receipt.responseCacheId);
    if (
      !cached
      || cached.pairingId !== receipt.pairingId
      || cached.operation !== receipt.operation
      || cached.requestId !== receipt.requestId
      || cached.createdAt !== receipt.createdAt
      || cached.expiresAt !== receipt.expiresAt
    ) {
      throw new AgentFeedStoreError("store_not_ready", `Legacy read request ${receipt.requestId} lacks exactly one canonical cache record; v2 migration refused.`);
    }
    ownerCount.set(cached.cacheId, (ownerCount.get(cached.cacheId) ?? 0) + 1);
  }
  if (responseCache.some((record) => ownerCount.get(record.cacheId) !== 1)) {
    throw new AgentFeedStoreError("store_not_ready", "Legacy response cache ownership is not one-to-one; v2 migration refused.");
  }
  return clone({ requestReceipts, responseCache }) as Pick<AgentFeedPersistedState, "requestReceipts" | "responseCache">;
}

const snapshotRecordSchema = z.object({
  snapshotId: persistedIdentifierSchema,
  filtersHash: persistedBoundHashSchema,
  audienceHash: persistedBoundHashSchema,
  challengeIds: z.array(persistedIdentifierSchema).max(MAX_AGENT_FEED_SNAPSHOT_CHALLENGES),
  createdAt: persistedDateSchema,
  expiresAt: persistedDateSchema,
}).strict().superRefine((record, context) => {
  if (Date.parse(record.expiresAt) <= Date.parse(record.createdAt)) {
    context.addIssue({ code: "custom", message: "Snapshot expiry must follow creation.", path: ["expiresAt"] });
  }
});

const runGrantRecordSchema = z.object({
  grantId: persistedIdentifierSchema,
  nonceHash: persistedHashSchema,
  pairingId: persistedIdentifierSchema,
  requestId: persistedIdentifierSchema,
  challengeId: persistedIdentifierSchema,
  challengeRevision: z.number().int().nonnegative(),
  requestClass: z.literal("challenge_contribution"),
  promptVersion: z.string().min(1).max(80),
  maxOutputBytes: z.number().int().positive().max(256 * 1024),
  issuedAt: persistedDateSchema,
  expiresAt: persistedDateSchema,
  consumedAt: persistedDateSchema.optional(),
  submissionId: persistedIdentifierSchema.optional(),
}).strict().superRefine((grant, context) => {
  const issuedAt = Date.parse(grant.issuedAt);
  const expiresAt = Date.parse(grant.expiresAt);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > AGENT_PROTOCOL_DEFAULT_NONCE_TTL_MS) {
    context.addIssue({ code: "custom", message: "Persisted run grant lifetime exceeds the authoritative maximum.", path: ["expiresAt"] });
  }
  if ((grant.consumedAt === undefined) !== (grant.submissionId === undefined)) {
    context.addIssue({ code: "custom", message: "Consumed grants require one submission ID and vice versa." });
  }
  if (grant.consumedAt && (Date.parse(grant.consumedAt) < issuedAt || Date.parse(grant.consumedAt) >= expiresAt)) {
    context.addIssue({ code: "custom", message: "Grant consumption must occur after issuance and before expiry.", path: ["consumedAt"] });
  }
});

const submissionReceiptSchema = z.intersection(
  z.object({
    pairingId: persistedIdentifierSchema,
    contributorId: persistedIdentifierSchema.optional(),
    challengeId: persistedIdentifierSchema,
    challengeRevision: z.number().int().nonnegative(),
    criteriaStatusAtSubmission: challengeCriteriaStatusSchema,
    idempotencyKeyHash: persistedHashSchema,
    cardHash: persistedHashSchema,
    nonceHash: persistedHashSchema,
    submissionId: persistedIdentifierSchema,
    contributionId: persistedIdentifierSchema,
    acceptedAt: persistedDateSchema,
    expiresAt: persistedDateSchema,
  }).strict(),
  z.discriminatedUnion("payloadIdentity", [
    z.object({ payloadIdentity: z.literal("canonical_payload_v1"), payloadHash: persistedHashSchema }).strict(),
    z.object({ payloadIdentity: z.literal("legacy_request_v1"), legacyRequestHash: persistedHashSchema }).strict(),
  ]),
).superRefine((record, context) => {
  if (Date.parse(record.expiresAt) <= Date.parse(record.acceptedAt)) {
    context.addIssue({ code: "custom", message: "Submission receipt expiry must follow acceptance.", path: ["expiresAt"] });
  }
});

const submissionTerminalKindSchema = z.enum([
  "idempotency_conflict",
  "duplicate_submit",
  "run_nonce_unknown",
  "run_nonce_expired",
  "run_nonce_replayed",
  "run_nonce_mismatch",
  "challenge_unavailable",
]);

const submissionRequestReceiptSchema = z.object({
  pairingId: persistedIdentifierSchema,
  requestId: persistedIdentifierSchema,
  requestHash: persistedHashSchema,
  createdAt: persistedDateSchema,
  expiresAt: persistedDateSchema,
  outcome: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("submission"), submissionId: persistedIdentifierSchema }).strict(),
    z.object({
      kind: z.literal("terminal"),
      result: z.object({
        kind: submissionTerminalKindSchema,
        originalSubmissionId: persistedIdentifierSchema.optional(),
      }).strict(),
    }).strict(),
  ]),
}).strict().superRefine((record, context) => {
  if (Date.parse(record.expiresAt) - Date.parse(record.createdAt) !== AGENT_FEED_SUBMISSION_RETENTION_MS) {
    context.addIssue({ code: "custom", message: "Submission request receipt must use the authoritative submission retention window.", path: ["expiresAt"] });
  }
});

const agentFeedPersistedStateSchema = z.object({
  schemaVersion: z.literal(AGENT_FEED_STORE_SCHEMA_VERSION),
  requestReceipts: z.array(requestReceiptSchema).max(MAX_AGENT_FEED_REQUEST_RECEIPTS),
  responseCache: z.array(responseCacheRecordSchema).max(MAX_AGENT_FEED_RESPONSE_CACHE),
  snapshots: z.array(snapshotRecordSchema).max(MAX_AGENT_FEED_SNAPSHOTS),
  runGrants: z.array(runGrantRecordSchema).max(MAX_AGENT_RUN_GRANTS),
  submissionReceipts: z.array(submissionReceiptSchema).max(MAX_AGENT_SUBMISSION_RECEIPTS),
  submissionRequestReceipts: z.array(submissionRequestReceiptSchema).max(MAX_AGENT_SUBMISSION_RECEIPTS).default([]),
}).strict().superRefine((state, context) => {
  const unique = (values: string[], path: string) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: `Persisted ${path} values must be unique.`, path: [path] });
    }
  };
  unique(state.requestReceipts.map((record) => `${record.pairingId}\0${record.requestId}`), "requestReceipts");
  unique(state.responseCache.map((record) => record.cacheId), "responseCache");
  unique(state.snapshots.map((record) => record.snapshotId), "snapshots");
  unique(state.runGrants.map((record) => record.grantId), "runGrants");
  unique(state.runGrants.map((record) => record.nonceHash), "runGrants");
  unique(state.submissionReceipts.map((record) => `${record.pairingId}\0${record.idempotencyKeyHash}`), "submissionReceipts");
  unique(state.submissionReceipts.map((record) => record.submissionId), "submissionReceipts");
  unique(state.submissionReceipts.map((record) => record.contributionId), "submissionReceipts");
  unique(state.submissionRequestReceipts.map((record) => `${record.pairingId}\0${record.requestId}`), "submissionRequestReceipts");
  const responseBytes = state.responseCache.reduce((total, record) => total + record.serializedBytes, 0);
  if (responseBytes > MAX_AGENT_FEED_RESPONSE_CACHE_BYTES) {
    context.addIssue({ code: "custom", message: "Persisted Agent feed response cache exceeds its byte budget.", path: ["responseCache"] });
  }
  const responseCountByPairing = new Map<string, number>();
  const responseBytesByPairing = new Map<string, number>();
  const cacheById = new Map<string, (typeof state.responseCache)[number]>();
  for (const record of state.responseCache) {
    responseCountByPairing.set(record.pairingId, (responseCountByPairing.get(record.pairingId) ?? 0) + 1);
    responseBytesByPairing.set(record.pairingId, (responseBytesByPairing.get(record.pairingId) ?? 0) + record.serializedBytes);
    cacheById.set(record.cacheId, record);
  }
  if ([...responseCountByPairing.values()].some((count) => count > MAX_AGENT_FEED_RESPONSE_CACHE_PER_PAIRING)) {
    context.addIssue({ code: "custom", message: "Persisted Agent feed response cache exceeds one pairing's count budget.", path: ["responseCache"] });
  }
  if ([...responseBytesByPairing.values()].some((bytes) => bytes > MAX_AGENT_FEED_RESPONSE_CACHE_BYTES_PER_PAIRING)) {
    context.addIssue({ code: "custom", message: "Persisted Agent feed response cache exceeds one pairing's byte budget.", path: ["responseCache"] });
  }
  const snapshotIds = state.snapshots.reduce((total, record) => total + record.challengeIds.length, 0);
  if (snapshotIds > MAX_AGENT_FEED_SNAPSHOT_IDS) {
    context.addIssue({ code: "custom", message: "Persisted Agent feed snapshots exceed the aggregate ID budget.", path: ["snapshots"] });
  }

  const cacheReferenceCounts = new Map<string, number>();
  for (const receipt of state.requestReceipts) {
    const cached = cacheById.get(receipt.responseCacheId);
    const responseRequestId = cached?.response && typeof cached.response === "object" && !Array.isArray(cached.response)
      ? (cached.response as { request_id?: unknown }).request_id
      : undefined;
    if (
      !cached
      || cached.pairingId !== receipt.pairingId
      || cached.operation !== receipt.operation
      || cached.requestId !== receipt.requestId
      || responseRequestId !== receipt.requestId
    ) {
      context.addIssue({ code: "custom", message: "Request receipt must reference its matching request-bound response cache record.", path: ["requestReceipts"] });
      continue;
    }
    cacheReferenceCounts.set(cached.cacheId, (cacheReferenceCounts.get(cached.cacheId) ?? 0) + 1);
  }
  for (const cached of state.responseCache) {
    if (cacheReferenceCounts.get(cached.cacheId) !== 1) {
      context.addIssue({ code: "custom", message: "Every response cache record must have exactly one owning request receipt.", path: ["responseCache"] });
    }
  }

  const grantByNonce = new Map(state.runGrants.map((record) => [record.nonceHash, record]));
  const submissionGrantIdentities = new Set(state.submissionReceipts.map((record) =>
    `${record.nonceHash}\0${record.submissionId}\0${record.pairingId}\0${record.challengeId}\0${record.challengeRevision}`,
  ));
  const submissionReceiptKeys = new Set(state.submissionReceipts.map((record) => `${record.pairingId}\0${record.submissionId}`));
  const aliasStats = new Map<string, { count: number; latestExpiry: number }>();
  for (const record of state.submissionRequestReceipts) {
    const outcome = record.outcome;
    if (!("submissionId" in outcome)) continue;
    const key = `${record.pairingId}\0${outcome.submissionId}`;
    const previous = aliasStats.get(key);
    aliasStats.set(key, {
      count: (previous?.count ?? 0) + 1,
      latestExpiry: Math.max(previous?.latestExpiry ?? Number.NEGATIVE_INFINITY, Date.parse(record.expiresAt)),
    });
  }

  for (const grant of state.runGrants) {
    if (!grant.consumedAt || !grant.submissionId) continue;
    const identity = `${grant.nonceHash}\0${grant.submissionId}\0${grant.pairingId}\0${grant.challengeId}\0${grant.challengeRevision}`;
    if (!submissionGrantIdentities.has(identity)) {
      context.addIssue({ code: "custom", message: "Consumed run grant must reference its matching submission receipt.", path: ["runGrants"] });
    }
  }
  for (const receipt of state.submissionReceipts) {
    const grant = grantByNonce.get(receipt.nonceHash);
    if (
      !grant
      || grant.submissionId !== receipt.submissionId
      || grant.pairingId !== receipt.pairingId
      || grant.challengeId !== receipt.challengeId
      || grant.challengeRevision !== receipt.challengeRevision
      || grant.consumedAt !== receipt.acceptedAt
    ) {
      context.addIssue({ code: "custom", message: "Submission receipt must reference its matching consumed run grant.", path: ["submissionReceipts"] });
    }
    const aliases = aliasStats.get(`${receipt.pairingId}\0${receipt.submissionId}`);
    if (!aliases || aliases.count === 0 || aliases.latestExpiry !== Date.parse(receipt.expiresAt)) {
      context.addIssue({ code: "custom", message: "Submission receipt must retain exactly through its latest request alias.", path: ["submissionRequestReceipts"] });
    }
  }
  for (const requestReceipt of state.submissionRequestReceipts) {
    const outcome = requestReceipt.outcome;
    if (!("submissionId" in outcome)) continue;
    if (!submissionReceiptKeys.has(`${requestReceipt.pairingId}\0${outcome.submissionId}`)) {
      context.addIssue({ code: "custom", message: "Submission request receipt must reference one retained business receipt.", path: ["submissionRequestReceipts"] });
    }
  }
});

export function assertAgentFeedPersistedStateV2(raw: unknown): AgentFeedPersistedState {
  const parsed = agentFeedPersistedStateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AgentFeedStoreError("store_not_ready", "Agent feed state is malformed or violates persisted invariants.");
  }
  return clone(parsed.data) as AgentFeedPersistedState;
}

/** @deprecated Use assertAgentFeedPersistedStateV2 for the current schema. */
export const assertAgentFeedPersistedStateV1 = assertAgentFeedPersistedStateV2;

function assertContributionReferences(rawRoot: Record<string, unknown>, state: AgentFeedPersistedState): void {
  const rawContributions = Array.isArray(rawRoot.contributions) ? rawRoot.contributions : [];
  const contributions = new Map<string, Contribution>();
  for (const value of rawContributions) {
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { id?: unknown }).id !== "string") continue;
    const contribution = value as Contribution;
    if (contributions.has(contribution.id)) {
      throw new AgentFeedStoreError("store_not_ready", "Persisted contribution identifiers must be unique.");
    }
    contributions.set(contribution.id, contribution);
  }
  for (const receipt of state.submissionReceipts) {
    const contribution = contributions.get(receipt.contributionId);
    if (
      !contribution
      || contribution.challengeId !== receipt.challengeId
      || contribution.contributorId !== (receipt.contributorId ?? receipt.pairingId)
      || contribution.contributorKind !== "agent"
      || contribution.createdAt !== receipt.acceptedAt
      || contribution.status !== "posted"
      || contribution.externallyGenerated !== true
      || contribution.card?.challenge_id !== receipt.challengeId
      || hashAgentProtocolPayload(contribution.card) !== receipt.cardHash
      || contribution.criteriaVersion !== receipt.challengeRevision
      || contribution.criteriaStatusAtSubmission !== receipt.criteriaStatusAtSubmission
    ) {
      throw new AgentFeedStoreError("store_not_ready", "Submission receipt contribution evidence is missing or inconsistent.");
    }
  }
}

export function assertAgentProtocolStateCoherence(
  pairingState: PairingPlatformState,
  rawRoot: unknown,
  _now: Date = new Date(),
): void {
  if (!rawRoot || typeof rawRoot !== "object" || Array.isArray(rawRoot)) {
    throw new AgentFeedStoreError("store_not_ready", "Agent protocol root state is missing or malformed.");
  }
  const root = rawRoot as Record<string, unknown>;
  const feedState = assertAgentFeedPersistedRootV2(root);
  const pairingReceipts = pairingState.authorizedRequestReceipts;
  const pairingByRequest = new Map(pairingReceipts.map((receipt) => [`${receipt.pairingId}\0${receipt.requestId}`, receipt]));
  const feedEvidence = [
    ...feedState.requestReceipts.map((receipt) => ({
      pairingId: receipt.pairingId,
      requestId: receipt.requestId,
      operation: receipt.operation,
      requestHash: receipt.requestHash,
      createdAt: receipt.createdAt,
      expiresAt: receipt.expiresAt,
    })),
    ...feedState.submissionRequestReceipts.map((receipt) => ({
      pairingId: receipt.pairingId,
      requestId: receipt.requestId,
      operation: "contribution.submit" as const,
      requestHash: receipt.requestHash,
      createdAt: receipt.createdAt,
      expiresAt: receipt.expiresAt,
    })),
  ];
  const feedByRequest = new Map(feedEvidence.map((receipt) => [`${receipt.pairingId}\0${receipt.requestId}`, receipt]));
  if (pairingByRequest.size !== pairingReceipts.length || feedByRequest.size !== feedEvidence.length) {
    throw new AgentFeedStoreError("store_not_ready", "Agent protocol replay evidence must be one-to-one across pairing and feed state.");
  }
  const matches = (left: (typeof pairingReceipts)[number], right: (typeof feedEvidence)[number]) => left.pairingId === right.pairingId
    && left.requestId === right.requestId
    && left.operation === right.operation
    && left.requestHash === right.requestHash
    && left.createdAt === right.createdAt
    && left.expiresAt === right.expiresAt;
  for (const receipt of pairingReceipts) {
    const feedReceipt = feedByRequest.get(`${receipt.pairingId}\0${receipt.requestId}`);
    if (!feedReceipt || !matches(receipt, feedReceipt)) {
      throw new AgentFeedStoreError("store_not_ready", "Pairing authorization receipt has no matching feed transaction evidence.");
    }
  }
  for (const receipt of feedEvidence) {
    const pairingReceipt = pairingByRequest.get(`${receipt.pairingId}\0${receipt.requestId}`);
    if (!pairingReceipt || !matches(pairingReceipt, receipt)) {
      throw new AgentFeedStoreError("store_not_ready", `Feed transaction receipt has no matching pairing authorization evidence (${receipt.operation}:${receipt.requestId}).`);
    }
  }
}

export function assertAgentFeedPersistedRootV2(raw: unknown): AgentFeedPersistedState {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new AgentFeedStoreError("store_not_ready", "Agent feed root state is missing or malformed.");
  }
  const root = raw as Record<string, unknown>;
  const state = assertAgentFeedPersistedStateV2(root.agentFeedState);
  assertContributionReferences(root, state);
  return state;
}

/** @deprecated Use assertAgentFeedPersistedRootV2 for the current schema. */
export const assertAgentFeedPersistedRootV1 = assertAgentFeedPersistedRootV2;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function emptyAgentFeedPersistedState(): AgentFeedPersistedState {
  return {
    schemaVersion: AGENT_FEED_STORE_SCHEMA_VERSION,
    requestReceipts: [],
    responseCache: [],
    snapshots: [],
    runGrants: [],
    submissionReceipts: [],
    submissionRequestReceipts: [],
  };
}

export function normalizeAgentFeedPersistedState(raw: Partial<AgentFeedPersistedState> | null | undefined): AgentFeedPersistedState {
  if (raw?.schemaVersion !== undefined && raw.schemaVersion !== AGENT_FEED_STORE_SCHEMA_VERSION) {
    throw new AgentFeedStoreError("store_not_ready", `Unsupported Agent feed store schema version: ${String(raw.schemaVersion)}.`);
  }
  if (raw?.schemaVersion === AGENT_FEED_STORE_SCHEMA_VERSION) {
    return assertAgentFeedPersistedStateV2(raw);
  }
  return emptyAgentFeedPersistedState();
}

export function hasReadyAgentFeedState(raw: unknown): raw is { agentFeedState: AgentFeedPersistedState } {
  try {
    assertAgentFeedPersistedRootV2(raw);
    return true;
  } catch {
    return false;
  }
}

export function inspectAgentFeedState(raw: unknown): AgentFeedStoreReadiness {
  if (hasReadyAgentFeedState(raw)) return { ready: true, schemaVersion: AGENT_FEED_STORE_SCHEMA_VERSION };
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const candidate = (raw as Record<string, unknown>).agentFeedState;
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      const observed = (candidate as { schemaVersion?: unknown }).schemaVersion;
      if (typeof observed === "number" && observed !== AGENT_FEED_STORE_SCHEMA_VERSION) {
        return { ready: false, reason: "schema_version_unsupported", observedSchemaVersion: observed };
      }
    }
  }
  return { ready: false, reason: "migration_required" };
}

export function migrateAgentFeedStateV1<T extends Record<string, unknown>>(raw: T): { state: T & { agentFeedState: AgentFeedPersistedState }; changed: boolean } {
  if (hasReadyAgentFeedState(raw)) {
    return { state: { ...raw, agentFeedState: normalizeAgentFeedPersistedState(raw.agentFeedState as AgentFeedPersistedState) }, changed: false };
  }
  if ("agentFeedState" in raw && raw.agentFeedState !== undefined && raw.agentFeedState !== null) {
    throw new AgentFeedStoreError("store_not_ready", "Existing Agent feed state is malformed or incompatible.");
  }
  return { state: { ...raw, agentFeedState: emptyAgentFeedPersistedState() }, changed: true };
}

function pruneAgentFeedState(state: AgentFeedPersistedState, nowMs: number): void {
  state.requestReceipts = state.requestReceipts.filter((record) => Date.parse(record.expiresAt) > nowMs);
  state.responseCache = state.responseCache.filter((record) => Date.parse(record.expiresAt) > nowMs);
  state.snapshots = state.snapshots.filter((record) => Date.parse(record.expiresAt) > nowMs);
  state.submissionReceipts = state.submissionReceipts.filter((record) => Date.parse(record.expiresAt) > nowMs);
  const liveSubmissionKeys = new Set(state.submissionReceipts.map((record) => `${record.pairingId}\0${record.submissionId}`));
  state.submissionRequestReceipts = state.submissionRequestReceipts.filter((record) => {
    if (Date.parse(record.expiresAt) <= nowMs) return false;
    const outcome = record.outcome;
    return !("submissionId" in outcome) || liveSubmissionKeys.has(`${record.pairingId}\0${outcome.submissionId}`);
  });
  const liveGrantSubmissionKeys = new Set(state.submissionReceipts.map((record) => `${record.nonceHash}\0${record.submissionId}`));
  state.runGrants = state.runGrants.filter((record) => record.consumedAt && record.submissionId
    ? liveGrantSubmissionKeys.has(`${record.nonceHash}\0${record.submissionId}`)
    : Date.parse(record.expiresAt) + AGENT_FEED_GRANT_RETENTION_MS > nowMs);
}

function normalizedSearchText(challenge: Challenge): string {
  return [
    challenge.title,
    challenge.category,
    challenge.brief.problem_statement,
    challenge.brief.original_ai_answer,
    challenge.brief.context,
    challenge.brief.raw_material_summary,
    ...challenge.brief.constraints,
    ...challenge.brief.success_criteria,
    ...challenge.brief.assumptions_to_test,
    ...challenge.brief.claims_to_check,
    ...challenge.brief.known_risks,
    ...challenge.brief.what_a_useful_response_should_address,
  ].join(" ").normalize("NFKC").toLowerCase();
}

function matchesFilters(root: AgentFeedTransactionRoot, challenge: Challenge, rawFilters: AgentFeedNormalizedFilters): boolean {
  const filters = normalizeAgentFeedFilters(rawFilters);
  if (!resolveEligibleAgentChallenge(root, challenge.id)) return false;
  if (filters.category && challenge.category.normalize("NFKC").trim().toLowerCase() !== filters.category) return false;
  if (filters.requested_modes?.length && !filters.requested_modes.some((mode) => challenge.requestedModes.includes(mode as never))) return false;
  if (filters.min_reward_credits !== undefined && challenge.reward < filters.min_reward_credits) return false;
  if (filters.query) {
    const terms = filters.query.split(" ").filter(Boolean);
    const text = normalizedSearchText(challenge);
    if (!terms.every((term) => text.includes(term))) return false;
  }
  return true;
}

function compareChallenges(left: Challenge, right: Challenge): number {
  return right.reward - left.reward
    || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
    || left.id.localeCompare(right.id);
}

function validateCachedResponse(operation: AgentFeedProtocolOperation, requestId: string, response: unknown): AgentFeedJsonValue {
  assertAgentProtocolResponseSize(operation, response);
  const success = operation === "feed.list"
    ? agentFeedListResponseSchema.safeParse(response)
    : agentChallengeGetResponseSchema.safeParse(response);
  if (success.success && success.data.request_id === requestId) return clone(success.data) as AgentFeedJsonValue;
  const failure = agentProtocolErrorResponseSchema.safeParse(response);
  if (failure.success && failure.data.request_id === requestId) return clone(failure.data) as AgentFeedJsonValue;
  throw new AgentFeedStoreError("response_invalid", "Only a strict request-bound Agent protocol response may be cached.");
}

export type AgentFeedTransaction = {
  lookupRequest(input: { pairingId: string; operation: AgentFeedProtocolOperation; requestId: string; requestHash: string }): AgentFeedRequestLookup;
  recordRequestResult(input: { pairingId: string; operation: AgentFeedProtocolOperation; requestId: string; requestHash: string; responseCacheId: string; response: unknown; requestAuthorizedAt: string; requestReceiptExpiresAt: string }): void;
  listPage(input: { filters: AgentFeedNormalizedFilters; filtersHash: string; audienceHash: string; limit: number; snapshotId: string; offset?: number }): AgentFeedPageResult;
  issueRunGrant(input: {
    grantId: string;
    pairingId: string;
    requestId: string;
    challengeId: string;
    challengeRevision?: number;
    nonceHash: string;
    promptVersion: string;
    maxOutputBytes: number;
    expiresAt: string;
  }): AgentGrantIssueResult;
  discardRunGrant(input: { grantId: string; pairingId: string; requestId: string; nonceHash: string }): void;
  acceptSubmission(input: {
    pairingId: string;
    requestId: string;
    challengeId: string;
    challengeRevision: number;
    nonceHash: string;
    idempotencyKeyHash: string;
    requestHash: string;
    payloadHash: string;
    cardHash: string;
    submissionId: string;
    contributionId: string;
    contributorId: string;
    contributorKind: "human" | "agent";
    contributorLabel: string;
    card: ContributionCard;
    externallyGenerated: boolean;
    acceptedAt: string;
    requestAuthorizedAt: string;
    requestReceiptExpiresAt: string;
  }): AgentSubmissionAcceptResult;
};

export type AgentFeedSubmissionInput = Parameters<AgentFeedTransaction["acceptSubmission"]>[0];

function parseReadResponse(operation: AgentFeedProtocolOperation, requestId: string, response: unknown): AgentFeedReadResponse {
  const success = operation === "feed.list"
    ? agentFeedListResponseSchema.safeParse(response)
    : agentChallengeGetResponseSchema.safeParse(response);
  if (success.success && success.data.request_id === requestId) return clone(success.data) as AgentFeedReadResponse;
  const failure = agentProtocolErrorResponseSchema.safeParse(response);
  if (failure.success && failure.data.request_id === requestId) return clone(failure.data) as AgentFeedReadResponse;
  throw new AgentFeedStoreError("response_invalid", "Agent feed transaction returned the wrong strict request-bound response shape.");
}

export function queryAgentFeedState(root: AgentFeedTransactionRoot, input: AgentFeedQueryInput): AgentFeedQueryResult {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) {
    throw new AgentFeedStoreError("response_invalid", "Agent feed query limit must be between 1 and 50.");
  }
  const selected = root.challenges
    .filter((challenge) => matchesFilters(root, challenge, input.filters))
    .sort(compareChallenges)
    .slice(0, input.limit + 1)
    .map((challenge) => clone(challenge));
  return { challenges: selected.slice(0, input.limit), hasMore: selected.length > input.limit };
}

export function transactAgentFeedRequestState(
  root: AgentFeedTransactionRoot,
  input: AgentFeedRequestTransactionInput,
  execute: AgentFeedRequestExecutor,
  transactionTime: Date,
): AgentFeedRequestTransactionResult {
  const transaction = createAgentFeedTransaction(root, transactionTime);
  const existing = transaction.lookupRequest(input);
  if (existing.kind === "conflict") throw new AgentFeedStoreError("request_conflict", "Request ID was already used with different canonical bytes.");
  if (existing.kind === "exact") {
    return { replayed: true, response: parseReadResponse(input.operation, input.requestId, existing.response) };
  }
  const response = parseReadResponse(input.operation, input.requestId, execute(transaction));
  transaction.recordRequestResult({ ...input, response });
  return { replayed: false, response: clone(response) };
}

export function submitAgentFeedContributionState(
  root: AgentFeedTransactionRoot,
  input: AgentFeedSubmissionInput,
  transactionTime: Date,
): AgentSubmissionAcceptResult {
  return createAgentFeedTransaction(root, transactionTime).acceptSubmission(input);
}

export function createAgentFeedTransaction(root: AgentFeedTransactionRoot, now: Date): AgentFeedTransaction {
  const state = normalizeAgentFeedPersistedState(root.agentFeedState);
  assertContributionReferences(root as unknown as Record<string, unknown>, state);
  root.agentFeedState = state;
  pruneAgentFeedState(state, now.getTime());

  return {
    lookupRequest(input) {
      const receipt = state.requestReceipts.find((candidate) =>
        candidate.pairingId === input.pairingId
        && candidate.operation === input.operation
        && candidate.requestId === input.requestId,
      );
      if (!receipt) return { kind: "none" };
      if (receipt.requestHash !== input.requestHash) return { kind: "conflict" };
      const cached = state.responseCache.find((candidate) =>
        candidate.cacheId === receipt.responseCacheId
        && candidate.pairingId === input.pairingId
        && candidate.operation === input.operation
        && candidate.requestId === input.requestId,
      );
      if (!cached) throw new AgentFeedStoreError("store_not_ready", "Request replay evidence is incomplete.");
      return { kind: "exact", response: clone(cached.response) };
    },

    recordRequestResult(input) {
      const existing = this.lookupRequest(input);
      if (existing.kind === "exact") return;
      if (existing.kind === "conflict") throw new AgentFeedStoreError("request_conflict", "Request ID conflicts with existing receipt evidence.");
      if (state.requestReceipts.length >= MAX_AGENT_FEED_REQUEST_RECEIPTS || state.responseCache.length >= MAX_AGENT_FEED_RESPONSE_CACHE) {
        throw new AgentFeedStoreError("capacity_exceeded", "Agent feed request evidence capacity is exhausted.");
      }
      if (state.responseCache.some((candidate) => candidate.cacheId === input.responseCacheId)) {
        throw new AgentFeedStoreError("response_invalid", "Response cache identifier already exists.");
      }
      const response = validateCachedResponse(input.operation, input.requestId, input.response);
      const serializedBytes = utf8JsonBytes(response);
      const liveCacheBytes = state.responseCache.reduce((total, record) => total + record.serializedBytes, 0);
      const pairingCache = state.responseCache.filter((record) => record.pairingId === input.pairingId);
      const pairingCacheBytes = pairingCache.reduce((total, record) => total + record.serializedBytes, 0);
      if (liveCacheBytes + serializedBytes > MAX_AGENT_FEED_RESPONSE_CACHE_BYTES) {
        throw new AgentFeedStoreError("capacity_exceeded", "Agent feed response cache byte capacity is exhausted.");
      }
      if (
        pairingCache.length >= MAX_AGENT_FEED_RESPONSE_CACHE_PER_PAIRING
        || pairingCacheBytes + serializedBytes > MAX_AGENT_FEED_RESPONSE_CACHE_BYTES_PER_PAIRING
      ) {
        throw new AgentFeedStoreError("capacity_exceeded", "This pairing's Agent feed response-cache capacity is exhausted.");
      }
      const createdAt = input.requestAuthorizedAt;
      const expiresAt = input.requestReceiptExpiresAt;
      const createdAtMs = Date.parse(createdAt);
      const expiresAtMs = Date.parse(expiresAt);
      if (!Number.isFinite(createdAtMs) || !Number.isFinite(expiresAtMs) || createdAtMs > now.getTime() || expiresAtMs <= now.getTime()) {
        throw new AgentFeedStoreError("request_conflict", "Canonical request authorization timestamps are invalid.");
      }
      state.responseCache.unshift({
        cacheId: input.responseCacheId,
        pairingId: input.pairingId,
        operation: input.operation,
        requestId: input.requestId,
        response: clone(response),
        serializedBytes,
        createdAt,
        expiresAt,
      });
      state.requestReceipts.unshift({
        pairingId: input.pairingId,
        operation: input.operation,
        requestId: input.requestId,
        requestHash: input.requestHash,
        responseCacheId: input.responseCacheId,
        createdAt,
        expiresAt,
      });
    },

    listPage(input) {
      if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 50) throw new AgentFeedStoreError("snapshot_invalid", "Feed limit is invalid.");
      const offset = input.offset ?? 0;
      let snapshot = state.snapshots.find((candidate) => candidate.snapshotId === input.snapshotId);
      if (snapshot) {
        if (
          snapshot.filtersHash !== input.filtersHash
          || snapshot.audienceHash !== input.audienceHash
          || Date.parse(snapshot.expiresAt) <= now.getTime()
        ) {
          throw new AgentFeedStoreError("snapshot_invalid", "Feed snapshot is invalid.");
        }
      } else {
        if (offset !== 0) throw new AgentFeedStoreError("snapshot_invalid", "Feed snapshot is missing.");
        if (state.snapshots.length >= MAX_AGENT_FEED_SNAPSHOTS) throw new AgentFeedStoreError("capacity_exceeded", "Feed snapshot capacity is exhausted.");
        if (state.snapshots.some((candidate) => candidate.snapshotId === input.snapshotId)) throw new AgentFeedStoreError("snapshot_invalid", "Feed snapshot identifier already exists.");
        const challengeIds = root.challenges
          .filter((challenge) => matchesFilters(root, challenge, input.filters))
          .sort(compareChallenges)
          .slice(0, MAX_AGENT_FEED_SNAPSHOT_CHALLENGES)
          .map((challenge) => challenge.id);
        const liveSnapshotIds = state.snapshots.reduce((total, record) => total + record.challengeIds.length, 0);
        if (liveSnapshotIds + challengeIds.length > MAX_AGENT_FEED_SNAPSHOT_IDS) {
          throw new AgentFeedStoreError("capacity_exceeded", "Feed snapshot ID capacity is exhausted.");
        }
        snapshot = {
          snapshotId: input.snapshotId,
          filtersHash: input.filtersHash,
          audienceHash: input.audienceHash,
          challengeIds,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + AGENT_FEED_SNAPSHOT_TTL_MS).toISOString(),
        };
        state.snapshots.unshift(snapshot);
      }
      if (offset < 0 || offset > snapshot.challengeIds.length) throw new AgentFeedStoreError("snapshot_invalid", "Feed snapshot offset is invalid.");
      const selected: Array<{ challenge: Challenge; criteria: ChallengeCriteriaVersionRecord; resumeOffset: number }> = [];
      let index = offset;
      while (index < snapshot.challengeIds.length && selected.length < input.limit + 1) {
        const challenge = root.challenges.find((candidate) => candidate.id === snapshot?.challengeIds[index]);
        index += 1;
        if (!challenge || !matchesFilters(root, challenge, input.filters)) continue;
        const eligible = resolveEligibleAgentChallenge(root, challenge.id, challenge.activeCriteriaVersion);
        if (eligible) selected.push({
          challenge: clone(eligible.challenge),
          criteria: clone(eligible.criteria),
          resumeOffset: index,
        });
      }
      const hasMore = selected.length > input.limit || index < snapshot.challengeIds.length;
      const page = selected.slice(0, input.limit);
      return {
        challenges: page.map((item) => item.challenge),
        criteria: page.map((item) => item.criteria),
        resumeOffsets: page.map((item) => item.resumeOffset),
        snapshotId: snapshot.snapshotId,
        ...(hasMore ? { nextOffset: index - Math.max(0, selected.length - input.limit) } : {}),
        expiresAt: snapshot.expiresAt,
      };
    },

    issueRunGrant(input) {
      if (state.runGrants.some((grant) => grant.nonceHash === input.nonceHash || grant.grantId === input.grantId)) return { kind: "nonce_conflict" };
      if (state.runGrants.length >= MAX_AGENT_RUN_GRANTS) return { kind: "capacity_exceeded" };
      const eligible = resolveEligibleAgentChallenge(root, input.challengeId, input.challengeRevision);
      if (!eligible) return { kind: "challenge_unavailable" };
      const expiresAtMs = Date.parse(input.expiresAt);
      if (
        !Number.isFinite(expiresAtMs)
        || expiresAtMs <= now.getTime()
        || expiresAtMs - now.getTime() > AGENT_PROTOCOL_DEFAULT_NONCE_TTL_MS
        || !input.promptVersion
        || input.promptVersion.length > 80
        || !Number.isInteger(input.maxOutputBytes)
        || input.maxOutputBytes < 1
        || input.maxOutputBytes > 256 * 1024
      ) return { kind: "challenge_unavailable" };
      const grant: AgentRunGrantRecord = {
        grantId: input.grantId,
        nonceHash: input.nonceHash,
        pairingId: input.pairingId,
        requestId: input.requestId,
        challengeId: input.challengeId,
        challengeRevision: eligible.criteria.version!,
        requestClass: "challenge_contribution",
        promptVersion: input.promptVersion,
        maxOutputBytes: input.maxOutputBytes,
        issuedAt: now.toISOString(),
        expiresAt: input.expiresAt,
      };
      state.runGrants.unshift(grant);
      return {
        kind: "issued",
        grant: clone(grant),
        challenge: clone(eligible.challenge),
        criteria: clone(eligible.criteria),
      };
    },

    discardRunGrant(input) {
      const index = state.runGrants.findIndex((grant) =>
        grant.grantId === input.grantId
        && grant.pairingId === input.pairingId
        && grant.requestId === input.requestId
        && grant.nonceHash === input.nonceHash
        && grant.consumedAt === undefined,
      );
      if (index < 0) throw new AgentFeedStoreError("store_not_ready", "Provisional run grant rollback evidence is incomplete.");
      state.runGrants.splice(index, 1);
    },

    acceptSubmission(input) {
      const authorizedAtMs = Date.parse(input.requestAuthorizedAt);
      const requestExpiresAtMs = Date.parse(input.requestReceiptExpiresAt);
      if (
        !Number.isFinite(authorizedAtMs)
        || !Number.isFinite(requestExpiresAtMs)
        || authorizedAtMs > now.getTime()
        || requestExpiresAtMs <= now.getTime()
        || requestExpiresAtMs - authorizedAtMs !== AGENT_FEED_SUBMISSION_RETENTION_MS
      ) throw new AgentFeedStoreError("request_conflict", "Canonical submission authorization timestamps are invalid.");

      const recordSubmissionAlias = (submissionId: string): void => {
        if (state.submissionRequestReceipts.length >= MAX_AGENT_SUBMISSION_RECEIPTS) {
          throw new AgentFeedStoreError("capacity_exceeded", "Submission request evidence capacity is exhausted.");
        }
        state.submissionRequestReceipts.unshift({
          pairingId: input.pairingId,
          requestId: input.requestId,
          requestHash: input.requestHash,
          createdAt: input.requestAuthorizedAt,
          expiresAt: input.requestReceiptExpiresAt,
          outcome: { kind: "submission", submissionId },
        });
      };
      const recordTerminal = (
        result: Omit<AgentSubmissionTerminalResult, "requestReplayed">,
      ): AgentSubmissionTerminalResult => {
        if (state.submissionRequestReceipts.length >= MAX_AGENT_SUBMISSION_RECEIPTS) {
          throw new AgentFeedStoreError("capacity_exceeded", "Submission request evidence capacity is exhausted.");
        }
        state.submissionRequestReceipts.unshift({
          pairingId: input.pairingId,
          requestId: input.requestId,
          requestHash: input.requestHash,
          createdAt: input.requestAuthorizedAt,
          expiresAt: input.requestReceiptExpiresAt,
          outcome: { kind: "terminal", result: clone(result) },
        });
        return { ...result, requestReplayed: false };
      };

      const requestReceipt = state.submissionRequestReceipts.find((receipt) =>
        receipt.pairingId === input.pairingId && receipt.requestId === input.requestId,
      );
      if (requestReceipt) {
        if (requestReceipt.requestHash !== input.requestHash) return { kind: "idempotency_conflict", requestReplayed: true };
        const outcome = requestReceipt.outcome;
        if (outcome.kind === "terminal") return { ...clone(outcome.result), requestReplayed: true };
        const businessReceipt = state.submissionReceipts.find((receipt) =>
          receipt.pairingId === input.pairingId && receipt.submissionId === outcome.submissionId,
        );
        const identityMatches = businessReceipt?.payloadIdentity === "canonical_payload_v1"
          ? businessReceipt.payloadHash === input.payloadHash
          : businessReceipt?.payloadIdentity === "legacy_request_v1" && businessReceipt.legacyRequestHash === input.requestHash;
        if (!businessReceipt || !identityMatches) {
          throw new AgentFeedStoreError("store_not_ready", "Submission request replay evidence is incomplete or inconsistent.");
        }
        const contribution = root.contributions.find((candidate) => candidate.id === businessReceipt.contributionId);
        if (!contribution) throw new AgentFeedStoreError("store_not_ready", "Submission replay evidence is incomplete.");
        return { kind: "replayed", submissionId: businessReceipt.submissionId, contribution: clone(contribution), replayed: true, requestReplayed: true };
      }

      const existing = state.submissionReceipts.find((receipt) => receipt.pairingId === input.pairingId && receipt.idempotencyKeyHash === input.idempotencyKeyHash);
      if (existing) {
        if (existing.payloadIdentity !== "canonical_payload_v1" || existing.payloadHash !== input.payloadHash) {
          return recordTerminal({ kind: "idempotency_conflict" });
        }
        const contribution = root.contributions.find((candidate) => candidate.id === existing.contributionId);
        if (!contribution) throw new AgentFeedStoreError("store_not_ready", "Submission replay evidence is incomplete.");
        recordSubmissionAlias(existing.submissionId);
        if (Date.parse(existing.expiresAt) < requestExpiresAtMs) existing.expiresAt = input.requestReceiptExpiresAt;
        return { kind: "replayed", submissionId: existing.submissionId, contribution: clone(contribution), replayed: true, requestReplayed: false };
      }
      const duplicate = state.submissionReceipts.find((receipt) =>
        receipt.pairingId === input.pairingId && receipt.challengeId === input.challengeId && receipt.cardHash === input.cardHash,
      );
      if (duplicate) return recordTerminal({ kind: "duplicate_submit", originalSubmissionId: duplicate.submissionId });
      const eligible = resolveEligibleAgentChallenge(root, input.challengeId, input.challengeRevision);
      if (!eligible) return recordTerminal({ kind: "challenge_unavailable" });
      const grant = state.runGrants.find((candidate) => candidate.nonceHash === input.nonceHash);
      if (!grant) return recordTerminal({ kind: "run_nonce_unknown" });
      if (
        grant.pairingId !== input.pairingId
        || grant.challengeId !== input.challengeId
        || grant.challengeRevision !== input.challengeRevision
        || grant.requestClass !== "challenge_contribution"
      ) return recordTerminal({ kind: "run_nonce_mismatch" });
      if (now.getTime() >= Date.parse(grant.expiresAt)) return recordTerminal({ kind: "run_nonce_expired" });
      if (grant.consumedAt) return recordTerminal({ kind: "run_nonce_replayed" });
      if (
        state.submissionReceipts.length >= MAX_AGENT_SUBMISSION_RECEIPTS
        || state.submissionRequestReceipts.length >= MAX_AGENT_SUBMISSION_RECEIPTS
        || root.contributions.some((contribution) => contribution.id === input.contributionId)
      ) throw new AgentFeedStoreError("capacity_exceeded", "Submission business or request evidence capacity is exhausted.");
      if (input.card.challenge_id !== input.challengeId || Date.parse(input.acceptedAt) >= requestExpiresAtMs) {
        return recordTerminal({ kind: "challenge_unavailable" });
      }
      let contribution: Contribution;
      try {
        contribution = createContributionRecordInState(root, {
          contributionId: input.contributionId,
          challengeId: input.challengeId,
          contributorId: input.contributorId,
          contributorKind: input.contributorKind,
          contributorLabel: input.contributorLabel,
          card: input.card,
          externallyGenerated: input.externallyGenerated,
          createdAt: input.acceptedAt,
          expectedRevision: input.challengeRevision,
        });
      } catch {
        return recordTerminal({ kind: "challenge_unavailable" });
      }
      grant.consumedAt = input.acceptedAt;
      grant.submissionId = input.submissionId;
      state.submissionReceipts.unshift({
        pairingId: input.pairingId,
        contributorId: input.contributorId,
        challengeId: input.challengeId,
        challengeRevision: input.challengeRevision,
        criteriaStatusAtSubmission: eligible.criteria.criteriaStatus,
        idempotencyKeyHash: input.idempotencyKeyHash,
        payloadIdentity: "canonical_payload_v1",
        payloadHash: input.payloadHash,
        cardHash: input.cardHash,
        nonceHash: input.nonceHash,
        submissionId: input.submissionId,
        contributionId: contribution.id,
        acceptedAt: input.acceptedAt,
        expiresAt: input.requestReceiptExpiresAt,
      });
      recordSubmissionAlias(input.submissionId);
      return { kind: "accepted", submissionId: input.submissionId, contribution: clone(contribution), replayed: false, requestReplayed: false };
    },
  };
}
