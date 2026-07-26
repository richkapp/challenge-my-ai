import { contributionModes } from "@/lib/types";
import type { ContributionMode } from "@/lib/types";

export const maxRequestedPerspectives = 3;

export const defaultRequestedContributionModes = ["critique"] as const satisfies readonly ContributionMode[];

export const normalContributionModes = [
  "critique",
  "red_team",
  "alternate_proposal",
  "risk_audit",
  "steelman",
] as const satisfies readonly ContributionMode[];

export const advancedContributionModes = ["judge"] as const satisfies readonly ContributionMode[];

type ContributionModeCopy = {
  label: string;
  shortLabel: string;
  description: string;
};

export const contributionModeCopy: Record<ContributionMode, ContributionModeCopy> = {
  critique: {
    label: "Critique",
    shortLabel: "Critique",
    description: "Find weak reasoning, missing context, and practical objections.",
  },
  red_team: {
    label: "Red-team",
    shortLabel: "Red-team",
    description: "Attack the answer like it has to survive adversarial review.",
  },
  alternate_proposal: {
    label: "Alternate proposal",
    shortLabel: "Alternative",
    description: "Offer a materially different path, not just tweaks.",
  },
  steelman: {
    label: "Defend / steelman",
    shortLabel: "Steelman",
    description: "Make the strongest case for the original answer before judging it.",
  },
  risk_audit: {
    label: "Risk audit",
    shortLabel: "Risk audit",
    description: "Surface failure modes, safety concerns, and downside scenarios.",
  },
  judge: {
    label: "Judge",
    shortLabel: "Judge",
    description: "Score competing perspectives; kept for compatibility and advanced flows.",
  },
};

export function labelForContributionMode(mode: ContributionMode): string {
  return contributionModeCopy[mode]?.label || mode.replaceAll("_", " ");
}

export function shortLabelForContributionMode(mode: ContributionMode): string {
  return contributionModeCopy[mode]?.shortLabel || labelForContributionMode(mode);
}

export function descriptionForContributionMode(mode: ContributionMode): string {
  return contributionModeCopy[mode]?.description || "Add a useful perspective to this challenge.";
}

export function isNormalContributionMode(mode: ContributionMode): boolean {
  return (normalContributionModes as readonly ContributionMode[]).includes(mode);
}

export function isKnownContributionMode(mode: string): mode is ContributionMode {
  return (contributionModes as readonly string[]).includes(mode);
}

export function normalRequestedModes(modes: readonly ContributionMode[]): ContributionMode[] {
  const seen = new Set<ContributionMode>();
  const visibleModes: ContributionMode[] = [];
  for (const mode of modes) {
    if (!isNormalContributionMode(mode) || seen.has(mode)) continue;
    seen.add(mode);
    visibleModes.push(mode);
  }
  return visibleModes;
}

export function requestedContributionModesForNormalSurface(modes: readonly ContributionMode[]): ContributionMode[] {
  const visibleModes = normalRequestedModes(modes).slice(0, maxRequestedPerspectives);
  return visibleModes.length ? visibleModes : [...defaultRequestedContributionModes];
}

export function normalizeRequestedContributionModes(modes: readonly ContributionMode[]): ContributionMode[] {
  return requestedContributionModesForNormalSurface(modes);
}

export function defaultContributionModeForRequestedModes(modes: readonly ContributionMode[]): ContributionMode {
  return requestedContributionModesForNormalSurface(modes)[0] || defaultRequestedContributionModes[0];
}

export function parseNormalContributionModeFilter(value: string | undefined): ContributionMode | undefined {
  if (!value || !isKnownContributionMode(value)) return undefined;
  return isNormalContributionMode(value) ? value : undefined;
}
