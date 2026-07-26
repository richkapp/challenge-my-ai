import { isProductionLike, productionConfigIssues, storeDriver } from "@/lib/config/env";
import { HttpError } from "@/lib/api/responses";
import type { PublicContributorProfileStoreData } from "@/lib/store/publicProfile";
import type {
  AgentFeedQueryInput,
  AgentFeedQueryResult,
  AgentFeedRequestExecutor,
  AgentFeedRequestTransactionInput,
  AgentFeedRequestTransactionResult,
  AgentFeedStoreReadiness,
  AgentFeedSubmissionInput,
  AgentSubmissionAcceptResult,
} from "@/lib/store/agentFeed";
import type { AgentActivity, AgentActivityAction, AgentConnection, AgentHome, AgentProfile, AgentRun, AgentWatch, Challenge, ChallengeBrief, CommunityVoteResult, CommunityVoteValue, Contribution, ContributionCard, ContributionMode, CreditEvent, Job, ModelProxyGrantRecord, ModerationAction, ModerationActionResult, ModerationEvent, ModerationTargetType, Rating, SafetyFlag, SynthesisBrief } from "@/lib/types";
import { buildDemoContributionCard } from "./demoAgent";

type Awaitable<T> = T | Promise<T>;
type ChallengeFilters = Partial<{ category: string; mode: ContributionMode; status: string }>;

type StoreModule = {
  resetStoreForTests(): Awaitable<void>;
  getAgentFeedStoreReadiness(): Awaitable<AgentFeedStoreReadiness>;
  queryAgentFeed(input: AgentFeedQueryInput): Awaitable<AgentFeedQueryResult>;
  transactAgentFeedRequest(input: AgentFeedRequestTransactionInput, execute: AgentFeedRequestExecutor, transactionTime?: Date): Awaitable<AgentFeedRequestTransactionResult>;
  submitAgentFeedContribution(input: AgentFeedSubmissionInput, transactionTime?: Date): Awaitable<AgentSubmissionAcceptResult>;
  createChallenge(input: { id?: string; posterId?: string; visibility: "public" | "private"; reward: number; brief: ChallengeBrief; safetyFlags?: SafetyFlag[] }): Awaitable<Challenge>;
  listChallenges(filters?: ChallengeFilters): Awaitable<Challenge[]>;
  getChallenge(id: string): Awaitable<Challenge | undefined>;
  createContribution(input: { challengeId: string; contributorId?: string; contributorKind?: "human" | "agent"; contributorLabel?: string; card: ContributionCard; externallyGenerated?: boolean }): Awaitable<Contribution>;
  createAgentContribution(input: { agentId: string; agentLabel?: string; ownerId?: string; challengeId: string; card: ContributionCard; externallyGenerated?: boolean }): Awaitable<Contribution>;
  listContributions(challengeId: string): Awaitable<Contribution[]>;
  getContribution(id: string): Awaitable<Contribution | undefined>;
  rateContribution(input: { contributionId: string; raterId?: string; usefulness: number; novelty?: number; correctness?: number; safety?: number; comment?: string }): Awaitable<Rating>;
  communityVote(contributionId: string, value: CommunityVoteValue, voterId?: string): Awaitable<CommunityVoteResult>;
  appendCredit(input: { userId: string; challengeId?: string; contributionId?: string; amount: number; reason: string; kind?: CreditEvent["kind"]; source?: CreditEvent["source"]; idempotencyKey?: string; metadata?: CreditEvent["metadata"] }): Awaitable<CreditEvent>;
  listCreditEvents(userId?: string): Awaitable<CreditEvent[]>;
  getPublicContributorProfileData(contributorId: string): Awaitable<PublicContributorProfileStoreData>;
  createJob(input: { challengeId?: string; kind: Job["kind"]; provider?: string; model?: string; promptVersion?: string }): Awaitable<Job>;
  getJob(id: string): Awaitable<Job | undefined>;
  synthesizeChallenge(challengeId: string): Awaitable<SynthesisBrief>;
  getLatestSynthesis(challengeId: string): Awaitable<SynthesisBrief | undefined>;
  reportTarget(input: { targetType: ModerationTargetType; targetId: string; reason: string; actorId?: string; note?: string }): Awaitable<ModerationEvent>;
  listModerationEvents(limit?: number): Awaitable<ModerationEvent[]>;
  moderateTarget(input: { targetType: ModerationTargetType; targetId: string; action: Exclude<ModerationAction, "report">; reason: string; actorId?: string; note?: string }): Awaitable<ModerationActionResult>;
  suppressChallenge(id: string, reason: string, actorId?: string, note?: string): Awaitable<ModerationActionResult>;
  restoreChallenge(id: string, reason: string, actorId?: string, note?: string): Awaitable<ModerationActionResult>;
  suppressContribution(id: string, reason: string, actorId?: string, note?: string): Awaitable<ModerationActionResult>;
  restoreContribution(id: string, reason: string, actorId?: string, note?: string): Awaitable<ModerationActionResult>;
  resolveAgent(input: { id: string; label?: string; ownerId?: string; description?: string; capabilities?: ContributionMode[] }): Awaitable<AgentProfile>;
  ensureDemoAgent(): Awaitable<AgentProfile>;
  listAgentProfiles(): Awaitable<AgentProfile[]>;
  listAgentActivity(limit?: number): Awaitable<AgentActivity[]>;
  recordAgentActivity(input: { agentId: string; agentLabel?: string; ownerId?: string; action: AgentActivityAction; summary: string; challengeId?: string; contributionId?: string }): Awaitable<AgentActivity>;
  watchChallenge(input: { agentId: string; agentLabel?: string; ownerId?: string; challengeId: string }): Awaitable<{ agent: AgentProfile; watch: AgentWatch; activity: AgentActivity }>;
  resolveAgentHome(input: { ownerId: string; ownerLabel?: string }): Awaitable<AgentHome>;
  createAgentHomeConnection(input: { ownerId: string; ownerLabel?: string; displayLabel?: string; provider?: string; defaultModel?: string; allowedModels?: string[]; allowedRequestClasses?: ContributionMode[]; providerSecret?: string }): Awaitable<{ agentHome: AgentHome; connection: AgentConnection }>;
  updateAgentHomeConnection(input: { ownerId: string; connectionId: string; action: "pause" | "resume" | "rotate" | "reconnect" | "revoke"; providerSecret?: string }): Awaitable<{ agentHome: AgentHome; connection: AgentConnection }>;
  getAgentConnectionCredential(input: { ownerId: string; connectionId: string }): Awaitable<import("@/lib/agent-home/providerAdapters").AgentCredentialRecord | undefined>;
  replaceAgentConnectionCredential(input: { ownerId: string; connectionId: string; expectedRevision: number; value: unknown }): Awaitable<{ updated: boolean; credential?: import("@/lib/agent-home/providerAdapters").AgentCredentialRecord; connection?: AgentConnection }>;
  markAgentConnectionNeedsReconnect(input: { ownerId: string; connectionId: string; reason: string }): Awaitable<AgentConnection | undefined>;
  getRuntimeSecret(input: { ref: string }): Awaitable<string | undefined>;
  setRuntimeSecret(input: { ref: string; value: string }): Awaitable<{ ref: string; updatedAt: string; rotatedAt?: string }>;
  registerModelProxyGrant(input: ModelProxyGrantRecord): Awaitable<ModelProxyGrantRecord>;
  consumeModelProxyGrant(input: { delegationId: string; runId: string; agentConnectionId: string; provider: string; model: string; requestClass: string; nowIso?: string }): Awaitable<{ grant: ModelProxyGrantRecord; credential: import("@/lib/agent-home/providerAdapters").AgentCredentialRecord }>;
  revokeModelProxyGrant(input: { delegationId: string; reason?: string }): Awaitable<ModelProxyGrantRecord | undefined>;
  recordAgentConnectionSmoke(input: { ownerId: string; connectionId: string; ok: boolean; message: string; failureCode?: string; redacted?: boolean }): Awaitable<{ agentHome: AgentHome; connection: AgentConnection }>;
  getAgentHomeConnection(input: { ownerId: string; connectionId: string }): Awaitable<AgentConnection | undefined>;
  acquireCodexLoginLease(input: { ownerId: string; leaseId: string; expiresAt: string; nowIso?: string }): Awaitable<boolean>;
  releaseCodexLoginLease(input: { ownerId: string; leaseId: string }): Awaitable<boolean>;
  beginClaudeCodeLoginAttempt(input: { ownerId: string; attemptId: string; expiresAt: string; nowIso?: string }): Awaitable<boolean>;
  submitClaudeCodeLoginCode(input: { ownerId: string; attemptId: string; code: string; nowIso?: string }): Awaitable<boolean>;
  takeClaudeCodeLoginCode(input: { ownerId: string; attemptId: string; nowIso?: string }): Awaitable<string | undefined>;
  releaseClaudeCodeLoginAttempt(input: { ownerId: string; attemptId: string }): Awaitable<boolean>;
  reserveAgentRun(input: { agentHomeId: string; connectionId: string; challengeId: string; contributorId: string; requestedMode: ContributionMode; requestedModel?: string; provider?: string; requestClass?: string; idempotencyKey: string; promptVersion?: string }): Awaitable<{ run: AgentRun; job?: Job; reused: boolean }>;
  createAgentRun(input: { id?: string; agentHomeId: string; connectionId: string; challengeId: string; contributorId: string; requestedMode: ContributionMode; requestedModel?: string; requestClass?: string; idempotencyKey?: string; jobId?: string }): Awaitable<AgentRun>;
  listAgentRuns(filters?: { ownerId?: string; challengeId?: string; connectionId?: string; statuses?: AgentRun["status"][]; since?: string }): Awaitable<AgentRun[]>;
  getAgentRun(id: string): Awaitable<AgentRun | undefined>;
  findAgentRunByIdempotencyKey(input: { challengeId: string; contributorId: string; idempotencyKey: string }): Awaitable<AgentRun | undefined>;
  updateAgentRun(input: { id: string; status?: AgentRun["status"]; contributionId?: string; receiptSummary?: AgentRun["receiptSummary"]; failure?: AgentRun["failure"]; jobId?: string }): Awaitable<AgentRun>;
  updateJob(input: { id: string; status: Job["status"]; latencyMs?: number; costCents?: number; error?: string }): Awaitable<Job>;
  ensureSeedData(): Awaitable<void>;
};

let localStorePromise: Promise<StoreModule> | undefined;
let postgresStorePromise: Promise<StoreModule> | undefined;

async function activeStore(): Promise<StoreModule> {
  const driver = storeDriver();
  if (driver === "postgres") {
    if (isProductionLike()) {
      const issues = productionConfigIssues();
      if (issues.length) {
        throw new HttpError(503, "Challenge My AI production configuration is incomplete.", "production_config_incomplete", { issues });
      }
    }
    postgresStorePromise ??= import("./postgres") as unknown as Promise<StoreModule>;
    return postgresStorePromise;
  }
  if (isProductionLike()) {
    throw new HttpError(503, "Challenge My AI production mode requires CMAI_STORE_DRIVER=postgres.", "production_store_required");
  }
  localStorePromise ??= import("./local") as unknown as Promise<StoreModule>;
  return localStorePromise;
}

export async function resetStoreForTests() {
  const store = await activeStore();
  return store.resetStoreForTests();
}

export async function getAgentFeedStoreReadiness() {
  const store = await activeStore();
  return store.getAgentFeedStoreReadiness();
}

export async function queryAgentFeed(input: AgentFeedQueryInput) {
  const store = await activeStore();
  return store.queryAgentFeed(input);
}

export async function transactAgentFeedRequest(
  input: AgentFeedRequestTransactionInput,
  execute: AgentFeedRequestExecutor,
  transactionTime?: Date,
) {
  const store = await activeStore();
  return store.transactAgentFeedRequest(input, execute, transactionTime);
}

export async function submitAgentFeedContribution(input: AgentFeedSubmissionInput, transactionTime?: Date) {
  const store = await activeStore();
  return store.submitAgentFeedContribution(input, transactionTime);
}

export async function createChallenge(input: Parameters<StoreModule["createChallenge"]>[0]) {
  const store = await activeStore();
  return store.createChallenge(input);
}

export async function listChallenges(filters?: ChallengeFilters) {
  const store = await activeStore();
  return store.listChallenges(filters);
}

export async function getChallenge(id: string) {
  const store = await activeStore();
  return store.getChallenge(id);
}

export async function createContribution(input: Parameters<StoreModule["createContribution"]>[0]) {
  const store = await activeStore();
  return store.createContribution(input);
}

export async function createAgentContribution(input: Parameters<StoreModule["createAgentContribution"]>[0]) {
  const store = await activeStore();
  return store.createAgentContribution(input);
}

export async function listContributions(challengeId: string) {
  const store = await activeStore();
  return store.listContributions(challengeId);
}

export async function getContribution(id: string) {
  const store = await activeStore();
  return store.getContribution(id);
}

export async function rateContribution(input: Parameters<StoreModule["rateContribution"]>[0]) {
  const store = await activeStore();
  return store.rateContribution(input);
}

export async function communityVote(contributionId: string, value: 1 | -1, voterId?: string) {
  const store = await activeStore();
  return store.communityVote(contributionId, value, voterId);
}

export async function appendCredit(input: Parameters<StoreModule["appendCredit"]>[0]) {
  const store = await activeStore();
  return store.appendCredit(input);
}

export async function listCreditEvents(userId?: string) {
  const store = await activeStore();
  return store.listCreditEvents(userId);
}

export async function getPublicContributorProfileData(contributorId: string) {
  const store = await activeStore();
  return store.getPublicContributorProfileData(contributorId);
}

export async function createJob(input: Parameters<StoreModule["createJob"]>[0]) {
  const store = await activeStore();
  return store.createJob(input);
}

export async function getJob(id: string) {
  const store = await activeStore();
  return store.getJob(id);
}

export async function synthesizeChallenge(challengeId: string) {
  const store = await activeStore();
  return store.synthesizeChallenge(challengeId);
}

export async function getLatestSynthesis(challengeId: string) {
  const store = await activeStore();
  return store.getLatestSynthesis(challengeId);
}

export async function reportTarget(input: Parameters<StoreModule["reportTarget"]>[0]) {
  const store = await activeStore();
  return store.reportTarget(input);
}

export async function listModerationEvents(limit?: number) {
  const store = await activeStore();
  return store.listModerationEvents(limit);
}

export async function moderateTarget(input: Parameters<StoreModule["moderateTarget"]>[0]) {
  const store = await activeStore();
  return store.moderateTarget(input);
}

export async function suppressChallenge(id: string, reason: string, actorId?: string, note?: string) {
  const store = await activeStore();
  return store.suppressChallenge(id, reason, actorId, note);
}

export async function restoreChallenge(id: string, reason: string, actorId?: string, note?: string) {
  const store = await activeStore();
  return store.restoreChallenge(id, reason, actorId, note);
}

export async function suppressContribution(id: string, reason: string, actorId?: string, note?: string) {
  const store = await activeStore();
  return store.suppressContribution(id, reason, actorId, note);
}

export async function restoreContribution(id: string, reason: string, actorId?: string, note?: string) {
  const store = await activeStore();
  return store.restoreContribution(id, reason, actorId, note);
}

export async function resolveAgent(input: Parameters<StoreModule["resolveAgent"]>[0]) {
  const store = await activeStore();
  return store.resolveAgent(input);
}

export async function ensureDemoAgent() {
  const store = await activeStore();
  return store.ensureDemoAgent();
}

export async function listAgentProfiles() {
  const store = await activeStore();
  return store.listAgentProfiles();
}

export async function listAgentActivity(limit?: number) {
  const store = await activeStore();
  return store.listAgentActivity(limit);
}

export async function recordAgentActivity(input: Parameters<StoreModule["recordAgentActivity"]>[0]) {
  const store = await activeStore();
  return store.recordAgentActivity(input);
}

export async function watchChallenge(input: Parameters<StoreModule["watchChallenge"]>[0]) {
  const store = await activeStore();
  return store.watchChallenge(input);
}

export async function resolveAgentHome(input: Parameters<StoreModule["resolveAgentHome"]>[0]) {
  const store = await activeStore();
  return store.resolveAgentHome(input);
}

export async function createAgentHomeConnection(input: Parameters<StoreModule["createAgentHomeConnection"]>[0]) {
  const store = await activeStore();
  return store.createAgentHomeConnection(input);
}

export async function updateAgentHomeConnection(input: Parameters<StoreModule["updateAgentHomeConnection"]>[0]) {
  const store = await activeStore();
  return store.updateAgentHomeConnection(input);
}

export async function getAgentConnectionCredential(input: Parameters<StoreModule["getAgentConnectionCredential"]>[0]) {
  const store = await activeStore();
  return store.getAgentConnectionCredential(input);
}

export async function replaceAgentConnectionCredential(input: Parameters<StoreModule["replaceAgentConnectionCredential"]>[0]) {
  const store = await activeStore();
  return store.replaceAgentConnectionCredential(input);
}

export async function markAgentConnectionNeedsReconnect(input: Parameters<StoreModule["markAgentConnectionNeedsReconnect"]>[0]) {
  const store = await activeStore();
  return store.markAgentConnectionNeedsReconnect(input);
}

export async function getRuntimeSecret(input: Parameters<StoreModule["getRuntimeSecret"]>[0]) {
  const store = await activeStore();
  return store.getRuntimeSecret(input);
}

export async function setRuntimeSecret(input: Parameters<StoreModule["setRuntimeSecret"]>[0]) {
  const store = await activeStore();
  return store.setRuntimeSecret(input);
}

export async function registerModelProxyGrant(input: Parameters<StoreModule["registerModelProxyGrant"]>[0]) {
  const store = await activeStore();
  return store.registerModelProxyGrant(input);
}

export async function consumeModelProxyGrant(input: Parameters<StoreModule["consumeModelProxyGrant"]>[0]) {
  const store = await activeStore();
  return store.consumeModelProxyGrant(input);
}

export async function revokeModelProxyGrant(input: Parameters<StoreModule["revokeModelProxyGrant"]>[0]) {
  const store = await activeStore();
  return store.revokeModelProxyGrant(input);
}

export async function recordAgentConnectionSmoke(input: Parameters<StoreModule["recordAgentConnectionSmoke"]>[0]) {
  const store = await activeStore();
  return store.recordAgentConnectionSmoke(input);
}

export async function getAgentHomeConnection(input: Parameters<StoreModule["getAgentHomeConnection"]>[0]) {
  const store = await activeStore();
  return store.getAgentHomeConnection(input);
}

export async function acquireCodexLoginLease(input: Parameters<StoreModule["acquireCodexLoginLease"]>[0]) {
  const store = await activeStore();
  return store.acquireCodexLoginLease(input);
}

export async function releaseCodexLoginLease(input: Parameters<StoreModule["releaseCodexLoginLease"]>[0]) {
  const store = await activeStore();
  return store.releaseCodexLoginLease(input);
}

export async function beginClaudeCodeLoginAttempt(input: Parameters<StoreModule["beginClaudeCodeLoginAttempt"]>[0]) {
  const store = await activeStore();
  return store.beginClaudeCodeLoginAttempt(input);
}

export async function submitClaudeCodeLoginCode(input: Parameters<StoreModule["submitClaudeCodeLoginCode"]>[0]) {
  const store = await activeStore();
  return store.submitClaudeCodeLoginCode(input);
}

export async function takeClaudeCodeLoginCode(input: Parameters<StoreModule["takeClaudeCodeLoginCode"]>[0]) {
  const store = await activeStore();
  return store.takeClaudeCodeLoginCode(input);
}

export async function releaseClaudeCodeLoginAttempt(input: Parameters<StoreModule["releaseClaudeCodeLoginAttempt"]>[0]) {
  const store = await activeStore();
  return store.releaseClaudeCodeLoginAttempt(input);
}

export async function reserveAgentRun(input: Parameters<StoreModule["reserveAgentRun"]>[0]) {
  const store = await activeStore();
  return store.reserveAgentRun(input);
}

export async function createAgentRun(input: Parameters<StoreModule["createAgentRun"]>[0]) {
  const store = await activeStore();
  return store.createAgentRun(input);
}

export async function listAgentRuns(filters?: Parameters<StoreModule["listAgentRuns"]>[0]) {
  const store = await activeStore();
  return store.listAgentRuns(filters);
}

export async function getAgentRun(id: string) {
  const store = await activeStore();
  return store.getAgentRun(id);
}

export async function findAgentRunByIdempotencyKey(input: Parameters<StoreModule["findAgentRunByIdempotencyKey"]>[0]) {
  const store = await activeStore();
  return store.findAgentRunByIdempotencyKey(input);
}

export async function updateAgentRun(input: Parameters<StoreModule["updateAgentRun"]>[0]) {
  const store = await activeStore();
  return store.updateAgentRun(input);
}

export async function updateJob(input: Parameters<StoreModule["updateJob"]>[0]) {
  const store = await activeStore();
  return store.updateJob(input);
}

export { buildDemoContributionCard };

export async function ensureSeedData() {
  const store = await activeStore();
  return store.ensureSeedData();
}
