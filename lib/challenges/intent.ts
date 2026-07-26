import { z } from "zod";

export const CHALLENGE_SEMANTICS_VERSION = "1.0" as const;
export const challengeIntents = ["solve", "decide", "pressure_test", "perspectives", "debate", "options", "audit"] as const;
export const challengeSuccessfulOutcomes = [
  "solved",
  "decision_ready",
  "review_complete",
  "sufficiently_explored",
  "closed_with_conclusion",
  "closed_with_disagreement",
  "option_set_complete",
  "audit_complete",
] as const;
export const challengeCriteriaStatuses = ["confirmed", "criteria_unconfirmed"] as const;
export const challengeImpactTiers = ["signal", "useful", "material", "decisive"] as const;

export const challengeIntentSchema = z.enum(challengeIntents);
export const challengeSuccessfulOutcomeSchema = z.enum(challengeSuccessfulOutcomes);
export const challengeCriteriaStatusSchema = z.enum(challengeCriteriaStatuses);

const boundedCriteriaArraySchema = z.array(z.string().trim().min(1).max(240)).max(8);

export const challengeCriteriaHistoryEntrySchema = z.object({
  version: z.number().int().positive(),
  intent: challengeIntentSchema,
  status: challengeCriteriaStatusSchema,
  success_criteria: boundedCriteriaArraySchema,
  successful_outcomes: z.array(challengeSuccessfulOutcomeSchema).min(1).max(2),
  change_reason: z.string().trim().min(1).max(240),
}).strict();

export const declarativeRewardPostureSchema = z.object({
  basis: z.literal("poster_confirmed_impact"),
  funding_state: z.literal("declarative_only"),
  eligible_impact_tiers: z.tuple([
    z.literal("signal"),
    z.literal("useful"),
    z.literal("material"),
    z.literal("decisive"),
  ]),
  completion_bonus: z.enum(["eligible", "not_applicable"]),
}).strict();

export const challengeSemanticsVersionSchema = z.literal(CHALLENGE_SEMANTICS_VERSION);
export const challengeCriteriaVersionSchema = z.number().int().positive();
export const challengeCriteriaHistorySchema = z.array(challengeCriteriaHistoryEntrySchema).min(1).max(20);
export const challengeSuccessfulOutcomesSchema = z.array(challengeSuccessfulOutcomeSchema).min(1).max(2);

export type ChallengeIntent = z.infer<typeof challengeIntentSchema>;
export type ChallengeSuccessfulOutcome = z.infer<typeof challengeSuccessfulOutcomeSchema>;
export type ChallengeCriteriaStatus = z.infer<typeof challengeCriteriaStatusSchema>;
export type ChallengeCriteriaHistoryEntry = z.infer<typeof challengeCriteriaHistoryEntrySchema>;
export type DeclarativeRewardPosture = z.infer<typeof declarativeRewardPostureSchema>;

export type ChallengeSemantics = {
  challenge_semantics_version: typeof CHALLENGE_SEMANTICS_VERSION;
  challenge_intent: ChallengeIntent;
  criteria_status: ChallengeCriteriaStatus;
  criteria_version: number;
  successful_outcomes: ChallengeSuccessfulOutcome[];
  criteria_history: ChallengeCriteriaHistoryEntry[];
  reward_posture: DeclarativeRewardPosture;
};

export type IntentAwareChallengeBrief = {
  success_criteria: string[];
  constraints: string[];
  missing_information: string[];
  privacy_sensitivity: "public_ok" | "anonymize_first" | "private_only" | "unknown";
  challenge_semantics_version?: typeof CHALLENGE_SEMANTICS_VERSION;
  challenge_intent?: ChallengeIntent;
  criteria_status?: ChallengeCriteriaStatus;
  criteria_version?: number;
  successful_outcomes?: ChallengeSuccessfulOutcome[];
  criteria_history?: ChallengeCriteriaHistoryEntry[];
  reward_posture?: DeclarativeRewardPosture;
};

export type ChallengeIntentIssue = {
  path: string;
  message: string;
};

type ChallengePublicEligibilityRecord = {
  visibility: string;
  status: string;
  brief: {
    criteria_status?: ChallengeCriteriaStatus;
    privacy_sensitivity: string;
  };
  publicEligibility?: {
    eligible: boolean;
    reasons: string[];
  };
};

export type ChallengeIntentPolicy = {
  intent: ChallengeIntent;
  label: string;
  successfulOutcomes: readonly ChallengeSuccessfulOutcome[];
  successfulOutcomeLabel: string;
  requiredCriteria: readonly { dimension: string; label: string; suggestedCriterion: string }[];
  completionBonus: DeclarativeRewardPosture["completion_bonus"];
};

const policies: Record<ChallengeIntent, ChallengeIntentPolicy> = {
  solve: {
    intent: "solve",
    label: "Solve a problem",
    successfulOutcomes: ["solved"],
    successfulOutcomeLabel: "Solved",
    requiredCriteria: [
      { dimension: "observable_result", label: "Observable result", suggestedCriterion: "The blocker is removed or the target result is observed under the stated constraints." },
    ],
    completionBonus: "eligible",
  },
  decide: {
    intent: "decide",
    label: "Make a decision",
    successfulOutcomes: ["decision_ready"],
    successfulOutcomeLabel: "Decision-ready",
    requiredCriteria: [
      { dimension: "decision_rule", label: "Decision rule", suggestedCriterion: "The decision rule and material trade-offs are explicit enough to choose." },
      { dimension: "minimum_evidence", label: "Minimum evidence", suggestedCriterion: "Remaining uncertainty is visible and no longer blocks the choice or next test." },
    ],
    completionBonus: "eligible",
  },
  pressure_test: {
    intent: "pressure_test",
    label: "Pressure-test a plan",
    successfulOutcomes: ["review_complete"],
    successfulOutcomeLabel: "Review complete",
    requiredCriteria: [
      { dimension: "risk_coverage", label: "Risk coverage", suggestedCriterion: "Material risks and failure modes are identified and severity-ranked." },
      { dimension: "finding_disposition", label: "Risk disposition", suggestedCriterion: "Each material risk has an accepted, rejected, or deferred fix with rationale." },
    ],
    completionBonus: "not_applicable",
  },
  perspectives: {
    intent: "perspectives",
    label: "Gather perspectives",
    successfulOutcomes: ["sufficiently_explored"],
    successfulOutcomeLabel: "Sufficiently explored",
    requiredCriteria: [
      { dimension: "perspective_coverage", label: "Perspective coverage", suggestedCriterion: "The requested perspective categories have meaningful coverage." },
      { dimension: "diminishing_returns", label: "Diminishing returns", suggestedCriterion: "New perspectives are mostly repetitive and no obvious high-value viewpoint is missing." },
    ],
    completionBonus: "not_applicable",
  },
  debate: {
    intent: "debate",
    label: "Debate a claim",
    successfulOutcomes: ["closed_with_conclusion", "closed_with_disagreement"],
    successfulOutcomeLabel: "Closed with conclusion or disagreement",
    requiredCriteria: [
      { dimension: "argument_coverage", label: "Argument coverage", suggestedCriterion: "The strongest cases for and against the claim are recorded with their evidence." },
      { dimension: "disagreement_recorded", label: "Remaining disagreement", suggestedCriterion: "Unresolved evidence or value disagreements remain explicit rather than being forced into consensus." },
    ],
    completionBonus: "not_applicable",
  },
  options: {
    intent: "options",
    label: "Generate options",
    successfulOutcomes: ["option_set_complete"],
    successfulOutcomeLabel: "Option set complete",
    requiredCriteria: [
      { dimension: "option_diversity", label: "Option diversity", suggestedCriterion: "The option set contains meaningfully different viable approaches rather than reworded duplicates." },
      { dimension: "comparison_criteria", label: "Comparison criteria", suggestedCriterion: "The options can be compared against explicit constraints and decision criteria." },
    ],
    completionBonus: "not_applicable",
  },
  audit: {
    intent: "audit",
    label: "Audit or red-team",
    successfulOutcomes: ["audit_complete"],
    successfulOutcomeLabel: "Audit complete",
    requiredCriteria: [
      { dimension: "finding_coverage", label: "Finding coverage", suggestedCriterion: "Material findings are identified and severity-ranked against the stated audit scope." },
      { dimension: "finding_disposition", label: "Finding disposition", suggestedCriterion: "Each material finding is accepted, rejected, or deferred with rationale and an owner or next action." },
    ],
    completionBonus: "eligible",
  },
};

const semanticKeys = [
  "challenge_semantics_version",
  "challenge_intent",
  "criteria_status",
  "criteria_version",
  "successful_outcomes",
  "criteria_history",
  "reward_posture",
] as const;
const LEGACY_MAPPING_REASON = "Legacy brief mapped conservatively; the poster must confirm intent and criteria before decisive closure.";

const impossibleCriterionPatterns = [
  /\bimpossible\b/i,
  /\bcannot be satisfied\b/i,
  /\ball possible perspectives\b/i,
  /\beveryone agrees\b/i,
  /\bzero uncertainty\b/i,
  /\babsolute certainty\b/i,
  /\bguarantee(?:d)? no failures?\b/i,
  /\bnever fail under any circumstances\b/i,
  /\bguarantee(?:d|s)?\b/i,
  /\bmust be accepted as (?:correct|successful|satisfied)\b/i,
  /\bno reasonable (?:person|reviewer) (?:could|would) (?:disagree|object)\b/i,
  /\b(?:obviously|indisputably|unquestionably) (?:correct|successful|satisfied)\b/i,
];
const invisibleCriterionFormattingPattern = /[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

export class ChallengeIntentValidationError extends Error {
  constructor(public issues: ChallengeIntentIssue[]) {
    super(issues[0]?.message || "Challenge intent contract failed validation.");
  }
}

export function challengeIntentPolicy(intent: ChallengeIntent): ChallengeIntentPolicy {
  return policies[intent];
}

export function challengeIntentLabel(intent: ChallengeIntent): string {
  return policies[intent].label;
}

export function successfulOutcomeLabel(outcome: ChallengeSuccessfulOutcome): string {
  return outcome.split("_").map((part) => `${part[0]?.toUpperCase() || ""}${part.slice(1)}`).join(" ");
}

export function requiredCriteriaLabels(intent: ChallengeIntent): string[] {
  return policies[intent].requiredCriteria.map((criterion) => criterion.label);
}

export function defaultSuccessCriteria(intent: ChallengeIntent): string[] {
  return policies[intent].requiredCriteria.map((criterion) => criterion.suggestedCriterion);
}

export function declarativeRewardPosture(intent: ChallengeIntent): DeclarativeRewardPosture {
  return {
    basis: "poster_confirmed_impact",
    funding_state: "declarative_only",
    eligible_impact_tiers: ["signal", "useful", "material", "decisive"],
    completion_bonus: policies[intent].completionBonus,
  };
}

export function rewardPostureLabel(rewardCredits: number): string {
  const credits = Number.isFinite(rewardCredits) ? Math.max(0, Math.round(rewardCredits)) : 0;
  return `${credits} credits declared for poster-confirmed impact. No reservation or settlement is represented yet.`;
}

export function isChallengePubliclyEligible(challenge: ChallengePublicEligibilityRecord | undefined): boolean {
  return Boolean(
    challenge
    && challenge.visibility === "public"
    && challenge.status !== "suppressed"
    && challenge.brief.privacy_sensitivity === "public_ok"
    && challenge.brief.criteria_status === "confirmed"
    && challenge.publicEligibility?.eligible === true,
  );
}

export function isChallengeReadOnlyCompatibilityEligible(challenge: ChallengePublicEligibilityRecord | undefined): boolean {
  if (!challenge
    || challenge.visibility !== "public"
    || challenge.status === "suppressed"
    || challenge.brief.privacy_sensitivity !== "public_ok"
    || challenge.brief.criteria_status !== "criteria_unconfirmed"
    || challenge.publicEligibility?.eligible !== false) return false;
  const reasons = challenge.publicEligibility.reasons;
  return reasons.length > 0 && reasons.every((reason) => reason === "criteria_unconfirmed");
}

export function inferChallengeIntent(value: string): ChallengeIntent {
  const lowered = value.toLowerCase();
  if (/\b(audit|red.?team|security review|threat model|vulnerabilit)/.test(lowered)) return "audit";
  if (/\b(debate|argue|claim|for and against|disagreement)\b/.test(lowered)) return "debate";
  if (/\b(options?|alternatives?|ideas?|possibilities)\b/.test(lowered)) return "options";
  if (/\b(perspectives?|viewpoints?|angles?|stakeholders?)\b/.test(lowered)) return "perspectives";
  if (/\b(pressure.?test|review|risk|failure mode|plan|proposal|spec)\b/.test(lowered)) return "pressure_test";
  if (/\b(decide|decision|choose|choice|which should|should i)\b/.test(lowered)) return "decide";
  return "solve";
}

export function createChallengeSemantics(input: {
  intent: ChallengeIntent;
  successCriteria: string[];
  status?: ChallengeCriteriaStatus;
  changeReason: string;
}): ChallengeSemantics {
  const status = input.status ?? "criteria_unconfirmed";
  const successCriteria = input.successCriteria.map((criterion) => criterion.trim());
  const successfulOutcomes = [...policies[input.intent].successfulOutcomes];
  return {
    challenge_semantics_version: CHALLENGE_SEMANTICS_VERSION,
    challenge_intent: input.intent,
    criteria_status: status,
    criteria_version: 1,
    successful_outcomes: successfulOutcomes,
    criteria_history: [{
      version: 1,
      intent: input.intent,
      status,
      success_criteria: successCriteria,
      successful_outcomes: successfulOutcomes,
      change_reason: input.changeReason.trim(),
    }],
    reward_posture: declarativeRewardPosture(input.intent),
  };
}

export function legacyChallengeSemantics(successCriteria: string[]): ChallengeSemantics {
  const criteria = Array.isArray(successCriteria)
    ? successCriteria.filter((criterion): criterion is string => typeof criterion === "string").map((criterion) => criterion.trim()).filter(Boolean).slice(0, 8).map((criterion) => criterion.slice(0, 240))
    : [];
  return createChallengeSemantics({
    intent: "pressure_test",
    successCriteria: criteria,
    status: "criteria_unconfirmed",
    changeReason: LEGACY_MAPPING_REASON,
  });
}

export function resolveChallengeSemantics(brief: IntentAwareChallengeBrief):
  | { ok: true; value: ChallengeSemantics; legacy: boolean }
  | { ok: false; issues: ChallengeIntentIssue[]; legacy: false } {
  const presentKeys = semanticKeys.filter((key) => brief[key] !== undefined);
  if (presentKeys.length === 0) return { ok: true, value: legacyChallengeSemantics(brief.success_criteria), legacy: true };

  if (brief.challenge_semantics_version === undefined) {
    return {
      ok: false,
      legacy: false,
      issues: [{ path: "challenge_semantics_version", message: "challenge_semantics_version is required when any intent contract field is present." }],
    };
  }

  const parsed = z.object({
    challenge_semantics_version: challengeSemanticsVersionSchema,
    challenge_intent: challengeIntentSchema,
    criteria_status: challengeCriteriaStatusSchema,
    criteria_version: challengeCriteriaVersionSchema,
    successful_outcomes: challengeSuccessfulOutcomesSchema,
    criteria_history: challengeCriteriaHistorySchema,
    reward_posture: declarativeRewardPostureSchema,
  }).strict().safeParse(Object.fromEntries(semanticKeys.map((key) => [key, brief[key]])));

  if (!parsed.success) {
    return {
      ok: false,
      legacy: false,
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    };
  }

  if (isLegacyProjection(parsed.data)) {
    return { ok: true, value: parsed.data, legacy: true };
  }
  const issues = validateModernSemantics(brief, parsed.data);
  if (issues.length) return { ok: false, legacy: false, issues };
  return { ok: true, value: parsed.data, legacy: false };
}

export function normalizeChallengeIntentBrief<T extends IntentAwareChallengeBrief>(brief: T): T & ChallengeSemantics {
  const resolved = resolveChallengeSemantics(brief);
  if (!resolved.ok) throw new ChallengeIntentValidationError(resolved.issues);
  if (resolved.legacy) {
    return { ...brief, success_criteria: [...(resolved.value.criteria_history.at(-1)?.success_criteria || [])], ...resolved.value };
  }
  return { ...brief, ...resolved.value };
}

export function challengeIntentPublicationIssues(brief: IntentAwareChallengeBrief): ChallengeIntentIssue[] {
  const submittedAsLegacy = !hasAnySemanticsField(brief);
  const resolved = resolveChallengeSemantics(brief);
  if (!resolved.ok) return resolved.issues;

  const issues: ChallengeIntentIssue[] = [];
  if (resolved.legacy && submittedAsLegacy) {
    issues.push(...validateLegacyCriteriaForPublication(brief.success_criteria));
  } else if (resolved.value.criteria_status !== "confirmed") {
    issues.push({ path: "criteria_status", message: "The poster must confirm the challenge intent and criteria before publishing this version." });
  }
  return issues;
}

export function challengeIntentPublicEligibilityIssues(brief: IntentAwareChallengeBrief): ChallengeIntentIssue[] {
  const issues = challengeIntentPublicationIssues(brief);
  if (brief.privacy_sensitivity === "private_only") {
    issues.push({ path: "privacy_sensitivity", message: "Private-only material is not eligible for the public challenge feed." });
  }
  return issues;
}

export function confirmChallengeCriteria<T extends IntentAwareChallengeBrief>(brief: T, changeReason = "Poster confirmed the challenge intent and criteria before publication."): T & ChallengeSemantics {
  return reviseChallengeCriteria(brief, {
    intent: normalizeChallengeIntentBrief(brief).challenge_intent,
    successCriteria: brief.success_criteria,
    status: "confirmed",
    contributionCount: 0,
    changeReason,
  });
}

export function editChallengeCriteriaDraft<T extends IntentAwareChallengeBrief>(brief: T, input: { intent: ChallengeIntent; successCriteria: string[] }): T & ChallengeSemantics {
  const semantics = createChallengeSemantics({
    intent: input.intent,
    successCriteria: input.successCriteria,
    status: "criteria_unconfirmed",
    changeReason: "Draft intent or criteria changed before publication; poster confirmation is required.",
  });
  return { ...brief, success_criteria: input.successCriteria, ...semantics };
}

export function reviseChallengeCriteria<T extends IntentAwareChallengeBrief>(brief: T, input: {
  intent: ChallengeIntent;
  successCriteria: string[];
  status: ChallengeCriteriaStatus;
  contributionCount: number;
  changeReason: string;
}): T & ChallengeSemantics {
  const current = normalizeChallengeIntentBrief(brief);
  const criteriaIssues = validateCriteria(input.intent, input.successCriteria, "success_criteria");
  if (criteriaIssues.length) throw new ChallengeIntentValidationError(criteriaIssues);
  const reason = input.changeReason.trim();
  if (input.contributionCount > 0 && reason.length < 8) {
    throw new ChallengeIntentValidationError([{ path: "change_reason", message: "Criteria changes after contributions begin require a specific change reason of at least 8 characters." }]);
  }
  if (!reason || reason.length > 240) {
    throw new ChallengeIntentValidationError([{ path: "change_reason", message: "Criteria change reason must be between 1 and 240 characters." }]);
  }
  if (current.criteria_history.length >= 20) {
    throw new ChallengeIntentValidationError([{ path: "criteria_history", message: "Criteria history is limited to 20 versions; archive or migrate before another revision." }]);
  }

  const version = current.criteria_version + 1;
  const successfulOutcomes = [...policies[input.intent].successfulOutcomes];
  const historyEntry: ChallengeCriteriaHistoryEntry = {
    version,
    intent: input.intent,
    status: input.status,
    success_criteria: input.successCriteria.map((criterion) => criterion.trim()),
    successful_outcomes: successfulOutcomes,
    change_reason: reason,
  };
  return {
    ...brief,
    success_criteria: historyEntry.success_criteria,
    challenge_semantics_version: CHALLENGE_SEMANTICS_VERSION,
    challenge_intent: input.intent,
    criteria_status: input.status,
    criteria_version: version,
    successful_outcomes: successfulOutcomes,
    criteria_history: [...current.criteria_history, historyEntry],
    reward_posture: declarativeRewardPosture(input.intent),
  };
}

export type ChallengeCriterionEvidence = {
  criterion_number: number;
  status: "satisfied" | "not_satisfied";
  evidence: string;
};

export function evaluateSuccessfulOutcome(input: {
  brief: IntentAwareChallengeBrief;
  outcome: ChallengeSuccessfulOutcome;
  criteriaVersion: number;
  criterionEvidence: ChallengeCriterionEvidence[];
  missingInformationResolved: boolean;
  posterConfirmed: boolean;
}): { eligible: true } | { eligible: false; reasons: string[] } {
  if (input.brief.criteria_status === "criteria_unconfirmed") {
    return { eligible: false, reasons: ["criteria_unconfirmed"] };
  }
  const resolved = resolveChallengeSemantics(input.brief);
  if (!resolved.ok) return { eligible: false, reasons: resolved.issues.map((issue) => issue.message) };

  const reasons: string[] = [];
  const semantics = resolved.value;
  if (resolved.legacy || semantics.criteria_status !== "confirmed") reasons.push("criteria_unconfirmed");
  if (!semantics.successful_outcomes.includes(input.outcome)) reasons.push("invalid_intent_outcome_pair");
  if (input.criteriaVersion !== semantics.criteria_version) reasons.push("stale_criteria_version");
  if (!input.posterConfirmed) reasons.push("poster_confirmation_required");
  if (!input.missingInformationResolved && input.brief.missing_information.length > 0) reasons.push("missing_information_unresolved");

  input.brief.success_criteria.forEach((_, index) => {
    const criterionNumber = index + 1;
    const evidence = input.criterionEvidence.find((item) => item.criterion_number === criterionNumber);
    if (!evidence || evidence.status !== "satisfied" || evidence.evidence.trim().length < 3) reasons.push(`criterion_${criterionNumber}_not_satisfied`);
  });

  return reasons.length ? { eligible: false, reasons: [...new Set(reasons)] } : { eligible: true };
}

export function criteriaStatusLabel(status: ChallengeCriteriaStatus): string {
  return status === "confirmed" ? "Criteria confirmed" : "Criteria need confirmation";
}

function validateModernSemantics(brief: IntentAwareChallengeBrief, semantics: ChallengeSemantics): ChallengeIntentIssue[] {
  const issues = validateCriteria(semantics.challenge_intent, brief.success_criteria, "success_criteria");
  const expectedOutcomes = policies[semantics.challenge_intent].successfulOutcomes;
  if (!sameArray(semantics.successful_outcomes, expectedOutcomes)) {
    issues.push({ path: "successful_outcomes", message: `${semantics.challenge_intent} challenges allow only: ${expectedOutcomes.join(", ")}.` });
  }
  if (!sameRewardPosture(semantics.reward_posture, declarativeRewardPosture(semantics.challenge_intent))) {
    issues.push({ path: "reward_posture", message: "Reward posture must remain declarative and based on poster-confirmed impact; settlement fields are not allowed here." });
  }
  if (semantics.criteria_history.length !== semantics.criteria_version) {
    issues.push({ path: "criteria_history", message: "Criteria history must contain one contiguous entry for every criteria version." });
  }

  semantics.criteria_history.forEach((entry, index) => {
    const expectedVersion = index + 1;
    if (entry.version !== expectedVersion) issues.push({ path: `criteria_history.${index}.version`, message: `Expected criteria history version ${expectedVersion}.` });
    const historyOutcomes = policies[entry.intent].successfulOutcomes;
    if (!sameArray(entry.successful_outcomes, historyOutcomes)) {
      issues.push({ path: `criteria_history.${index}.successful_outcomes`, message: `${entry.intent} criteria history has an invalid successful outcome.` });
    }
    if (index < semantics.criteria_history.length - 1) {
      issues.push(...validateCriteria(entry.intent, entry.success_criteria, `criteria_history.${index}.success_criteria`));
    }
  });

  const latest = semantics.criteria_history.at(-1);
  if (!latest
    || latest.version !== semantics.criteria_version
    || latest.intent !== semantics.challenge_intent
    || latest.status !== semantics.criteria_status
    || !sameArray(latest.success_criteria, brief.success_criteria)
    || !sameArray(latest.successful_outcomes, semantics.successful_outcomes)) {
    issues.push({ path: "criteria_history", message: "The latest criteria history entry must exactly match the current intent, status, criteria, and successful outcomes." });
  }
  return issues;
}

function hasAnySemanticsField(brief: IntentAwareChallengeBrief): boolean {
  return semanticKeys.some((key) => brief[key] !== undefined);
}

function isLegacyProjection(semantics: ChallengeSemantics): boolean {
  return semantics.challenge_intent === "pressure_test"
    && semantics.criteria_status === "criteria_unconfirmed"
    && semantics.criteria_version === 1
    && semantics.criteria_history.length === 1
    && semantics.criteria_history[0]?.change_reason === LEGACY_MAPPING_REASON;
}

function validateLegacyCriteriaForPublication(criteria: string[]): ChallengeIntentIssue[] {
  if (!Array.isArray(criteria) || criteria.length === 0) {
    return [{ path: "success_criteria", message: "Legacy briefs need at least one attainable criterion before publication; they remain criteria_unconfirmed until the poster confirms them." }];
  }
  return validateBoundedCriterionStrings(criteria, "success_criteria", 1);
}

function validateCriteria(intent: ChallengeIntent, criteria: string[], path: string): ChallengeIntentIssue[] {
  return validateBoundedCriterionStrings(criteria, path, policies[intent].requiredCriteria.length);
}

function validateBoundedCriterionStrings(criteria: string[], path: string, minimum: number): ChallengeIntentIssue[] {
  const issues: ChallengeIntentIssue[] = [];
  if (!Array.isArray(criteria) || criteria.length < minimum) {
    issues.push({ path, message: `At least ${minimum} intent-specific ${minimum === 1 ? "criterion is" : "criteria are"} required.` });
    return issues;
  }
  if (criteria.length > 8) issues.push({ path, message: "No more than 8 success or closure criteria are allowed." });
  const normalized = new Set<string>();
  let totalLength = 0;
  criteria.forEach((criterion, index) => {
    const value = typeof criterion === "string" ? criterion.trim() : "";
    const inspectionValue = value.normalize("NFKC").replace(invisibleCriterionFormattingPattern, "");
    totalLength += value.length;
    if (!value) issues.push({ path: `${path}.${index}`, message: "Criteria cannot be empty." });
    if (value.length > 240) issues.push({ path: `${path}.${index}`, message: "Each criterion is limited to 240 characters." });
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)) issues.push({ path: `${path}.${index}`, message: "Criteria cannot contain control characters." });
    if (invisibleCriterionFormattingPattern.test(value)) issues.push({ path: `${path}.${index}`, message: "Criteria cannot contain invisible or bidirectional formatting characters." });
    invisibleCriterionFormattingPattern.lastIndex = 0;
    if (impossibleCriterionPatterns.some((pattern) => pattern.test(inspectionValue))) issues.push({ path: `${path}.${index}`, message: "Criterion appears impossible or absolute, or coercively pre-judges the outcome; replace it with an observable, attainable threshold." });
    const key = inspectionValue.toLowerCase();
    if (normalized.has(key)) issues.push({ path: `${path}.${index}`, message: "Duplicate criteria do not add a distinct closure threshold." });
    normalized.add(key);
  });
  if (totalLength > 1200) issues.push({ path, message: "Combined criteria text is limited to 1,200 characters." });
  return issues;
}

function sameArray<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameRewardPosture(left: DeclarativeRewardPosture, right: DeclarativeRewardPosture): boolean {
  return left.basis === right.basis
    && left.funding_state === right.funding_state
    && left.completion_bonus === right.completion_bonus
    && sameArray(left.eligible_impact_tiers, right.eligible_impact_tiers);
}
