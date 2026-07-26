import { resolveEligibleAgentChallenge, type ChallengeEligibilityState } from "@/lib/store/challengeEligibility";
import type { Contribution, ContributionCard, Rating } from "@/lib/types";

export type ContributionTransactionState = ChallengeEligibilityState & {
  contributions: Contribution[];
  ratings: Rating[];
};

export type CreateContributionRecordInput = {
  contributionId: string;
  challengeId: string;
  contributorId: string;
  contributorKind: "human" | "agent";
  contributorLabel: string;
  card: ContributionCard;
  externallyGenerated: boolean;
  createdAt: string;
  expectedRevision?: number;
};

function refreshChallengeLifecycle(state: ContributionTransactionState, challengeId: string, updatedAt: string): void {
  const challenge = state.challenges.find((candidate) => candidate.id === challengeId);
  if (!challenge || !["open", "contributing", "ready_for_synthesis"].includes(challenge.status)) return;
  const posted = state.contributions.filter((contribution) => contribution.challengeId === challengeId && contribution.status === "posted");
  const usefulRated = posted.some((contribution) => {
    const rating = state.ratings.filter((candidate) => candidate.contributionId === contribution.id).at(-1);
    return (rating?.usefulness ?? 0) >= 7 && (rating?.safety ?? 5) >= 5;
  });
  challenge.status = posted.length >= 2 || usefulRated ? "ready_for_synthesis" : posted.length >= 1 ? "contributing" : "open";
  challenge.updatedAt = updatedAt;
}

export function createContributionRecordInState(
  state: ContributionTransactionState,
  input: CreateContributionRecordInput,
): Contribution {
  const eligible = resolveEligibleAgentChallenge(state, input.challengeId, input.expectedRevision);
  if (!eligible) throw new Error("Challenge is not accepting contributions.");
  if (input.card.challenge_id !== input.challengeId) throw new Error("Contribution card challenge does not match the target challenge.");
  if (state.contributions.some((contribution) => contribution.id === input.contributionId)) throw new Error("Contribution identifier already exists.");
  const contribution: Contribution = {
    id: input.contributionId,
    challengeId: input.challengeId,
    contributorId: input.contributorId,
    contributorKind: input.contributorKind,
    contributorLabel: input.contributorLabel,
    createdAt: input.createdAt,
    status: "posted",
    externallyGenerated: input.externallyGenerated,
    card: JSON.parse(JSON.stringify(input.card)) as ContributionCard,
    communityScore: 0,
    criteriaVersion: eligible.criteria.version,
    criteriaStatusAtSubmission: eligible.criteria.criteriaStatus,
  };
  state.contributions.unshift(contribution);
  refreshChallengeLifecycle(state, input.challengeId, input.createdAt);
  return JSON.parse(JSON.stringify(contribution)) as Contribution;
}
