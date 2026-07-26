import type { ChallengeBrief, SafetyFlag } from "@/lib/types";
import { analyzeContentSafety } from "@/lib/safety/analyzeContent";
import { sensitiveCategory, sensitiveCategoryLabel } from "@/lib/moderation/rules";

export type PublicationPolicyRiskLevel = "clear" | "needs_review" | "blocked";

export type PublicationPolicyResult = {
  ok: boolean;
  blockers: string[];
  warnings: string[];
  safetyFlags: SafetyFlag[];
  riskLevel: PublicationPolicyRiskLevel;
  canOverride: boolean;
  relatedArtifactSearchAllowed: boolean;
};

export type ChallengeIntakeIssue = { path: string; message: string };

const publicChallengeCategories = new Set([
  "product",
  "code",
  "startup",
  "copy",
  "business_decision",
  "strategy",
  "personal_decision",
  "other",
]);

const forbiddenFormattingControls = /[\u200B-\u200F\u2028-\u202E\u2066-\u2069\uFEFF]/u;

export function normalizeChallengeIntakeBrief(brief: ChallengeBrief): ChallengeBrief {
  const normalizeText = (value: string) => value.normalize("NFC").trim();
  const normalizeList = (values: string[]) => values.map((value) => normalizeText(value).replace(/\s+/gu, " "));
  return {
    ...brief,
    title: normalizeText(brief.title),
    category: normalizeText(brief.category),
    problem_statement: normalizeText(brief.problem_statement),
    original_ai_answer: normalizeText(brief.original_ai_answer),
    context: normalizeText(brief.context),
    constraints: normalizeList(brief.constraints),
    success_criteria: normalizeList(brief.success_criteria),
    assumptions_to_test: normalizeList(brief.assumptions_to_test),
    claims_to_check: normalizeList(brief.claims_to_check),
    known_risks: normalizeList(brief.known_risks),
    what_a_useful_response_should_address: normalizeList(brief.what_a_useful_response_should_address),
    redactions_made: normalizeList(brief.redactions_made),
    abuse_or_safety_flags: normalizeList(brief.abuse_or_safety_flags),
    missing_information: normalizeList(brief.missing_information),
    raw_material_summary: normalizeText(brief.raw_material_summary),
    criteria_history: brief.criteria_history?.map((entry) => ({
      ...entry,
      success_criteria: normalizeList(entry.success_criteria),
      change_reason: normalizeText(entry.change_reason).replace(/\s+/gu, " "),
    })),
  };
}

export function challengeIntakeValidationIssues(brief: ChallengeBrief): ChallengeIntakeIssue[] {
  const issues: ChallengeIntakeIssue[] = [];
  validateRequiredText(issues, "brief.title", brief.title, 120);
  validateRequiredText(issues, "brief.problem_statement", brief.problem_statement, 4_000);
  validateRequiredText(issues, "brief.original_ai_answer", brief.original_ai_answer, 4_000);
  validateOptionalText(issues, "brief.context", brief.context, 4_000);
  validateOptionalText(issues, "brief.raw_material_summary", brief.raw_material_summary, 240);

  if (!publicChallengeCategories.has(brief.category)) {
    issues.push({ path: "brief.category", message: "Choose a supported public challenge category." });
  }
  if (brief.challenge_mode_requested.length < 1 || brief.challenge_mode_requested.length > 3) {
    issues.push({ path: "brief.challenge_mode_requested", message: "Choose between 1 and 3 requested perspectives." });
  }
  if (new Set(brief.challenge_mode_requested).size !== brief.challenge_mode_requested.length) {
    issues.push({ path: "brief.challenge_mode_requested", message: "Requested perspectives must be distinct." });
  }
  if (brief.challenge_mode_requested.includes("judge")) {
    issues.push({ path: "brief.challenge_mode_requested", message: "Judge is reserved for advanced compatibility and cannot be requested through public intake." });
  }

  const standardArrays: Array<[string, string[]]> = [
    ["brief.constraints", brief.constraints],
    ["brief.assumptions_to_test", brief.assumptions_to_test],
    ["brief.claims_to_check", brief.claims_to_check],
    ["brief.known_risks", brief.known_risks],
    ["brief.what_a_useful_response_should_address", brief.what_a_useful_response_should_address],
    ["brief.redactions_made", brief.redactions_made],
    ["brief.missing_information", brief.missing_information],
  ];
  for (const [path, values] of standardArrays) validateTextArray(issues, path, values, { maxItems: 12, maxItemCodePoints: 240, maxCombinedCodePoints: 1_600 });
  validateTextArray(issues, "brief.abuse_or_safety_flags", brief.abuse_or_safety_flags, { maxItems: 12, maxItemCodePoints: 120, maxCombinedCodePoints: 1_440 });
  validateTextArray(issues, "brief.success_criteria", brief.success_criteria, { maxItems: 8, maxItemCodePoints: 240, maxCombinedCodePoints: 1_200 });

  brief.criteria_history?.forEach((entry, index) => {
    validateTextArray(issues, `brief.criteria_history.${index}.success_criteria`, entry.success_criteria, { maxItems: 8, maxItemCodePoints: 240, maxCombinedCodePoints: 1_200 });
    validateRequiredText(issues, `brief.criteria_history.${index}.change_reason`, entry.change_reason, 240);
  });
  return dedupeIssues(issues);
}

export function evaluateChallengePublicationPolicy(input: { brief: ChallengeBrief; visibility: "public" | "private"; confirmPrivacyOverride?: boolean }): PublicationPolicyResult {
  const blockers: string[] = [];
  const warnings: string[] = [];
  const content = challengeBriefPublicationText(input.brief);
  const safetyFlags = new Set<SafetyFlag>(analyzeContentSafety(content));
  const hasRedactions = hasConcreteRedactionEvidence(input.brief);

  if (sensitiveCategory(input.brief.category) || declaredSensitiveCategory(input.brief)) safetyFlags.add("sensitive_category");
  if (input.brief.privacy_sensitivity !== "public_ok") safetyFlags.add("privacy_risk");

  if (input.visibility === "public") {
    if (input.brief.privacy_sensitivity === "private_only") blockers.push("private_only briefs cannot be posted publicly.");
    if (safetyFlags.has("secret_exposure")) blockers.push("public briefs cannot contain obvious secrets, credentials, private keys, or tokens.");
    if (safetyFlags.has("sensitive_category")) {
      const categoryLabel = sensitiveCategory(input.brief.category) ? sensitiveCategoryLabel(input.brief.category) : "declared sensitive content";
      blockers.push(`sensitive professional-advice categories (${categoryLabel}) are not public-launch categories yet.`);
    }

    if (input.brief.privacy_sensitivity === "anonymize_first" && !hasRedactions) {
      blockers.push("anonymize_first briefs need concrete redactions_made before public posting.");
    }

    if (["anonymize_first", "unknown"].includes(input.brief.privacy_sensitivity) && !input.confirmPrivacyOverride) {
      warnings.push("privacy sensitivity requires explicit public-post override.");
      blockers.push("confirmPrivacyOverride is required before posting this brief publicly.");
    }

    if (safetyFlags.has("privacy_risk")) {
      if (!hasRedactions && input.brief.privacy_sensitivity === "public_ok") {
        blockers.push("privacy or proprietary indicators need concrete redactions_made before public posting.");
      } else if (!input.confirmPrivacyOverride) {
        warnings.push("privacy or proprietary indicators require explicit public-post override.");
        blockers.push("confirmPrivacyOverride is required before posting this brief publicly.");
      }
    }

    const overrideableSafetyFlags = ["prompt_injection", "malicious_code", "tool_use_request", "unsafe_link"].filter((flag): flag is SafetyFlag => safetyFlags.has(flag as SafetyFlag));
    if (overrideableSafetyFlags.length && !input.confirmPrivacyOverride) {
      warnings.push("challenge text contains hostile-data or tool/link risk; explicit public-post override is required.");
      blockers.push("confirmPrivacyOverride is required before posting this brief publicly.");
    }
  }

  if (safetyFlags.has("prompt_injection")) warnings.push("prompt-injection language detected; challenge content will be treated as untrusted data.");
  if (safetyFlags.has("malicious_code")) warnings.push("code or command-like text detected; it must stay inert and must not be executed.");
  if (safetyFlags.has("tool_use_request")) warnings.push("tool-use or file/network-access language detected; copied prompts must remain no-tool/no-fetch.");
  if (safetyFlags.has("unsafe_link")) warnings.push("URLs detected; links should be shown inertly and not fetched automatically.");
  if (safetyFlags.has("privacy_risk")) warnings.push("privacy or proprietary language detected; redactions and privacy sensitivity need review.");
  if (safetyFlags.has("sensitive_category")) warnings.push("sensitive professional-advice category detected; keep this constrained until launch policy/private routing is stronger.");

  const uniqueBlockers = [...new Set(blockers)];
  const uniqueWarnings = [...new Set(warnings)];
  const uniqueSafetyFlags = [...safetyFlags];
  const ok = uniqueBlockers.length === 0;
  const riskLevel: PublicationPolicyRiskLevel = ok ? (uniqueWarnings.length || uniqueSafetyFlags.length ? "needs_review" : "clear") : "blocked";
  const relatedArtifactSearchAllowed = ok && riskLevel === "clear" && input.visibility === "public" && input.brief.privacy_sensitivity === "public_ok";

  return {
    ok,
    blockers: uniqueBlockers,
    warnings: uniqueWarnings,
    safetyFlags: uniqueSafetyFlags,
    riskLevel,
    canOverride: uniqueBlockers.every(isOverrideBlocker),
    relatedArtifactSearchAllowed,
  };
}

export function challengeBriefPublicationText(brief: ChallengeBrief): string {
  return [
    brief.title,
    brief.category,
    ...brief.challenge_mode_requested,
    brief.problem_statement,
    brief.original_ai_answer,
    brief.context,
    ...brief.constraints,
    ...brief.success_criteria,
    ...brief.assumptions_to_test,
    ...brief.claims_to_check,
    ...brief.known_risks,
    ...brief.what_a_useful_response_should_address,
    brief.privacy_sensitivity,
    ...brief.redactions_made,
    ...brief.abuse_or_safety_flags,
    ...brief.missing_information,
    brief.raw_material_summary,
    ...(brief.criteria_history || []).flatMap((entry) => [...entry.success_criteria, entry.change_reason]),
  ].filter(Boolean).join("\n");
}

function validateRequiredText(issues: ChallengeIntakeIssue[], path: string, value: string, maxCodePoints: number) {
  if (!value.trim()) issues.push({ path, message: "This field cannot be empty." });
  validateOptionalText(issues, path, value, maxCodePoints);
}

function validateOptionalText(issues: ChallengeIntakeIssue[], path: string, value: string, maxCodePoints: number) {
  if (codePointLength(value) > maxCodePoints) issues.push({ path, message: `This field is limited to ${maxCodePoints.toLocaleString("en-US")} characters.` });
  if (forbiddenFormattingControls.test(value)) issues.push({ path, message: "This field cannot contain bidi, zero-width, BOM, or line-separator formatting controls." });
}

function validateTextArray(
  issues: ChallengeIntakeIssue[],
  path: string,
  values: string[],
  limits: { maxItems: number; maxItemCodePoints: number; maxCombinedCodePoints: number },
) {
  if (values.length > limits.maxItems) issues.push({ path, message: `No more than ${limits.maxItems} items are allowed.` });
  let combinedCodePoints = 0;
  values.forEach((value, index) => {
    const length = codePointLength(value);
    combinedCodePoints += length;
    if (!value.trim()) issues.push({ path: `${path}.${index}`, message: "Items cannot be empty." });
    if (length > limits.maxItemCodePoints) issues.push({ path: `${path}.${index}`, message: `Each item is limited to ${limits.maxItemCodePoints} characters.` });
    if (forbiddenFormattingControls.test(value)) issues.push({ path: `${path}.${index}`, message: "Items cannot contain bidi, zero-width, BOM, or line-separator formatting controls." });
  });
  if (combinedCodePoints > limits.maxCombinedCodePoints) {
    issues.push({ path, message: `Combined text is limited to ${limits.maxCombinedCodePoints.toLocaleString("en-US")} characters.` });
  }
}

function codePointLength(value: string) {
  return [...value].length;
}

function dedupeIssues(issues: ChallengeIntakeIssue[]) {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.path}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function hasConcreteRedactionEvidence(brief: ChallengeBrief) {
  return brief.redactions_made.some((item) => {
    const normalized = item.trim().toLowerCase();
    if (normalized.length < 8) return false;
    return !/^(none|n\/a|na|unknown|not sure|no redactions?|nothing)$/i.test(normalized);
  });
}

function declaredSensitiveCategory(brief: ChallengeBrief) {
  return brief.abuse_or_safety_flags.some((flag) => /sensitive|medical|legal|financial|therapy|mental health|professional advice/i.test(flag));
}

function isOverrideBlocker(value: string) {
  const lowered = value.toLowerCase();
  return lowered.includes("confirmprivacyoverride") || lowered.includes("explicit public-post override");
}
