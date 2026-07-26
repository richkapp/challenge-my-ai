import type { ChallengeBrief } from "@/lib/types";
import { defaultRequestedContributionModes } from "@/lib/contributionModes";
import type { ContributionMode } from "@/lib/types";
import { challengeBriefSchema } from "@/lib/validation/schemas";
import { extractFencedBlock, jsonObjectCandidates, type ParseResult } from "@/lib/validation/fencedJson";
import {
  ChallengeIntentValidationError,
  createChallengeSemantics,
  defaultSuccessCriteria,
  inferChallengeIntent,
  normalizeChallengeIntentBrief,
} from "@/lib/challenges/intent";

export const CHALLENGE_BRIEF_LABEL = "CMAI_CHALLENGE_BRIEF_V1";

export function parseChallengeBrief(input: string): ParseResult<ChallengeBrief> {
  const block = extractFencedBlock(input, CHALLENGE_BRIEF_LABEL);
  if (block.ok) return validateChallengeBrief(block.value, block.raw);

  let validationFailure: ParseResult<ChallengeBrief> | null = null;
  for (const raw of jsonObjectCandidates(input, CHALLENGE_BRIEF_LABEL)) {
    try {
      const parsedJson = JSON.parse(raw);
      const parsedBrief = validateChallengeBrief(parsedJson, raw);
      if (parsedBrief.ok) return parsedBrief;
      validationFailure ??= parsedBrief;
    } catch {
      // Keep trying candidates. If none are valid JSON, preserve the original
      // missing-fence error so ordinary raw text continues through the raw
      // structuring fallback.
    }
  }

  return validationFailure || block;
}

function validateChallengeBrief(value: unknown, raw: string): ParseResult<ChallengeBrief> {
  const parsed = challengeBriefSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
    return { ok: false, error: "Challenge brief failed validation.", issues, raw };
  }
  try {
    return { ok: true, value: normalizeChallengeIntentBrief(parsed.data), raw };
  } catch (error) {
    if (error instanceof ChallengeIntentValidationError) {
      return { ok: false, error: "Challenge intent and criteria failed validation.", issues: error.issues, raw };
    }
    throw error;
  }
}

type RawSections = {
  problem?: string;
  answer?: string;
  context?: string;
  constraints: string[];
  success: string[];
  assumptions: string[];
  claims: string[];
  risks: string[];
  useful: string[];
  privacy?: string;
};

const SECTION_ALIASES: Array<[keyof RawSections, RegExp]> = [
  ["problem", /^(problem|question|decision|obstacle|hard problem|what i need|goal)\s*:/i],
  ["answer", /^(my agent(?:'s)? current answer|agent(?:'s)? current answer|ai answer|original ai answer|current ai answer|current answer|recommendation|agent recommendation)\s*:/i],
  ["context", /^(context|background|prompt|source context)\s*:/i],
  ["constraints", /^(constraints|hard constraints|must keep|requirements)\s*:/i],
  ["success", /^(success criteria|desired outcome|what better means|win condition)\s*:/i],
  ["assumptions", /^(assumptions|assumptions to test|what to test)\s*:/i],
  ["claims", /^(claims|claims to check|facts to check|verify)\s*:/i],
  ["risks", /^(risks|known risks|failure modes|concerns)\s*:/i],
  ["useful", /^(what i want challenged|what useful challengers should address|useful response should address|critique focus|challenge focus)\s*:/i],
  ["privacy", /^(privacy note|privacy|redactions|redaction note)\s*:/i],
];

const ARRAY_SECTION_KEYS = new Set<keyof RawSections>(["constraints", "success", "assumptions", "claims", "risks", "useful"]);

export function structureRawChallenge(raw: string): ChallengeBrief {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  const sections = parseRawSections(normalized);
  const problem = sections.problem || inferProblem(normalized);
  const answer = sections.answer || inferAnswer(normalized);
  const context = sections.context || inferContext(normalized, problem, answer);
  const privacyText = sections.privacy || normalized;
  const intent = inferChallengeIntent(normalized);
  const successCriteria = sections.success.length ? sections.success : defaultSuccessCriteria(intent);
  return {
    schema_version: "1.0",
    ...createChallengeSemantics({
      intent,
      successCriteria,
      status: "criteria_unconfirmed",
      changeReason: "Raw material was structured into a draft; the poster must confirm intent and criteria before publication.",
    }),
    title: shortThreadTitle(problem || normalized || "Untitled challenge"),
    category: inferCategory(normalized),
    challenge_mode_requested: inferRequestedModes(normalized),
    problem_statement: truncateField(problem || normalized, 1800),
    original_ai_answer: truncateField(answer || "Paste or summarize the Agent answer you want challenged before publishing.", 1800),
    context: truncateField(context || "Structured locally from raw paste. Review before posting.", 1800),
    constraints: sections.constraints,
    success_criteria: successCriteria,
    assumptions_to_test: sections.assumptions,
    claims_to_check: sections.claims,
    known_risks: sections.risks,
    what_a_useful_response_should_address: sections.useful.length ? sections.useful : ["Challenge weak assumptions", "Name missing context", "Offer a better path"],
    privacy_sensitivity: inferPrivacySensitivity(privacyText),
    redactions_made: inferRedactions(privacyText),
    abuse_or_safety_flags: [],
    missing_information: inferMissingInformation(sections),
    raw_material_summary: truncateField(summaryFrom(problem, answer, normalized), 240),
  };
}

function parseRawSections(raw: string): RawSections {
  const sections: RawSections = { constraints: [], success: [], assumptions: [], claims: [], risks: [], useful: [] };
  let current: keyof RawSections | null = null;
  for (const originalLine of raw.split("\n")) {
    const line = originalLine.trim();
    if (!line) continue;
    const match = SECTION_ALIASES.find(([, pattern]) => pattern.test(line));
    if (match) {
      current = match[0];
      const value = line.replace(match[1], "").trim();
      if (value) addSectionValue(sections, current, value);
      continue;
    }
    if (current) addSectionValue(sections, current, line);
  }
  return sections;
}

function addSectionValue(sections: RawSections, key: keyof RawSections, value: string) {
  const cleaned = value.replace(/^[-*•]\s*/, "").trim();
  if (!cleaned) return;
  if (ARRAY_SECTION_KEYS.has(key)) {
    (sections[key] as string[]).push(cleaned);
    return;
  }
  const next = [stringSectionValue(sections, key), cleaned].filter(Boolean).join("\n");
  switch (key) {
    case "problem":
      sections.problem = next;
      break;
    case "answer":
      sections.answer = next;
      break;
    case "context":
      sections.context = next;
      break;
    case "privacy":
      sections.privacy = next;
      break;
  }
}

function stringSectionValue(sections: RawSections, key: keyof RawSections) {
  if (key === "problem") return sections.problem;
  if (key === "answer") return sections.answer;
  if (key === "context") return sections.context;
  if (key === "privacy") return sections.privacy;
  return undefined;
}

function inferProblem(raw: string) {
  const split = raw.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  const first = split[0] || raw;
  return stripLikelyLabel(first).slice(0, 1800);
}

function inferAnswer(raw: string) {
  const answerMatch = raw.match(/(?:my agent(?:'s)? current answer|agent(?:'s)? current answer|ai answer|original ai answer|current ai answer|recommendation|agent recommendation)\s*:\s*([\s\S]+)/i);
  if (answerMatch?.[1]) return stripLikelyLabel(answerMatch[1]).slice(0, 1800);
  const quoteMatch = raw.match(/(?:the agent said|it said|the ai said)\s*[:\-]\s*([\s\S]+)/i);
  if (quoteMatch?.[1]) return stripLikelyLabel(quoteMatch[1]).slice(0, 1800);
  return "";
}

function inferContext(raw: string, problem: string, answer: string) {
  const remaining = raw.replace(problem, "").replace(answer, "").trim();
  return remaining && remaining.length < raw.length ? truncateField(remaining, 1800) : "";
}

function stripLikelyLabel(value: string) {
  return value.replace(/^(problem|question|decision|obstacle|goal|context|background|prompt)\s*:\s*/i, "").trim();
}

function shortThreadTitle(value: string) {
  const cleaned = value.replace(/[`*_#[\]()>-]+/g, " ").replace(/\s+/g, " ").trim();
  const words = cleaned.split(" ").filter(Boolean).slice(0, 6);
  return words.join(" ").replace(/[.?!,:;]+$/, "") || "Untitled challenge";
}

function inferCategory(raw: string) {
  const lowered = raw.toLowerCase();
  if (/landing page|headline|copy|offer|cta|positioning|messaging/.test(lowered)) return "copy";
  if (/implementation|code|bug|architecture|migration|api|typescript|react|next\.js|database|test/.test(lowered)) return "code";
  if (/startup|market|icp|business model|willingness|pricing|acquisition/.test(lowered)) return "startup";
  if (/business decision|operator|ops|operations|contract|vendor|hire|process/.test(lowered)) return "business_decision";
  if (/strategy|roadmap|positioning|launch wedge|go-to-market|gtm/.test(lowered)) return "strategy";
  if (/feature|spec|product|user|workflow|ux/.test(lowered)) return "product";
  return "other";
}

function inferRequestedModes(raw: string): ContributionMode[] {
  const lowered = raw.toLowerCase();
  if (/red.?team|security|abuse|exploit|unsafe|secret/.test(lowered)) return ["red_team", "risk_audit", "critique"];
  if (/startup|business model|market|pricing|acquisition|strategy/.test(lowered)) return ["critique", "risk_audit", "alternate_proposal"];
  if (/landing page|copy|headline|offer|positioning/.test(lowered)) return ["critique", "alternate_proposal", "steelman"];
  if (/implementation|code|architecture|migration|api/.test(lowered)) return ["critique", "risk_audit", "alternate_proposal"];
  return [...defaultRequestedContributionModes];
}

function inferPrivacySensitivity(raw: string): ChallengeBrief["privacy_sensitivity"] {
  const lowered = raw.toLowerCase();
  if (/private[_\s-]?only|do not publish|cannot share|nda|confidential|client secret|personal data|private repo|internal only/.test(lowered)) return "private_only";
  if (/no private|no customer|no client|public url|open source|already public|public topic|public copy/.test(lowered)) return "public_ok";
  if (/customer|client|internal|proprietary|financial|contract|source code|roadmap|pricing|employee|strategy/.test(lowered)) return "anonymize_first";
  return "unknown";
}

function inferRedactions(raw: string) {
  const lowered = raw.toLowerCase();
  if (/customer|client|internal|proprietary|financial|contract|source code|roadmap|pricing|employee/.test(lowered)) return ["Review and remove private names, metrics, code, strategy, customer/client identifiers, and internal specifics before publishing."];
  if (/redact|redacted|remove|generalize|anonymize/.test(lowered)) return ["Raw paste requested review of redactions; confirm protected details are removed before publishing."];
  return [];
}

function inferMissingInformation(sections: RawSections) {
  const missing: string[] = [];
  if (!sections.answer) missing.push("Agent answer needs manual cleanup before publishing.");
  if (!sections.context) missing.push("Context may need a short public-safe explanation.");
  return missing;
}

function summaryFrom(problem: string, answer: string, raw: string) {
  if (problem && answer) return `${shortThreadTitle(problem)} — Agent answer included for critique.`;
  return raw.slice(0, 240);
}

function truncateField(value: string, max: number) {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}
