import { z } from "zod";
import type { PairingPlatformState } from "@/lib/agent-pairing/types";
import {
  AGENT_FEED_STORE_SCHEMA_VERSION,
  MAX_AGENT_FEED_RESPONSE_CACHE_BYTES_PER_PAIRING,
  MAX_AGENT_FEED_RESPONSE_CACHE_PER_PAIRING,
  assertAgentFeedPersistedReadEvidenceV1,
  assertAgentFeedPersistedRootV2,
  type AgentFeedPersistedState,
} from "@/lib/store/agentFeed";

export const AGENT_FEED_STATE_V2_MIGRATION_ID = "2026-07-15-agent-feed-state-v2" as const;

const identifierSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/u);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const dateSchema = z.string().datetime({ offset: true });
const legacySubmissionReceiptSchema = z.object({
  pairingId: identifierSchema,
  requestId: identifierSchema,
  challengeId: identifierSchema,
  challengeRevision: z.number().int().nonnegative(),
  criteriaStatusAtSubmission: z.enum(["confirmed", "criteria_unconfirmed"]),
  idempotencyKeyHash: hashSchema,
  requestHash: hashSchema,
  cardHash: hashSchema,
  nonceHash: hashSchema,
  submissionId: identifierSchema,
  contributionId: identifierSchema,
  acceptedAt: dateSchema,
  expiresAt: dateSchema,
}).strict();

const legacyFeedStateSchema = z.object({
  schemaVersion: z.literal(1),
  requestReceipts: z.array(z.unknown()),
  responseCache: z.array(z.unknown()),
  snapshots: z.array(z.unknown()),
  runGrants: z.array(z.unknown()),
  submissionReceipts: z.array(legacySubmissionReceiptSchema),
}).strict();

const interimSubmissionReceiptSchema = legacySubmissionReceiptSchema.omit({ requestId: true, requestHash: true }).extend({
  payloadHash: hashSchema,
}).strict();
const interimSubmissionRequestReceiptSchema = z.object({
  pairingId: identifierSchema,
  requestId: identifierSchema,
  requestHash: hashSchema,
  submissionId: identifierSchema,
  createdAt: dateSchema,
  expiresAt: dateSchema,
}).strict();
const interimFeedStateSchema = z.object({
  schemaVersion: z.literal(1),
  requestReceipts: z.array(z.unknown()),
  responseCache: z.array(z.unknown()),
  snapshots: z.array(z.unknown()),
  runGrants: z.array(z.unknown()),
  submissionReceipts: z.array(interimSubmissionReceiptSchema),
  submissionRequestReceipts: z.array(interimSubmissionRequestReceiptSchema),
}).strict();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function pruneExpiredReadEvidence(
  requestReceiptsValue: unknown[],
  responseCacheValue: unknown[],
  pairingState: PairingPlatformState,
  migrationTime: Date,
) {
  const { requestReceipts, responseCache } = assertAgentFeedPersistedReadEvidenceV1(requestReceiptsValue, responseCacheValue);
  const readAuthorizations = pairingState.authorizedRequestReceipts.filter((receipt) => receipt.operation !== "contribution.submit");
  const authorizationIdentity = (receipt: (typeof readAuthorizations)[number]) =>
    `${receipt.pairingId}\0${receipt.operation}\0${receipt.requestId}\0${receipt.requestHash}\0${receipt.createdAt}\0${receipt.expiresAt}`;
  const receiptAuthorizationIdentity = (receipt: (typeof requestReceipts)[number]) =>
    `${receipt.pairingId}\0${receipt.operation}\0${receipt.requestId}\0${receipt.requestHash}\0${receipt.createdAt}\0${receipt.expiresAt}`;
  const receiptIdentity = (receipt: (typeof requestReceipts)[number]) =>
    `${receiptAuthorizationIdentity(receipt)}\0${receipt.responseCacheId}`;

  const authorizationCounts = new Map<string, number>();
  for (const authorization of readAuthorizations) {
    const identity = authorizationIdentity(authorization);
    authorizationCounts.set(identity, (authorizationCounts.get(identity) ?? 0) + 1);
  }
  const receiptCounts = new Map<string, number>();
  for (const receipt of requestReceipts) {
    const identity = receiptAuthorizationIdentity(receipt);
    receiptCounts.set(identity, (receiptCounts.get(identity) ?? 0) + 1);
  }
  for (const receipt of requestReceipts) {
    if (authorizationCounts.get(receiptAuthorizationIdentity(receipt)) !== 1) {
      throw new Error(`Legacy read request ${receipt.requestId} lacks exactly one canonical pairing authorization; v2 migration refused.`);
    }
  }
  for (const authorization of readAuthorizations) {
    if (receiptCounts.get(authorizationIdentity(authorization)) !== 1) {
      throw new Error(`Legacy pairing authorization ${authorization.requestId} lacks exactly one canonical read receipt; v2 migration refused.`);
    }
  }

  const expiredReceiptIdentities = new Set<string>();
  const expiredCacheIds = new Set<string>();
  const expiredAuthorizationIdentities = new Set<string>();
  for (const receipt of requestReceipts) {
    if (Date.parse(receipt.expiresAt) > migrationTime.getTime()) continue;
    expiredReceiptIdentities.add(receiptIdentity(receipt));
    expiredCacheIds.add(receipt.responseCacheId);
    expiredAuthorizationIdentities.add(receiptAuthorizationIdentity(receipt));
  }
  const retainedRequestReceipts = requestReceipts.filter((receipt) => !expiredReceiptIdentities.has(receiptIdentity(receipt)));
  const retainedResponseCache = responseCache.filter((record) => !expiredCacheIds.has(record.cacheId));
  const retainedPairingState: PairingPlatformState = {
    ...pairingState,
    authorizedRequestReceipts: pairingState.authorizedRequestReceipts.filter((receipt) =>
      receipt.operation === "contribution.submit" || !expiredAuthorizationIdentities.has(authorizationIdentity(receipt)),
    ),
  };
  const counts = new Map<string, number>();
  const bytes = new Map<string, number>();
  const latestExpiry = new Map<string, string>();
  for (const record of retainedResponseCache) {
    counts.set(record.pairingId, (counts.get(record.pairingId) ?? 0) + 1);
    bytes.set(record.pairingId, (bytes.get(record.pairingId) ?? 0) + record.serializedBytes);
    const previous = latestExpiry.get(record.pairingId);
    if (!previous || Date.parse(record.expiresAt) > Date.parse(previous)) latestExpiry.set(record.pairingId, record.expiresAt);
  }
  const blockedPairing = [...counts.keys()].find((pairingId) =>
    (counts.get(pairingId) ?? 0) > MAX_AGENT_FEED_RESPONSE_CACHE_PER_PAIRING
    || (bytes.get(pairingId) ?? 0) > MAX_AGENT_FEED_RESPONSE_CACHE_BYTES_PER_PAIRING,
  );
  if (blockedPairing) {
    throw new Error(
      `Agent feed v2 migration requires read-cache drain for pairing ${blockedPairing}: `
      + `${counts.get(blockedPairing)} records / ${bytes.get(blockedPairing)} bytes remain live; `
      + `retry after ${latestExpiry.get(blockedPairing)}.`,
    );
  }
  return {
    requestReceipts: retainedRequestReceipts,
    responseCache: retainedResponseCache,
    pairingState: retainedPairingState,
  };
}

export function migrateAgentFeedStateV2<T extends Record<string, unknown>>(
  rawRoot: T,
  pairingState: PairingPlatformState,
  migrationTime = new Date(),
): { state: Omit<T, "agentFeedState"> & { agentFeedState: AgentFeedPersistedState }; pairingState: PairingPlatformState; changed: boolean } {
  if (!isRecord(rawRoot.agentFeedState)) {
    throw new Error("Agent feed v2 migration requires an existing v1 feed state.");
  }
  const observedVersion = rawRoot.agentFeedState.schemaVersion;
  if (observedVersion === AGENT_FEED_STORE_SCHEMA_VERSION) {
    const agentFeedState = assertAgentFeedPersistedRootV2(rawRoot);
    return { state: { ...rawRoot, agentFeedState }, pairingState, changed: false };
  }
  const legacy = legacyFeedStateSchema.safeParse(rawRoot.agentFeedState);
  const interim = interimFeedStateSchema.safeParse(rawRoot.agentFeedState);
  if (!legacy.success && !interim.success) {
    throw new Error("Agent feed v1 state is malformed; v2 migration refused.");
  }
  const source = interim.success ? interim.data : legacy.data!;
  const pruned = pruneExpiredReadEvidence(source.requestReceipts, source.responseCache, pairingState, migrationTime);
  pairingState = pruned.pairingState;

  let agentFeedState: AgentFeedPersistedState;
  if (interim.success) {
    const submissionRequestReceipts = interim.data.submissionRequestReceipts.map((receipt) => {
      const authorization = pairingState.authorizedRequestReceipts.find((candidate) =>
        candidate.pairingId === receipt.pairingId
        && candidate.requestId === receipt.requestId
        && candidate.operation === "contribution.submit"
        && candidate.requestHash === receipt.requestHash,
      );
      if (!authorization || authorization.createdAt !== receipt.createdAt || authorization.expiresAt !== receipt.expiresAt) {
        throw new Error(`Interim submission request ${receipt.requestId} has no exact pairing authorization evidence.`);
      }
      return {
        pairingId: receipt.pairingId,
        requestId: receipt.requestId,
        requestHash: receipt.requestHash,
        createdAt: receipt.createdAt,
        expiresAt: receipt.expiresAt,
        outcome: { kind: "submission" as const, submissionId: receipt.submissionId },
      };
    });
    agentFeedState = {
      schemaVersion: AGENT_FEED_STORE_SCHEMA_VERSION,
      requestReceipts: pruned.requestReceipts as AgentFeedPersistedState["requestReceipts"],
      responseCache: pruned.responseCache as AgentFeedPersistedState["responseCache"],
      snapshots: interim.data.snapshots as AgentFeedPersistedState["snapshots"],
      runGrants: interim.data.runGrants as AgentFeedPersistedState["runGrants"],
      submissionReceipts: interim.data.submissionReceipts.map((receipt) => {
        const aliases = submissionRequestReceipts.filter((alias) =>
          alias.pairingId === receipt.pairingId && alias.outcome.submissionId === receipt.submissionId,
        );
        if (aliases.length === 0) throw new Error(`Interim submission ${receipt.submissionId} has no request alias.`);
        return {
          ...receipt,
          payloadIdentity: "canonical_payload_v1" as const,
          expiresAt: aliases.reduce((latest, alias) => Date.parse(alias.expiresAt) > Date.parse(latest) ? alias.expiresAt : latest, aliases[0]!.expiresAt),
        };
      }),
      submissionRequestReceipts,
    };
  } else {
    const legacyData = legacy.data!;
    const submissionRequestReceipts = legacyData.submissionReceipts.map((receipt) => {
      const authorization = pairingState.authorizedRequestReceipts.find((candidate) =>
        candidate.pairingId === receipt.pairingId
        && candidate.requestId === receipt.requestId
        && candidate.operation === "contribution.submit"
        && candidate.requestHash === receipt.requestHash,
      );
      if (!authorization) {
        throw new Error(`Legacy submission ${receipt.submissionId} has no matching pairing authorization evidence.`);
      }
      return {
        pairingId: receipt.pairingId,
        requestId: receipt.requestId,
        requestHash: receipt.requestHash,
        createdAt: authorization.createdAt,
        expiresAt: authorization.expiresAt,
        outcome: { kind: "submission" as const, submissionId: receipt.submissionId },
      };
    });
    agentFeedState = {
      schemaVersion: AGENT_FEED_STORE_SCHEMA_VERSION,
      requestReceipts: pruned.requestReceipts as AgentFeedPersistedState["requestReceipts"],
      responseCache: pruned.responseCache as AgentFeedPersistedState["responseCache"],
      snapshots: legacyData.snapshots as AgentFeedPersistedState["snapshots"],
      runGrants: legacyData.runGrants as AgentFeedPersistedState["runGrants"],
      submissionReceipts: legacyData.submissionReceipts.map((receipt, index) => {
        const alias = submissionRequestReceipts[index]!;
        const { requestId: _requestId, requestHash, ...businessReceipt } = receipt;
        return {
          ...businessReceipt,
          payloadIdentity: "legacy_request_v1" as const,
          legacyRequestHash: requestHash,
          expiresAt: alias.expiresAt,
        };
      }),
      submissionRequestReceipts,
    };
  }
  const state = { ...rawRoot, agentFeedState } as Omit<T, "agentFeedState"> & { agentFeedState: AgentFeedPersistedState };
  assertAgentFeedPersistedRootV2(state);
  return { state, pairingState, changed: true };
}
