import { summarizeReputation } from "@/lib/credits/reputation";
import { shortLabelForContributionMode } from "@/lib/contributionModes";
import { formatChallengeCategory } from "@/lib/discovery/challengeDiscovery";
import { contributorBadge } from "@/lib/rewards/badges";
import type { Challenge, Contribution, CreditEvent, SynthesisBrief } from "@/lib/types";
import type { PublicContributorProfileStoreRow } from "@/lib/store/publicProfile";

export type PublicContributorProfileRow = PublicContributorProfileStoreRow;

export type PublicContributorProfileContribution = {
  id: string;
  challengeId: string;
  challengeTitle: string;
  challengeCategory: string;
  challengeHref: string;
  artifactHref?: string;
  createdAt: string;
  contributorLabel: string;
  contributionModeLabel: string;
  verdict: string;
  answerSummary: string;
  usefulness?: number;
  communityScore: number;
};

export type PublicContributorProfile = {
  id: string;
  displayLabel: string;
  badge: ReturnType<typeof contributorBadge>;
  reputation: ReturnType<typeof summarizeReputation>;
  publicContributionCount: number;
  usefulContributionCount: number;
  communityScore: number;
  decisionArtifactCount: number;
  recentContributions: PublicContributorProfileContribution[];
  shareUrl: string;
  referralLinks: {
    browse: string;
    post: string;
    answers: string;
  };
};

export function buildPublicContributorProfile(input: { contributorId: string; rows: PublicContributorProfileRow[]; creditEvents: CreditEvent[] }): PublicContributorProfile {
  const id = input.contributorId;
  const publicRows = input.rows.filter((row) => row.challenge.visibility === "public" && row.challenge.status !== "suppressed");
  const contributions = publicRows.flatMap((row) => row.contributions
    .filter((contribution) => contribution.contributorId === id && contribution.status === "posted")
    .map((contribution) => toProfileContribution({ contribution, challenge: row.challenge, synthesis: row.synthesis })));
  const visibleContributionIds = new Set(contributions.map((contribution) => contribution.id));
  const visibleChallengeIds = new Set(contributions.map((contribution) => contribution.challengeId));
  const reputation = summarizeReputation(input.creditEvents.filter((event) => event.userId === id && isVisibleProfileCreditEvent(event, { visibleContributionIds, visibleChallengeIds })));
  const usefulContributionCount = contributions.filter((contribution) => (contribution.usefulness ?? 0) >= 7).length;
  const communityScore = contributions.reduce((sum, contribution) => sum + contribution.communityScore, 0);
  const displayLabel = publicContributorLabel(id, contributions[0]?.contributorLabel);
  const badge = contributorBadge({
    creditsEarned: reputation.earned,
    contributionCount: contributions.length,
    usefulRatings: usefulContributionCount,
    communityScore: Math.max(0, communityScore),
  });
  const ref = encodeURIComponent(`profile:${id}`);

  return {
    id,
    displayLabel,
    badge,
    reputation,
    publicContributionCount: contributions.length,
    usefulContributionCount,
    communityScore,
    decisionArtifactCount: contributions.filter((contribution) => Boolean(contribution.artifactHref)).length,
    recentContributions: contributions
      .sort((a, b) => contributionProfileRank(b) - contributionProfileRank(a) || Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.challengeTitle.localeCompare(b.challengeTitle))
      .slice(0, 8),
    shareUrl: profileHref(id),
    referralLinks: {
      browse: `/lobby?ref=${ref}`,
      post: `/challenges/new?ref=${ref}`,
      answers: `/answers?ref=${ref}`,
    },
  };
}

export function profileHref(id: string) {
  return `/profile/${encodeURIComponent(id)}`;
}

export function publicContributorLabel(id: string, label?: string) {
  const trimmed = label?.trim() || "";
  if (trimmed && !isUnsafePublicContributorLabel(trimmed)) return trimmed;
  return publicContributorFallbackLabel(id);
}

function toProfileContribution(input: { contribution: Contribution; challenge: Challenge; synthesis?: SynthesisBrief }): PublicContributorProfileContribution {
  const { contribution, challenge, synthesis } = input;
  return {
    id: contribution.id,
    challengeId: challenge.id,
    challengeTitle: challenge.title,
    challengeCategory: formatChallengeCategory(challenge.category),
    challengeHref: `/challenges/${challenge.id}`,
    artifactHref: synthesis ? `/answers/${challenge.id}` : undefined,
    createdAt: contribution.createdAt,
    contributorLabel: publicContributorLabel(contribution.contributorId, contribution.contributorLabel),
    contributionModeLabel: shortLabelForContributionMode(contribution.card.contribution_mode),
    verdict: contribution.card.verdict,
    answerSummary: contribution.card.answer_to_challenge_poster,
    usefulness: contribution.opRating?.usefulness,
    communityScore: contribution.communityScore,
  };
}

function isVisibleProfileCreditEvent(event: CreditEvent, input: { visibleContributionIds: Set<string>; visibleChallengeIds: Set<string> }) {
  if (event.contributionId) return input.visibleContributionIds.has(event.contributionId);
  if (!event.challengeId || !input.visibleChallengeIds.has(event.challengeId)) return false;
  return event.kind === "usefulness_reward" || event.kind === "reversal" || event.kind === "moderation_adjustment" || (!event.kind && event.amount > 0);
}

function contributionProfileRank(contribution: PublicContributorProfileContribution) {
  return (contribution.usefulness ?? -1) * 10_000 + contribution.communityScore * 100 + (contribution.artifactHref ? 50 : 0);
}

function publicContributorFallbackLabel(id: string) {
  const token = publicContributorToken(id);
  return token ? `Contributor ${token}` : "Public contributor";
}

function isUnsafePublicContributorLabel(label: string) {
  return /\S+@\S+\.\S+/.test(label) || label.includes("@");
}

function publicContributorToken(id: string) {
  const trimmed = id.trim();
  if (!trimmed) return "";
  if (!isUnsafePublicContributorLabel(trimmed) && /^[a-z0-9][a-z0-9_-]{1,24}$/i.test(trimmed)) return trimmed;

  let hash = 0;
  for (const character of trimmed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash.toString(36).slice(0, 8) || "public";
}
