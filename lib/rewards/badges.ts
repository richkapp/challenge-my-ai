export type ContributorBadgeTier = "new_voice" | "useful_signal" | "trusted_challenger" | "synthesis_maker";

export type ContributorBadge = {
  tier: ContributorBadgeTier;
  label: string;
  shortLabel: string;
  description: string;
  nextMilestone: string;
  className: string;
  accentClassName: string;
  score: number;
};

export type ContributorBadgeInput = {
  creditsEarned?: number | null;
  contributionCount?: number | null;
  usefulRatings?: number | null;
  communityScore?: number | null;
};

const badgeTiers: Array<Omit<ContributorBadge, "score"> & { minScore: number }> = [
  {
    tier: "synthesis_maker",
    minScore: 240,
    label: "Synthesis Maker",
    shortLabel: "Maker",
    description: "Repeatedly earns useful ratings and moves threads toward better answers.",
    nextMilestone: "Keep the streak alive with high-signal critiques.",
    className: "bg-[#fef3c7] text-[#92400e] border-[#fcd34d]",
    accentClassName: "bg-[#facc15] text-[#422006]",
  },
  {
    tier: "trusted_challenger",
    minScore: 100,
    label: "Trusted Challenger",
    shortLabel: "Trusted",
    description: "Consistently contributes critiques that posters and the community find useful.",
    nextMilestone: "Reach 240 reward score to become a Synthesis Maker.",
    className: "bg-[#ecfeff] text-[#155e75] border-[#67e8f9]",
    accentClassName: "bg-[#06b6d4] text-white",
  },
  {
    tier: "useful_signal",
    minScore: 25,
    label: "Useful Signal",
    shortLabel: "Useful",
    description: "Has earned visible signal from useful Agent perspectives.",
    nextMilestone: "Reach 100 reward score to become a Trusted Challenger.",
    className: "bg-[#ecfdf5] text-[#065f46] border-[#86efac]",
    accentClassName: "bg-[#10b981] text-white",
  },
  {
    tier: "new_voice",
    minScore: 0,
    label: "New Voice",
    shortLabel: "New",
    description: "Ready to earn reputation by adding a useful Agent perspective.",
    nextMilestone: "Earn 25 reward score to unlock Useful Signal.",
    className: "bg-white text-zinc-700 border-zinc-200",
    accentClassName: "bg-zinc-900 text-white",
  },
];

function safeNumber(value: number | null | undefined) {
  return Number.isFinite(value) ? Math.max(0, Number(value)) : 0;
}

export function contributorRewardScore(input: ContributorBadgeInput) {
  const credits = safeNumber(input.creditsEarned);
  const contributions = safeNumber(input.contributionCount);
  const usefulRatings = safeNumber(input.usefulRatings);
  const community = safeNumber(input.communityScore);
  const usefulnessSignal = credits + usefulRatings;
  const usefulVolumeBonus = Math.min(contributions, usefulRatings) * 6;
  const communityBonus = usefulnessSignal > 0 ? Math.min(community, 5) * 3 : 0;
  return Math.round(credits + usefulRatings * 24 + usefulVolumeBonus + communityBonus);
}

export function contributorBadge(input: ContributorBadgeInput): ContributorBadge {
  const score = contributorRewardScore(input);
  const tier = badgeTiers.find((candidate) => score >= candidate.minScore) ?? badgeTiers[badgeTiers.length - 1];
  const { minScore: _minScore, ...badge } = tier;
  return { ...badge, score };
}

export function initialsForLabel(label: string) {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}
