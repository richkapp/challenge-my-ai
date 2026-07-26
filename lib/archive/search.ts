import { matchSearchReasons, tokenizeSearchQuery } from "@/lib/archive/searchUtils";
import type { Challenge, Contribution, ContributionMode, SynthesisBrief } from "@/lib/types";
import { isChallengePubliclyEligible } from "@/lib/challenges/intent";

export type AnswerArchiveItem = {
  id: string;
  title: string;
  category: string;
  status: Challenge["status"];
  reward: number;
  updatedAt: string;
  url: string;
  problemStatement: string;
  summary: string;
  currentAnswer: string;
  hasSynthesis: boolean;
  strongestObjections: string[];
  risks: string[];
  nextTests: string[];
  contributorModes: ContributionMode[];
  contributionCount: number;
  usefulSignals: number;
  score: number;
  matchReasons: string[];
};

type ArchiveInput = {
  challenges: Challenge[];
  contributionsByChallengeId?: Record<string, Contribution[]>;
  synthesesByChallengeId?: Record<string, SynthesisBrief | undefined>;
  query?: string;
  limit?: number;
};

export function buildAnswerArchive(input: ArchiveInput): AnswerArchiveItem[] {
  const queryTokens = tokenizeSearchQuery(input.query);

  return input.challenges
    .filter(isChallengePubliclyEligible)
    .map((challenge) => toArchiveItem(challenge, input.contributionsByChallengeId?.[challenge.id] || [], input.synthesesByChallengeId?.[challenge.id], queryTokens))
    .filter((item) => queryTokens.length === 0 || item.matchReasons.length > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.title.localeCompare(b.title))
    .slice(0, input.limit ?? 20);
}

function toArchiveItem(challenge: Challenge, contributions: Contribution[], synthesis: SynthesisBrief | undefined, queryTokens: string[]): AnswerArchiveItem {
  const postedContributions = contributions.filter((contribution) => contribution.status === "posted");
  const currentAnswer = synthesis?.improvedAnswer || challenge.brief.original_ai_answer;
  const strongestObjections = synthesis?.strongestObjections.length ? synthesis.strongestObjections : postedContributions.flatMap((contribution) => contribution.card.strongest_objections).slice(0, 4);
  const risks = synthesis?.risks.length ? synthesis.risks : postedContributions.flatMap((contribution) => contribution.card.risks_and_failure_modes).slice(0, 4);
  const nextTests = synthesis?.nextTests.length ? synthesis.nextTests : [...challenge.brief.claims_to_check, ...postedContributions.flatMap((contribution) => contribution.card.claims_to_verify)].slice(0, 5);
  const contributorModes = Array.from(new Set(postedContributions.map((contribution) => contribution.card.contribution_mode)));
  const usefulSignals = postedContributions.filter((contribution) => (contribution.opRating?.usefulness ?? 0) >= 7 || contribution.communityScore > 0).length;
  const fields = searchableFields({ challenge, currentAnswer, synthesis, contributions: postedContributions, strongestObjections, risks, nextTests });

  return {
    id: challenge.id,
    title: challenge.title,
    category: challenge.category,
    status: challenge.status,
    reward: challenge.reward,
    updatedAt: challenge.updatedAt,
    url: `/challenges/${challenge.id}`,
    problemStatement: challenge.brief.problem_statement,
    summary: challenge.brief.raw_material_summary || challenge.brief.problem_statement,
    currentAnswer,
    hasSynthesis: Boolean(synthesis),
    strongestObjections,
    risks,
    nextTests,
    contributorModes,
    contributionCount: postedContributions.length || challenge.contributionCount,
    usefulSignals,
    score: archiveScore(challenge, postedContributions, synthesis, usefulSignals),
    matchReasons: matchSearchReasons(fields, queryTokens),
  };
}

function archiveScore(challenge: Challenge, contributions: Contribution[], synthesis: SynthesisBrief | undefined, usefulSignals: number) {
  const updatedAt = Date.parse(challenge.updatedAt);
  const ageHours = Number.isFinite(updatedAt) ? Math.max(0, (Date.now() - updatedAt) / 3_600_000) : 72;
  const freshness = Math.max(0, 24 - Math.min(24, ageHours));
  return Math.max(1, Math.round(challenge.reward / 5 + contributions.length * 12 + usefulSignals * 8 + (synthesis ? 16 : 0) + freshness));
}

function searchableFields(input: {
  challenge: Challenge;
  currentAnswer: string;
  synthesis?: SynthesisBrief;
  contributions: Contribution[];
  strongestObjections: string[];
  risks: string[];
  nextTests: string[];
}) {
  const { challenge, contributions, currentAnswer, strongestObjections, risks, nextTests, synthesis } = input;
  return [
    { label: "title", text: challenge.title },
    { label: "category", text: challenge.category },
    { label: "problem", text: challenge.brief.problem_statement },
    { label: "context", text: challenge.brief.context },
    { label: "current answer", text: currentAnswer },
    { label: "objection", text: strongestObjections.join(" ") },
    { label: "risk", text: risks.join(" ") },
    { label: "next test", text: nextTests.join(" ") },
    { label: "synthesis", text: [synthesis?.unresolvedDisagreements.join(" "), synthesis?.confidence].filter(Boolean).join(" ") },
    { label: "contribution", text: contributions.map((contribution) => [contribution.card.verdict, contribution.card.reasoning_summary, contribution.card.alternative_recommendation, contribution.card.raw_output_summary].join(" ")).join(" ") },
  ];
}
