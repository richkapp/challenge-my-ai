import type { Challenge, Contribution, CreditEvent, Rating, SynthesisBrief } from "@/lib/types";
import { isChallengePubliclyEligible } from "@/lib/challenges/intent";

export type PublicContributorProfileStoreRow = {
  challenge: Challenge;
  contributions: Contribution[];
  synthesis?: SynthesisBrief;
};

export type PublicContributorProfileStoreData = {
  rows: PublicContributorProfileStoreRow[];
  creditEvents: CreditEvent[];
};

type PublicContributorProfileState = {
  challenges: Challenge[];
  contributions: Contribution[];
  ratings: Rating[];
  creditEvents: CreditEvent[];
  synthesisBriefs: SynthesisBrief[];
};

export function selectPublicContributorProfileData(state: PublicContributorProfileState, contributorId: string): PublicContributorProfileStoreData {
  const publicChallenges = state.challenges.filter(isChallengePubliclyEligible);
  const publicChallengeIds = new Set(publicChallenges.map((challenge) => challenge.id));
  const visibleContributions = state.contributions.filter((contribution) => (
    contribution.contributorId === contributorId
    && contribution.status === "posted"
    && publicChallengeIds.has(contribution.challengeId)
  ));
  const visibleContributionIds = new Set(visibleContributions.map((contribution) => contribution.id));
  const visibleChallengeIds = new Set(visibleContributions.map((contribution) => contribution.challengeId));

  const rows = publicChallenges
    .map((challenge) => {
      const contributions = visibleContributions
        .filter((contribution) => contribution.challengeId === challenge.id)
        .map((contribution) => withLatestRating(state, contribution));
      if (!contributions.length) return undefined;
      const synthesis = state.synthesisBriefs.find((brief) => brief.challengeId === challenge.id);
      const row: PublicContributorProfileStoreRow = {
        challenge: withContributionCount(state, challenge),
        contributions,
      };
      if (synthesis) row.synthesis = clone(synthesis);
      return row;
    })
    .filter((row): row is PublicContributorProfileStoreRow => Boolean(row));

  const creditEvents = state.creditEvents
    .filter((event) => event.userId === contributorId)
    .filter((event) => isVisibleProfileCreditEvent(event, { visibleContributionIds, visibleChallengeIds }))
    .map(clone);

  return { rows, creditEvents };
}

function isVisibleProfileCreditEvent(event: CreditEvent, input: { visibleContributionIds: Set<string>; visibleChallengeIds: Set<string> }) {
  if (event.contributionId) return input.visibleContributionIds.has(event.contributionId);
  if (!event.challengeId || !input.visibleChallengeIds.has(event.challengeId)) return false;
  return event.kind === "usefulness_reward" || event.kind === "reversal" || event.kind === "moderation_adjustment" || (!event.kind && event.amount > 0);
}

function withContributionCount(state: PublicContributorProfileState, challenge: Challenge): Challenge {
  return {
    ...clone(challenge),
    contributionCount: state.contributions.filter((contribution) => contribution.challengeId === challenge.id && contribution.status === "posted").length,
  };
}

function withLatestRating(state: PublicContributorProfileState, contribution: Contribution): Contribution {
  return {
    ...clone(contribution),
    opRating: state.ratings.filter((rating) => rating.contributionId === contribution.id).at(-1),
  };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
