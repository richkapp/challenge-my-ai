import { describe, expect, it } from "vitest";
import type { AgentChallengeGetResponse, AgentFeedListResponse } from "@/lib/agent-protocol/schemas";
import { validChallengeGetResponseFixture, validFeedListResponseFixture, validContributionSubmitRequestFixture } from "@/lib/agent-protocol/fixtures";
import {
  AGENT_FEED_STORE_SCHEMA_VERSION,
  MAX_AGENT_FEED_SNAPSHOT_IDS,
  MAX_AGENT_FEED_RESPONSE_CACHE_PER_PAIRING,
  MAX_AGENT_FEED_RESPONSE_CACHE_BYTES_PER_PAIRING,
  MAX_AGENT_FEED_RESPONSE_CACHE,
  AgentFeedStoreError,
  assertAgentProtocolStateCoherence,
  assertAgentFeedPersistedRootV1,
  assertAgentFeedPersistedStateV1,
  createAgentFeedTransaction,
  emptyAgentFeedPersistedState,
  hasReadyAgentFeedState,
} from "@/lib/store/agentFeed";
import {
  AGENT_FEED_STATE_V1_MIGRATION_ID,
  AGENT_FEED_STATE_V1_SQL,
  migrateAgentFeedStateV1,
} from "@/db/migrations/agent-feed-state-v1";
import { migrateAgentFeedStateV2 } from "@/db/migrations/agent-feed-state-v2";
import {
  createChallenge,
  getAgentFeedStoreReadiness,
  getChallenge,
  queryAgentFeed,
  resetStoreForTests,
  submitAgentFeedContribution,
  suppressChallenge,
  transactAgentFeedRequest,
  withAgentFeedTransaction,
} from "@/lib/store/local";
import { utf8JsonBytes } from "@/lib/agent-feed/egress";
import { hashAgentProtocolPayload } from "@/lib/agent-protocol/canonical";
import { emptyPairingPlatformState } from "@/lib/agent-pairing/storage";
import type { ChallengeBrief, Contribution } from "@/lib/types";

const now = new Date("2026-07-15T12:00:00.000Z");
const readReceiptTiming = {
  requestAuthorizedAt: now.toISOString(),
  requestReceiptExpiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
};
const submissionReceiptTiming = {
  requestAuthorizedAt: now.toISOString(),
  requestReceiptExpiresAt: new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString(),
};

function brief(title: string, category = "security"): ChallengeBrief {
  return {
    schema_version: "1.0",
    title,
    category,
    challenge_mode_requested: ["critique"],
    problem_statement: `Problem ${title}`,
    original_ai_answer: `Answer ${title}`,
    context: `Context ${title}`,
    constraints: [],
    success_criteria: ["Find the flaw", "Verify the evidence"],
    assumptions_to_test: [],
    claims_to_check: [],
    known_risks: [],
    what_a_useful_response_should_address: ["Evidence"],
    privacy_sensitivity: "public_ok",
    redactions_made: [],
    abuse_or_safety_flags: [],
    missing_information: [],
    raw_material_summary: `Summary ${title}`,
    challenge_semantics_version: "1.0",
    challenge_intent: "pressure_test",
    criteria_status: "confirmed",
    criteria_version: 1,
    successful_outcomes: ["review_complete"],
    criteria_history: [{
      version: 1,
      intent: "pressure_test",
      status: "confirmed",
      success_criteria: ["Find the flaw", "Verify the evidence"],
      successful_outcomes: ["review_complete"],
      change_reason: "Poster confirmed the canonical pressure-test criteria.",
    }],
    reward_posture: {
      basis: "poster_confirmed_impact",
      funding_state: "declarative_only",
      eligible_impact_tiers: ["signal", "useful", "material", "decisive"],
      completion_bonus: "not_applicable",
    },
  };
}

describe("Agent feed store transaction seam", () => {
  it("migrates explicitly and rejects malformed installed state", () => {
    const migrated = migrateAgentFeedStateV1({ challenges: [] });
    expect(migrated.changed).toBe(true);
    expect(migrated.state.agentFeedState.schemaVersion).toBe(AGENT_FEED_STORE_SCHEMA_VERSION);
    expect(hasReadyAgentFeedState(migrated.state)).toBe(true);
    expect(migrateAgentFeedStateV1(migrated.state).changed).toBe(false);
    expect(AGENT_FEED_STATE_V1_MIGRATION_ID).toBe("2026-07-15-agent-feed-state-v1");
    expect(AGENT_FEED_STATE_V1_SQL).toContain("UPDATE cmai_state");
    expect(AGENT_FEED_STATE_V1_SQL).not.toMatch(/CREATE TABLE|INSERT INTO/i);
    expect(() => migrateAgentFeedStateV1({ agentFeedState: { schemaVersion: 99 } })).toThrow(AgentFeedStoreError);
    const malformedGrantState = emptyAgentFeedPersistedState();
    malformedGrantState.runGrants.push({
      grantId: "grant_malformed_ttl",
      nonceHash: "a".repeat(64),
      pairingId: "pairing_malformed_ttl",
      requestId: "request_malformed_ttl",
      challengeId: "challenge_malformed_ttl",
      challengeRevision: 1,
      requestClass: "challenge_contribution",
      promptVersion: "CMAI_HERMES_PROMPT_V1",
      maxOutputBytes: 65_536,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 10 * 60_000 + 1).toISOString(),
    });
    expect(hasReadyAgentFeedState({ agentFeedState: malformedGrantState })).toBe(false);
    expect(() => migrateAgentFeedStateV1({ agentFeedState: malformedGrantState })).toThrow(AgentFeedStoreError);
    expect(emptyAgentFeedPersistedState()).toMatchObject({ requestReceipts: [], snapshots: [], runGrants: [] });
  });

  it("upgrades accepted v1 submissions without losing exact replay or business-truth evidence", () => {
    const acceptedAt = new Date(now.getTime() + 1_000).toISOString();
    const authorizationExpiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60_000).toISOString();
    const card = {
      ...(JSON.parse(JSON.stringify(validContributionSubmitRequestFixture.payload.card)) as Contribution["card"]),
      challenge_id: "challenge_migration_v2",
    };
    const contribution: Contribution = {
      id: "contribution_migration_v2",
      challengeId: "challenge_migration_v2",
      contributorId: "pairing_migration_v2",
      contributorKind: "agent",
      contributorLabel: "Migrated Agent",
      createdAt: acceptedAt,
      status: "posted",
      externallyGenerated: true,
      card,
      communityScore: 0,
      criteriaVersion: 1,
      criteriaStatusAtSubmission: "confirmed",
    };
    const legacyRoot = {
      challenges: [],
      challengeCriteriaVersions: [],
      challengeCriteriaQuarantine: [],
      contributions: [contribution],
      ratings: [],
      agentFeedState: {
        schemaVersion: 1 as const,
        requestReceipts: [],
        responseCache: [],
        snapshots: [],
        runGrants: [{
          grantId: "grant_migration_v2",
          nonceHash: "1".repeat(64),
          pairingId: "pairing_migration_v2",
          requestId: "req_grant_migration_v2",
          challengeId: "challenge_migration_v2",
          challengeRevision: 1,
          requestClass: "challenge_contribution" as const,
          promptVersion: "cmai-contribution-card-v1",
          maxOutputBytes: 64 * 1024,
          issuedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
          consumedAt: acceptedAt,
          submissionId: "submission_migration_v2",
        }],
        submissionReceipts: [{
          pairingId: "pairing_migration_v2",
          requestId: "req_submit_migration_v2",
          challengeId: "challenge_migration_v2",
          challengeRevision: 1,
          criteriaStatusAtSubmission: "confirmed" as const,
          idempotencyKeyHash: "2".repeat(64),
          requestHash: "3".repeat(64),
          cardHash: hashAgentProtocolPayload(card),
          nonceHash: "1".repeat(64),
          submissionId: "submission_migration_v2",
          contributionId: contribution.id,
          acceptedAt,
          expiresAt: new Date(Date.parse(acceptedAt) + 30 * 24 * 60 * 60_000).toISOString(),
        }],
      },
    };
    const pairingState = emptyPairingPlatformState();
    pairingState.authorizedRequestReceipts.push({
      pairingId: "pairing_migration_v2",
      requestId: "req_submit_migration_v2",
      operation: "contribution.submit",
      requestHash: "3".repeat(64),
      createdAt: now.toISOString(),
      expiresAt: authorizationExpiresAt,
    });

    const migrated = migrateAgentFeedStateV2(legacyRoot, pairingState);
    expect(migrated.changed).toBe(true);
    expect(migrated.state.agentFeedState).toMatchObject({
      schemaVersion: 2,
      submissionReceipts: [{
        payloadIdentity: "legacy_request_v1",
        legacyRequestHash: "3".repeat(64),
        expiresAt: authorizationExpiresAt,
      }],
      submissionRequestReceipts: [{
        requestId: "req_submit_migration_v2",
        createdAt: now.toISOString(),
        expiresAt: authorizationExpiresAt,
        outcome: { kind: "submission", submissionId: "submission_migration_v2" },
      }],
    });
    expect(hasReadyAgentFeedState(migrated.state)).toBe(true);
    expect(migrateAgentFeedStateV2(migrated.state, pairingState).changed).toBe(false);

    const interimRoot = {
      ...legacyRoot,
      agentFeedState: {
        ...legacyRoot.agentFeedState,
        submissionReceipts: legacyRoot.agentFeedState.submissionReceipts.map((receipt) => {
          const { requestId: _requestId, requestHash: _requestHash, ...businessReceipt } = receipt;
          return { ...businessReceipt, payloadHash: "4".repeat(64) };
        }),
        submissionRequestReceipts: [{
          pairingId: "pairing_migration_v2",
          requestId: "req_submit_migration_v2",
          requestHash: "3".repeat(64),
          submissionId: "submission_migration_v2",
          createdAt: now.toISOString(),
          expiresAt: authorizationExpiresAt,
        }],
      },
    };
    const interimMigrated = migrateAgentFeedStateV2(interimRoot, pairingState);
    expect(interimMigrated.state.agentFeedState).toMatchObject({
      schemaVersion: 2,
      submissionReceipts: [{ payloadIdentity: "canonical_payload_v1", payloadHash: "4".repeat(64) }],
      submissionRequestReceipts: [{ outcome: { kind: "submission", submissionId: "submission_migration_v2" } }],
    });
  });

  it("drains only expired v1 read evidence before enforcing v2 per-pairing cache quotas", () => {
    const legacyRoot = {
      challenges: [],
      challengeCriteriaVersions: [],
      challengeCriteriaQuarantine: [],
      contributions: [],
      ratings: [],
      agentFeedState: {
        ...emptyAgentFeedPersistedState(),
        schemaVersion: 1 as const,
      },
    };
    const pairingState = emptyPairingPlatformState();
    const appendRead = (pairingId: string, index: number, createdAt: Date, response: AgentFeedListResponse | AgentChallengeGetResponse) => {
      const operation = "challenges" in response.result ? "feed.list" as const : "challenge.get" as const;
      const requestId = `req_v1_drain_${index.toString().padStart(4, "0")}`;
      const requestHash = index.toString(16).padStart(64, "0");
      const cacheId = `cache_v1_drain_${index.toString().padStart(4, "0")}`;
      const expiresAt = new Date(createdAt.getTime() + 30 * 60_000).toISOString();
      legacyRoot.agentFeedState.requestReceipts.push({
        pairingId,
        operation,
        requestId,
        requestHash,
        responseCacheId: cacheId,
        createdAt: createdAt.toISOString(),
        expiresAt,
      });
      legacyRoot.agentFeedState.responseCache.push({
        cacheId,
        pairingId,
        operation,
        requestId,
        response,
        serializedBytes: utf8JsonBytes(response),
        createdAt: createdAt.toISOString(),
        expiresAt,
      });
      pairingState.authorizedRequestReceipts.push({
        pairingId,
        operation,
        requestId,
        requestHash,
        createdAt: createdAt.toISOString(),
        expiresAt,
      });
    };
    for (let index = 0; index < MAX_AGENT_FEED_RESPONSE_CACHE_PER_PAIRING + 1; index += 1) {
      appendRead(
        "pairing_v1_drain_attacker",
        index,
        now,
        JSON.parse(JSON.stringify({ ...validFeedListResponseFixture, request_id: `req_v1_drain_${index.toString().padStart(4, "0")}` })) as AgentFeedListResponse,
      );
    }
    const retainedCreatedAt = new Date(now.getTime() + 5 * 60_000);
    const retainedIndex = MAX_AGENT_FEED_RESPONSE_CACHE_PER_PAIRING + 1;
    appendRead(
      "pairing_v1_drain_retained",
      retainedIndex,
      retainedCreatedAt,
      JSON.parse(JSON.stringify({ ...validFeedListResponseFixture, request_id: `req_v1_drain_${retainedIndex.toString().padStart(4, "0")}` })) as AgentFeedListResponse,
    );

    expect(() => migrateAgentFeedStateV2(legacyRoot, pairingState, new Date(now.getTime() + 10 * 60_000)))
      .toThrow(/requires read-cache drain.*retry after/u);
    const migrated = migrateAgentFeedStateV2(legacyRoot, pairingState, new Date(now.getTime() + 31 * 60_000));
    expect(migrated.state.agentFeedState.requestReceipts).toHaveLength(1);
    expect(migrated.state.agentFeedState.responseCache).toHaveLength(1);
    expect(migrated.pairingState.authorizedRequestReceipts).toHaveLength(1);
    expect(migrated.pairingState.authorizedRequestReceipts[0]?.pairingId).toBe("pairing_v1_drain_retained");
    expect(createAgentFeedTransaction(migrated.state, new Date(now.getTime() + 31 * 60_000)).lookupRequest({
      pairingId: "pairing_v1_drain_retained",
      operation: "feed.list",
      requestId: `req_v1_drain_${retainedIndex.toString().padStart(4, "0")}`,
      requestHash: retainedIndex.toString(16).padStart(64, "0"),
    })).toMatchObject({ kind: "exact", response: { request_id: `req_v1_drain_${retainedIndex.toString().padStart(4, "0")}` } });

    const malformedResponseRoot = structuredClone(legacyRoot);
    const malformedResponse = malformedResponseRoot.agentFeedState.responseCache[0]!.response as { request_id: string };
    malformedResponse.request_id = "req_wrong_audience";
    expect(() => migrateAgentFeedStateV2(malformedResponseRoot, structuredClone(pairingState), new Date(now.getTime() + 31 * 60_000)))
      .toThrow(/malformed|belongs to another request/i);

    const falseByteRoot = structuredClone(legacyRoot);
    falseByteRoot.agentFeedState.responseCache[0]!.serializedBytes += 1;
    expect(() => migrateAgentFeedStateV2(falseByteRoot, structuredClone(pairingState), new Date(now.getTime() + 31 * 60_000)))
      .toThrow(/malformed|byte count/i);

    const duplicateAuthorizationState = structuredClone(pairingState);
    duplicateAuthorizationState.authorizedRequestReceipts.push(structuredClone(duplicateAuthorizationState.authorizedRequestReceipts[0]!));
    expect(() => migrateAgentFeedStateV2(structuredClone(legacyRoot), duplicateAuthorizationState, new Date(now.getTime() + 31 * 60_000)))
      .toThrow(/exactly one canonical pairing authorization/i);

    const largeResponse = JSON.parse(JSON.stringify(validChallengeGetResponseFixture)) as AgentChallengeGetResponse;
    const chunk = "x".repeat(40_000);
    largeResponse.request_id = "req_v1_drain_0000";
    largeResponse.result.challenge.content.problem_statement = chunk;
    largeResponse.result.challenge.content.original_ai_answer = chunk;
    largeResponse.result.challenge.content.context = chunk;
    largeResponse.result.challenge.content.constraints = [chunk];
    largeResponse.result.challenge.content.success_criteria = [chunk];
    largeResponse.result.challenge.content.assumptions_to_test = [chunk];
    largeResponse.result.challenge.content.claims_to_check = [chunk];
    largeResponse.result.challenge.content.known_risks = [chunk];
    largeResponse.result.challenge.content.useful_response_should_address = [chunk];
    largeResponse.result.challenge.content.missing_information = [chunk];
    const byteRoot = {
      ...legacyRoot,
      agentFeedState: { ...emptyAgentFeedPersistedState(), schemaVersion: 1 as const },
    };
    const bytePairingState = emptyPairingPlatformState();
    legacyRoot.agentFeedState = byteRoot.agentFeedState;
    pairingState.authorizedRequestReceipts = bytePairingState.authorizedRequestReceipts;
    for (let index = 0; index < 3; index += 1) {
      const response = JSON.parse(JSON.stringify(largeResponse)) as AgentChallengeGetResponse;
      response.request_id = `req_v1_drain_${index.toString().padStart(4, "0")}`;
      appendRead("pairing_v1_drain_bytes", index, now, response);
    }
    expect(byteRoot.agentFeedState.responseCache.reduce((total, record) => total + record.serializedBytes, 0))
      .toBeGreaterThan(MAX_AGENT_FEED_RESPONSE_CACHE_BYTES_PER_PAIRING);
    expect(() => migrateAgentFeedStateV2(byteRoot, bytePairingState, new Date(now.getTime() + 10 * 60_000)))
      .toThrow(/requires read-cache drain/u);
    const byteMigrated = migrateAgentFeedStateV2(byteRoot, bytePairingState, new Date(now.getTime() + 31 * 60_000));
    expect(byteMigrated.state.agentFeedState.responseCache).toEqual([]);
    expect(byteMigrated.pairingState.authorizedRequestReceipts).toEqual([]);
  });

  it("validates and retains the maximum canonical live v1 read reserve without quadratic lock amplification", () => {
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 30 * 60_000).toISOString();
    const root = {
      challenges: [],
      challengeCriteriaVersions: [],
      challengeCriteriaQuarantine: [],
      contributions: [],
      ratings: [],
      agentFeedState: { ...emptyAgentFeedPersistedState(), schemaVersion: 1 as const },
    };
    const pairingState = emptyPairingPlatformState();
    const baseResponse = JSON.parse(JSON.stringify(validFeedListResponseFixture)) as AgentFeedListResponse;
    for (let index = 0; index < MAX_AGENT_FEED_RESPONSE_CACHE; index += 1) {
      const pairingId = `pairing_v1_scale_${Math.floor(index / MAX_AGENT_FEED_RESPONSE_CACHE_PER_PAIRING).toString().padStart(2, "0")}`;
      const requestId = `req_v1_scale_${index.toString().padStart(5, "0")}`;
      const requestHash = index.toString(16).padStart(64, "0");
      const cacheId = `cache_v1_scale_${index.toString().padStart(5, "0")}`;
      const response = { ...baseResponse, request_id: requestId, server_time: createdAt };
      root.agentFeedState.requestReceipts.push({
        pairingId,
        operation: "feed.list",
        requestId,
        requestHash,
        responseCacheId: cacheId,
        createdAt,
        expiresAt,
      });
      root.agentFeedState.responseCache.push({
        cacheId,
        pairingId,
        operation: "feed.list",
        requestId,
        response,
        serializedBytes: utf8JsonBytes(response),
        createdAt,
        expiresAt,
      });
      pairingState.authorizedRequestReceipts.push({ pairingId, operation: "feed.list", requestId, requestHash, createdAt, expiresAt });
    }

    const startedAt = performance.now();
    const migrated = migrateAgentFeedStateV2(root, pairingState, new Date(now.getTime() + 10 * 60_000));
    const elapsedMs = performance.now() - startedAt;
    expect(migrated.state.agentFeedState.requestReceipts).toHaveLength(MAX_AGENT_FEED_RESPONSE_CACHE);
    expect(migrated.state.agentFeedState.responseCache).toHaveLength(MAX_AGENT_FEED_RESPONSE_CACHE);
    expect(migrated.pairingState.authorizedRequestReceipts).toHaveLength(MAX_AGENT_FEED_RESPONSE_CACHE);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it("rejects cross-audience replay evidence, oversized cached responses, and aggregate snapshot overflow", () => {
    const root = {
      challenges: [],
      challengeCriteriaVersions: [],
      challengeCriteriaQuarantine: [],
      contributions: [],
      ratings: [],
      agentFeedState: emptyAgentFeedPersistedState(),
    };
    createAgentFeedTransaction(root, now).recordRequestResult({
      ...readReceiptTiming,
      pairingId: "pairing_audience_a",
      operation: "feed.list",
      requestId: "req_audience_a",
      requestHash: "1".repeat(64),
      responseCacheId: "cache_audience_a",
      response: { ...validFeedListResponseFixture, request_id: "req_audience_a" },
    });
    expect(hasReadyAgentFeedState(root)).toBe(true);
    const storedReadReceipt = root.agentFeedState.requestReceipts[0]!;
    const matchingPairingState = emptyPairingPlatformState();
    matchingPairingState.authorizedRequestReceipts.push({
      pairingId: storedReadReceipt.pairingId,
      requestId: storedReadReceipt.requestId,
      operation: storedReadReceipt.operation,
      requestHash: storedReadReceipt.requestHash,
      createdAt: storedReadReceipt.createdAt,
      expiresAt: storedReadReceipt.expiresAt,
    });
    expect(() => assertAgentProtocolStateCoherence(matchingPairingState, root, now)).not.toThrow();
    expect(() => assertAgentProtocolStateCoherence(matchingPairingState, root, new Date(now.getTime() + 31 * 60_000))).not.toThrow();
    const skewedExpiry = structuredClone(root);
    skewedExpiry.agentFeedState.requestReceipts[0]!.expiresAt = new Date(Date.parse(storedReadReceipt.expiresAt) + 1_000).toISOString();
    skewedExpiry.agentFeedState.responseCache[0]!.expiresAt = skewedExpiry.agentFeedState.requestReceipts[0]!.expiresAt;
    expect(() => assertAgentProtocolStateCoherence(matchingPairingState, skewedExpiry, now)).toThrow(AgentFeedStoreError);
    expect(() => assertAgentProtocolStateCoherence(emptyPairingPlatformState(), root, now)).toThrow(AgentFeedStoreError);
    const wrongPairingHash = structuredClone(matchingPairingState);
    wrongPairingHash.authorizedRequestReceipts[0]!.requestHash = "f".repeat(64);
    expect(() => assertAgentProtocolStateCoherence(wrongPairingHash, root, now)).toThrow(AgentFeedStoreError);

    const crossAudience = structuredClone(root);
    crossAudience.agentFeedState.responseCache[0]!.pairingId = "pairing_audience_b";
    expect(hasReadyAgentFeedState(crossAudience)).toBe(false);
    const orphanCache = structuredClone(root);
    orphanCache.agentFeedState.requestReceipts = [];
    expect(hasReadyAgentFeedState(orphanCache)).toBe(false);

    const exactSnapshotBound = emptyAgentFeedPersistedState();
    exactSnapshotBound.snapshots = Array.from({ length: 100 }, (_, snapshotIndex) => ({
      snapshotId: `snapshot_${snapshotIndex}`,
      filtersHash: "a".repeat(22),
      audienceHash: "b".repeat(22),
      challengeIds: Array.from({ length: 1_000 }, (_, challengeIndex) => `challenge_${snapshotIndex}_${challengeIndex}`),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    }));
    expect(exactSnapshotBound.snapshots.reduce((total, record) => total + record.challengeIds.length, 0)).toBe(MAX_AGENT_FEED_SNAPSHOT_IDS);
    expect(() => assertAgentFeedPersistedStateV1(exactSnapshotBound)).not.toThrow();
    exactSnapshotBound.snapshots.push({
      snapshotId: "snapshot_overflow",
      filtersHash: "a".repeat(22),
      audienceHash: "b".repeat(22),
      challengeIds: ["challenge_overflow"],
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    });
    expect(() => assertAgentFeedPersistedStateV1(exactSnapshotBound)).toThrow(AgentFeedStoreError);

    const oversizedGrant = emptyAgentFeedPersistedState();
    oversizedGrant.runGrants.push({
      grantId: "grant_output_overflow",
      nonceHash: "2".repeat(64),
      pairingId: "pairing_output_overflow",
      requestId: "req_output_overflow",
      challengeId: "challenge_output_overflow",
      challengeRevision: 1,
      requestClass: "challenge_contribution",
      promptVersion: "cmai-contribution-card-v1",
      maxOutputBytes: 256 * 1024 + 1,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    });
    expect(() => assertAgentFeedPersistedStateV1(oversizedGrant)).toThrow(AgentFeedStoreError);

    const danglingContribution = emptyAgentFeedPersistedState();
    const acceptedAt = new Date(now.getTime() + 1_000).toISOString();
    const persistedCard = {
      ...(JSON.parse(JSON.stringify(validContributionSubmitRequestFixture.payload.card)) as Contribution["card"]),
      challenge_id: "challenge_dangling_contribution",
    };
    danglingContribution.runGrants.push({
      grantId: "grant_dangling_contribution",
      nonceHash: "6".repeat(64),
      pairingId: "pairing_dangling_contribution",
      requestId: "req_grant_dangling_contribution",
      challengeId: "challenge_dangling_contribution",
      challengeRevision: 1,
      requestClass: "challenge_contribution",
      promptVersion: "cmai-contribution-card-v1",
      maxOutputBytes: 64 * 1024,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
      consumedAt: acceptedAt,
      submissionId: "submission_dangling_contribution",
    });
    danglingContribution.submissionReceipts.push({
      pairingId: "pairing_dangling_contribution",
      challengeId: "challenge_dangling_contribution",
      challengeRevision: 1,
      criteriaStatusAtSubmission: "confirmed",
      idempotencyKeyHash: "7".repeat(64),
      payloadIdentity: "canonical_payload_v1",
      payloadHash: "8".repeat(64),
      cardHash: hashAgentProtocolPayload(persistedCard),
      nonceHash: "6".repeat(64),
      submissionId: "submission_dangling_contribution",
      contributionId: "contribution_missing",
      acceptedAt,
      expiresAt: new Date(Date.parse(acceptedAt) + 30 * 24 * 60 * 60_000).toISOString(),
    });
    danglingContribution.submissionRequestReceipts.push({
      pairingId: "pairing_dangling_contribution",
      requestId: "req_submit_dangling_contribution",
      requestHash: "9".repeat(64),
      outcome: { kind: "submission", submissionId: "submission_dangling_contribution" },
      createdAt: acceptedAt,
      expiresAt: new Date(Date.parse(acceptedAt) + 30 * 24 * 60 * 60_000).toISOString(),
    });
    const validContribution: Contribution = {
      id: "contribution_missing",
      challengeId: "challenge_dangling_contribution",
      contributorId: "pairing_dangling_contribution",
      contributorKind: "agent",
      contributorLabel: "Persisted Agent",
      createdAt: acceptedAt,
      status: "posted",
      externallyGenerated: true,
      card: persistedCard,
      communityScore: 0,
      criteriaVersion: 1,
      criteriaStatusAtSubmission: "confirmed",
    };
    expect(hasReadyAgentFeedState({ agentFeedState: danglingContribution, contributions: [] })).toBe(false);
    expect(hasReadyAgentFeedState({ agentFeedState: danglingContribution, contributions: [validContribution] })).toBe(true);
    expect(() => assertAgentFeedPersistedRootV1({ agentFeedState: danglingContribution, contributions: [{ ...validContribution, challengeId: "challenge_other" }] })).toThrow(AgentFeedStoreError);
    expect(() => assertAgentFeedPersistedRootV1({ agentFeedState: danglingContribution, contributions: [{ ...validContribution, contributorId: "pairing_other" }] })).toThrow(AgentFeedStoreError);
    expect(() => assertAgentFeedPersistedRootV1({ agentFeedState: danglingContribution, contributions: [{ ...validContribution, card: { ...persistedCard, challenge_id: "challenge_other" } }] })).toThrow(AgentFeedStoreError);
    expect(() => assertAgentFeedPersistedRootV1({ agentFeedState: danglingContribution, contributions: [validContribution, validContribution] })).toThrow(AgentFeedStoreError);
    const wrongCardHash = structuredClone(danglingContribution);
    wrongCardHash.submissionReceipts[0]!.cardHash = "9".repeat(64);
    expect(() => assertAgentFeedPersistedRootV1({ agentFeedState: wrongCardHash, contributions: [validContribution] })).toThrow(AgentFeedStoreError);

    const oversizedResponse = JSON.parse(JSON.stringify(validFeedListResponseFixture)) as AgentFeedListResponse;
    oversizedResponse.request_id = "req_oversized_cache";
    const summary = oversizedResponse.result.challenges[0]!;
    oversizedResponse.result.challenges = Array.from({ length: 7 }, (_, index) => ({
      ...summary,
      challenge_id: `challenge_oversized_${index}`,
      summary: "x".repeat(40_000),
    }));
    const oversizedCache = emptyAgentFeedPersistedState();
    oversizedCache.responseCache.push({
      cacheId: "cache_oversized",
      pairingId: "pairing_oversized",
      operation: "feed.list",
      requestId: oversizedResponse.request_id,
      response: oversizedResponse,
      serializedBytes: utf8JsonBytes(oversizedResponse),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    });
    oversizedCache.requestReceipts.push({
      pairingId: "pairing_oversized",
      operation: "feed.list",
      requestId: oversizedResponse.request_id,
      requestHash: "3".repeat(64),
      responseCacheId: "cache_oversized",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
    });
    expect(() => assertAgentFeedPersistedStateV1(oversizedCache)).toThrow(AgentFeedStoreError);
  });

  it("reports local readiness and keeps the standalone query read-only and fail-closed", () => {
    resetStoreForTests();
    expect(getAgentFeedStoreReadiness()).toEqual({ ready: true, schemaVersion: AGENT_FEED_STORE_SCHEMA_VERSION });
    createChallenge({ id: "challenge_query_low", visibility: "public", reward: 1, brief: brief("Query low") });
    createChallenge({ id: "challenge_query_high", visibility: "public", reward: 9, brief: brief("Query high") });
    expect(queryAgentFeed({ filters: { category: "security" }, limit: 1 })).toMatchObject({
      hasMore: true,
      challenges: [{ id: "challenge_query_high" }],
    });
    suppressChallenge("challenge_query_high", "test suppression");
    expect(queryAgentFeed({ filters: { category: "security" }, limit: 5 }).challenges.map((challenge) => challenge.id)).toEqual(["challenge_query_low"]);
  });

  it("creates stable bounded snapshots and excludes concurrent inserts from later pages", () => {
    resetStoreForTests();
    createChallenge({ id: "challenge_low", visibility: "public", reward: 1, brief: brief("Low") });
    createChallenge({ id: "challenge_mid", visibility: "public", reward: 2, brief: brief("Mid") });
    createChallenge({ id: "challenge_high", visibility: "public", reward: 3, brief: brief("High") });

    const first = withAgentFeedTransaction((transaction) => transaction.listPage({
      filters: { category: "security", requested_modes: ["critique"] },
      filtersHash: "a".repeat(22),
      audienceHash: "b".repeat(22),
      limit: 2,
      snapshotId: "snapshot_stable_1",
    }), now);
    expect(first.challenges.map((challenge) => challenge.id)).toEqual(["challenge_high", "challenge_mid"]);
    expect(first.resumeOffsets).toEqual([1, 2]);
    expect(first.nextOffset).toBe(2);

    createChallenge({ id: "challenge_new", visibility: "public", reward: 99, brief: brief("New") });
    const second = withAgentFeedTransaction((transaction) => transaction.listPage({
      filters: { category: "security", requested_modes: ["critique"] },
      filtersHash: "a".repeat(22),
      audienceHash: "b".repeat(22),
      limit: 2,
      snapshotId: first.snapshotId,
      offset: first.nextOffset,
    }), new Date(now.getTime() + 1_000));
    expect(second.challenges.map((challenge) => challenge.id)).toEqual(["challenge_low"]);
    expect(second.resumeOffsets).toEqual([3]);
    expect(second.challenges.map((challenge) => challenge.id)).not.toContain("challenge_new");

    expect(() => withAgentFeedTransaction((transaction) => transaction.listPage({
      filters: { category: "security", requested_modes: ["critique"] },
      filtersHash: "a".repeat(22),
      audienceHash: "c".repeat(22),
      limit: 2,
      snapshotId: first.snapshotId,
      offset: first.nextOffset,
    }), new Date(now.getTime() + 2_000))).toThrow("snapshot is invalid");
  });

  it("stores request hashes separately from bounded public response cache and rejects conflicts", () => {
    resetStoreForTests();
    const input = {
      ...readReceiptTiming,
      pairingId: "pairing_store_1",
      operation: "feed.list" as const,
      requestId: "req_store_feed_1",
      requestHash: "b".repeat(64),
    };
    withAgentFeedTransaction((transaction) => {
      expect(transaction.lookupRequest(input)).toEqual({ kind: "none" });
      transaction.recordRequestResult({
        ...input,
        responseCacheId: "cache_store_feed_1",
        response: { ...validFeedListResponseFixture, request_id: input.requestId },
      });
      expect(transaction.lookupRequest(input)).toMatchObject({ kind: "exact" });
      expect(transaction.lookupRequest({ ...input, requestHash: "c".repeat(64) })).toEqual({ kind: "conflict" });
    }, now);

    const root = {
      challenges: [],
      challengeCriteriaVersions: [],
      challengeCriteriaQuarantine: [],
      contributions: [],
      ratings: [],
      agentFeedState: emptyAgentFeedPersistedState(),
    };
    createAgentFeedTransaction(root, now).recordRequestResult({
      ...input,
      responseCacheId: "cache_privacy_1",
      response: { ...validFeedListResponseFixture, request_id: input.requestId },
    });
    expect(Object.keys(root.agentFeedState.requestReceipts[0]).sort()).toEqual([
      "createdAt", "expiresAt", "operation", "pairingId", "requestHash", "requestId", "responseCacheId",
    ].sort());
    expect(JSON.stringify(root.agentFeedState.requestReceipts)).not.toContain("raw-query-or-signature");
    expect(root.agentFeedState.responseCache[0].serializedBytes).toBeGreaterThan(0);
  });

  it("keeps read replay capacity fair by pairing across count and byte ceilings", () => {
    const countRoot = {
      challenges: [],
      challengeCriteriaVersions: [],
      challengeCriteriaQuarantine: [],
      contributions: [],
      ratings: [],
      agentFeedState: emptyAgentFeedPersistedState(),
    };
    const countTransaction = createAgentFeedTransaction(countRoot, now);
    const recordSmall = (pairingId: string, index: number) => {
      const suffix = index.toString().padStart(4, "0");
      const requestId = `req_fair_count_${suffix}`;
      const response = JSON.parse(JSON.stringify(validFeedListResponseFixture)) as AgentFeedListResponse;
      response.request_id = requestId;
      return countTransaction.recordRequestResult({
        ...readReceiptTiming,
        pairingId,
        operation: "feed.list",
        requestId,
        requestHash: hashAgentProtocolPayload({ pairingId, requestId }),
        responseCacheId: `cache_fair_count_${suffix}_${pairingId}`,
        response,
      });
    };
    for (let index = 0; index < MAX_AGENT_FEED_RESPONSE_CACHE_PER_PAIRING; index += 1) {
      recordSmall("pairing_fair_attacker", index);
    }
    expect(() => recordSmall("pairing_fair_attacker", 0)).not.toThrow();
    expect(() => recordSmall("pairing_fair_attacker", MAX_AGENT_FEED_RESPONSE_CACHE_PER_PAIRING))
      .toThrow("This pairing's Agent feed response-cache capacity is exhausted.");
    expect(() => recordSmall("pairing_fair_second", MAX_AGENT_FEED_RESPONSE_CACHE_PER_PAIRING + 1)).not.toThrow();

    const corruptedCountRoot = structuredClone(countRoot);
    const countReceipt = corruptedCountRoot.agentFeedState.requestReceipts[0];
    const countCache = corruptedCountRoot.agentFeedState.responseCache[0];
    corruptedCountRoot.agentFeedState.requestReceipts.push({
      ...countReceipt,
      requestId: "req_fair_count_corrupt",
      requestHash: "c".repeat(64),
      responseCacheId: "cache_fair_count_corrupt",
    });
    corruptedCountRoot.agentFeedState.responseCache.push({
      ...countCache,
      requestId: "req_fair_count_corrupt",
      cacheId: "cache_fair_count_corrupt",
      response: JSON.parse(JSON.stringify({ ...validFeedListResponseFixture, request_id: "req_fair_count_corrupt" })) as AgentFeedListResponse,
    });
    expect(() => assertAgentFeedPersistedRootV1(corruptedCountRoot)).toThrow("malformed or violates persisted invariants");

    const byteRoot = {
      challenges: [],
      challengeCriteriaVersions: [],
      challengeCriteriaQuarantine: [],
      contributions: [],
      ratings: [],
      agentFeedState: emptyAgentFeedPersistedState(),
    };
    const byteTransaction = createAgentFeedTransaction(byteRoot, now);
    const chunk = "x".repeat(40_000);
    const largeResponse = structuredClone(validChallengeGetResponseFixture) as unknown as AgentChallengeGetResponse;
    largeResponse.result.challenge.content = {
      problem_statement: chunk,
      original_ai_answer: chunk,
      context: chunk,
      constraints: [chunk],
      success_criteria: [chunk],
      assumptions_to_test: [chunk],
      claims_to_check: [chunk],
      known_risks: [chunk],
      useful_response_should_address: [chunk],
      missing_information: [chunk],
    };
    const probeRequestId = "req_fair_bytes_0000";
    largeResponse.request_id = probeRequestId;
    const largeResponseBytes = utf8JsonBytes(largeResponse);
    const allowedLargeResponses = Math.floor(MAX_AGENT_FEED_RESPONSE_CACHE_BYTES_PER_PAIRING / largeResponseBytes);
    expect(allowedLargeResponses).toBeGreaterThan(1);
    const recordLarge = (pairingId: string, index: number) => {
      const suffix = index.toString().padStart(4, "0");
      const requestId = `req_fair_bytes_${suffix}`;
      return byteTransaction.recordRequestResult({
        ...readReceiptTiming,
        pairingId,
        operation: "challenge.get",
        requestId,
        requestHash: hashAgentProtocolPayload({ pairingId, requestId }),
        responseCacheId: `cache_fair_bytes_${suffix}_${pairingId}`,
        response: { ...largeResponse, request_id: requestId },
      });
    };
    for (let index = 0; index < allowedLargeResponses; index += 1) {
      recordLarge("pairing_fair_attacker", index);
    }
    expect(() => recordLarge("pairing_fair_attacker", 0)).not.toThrow();
    expect(() => recordLarge("pairing_fair_attacker", allowedLargeResponses))
      .toThrow("This pairing's Agent feed response-cache capacity is exhausted.");
    expect(() => recordLarge("pairing_fair_second", allowedLargeResponses + 1)).not.toThrow();
  });

  it("returns the original challenge response on exact signed-request replay without minting another grant", () => {
    resetStoreForTests();
    createChallenge({ id: "challenge_replay_1", visibility: "public", reward: 4, brief: brief("Replay") });
    let issueAttempts = 0;
    const execute = (nonce: string) => transactAgentFeedRequest({
      ...readReceiptTiming,
      pairingId: "pairing_store_1",
      operation: "challenge.get",
      requestId: "req_challenge_replay_1",
      requestHash: "f".repeat(64),
      responseCacheId: "cache_challenge_replay_1",
    }, (transaction) => {
      issueAttempts += 1;
      const issued = transaction.issueRunGrant({
        grantId: "grant_replay_1",
        pairingId: "pairing_store_1",
        requestId: "req_challenge_replay_1",
        challengeId: "challenge_replay_1",
        challengeRevision: 1,
        nonceHash: "1".repeat(64),
        promptVersion: "cmai-prompt-v1",
        maxOutputBytes: 64 * 1024,
        expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
      });
      expect(issued.kind).toBe("issued");
      const response = JSON.parse(JSON.stringify({
        ...validChallengeGetResponseFixture,
        request_id: "req_challenge_replay_1",
        server_time: now.toISOString(),
        result: {
          challenge: {
            ...validChallengeGetResponseFixture.result.challenge,
            challenge_id: "challenge_replay_1",
            run_grant: {
              ...validChallengeGetResponseFixture.result.challenge.run_grant,
              run_nonce: nonce,
              issued_at: now.toISOString(),
              expires_at: new Date(now.getTime() + 10 * 60_000).toISOString(),
            },
          },
        },
      })) as AgentChallengeGetResponse;
      return response;
    }, now).response;

    const original = execute("nonce_original_123456789012345678901234");
    const replayed = execute("nonce_must_not_be_issued_123456");
    expect(replayed).toEqual(original);
    expect(issueAttempts).toBe(1);
  });

  it("caches strict domain-error envelopes so exact replays do not rerun failed execution", () => {
    resetStoreForTests();
    let attempts = 0;
    const execute = () => transactAgentFeedRequest({
      ...readReceiptTiming,
      pairingId: "pairing_store_1",
      operation: "challenge.get",
      requestId: "req_challenge_missing_1",
      requestHash: "9".repeat(64),
      responseCacheId: "cache_challenge_missing_1",
    }, () => {
      attempts += 1;
      return {
        protocol: "CMAI_AGENT_PROTOCOL_V1",
        protocol_version: "1.2",
        request_id: "req_challenge_missing_1",
        server_time: now.toISOString(),
        error: {
          code: "challenge_unavailable",
          message: "Challenge is unavailable.",
          retryable: false,
        },
      };
    }, now);

    expect(execute()).toMatchObject({ replayed: false, response: { error: { code: "challenge_unavailable" } } });
    expect(execute()).toMatchObject({ replayed: true, response: { error: { code: "challenge_unavailable" } } });
    expect(attempts).toBe(1);
  });

  it("atomically issues, binds, consumes, and replays one-run grants with contribution acceptance", () => {
    resetStoreForTests();
    createChallenge({ id: "challenge_grant_1", visibility: "public", reward: 4, brief: brief("Grant") });
    const challenge = getChallenge("challenge_grant_1");
    expect(challenge?.activeCriteriaVersion).toBe(1);
    const card = {
      ...(JSON.parse(JSON.stringify(validContributionSubmitRequestFixture.payload.card)) as Contribution["card"]),
      challenge_id: "challenge_grant_1",
    };
    const cardHash = hashAgentProtocolPayload(card);

    const issued = withAgentFeedTransaction((transaction) => transaction.issueRunGrant({
      grantId: "grant_store_1",
      pairingId: "pairing_store_1",
      requestId: "req_grant_1",
      challengeId: "challenge_grant_1",
      challengeRevision: 1,
      nonceHash: "2".repeat(64),
      promptVersion: "cmai-prompt-v1",
      maxOutputBytes: 64 * 1024,
      expiresAt: new Date(now.getTime() + 10 * 60_000).toISOString(),
    }), now);
    expect(issued.kind).toBe("issued");

    const accepted = submitAgentFeedContribution({
      ...submissionReceiptTiming,
      pairingId: "pairing_store_1",
      requestId: "req_submit_store_1",
      challengeId: "challenge_grant_1",
      challengeRevision: 1,
      nonceHash: "2".repeat(64),
      idempotencyKeyHash: "3".repeat(64),
      requestHash: "d".repeat(64),
      payloadHash: "e".repeat(64),
      cardHash,
      submissionId: "submission_store_1",
      contributionId: "contribution_grant_1",
      contributorId: "pairing_store_1",
      contributorKind: "agent",
      contributorLabel: "Paired Agent",
      card,
      externallyGenerated: true,
      acceptedAt: new Date(now.getTime() + 1_000).toISOString(),
    }, new Date(now.getTime() + 1_000));
    expect(accepted).toMatchObject({ kind: "accepted", replayed: false });

    const replay = submitAgentFeedContribution({
      ...submissionReceiptTiming,
      pairingId: "pairing_store_1",
      requestId: "req_submit_store_1",
      challengeId: "challenge_grant_1",
      challengeRevision: 1,
      nonceHash: "2".repeat(64),
      idempotencyKeyHash: "3".repeat(64),
      requestHash: "d".repeat(64),
      payloadHash: "e".repeat(64),
      cardHash,
      submissionId: "submission_ignored",
      contributionId: "contribution_ignored",
      contributorId: "pairing_store_1",
      contributorKind: "agent",
      contributorLabel: "Paired Agent",
      card,
      externallyGenerated: true,
      acceptedAt: new Date(now.getTime() + 2_000).toISOString(),
    }, new Date(now.getTime() + 2_000));
    expect(replay).toMatchObject({ kind: "replayed", submissionId: "submission_store_1", contribution: { id: "contribution_grant_1" }, requestReplayed: true });

    const aliasAuthorizedAt = new Date(now.getTime() + 3_000);
    const freshRequestReplay = submitAgentFeedContribution({
      requestAuthorizedAt: aliasAuthorizedAt.toISOString(),
      requestReceiptExpiresAt: new Date(aliasAuthorizedAt.getTime() + 30 * 24 * 60 * 60_000).toISOString(),
      pairingId: "pairing_store_1",
      requestId: "req_submit_store_2",
      challengeId: "challenge_grant_1",
      challengeRevision: 1,
      nonceHash: "2".repeat(64),
      idempotencyKeyHash: "3".repeat(64),
      requestHash: "f".repeat(64),
      payloadHash: "e".repeat(64),
      cardHash,
      submissionId: "submission_alias_ignored",
      contributionId: "contribution_alias_ignored",
      contributorId: "pairing_store_1",
      contributorKind: "agent",
      contributorLabel: "Paired Agent",
      card,
      externallyGenerated: true,
      acceptedAt: aliasAuthorizedAt.toISOString(),
    }, aliasAuthorizedAt);
    expect(freshRequestReplay).toMatchObject({
      kind: "replayed",
      replayed: true,
      requestReplayed: false,
      submissionId: "submission_store_1",
      contribution: { id: "contribution_grant_1" },
    });
  });

  it("persists and exactly replays terminal submission outcomes without re-executing business logic", () => {
    resetStoreForTests();
    createChallenge({ id: "challenge_terminal_1", visibility: "public", reward: 2, brief: brief("Terminal replay") });
    const card = {
      ...(JSON.parse(JSON.stringify(validContributionSubmitRequestFixture.payload.card)) as Contribution["card"]),
      challenge_id: "challenge_terminal_1",
    };
    const input = {
      ...submissionReceiptTiming,
      pairingId: "pairing_terminal_1",
      requestId: "req_terminal_1",
      challengeId: "challenge_terminal_1",
      challengeRevision: 1,
      nonceHash: "a".repeat(64),
      idempotencyKeyHash: "b".repeat(64),
      requestHash: "c".repeat(64),
      payloadHash: "d".repeat(64),
      cardHash: hashAgentProtocolPayload(card),
      submissionId: "submission_terminal_unused",
      contributionId: "contribution_terminal_unused",
      contributorId: "pairing_terminal_1",
      contributorKind: "agent" as const,
      contributorLabel: "Paired Agent",
      card,
      externallyGenerated: true,
      acceptedAt: new Date(now.getTime() + 1_000).toISOString(),
    };

    expect(submitAgentFeedContribution(input, new Date(now.getTime() + 1_000))).toEqual({
      kind: "run_nonce_unknown",
      requestReplayed: false,
    });
    expect(submitAgentFeedContribution(input, new Date(now.getTime() + 2_000))).toEqual({
      kind: "run_nonce_unknown",
      requestReplayed: true,
    });
  });

  it("rejects malformed or overlong run-grant expiry at the authoritative transaction seam", () => {
    resetStoreForTests();
    createChallenge({ id: "challenge_grant_ttl", visibility: "public", reward: 4, brief: brief("Grant TTL") });
    const issue = (expiresAt: string, suffix: string) => withAgentFeedTransaction((transaction) => transaction.issueRunGrant({
      grantId: `grant_ttl_${suffix}`,
      pairingId: "pairing_store_1",
      requestId: `req_ttl_${suffix}`,
      challengeId: "challenge_grant_ttl",
      challengeRevision: 1,
      nonceHash: suffix.repeat(64).slice(0, 64),
      promptVersion: "cmai-prompt-v1",
      maxOutputBytes: 64 * 1024,
      expiresAt,
    }), now);

    expect(issue(new Date(now.getTime() + 10 * 60_000 + 1).toISOString(), "a").kind).toBe("challenge_unavailable");
    expect(issue("not-a-date", "b").kind).toBe("challenge_unavailable");
    expect(issue(new Date(now.getTime() + 10 * 60_000).toISOString(), "c").kind).toBe("issued");
  });

  it("rolls back local transaction mutations when the operation throws", () => {
    resetStoreForTests();
    createChallenge({ id: "challenge_rollback_1", visibility: "public", reward: 1, brief: brief("Rollback") });
    expect(() => withAgentFeedTransaction((transaction) => {
      expect(transaction.issueRunGrant({
        grantId: "grant_rollback_1",
        pairingId: "pairing_store_1",
        requestId: "req_rollback_1",
        challengeId: "challenge_rollback_1",
        challengeRevision: 1,
        nonceHash: "4".repeat(64),
        promptVersion: "cmai-prompt-v1",
        maxOutputBytes: 64 * 1024,
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      }).kind).toBe("issued");
      throw new Error("rollback");
    }, now)).toThrow("rollback");

    const retried = withAgentFeedTransaction((transaction) => transaction.issueRunGrant({
      grantId: "grant_rollback_2",
      pairingId: "pairing_store_1",
      requestId: "req_rollback_2",
      challengeId: "challenge_rollback_1",
      challengeRevision: 1,
      nonceHash: "4".repeat(64),
      promptVersion: "cmai-prompt-v1",
      maxOutputBytes: 64 * 1024,
      expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    }), now);
    expect(retried.kind).toBe("issued");
  });
});
