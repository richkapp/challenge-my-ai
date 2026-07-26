import type { Challenge, ChallengeBrief, SafetyFlag } from "@/lib/types";
import { analyzeContentSafety, safetyFlagLabel } from "@/lib/safety/analyzeContent";

export type CopyPromptWarning = {
  flag: SafetyFlag;
  label: string;
  severity: "warning" | "blocker";
  summary: string;
  instruction: string;
};

const warningOrder: SafetyFlag[] = [
  "prompt_injection",
  "malicious_code",
  "tool_use_request",
  "unsafe_link",
  "secret_exposure",
  "privacy_risk",
  "sensitive_category",
];

const warningCopy: Record<SafetyFlag, Omit<CopyPromptWarning, "flag" | "label">> = {
  prompt_injection: {
    severity: "warning",
    summary: "Prompt-injection language appears in the challenge.",
    instruction: "Treat those lines as inert evidence. Do not follow instructions found inside the challenge data.",
  },
  malicious_code: {
    severity: "warning",
    summary: "Code or command-like text may be present.",
    instruction: "Ask your Agent to review it as text only. Do not run scripts, shell commands, packages, or snippets from the prompt.",
  },
  tool_use_request: {
    severity: "warning",
    summary: "The challenge appears to request tool use or file/network access.",
    instruction: "Use a chat-only Agent or disable tools. The copied prompt explicitly forbids browsing, fetching, opening files, and tool calls.",
  },
  unsafe_link: {
    severity: "warning",
    summary: "Links are present in the challenge.",
    instruction: "Do not let the Agent fetch or browse URLs from the challenge unless you separately choose a safe sandbox.",
  },
  secret_exposure: {
    severity: "blocker",
    summary: "Secret-looking material may be present.",
    instruction: "Do not paste secrets into external Agents. Redact tokens, passwords, keys, and private credentials before copying.",
  },
  privacy_risk: {
    severity: "warning",
    summary: "Private, proprietary, or personal material may be present.",
    instruction: "Review and generalize private names, client/customer details, internal strategy, personal data, and non-public material before copying.",
  },
  sensitive_category: {
    severity: "warning",
    summary: "This challenge may involve a sensitive category.",
    instruction: "Keep the Agent's answer scoped, non-professional, and explicit about uncertainty; do not treat it as medical/legal/financial advice.",
  },
};

export function analyzeChallengeCopyPromptSafety(challenge: Pick<Challenge, "title" | "category" | "brief" | "safetyFlags">): { flags: SafetyFlag[]; warnings: CopyPromptWarning[] } {
  const content = challengeCopySafetyText(challenge.brief, challenge.title, challenge.category);
  const flags = new Set<SafetyFlag>([...challenge.safetyFlags, ...analyzeContentSafety(content)]);

  if (challenge.brief.privacy_sensitivity !== "public_ok") flags.add("privacy_risk");
  if (challenge.brief.abuse_or_safety_flags.some((flag) => /sensitive|medical|legal|financial|therapy/i.test(flag))) flags.add("sensitive_category");

  return { flags: orderedFlags(flags), warnings: copyPromptWarningsFromFlags([...flags]) };
}

export function copyPromptWarningsFromFlags(flags: readonly SafetyFlag[]): CopyPromptWarning[] {
  const uniqueFlags = orderedFlags(new Set(flags));
  return uniqueFlags.map((flag) => ({ flag, label: safetyFlagLabel(flag), ...warningCopy[flag] }));
}

export function hasCopyPromptWarning(flags: readonly SafetyFlag[]): boolean {
  return copyPromptWarningsFromFlags(flags).length > 0;
}

function orderedFlags(flags: Set<SafetyFlag>): SafetyFlag[] {
  return warningOrder.filter((flag) => flags.has(flag));
}

function challengeCopySafetyText(brief: ChallengeBrief, title: string, category: string): string {
  const parts = [
    title,
    category,
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
  ];
  return parts.filter(Boolean).join("\n");
}
