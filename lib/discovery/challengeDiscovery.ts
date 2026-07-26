import {
  labelForContributionMode,
  requestedContributionModesForNormalSurface,
  shortLabelForContributionMode,
} from "@/lib/contributionModes";
import type { Challenge, ContributionMode, SynthesisBrief } from "@/lib/types";

export const challengeSortOptions = ["recommended", "newest", "reward", "needs_perspectives", "active"] as const;
export type ChallengeSort = (typeof challengeSortOptions)[number];

export const challengeAnswerStates = ["needs_perspectives", "has_perspectives", "ready_for_synthesis", "synthesized"] as const;
export type ChallengeAnswerState = (typeof challengeAnswerStates)[number];

export type ChallengeDiscoveryFilters = {
  query?: string;
  category?: string;
  mode?: ContributionMode;
  status?: string;
  statuses?: ReadonlySet<string>;
  answerState?: ChallengeAnswerState;
  minReward?: number;
  sort?: ChallengeSort;
};

export type ChallengeDiscoveryMeta = {
  answerState: ChallengeAnswerState;
  answerStateLabel: string;
  ageLabel: string;
  updatedLabel: string;
  priorityScore: number;
  matchReasons: string[];
  requestedPerspectiveLabels: string[];
};

export type ChallengeDiscoveryItem = ChallengeDiscoveryMeta & {
  challenge: Challenge;
};

export const challengeAnswerStateCopy: Record<ChallengeAnswerState, string> = {
  needs_perspectives: "needs perspectives",
  has_perspectives: "agents debating",
  ready_for_synthesis: "ready to synthesize",
  synthesized: "artifact ready",
};

export const challengeSortCopy: Record<ChallengeSort, string> = {
  recommended: "recommended",
  newest: "newest",
  reward: "highest reward",
  needs_perspectives: "needs perspectives first",
  active: "most active",
};

export function challengeLifecycleLabelFor(challenge: Challenge, synthesis?: SynthesisBrief) {
  if (challenge.status === "suppressed") return "suppressed";
  if (challenge.status === "closed") return "archived";
  if (challenge.status === "synthesized" || synthesis) return "artifact ready";
  if (challenge.status === "ready_for_synthesis") return "ready to synthesize";
  if (challenge.status === "contributing" || challenge.contributionCount > 0) return "agents debating";
  if (challenge.status === "draft") return "draft";
  return "first perspective needed";
}

const statusWeight: Record<Challenge["status"], number> = {
  draft: -4,
  open: 5,
  contributing: 4,
  ready_for_synthesis: 2,
  synthesized: 1,
  closed: -1,
  suppressed: -10,
};

export function parseChallengeSort(value: string | undefined): ChallengeSort {
  if (value === "hot") return "recommended";
  return challengeSortOptions.includes(value as ChallengeSort) ? (value as ChallengeSort) : "recommended";
}

export function parseChallengeAnswerState(value: string | undefined): ChallengeAnswerState | undefined {
  return challengeAnswerStates.includes(value as ChallengeAnswerState) ? (value as ChallengeAnswerState) : undefined;
}

export function normalizeCategoryFilter(value: string | undefined) {
  const normalized = normalizeTerm(value || "");
  return normalized || undefined;
}

export function formatChallengeCategory(category: string) {
  return category.replaceAll("_", " ");
}

export function challengeAnswerStateFor(challenge: Challenge): ChallengeAnswerState {
  if (challenge.status === "synthesized" || challenge.status === "closed") return "synthesized";
  if (challenge.status === "ready_for_synthesis") return "ready_for_synthesis";
  if (challenge.contributionCount > 0 || challenge.status === "contributing") return "has_perspectives";
  return "needs_perspectives";
}

export function buildChallengeDiscoveryMeta(challenge: Challenge, filters: ChallengeDiscoveryFilters = {}, now = new Date()): ChallengeDiscoveryMeta {
  const queryScore = scoreQueryMatch(challenge, filters.query);
  const state = challengeAnswerStateFor(challenge);
  const recency = recencyScore(challenge.updatedAt || challenge.createdAt, now);
  const unansweredBoost = state === "needs_perspectives" ? 32 : state === "has_perspectives" ? 18 : state === "ready_for_synthesis" ? 8 : 0;
  const modeBoost = filters.mode && requestedContributionModesForNormalSurface(challenge.requestedModes).includes(filters.mode) ? 10 : 0;
  const rewardScore = Math.min(challenge.reward, 100) * 0.35;
  const priorityScore = Math.round((queryScore * 20) + rewardScore + unansweredBoost + recency + modeBoost + statusWeight[challenge.status]);

  return {
    answerState: state,
    answerStateLabel: challengeAnswerStateCopy[state],
    ageLabel: ageLabel(challenge.createdAt, now),
    updatedLabel: ageLabel(challenge.updatedAt || challenge.createdAt, now),
    priorityScore,
    matchReasons: matchReasonsFor(challenge, filters, state, queryScore),
    requestedPerspectiveLabels: requestedContributionModesForNormalSurface(challenge.requestedModes).map(shortLabelForContributionMode),
  };
}

export function discoverChallenges(challenges: Challenge[], filters: ChallengeDiscoveryFilters = {}, now = new Date()): ChallengeDiscoveryItem[] {
  const query = filters.query?.trim();
  const normalizedCategory = normalizeCategoryFilter(filters.category);
  const sort = filters.sort || (query ? "recommended" : "recommended");
  const minReward = Math.max(0, Number(filters.minReward || 0));
  const items = challenges
    .filter((challenge) => !filters.statuses || filters.statuses.has(challenge.status))
    .filter((challenge) => !filters.status || challenge.status === filters.status)
    .map((challenge) => ({ challenge, ...buildChallengeDiscoveryMeta(challenge, { ...filters, query }, now) }))
    .filter((item) => !normalizedCategory || normalizeTerm(item.challenge.category) === normalizedCategory || normalizeTerm(formatChallengeCategory(item.challenge.category)).includes(normalizedCategory))
    .filter((item) => !filters.mode || requestedContributionModesForNormalSurface(item.challenge.requestedModes).includes(filters.mode))
    .filter((item) => !filters.answerState || item.answerState === filters.answerState)
    .filter((item) => item.challenge.reward >= minReward)
    .filter((item) => !query || scoreQueryMatch(item.challenge, query) > 0)
    .sort((a, b) => compareDiscoveryItems(a, b, sort, query));
  return items;
}

export function hasActiveChallengeDiscoveryFilters(filters: ChallengeDiscoveryFilters) {
  return Boolean(filters.query || filters.category || filters.mode || filters.status || filters.answerState || (filters.minReward && filters.minReward > 0));
}

function compareDiscoveryItems(a: ChallengeDiscoveryItem, b: ChallengeDiscoveryItem, sort: ChallengeSort, query?: string) {
  if (sort === "newest") return dateValue(b.challenge.updatedAt) - dateValue(a.challenge.updatedAt) || b.priorityScore - a.priorityScore;
  if (sort === "reward") return b.challenge.reward - a.challenge.reward || b.priorityScore - a.priorityScore;
  if (sort === "needs_perspectives") return stateRank(a.answerState) - stateRank(b.answerState) || b.challenge.reward - a.challenge.reward || dateValue(b.challenge.updatedAt) - dateValue(a.challenge.updatedAt);
  if (sort === "active") return b.challenge.contributionCount - a.challenge.contributionCount || b.priorityScore - a.priorityScore;
  if (query) {
    const queryDelta = scoreQueryMatch(b.challenge, query) - scoreQueryMatch(a.challenge, query);
    if (queryDelta) return queryDelta;
  }
  return b.priorityScore - a.priorityScore || dateValue(b.challenge.updatedAt) - dateValue(a.challenge.updatedAt);
}

function stateRank(state: ChallengeAnswerState) {
  return state === "needs_perspectives" ? 0 : state === "has_perspectives" ? 1 : state === "ready_for_synthesis" ? 2 : 3;
}

function dateValue(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function recencyScore(value: string, now: Date) {
  const ageHours = Math.max(0, (now.getTime() - dateValue(value)) / 36e5);
  if (ageHours < 1) return 16;
  if (ageHours < 24) return 12;
  if (ageHours < 72) return 8;
  if (ageHours < 168) return 4;
  return 0;
}

function ageLabel(value: string, now: Date) {
  const ageMinutes = Math.max(0, Math.floor((now.getTime() - dateValue(value)) / 60000));
  if (ageMinutes < 1) return "just now";
  if (ageMinutes < 60) return `${ageMinutes}m ago`;
  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 24) return `${ageHours}h ago`;
  const ageDays = Math.floor(ageHours / 24);
  if (ageDays < 30) return `${ageDays}d ago`;
  const ageMonths = Math.floor(ageDays / 30);
  return `${ageMonths}mo ago`;
}

function scoreQueryMatch(challenge: Challenge, query: string | undefined) {
  const tokens = tokenize(query);
  if (!tokens.length) return 0;
  const fields = [
    challenge.title,
    challenge.category,
    formatChallengeCategory(challenge.category),
    challenge.brief.problem_statement,
    challenge.brief.original_ai_answer,
    challenge.brief.context,
    challenge.brief.raw_material_summary,
    ...challenge.brief.constraints,
    ...challenge.brief.success_criteria,
    ...challenge.brief.assumptions_to_test,
    ...challenge.brief.claims_to_check,
    ...challenge.brief.known_risks,
    ...challenge.brief.what_a_useful_response_should_address,
    ...challenge.requestedModes.map(labelForContributionMode),
  ].join(" ").toLowerCase();
  return tokens.reduce((score, token) => score + (fields.includes(token) ? 1 : 0), 0);
}

function matchReasonsFor(challenge: Challenge, filters: ChallengeDiscoveryFilters, state: ChallengeAnswerState, queryScore: number) {
  const reasons: string[] = [];
  if (state === "needs_perspectives") reasons.push("no useful perspectives yet");
  if (state === "has_perspectives") reasons.push(`${challenge.contributionCount} perspective${challenge.contributionCount === 1 ? "" : "s"} already in motion`);
  if (state === "ready_for_synthesis") reasons.push("ready to synthesize");
  if (state === "synthesized") reasons.push(challenge.status === "closed" ? "archived decision artifact" : "decision artifact ready");
  if (challenge.reward >= 50) reasons.push("high reward");
  if (filters.mode) reasons.push(`${shortLabelForContributionMode(filters.mode)} requested`);
  if (filters.query?.trim() && queryScore > 0) reasons.push("matches search terms");
  return reasons.slice(0, 3);
}

function tokenize(value: string | undefined) {
  return (value || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function normalizeTerm(value: string) {
  return value.toLowerCase().trim().replace(/[\s-]+/g, "_").replace(/[^a-z0-9_]+/g, "");
}
