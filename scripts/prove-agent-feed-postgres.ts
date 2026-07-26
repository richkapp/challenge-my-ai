import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import postgres from "postgres";
import {
  AGENT_FEED_STATE_V1_MIGRATION_ID,
  AGENT_FEED_STATE_V1_SQL,
} from "@/db/migrations/agent-feed-state-v1";
import { AGENT_FEED_STATE_V2_MIGRATION_ID } from "@/db/migrations/agent-feed-state-v2";
import { AGENT_PAIRING_STATE_V1_MIGRATION_ID, AGENT_PAIRING_STATE_V1_SQL } from "@/db/migrations/agent-pairing-state-v1";
import {
  applyAgentProtocolStateV1,
  rollbackAgentProtocolStateV1,
} from "@/db/migrations/agent-protocol-state-v1";
import { validChallengeGetResponseFixture, validContributionSubmitRequestFixture, validFeedListResponseFixture } from "@/lib/agent-protocol/fixtures";
import { hashAgentProtocolPayload } from "@/lib/agent-protocol/canonical";
import {
  agentChallengeGetRequestSchema,
  agentChallengeGetResponseSchema,
  agentContributionSubmitRequestSchema,
  agentFeedListRequestSchema,
} from "@/lib/agent-protocol/schemas";
import { AgentFeedProjectionError, utf8JsonBytes } from "@/lib/agent-feed/egress";
import { AgentFeedProtocolService } from "@/lib/agent-feed/service";
import {
  PairingService,
  type PairingAuthorizationContext,
  agentFeedNetworkPreauthRateLimit,
  authenticatedAgentOperationRateLimits,
} from "@/lib/agent-pairing/service";
import { PostgresPairingStateBackend, emptyPairingPlatformState } from "@/lib/agent-pairing/storage";
import { generatePairingTestKey, pairCreateRequest, signedPairingRequest } from "@/lib/agent-pairing/testUtils";
import {
  AGENT_FEED_SUBMISSION_RETENTION_MS,
  MAX_AGENT_FEED_RESPONSE_CACHE_BYTES_PER_PAIRING,
  MAX_AGENT_FEED_RESPONSE_CACHE_PER_PAIRING,
  emptyAgentFeedPersistedState,
  type AgentFeedRequestExecutor,
  type AgentFeedRequestTransactionInput,
  type AgentFeedSubmissionInput,
  type AgentFeedTransactionalStore,
  type AgentFeedTransactionRoot,
} from "@/lib/store/agentFeed";
import { transactAgentFeedRequest as transactPostgresAgentFeedRequest } from "@/lib/store/postgres";
import type { ChallengeBrief, ContributionCard } from "@/lib/types";

const databaseUrl = process.env.DATABASE_URL || "";
const allowReset = process.env.CMAI_AGENT_FEED_PROOF_ALLOW_RESET === "1";
if (!databaseUrl || !allowReset) {
  throw new Error("Set DATABASE_URL and CMAI_AGENT_FEED_PROOF_ALLOW_RESET=1 for the disposable Postgres proof.");
}
const parsedUrl = new URL(databaseUrl);
if (!["127.0.0.1", "localhost", "::1"].includes(parsedUrl.hostname)) {
  throw new Error("Agent feed Postgres proof refuses non-loopback databases.");
}
const databaseName = parsedUrl.pathname.replace(/^\//, "");
if (!databaseName.startsWith("cmai_agent_feed_proof_")) {
  throw new Error("Agent feed Postgres proof requires a disposable cmai_agent_feed_proof_* database.");
}

const admin = postgres(databaseUrl, { max: 2, prepare: false });
const firstClient = postgres(databaseUrl, { max: 1, prepare: false });
const secondClient = postgres(databaseUrl, { max: 1, prepare: false });

function brief(title: string, bodySize = 0): ChallengeBrief {
  const body = bodySize > 0 ? "x".repeat(Math.min(bodySize, 4_000)) : undefined;
  const standardList = body ? Array.from({ length: 8 }, (_, index) => `${index}`.padEnd(200, "x")) : undefined;
  const successList = body ? Array.from({ length: 5 }, (_, index) => `${index}`.padEnd(240, "x")) : undefined;
  return {
    schema_version: "1.0",
    title,
    category: "security",
    challenge_mode_requested: ["critique"],
    problem_statement: body ?? `Problem ${title}`,
    original_ai_answer: body ?? `Answer ${title}`,
    context: body ?? `Context ${title}`,
    constraints: standardList ?? [],
    success_criteria: successList ?? ["Find the flaw", "Verify the evidence"],
    assumptions_to_test: standardList ?? [],
    claims_to_check: standardList ?? [],
    known_risks: standardList ?? [],
    what_a_useful_response_should_address: standardList ?? ["Evidence"],
    privacy_sensitivity: "public_ok",
    redactions_made: [],
    abuse_or_safety_flags: [],
    missing_information: standardList ?? [],
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
      success_criteria: successList ?? ["Find the flaw", "Verify the evidence"],
      successful_outcomes: ["review_complete"],
      change_reason: "Disposable Postgres proof criteria.",
    }],
    reward_posture: {
      basis: "poster_confirmed_impact",
      funding_state: "declarative_only",
      eligible_impact_tiers: ["signal", "useful", "material", "decisive"],
      completion_bonus: "not_applicable",
    },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitForProof(label: string, predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

let store: typeof import("@/lib/store/postgres") | undefined;
let firstPairingBackend: PostgresPairingStateBackend | undefined;
let secondPairingBackend: PostgresPairingStateBackend | undefined;
let restartedPairingBackend: PostgresPairingStateBackend | undefined;
try {
  store = await import("@/lib/store/postgres");

  await admin.unsafe("DROP TABLE IF EXISTS cmai_agent_pairing_state");
  await admin.unsafe("DROP TABLE IF EXISTS cmai_schema_migrations");
  await admin.unsafe("DROP TABLE IF EXISTS cmai_state");
  firstPairingBackend = new PostgresPairingStateBackend(databaseUrl);
  await assert.rejects(firstPairingBackend.read(), "pairing reads must fail before explicit migration");
  const pairingTableAfterRead = await admin`SELECT to_regclass('public.cmai_agent_pairing_state') AS table_name`;
  assert.equal(pairingTableAfterRead[0]?.table_name, null, "pairing read must not create its state table");

  assert.deepEqual(await store.getAgentFeedStoreReadiness(), { ready: false, reason: "state_table_missing" });
  const tableAfterRead = await admin`SELECT to_regclass('public.cmai_state') AS table_name`;
  assert.equal(tableAfterRead[0]?.table_name, null, "readiness check must not create the state table");

  await admin.unsafe("CREATE TABLE cmai_state (id text PRIMARY KEY, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())");
  await admin`INSERT INTO cmai_state (id, state) VALUES ('default', ${admin.json({})})`;
  assert.deepEqual(await store.getAgentFeedStoreReadiness(), { ready: false, reason: "migration_required" });

  await assert.rejects(
    applyAgentProtocolStateV1(admin, { testFailAfterMigrationId: AGENT_FEED_STATE_V1_MIGRATION_ID }),
    /Injected migration interruption/,
  );
  assert.equal((await admin`SELECT to_regclass('public.cmai_schema_migrations') AS table_name`)[0]?.table_name, null);
  assert.equal((await admin`SELECT to_regclass('public.cmai_agent_pairing_state') AS table_name`)[0]?.table_name, null);
  assert.deepEqual((await admin`SELECT state FROM cmai_state WHERE id = 'default'`)[0]?.state, {});

  await assert.rejects(
    applyAgentProtocolStateV1(admin, { testFailAfterMigrationId: AGENT_FEED_STATE_V2_MIGRATION_ID }),
    /Injected migration interruption after Agent feed state v2/,
  );
  assert.equal((await admin`SELECT to_regclass('public.cmai_schema_migrations') AS table_name`)[0]?.table_name, null);
  assert.equal((await admin`SELECT to_regclass('public.cmai_agent_pairing_state') AS table_name`)[0]?.table_name, null);
  assert.deepEqual((await admin`SELECT state FROM cmai_state WHERE id = 'default'`)[0]?.state, {});

  await admin`UPDATE cmai_state SET state = ${admin.json({ agentFeedState: { schemaVersion: 999 } })} WHERE id = 'default'`;
  await assert.rejects(applyAgentProtocolStateV1(admin), /Agent feed v1 state is malformed|Agent feed state is missing or incompatible/);
  assert.equal((await admin`SELECT to_regclass('public.cmai_agent_pairing_state') AS table_name`)[0]?.table_name, null, "incompatible feed state rolled back pairing DDL");
  await admin`UPDATE cmai_state SET state = ${admin.json({})} WHERE id = 'default'`;

  const migrationProbeNow = "2026-07-15T12:00:00.000Z";
  const danglingReplayState = emptyAgentFeedPersistedState();
  danglingReplayState.requestReceipts.push({
    pairingId: "pairing_dangling_migration",
    operation: "feed.list",
    requestId: "req_dangling_migration",
    requestHash: "a".repeat(64),
    responseCacheId: "cache_missing_migration",
    createdAt: migrationProbeNow,
    expiresAt: new Date(Date.parse(migrationProbeNow) + 30 * 60_000).toISOString(),
  });
  await admin`UPDATE cmai_state SET state = ${admin.json({ agentFeedState: danglingReplayState, contributions: [] })} WHERE id = 'default'`;
  await assert.rejects(
    () => applyAgentProtocolStateV1(admin),
    /malformed or violates persisted invariants|missing or incompatible/i,
    "deep Agent-feed reference corruption must block migration readiness",
  );
  assert.equal((await admin`SELECT to_regclass('public.cmai_agent_pairing_state') AS table_name`)[0]?.table_name, null, "deep readiness failure rolled back pairing DDL");
  await admin`UPDATE cmai_state SET state = ${admin.json({})} WHERE id = 'default'`;

  await admin.unsafe(AGENT_PAIRING_STATE_V1_SQL);
  await admin`INSERT INTO cmai_agent_pairing_state (id, state) VALUES ('unexpected-preexisting-row', ${admin.json({ schemaVersion: 1, codes: [], pairings: [], auditEvents: [], mutationReceipts: [], authorizedRequestReceipts: [], rateLimitBuckets: [] })})`;
  await assert.rejects(
    () => applyAgentProtocolStateV1(admin),
    /singleton default row/,
    "migration must reject a pre-existing pairing table with unexpected rows before ledger success",
  );
  assert.equal((await admin`SELECT to_regclass('public.cmai_schema_migrations') AS table_name`)[0]?.table_name, null, "rogue-row rejection must not record a migration ledger");
  await admin`DELETE FROM cmai_agent_pairing_state WHERE id = 'unexpected-preexisting-row'`;

  const firstApplied = await applyAgentProtocolStateV1(admin);
  assert.deepEqual(firstApplied, [AGENT_FEED_STATE_V1_MIGRATION_ID, AGENT_PAIRING_STATE_V1_MIGRATION_ID, AGENT_FEED_STATE_V2_MIGRATION_ID]);
  await admin`INSERT INTO cmai_agent_pairing_state (id, state) VALUES ('unexpected-proof-row', ${admin.json({ schemaVersion: 1, codes: [], pairings: [], auditEvents: [], mutationReceipts: [], authorizedRequestReceipts: [], rateLimitBuckets: [] })})`;
  await assert.rejects(rollbackAgentProtocolStateV1(admin), /unexpected rows/);
  assert.equal((await admin`SELECT COUNT(*)::int AS count FROM cmai_schema_migrations`)[0]?.count, 3, "refused rollback must preserve all migration rows");
  assert.equal((await admin`SELECT to_regclass('public.cmai_agent_pairing_state') AS table_name`)[0]?.table_name, "cmai_agent_pairing_state");
  await admin`DELETE FROM cmai_agent_pairing_state WHERE id = 'unexpected-proof-row'`;
  assert.deepEqual(await rollbackAgentProtocolStateV1(admin), [AGENT_FEED_STATE_V1_MIGRATION_ID, AGENT_PAIRING_STATE_V1_MIGRATION_ID, AGENT_FEED_STATE_V2_MIGRATION_ID]);
  assert.equal((await admin`SELECT to_regclass('public.cmai_agent_pairing_state') AS table_name`)[0]?.table_name, null);
  assert.deepEqual((await admin`SELECT migration_id FROM cmai_schema_migrations`), []);
  assert.deepEqual((await admin`SELECT state FROM cmai_state WHERE id = 'default'`)[0]?.state, {});

  await admin.unsafe(AGENT_PAIRING_STATE_V1_SQL);
  await admin.unsafe(AGENT_FEED_STATE_V1_SQL);
  const migrationOverflowNow = new Date();
  const migrationOverflowExpiresAt = new Date(migrationOverflowNow.getTime() + 30 * 60_000).toISOString();
  const migrationRetainedCreatedAt = new Date(migrationOverflowNow.getTime() + 1_000);
  const migrationRetainedExpiresAt = new Date(migrationRetainedCreatedAt.getTime() + 30 * 60_000).toISOString();
  const migrationOverflowFeedState = { ...emptyAgentFeedPersistedState(), schemaVersion: 1 as const };
  const migrationOverflowPairingState = (await admin`SELECT state FROM cmai_agent_pairing_state WHERE id = 'default'`)[0]?.state as Awaited<ReturnType<PostgresPairingStateBackend["read"]>>;
  for (const [pairingId, key] of [
    ["pairing_pg_v1_drain_attacker", generatePairingTestKey("key_pg_v1_drain_attacker")],
    ["pairing_pg_v1_drain_retained", generatePairingTestKey("key_pg_v1_drain_retained")],
  ] as const) {
    migrationOverflowPairingState.pairings.push({
      pairingId,
      ownerId: `owner_${pairingId}`,
      device: {
        deviceId: `device_${pairingId}`,
        displayName: pairingId,
        runtime: "hermes",
        adapterName: "postgres-proof",
        adapterVersion: "1.0.0",
      },
      status: "active",
      grantedScopes: ["challenge:read", "challenge:run", "contribution:submit", "pairing:manage"],
      keys: [{
        keyId: key.keyId,
        algorithm: "ed25519",
        generation: 1,
        publicKey: key.publicKey,
        status: "active",
        activatedAt: migrationOverflowNow.toISOString(),
      }],
      createdAt: migrationOverflowNow.toISOString(),
      updatedAt: migrationOverflowNow.toISOString(),
    });
  }
  const appendMigrationRead = (pairingId: string, index: number, createdAt: string, expiresAt: string) => {
    const requestId = `req_pg_v1_drain_${index.toString().padStart(4, "0")}`;
    const requestHash = index.toString(16).padStart(64, "0");
    const response = JSON.parse(JSON.stringify(validFeedListResponseFixture));
    response.request_id = requestId;
    response.server_time = createdAt;
    migrationOverflowFeedState.requestReceipts.push({
      pairingId,
      operation: "feed.list",
      requestId,
      requestHash,
      responseCacheId: `cache_pg_v1_drain_${index.toString().padStart(4, "0")}`,
      createdAt,
      expiresAt,
    });
    migrationOverflowFeedState.responseCache.push({
      cacheId: `cache_pg_v1_drain_${index.toString().padStart(4, "0")}`,
      pairingId,
      operation: "feed.list",
      requestId,
      response,
      serializedBytes: utf8JsonBytes(response),
      createdAt,
      expiresAt,
    });
    migrationOverflowPairingState.authorizedRequestReceipts.push({
      pairingId,
      operation: "feed.list",
      requestId,
      requestHash,
      createdAt,
      expiresAt,
    });
  };
  for (let index = 0; index < 501; index += 1) {
    appendMigrationRead("pairing_pg_v1_drain_attacker", index, migrationOverflowNow.toISOString(), migrationOverflowExpiresAt);
  }
  appendMigrationRead("pairing_pg_v1_drain_retained", 501, migrationRetainedCreatedAt.toISOString(), migrationRetainedExpiresAt);
  const migrationOverflowRoot = {
    ...((await admin`SELECT state FROM cmai_state WHERE id = 'default'`)[0]?.state as Record<string, unknown>),
    agentFeedState: migrationOverflowFeedState,
  };
  await admin`UPDATE cmai_state SET state = ${admin.json(migrationOverflowRoot)} WHERE id = 'default'`;
  await admin`UPDATE cmai_agent_pairing_state SET state = ${admin.json(migrationOverflowPairingState)} WHERE id = 'default'`;
  const countFeedBeforeRefusal = structuredClone(migrationOverflowRoot);
  const countPairingBeforeRefusal = structuredClone(migrationOverflowPairingState);
  await assert.rejects(
    () => applyAgentProtocolStateV1(admin),
    /requires read-cache drain.*retry after/u,
    "live v1 per-pair overflow must fail with an explicit drain diagnostic",
  );
  assert.deepEqual((await admin`SELECT state FROM cmai_state WHERE id = 'default'`)[0]?.state, countFeedBeforeRefusal);
  assert.deepEqual((await admin`SELECT state FROM cmai_agent_pairing_state WHERE id = 'default'`)[0]?.state, countPairingBeforeRefusal);
  assert.deepEqual((await admin`SELECT migration_id FROM cmai_schema_migrations`), [], "drain refusal must not record migration success");
  const corruptCreatedAt = new Date(migrationOverflowNow.getTime() - 31 * 60_000).toISOString();
  const corruptExpiresAt = new Date(migrationOverflowNow.getTime() - 60_000).toISOString();
  const corruptResponse = migrationOverflowFeedState.responseCache[0]!.response as { request_id: string };
  const canonicalFirstRequestId = corruptResponse.request_id;
  migrationOverflowFeedState.requestReceipts[0]!.createdAt = corruptCreatedAt;
  migrationOverflowFeedState.requestReceipts[0]!.expiresAt = corruptExpiresAt;
  migrationOverflowFeedState.responseCache[0]!.createdAt = corruptCreatedAt;
  migrationOverflowFeedState.responseCache[0]!.expiresAt = corruptExpiresAt;
  corruptResponse.request_id = "req_pg_v1_corrupt_expired";
  migrationOverflowFeedState.responseCache[0]!.serializedBytes = utf8JsonBytes(corruptResponse);
  migrationOverflowPairingState.authorizedRequestReceipts[0]!.createdAt = corruptCreatedAt;
  migrationOverflowPairingState.authorizedRequestReceipts[0]!.expiresAt = corruptExpiresAt;
  const corruptOverflowRoot = { ...migrationOverflowRoot, agentFeedState: migrationOverflowFeedState };
  await admin`UPDATE cmai_state SET state = ${admin.json(corruptOverflowRoot)} WHERE id = 'default'`;
  await admin`UPDATE cmai_agent_pairing_state SET state = ${admin.json(migrationOverflowPairingState)} WHERE id = 'default'`;
  const corruptFeedBeforeRefusal = structuredClone(corruptOverflowRoot);
  const corruptPairingBeforeRefusal = structuredClone(migrationOverflowPairingState);
  await assert.rejects(
    () => applyAgentProtocolStateV1(admin),
    /malformed|belongs to another request/u,
    "malformed expired legacy evidence must fail before pruning",
  );
  assert.deepEqual((await admin`SELECT state FROM cmai_state WHERE id = 'default'`)[0]?.state, corruptFeedBeforeRefusal);
  assert.deepEqual((await admin`SELECT state FROM cmai_agent_pairing_state WHERE id = 'default'`)[0]?.state, corruptPairingBeforeRefusal);
  assert.deepEqual((await admin`SELECT migration_id FROM cmai_schema_migrations`), [], "malformed expired evidence must not record migration success");
  migrationOverflowFeedState.requestReceipts[0]!.createdAt = migrationOverflowNow.toISOString();
  migrationOverflowFeedState.requestReceipts[0]!.expiresAt = migrationOverflowExpiresAt;
  migrationOverflowFeedState.responseCache[0]!.createdAt = migrationOverflowNow.toISOString();
  migrationOverflowFeedState.responseCache[0]!.expiresAt = migrationOverflowExpiresAt;
  corruptResponse.request_id = canonicalFirstRequestId;
  migrationOverflowFeedState.responseCache[0]!.serializedBytes = utf8JsonBytes(corruptResponse);
  migrationOverflowPairingState.authorizedRequestReceipts[0]!.createdAt = migrationOverflowNow.toISOString();
  migrationOverflowPairingState.authorizedRequestReceipts[0]!.expiresAt = migrationOverflowExpiresAt;
  const expiredCreatedAt = new Date(migrationOverflowNow.getTime() - 31 * 60_000).toISOString();
  const expiredAt = new Date(migrationOverflowNow.getTime() - 60_000).toISOString();
  for (let index = 0; index < 501; index += 1) {
    migrationOverflowFeedState.requestReceipts[index]!.createdAt = expiredCreatedAt;
    migrationOverflowFeedState.requestReceipts[index]!.expiresAt = expiredAt;
    migrationOverflowFeedState.responseCache[index]!.createdAt = expiredCreatedAt;
    migrationOverflowFeedState.responseCache[index]!.expiresAt = expiredAt;
    migrationOverflowPairingState.authorizedRequestReceipts[index]!.createdAt = expiredCreatedAt;
    migrationOverflowPairingState.authorizedRequestReceipts[index]!.expiresAt = expiredAt;
  }
  await admin`UPDATE cmai_state SET state = ${admin.json({ ...migrationOverflowRoot, agentFeedState: migrationOverflowFeedState })} WHERE id = 'default'`;
  await admin`UPDATE cmai_agent_pairing_state SET state = ${admin.json(migrationOverflowPairingState)} WHERE id = 'default'`;
  assert.deepEqual(
    await applyAgentProtocolStateV1(admin),
    [AGENT_FEED_STATE_V1_MIGRATION_ID, AGENT_PAIRING_STATE_V1_MIGRATION_ID, AGENT_FEED_STATE_V2_MIGRATION_ID],
    "migration must atomically prune expired evidence from both rows and retain the live second pairing",
  );
  const drainedFeedRoot = (await admin`SELECT state FROM cmai_state WHERE id = 'default'`)[0]?.state as AgentFeedTransactionRoot;
  const drainedPairingState = (await admin`SELECT state FROM cmai_agent_pairing_state WHERE id = 'default'`)[0]?.state as Awaited<ReturnType<PostgresPairingStateBackend["read"]>>;
  assert.equal(drainedFeedRoot.agentFeedState.requestReceipts.length, 1);
  assert.equal(drainedFeedRoot.agentFeedState.responseCache.length, 1);
  assert.equal(drainedPairingState.authorizedRequestReceipts.length, 1);
  assert.equal(drainedPairingState.authorizedRequestReceipts[0]?.pairingId, "pairing_pg_v1_drain_retained");
  const retainedReplay = await transactPostgresAgentFeedRequest({
    pairingId: "pairing_pg_v1_drain_retained",
    operation: "feed.list",
    requestId: "req_pg_v1_drain_0501",
    requestHash: (501).toString(16).padStart(64, "0"),
    responseCacheId: "unused_exact_replay_cache",
    requestAuthorizedAt: migrationRetainedCreatedAt.toISOString(),
    requestReceiptExpiresAt: migrationRetainedExpiresAt,
  }, () => { throw new Error("retained migration replay must not execute"); }, migrationOverflowNow);
  assert.equal(retainedReplay.replayed, true);
  drainedFeedRoot.agentFeedState.requestReceipts = [];
  drainedFeedRoot.agentFeedState.responseCache = [];
  await admin`UPDATE cmai_state SET state = ${admin.json(drainedFeedRoot)} WHERE id = 'default'`;
  await admin`UPDATE cmai_agent_pairing_state SET state = ${admin.json(emptyPairingPlatformState())} WHERE id = 'default'`;
  assert.deepEqual(await rollbackAgentProtocolStateV1(admin), [AGENT_FEED_STATE_V1_MIGRATION_ID, AGENT_PAIRING_STATE_V1_MIGRATION_ID, AGENT_FEED_STATE_V2_MIGRATION_ID]);
  assert.deepEqual((await admin`SELECT state FROM cmai_state WHERE id = 'default'`)[0]?.state, {});

  await admin.unsafe(AGENT_PAIRING_STATE_V1_SQL);
  await admin.unsafe(AGENT_FEED_STATE_V1_SQL);
  const byteOverflowNow = new Date();
  const byteOverflowPairingState = structuredClone(migrationOverflowPairingState);
  byteOverflowPairingState.authorizedRequestReceipts = [];
  const byteOverflowFeedState = {
    ...emptyAgentFeedPersistedState(),
    schemaVersion: 1 as const,
  };
  const byteChunk = "b".repeat(40_000);
  const byteResponses = Array.from({ length: 3 }, (_, index) => {
    const response = JSON.parse(JSON.stringify(validChallengeGetResponseFixture));
    response.request_id = `req_pg_v1_byte_${index.toString().padStart(4, "0")}`;
    response.server_time = byteOverflowNow.toISOString();
    response.result.challenge.content.problem_statement = byteChunk;
    response.result.challenge.content.original_ai_answer = byteChunk;
    response.result.challenge.content.context = byteChunk;
    response.result.challenge.content.constraints = [byteChunk];
    response.result.challenge.content.success_criteria = [byteChunk];
    response.result.challenge.content.assumptions_to_test = [byteChunk];
    response.result.challenge.content.claims_to_check = [byteChunk];
    response.result.challenge.content.known_risks = [byteChunk];
    response.result.challenge.content.useful_response_should_address = [byteChunk];
    response.result.challenge.content.missing_information = [byteChunk];
    return response;
  });
  const appendByteMigrationRead = (
    pairingId: string,
    operation: "feed.list" | "challenge.get",
    requestId: string,
    requestHash: string,
    response: (typeof byteResponses)[number] | typeof validFeedListResponseFixture,
    createdAt: string,
    expiresAt: string,
  ) => {
    const cacheId = `cache_${requestId}`;
    byteOverflowFeedState.requestReceipts.push({ pairingId, operation, requestId, requestHash, responseCacheId: cacheId, createdAt, expiresAt });
    byteOverflowFeedState.responseCache.push({
      cacheId,
      pairingId,
      operation,
      requestId,
      response,
      serializedBytes: utf8JsonBytes(response),
      createdAt,
      expiresAt,
    });
    byteOverflowPairingState.authorizedRequestReceipts.push({ pairingId, operation, requestId, requestHash, createdAt, expiresAt });
  };
  const byteLiveExpiry = new Date(byteOverflowNow.getTime() + 30 * 60_000).toISOString();
  for (let index = 0; index < byteResponses.length; index += 1) {
    appendByteMigrationRead(
      "pairing_pg_v1_drain_attacker",
      "challenge.get",
      `req_pg_v1_byte_${index.toString().padStart(4, "0")}`,
      (index + 700).toString(16).padStart(64, "0"),
      byteResponses[index]!,
      byteOverflowNow.toISOString(),
      byteLiveExpiry,
    );
  }
  const byteRetainedCreatedAt = new Date(byteOverflowNow.getTime() + 1_000);
  const byteRetainedExpiry = new Date(byteRetainedCreatedAt.getTime() + 30 * 60_000).toISOString();
  const byteRetainedResponse = JSON.parse(JSON.stringify(validFeedListResponseFixture));
  byteRetainedResponse.request_id = "req_pg_v1_byte_retained";
  byteRetainedResponse.server_time = byteRetainedCreatedAt.toISOString();
  appendByteMigrationRead(
    "pairing_pg_v1_drain_retained",
    "feed.list",
    "req_pg_v1_byte_retained",
    "e".repeat(64),
    byteRetainedResponse,
    byteRetainedCreatedAt.toISOString(),
    byteRetainedExpiry,
  );
  assert.ok(byteOverflowFeedState.responseCache.length <= MAX_AGENT_FEED_RESPONSE_CACHE_PER_PAIRING);
  assert.ok(
    byteOverflowFeedState.responseCache
      .filter((record) => record.pairingId === "pairing_pg_v1_drain_attacker")
      .reduce((total, record) => total + record.serializedBytes, 0) > MAX_AGENT_FEED_RESPONSE_CACHE_BYTES_PER_PAIRING,
    "byte-overflow migration fixture must truthfully exceed 1 MiB with at most 500 live records",
  );
  const byteOverflowRoot = {
    ...((await admin`SELECT state FROM cmai_state WHERE id = 'default'`)[0]?.state as Record<string, unknown>),
    agentFeedState: byteOverflowFeedState,
  };
  await admin`UPDATE cmai_state SET state = ${admin.json(byteOverflowRoot)} WHERE id = 'default'`;
  await admin`UPDATE cmai_agent_pairing_state SET state = ${admin.json(byteOverflowPairingState)} WHERE id = 'default'`;
  const byteFeedBeforeRefusal = structuredClone(byteOverflowRoot);
  const bytePairingBeforeRefusal = structuredClone(byteOverflowPairingState);
  await assert.rejects(
    () => applyAgentProtocolStateV1(admin),
    /requires read-cache drain.*retry after/u,
    "live v1 per-pair byte overflow must fail with an explicit drain diagnostic",
  );
  assert.deepEqual((await admin`SELECT state FROM cmai_state WHERE id = 'default'`)[0]?.state, byteFeedBeforeRefusal);
  assert.deepEqual((await admin`SELECT state FROM cmai_agent_pairing_state WHERE id = 'default'`)[0]?.state, bytePairingBeforeRefusal);
  assert.deepEqual((await admin`SELECT migration_id FROM cmai_schema_migrations`), [], "byte-overflow drain refusal must not record migration success");
  const byteExpiredCreatedAt = new Date(byteOverflowNow.getTime() - 31 * 60_000).toISOString();
  const byteExpiredAt = new Date(byteOverflowNow.getTime() - 60_000).toISOString();
  for (let index = 0; index < byteResponses.length; index += 1) {
    byteOverflowFeedState.requestReceipts[index]!.createdAt = byteExpiredCreatedAt;
    byteOverflowFeedState.requestReceipts[index]!.expiresAt = byteExpiredAt;
    byteOverflowFeedState.responseCache[index]!.createdAt = byteExpiredCreatedAt;
    byteOverflowFeedState.responseCache[index]!.expiresAt = byteExpiredAt;
    byteOverflowPairingState.authorizedRequestReceipts[index]!.createdAt = byteExpiredCreatedAt;
    byteOverflowPairingState.authorizedRequestReceipts[index]!.expiresAt = byteExpiredAt;
  }
  await admin`UPDATE cmai_state SET state = ${admin.json({ ...byteOverflowRoot, agentFeedState: byteOverflowFeedState })} WHERE id = 'default'`;
  await admin`UPDATE cmai_agent_pairing_state SET state = ${admin.json(byteOverflowPairingState)} WHERE id = 'default'`;
  assert.deepEqual(
    await applyAgentProtocolStateV1(admin),
    [AGENT_FEED_STATE_V1_MIGRATION_ID, AGENT_PAIRING_STATE_V1_MIGRATION_ID, AGENT_FEED_STATE_V2_MIGRATION_ID],
    "byte-overflow migration must prune the exact expired triples and retain second-pair replay",
  );
  const byteDrainedFeedRoot = (await admin`SELECT state FROM cmai_state WHERE id = 'default'`)[0]?.state as AgentFeedTransactionRoot;
  const byteDrainedPairingState = (await admin`SELECT state FROM cmai_agent_pairing_state WHERE id = 'default'`)[0]?.state as Awaited<ReturnType<PostgresPairingStateBackend["read"]>>;
  assert.equal(byteDrainedFeedRoot.agentFeedState.requestReceipts.length, 1);
  assert.equal(byteDrainedFeedRoot.agentFeedState.responseCache.length, 1);
  assert.equal(byteDrainedPairingState.authorizedRequestReceipts.length, 1);
  const byteRetainedReplay = await transactPostgresAgentFeedRequest({
    pairingId: "pairing_pg_v1_drain_retained",
    operation: "feed.list",
    requestId: "req_pg_v1_byte_retained",
    requestHash: "e".repeat(64),
    responseCacheId: "unused_exact_replay_cache",
    requestAuthorizedAt: byteRetainedCreatedAt.toISOString(),
    requestReceiptExpiresAt: byteRetainedExpiry,
  }, () => { throw new Error("retained byte-overflow migration replay must not execute"); }, byteOverflowNow);
  assert.equal(byteRetainedReplay.replayed, true);
  byteDrainedFeedRoot.agentFeedState.requestReceipts = [];
  byteDrainedFeedRoot.agentFeedState.responseCache = [];
  await admin`UPDATE cmai_state SET state = ${admin.json(byteDrainedFeedRoot)} WHERE id = 'default'`;
  await admin`UPDATE cmai_agent_pairing_state SET state = ${admin.json(emptyPairingPlatformState())} WHERE id = 'default'`;
  assert.deepEqual(await rollbackAgentProtocolStateV1(admin), [AGENT_FEED_STATE_V1_MIGRATION_ID, AGENT_PAIRING_STATE_V1_MIGRATION_ID, AGENT_FEED_STATE_V2_MIGRATION_ID]);
  assert.deepEqual((await admin`SELECT state FROM cmai_state WHERE id = 'default'`)[0]?.state, {});

  const applied = await applyAgentProtocolStateV1(admin);
  assert.deepEqual(applied, [AGENT_FEED_STATE_V1_MIGRATION_ID, AGENT_PAIRING_STATE_V1_MIGRATION_ID, AGENT_FEED_STATE_V2_MIGRATION_ID]);
  assert.deepEqual(await applyAgentProtocolStateV1(admin), [], "migration runner must be idempotent");
  const migrationRows = await admin`SELECT migration_id FROM cmai_schema_migrations ORDER BY migration_id`;
  assert.deepEqual(migrationRows.map((row) => row.migration_id), [...applied].sort());
  assert.deepEqual(await store.getAgentFeedStoreReadiness(), { ready: true, schemaVersion: 2 });
  assert.deepEqual((await firstPairingBackend.read()).pairings, []);

  const challengeId = "challenge_pg_agent_feed_proof";
  await store.createChallenge({ id: challengeId, posterId: "poster-proof", visibility: "public", reward: 5, brief: brief("Postgres proof", 4_000) });

  const now = new Date();
  const readReceiptTiming = {
    requestAuthorizedAt: now.toISOString(),
    requestReceiptExpiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
  };

  secondPairingBackend = new PostgresPairingStateBackend(databaseUrl);
  const firstPairingService = new PairingService(firstPairingBackend, { clock: () => new Date(now) });
  const secondPairingService = new PairingService(secondPairingBackend, { clock: () => new Date(now) });
  const pairingKey = generatePairingTestKey("key_pg_pairing_proof");
  const pairingCode = await firstPairingService.issuePairingCode({
    ownerId: "owner-pg-pairing-proof",
    runtime: "hermes",
    displayName: "Postgres Pairing Proof",
  });
  const pairing = await firstPairingService.redeemPairing(pairCreateRequest({
    pairingCode: pairingCode.pairing_code,
    key: pairingKey,
    sentAt: now.toISOString(),
    requestId: "req_pg_pairing_create",
    deviceId: "device_pg_pairing_proof",
    ownerLabel: "Postgres Pairing Proof",
  }), { rateLimitKey: "network-pg-pairing-proof" });

  const coherentPairingBaseline = await firstPairingBackend.read();
  const firstRateBucket = coherentPairingBaseline.rateLimitBuckets[0];
  assert.ok(firstRateBucket, "Postgres validation proof requires one persisted rate bucket");
  await assert.rejects(
    () => firstPairingBackend!.transact((state) => {
      state.rateLimitBuckets.push(structuredClone(firstRateBucket));
    }),
    /missing or incompatible/,
    "Postgres pairing backend must validate complete state before UPDATE",
  );
  assert.deepEqual(await firstPairingBackend.read(), coherentPairingBaseline, "failed post-operation validation must roll back Postgres state");
  const crossStoreCorruption = structuredClone(coherentPairingBaseline);
  crossStoreCorruption.authorizedRequestReceipts.push({
    pairingId: pairing.pairing_id,
    requestId: "req_cross_store_missing_feed",
    operation: "feed.list",
    requestHash: "c".repeat(64),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 30 * 60_000).toISOString(),
  });
  await admin`UPDATE cmai_agent_pairing_state SET state = ${admin.json(crossStoreCorruption)} WHERE id = 'default'`;
  await assert.rejects(
    () => applyAgentProtocolStateV1(admin),
    /matching feed transaction evidence/,
    "cross-store replay corruption must block migration readiness",
  );
  await admin`UPDATE cmai_agent_pairing_state SET state = ${admin.json(coherentPairingBaseline)} WHERE id = 'default'`;

  await Promise.all([
    firstPairingService.assertAgentFeedNetworkRateLimit({ identity: "network-pg-feed-proof" }),
    secondPairingService.assertAgentFeedNetworkRateLimit({ identity: "network-pg-feed-proof" }),
  ]);
  const signedFeed = agentFeedListRequestSchema.parse(signedPairingRequest({
    operation: "feed.list",
    requestId: "req_pg_pairing_receipt",
    sentAt: now.toISOString(),
    pairingId: pairing.pairing_id,
    key: pairingKey,
    payload: { limit: 10 },
  }));
  const signedFeedInput: AgentFeedRequestTransactionInput = {
    ...readReceiptTiming,
    pairingId: pairing.pairing_id,
    operation: "feed.list",
    requestId: signedFeed.request_id,
    requestHash: hashAgentProtocolPayload({ sent_at: signedFeed.sent_at, key_id: signedFeed.auth.key_id, payload: signedFeed.payload }),
    responseCacheId: "response_pg_pairing_receipt",
  };
  const executeSignedFeed: AgentFeedRequestExecutor = () => {
    const response = JSON.parse(JSON.stringify(validFeedListResponseFixture));
    response.request_id = signedFeed.request_id;
    response.server_time = now.toISOString();
    return response;
  };
  const firstAuthorizationEntered = deferred();
  const releaseFirstAuthorization = deferred();
  const firstAuthorization = firstPairingService.authorizeAndExecute(signedFeed, async (authorization) => {
    assert.equal(authorization.requestReplay, "new");
    assert.ok(authorization.agentFeedStore, "Postgres pairing authorization must expose the transaction-scoped Agent feed store");
    firstAuthorizationEntered.resolve();
    await releaseFirstAuthorization.promise;
    return authorization.agentFeedStore.transactAgentFeedRequest(signedFeedInput, executeSignedFeed, now);
  });
  await firstAuthorizationEntered.promise;
  let secondAuthorizationResolved = false;
  const secondAuthorization = secondPairingService.authorizeAndExecute(signedFeed, (authorization) => {
    assert.ok(authorization.agentFeedStore, "Postgres pairing replay must use the transaction-scoped Agent feed store");
    return authorization.agentFeedStore.transactAgentFeedRequest(signedFeedInput, executeSignedFeed, now);
  }).then((result) => {
    secondAuthorizationResolved = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(secondAuthorizationResolved, false, "second pairing transaction must block on the authoritative row lock");
  releaseFirstAuthorization.resolve();
  const [freshAuthorizedFeed, replayedAuthorizedFeed] = await Promise.all([firstAuthorization, secondAuthorization]);
  assert.equal(freshAuthorizedFeed.replayed, false);
  assert.equal(replayedAuthorizedFeed.replayed, true);
  assert.deepEqual(replayedAuthorizedFeed.response, freshAuthorizedFeed.response);
  const pairingState = await firstPairingBackend.read();
  assert.equal(pairingState.authorizedRequestReceipts.length, 1, "concurrent exact authorization must persist one receipt");
  assert.equal(pairingState.rateLimitBuckets.find((bucket) => bucket.capacityClass === "network:agent_feed")?.count, 2);
  assert.equal(pairingState.rateLimitBuckets.find((bucket) => bucket.capacityClass === "principal:feed.list")?.count, 1);

  const protocolServiceFeed = agentFeedListRequestSchema.parse(signedPairingRequest({
    operation: "feed.list",
    requestId: "req_pg_protocol_service_feed",
    sentAt: now.toISOString(),
    pairingId: pairing.pairing_id,
    key: pairingKey,
    payload: { limit: 10 },
  }));
  const firstFeedService = new AgentFeedProtocolService({
    pairingService: firstPairingService,
    store: { transactAgentFeedRequest: transactPostgresAgentFeedRequest },
    cursorSecret: "postgres-proof-cursor-secret-32-byte-minimum",
    clock: () => new Date(now),
  });
  const secondFeedService = new AgentFeedProtocolService({
    pairingService: secondPairingService,
    store: { transactAgentFeedRequest: transactPostgresAgentFeedRequest },
    cursorSecret: "postgres-proof-cursor-secret-32-byte-minimum",
    clock: () => new Date(now),
  });
  const [protocolServiceFeedResponse, protocolServiceFeedReplay] = await Promise.all([
    firstFeedService.execute(protocolServiceFeed, "network-pg-protocol-service", { networkRateLimitPrecharged: true }),
    secondFeedService.execute(protocolServiceFeed, "network-pg-protocol-service", { networkRateLimitPrecharged: true }),
  ]);
  assert.deepEqual(protocolServiceFeedReplay, protocolServiceFeedResponse, "production service must exact-replay one concurrent feed response");
  const protocolServiceState = await firstPairingBackend.read();
  assert.equal(protocolServiceState.authorizedRequestReceipts.filter((receipt) => receipt.requestId === protocolServiceFeed.request_id).length, 1);
  assert.equal(protocolServiceState.rateLimitBuckets.find((bucket) => bucket.capacityClass === "principal:feed.list")?.count, 2);

  const migrationRaceFeed = agentFeedListRequestSchema.parse(signedPairingRequest({
    operation: "feed.list",
    requestId: "req_pg_migration_runtime_lock_order",
    sentAt: now.toISOString(),
    pairingId: pairing.pairing_id,
    key: pairingKey,
    payload: { limit: 10 },
  }));
  const runtimePairingLockHeld = deferred();
  const releaseRuntimePairingLock = deferred();
  const runtimeLockHolder = firstClient.begin(async (transaction) => {
    const rows = await transaction`SELECT id FROM cmai_agent_pairing_state WHERE id = 'default' FOR UPDATE`;
    assert.equal(rows.length, 1);
    runtimePairingLockHeld.resolve();
    await releaseRuntimePairingLock.promise;
  });
  await runtimePairingLockHeld.promise;
  const migrationWhileRuntimeLocked = applyAgentProtocolStateV1(admin);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await secondClient.begin(async (transaction) => {
    await transaction.unsafe("SET LOCAL lock_timeout = '1000ms'");
    const rows = await transaction`SELECT id FROM cmai_state WHERE id = 'default' FOR UPDATE`;
    assert.equal(rows.length, 1, "migration must not lock cmai_state while waiting for the runtime pairing lock");
  });
  releaseRuntimePairingLock.resolve();
  await Promise.race([
    Promise.all([runtimeLockHolder, migrationWhileRuntimeLocked]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("deterministic migration/runtime lock-order rehearsal timed out")), 5_000)),
  ]);
  await firstFeedService.execute(migrationRaceFeed, "network-pg-migration-race", { networkRateLimitPrecharged: true });

  const beforeProjectionFailure = (await admin`SELECT state FROM cmai_state WHERE id = 'default'`)[0]?.state;
  const projectionFailureInput: AgentFeedRequestTransactionInput = {
    ...readReceiptTiming,
    pairingId: pairing.pairing_id,
    operation: "feed.list",
    requestId: "req_pg_projection_failure",
    requestHash: createHash("sha256").update("postgres-proof-projection-failure", "utf8").digest("hex"),
    responseCacheId: "response_pg_projection_failure",
  };
  await assert.rejects(
    transactPostgresAgentFeedRequest(projectionFailureInput, (transaction) => {
      transaction.listPage({
        filters: {},
        filtersHash: "p".repeat(22),
        audienceHash: "q".repeat(22),
        limit: 1,
        snapshotId: "snapshot_pg_projection_failure",
      });
      throw new AgentFeedProjectionError("projection_invalid", "Projection failed after provisional state mutation.");
    }, now),
    (error: unknown) => error instanceof AgentFeedProjectionError,
  );
  const afterProjectionFailure = (await admin`SELECT state FROM cmai_state WHERE id = 'default'`)[0]?.state;
  assert.deepEqual(afterProjectionFailure, beforeProjectionFailure, "projection failure must preserve error class and roll back provisional state");

  const atomicFailureRequest = agentFeedListRequestSchema.parse(signedPairingRequest({
    operation: "feed.list",
    requestId: "req_pg_atomic_pairing_feed_failure",
    sentAt: now.toISOString(),
    pairingId: pairing.pairing_id,
    key: pairingKey,
    payload: { limit: 1 },
  }));
  const atomicFailureFeedInput: AgentFeedRequestTransactionInput = {
    ...readReceiptTiming,
    pairingId: pairing.pairing_id,
    operation: "feed.list",
    requestId: atomicFailureRequest.request_id,
    requestHash: createHash("sha256").update("postgres-proof-atomic-pairing-feed-failure", "utf8").digest("hex"),
    responseCacheId: "response_pg_atomic_pairing_feed_failure",
  };
  const pairingBeforeAtomicFailure = await firstPairingBackend.read();
  const feedBeforeAtomicFailure = (await admin`SELECT state FROM cmai_state WHERE id = 'default'`)[0]?.state;
  await assert.rejects(
    firstPairingService.authorizeAndExecute(atomicFailureRequest, (authorization) => {
      assert.ok(authorization.agentFeedStore, "atomic failure proof requires transaction-scoped Agent feed state");
      return authorization.agentFeedStore.transactAgentFeedRequest(atomicFailureFeedInput, (transaction) => {
        transaction.listPage({
          filters: {},
          filtersHash: "r".repeat(22),
          audienceHash: "s".repeat(22),
          limit: 1,
          snapshotId: "snapshot_pg_atomic_pairing_feed_failure",
        });
        throw new AgentFeedProjectionError("projection_invalid", "Atomic pairing/feed projection failed.");
      }, now);
    }),
    (error: unknown) => error instanceof AgentFeedProjectionError,
  );
  assert.deepEqual(await firstPairingBackend.read(), pairingBeforeAtomicFailure, "failed Agent feed projection must roll back pairing authorization and rate state");
  assert.deepEqual((await admin`SELECT state FROM cmai_state WHERE id = 'default'`)[0]?.state, feedBeforeAtomicFailure, "failed Agent feed projection must roll back feed state in the same transaction");

  const postWriteFailureRequest = agentFeedListRequestSchema.parse(signedPairingRequest({
    operation: "feed.list",
    requestId: "req_pg_post_write_pairing_feed_failure",
    sentAt: now.toISOString(),
    pairingId: pairing.pairing_id,
    key: pairingKey,
    payload: { limit: 1 },
  }));
  const postWriteFailureInput: AgentFeedRequestTransactionInput = {
    ...readReceiptTiming,
    pairingId: pairing.pairing_id,
    operation: "feed.list",
    requestId: postWriteFailureRequest.request_id,
    requestHash: createHash("sha256").update("postgres-proof-post-write-pairing-feed-failure", "utf8").digest("hex"),
    responseCacheId: "response_pg_post_write_pairing_feed_failure",
  };
  const pairingBeforePostWriteFailure = await firstPairingBackend.read();
  const feedBeforePostWriteFailure = (await admin`SELECT state FROM cmai_state WHERE id = 'default'`)[0]?.state;
  await assert.rejects(
    firstPairingService.authorizeAndExecute(postWriteFailureRequest, async (authorization) => {
      assert.ok(authorization.agentFeedStore, "post-write failure proof requires transaction-scoped Agent feed state");
      await authorization.agentFeedStore.transactAgentFeedRequest(postWriteFailureInput, () => {
        const response = JSON.parse(JSON.stringify(validFeedListResponseFixture));
        response.request_id = postWriteFailureRequest.request_id;
        response.server_time = now.toISOString();
        return response;
      }, now);
      throw new AgentFeedProjectionError("projection_invalid", "Protected action failed after the feed SQL update completed.");
    }),
    (error: unknown) => error instanceof AgentFeedProjectionError,
  );
  assert.deepEqual(await firstPairingBackend.read(), pairingBeforePostWriteFailure, "post-write failure must roll back pairing authorization and rate state");
  assert.deepEqual((await admin`SELECT state FROM cmai_state WHERE id = 'default'`)[0]?.state, feedBeforePostWriteFailure, "post-write failure must roll back a completed transaction-scoped feed update");

  const signedGrantRequest = agentChallengeGetRequestSchema.parse(signedPairingRequest({
    operation: "challenge.get",
    requestId: "req_pg_grant_proof_1",
    sentAt: now.toISOString(),
    pairingId: pairing.pairing_id,
    key: pairingKey,
    payload: { challenge_id: challengeId },
  }));
  const principalGrantCountBefore = (await firstPairingBackend.read()).rateLimitBuckets
    .find((bucket) => bucket.capacityClass === "principal:challenge.get")?.count ?? 0;
  let productionChallengeExecutorCalls = 0;
  const instrumentAuthorization = (authorization: PairingAuthorizationContext): PairingAuthorizationContext => {
    const originalStore = authorization.agentFeedStore;
    if (!originalStore) throw new Error("Production proof requires the coordinated Agent feed transaction store.");
    const instrumentedStore: AgentFeedTransactionalStore = {
      transactAgentFeedRequest(input, execute, transactionTime) {
        return originalStore.transactAgentFeedRequest(input, (transaction) => {
          if (input.requestId === signedGrantRequest.request_id) productionChallengeExecutorCalls += 1;
          return execute(transaction);
        }, transactionTime);
      },
      submitAgentFeedContribution(input, transactionTime) {
        return originalStore.submitAgentFeedContribution(input, transactionTime);
      },
    };
    return { ...authorization, agentFeedStore: instrumentedStore };
  };
  const instrumentPairingService = (service: PairingService): PairingService => ({
    authorizeAndExecute: async <T>(
      request: Parameters<PairingService["authorizeAndExecute"]>[0],
      action: (authorization: PairingAuthorizationContext) => Promise<T> | T,
    ): Promise<T> => service.authorizeAndExecute(request, (authorization) => action(instrumentAuthorization(authorization))),
  }) as unknown as PairingService;
  const firstProductionLockHeld = deferred();
  const releaseFirstProductionCall = deferred();
  let firstGateUsed = false;
  const gatedFirstPairingService = {
    authorizeAndExecute: async <T>(
      request: Parameters<PairingService["authorizeAndExecute"]>[0],
      action: (authorization: Parameters<Parameters<PairingService["authorizeAndExecute"]>[1]>[0]) => Promise<T> | T,
    ): Promise<T> => firstPairingService.authorizeAndExecute(request, async (authorization) => {
      if (!firstGateUsed) {
        firstGateUsed = true;
        firstProductionLockHeld.resolve();
        await releaseFirstProductionCall.promise;
      }
      return await action(instrumentAuthorization(authorization));
    }),
  } as unknown as PairingService;
  const gatedFirstFeedService = new AgentFeedProtocolService({
    pairingService: gatedFirstPairingService,
    store: { transactAgentFeedRequest: transactPostgresAgentFeedRequest },
    cursorSecret: "postgres-proof-cursor-secret-32-byte-minimum",
    clock: () => new Date(now),
  });
  const firstGrantCall = gatedFirstFeedService.execute(signedGrantRequest, "network-pg-grant-service", { networkRateLimitPrecharged: true });
  await firstProductionLockHeld.promise;
  const instrumentedSecondFeedService = new AgentFeedProtocolService({
    pairingService: instrumentPairingService(secondPairingService),
    store: { transactAgentFeedRequest: transactPostgresAgentFeedRequest },
    cursorSecret: "postgres-proof-cursor-secret-32-byte-minimum",
    clock: () => new Date(now),
  });
  let secondGrantCallResolved = false;
  const secondGrantCall = instrumentedSecondFeedService.execute(signedGrantRequest, "network-pg-grant-service", { networkRateLimitPrecharged: true })
    .then((response) => {
      secondGrantCallResolved = true;
      return response;
    });
  await waitForProof("the second production challenge.get call to wait on the pairing row", async () => {
    const rows = await admin`
      SELECT count(*)::int AS waiting
      FROM pg_stat_activity
      WHERE datname = ${databaseName}
        AND wait_event_type = 'Lock'
        AND query ILIKE '%cmai_agent_pairing_state%'
    `;
    return Number(rows[0]?.waiting ?? 0) >= 1;
  });
  assert.equal(secondGrantCallResolved, false, "second production challenge.get must remain blocked while the first holds the pairing row");
  releaseFirstProductionCall.resolve();
  const [grantResponseValue, grantReplayValue] = await Promise.all([firstGrantCall, secondGrantCall]);
  assert.deepEqual(grantReplayValue, grantResponseValue, "production challenge.get concurrency must exact-replay one response");
  const grantResponse = agentChallengeGetResponseSchema.parse(grantResponseValue);
  const returnedNonce = grantResponse.result.challenge.run_grant.run_nonce;

  const grantProofPairingState = await firstPairingBackend.read();
  assert.equal(grantProofPairingState.authorizedRequestReceipts.filter((receipt) => receipt.requestId === signedGrantRequest.request_id).length, 1);
  assert.equal(
    grantProofPairingState.rateLimitBuckets.find((bucket) => bucket.capacityClass === "principal:challenge.get")?.count,
    principalGrantCountBefore + 1,
    "concurrent exact challenge replay must charge principal capacity once",
  );
  const grantProofRoot = (await admin`SELECT state FROM cmai_state WHERE id = 'default'`)[0]?.state as AgentFeedTransactionRoot;
  assert.equal(grantProofRoot.agentFeedState.requestReceipts.filter((receipt) => receipt.requestId === signedGrantRequest.request_id).length, 1);
  assert.equal(grantProofRoot.agentFeedState.responseCache.filter((record) => record.requestId === signedGrantRequest.request_id).length, 1);
  const grantRecords = grantProofRoot.agentFeedState.runGrants.filter((grant) => grant.requestId === signedGrantRequest.request_id);
  assert.equal(grantRecords.length, 1, "production challenge.get concurrency must persist one run grant");
  assert.equal(productionChallengeExecutorCalls, 1, "production challenge projection/grant executor must run exactly once under concurrent replay");

  const restartGrantBackend = new PostgresPairingStateBackend(databaseUrl);
  const restartBasePairingService = new PairingService(restartGrantBackend, { clock: () => new Date(now) });
  const restartGrantService = new AgentFeedProtocolService({
    pairingService: instrumentPairingService(restartBasePairingService),
    store: { transactAgentFeedRequest: transactPostgresAgentFeedRequest },
    cursorSecret: "postgres-proof-cursor-secret-32-byte-minimum",
    clock: () => new Date(now),
  });
  const restartedGrantReplay = await restartGrantService.execute(signedGrantRequest, "network-pg-grant-restart", { networkRateLimitPrecharged: true });
  assert.deepEqual(restartedGrantReplay, grantResponseValue, "restart replay must return the original challenge response and nonce");
  assert.equal(productionChallengeExecutorCalls, 1, "concurrent and restart exact replay must not re-enter the production challenge executor");
  const afterRestartGrantRoot = (await admin`SELECT state FROM cmai_state WHERE id = 'default'`)[0]?.state as AgentFeedTransactionRoot;
  assert.equal(afterRestartGrantRoot.agentFeedState.runGrants.filter((grant) => grant.requestId === signedGrantRequest.request_id).length, 1);
  assert.equal(
    (await restartGrantBackend.read()).rateLimitBuckets.find((bucket) => bucket.capacityClass === "principal:challenge.get")?.count,
    principalGrantCountBefore + 1,
    "restart exact replay must not charge principal capacity again",
  );
  await restartGrantBackend.close();

  const largeResponseBytes = utf8JsonBytes(grantResponseValue);
  assert.ok(largeResponseBytes > 20_000 && largeResponseBytes <= 512 * 1024, "fairness proof requires a large valid challenge.get response");
  assert.ok(Math.floor(MAX_AGENT_FEED_RESPONSE_CACHE_BYTES_PER_PAIRING / largeResponseBytes) >= 2, "per-pairing byte quota must admit multiple useful large responses");
  let attackerAdmissions = 1;
  let attackerCapacityRejected = false;
  for (let index = 1; index < 100; index += 1) {
    const requestId = `req_pg_fair_attacker_${index.toString().padStart(2, "0")}`;
    const request = agentChallengeGetRequestSchema.parse(signedPairingRequest({
      operation: "challenge.get",
      requestId,
      sentAt: now.toISOString(),
      pairingId: pairing.pairing_id,
      key: pairingKey,
      payload: { challenge_id: challengeId },
    }));
    try {
      await firstFeedService.execute(request, "network-pg-fair-attacker", { networkRateLimitPrecharged: true });
      attackerAdmissions += 1;
    } catch (error) {
      assert.equal((error as { code?: string }).code, "capacity_exceeded", "one pairing must stop at its own response-cache quota");
      attackerCapacityRejected = true;
      break;
    }
  }
  assert.equal(attackerCapacityRejected, true, "large production reads must reach the per-pairing byte ceiling before the shared cache");
  assert.ok(attackerAdmissions >= 2, "one pairing keeps useful large-response admission before its quota closes");
  assert.deepEqual(
    await firstFeedService.execute(signedGrantRequest, "network-pg-fair-attacker-replay", { networkRateLimitPrecharged: true }),
    grantResponseValue,
    "exact replay must remain available after the pairing reaches its new-request quota",
  );

  const fairPairingKey = generatePairingTestKey("key_pg_fair_second_pairing");
  const fairPairingCode = await firstPairingService.issuePairingCode({
    ownerId: "owner-pg-fair-second",
    runtime: "hermes",
    displayName: "Postgres Fairness Second Pairing",
  });
  const fairPairing = await firstPairingService.redeemPairing(pairCreateRequest({
    pairingCode: fairPairingCode.pairing_code,
    key: fairPairingKey,
    sentAt: now.toISOString(),
    requestId: "req_pg_fair_second_pairing_create",
    deviceId: "device_pg_fair_second_pairing",
    ownerLabel: "Postgres Fairness Second Pairing",
  }), { rateLimitKey: "network-pg-fair-second-pairing" });
  const fairSecondRequest = agentChallengeGetRequestSchema.parse(signedPairingRequest({
    operation: "challenge.get",
    requestId: "req_pg_fair_second_pairing_read",
    sentAt: now.toISOString(),
    pairingId: fairPairing.pairing_id,
    key: fairPairingKey,
    payload: { challenge_id: challengeId },
  }));
  const fairSecondResponse = await secondFeedService.execute(fairSecondRequest, "network-pg-fair-second-read", { networkRateLimitPrecharged: true });
  assert.equal(agentChallengeGetResponseSchema.parse(fairSecondResponse).result.challenge.challenge_id, challengeId, "one pairing's cache quota must not consume another pairing's admission");

  const idempotencyProof = ["idem", "pg", "submission", "proof", "1"].join("_");
  const signedSubmission = agentContributionSubmitRequestSchema.parse(signedPairingRequest({
    operation: "contribution.submit",
    requestId: "req_pg_submission_proof_1",
    sentAt: new Date(now.getTime() + 1_000).toISOString(),
    pairingId: pairing.pairing_id,
    key: pairingKey,
    payload: {
      ...JSON.parse(JSON.stringify(validContributionSubmitRequestFixture.payload)),
      challenge_id: challengeId,
      challenge_revision: 1,
      run_nonce: returnedNonce,
      idempotency_key: idempotencyProof,
      card: {
        ...JSON.parse(JSON.stringify(validContributionSubmitRequestFixture.payload.card)),
        challenge_id: challengeId,
      },
    },
  }));
  const card = signedSubmission.payload.card as ContributionCard;
  const submissionInput: AgentFeedSubmissionInput = {
    pairingId: pairing.pairing_id,
    requestId: signedSubmission.request_id,
    challengeId: signedSubmission.payload.challenge_id,
    challengeRevision: signedSubmission.payload.challenge_revision,
    nonceHash: createHash("sha256").update(`CMAI_AGENT_RUN_NONCE_V1\0${signedSubmission.payload.run_nonce}`, "utf8").digest("hex"),
    idempotencyKeyHash: createHash("sha256").update(signedSubmission.payload.idempotency_key, "utf8").digest("hex"),
    requestHash: hashAgentProtocolPayload({
      sent_at: signedSubmission.sent_at,
      key_id: signedSubmission.auth.key_id,
      payload: signedSubmission.payload,
    }),
    payloadHash: hashAgentProtocolPayload(signedSubmission.payload),
    cardHash: hashAgentProtocolPayload(card),
    submissionId: "submission_pg_proof_1",
    contributionId: "contribution_pg_proof_1",
    contributorId: pairing.pairing_id,
    contributorKind: "agent",
    contributorLabel: "Postgres Proof Agent",
    card,
    externallyGenerated: true,
    acceptedAt: new Date(now.getTime() + 1_000).toISOString(),
    requestAuthorizedAt: now.toISOString(),
    requestReceiptExpiresAt: new Date(now.getTime() + AGENT_FEED_SUBMISSION_RETENTION_MS).toISOString(),
  };
  const submissionResults = await Promise.all([
    firstPairingService.authorizeAndExecute(signedSubmission, (authorization) => (
      authorization.agentFeedStore ?? store!
    ).submitAgentFeedContribution({
      ...submissionInput,
      requestAuthorizedAt: authorization.requestAuthorizedAt,
      requestReceiptExpiresAt: authorization.requestReceiptExpiresAt,
    }, new Date(now.getTime() + 1_000))),
    secondPairingService.authorizeAndExecute(signedSubmission, (authorization) => (
      authorization.agentFeedStore ?? store!
    ).submitAgentFeedContribution({
      ...submissionInput,
      requestAuthorizedAt: authorization.requestAuthorizedAt,
      requestReceiptExpiresAt: authorization.requestReceiptExpiresAt,
    }, new Date(now.getTime() + 1_000))),
  ]);
  assert.deepEqual(submissionResults.map((result) => result.kind).sort(), ["accepted", "replayed"]);
  const acceptedSubmission = submissionResults.find((result) => result.kind === "accepted");
  const replayedSubmission = submissionResults.find((result) => result.kind === "replayed");
  if (!acceptedSubmission || acceptedSubmission.kind !== "accepted" || !replayedSubmission || replayedSubmission.kind !== "replayed") {
    throw new Error("Postgres signed submission race did not linearize to one accepted and one replayed result.");
  }
  assert.equal(acceptedSubmission.submissionId, replayedSubmission.submissionId);
  assert.equal(replayedSubmission.requestReplayed, true, "same request ID must exact-replay request evidence");

  const legacyUpgradeRoot = structuredClone((await admin`SELECT state FROM cmai_state WHERE id = 'default'`)[0]?.state) as Record<string, any>;
  const legacyFeedState = legacyUpgradeRoot.agentFeedState as Record<string, any>;
  const legacyBusinessReceipt = legacyFeedState.submissionReceipts[0] as Record<string, any>;
  const legacyExactAlias = (legacyFeedState.submissionRequestReceipts as Array<Record<string, any>>)
    .find((receipt) => receipt.requestId === signedSubmission.request_id);
  assert.ok(legacyExactAlias, "populated v1 upgrade proof requires the original accepted request alias");
  legacyBusinessReceipt.requestId = legacyExactAlias.requestId;
  legacyBusinessReceipt.requestHash = legacyExactAlias.requestHash;
  delete legacyBusinessReceipt.payloadIdentity;
  delete legacyBusinessReceipt.payloadHash;
  legacyFeedState.schemaVersion = 1;
  delete legacyFeedState.submissionRequestReceipts;
  await admin`UPDATE cmai_state SET state = ${admin.json(legacyUpgradeRoot)} WHERE id = 'default'`;
  await admin`DELETE FROM cmai_schema_migrations WHERE migration_id = ${AGENT_FEED_STATE_V2_MIGRATION_ID}`;
  assert.deepEqual(await applyAgentProtocolStateV1(admin), [AGENT_FEED_STATE_V2_MIGRATION_ID]);
  const upgradedPopulatedRoot = (await admin`SELECT state FROM cmai_state WHERE id = 'default'`)[0]?.state as Record<string, any>;
  assert.equal(upgradedPopulatedRoot.agentFeedState.schemaVersion, 2);
  assert.equal(upgradedPopulatedRoot.agentFeedState.submissionReceipts[0]?.payloadIdentity, "legacy_request_v1");
  assert.equal(upgradedPopulatedRoot.agentFeedState.submissionRequestReceipts[0]?.outcome?.submissionId, acceptedSubmission.submissionId);
  const migratedExactReplay = await firstPairingService.authorizeAndExecute(signedSubmission, (authorization) => (
    authorization.agentFeedStore ?? store!
  ).submitAgentFeedContribution({
    ...submissionInput,
    requestAuthorizedAt: authorization.requestAuthorizedAt,
    requestReceiptExpiresAt: authorization.requestReceiptExpiresAt,
  }, new Date(now.getTime() + 1_000)));
  assert.deepEqual(migratedExactReplay, {
    kind: "replayed",
    submissionId: acceptedSubmission.submissionId,
    contribution: acceptedSubmission.contribution,
    replayed: true,
    requestReplayed: true,
  }, "populated v1 accepted submission must retain exact replay after the v2 upgrade");
  const canonicalContinuationRoot = structuredClone(upgradedPopulatedRoot);
  const canonicalContinuationReceipt = canonicalContinuationRoot.agentFeedState.submissionReceipts[0] as Record<string, any>;
  canonicalContinuationReceipt.payloadIdentity = "canonical_payload_v1";
  canonicalContinuationReceipt.payloadHash = submissionInput.payloadHash;
  delete canonicalContinuationReceipt.legacyRequestHash;
  await admin`UPDATE cmai_state SET state = ${admin.json(canonicalContinuationRoot)} WHERE id = 'default'`;

  const aliasedSubmission = agentContributionSubmitRequestSchema.parse(signedPairingRequest({
    operation: "contribution.submit",
    requestId: "req_pg_submission_proof_2",
    sentAt: new Date(now.getTime() + 2_000).toISOString(),
    pairingId: pairing.pairing_id,
    key: pairingKey,
    payload: signedSubmission.payload,
  }));
  const aliasResult = await firstPairingService.authorizeAndExecute(aliasedSubmission, (authorization) => (
    authorization.agentFeedStore ?? store!
  ).submitAgentFeedContribution({
    ...submissionInput,
    requestId: aliasedSubmission.request_id,
    requestHash: hashAgentProtocolPayload({
      sent_at: aliasedSubmission.sent_at,
      key_id: aliasedSubmission.auth.key_id,
      payload: aliasedSubmission.payload,
    }),
    submissionId: "submission_pg_alias_ignored",
    contributionId: "contribution_pg_alias_ignored",
    acceptedAt: new Date(now.getTime() + 2_000).toISOString(),
    requestAuthorizedAt: authorization.requestAuthorizedAt,
    requestReceiptExpiresAt: authorization.requestReceiptExpiresAt,
  }, new Date(now.getTime() + 2_000)));
  assert.deepEqual(aliasResult, {
    kind: "replayed",
    submissionId: acceptedSubmission.submissionId,
    contribution: acceptedSubmission.contribution,
    replayed: true,
    requestReplayed: false,
  }, "fresh request ID with the same idempotency key and payload must create request-alias evidence and replay the original result");

  const terminalSubmission = agentContributionSubmitRequestSchema.parse(signedPairingRequest({
    operation: "contribution.submit",
    requestId: "req_pg_submission_terminal_1",
    sentAt: new Date(now.getTime() + 3_000).toISOString(),
    pairingId: pairing.pairing_id,
    key: pairingKey,
    payload: {
      ...signedSubmission.payload,
      idempotency_key: "idem_pg_submission_terminal_1",
    },
  }));
  const executeTerminalSubmission = () => firstPairingService.authorizeAndExecute(terminalSubmission, (authorization) => (
    authorization.agentFeedStore ?? store!
  ).submitAgentFeedContribution({
    ...submissionInput,
    requestId: terminalSubmission.request_id,
    idempotencyKeyHash: createHash("sha256").update(terminalSubmission.payload.idempotency_key, "utf8").digest("hex"),
    requestHash: hashAgentProtocolPayload({
      sent_at: terminalSubmission.sent_at,
      key_id: terminalSubmission.auth.key_id,
      payload: terminalSubmission.payload,
    }),
    payloadHash: hashAgentProtocolPayload(terminalSubmission.payload),
    submissionId: "submission_pg_terminal_unused",
    contributionId: "contribution_pg_terminal_unused",
    acceptedAt: new Date(now.getTime() + 3_000).toISOString(),
    requestAuthorizedAt: authorization.requestAuthorizedAt,
    requestReceiptExpiresAt: authorization.requestReceiptExpiresAt,
  }, new Date(now.getTime() + 3_000)));
  assert.deepEqual(await executeTerminalSubmission(), {
    kind: "duplicate_submit",
    originalSubmissionId: acceptedSubmission.submissionId,
    requestReplayed: false,
  });
  assert.deepEqual(await executeTerminalSubmission(), {
    kind: "duplicate_submit",
    originalSubmissionId: acceptedSubmission.submissionId,
    requestReplayed: true,
  }, "terminal submission outcome must survive exact signed-request replay without re-executing business logic");

  const counts = await admin`
    SELECT
      jsonb_array_length(state->'agentFeedState'->'runGrants')::int AS grants,
      jsonb_array_length(state->'agentFeedState'->'submissionReceipts')::int AS submission_receipts,
      jsonb_array_length(state->'agentFeedState'->'submissionRequestReceipts')::int AS submission_request_receipts,
      jsonb_array_length(state->'contributions')::int AS contributions,
      EXISTS (
        SELECT 1
        FROM jsonb_array_elements(state->'agentFeedState'->'runGrants') AS grant_record
        WHERE grant_record->>'requestId' = ${signedGrantRequest.request_id}
          AND grant_record->>'consumedAt' IS NOT NULL
      ) AS nonce_consumed
    FROM cmai_state
    WHERE id = 'default'
  `;
  assert.deepEqual({
    grants: counts[0]?.grants,
    submissionReceipts: counts[0]?.submission_receipts,
    submissionRequestReceipts: counts[0]?.submission_request_receipts,
    contributions: counts[0]?.contributions,
    nonceConsumed: counts[0]?.nonce_consumed,
  }, {
    grants: attackerAdmissions + 1,
    submissionReceipts: 1,
    submissionRequestReceipts: 3,
    contributions: 1,
    nonceConsumed: true,
  });
  const coherentContributionRoot = (await admin`SELECT state FROM cmai_state WHERE id = 'default'`)[0]?.state as AgentFeedTransactionRoot;
  const coherentSubmissionPairingState = await firstPairingBackend.read();
  const feedMissingRequestEvidence = structuredClone(coherentContributionRoot);
  feedMissingRequestEvidence.agentFeedState.submissionRequestReceipts = feedMissingRequestEvidence.agentFeedState.submissionRequestReceipts
    .filter((receipt) => receipt.requestId !== signedSubmission.request_id);
  await admin`UPDATE cmai_state SET state = ${admin.json(feedMissingRequestEvidence)} WHERE id = 'default'`;
  let corruptReplayActionCount = 0;
  await assert.rejects(
    () => firstPairingService.authorizeAndExecute(signedSubmission, () => {
      corruptReplayActionCount += 1;
      return acceptedSubmission;
    }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "service_unavailable"),
    "pairing receipt without feed request evidence must fail before invoking the protected submission action",
  );
  assert.equal(corruptReplayActionCount, 0);
  await admin`UPDATE cmai_state SET state = ${admin.json(coherentContributionRoot)} WHERE id = 'default'`;

  const pairingMissingRequestEvidence = structuredClone(coherentSubmissionPairingState);
  pairingMissingRequestEvidence.authorizedRequestReceipts = pairingMissingRequestEvidence.authorizedRequestReceipts
    .filter((receipt) => receipt.requestId !== signedSubmission.request_id);
  await admin`UPDATE cmai_agent_pairing_state SET state = ${admin.json(pairingMissingRequestEvidence)} WHERE id = 'default'`;
  await assert.rejects(
    () => firstPairingService.authorizeAndExecute(signedSubmission, () => {
      corruptReplayActionCount += 1;
      return acceptedSubmission;
    }),
    (error: unknown) => Boolean(error && typeof error === "object" && "code" in error && error.code === "service_unavailable"),
    "feed request evidence without a pairing receipt must fail before invoking the protected submission action",
  );
  assert.equal(corruptReplayActionCount, 0);
  await admin`UPDATE cmai_agent_pairing_state SET state = ${admin.json(coherentSubmissionPairingState)} WHERE id = 'default'`;

  const wrongChallengeContributionRoot = structuredClone(coherentContributionRoot);
  wrongChallengeContributionRoot.contributions[0]!.challengeId = "challenge_wrong_persisted_reference";
  await admin`UPDATE cmai_state SET state = ${admin.json(wrongChallengeContributionRoot)} WHERE id = 'default'`;
  await assert.rejects(
    () => applyAgentProtocolStateV1(admin),
    /Agent feed state is missing or incompatible|contribution evidence is missing or inconsistent/,
    "migration must reject a submission receipt bound to the wrong contribution business truth",
  );
  await admin`UPDATE cmai_state SET state = ${admin.json(coherentContributionRoot)} WHERE id = 'default'`;
  await assert.rejects(rollbackAgentProtocolStateV1(admin), /refusing to roll back non-empty Agent pairing state|non-empty or incompatible/);
  assert.equal((await admin`SELECT COUNT(*)::int AS count FROM cmai_schema_migrations WHERE migration_id IN (${AGENT_FEED_STATE_V1_MIGRATION_ID}, ${AGENT_PAIRING_STATE_V1_MIGRATION_ID}, ${AGENT_FEED_STATE_V2_MIGRATION_ID})`)[0]?.count, 3);
  assert.equal((await admin`SELECT to_regclass('public.cmai_agent_pairing_state') AS table_name`)[0]?.table_name, "cmai_agent_pairing_state");

  await firstPairingBackend.transact((state) => {
    const networkBucket = state.rateLimitBuckets.find((bucket) => bucket.capacityClass === "network:agent_feed");
    const principalBucket = state.rateLimitBuckets.find((bucket) => bucket.capacityClass === "principal:feed.list");
    assert.ok(networkBucket && principalBucket, "rate proof requires persisted network and principal buckets");
    networkBucket.count = agentFeedNetworkPreauthRateLimit.limit;
    principalBucket.count = authenticatedAgentOperationRateLimits["feed.list"].limit;
  });
  const persistedBeforeRestart = await firstPairingBackend.read();
  const principalBeforeRestart = persistedBeforeRestart.rateLimitBuckets.find((bucket) => bucket.capacityClass === "principal:feed.list")?.count;
  await Promise.all([
    firstPairingBackend.close(),
    secondPairingBackend.close(),
    store.closePostgresStoreForTests(),
  ]);
  firstPairingBackend = undefined;
  secondPairingBackend = undefined;
  restartedPairingBackend = new PostgresPairingStateBackend(databaseUrl);
  const restartedPairingService = new PairingService(restartedPairingBackend, { clock: () => new Date(now) });
  const restartedFeedService = new AgentFeedProtocolService({
    pairingService: restartedPairingService,
    store: { transactAgentFeedRequest: transactPostgresAgentFeedRequest },
    cursorSecret: "postgres-proof-cursor-secret-32-byte-minimum",
    clock: () => new Date(now),
  });
  const responseAfterRestart = await restartedFeedService.execute(
    protocolServiceFeed,
    "network-pg-protocol-service",
    { networkRateLimitPrecharged: true },
  );
  assert.deepEqual(responseAfterRestart, protocolServiceFeedResponse, "exact feed response must survive pairing and store client restart");
  const persistedAfterRestart = await restartedPairingBackend.read();
  assert.equal(
    persistedAfterRestart.rateLimitBuckets.find((bucket) => bucket.capacityClass === "principal:feed.list")?.count,
    principalBeforeRestart,
    "exact replay after restart must not consume principal capacity",
  );
  const isRateLimited = (error: unknown) => Boolean(
    error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "rate_limited",
  );
  const networkBeforeRestartProof = persistedAfterRestart.rateLimitBuckets.find((bucket) => bucket.capacityClass === "network:agent_feed")?.count ?? 0;
  await assert.rejects(
    () => restartedPairingService.assertAgentFeedNetworkRateLimit({ identity: "network-pg-feed-proof" }),
    isRateLimited,
    "persisted network limit must continue returning rate_limited after restart",
  );
  const principalRateLimitedFeed = agentFeedListRequestSchema.parse(signedPairingRequest({
    operation: "feed.list",
    requestId: "req_pg_principal_rate_after_restart",
    sentAt: now.toISOString(),
    pairingId: pairing.pairing_id,
    key: pairingKey,
    payload: { limit: 10 },
  }));
  await assert.rejects(
    () => restartedFeedService.execute(principalRateLimitedFeed, "network-precharged", { networkRateLimitPrecharged: true }),
    isRateLimited,
    "persisted principal limit must continue returning rate_limited after restart",
  );
  const ratesAfterRestartProof = await restartedPairingBackend.read();
  assert.equal(
    ratesAfterRestartProof.rateLimitBuckets.find((bucket) => bucket.capacityClass === "network:agent_feed")?.count,
    networkBeforeRestartProof + 1,
  );
  assert.equal(
    ratesAfterRestartProof.rateLimitBuckets.find((bucket) => bucket.capacityClass === "principal:feed.list")?.count,
    (principalBeforeRestart ?? 0) + 1,
  );

  console.log(JSON.stringify({
    proof: "agent_feed_postgres_v1",
    readiness: "explicit_migration_only",
    migrationIds: [AGENT_FEED_STATE_V1_MIGRATION_ID, AGENT_PAIRING_STATE_V1_MIGRATION_ID, AGENT_FEED_STATE_V2_MIGRATION_ID],
    migrationInterruptedTransactionRolledBack: true,
    v2MigrationInterruptedTransactionRolledBack: true,
    populatedV1SubmissionUpgradedWithExactReplay: true,
    liveV1PerPairOverflowRequiresExplicitDrain: true,
    liveV1PerPairByteOverflowRequiresExplicitDrain: true,
    malformedExpiredV1ReadEvidenceRejectedWithoutMutation: true,
    expiredV1ReadEvidencePrunedAcrossBothRows: true,
    retainedV1SecondPairExactReplayAfterMigration: retainedReplay.replayed,
    retainedV1SecondPairExactReplayAfterByteDrain: byteRetainedReplay.replayed,
    incompatibleStateRejected: true,
    deepReferenceCorruptionRejected: true,
    crossStoreReplayCorruptionRejected: true,
    submissionBusinessTruthCorruptionRejected: true,
    preexistingUnexpectedPairingStateRowRejected: true,
    postgresPostOperationStateValidation: true,
    emptyStateRollbackReconciledLedger: true,
    unexpectedPairingStateRollbackRowRefused: true,
    migrationIdempotent: true,
    migrationRuntimeLockOrderRehearsal: true,
    pairingRowLockBlockedSecondTransaction: true,
    exactPairingReceiptReplay: true,
    productionServiceConcurrentExactReplay: true,
    productionServiceConcurrentGrantReplay: true,
    secondProductionCallObservedWaitingOnPairingRow: true,
    perPairingReadCacheByteFairness: true,
    attackerLargeReadAdmissions: attackerAdmissions,
    secondPairingAdmittedAfterAttackerQuota: true,
    exactReplayAfterPairingQuota: true,
    pairingAndFeedSharedTransaction: true,
    projectionErrorClassPreserved: true,
    atomicPairingFeedFailureRolledBack: true,
    postWritePairingFeedFailureRolledBack: true,
    exactReplaySurvivedRestart: true,
    persistedNetworkRateLimitSurvivedRestart: true,
    persistedNetworkAndPrincipalRateLimitExhaustionEnforcedAfterRestart: true,
    persistedPairingRateClasses: ["network:agent_feed", "principal:feed.list"],
    rowLockBlockedSecondTransaction: true,
    productionChallengeExecutorCalls,
    exactGrantReplay: true,
    freshRequestIdSubmissionReplay: aliasResult.requestReplayed === false,
    terminalSubmissionOutcomeExactReplay: true,
    preActionCrossStoreCoherenceValidated: corruptReplayActionCount === 0,
    signedPairingGrantNonceSubmissionChain: true,
    submissionOutcomes: submissionResults.map((result) => result.kind),
    persisted: { grants: counts[0]?.grants, submissionReceipts: 1, contributions: 1, nonceConsumed: true },
  }));
} finally {
  await Promise.allSettled([
    store?.closePostgresStoreForTests() ?? Promise.resolve(),
    firstPairingBackend?.close() ?? Promise.resolve(),
    secondPairingBackend?.close() ?? Promise.resolve(),
    restartedPairingBackend?.close() ?? Promise.resolve(),
    admin.end({ timeout: 1 }),
    firstClient.end({ timeout: 1 }),
    secondClient.end({ timeout: 1 }),
  ]);
}
