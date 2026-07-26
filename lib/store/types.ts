import type { AgentRun, Challenge, ChallengeBrief, CommunityVoteResult, CommunityVoteValue, Contribution, ContributionCard, ContributionMode, CreditEvent, Job, ModerationAction, ModerationActionResult, ModerationEvent, ModerationTargetType, Rating, SafetyFlag, SynthesisBrief } from "@/lib/types";
import type { PublicContributorProfileStoreData } from "@/lib/store/publicProfile";

export type ChallengeFilters = Partial<{ category: string; mode: ContributionMode; status: string }>;

export type Store = {
  createChallenge(input: { id?: string; posterId?: string; visibility: "public" | "private"; reward: number; brief: ChallengeBrief; safetyFlags?: SafetyFlag[] }): Challenge;
  listChallenges(filters?: ChallengeFilters): Challenge[];
  getChallenge(id: string): Challenge | undefined;
  createContribution(input: { challengeId: string; contributorId?: string; card: ContributionCard; externallyGenerated?: boolean }): Contribution;
  listContributions(challengeId: string): Contribution[];
  getContribution(id: string): Contribution | undefined;
  rateContribution(input: { contributionId: string; raterId?: string; usefulness: number; novelty?: number; correctness?: number; safety?: number; comment?: string }): Rating;
  communityVote(contributionId: string, value: CommunityVoteValue, voterId?: string): CommunityVoteResult;
  appendCredit(input: { userId: string; challengeId?: string; contributionId?: string; amount: number; reason: string; kind?: CreditEvent["kind"]; source?: CreditEvent["source"]; idempotencyKey?: string; metadata?: CreditEvent["metadata"] }): CreditEvent;
  listCreditEvents(userId?: string): CreditEvent[];
  getPublicContributorProfileData(contributorId: string): PublicContributorProfileStoreData;
  synthesizeChallenge(challengeId: string): SynthesisBrief;
  getLatestSynthesis(challengeId: string): SynthesisBrief | undefined;
  getJob(id: string): Job | undefined;
  reportTarget(input: { targetType: ModerationTargetType; targetId: string; reason: string; actorId?: string; note?: string }): ModerationEvent;
  listModerationEvents(limit?: number): ModerationEvent[];
  moderateTarget(input: { targetType: ModerationTargetType; targetId: string; action: Exclude<ModerationAction, "report">; reason: string; actorId?: string; note?: string }): ModerationActionResult;
  suppressChallenge(id: string, reason: string, actorId?: string, note?: string): ModerationActionResult;
  restoreChallenge(id: string, reason: string, actorId?: string, note?: string): ModerationActionResult;
  suppressContribution(id: string, reason: string, actorId?: string, note?: string): ModerationActionResult;
  restoreContribution(id: string, reason: string, actorId?: string, note?: string): ModerationActionResult;
  listAgentRuns(filters?: { ownerId?: string; challengeId?: string; connectionId?: string; statuses?: AgentRun["status"][]; since?: string }): AgentRun[];
  reserveAgentRun(input: { agentHomeId: string; connectionId: string; challengeId: string; contributorId: string; requestedMode: ContributionMode; requestedModel?: string; provider?: string; requestClass?: string; idempotencyKey: string; promptVersion?: string }): { run: AgentRun; job?: Job; reused: boolean };
};
