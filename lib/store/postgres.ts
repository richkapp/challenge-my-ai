import postgres from "postgres";
import { nanoid } from "nanoid";
import { env, isProductionLike } from "@/lib/config/env";
import { defaultContributionModeForRequestedModes, normalContributionModes, shortLabelForContributionMode } from "@/lib/contributionModes";
import { providerCatalogEntry } from "@/lib/agent-home/providerCatalog";
import { brokerCredentialRef, publicCredentialState, sealAgentCredential, sealAgentCredentialValue, sealRuntimeSecret, unsealAgentCredential, unsealRuntimeSecret, type SealedAgentCredentialRecord, type SealedRuntimeSecretRecord } from "@/lib/agent-home/brokerVault";
import type { AgentCredentialRecord } from "@/lib/agent-home/providerAdapters";
import type { AgentActivity, AgentActivityAction, AgentConnection, AgentConnectionStatus, AgentHome, AgentProfile, AgentRun, AgentWatch, Challenge, ChallengeBrief, ChallengeCriteriaQuarantineRecord, ChallengeCriteriaVersionRecord, ChallengePrivacySensitivity, CommunityVote, CommunityVoteResult, CommunityVoteValue, Contribution, ContributionCard, ContributionMode, CreditEvent, Job, ModelProxyGrantRecord, ModerationAction, ModerationActionResult, ModerationEvent, ModerationTargetType, Rating, SafetyFlag, SynthesisBrief } from "@/lib/types";
import { analyzeContentSafety } from "@/lib/safety/analyzeContent";
import { normalizeModerationReason, sanitizeModerationNote } from "@/lib/moderation/rules";
import { ratingCreditEventKind, rewardForRating } from "@/lib/credits/settlement";
import { buildCreditEvent, canSpendCredits, capUsefulnessReward, creditBalance, describeInsufficientCredits, netContributionCredit, normalizeChallengeReward, posterRatingCreditTotal } from "@/lib/credits/ledger";
import { assertCommunityVoteAllowed, buildCommunityVoteDecision } from "@/lib/community/voting";
import { buildSynthesisBrief } from "@/lib/ai/synthesis";
import { launchSeedChallenges } from "@/lib/store/launchSeeds";
import { assertAgentRunCaps } from "@/lib/agent-home/runCaps";
import { HttpError } from "@/lib/api/responses";
import { assertRateLimitPolicy } from "@/lib/security/rateLimit";
import { selectPublicContributorProfileData } from "@/lib/store/publicProfile";
import { isChallengePubliclyEligible, type ChallengeCriteriaStatus, type ChallengeCriterionEvidence, type ChallengeIntent, type ChallengeSuccessfulOutcome } from "@/lib/challenges/intent";
import { canonicalChallengePublicationAcknowledgementBrief } from "@/lib/challenges/intentAcknowledgement";
import { createContributionRecordInState } from "@/lib/store/contributionTransaction";
import {
  AgentFeedStoreError,
  assertAgentFeedPersistedRootV1,
  emptyAgentFeedPersistedState,
  inspectAgentFeedState,
  normalizeAgentFeedPersistedState,
  queryAgentFeedState,
  submitAgentFeedContributionState,
  transactAgentFeedRequestState,
  type AgentFeedQueryInput,
  type AgentFeedQueryResult,
  type AgentFeedRequestExecutor,
  type AgentFeedRequestTransactionInput,
  type AgentFeedRequestTransactionResult,
  type AgentFeedStoreReadiness,
  type AgentFeedSubmissionInput,
  type AgentFeedTransactionalStore,
  type AgentSubmissionAcceptResult,
} from "@/lib/store/agentFeed";
import { AgentFeedProjectionError } from "@/lib/agent-feed/egress";
import { canonicalizeNewChallengeBrief, challengeCriteriaHistory, evaluatePersistedChallengeClosure, initializeChallengeCriteriaPersistence, migrateChallengeCriteriaState, refreshChallengePublicEligibility, revisePersistedChallengeCriteria } from "@/db/migrations/challenge-criteria-v1";

type StoredAgentHome = Omit<AgentHome, "connections" | "setupStatus">;
type CodexLoginLease = { ownerId: string; leaseId: string; expiresAt: string };
type ClaudeCodeLoginAttempt = { ownerId: string; attemptId: string; expiresAt: string; codeSecret?: SealedRuntimeSecretRecord; codeTakenAt?: string };

type State = {
  challenges: Challenge[];
  challengeCriteriaVersions: ChallengeCriteriaVersionRecord[];
  challengeCriteriaQuarantine: ChallengeCriteriaQuarantineRecord[];
  contributions: Contribution[];
  ratings: Rating[];
  communityVotes: CommunityVote[];
  creditEvents: CreditEvent[];
  synthesisBriefs: SynthesisBrief[];
  jobs: Job[];
  moderationEvents: ModerationEvent[];
  agentProfiles: AgentProfile[];
  agentWatches: AgentWatch[];
  agentActivity: AgentActivity[];
  agentHomes: StoredAgentHome[];
  agentConnections: AgentConnection[];
  agentCredentialVault: SealedAgentCredentialRecord[];
  runtimeSecrets: SealedRuntimeSecretRecord[];
  modelProxyGrants: ModelProxyGrantRecord[];
  agentRuns: AgentRun[];
  codexLoginLeases: CodexLoginLease[];
  claudeCodeLoginAttempts: ClaudeCodeLoginAttempt[];
  agentFeedState: ReturnType<typeof emptyAgentFeedPersistedState>;
};

const emptyState = (): State => ({
  challenges: [],
  challengeCriteriaVersions: [],
  challengeCriteriaQuarantine: [],
  contributions: [],
  ratings: [],
  communityVotes: [],
  creditEvents: [],
  synthesisBriefs: [],
  jobs: [],
  moderationEvents: [],
  agentProfiles: [],
  agentWatches: [],
  agentActivity: [],
  agentHomes: [],
  agentConnections: [],
  agentCredentialVault: [],
  runtimeSecrets: [],
  modelProxyGrants: [],
  agentRuns: [],
  codexLoginLeases: [],
  claudeCodeLoginAttempts: [],
  agentFeedState: emptyAgentFeedPersistedState(),
});

let memory: State | undefined;

function now() {
  return new Date().toISOString();
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function appendCreditEventInState(state: State, input: { userId: string; challengeId?: string; contributionId?: string; amount: number; reason: string; kind?: CreditEvent["kind"]; source?: CreditEvent["source"]; idempotencyKey?: string; metadata?: CreditEvent["metadata"] }): CreditEvent {
  const existing = input.idempotencyKey ? state.creditEvents.find((event) => event.idempotencyKey === input.idempotencyKey) : undefined;
  if (existing) return clone(existing);
  const amount = Number.isFinite(input.amount) ? Math.round(input.amount) : 0;
  const kind = input.kind ?? (amount >= 0 ? "grant" : "spend");
  if (kind === "spend" && amount < 0) {
    const spend = canSpendCredits(state.creditEvents, { userId: input.userId, amount: Math.abs(amount) });
    if (!spend.ok) throw new Error(describeInsufficientCredits(spend));
  }
  const event = buildCreditEvent({
    ...input,
    amount,
    kind,
    id: nanoid(10),
    createdAt: now(),
    balanceAfter: creditBalance(state.creditEvents, input.userId) + amount,
  });
  state.creditEvents.unshift(event);
  return clone(event);
}

function posterRatingCreditKey(contributionId: string, ratingId: string) {
  return `poster-rating:${contributionId}:${ratingId}`;
}

function posterRatingAwardTotal(state: State, contribution: Contribution) {
  const legacyTotal = state.creditEvents
    .filter((event) => event.contributionId === contribution.id && event.userId === contribution.contributorId)
    .filter((event) => !event.source && event.reason.startsWith("Poster rating delta"))
    .reduce((sum, event) => sum + event.amount, 0);
  return legacyTotal + posterRatingCreditTotal(state.creditEvents, { userId: contribution.contributorId, contributionId: contribution.id });
}

function applyModerationCreditAdjustmentsForChallenge(state: State, input: { challengeId: string; actorId: string; reason: string }) {
  const contributions = state.contributions.filter((contribution) => contribution.challengeId === input.challengeId);
  for (const contribution of contributions) {
    applyModerationCreditAdjustmentForContribution(state, { contribution, actorId: input.actorId, reason: input.reason, scopeId: input.challengeId });
  }
}

function applyModerationCreditAdjustmentForContribution(state: State, input: { contribution: Contribution; actorId: string; reason: string; scopeId: string }) {
  const net = netContributionCredit(state.creditEvents, { userId: input.contribution.contributorId, contributionId: input.contribution.id });
  if (net <= 0) return;
  appendCreditEventInState(state, {
    userId: input.contribution.contributorId,
    challengeId: input.contribution.challengeId,
    contributionId: input.contribution.id,
    amount: -net,
    kind: "moderation_adjustment",
    source: "moderator",
    idempotencyKey: `moderation:${input.scopeId}:${input.contribution.id}`,
    reason: `Moderator adjustment reversed ${net} credits after moderation action: ${input.reason}`,
    metadata: { actorId: input.actorId },
  });
}

type ResolvedModerationTarget = {
  targetType: ModerationTargetType;
  targetId: string;
  resolvedTargetType: "challenge" | "contribution";
  resolvedTargetId: string;
  challenge?: Challenge;
  contribution?: Contribution;
};

function resolveModerationTargetInState(state: State, input: { targetType: ModerationTargetType; targetId: string }): ResolvedModerationTarget {
  if (input.targetType === "contribution") {
    const contribution = state.contributions.find((item) => item.id === input.targetId);
    if (!contribution) throw new Error("Contribution not found.");
    const challenge = state.challenges.find((item) => item.id === contribution.challengeId);
    if (!challenge) throw new Error("Challenge not found.");
    return { targetType: input.targetType, targetId: input.targetId, resolvedTargetType: "contribution", resolvedTargetId: contribution.id, challenge, contribution };
  }
  const challenge = state.challenges.find((item) => item.id === input.targetId);
  if (!challenge) throw new Error(input.targetType === "artifact" ? "Decision artifact not found." : "Challenge not found.");
  if (input.targetType === "artifact" && !state.synthesisBriefs.some((brief) => brief.challengeId === challenge.id)) {
    throw new Error("Decision artifact not found.");
  }
  return { targetType: input.targetType, targetId: input.targetId, resolvedTargetType: "challenge", resolvedTargetId: challenge.id, challenge };
}

function recordModerationEventInState(state: State, input: { target: ResolvedModerationTarget; action: ModerationAction; reason: string; actorId?: string; note?: string }): ModerationEvent {
  const event: ModerationEvent = {
    id: nanoid(10),
    targetType: input.target.targetType,
    targetId: input.target.targetId,
    resolvedTargetType: input.target.resolvedTargetType,
    resolvedTargetId: input.target.resolvedTargetId,
    actorId: input.actorId || (input.action === "report" ? "local-user" : "local-moderator"),
    action: input.action,
    reason: normalizeModerationReason(input.reason),
    note: sanitizeModerationNote(input.note),
    createdAt: now(),
  };
  state.moderationEvents.unshift(event);
  return event;
}

function moderateTargetInState(state: State, input: { targetType: ModerationTargetType; targetId: string; action: Exclude<ModerationAction, "report">; reason: string; actorId?: string; note?: string }): ModerationActionResult {
  const target = resolveModerationTargetInState(state, input);
  if (target.resolvedTargetType === "challenge") {
    const challenge = target.challenge;
    if (!challenge) throw new Error("Challenge not found.");
    if (input.action === "suppress") {
      challenge.status = "suppressed";
      challenge.updatedAt = now();
      applyModerationCreditAdjustmentsForChallenge(state, { challengeId: challenge.id, actorId: input.actorId || "local-moderator", reason: input.reason });
    } else {
      restoreChallengeStatusInState(state, challenge);
    }
    challenge.publicEligibility = refreshChallengePublicEligibility(challenge, state.challengeCriteriaVersions).publicEligibility;
    const event = recordModerationEventInState(state, { target, action: input.action, reason: input.reason, actorId: input.actorId, note: input.note });
    return { event: clone(event), challenge: withDerivedChallenge(state, challenge) };
  }

  const contribution = target.contribution;
  const challenge = target.challenge;
  if (!contribution || !challenge) throw new Error("Contribution not found.");
  if (input.action === "suppress") {
    contribution.status = "suppressed";
    applyModerationCreditAdjustmentForContribution(state, { contribution, actorId: input.actorId || "local-moderator", reason: input.reason, scopeId: contribution.id });
    refreshChallengeLifecycleInState(state, challenge);
  } else {
    if (!isChallengePubliclyEligible(challenge)) throw new Error("Challenge is unavailable for public interaction.");
    contribution.status = "posted";
    refreshChallengeLifecycleInState(state, challenge);
  }
  challenge.updatedAt = now();
  const event = recordModerationEventInState(state, { target, action: input.action, reason: input.reason, actorId: input.actorId, note: input.note });
  return { event: clone(event), challenge: withDerivedChallenge(state, challenge), contribution: withDerivedContribution(state, contribution) };
}

let sqlClient: ReturnType<typeof postgres> | undefined;

function sql() {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required for the Postgres store adapter.");
  sqlClient ??= postgres(env.DATABASE_URL, { max: 1, prepare: false });
  return sqlClient;
}

export async function closePostgresStoreForTests(): Promise<void> {
  if (!sqlClient) return;
  await sqlClient.end({ timeout: 1 });
  sqlClient = undefined;
}

async function ensureStateTable() {
  await sql()`CREATE TABLE IF NOT EXISTS cmai_state (id text PRIMARY KEY, state jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())`;
  await sql()`
    INSERT INTO cmai_state (id, state, updated_at)
    VALUES ('default', ${sql().json(emptyState())}, now())
    ON CONFLICT (id) DO NOTHING
  `;
}

function normalizeState(raw: Partial<State> | undefined): State {
  const state: State = { ...emptyState(), ...(raw || {}) };
  state.agentFeedState = normalizeAgentFeedPersistedState(raw?.agentFeedState);
  state.contributions = state.contributions.map((contribution) => {
    const { contributorKind, contributorLabel, ...rest } = contribution as Contribution & Partial<Pick<Contribution, "contributorKind" | "contributorLabel">>;
    return {
      ...rest,
      contributorKind: contributorKind ?? "human",
      contributorLabel: contributorLabel ?? contribution.contributorId,
    };
  });
  return migrateChallengeCriteriaState(state).state as State;
}

async function loadState(): Promise<State> {
  await ensureStateTable();
  const rows = await sql()`SELECT state FROM cmai_state WHERE id = 'default' LIMIT 1`;
  const state = normalizeState(rows[0]?.state as Partial<State> | undefined);
  memory = state;
  return state;
}

async function saveState(state: State) {
  memory = state;
  await ensureStateTable();
  await sql()`
    INSERT INTO cmai_state (id, state, updated_at)
    VALUES ('default', ${sql().json(state)}, now())
    ON CONFLICT (id) DO UPDATE SET state = EXCLUDED.state, updated_at = now()
  `;
}

async function mutate<T>(fn: (state: State) => T): Promise<T> {
  await ensureStateTable();
  const transactionResult = await sql().begin(async (tx) => {
    const rows = await tx`SELECT state FROM cmai_state WHERE id = 'default' FOR UPDATE`;
    const state = normalizeState(rows[0]?.state as Partial<State> | undefined);
    const result = fn(state);
    await tx`
      UPDATE cmai_state
      SET state = ${tx.json(state)}, updated_at = now()
      WHERE id = 'default'
    `;
    memory = state;
    return result;
  });
  return transactionResult as T;
}

async function loadAgentFeedStateReadOnly(): Promise<{ readiness: AgentFeedStoreReadiness; state?: State }> {
  try {
    const tables = await sql()`SELECT to_regclass('public.cmai_state') AS table_name`;
    if (!tables[0]?.table_name) return { readiness: { ready: false, reason: "state_table_missing" } };
    const rows = await sql()`SELECT state FROM cmai_state WHERE id = 'default' LIMIT 1`;
    if (!rows[0]) return { readiness: { ready: false, reason: "state_row_missing" } };
    const readiness = inspectAgentFeedState(rows[0].state);
    return readiness.ready
      ? { readiness, state: normalizeState(rows[0].state as Partial<State>) }
      : { readiness };
  } catch {
    return { readiness: { ready: false, reason: "store_unavailable" } };
  }
}

export async function getAgentFeedStoreReadiness(): Promise<AgentFeedStoreReadiness> {
  return (await loadAgentFeedStateReadOnly()).readiness;
}

export async function queryAgentFeed(input: AgentFeedQueryInput): Promise<AgentFeedQueryResult> {
  const loaded = await loadAgentFeedStateReadOnly();
  if (!loaded.readiness.ready) {
    throw new AgentFeedStoreError("store_not_ready", `Agent feed store is not ready: ${loaded.readiness.reason}.`);
  }
  if (!loaded.state) throw new AgentFeedStoreError("store_not_ready", "Agent feed state could not be loaded.");
  return queryAgentFeedState(loaded.state, input);
}

async function agentFeedMutateInTransaction<T>(
  transaction: postgres.TransactionSql,
  operation: (state: State) => T,
): Promise<T> {
  const rows = await transaction`SELECT state FROM cmai_state WHERE id = 'default' FOR UPDATE`;
  if (!rows[0]) throw new AgentFeedStoreError("store_not_ready", "Agent feed state row is missing.");
  const readiness = inspectAgentFeedState(rows[0].state);
  if (!readiness.ready) throw new AgentFeedStoreError("store_not_ready", `Agent feed state is not ready: ${readiness.reason}.`);
  const state = normalizeState(rows[0].state as Partial<State>);
  const result = operation(state);
  assertAgentFeedPersistedRootV1(state as unknown as Record<string, unknown>);
  await transaction`
    UPDATE cmai_state
    SET state = ${transaction.json(state)}, updated_at = now()
    WHERE id = 'default'
  `;
  return result;
}

export function createAgentFeedTransactionalStore(transaction: postgres.TransactionSql): AgentFeedTransactionalStore {
  return {
    transactAgentFeedRequest: async (input, execute, transactionTime = new Date()) => (
      await agentFeedMutateInTransaction(
        transaction,
        (state) => transactAgentFeedRequestState(state, input, execute, transactionTime),
      )
    ),
    submitAgentFeedContribution: async (input, transactionTime = new Date()) => (
      await agentFeedMutateInTransaction(
        transaction,
        (state) => submitAgentFeedContributionState(state, input, transactionTime),
      )
    ),
  };
}

async function agentFeedMutate<T>(operation: (state: State) => T): Promise<T> {
  try {
    return await sql().begin((transaction) => agentFeedMutateInTransaction(transaction, operation)) as T;
  } catch (error) {
    if (error instanceof AgentFeedStoreError || error instanceof AgentFeedProjectionError) throw error;
    throw new AgentFeedStoreError("store_not_ready", "Agent feed transaction failed before commit.");
  }
}

export async function transactAgentFeedRequest(
  input: AgentFeedRequestTransactionInput,
  execute: AgentFeedRequestExecutor,
  transactionTime = new Date(),
): Promise<AgentFeedRequestTransactionResult> {
  return await agentFeedMutate((state) => transactAgentFeedRequestState(state, input, execute, transactionTime));
}

export async function submitAgentFeedContribution(
  input: AgentFeedSubmissionInput,
  transactionTime = new Date(),
): Promise<AgentSubmissionAcceptResult> {
  return await agentFeedMutate((state) => submitAgentFeedContributionState(state, input, transactionTime));
}

function assertFiniteRating(value: number, name: string) {
  if (!Number.isFinite(value) || value < 0 || value > 10) throw new Error(`${name} must be a finite number from 0 to 10.`);
}

function challengeContributionCount(state: State, challengeId: string) {
  return state.contributions.filter((contribution) => contribution.challengeId === challengeId && contribution.status === "posted").length;
}

function agentContributionCount(state: State, agentId: string) {
  return state.contributions.filter((contribution) => contribution.contributorKind === "agent" && contribution.contributorId === agentId && contribution.status === "posted").length;
}

function agentWatchCount(state: State, agentId: string) {
  return state.agentWatches.filter((watch) => watch.agentId === agentId).length;
}

function withDerivedChallenge(state: State, challenge: Challenge): Challenge {
  return { ...clone(challenge), contributionCount: challengeContributionCount(state, challenge.id) };
}

function withDerivedContribution(state: State, contribution: Contribution): Contribution {
  return { ...clone(contribution), opRating: state.ratings.filter((rating) => rating.contributionId === contribution.id).at(-1) };
}

function withDerivedAgent(state: State, agent: AgentProfile): AgentProfile {
  return { ...clone(agent), contributionCount: agentContributionCount(state, agent.id), watchCount: agentWatchCount(state, agent.id) };
}

function agentHomeIdFor(ownerId: string) {
  return `agent-home-${ownerId.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "local-user"}`;
}

function readinessForStatus(status: AgentConnectionStatus, message?: string): AgentConnection["readiness"] {
  if (status === "ready") {
    return {
      state: "ready",
      label: "Ready for Run my Agent here",
      detail: message || "The connection passed its smoke test and can request a sandboxed run after per-challenge approval.",
      canRunHere: true,
    };
  }
  if (status === "smoke_failed") {
    return {
      state: "smoke_failed",
      label: "Setup needs attention",
      detail: message || "The latest smoke test failed. Manual paste still works while you fix the connection.",
      canRunHere: false,
    };
  }
  if (status === "paused") {
    return {
      state: "paused",
      label: "Paused",
      detail: "This connection is paused and cannot run on challenges until it is resumed.",
      canRunHere: false,
    };
  }
  if (status === "needs_reconnect") {
    return {
      state: "unavailable",
      label: "Reconnect needed",
      detail: "The connection needs fresh setup before it can run in a child sandbox.",
      canRunHere: false,
    };
  }
  if (status === "revoked") {
    return {
      state: "unavailable",
      label: "Revoked",
      detail: "This provider connection was revoked. Reconnect provider access before using Run my Agent here.",
      canRunHere: false,
    };
  }
  return {
    state: "setup_needed",
    label: "Smoke test needed",
    detail: "Connect an Agent and pass a smoke test before using Run my Agent here.",
    canRunHere: false,
  };
}

function credentialRecordForConnection(state: State, connection: Pick<AgentConnection, "id" | "ownerId" | "provider">) {
  return state.agentCredentialVault.find((record) => record.connectionId === connection.id && record.ownerId === connection.ownerId && record.provider === connection.provider && !record.revokedAt);
}

function providerComplianceFields(connection: Pick<AgentConnection, "provider">) {
  const entry = providerCatalogEntry(connection.provider);
  return {
    liveModelProxyCaller: entry.liveModelProxyCaller,
    providerReadiness: entry.providerReadiness,
    authClass: entry.authClass,
    countsForMvpUserPlan: entry.countsForMvpUserPlan,
    authSetupLabel: entry.authSetupLabel,
    authReadinessCopy: entry.authReadinessCopy,
    setupMechanisms: [...entry.setupMechanisms],
    complianceCopy: entry.complianceCopy,
    manualPasteFallbackCopy: entry.manualPasteFallbackCopy,
  };
}

function withProviderReadiness(connection: AgentConnection): AgentConnection {
  const entry = providerCatalogEntry(connection.provider);
  const next: AgentConnection = { ...connection, ...providerComplianceFields(connection) };
  const localFakeDevReady = entry.id === "local_fake" && !isProductionLike();
  if (connection.status === "ready" && !entry.liveModelProxyCaller) {
    next.readiness = {
      state: "unavailable",
      label: "Provider adapter pending",
      detail: `${entry.label} setup is saved, but a live broker caller is not enabled yet. ${entry.manualPasteFallbackCopy}`,
      canRunHere: false,
    };
  } else if (connection.status === "ready" && !entry.countsForMvpUserPlan && !localFakeDevReady) {
    next.readiness = {
      state: "unavailable",
      label: entry.authClass === "api_only" ? "API-only scaffold ready" : "User-plan auth pending",
      detail: `${entry.label} smoke/setup may be saved, but ${entry.authReadinessCopy} ${entry.manualPasteFallbackCopy}`,
      canRunHere: false,
    };
  }
  return next;
}

function withCredentialState(state: State, connection: AgentConnection): AgentConnection {
  return withProviderReadiness({ ...connection, ...publicCredentialState(credentialRecordForConnection(state, connection)) });
}

function appendConnectionAudit(connection: AgentConnection, action: NonNullable<AgentConnection["auditTrail"]>[number]["action"], summary: string, options: { redacted?: boolean } = {}) {
  connection.auditTrail = [
    { id: nanoid(10), action, summary, createdAt: now(), redacted: options.redacted },
    ...(connection.auditTrail || []),
  ].slice(0, 20);
}

function modelProxyStoreError(code: string, message: string, status = 400, issues: string[] = [], details?: unknown) {
  return Object.assign(new Error(message), { code, status, issues, details });
}

function assertModelProxyGrantAttemptRateLimit(input: { delegationId: string; runId: string; agentConnectionId: string }) {
  try {
    assertRateLimitPolicy("model_proxy_dispatch", `delegation:${input.delegationId}:run:${input.runId}:connection:${input.agentConnectionId}`);
  } catch (error) {
    if (error instanceof HttpError && error.code === "rate_limited") {
      throw modelProxyStoreError("MODEL_PROXY_RATE_LIMITED", error.message, 429, [], error.details);
    }
    throw error;
  }
}

function withDerivedAgentHome(state: State, home: StoredAgentHome): AgentHome {
  const connections = state.agentConnections.filter((connection) => connection.agentHomeId === home.id).map((connection) => withCredentialState(state, clone(connection)));
  return {
    ...clone(home),
    setupStatus: connections.some((connection) => connection.readiness.canRunHere) ? "ready" : "setup_required",
    connections,
  };
}

function ensureAgentHomeInState(state: State, input: { ownerId: string; ownerLabel?: string }): StoredAgentHome {
  const at = now();
  const id = agentHomeIdFor(input.ownerId);
  const existing = state.agentHomes.find((home) => home.id === id);
  if (existing) {
    existing.ownerLabel = input.ownerLabel || existing.ownerLabel;
    existing.updatedAt = at;
    return existing;
  }
  const home: StoredAgentHome = {
    id,
    ownerId: input.ownerId,
    ownerLabel: input.ownerLabel || input.ownerId,
    createdAt: at,
    updatedAt: at,
    lastActivityAt: at,
  };
  state.agentHomes.unshift(home);
  return home;
}

function recordAgentActivityInState(state: State, input: { agent: AgentProfile; action: AgentActivityAction; summary: string; challengeId?: string; contributionId?: string }): AgentActivity {
  const activity: AgentActivity = {
    id: nanoid(10),
    agentId: input.agent.id,
    agentLabel: input.agent.label,
    action: input.action,
    challengeId: input.challengeId,
    contributionId: input.contributionId,
    summary: input.summary,
    createdAt: now(),
  };
  state.agentActivity.unshift(activity);
  state.agentActivity = state.agentActivity.slice(0, 200);
  return clone(activity);
}

function ensureAgentInState(state: State, input: { id: string; label?: string; ownerId?: string; description?: string; capabilities?: ContributionMode[] }, options: { touch?: boolean } = {}): AgentProfile {
  const at = now();
  const existing = state.agentProfiles.find((agent) => agent.id === input.id);
  if (existing) {
    existing.label = input.label || existing.label;
    existing.ownerId = input.ownerId || existing.ownerId;
    existing.description = input.description || existing.description;
    if (input.capabilities?.length) existing.capabilities = Array.from(new Set([...existing.capabilities, ...input.capabilities]));
    if (options.touch !== false) existing.lastActiveAt = at;
    return existing;
  }

  const agent: AgentProfile = {
    id: input.id,
    ownerId: input.ownerId || "local-owner",
    label: input.label || input.id,
    description: input.description || "Local MVP agent participant.",
    status: "active",
    capabilities: input.capabilities?.length ? input.capabilities : ["critique"],
    createdAt: at,
    lastActiveAt: at,
    contributionCount: 0,
    watchCount: 0,
  };
  state.agentProfiles.unshift(agent);
  recordAgentActivityInState(state, { agent, action: "registered", summary: `${agent.label} registered as an agent participant.` });
  return agent;
}

function createContributionInState(state: State, input: { challengeId: string; contributorId?: string; contributorKind?: "human" | "agent"; contributorLabel?: string; card: ContributionCard; externallyGenerated?: boolean }): Contribution {
  const contributorId = input.contributorId || "local-contributor";
  return createContributionRecordInState(state, {
    contributionId: nanoid(10),
    challengeId: input.challengeId,
    contributorId,
    contributorKind: input.contributorKind || "human",
    contributorLabel: input.contributorLabel || contributorId,
    card: input.card,
    externallyGenerated: input.externallyGenerated !== false,
    createdAt: now(),
  });
}

function derivedPublicChallengeStatus(state: State, challenge: Challenge): Challenge["status"] {
  const posted = state.contributions.filter((item) => item.challengeId === challenge.id && item.status === "posted");
  const usefulRated = posted.some((contribution) => {
    const rating = withDerivedContribution(state, contribution).opRating;
    return (rating?.usefulness ?? 0) >= 7 && (rating?.safety ?? 5) >= 5;
  });
  return posted.length >= 2 || usefulRated ? "ready_for_synthesis" : posted.length >= 1 ? "contributing" : "open";
}

function restoreChallengeStatusInState(state: State, challenge: Challenge) {
  challenge.status = state.synthesisBriefs.some((brief) => brief.challengeId === challenge.id) ? "synthesized" : derivedPublicChallengeStatus(state, challenge);
  challenge.updatedAt = now();
}

function refreshChallengeLifecycleInState(state: State, challenge: Challenge) {
  if (["draft", "suppressed", "synthesized", "closed"].includes(challenge.status)) return;
  const nextStatus = derivedPublicChallengeStatus(state, challenge);
  if (challenge.status !== nextStatus) challenge.status = nextStatus;
  challenge.updatedAt = now();
}

export async function resetStoreForTests() {
  memory = emptyState();
  await saveState(memory);
}

export async function createChallenge(input: { id?: string; posterId?: string; visibility: "public" | "private"; reward: number; brief: ChallengeBrief; safetyFlags?: SafetyFlag[] }): Promise<Challenge> {
  return await mutate((state) => {
    const at = now();
    const brief = canonicalizeNewChallengeBrief(input.brief, { publicWrite: input.visibility === "public" });
    const contentForSafety = [brief.problem_statement, brief.original_ai_answer, brief.context, ...brief.success_criteria, ...brief.abuse_or_safety_flags].join("\n");
    const safetyFlags = input.safetyFlags ?? analyzeContentSafety(contentForSafety);
    const challenge: Challenge = {
      id: input.id || nanoid(10),
      createdAt: at,
      updatedAt: at,
      posterId: input.posterId || "local-challenge-poster",
      status: "open",
      title: brief.title,
      category: brief.category,
      visibility: input.visibility,
      reward: normalizeChallengeReward(input.reward),
      requestedModes: brief.challenge_mode_requested,
      brief: clone(brief),
      safetyFlags,
      contributionCount: 0,
    };
    const initialized = initializeChallengeCriteriaPersistence(challenge, challenge.posterId);
    state.challenges.unshift(initialized.challenge);
    state.challengeCriteriaVersions.push(...initialized.versions);
    return withDerivedChallenge(state, initialized.challenge);
  });
}

export async function listChallenges(filters: Partial<{ category: string; mode: ContributionMode; status: string }> = {}): Promise<Challenge[]> {
  const state = await loadState();
  const quarantined = new Set(state.challengeCriteriaQuarantine.map((entry) => entry.challengeId));
  return state.challenges
    .filter((challenge) => !quarantined.has(challenge.id) && isChallengePubliclyEligible(challenge))
    .filter((challenge) => !filters.category || challenge.category === filters.category)
    .filter((challenge) => !filters.mode || challenge.requestedModes.includes(filters.mode))
    .filter((challenge) => !filters.status || challenge.status === filters.status)
    .map((challenge) => withDerivedChallenge(state, challenge));
}

export async function getChallenge(id: string): Promise<Challenge | undefined> {
  const state = await loadState();
  if (state.challengeCriteriaQuarantine.some((entry) => entry.challengeId === id)) return undefined;
  const challenge = state.challenges.find((item) => item.id === id);
  return challenge ? withDerivedChallenge(state, challenge) : undefined;
}

export async function getChallengeCriteriaHistory(challengeId: string) {
  const state = await loadState();
  if (state.challengeCriteriaQuarantine.some((entry) => entry.challengeId === challengeId)) return undefined;
  const challenge = state.challenges.find((item) => item.id === challengeId);
  return challenge ? challengeCriteriaHistory(challenge, state.challengeCriteriaVersions) : undefined;
}

export async function updateChallengeCriteria(input: {
  challengeId: string;
  posterId: string;
  expectedVersion: number;
  intent: ChallengeIntent;
  successCriteria: string[];
  requestedPerspectives?: ContributionMode[];
  constraints?: string[];
  missingInformation?: string[];
  sensitivity?: ChallengePrivacySensitivity;
  status: ChallengeCriteriaStatus;
  changeReason: string;
}): Promise<Challenge> {
  return await mutate((state) => {
    if (state.challengeCriteriaQuarantine.some((entry) => entry.challengeId === input.challengeId)) throw new Error("Challenge criteria are unavailable.");
    const index = state.challenges.findIndex((challenge) => challenge.id === input.challengeId);
    const challenge = state.challenges[index];
    if (!challenge) throw new Error("Challenge not found.");
    const revised = revisePersistedChallengeCriteria({
      ...input,
      challenge,
      versions: state.challengeCriteriaVersions.filter((entry) => entry.challengeId === challenge.id),
      contributionCount: challengeContributionCount(state, challenge.id),
      at: now(),
    });
    state.challenges[index] = revised.challenge;
    state.challengeCriteriaVersions.push(revised.version);
    return withDerivedChallenge(state, revised.challenge);
  });
}

export async function evaluateChallengeClosure(input: {
  challengeId: string;
  posterId: string;
  outcome: ChallengeSuccessfulOutcome;
  criteriaVersion: number;
  criterionEvidence: ChallengeCriterionEvidence[];
  missingInformationEvidence: Array<{ item_number: number; evidence: string }>;
}) {
  const state = await loadState();
  if (state.challengeCriteriaQuarantine.some((entry) => entry.challengeId === input.challengeId)) return { eligible: false as const, reasons: ["invalid_persisted_history"] };
  const challenge = state.challenges.find((item) => item.id === input.challengeId);
  if (!challenge) return { eligible: false as const, reasons: ["challenge_not_found"] };
  return evaluatePersistedChallengeClosure({
    ...input,
    challenge: withDerivedChallenge(state, challenge),
    history: challengeCriteriaHistory(challenge, state.challengeCriteriaVersions),
  });
}

export async function createContribution(input: { challengeId: string; contributorId?: string; contributorKind?: "human" | "agent"; contributorLabel?: string; card: ContributionCard; externallyGenerated?: boolean }): Promise<Contribution> {
  return await mutate((state) => withDerivedContribution(state, createContributionInState(state, input)));
}

export async function createAgentContribution(input: { agentId: string; agentLabel?: string; ownerId?: string; challengeId: string; card: ContributionCard; externallyGenerated?: boolean }): Promise<Contribution> {
  return await mutate((state) => {
    const agent = ensureAgentInState(state, { id: input.agentId, label: input.agentLabel, ownerId: input.ownerId, capabilities: [input.card.contribution_mode] });
    const contribution = createContributionInState(state, {
      challengeId: input.challengeId,
      contributorId: agent.id,
      contributorKind: "agent",
      contributorLabel: agent.label,
      card: input.card,
      externallyGenerated: input.externallyGenerated,
    });
    agent.lastActiveAt = now();
    recordAgentActivityInState(state, {
      agent,
      action: "submitted_contribution",
      challengeId: input.challengeId,
      contributionId: contribution.id,
      summary: `${agent.label} submitted a ${shortLabelForContributionMode(input.card.contribution_mode)} contribution.`,
    });
    return withDerivedContribution(state, contribution);
  });
}

export async function listContributions(challengeId: string): Promise<Contribution[]> {
  const state = await loadState();
  return state.contributions.filter((contribution) => contribution.challengeId === challengeId && contribution.status === "posted").map((contribution) => withDerivedContribution(state, contribution));
}

export async function getContribution(id: string): Promise<Contribution | undefined> {
  const state = await loadState();
  const contribution = state.contributions.find((item) => item.id === id);
  return contribution ? withDerivedContribution(state, contribution) : undefined;
}

export async function rateContribution(input: { contributionId: string; raterId?: string; usefulness: number; novelty?: number; correctness?: number; safety?: number; comment?: string }): Promise<Rating> {
  return await mutate((state) => {
    const contribution = state.contributions.find((item) => item.id === input.contributionId);
    if (!contribution) throw new Error("Contribution not found.");
    const challenge = state.challenges.find((item) => item.id === contribution.challengeId);
    if (!challenge || !isChallengePubliclyEligible(challenge)) throw new Error("Challenge not found.");

    const usefulness = input.usefulness;
    const novelty = input.novelty ?? input.usefulness;
    const correctness = input.correctness ?? input.usefulness;
    const safety = input.safety ?? 5;
    assertFiniteRating(usefulness, "usefulness");
    assertFiniteRating(novelty, "novelty");
    assertFiniteRating(correctness, "correctness");
    assertFiniteRating(safety, "safety");

    const at = now();
    const raterId = input.raterId || "local-challenge-poster";
    const rating: Rating = { id: nanoid(10), contributionId: input.contributionId, raterId, usefulness, novelty, correctness, safety, comment: input.comment || "", createdAt: at };
    state.ratings.push(rating);

    const targetAward = rewardForRating({ usefulness, safety, challengeReward: challenge.reward });
    const existingAward = posterRatingAwardTotal(state, contribution);
    const desiredDelta = targetAward - existingAward;
    const delta = desiredDelta > 0
      ? capUsefulnessReward(state.creditEvents, { userId: contribution.contributorId, desiredDelta, nowIso: at })
      : desiredDelta;
    if (delta !== 0) {
      appendCreditEventInState(state, {
        userId: contribution.contributorId,
        challengeId: contribution.challengeId,
        contributionId: contribution.id,
        amount: delta,
        kind: ratingCreditEventKind(delta),
        source: "challenge_poster",
        idempotencyKey: posterRatingCreditKey(contribution.id, rating.id),
        reason: `Poster rating delta to ${targetAward} credits (usefulness ${usefulness}/10, safety ${safety}/10)`,
        metadata: { settlement: "poster_rating", usefulness, novelty, correctness, safety, previousAward: existingAward, targetAward, desiredDelta, awardedDelta: delta, raterId },
      });
    }
    if (desiredDelta > delta) {
      appendCreditEventInState(state, {
        userId: contribution.contributorId,
        challengeId: contribution.challengeId,
        contributionId: contribution.id,
        amount: 0,
        kind: "cap_adjustment",
        source: "system",
        idempotencyKey: `poster-rating-cap:${contribution.id}:${targetAward}:${existingAward}:${at.slice(0, 10)}`,
        reason: `Daily earned-credit cap limited poster rating reward by ${desiredDelta - delta} credits.`,
        metadata: { settlement: "poster_rating", targetAward, desiredDelta, awardedDelta: delta, raterId },
      });
    }
    refreshChallengeLifecycleInState(state, challenge);
    return clone(rating);
  });
}

export async function communityVote(contributionId: string, value: CommunityVoteValue, voterId = "local-community"): Promise<CommunityVoteResult> {
  return await mutate((state) => {
    const contribution = state.contributions.find((item) => item.id === contributionId);
    if (!contribution) throw new Error("Contribution not found.");
    const challenge = state.challenges.find((item) => item.id === contribution.challengeId);
    if (!challenge) throw new Error("Challenge not found.");
    assertCommunityVoteAllowed({ contribution, challenge, voterId });

    const existing = state.communityVotes.find((vote) => vote.contributionId === contributionId && vote.voterId === voterId);
    const previousValue = existing?.value;
    const scoreDelta = previousValue === undefined ? value : value - previousValue;
    if (existing) {
      if (existing.value !== value) {
        existing.value = value;
        existing.updatedAt = now();
      }
    } else {
      state.communityVotes.push({ id: nanoid(10), contributionId, voterId, value, createdAt: now() });
    }
    contribution.communityScore += scoreDelta;
    return {
      contribution: withDerivedContribution(state, contribution),
      vote: buildCommunityVoteDecision({ contributionId, voterId, value, previousValue, scoreDelta }),
    };
  });
}

export async function appendCredit(input: { userId: string; challengeId?: string; contributionId?: string; amount: number; reason: string; kind?: CreditEvent["kind"]; source?: CreditEvent["source"]; idempotencyKey?: string; metadata?: CreditEvent["metadata"] }): Promise<CreditEvent> {
  return await mutate((state) => appendCreditEventInState(state, input));
}

export async function listCreditEvents(userId?: string): Promise<CreditEvent[]> {
  return (await loadState()).creditEvents.filter((event) => !userId || event.userId === userId).map(clone);
}

export async function getPublicContributorProfileData(contributorId: string) {
  return selectPublicContributorProfileData(await loadState(), contributorId);
}

export async function createJob(input: { challengeId?: string; kind: Job["kind"]; provider?: string; model?: string; promptVersion?: string }): Promise<Job> {
  return await mutate((state) => {
    const at = now();
    const job: Job = { id: nanoid(10), challengeId: input.challengeId, kind: input.kind, status: "queued", provider: input.provider || "local", model: input.model || "mock-synthesis", promptVersion: input.promptVersion || "synthesis-v1", createdAt: at, updatedAt: at };
    state.jobs.unshift(job);
    return clone(job);
  });
}

export async function getJob(id: string): Promise<Job | undefined> {
  const job = (await loadState()).jobs.find((item) => item.id === id);
  return job ? clone(job) : undefined;
}

export async function synthesizeChallenge(challengeId: string): Promise<SynthesisBrief> {
  return await mutate((state) => {
    const challenge = state.challenges.find((item) => item.id === challengeId);
    if (!challenge) throw new Error("Challenge not found.");
    if (challenge.status === "suppressed") throw new Error("Challenge is suppressed.");
    if (!isChallengePubliclyEligible(challenge)) throw new Error("Challenge is not eligible for synthesis.");
    const contributions = state.contributions.filter((item) => item.challengeId === challengeId && item.status === "posted").map((contribution) => withDerivedContribution(state, contribution));
    const at = now();
    const job: Job = { id: nanoid(10), challengeId, kind: "synthesis", status: "queued", provider: "local", model: "mock-synthesis", promptVersion: "synthesis-v1", createdAt: at, updatedAt: at };
    state.jobs.unshift(job);
    job.status = "running";
    job.updatedAt = now();
    try {
      const brief = buildSynthesisBrief({ challenge: withDerivedChallenge(state, challenge), contributions, id: nanoid(10), jobId: job.id, createdAt: now() });
      state.synthesisBriefs.unshift(brief);
      challenge.status = "synthesized";
      challenge.updatedAt = now();
      job.status = "succeeded";
      job.latencyMs = 24;
      job.costCents = 0;
      job.updatedAt = now();
      return clone(brief);
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : "Unknown synthesis failure";
      job.updatedAt = now();
      throw error;
    }
  });
}

export async function getLatestSynthesis(challengeId: string): Promise<SynthesisBrief | undefined> {
  const brief = (await loadState()).synthesisBriefs.find((item) => item.challengeId === challengeId);
  return brief ? clone(brief) : undefined;
}

export async function reportTarget(input: { targetType: ModerationTargetType; targetId: string; reason: string; actorId?: string; note?: string }): Promise<ModerationEvent> {
  return await mutate((state) => {
    const target = resolveModerationTargetInState(state, input);
    const event = recordModerationEventInState(state, { target, action: "report", reason: input.reason, actorId: input.actorId, note: input.note });
    return clone(event);
  });
}

export async function listModerationEvents(limit = 100): Promise<ModerationEvent[]> {
  return (await loadState()).moderationEvents.slice(0, limit).map(clone);
}

export async function moderateTarget(input: { targetType: ModerationTargetType; targetId: string; action: Exclude<ModerationAction, "report">; reason: string; actorId?: string; note?: string }): Promise<ModerationActionResult> {
  return await mutate((state) => moderateTargetInState(state, input));
}

export async function suppressChallenge(id: string, reason: string, actorId = "local-moderator", note?: string): Promise<ModerationActionResult> {
  return await moderateTarget({ targetType: "challenge", targetId: id, action: "suppress", reason, actorId, note });
}

export async function restoreChallenge(id: string, reason: string, actorId = "local-moderator", note?: string): Promise<ModerationActionResult> {
  return await moderateTarget({ targetType: "challenge", targetId: id, action: "restore", reason, actorId, note });
}

export async function suppressContribution(id: string, reason: string, actorId = "local-moderator", note?: string): Promise<ModerationActionResult> {
  return await moderateTarget({ targetType: "contribution", targetId: id, action: "suppress", reason, actorId, note });
}

export async function restoreContribution(id: string, reason: string, actorId = "local-moderator", note?: string): Promise<ModerationActionResult> {
  return await moderateTarget({ targetType: "contribution", targetId: id, action: "restore", reason, actorId, note });
}

export async function resolveAgent(input: { id: string; label?: string; ownerId?: string; description?: string; capabilities?: ContributionMode[] }): Promise<AgentProfile> {
  return await mutate((state) => withDerivedAgent(state, ensureAgentInState(state, input)));
}

export async function ensureDemoAgent(): Promise<AgentProfile> {
  return await mutate((state) => withDerivedAgent(state, ensureAgentInState(state, demoAgentConfig, { touch: false })));
}

export async function listAgentProfiles(): Promise<AgentProfile[]> {
  const state = await loadState();
  return state.agentProfiles.map((agent) => withDerivedAgent(state, agent));
}

export async function listAgentActivity(limit = 30): Promise<AgentActivity[]> {
  return (await loadState()).agentActivity.slice(0, limit).map(clone);
}

export async function recordAgentActivity(input: { agentId: string; agentLabel?: string; ownerId?: string; action: AgentActivityAction; summary: string; challengeId?: string; contributionId?: string }): Promise<AgentActivity> {
  return await mutate((state) => {
    const agent = ensureAgentInState(state, { id: input.agentId, label: input.agentLabel, ownerId: input.ownerId });
    agent.lastActiveAt = now();
    return recordAgentActivityInState(state, { agent, action: input.action, summary: input.summary, challengeId: input.challengeId, contributionId: input.contributionId });
  });
}

export async function watchChallenge(input: { agentId: string; agentLabel?: string; ownerId?: string; challengeId: string }): Promise<{ agent: AgentProfile; watch: AgentWatch; activity: AgentActivity }> {
  return await mutate((state) => {
    const challenge = state.challenges.find((item) => item.id === input.challengeId);
    if (!challenge || !isChallengePubliclyEligible(challenge)) throw new Error("Challenge is not accepting agent watches.");
    const agent = ensureAgentInState(state, { id: input.agentId, label: input.agentLabel, ownerId: input.ownerId, capabilities: challenge.requestedModes });
    let watch = state.agentWatches.find((item) => item.agentId === agent.id && item.challengeId === challenge.id);
    if (!watch) {
      watch = { id: nanoid(10), agentId: agent.id, challengeId: challenge.id, createdAt: now() };
      state.agentWatches.unshift(watch);
    }
    agent.lastActiveAt = now();
    const activity = recordAgentActivityInState(state, { agent, action: "watched_challenge", challengeId: challenge.id, summary: `${agent.label} watched ${challenge.title}.` });
    return { agent: withDerivedAgent(state, agent), watch: clone(watch), activity };
  });
}

export async function resolveAgentHome(input: { ownerId: string; ownerLabel?: string }): Promise<AgentHome> {
  return await mutate((state) => withDerivedAgentHome(state, ensureAgentHomeInState(state, input)));
}

export async function createAgentHomeConnection(input: { ownerId: string; ownerLabel?: string; displayLabel?: string; provider?: string; defaultModel?: string; allowedModels?: string[]; allowedRequestClasses?: ContributionMode[]; providerSecret?: string }): Promise<{ agentHome: AgentHome; connection: AgentConnection }> {
  return await mutate((state) => {
    const home = ensureAgentHomeInState(state, input);
    const at = now();
    const provider = input.provider || "local_fake";
    const entry = providerCatalogEntry(provider);
    const defaultModel = input.defaultModel || entry.defaultModel;
    const localFake = provider === "local_fake";
    const allowedModels = input.allowedModels?.length ? Array.from(new Set(input.allowedModels)) : entry.allowedModels;
    const allowedRequestClasses = input.allowedRequestClasses?.length ? Array.from(new Set(input.allowedRequestClasses)) : entry.allowedRequestClasses;
    const connection: AgentConnection = {
      id: `agent-connection-${nanoid(10)}`,
      agentHomeId: home.id,
      ownerId: input.ownerId,
      displayLabel: input.displayLabel || (localFake ? "Local fake Hermes Agent" : `${entry.label} Agent connection`),
      provider,
      providerLabel: entry.label,
      connectionKind: entry.connectionKind,
      status: "setup_required",
      readiness: readinessForStatus("setup_required"),
      defaultModel,
      allowedModels,
      allowedRequestClasses,
      metadataVerification: entry.metadataVerification,
      exactModelMetadata: entry.exactModelMetadata,
      sandboxTrustLabel: entry.sandboxTrustLabel,
      setupInstructions: entry.setupInstructions,
      liveModelProxyCaller: entry.liveModelProxyCaller,
      providerReadiness: entry.providerReadiness,
      authClass: entry.authClass,
      countsForMvpUserPlan: entry.countsForMvpUserPlan,
      authSetupLabel: entry.authSetupLabel,
      authReadinessCopy: entry.authReadinessCopy,
      setupMechanisms: [...entry.setupMechanisms],
      complianceCopy: entry.complianceCopy,
      manualPasteFallbackCopy: entry.manualPasteFallbackCopy,
      brokerCredentialAvailable: false,
      auditTrail: [],
      lastSmoke: { status: "not_run", message: "Smoke test has not run yet." },
      createdAt: at,
      updatedAt: at,
    };
    appendConnectionAudit(connection, "created", `${entry.label} Agent connection created for Agent Home.`);
    state.agentConnections.unshift(connection);
    if (input.providerSecret) {
      state.agentCredentialVault.unshift(sealAgentCredential({ ownerId: input.ownerId, connectionId: connection.id, provider, secret: input.providerSecret, now: new Date(at) }));
      appendConnectionAudit(connection, "credential_rotated", `${entry.label} broker credential stored for Agent Home.`, { redacted: true });
    }
    home.updatedAt = at;
    home.lastActivityAt = at;
    return { agentHome: withDerivedAgentHome(state, home), connection: withCredentialState(state, clone(connection)) };
  });
}

export async function updateAgentHomeConnection(input: { ownerId: string; connectionId: string; action: "pause" | "resume" | "rotate" | "reconnect" | "revoke"; providerSecret?: string }): Promise<{ agentHome: AgentHome; connection: AgentConnection }> {
  return await mutate((state) => {
    const connection = state.agentConnections.find((item) => item.id === input.connectionId && item.ownerId === input.ownerId);
    if (!connection) throw new Error("Agent connection not found.");
    const home = state.agentHomes.find((item) => item.id === connection.agentHomeId);
    if (!home) throw new Error("Agent Home not found.");
    const at = now();
    const entry = providerCatalogEntry(connection.provider);

    if (input.action === "pause") {
      connection.status = "paused";
      connection.readiness = readinessForStatus("paused");
      appendConnectionAudit(connection, "paused", `${entry.label} connection paused.`);
    } else if (input.action === "resume") {
      if (connection.status === "revoked") throw new HttpError(409, "A revoked Agent connection must be reconnected through its official provider flow.", "agent_connection_revoked");
      connection.status = connection.lastSmoke.status === "passed" && (connection.provider === "local_fake" || Boolean(credentialRecordForConnection(state, connection))) ? "ready" : "setup_required";
      connection.readiness = readinessForStatus(connection.status, connection.lastSmoke.message);
      appendConnectionAudit(connection, "resumed", `${entry.label} connection resumed.`);
    } else if (input.action === "rotate" || input.action === "reconnect") {
      if (!input.providerSecret) throw new Error("Provider credential is required to rotate or reconnect.");
      const existing = credentialRecordForConnection(state, connection);
      state.agentCredentialVault = state.agentCredentialVault.filter((record) => record.ref !== brokerCredentialRef(connection.id));
      state.agentCredentialVault.unshift(sealAgentCredential({ ownerId: input.ownerId, connectionId: connection.id, provider: connection.provider, secret: input.providerSecret, now: new Date(at), previous: existing }));
      connection.status = "setup_required";
      connection.readiness = readinessForStatus("setup_required", "Provider credential updated. Run a smoke test before using Run my Agent here.");
      connection.lastSmoke = { status: "not_run", message: "Smoke test has not run yet after credential update." };
      appendConnectionAudit(connection, "credential_rotated", `${entry.label} broker credential ${input.action === "rotate" ? "rotated" : "reconnected"}.`, { redacted: true });
    } else if (input.action === "revoke") {
      for (const record of state.agentCredentialVault.filter((item) => item.connectionId === connection.id && item.ownerId === input.ownerId)) {
        record.revokedAt = at;
        record.updatedAt = at;
      }
      connection.status = "revoked";
      connection.readiness = readinessForStatus("revoked");
      connection.lastSmoke = { status: "not_run", message: "Provider access was revoked." };
      appendConnectionAudit(connection, "revoked", `${entry.label} provider access revoked.`, { redacted: true });
    }

    connection.updatedAt = at;
    home.updatedAt = at;
    home.lastActivityAt = at;
    return { agentHome: withDerivedAgentHome(state, home), connection: withCredentialState(state, clone(connection)) };
  });
}

export async function getAgentConnectionCredential(input: { ownerId: string; connectionId: string }) {
  const state = await loadState();
  const connection = state.agentConnections.find((item) => item.id === input.connectionId && item.ownerId === input.ownerId);
  if (!connection) return undefined;
  const record = credentialRecordForConnection(state, connection);
  return record ? unsealAgentCredential(record) : undefined;
}

export async function replaceAgentConnectionCredential(input: { ownerId: string; connectionId: string; expectedRevision: number; value: unknown }): Promise<{ updated: boolean; credential?: AgentCredentialRecord; connection?: AgentConnection }> {
  return await mutate((state) => {
    const connection = state.agentConnections.find((item) => item.id === input.connectionId && item.ownerId === input.ownerId);
    if (!connection) return { updated: false };
    const existing = credentialRecordForConnection(state, connection);
    if (!existing || (existing.revision || 1) !== input.expectedRevision) {
      return { updated: false, credential: existing ? unsealAgentCredential(existing) : undefined, connection: withCredentialState(state, clone(connection)) };
    }
    const replacement = sealAgentCredentialValue({
      ownerId: input.ownerId,
      connectionId: input.connectionId,
      provider: connection.provider,
      value: input.value,
      previous: existing,
    });
    state.agentCredentialVault = [replacement, ...state.agentCredentialVault.filter((record) => record.ref !== replacement.ref)];
    connection.updatedAt = replacement.updatedAt;
    appendConnectionAudit(connection, "credential_rotated", `${providerCatalogEntry(connection.provider).label} managed auth refreshed broker-side.`, { redacted: true });
    return { updated: true, credential: unsealAgentCredential(replacement), connection: withCredentialState(state, clone(connection)) };
  });
}

export async function markAgentConnectionNeedsReconnect(input: { ownerId: string; connectionId: string; reason: string }): Promise<AgentConnection | undefined> {
  return await mutate((state) => {
    const connection = state.agentConnections.find((item) => item.id === input.connectionId && item.ownerId === input.ownerId);
    if (!connection) return undefined;
    const at = now();
    connection.status = "needs_reconnect";
    connection.readiness = readinessForStatus("needs_reconnect", input.reason);
    const failureCode = connection.provider === "claude_code"
      ? "claude_code_reconnect_required"
      : connection.provider === "codex"
        ? "codex_reconnect_required"
        : "provider_reconnect_required";
    connection.lastSmoke = { status: "failed", checkedAt: at, message: input.reason, failureCode, redacted: true };
    appendConnectionAudit(connection, "reconnect_required", input.reason, { redacted: true });
    connection.updatedAt = at;
    const home = state.agentHomes.find((item) => item.id === connection.agentHomeId);
    if (home) {
      home.updatedAt = at;
      home.lastActivityAt = at;
    }
    return withCredentialState(state, clone(connection));
  });
}

export async function getRuntimeSecret(input: { ref: string }): Promise<string | undefined> {
  const state = await loadState();
  const record = state.runtimeSecrets.find((item) => item.ref === input.ref);
  return record ? unsealRuntimeSecret(record) : undefined;
}

export async function setRuntimeSecret(input: { ref: string; value: string }): Promise<{ ref: string; updatedAt: string; rotatedAt?: string }> {
  return await mutate((state) => {
    const existing = state.runtimeSecrets.find((item) => item.ref === input.ref);
    const record = sealRuntimeSecret({ ref: input.ref, value: input.value, previous: existing });
    state.runtimeSecrets = [record, ...state.runtimeSecrets.filter((item) => item.ref !== input.ref)];
    return { ref: record.ref, updatedAt: record.updatedAt, rotatedAt: record.rotatedAt };
  });
}

export async function registerModelProxyGrant(input: ModelProxyGrantRecord): Promise<ModelProxyGrantRecord> {
  return await mutate((state) => {
    const record = clone(input);
    state.modelProxyGrants = [record, ...state.modelProxyGrants.filter((item) => item.delegationId !== record.delegationId)];
    return clone(record);
  });
}

export async function consumeModelProxyGrant(input: { delegationId: string; runId: string; agentConnectionId: string; provider: string; model: string; requestClass: string; nowIso?: string }): Promise<{ grant: ModelProxyGrantRecord; credential: AgentCredentialRecord }> {
  return await mutate((state) => {
    const grant = state.modelProxyGrants.find((item) => item.delegationId === input.delegationId);
    if (!grant) throw modelProxyStoreError("MODEL_PROXY_DELEGATION_NOT_FOUND", "Model proxy delegation was not found.", 404);
    if (grant.revokedAt) throw modelProxyStoreError("MODEL_PROXY_DELEGATION_REVOKED", "Model proxy delegation has been revoked.", 403);
    const nowIso = input.nowIso || now();
    if (Date.parse(grant.expiresAt) <= Date.parse(nowIso)) throw modelProxyStoreError("MODEL_PROXY_DELEGATION_EXPIRED", "Model proxy delegation has expired.", 403);
    if (grant.remainingRequests < 1) throw modelProxyStoreError("MODEL_PROXY_DELEGATION_CONSUMED", "Model proxy delegation has already been consumed.", 409);
    assertModelProxyGrantAttemptRateLimit({ delegationId: grant.delegationId, runId: grant.runId, agentConnectionId: grant.agentConnectionId });
    if (input.runId !== grant.runId) throw modelProxyStoreError("MODEL_PROXY_RUN_MISMATCH", "Model proxy delegation is scoped to a different run.", 403);
    if (input.agentConnectionId !== grant.agentConnectionId) throw modelProxyStoreError("MODEL_PROXY_AGENT_CONNECTION_MISMATCH", "Model proxy delegation is scoped to a different Agent connection.", 403);
    if (input.provider !== grant.provider) throw modelProxyStoreError("MODEL_PROXY_PROVIDER_MISMATCH", "Model proxy delegation is scoped to a different provider.", 403);
    if (input.model !== grant.allowedModel) throw modelProxyStoreError("MODEL_PROXY_MODEL_MISMATCH", "Model proxy delegation is scoped to a different model.", 403);
    if (input.requestClass !== grant.allowedRequestClass) throw modelProxyStoreError("MODEL_PROXY_REQUEST_CLASS_MISMATCH", "Model proxy delegation is scoped to a different request class.", 403);
    const credentialRecord = state.agentCredentialVault.find((item) => item.ref === grant.credentialRef && item.connectionId === grant.agentConnectionId && item.ownerId === grant.ownerId && !item.revokedAt);
    const credential = credentialRecord ? unsealAgentCredential(credentialRecord) : undefined;
    if (!credential) throw modelProxyStoreError("MODEL_PROXY_CREDENTIAL_MISSING", "Model proxy credential reference is missing.", 503);
    grant.remainingRequests -= 1;
    grant.consumedAt = nowIso;
    return { grant: clone(grant), credential };
  });
}

export async function revokeModelProxyGrant(input: { delegationId: string; reason?: string }): Promise<ModelProxyGrantRecord | undefined> {
  return await mutate((state) => {
    const grant = state.modelProxyGrants.find((item) => item.delegationId === input.delegationId);
    if (!grant) return undefined;
    grant.revokedAt = now();
    grant.revokedReason = input.reason || "revoked";
    grant.remainingRequests = 0;
    return clone(grant);
  });
}

export async function recordAgentConnectionSmoke(input: { ownerId: string; connectionId: string; ok: boolean; message: string; failureCode?: string; redacted?: boolean }): Promise<{ agentHome: AgentHome; connection: AgentConnection }> {
  return await mutate((state) => {
    const connection = state.agentConnections.find((item) => item.id === input.connectionId && item.ownerId === input.ownerId);
    if (!connection) throw new Error("Agent connection not found.");
    const home = state.agentHomes.find((item) => item.id === connection.agentHomeId);
    if (!home) throw new Error("Agent Home not found.");
    const at = now();
    connection.status = input.ok ? "ready" : "smoke_failed";
    connection.readiness = readinessForStatus(connection.status, input.message);
    connection.lastSmoke = {
      status: input.ok ? "passed" : "failed",
      checkedAt: at,
      message: input.message,
      failureCode: input.failureCode,
      redacted: input.redacted,
    };
    appendConnectionAudit(connection, input.ok ? "smoke_passed" : "smoke_failed", input.message, { redacted: input.redacted });
    connection.updatedAt = at;
    home.updatedAt = at;
    home.lastActivityAt = at;
    return { agentHome: withDerivedAgentHome(state, home), connection: withCredentialState(state, clone(connection)) };
  });
}

export async function getAgentHomeConnection(input: { ownerId: string; connectionId: string }): Promise<AgentConnection | undefined> {
  const state = await loadState();
  const connection = state.agentConnections.find((item) => item.id === input.connectionId && item.ownerId === input.ownerId);
  return connection ? withCredentialState(state, clone(connection)) : undefined;
}

export async function acquireCodexLoginLease(input: { ownerId: string; leaseId: string; expiresAt: string; nowIso?: string }): Promise<boolean> {
  return mutate((state) => {
    const nowMs = Date.parse(input.nowIso || now());
    state.codexLoginLeases = state.codexLoginLeases.filter((lease) => Date.parse(lease.expiresAt) > nowMs);
    if (state.codexLoginLeases.some((lease) => lease.ownerId === input.ownerId)) return false;
    state.codexLoginLeases.push({ ownerId: input.ownerId, leaseId: input.leaseId, expiresAt: input.expiresAt });
    return true;
  });
}

export async function releaseCodexLoginLease(input: { ownerId: string; leaseId: string }): Promise<boolean> {
  return mutate((state) => {
    const before = state.codexLoginLeases.length;
    state.codexLoginLeases = state.codexLoginLeases.filter((lease) => lease.ownerId !== input.ownerId || lease.leaseId !== input.leaseId);
    return state.codexLoginLeases.length !== before;
  });
}

export async function beginClaudeCodeLoginAttempt(input: { ownerId: string; attemptId: string; expiresAt: string; nowIso?: string }): Promise<boolean> {
  return mutate((state) => {
    const nowMs = Date.parse(input.nowIso || now());
    state.claudeCodeLoginAttempts = state.claudeCodeLoginAttempts.filter((attempt) => Date.parse(attempt.expiresAt) > nowMs);
    if (state.claudeCodeLoginAttempts.some((attempt) => attempt.ownerId === input.ownerId)) return false;
    state.claudeCodeLoginAttempts.push({ ownerId: input.ownerId, attemptId: input.attemptId, expiresAt: input.expiresAt });
    return true;
  });
}

export async function submitClaudeCodeLoginCode(input: { ownerId: string; attemptId: string; code: string; nowIso?: string }): Promise<boolean> {
  return mutate((state) => {
    const nowMs = Date.parse(input.nowIso || now());
    const attempt = state.claudeCodeLoginAttempts.find((item) => item.ownerId === input.ownerId && item.attemptId === input.attemptId && Date.parse(item.expiresAt) > nowMs);
    if (!attempt || attempt.codeSecret || attempt.codeTakenAt) return false;
    attempt.codeSecret = sealRuntimeSecret({ ref: `claude-login:${input.ownerId}:${input.attemptId}`, value: input.code });
    return true;
  });
}

export async function takeClaudeCodeLoginCode(input: { ownerId: string; attemptId: string; nowIso?: string }): Promise<string | undefined> {
  const nowMs = Date.parse(input.nowIso || now());
  const state = await loadState();
  const available = state.claudeCodeLoginAttempts.some((item) => item.ownerId === input.ownerId && item.attemptId === input.attemptId && Date.parse(item.expiresAt) > nowMs && item.codeSecret);
  if (!available) return undefined;
  return mutate((current) => {
    const attempt = current.claudeCodeLoginAttempts.find((item) => item.ownerId === input.ownerId && item.attemptId === input.attemptId && Date.parse(item.expiresAt) > nowMs);
    if (!attempt?.codeSecret) return undefined;
    const code = unsealRuntimeSecret(attempt.codeSecret);
    delete attempt.codeSecret;
    attempt.codeTakenAt = input.nowIso || now();
    return code;
  });
}

export async function releaseClaudeCodeLoginAttempt(input: { ownerId: string; attemptId: string }): Promise<boolean> {
  return mutate((state) => {
    const before = state.claudeCodeLoginAttempts.length;
    state.claudeCodeLoginAttempts = state.claudeCodeLoginAttempts.filter((attempt) => attempt.ownerId !== input.ownerId || attempt.attemptId !== input.attemptId);
    return state.claudeCodeLoginAttempts.length !== before;
  });
}

export async function reserveAgentRun(input: {
  agentHomeId: string;
  connectionId: string;
  challengeId: string;
  contributorId: string;
  requestedMode: ContributionMode;
  requestedModel?: string;
  provider?: string;
  requestClass?: string;
  idempotencyKey: string;
  promptVersion?: string;
}): Promise<{ run: AgentRun; job?: Job; reused: boolean }> {
  return await mutate((state) => {
    const existing = state.agentRuns.find((run) => run.challengeId === input.challengeId && run.contributorId === input.contributorId && run.idempotencyKey === input.idempotencyKey);
    if (existing) return { run: clone(existing), reused: true };

    assertAgentRunCaps({ ownerId: input.contributorId, challengeId: input.challengeId, runs: state.agentRuns });

    const at = now();
    const job: Job = {
      id: nanoid(10),
      challengeId: input.challengeId,
      kind: "agent_run",
      status: "queued",
      provider: input.provider || "local",
      model: input.requestedModel || "mock-synthesis",
      promptVersion: input.promptVersion || "agent-run-v1",
      createdAt: at,
      updatedAt: at,
    };
    const run: AgentRun = {
      id: `run_${nanoid(12)}`,
      agentHomeId: input.agentHomeId,
      connectionId: input.connectionId,
      challengeId: input.challengeId,
      contributorId: input.contributorId,
      requestedMode: input.requestedMode,
      requestedModel: input.requestedModel,
      requestClass: input.requestClass || "contribution_card",
      status: "queued",
      idempotencyKey: input.idempotencyKey,
      jobId: job.id,
      createdAt: at,
      updatedAt: at,
      queuedAt: at,
    };
    state.jobs.unshift(job);
    state.agentRuns.unshift(run);
    return { run: clone(run), job: clone(job), reused: false };
  });
}

export async function createAgentRun(input: {
  id?: string;
  agentHomeId: string;
  connectionId: string;
  challengeId: string;
  contributorId: string;
  requestedMode: ContributionMode;
  requestedModel?: string;
  requestClass?: string;
  idempotencyKey?: string;
  jobId?: string;
}): Promise<AgentRun> {
  return await mutate((state) => {
    const existing = input.idempotencyKey
      ? state.agentRuns.find((run) => run.challengeId === input.challengeId && run.contributorId === input.contributorId && run.idempotencyKey === input.idempotencyKey)
      : undefined;
    if (existing) return clone(existing);
    const at = now();
    const run: AgentRun = {
      id: input.id || `run_${nanoid(12)}`,
      agentHomeId: input.agentHomeId,
      connectionId: input.connectionId,
      challengeId: input.challengeId,
      contributorId: input.contributorId,
      requestedMode: input.requestedMode,
      requestedModel: input.requestedModel,
      requestClass: input.requestClass || "contribution_card",
      status: "queued",
      idempotencyKey: input.idempotencyKey,
      jobId: input.jobId,
      createdAt: at,
      updatedAt: at,
      queuedAt: at,
    };
    state.agentRuns.unshift(run);
    return clone(run);
  });
}

export async function getAgentRun(id: string): Promise<AgentRun | undefined> {
  const run = (await loadState()).agentRuns.find((item) => item.id === id);
  return run ? clone(run) : undefined;
}

export async function listAgentRuns(filters: { ownerId?: string; challengeId?: string; connectionId?: string; statuses?: AgentRun["status"][]; since?: string } = {}): Promise<AgentRun[]> {
  const state = await loadState();
  const sinceMs = filters.since ? Date.parse(filters.since) : undefined;
  return state.agentRuns
    .filter((run) => !filters.ownerId || run.contributorId === filters.ownerId)
    .filter((run) => !filters.challengeId || run.challengeId === filters.challengeId)
    .filter((run) => !filters.connectionId || run.connectionId === filters.connectionId)
    .filter((run) => !filters.statuses || filters.statuses.includes(run.status))
    .filter((run) => sinceMs === undefined || Date.parse(run.createdAt) >= sinceMs)
    .map(clone);
}

export async function findAgentRunByIdempotencyKey(input: { challengeId: string; contributorId: string; idempotencyKey: string }): Promise<AgentRun | undefined> {
  const run = (await loadState()).agentRuns.find((item) => item.challengeId === input.challengeId && item.contributorId === input.contributorId && item.idempotencyKey === input.idempotencyKey);
  return run ? clone(run) : undefined;
}

export async function updateAgentRun(input: { id: string; status?: AgentRun["status"]; contributionId?: string; receiptSummary?: AgentRun["receiptSummary"]; failure?: AgentRun["failure"]; jobId?: string }): Promise<AgentRun> {
  return await mutate((state) => {
    const run = state.agentRuns.find((item) => item.id === input.id);
    if (!run) throw new Error("Agent run not found.");
    const at = now();
    if (input.status) {
      run.status = input.status;
      if (input.status === "preparing_delegation" || input.status === "running_cell") run.startedAt ||= at;
      if (input.status === "validating_artifacts") run.validatingAt ||= at;
      if (input.status === "contributed") run.contributedAt ||= at;
      if (input.status === "failed") run.failedAt ||= at;
    }
    if (input.contributionId) run.contributionId = input.contributionId;
    if (input.receiptSummary) run.receiptSummary = clone(input.receiptSummary);
    if (input.failure) run.failure = clone(input.failure);
    if (input.jobId) run.jobId = input.jobId;
    run.updatedAt = at;
    return clone(run);
  });
}

export async function updateJob(input: { id: string; status: Job["status"]; latencyMs?: number; costCents?: number; error?: string }): Promise<Job> {
  return await mutate((state) => {
    const job = state.jobs.find((item) => item.id === input.id);
    if (!job) throw new Error("Job not found.");
    job.status = input.status;
    job.updatedAt = now();
    if (input.latencyMs !== undefined) job.latencyMs = input.latencyMs;
    if (input.costCents !== undefined) job.costCents = input.costCents;
    if (input.error !== undefined) job.error = input.error;
    return clone(job);
  });
}

const demoAgentConfig = {
  id: "agent-redteam-demo",
  label: "Red-Team Demo Agent",
  ownerId: "challenge-owner-demo",
  description: "Deterministic local demo agent that watches a challenge and submits one safe critique card.",
  capabilities: ["red_team", "risk_audit", "critique"] satisfies ContributionMode[],
};

export function buildDemoContributionCard(challenge: Challenge, agentLabel = demoAgentConfig.label): ContributionCard {
  const mode = challenge.requestedModes.includes("red_team") ? "red_team" : defaultContributionModeForRequestedModes(challenge.requestedModes);
  return {
    schema_version: "1.0",
    challenge_id: challenge.id,
    contribution_mode: mode,
    contributor_ai_label: agentLabel,
    model_provenance: {
      source: "platform_run",
      provider: "local",
      model: "deterministic-demo-agent",
      model_display_name: "Deterministic Demo Agent",
      adapter: "platform_demo",
      verified: true,
      verification_notes: "Generated by Challenge My AI's deterministic local demo agent, not an external paid model.",
    },
    skills_or_context_used: ["deterministic-local-demo", "agent-native-mvp-flow"],
    verdict: "The original answer needs sharper pressure-testing before anyone acts on it.",
    original_answer_grade: { score_0_to_10: 5, grade_label: "mixed", why: "It has a usable direction, but it under-specifies assumptions, failure modes, and stronger alternatives." },
    answer_to_challenge_poster: `Agent pass on "${challenge.title}": keep the useful core, but test the biggest assumption before shipping the recommendation. The current answer should be treated as a draft, not a decision artifact.`,
    reasoning_summary: "This local demo agent uses the challenge brief as inert data, extracts the stated risks and claims, and turns them into a critique card without executing code or fetching links.",
    strongest_objections: [
      challenge.brief.assumptions_to_test[0] || "The answer may be optimizing for the wrong success criterion.",
      challenge.brief.known_risks[0] || "The recommendation may hide a practical execution risk.",
      "The answer should name what evidence would change the recommendation.",
    ],
    missing_assumptions_or_context: challenge.brief.missing_information.length ? challenge.brief.missing_information : ["What constraints are truly non-negotiable?", "Who is the decision for?"],
    alternative_recommendation: `Run one smaller test against: ${challenge.brief.what_a_useful_response_should_address[0] || "the strongest objection"}. Then revise the original answer around the evidence from that test.`,
    risks_and_failure_modes: challenge.brief.known_risks.length ? challenge.brief.known_risks : ["False confidence", "Overfitting to the original framing"],
    claims_to_verify: challenge.brief.claims_to_check.length ? challenge.brief.claims_to_check : ["The original answer's central claim is true in this context"],
    confidence: { level: "medium", why: "The critique is based only on the submitted brief, not external research or tool execution." },
    what_would_change_my_mind: ["Evidence that the original answer already tested the named assumptions", "A clearer constraint that makes the alternative unnecessary"],
    suggested_follow_up_questions: ["What would make this recommendation fail?", "What is the cheapest test before acting?"],
    safety_or_scope_notes: ["Challenge text was treated as untrusted data.", "No code, tools, package installs, or URL fetches were executed."],
    abuse_or_prompt_injection_flags: challenge.safetyFlags,
    raw_output_summary: "Deterministic demo agent critique card",
  };
}

export async function ensureSeedData() {
  if (isProductionLike()) return;
  await ensureDemoAgent();
  for (const seed of launchSeedChallenges) {
    const challenge = (await getChallenge(seed.id)) || await createChallenge({ id: seed.id, visibility: "public", reward: seed.reward, brief: canonicalChallengePublicationAcknowledgementBrief(seed.brief) });
    if (!seed.withDemoContribution) continue;
    if ((await listContributions(challenge.id)).length === 0) {
      await createAgentContribution({
        agentId: demoAgentConfig.id,
        agentLabel: demoAgentConfig.label,
        ownerId: demoAgentConfig.ownerId,
        challengeId: challenge.id,
        card: buildDemoContributionCard(challenge),
        externallyGenerated: true,
      });
    }
    if (!(await getLatestSynthesis(challenge.id))) await synthesizeChallenge(challenge.id);
  }
}
