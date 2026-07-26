import type { Challenge, Contribution, SynthesisBrief } from "@/lib/types";

export type BuildSynthesisBriefInput = {
  challenge: Challenge;
  contributions: Contribution[];
  id: string;
  jobId: string;
  createdAt: string;
};

type ScoredContribution = {
  contribution: Contribution;
  score: number;
};

const maxItems = {
  objections: 6,
  changes: 6,
  risks: 6,
  disagreements: 6,
  nextTests: 6,
};

export function buildSynthesisBrief(input: BuildSynthesisBriefInput): SynthesisBrief {
  const posted = input.contributions.filter((contribution) => contribution.status === "posted");
  const ranked = rankContributions(posted);
  const best = ranked[0]?.contribution;
  const useful = ranked.filter((item) => item.score >= 20).map((item) => item.contribution);
  const usefulOrAll = useful.length ? useful : posted;
  const safetyNotes = uniqueNonEmpty(
    input.challenge.brief.known_risks,
    input.challenge.brief.abuse_or_safety_flags,
    posted.flatMap((contribution) => contribution.card.safety_or_scope_notes),
    posted.flatMap((contribution) => contribution.card.abuse_or_prompt_injection_flags),
  );
  const strongestObjections = uniqueNonEmpty(usefulOrAll.flatMap((contribution) => contribution.card.strongest_objections)).slice(0, maxItems.objections);
  const risks = uniqueNonEmpty(
    usefulOrAll.flatMap((contribution) => contribution.card.risks_and_failure_modes),
    safetyNotes,
  ).slice(0, maxItems.risks);
  const whatChanged = uniqueNonEmpty(
    best ? [`Current best answer moved toward: ${best.card.alternative_recommendation}`] : [],
    usefulOrAll.map((contribution) => contribution.card.alternative_recommendation),
    usefulOrAll.map((contribution) => contribution.card.reasoning_summary),
  ).filter((item) => normalized(item) !== normalized(input.challenge.brief.original_ai_answer)).slice(0, maxItems.changes);
  const unresolvedDisagreements = uniqueNonEmpty(
    posted.map((contribution) => contribution.card.verdict),
    posted.flatMap((contribution) => contribution.card.missing_assumptions_or_context),
    posted.flatMap((contribution) => contribution.card.what_would_change_my_mind),
  ).slice(0, maxItems.disagreements);
  const nextTests = uniqueNonEmpty(
    input.challenge.brief.claims_to_check,
    input.challenge.brief.assumptions_to_test,
    posted.flatMap((contribution) => contribution.card.claims_to_verify),
    safetyNotes.length ? ["Re-check safety, legal, medical, financial, or other professional-advice caveats before acting on this answer."] : [],
  ).slice(0, maxItems.nextTests);

  return {
    id: input.id,
    challengeId: input.challenge.id,
    createdAt: input.createdAt,
    jobId: input.jobId,
    improvedAnswer: best?.card.alternative_recommendation || fallbackImprovedAnswer(input.challenge, strongestObjections),
    whatChanged: whatChanged.length ? whatChanged : fallbackWhatChanged(input.challenge, strongestObjections),
    strongestObjections,
    risks,
    confidence: confidenceFor(ranked, posted, safetyNotes),
    unresolvedDisagreements,
    nextTests,
  };
}

function rankContributions(contributions: Contribution[]): ScoredContribution[] {
  return contributions
    .map((contribution) => ({ contribution, score: contributionScore(contribution) }))
    .sort((a, b) => b.score - a.score || Date.parse(b.contribution.createdAt) - Date.parse(a.contribution.createdAt) || a.contribution.id.localeCompare(b.contribution.id));
}

function contributionScore(contribution: Contribution) {
  const usefulness = contribution.opRating?.usefulness ?? 0;
  const safety = contribution.opRating?.safety ?? 5;
  const selfGrade = contribution.card.original_answer_grade.score_0_to_10;
  const confidence = contribution.card.confidence.level === "high" ? 3 : contribution.card.confidence.level === "medium" ? 2 : 1;
  const provenance = provenanceScore(contribution.card.model_provenance?.source, contribution.card.model_provenance?.verified);
  const community = Math.max(-3, Math.min(3, contribution.communityScore));
  const textSubstance = [
    contribution.card.alternative_recommendation,
    contribution.card.reasoning_summary,
    contribution.card.strongest_objections.join(" "),
    contribution.card.risks_and_failure_modes.join(" "),
  ].join(" ").trim().length > 80 ? 2 : 0;
  const unsafePenalty = safety < 4 || contribution.card.abuse_or_prompt_injection_flags.length ? -25 : 0;
  return usefulness * 10 + safety + confidence + provenance + community + textSubstance + Math.max(0, selfGrade - 5) + unsafePenalty;
}

function provenanceScore(source: string | undefined, verified: boolean | undefined) {
  if (source === "provider_signed") return 8;
  if (source === "provider_api_verified" && verified) return 7;
  if (source === "platform_run" && verified) return 6;
  if (source === "hermes_sandbox_run") return 5;
  if (source === "client_attested") return 2;
  return 0;
}

function confidenceFor(ranked: ScoredContribution[], contributions: Contribution[], safetyNotes: string[]): SynthesisBrief["confidence"] {
  if (!contributions.length) return "low";
  const usefulCount = ranked.filter((item) => item.contribution.opRating && item.contribution.opRating.usefulness >= 7 && item.contribution.opRating.safety >= 6).length;
  if (usefulCount >= 2 && safetyNotes.length === 0) return "high";
  if (contributions.length >= 2 || usefulCount >= 1) return "medium";
  return "low";
}

function fallbackImprovedAnswer(challenge: Challenge, objections: string[]) {
  const checks = uniqueNonEmpty(challenge.brief.what_a_useful_response_should_address, challenge.brief.claims_to_check, objections).slice(0, 4);
  return `Re-check the starting answer against: ${checks.join(", ") || "the strongest missing assumptions"}.`;
}

function fallbackWhatChanged(challenge: Challenge, objections: string[]) {
  return [`The current answer now has to account for: ${uniqueNonEmpty(objections, challenge.brief.what_a_useful_response_should_address).slice(0, 3).join(", ") || "the strongest objections"}.`];
}

function uniqueNonEmpty(...groups: Array<string[] | undefined>) {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const group of groups) {
    for (const value of group || []) {
      const trimmed = value.replace(/\s+/g, " ").trim();
      const key = normalized(trimmed);
      if (!trimmed || seen.has(key)) continue;
      seen.add(key);
      values.push(trimmed);
    }
  }
  return values;
}

function normalized(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}
