import type { Challenge, CommunityVoteDecision, CommunityVoteValue, Contribution } from "@/lib/types";
import { isChallengePubliclyEligible } from "@/lib/challenges/intent";

export const communityVotePolicy = {
  affectsCredits: false,
  influence: "visibility_trust_tiebreaker",
  countedVoteWeight: 1,
  maxTieBreakerCommunityScore: 99,
} as const;

export class CommunityVoteRejectedError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

export function normalizeCommunityVoteValue(value: number): CommunityVoteValue {
  return value >= 0 ? 1 : -1;
}

export function assertCommunityVoteAllowed(input: { contribution: Contribution; challenge: Challenge; voterId: string }) {
  if (input.contribution.contributorId === input.voterId) {
    throw new CommunityVoteRejectedError(403, "self_vote_blocked", "Contributors cannot add community trust votes to their own contribution.", { affectsCredits: false });
  }
  if (input.contribution.status !== "posted") {
    throw new CommunityVoteRejectedError(409, "vote_target_unavailable", "Community votes are only counted on posted contributions.", { status: input.contribution.status, affectsCredits: false });
  }
  if (!isChallengePubliclyEligible(input.challenge)) {
    throw new CommunityVoteRejectedError(409, "vote_target_unavailable", "Community votes are not counted on challenges that are unavailable for public interaction.", { status: input.challenge.status, affectsCredits: false });
  }
}

export function buildCommunityVoteDecision(input: { contributionId: string; voterId: string; value: CommunityVoteValue; previousValue?: CommunityVoteValue; scoreDelta: number }): CommunityVoteDecision {
  const reason = input.previousValue === undefined ? "counted" : input.previousValue === input.value ? "duplicate" : "changed";
  const message = reason === "duplicate"
    ? "Duplicate community vote ignored. Your existing visibility/trust signal is already counted."
    : reason === "changed"
      ? "Community vote changed for visibility and trust only. Poster rewards decide credits."
      : "Community vote counted for visibility and trust only. Poster rewards decide credits.";
  return {
    contributionId: input.contributionId,
    voterId: input.voterId,
    value: input.value,
    previousValue: input.previousValue,
    counted: input.scoreDelta !== 0,
    reason,
    scoreDelta: input.scoreDelta,
    message,
    policy: { ...communityVotePolicy },
  };
}
