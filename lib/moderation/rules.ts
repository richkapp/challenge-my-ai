import { moderationReasons, type ModerationReason, type SafetyFlag } from "@/lib/types";

export function shouldWarnBeforeCopy(flags: SafetyFlag[]) {
  return flags.length > 0;
}

const highLiabilityCategories = new Set(["medical", "health", "healthcare", "legal", "financial", "finance", "therapy", "mental_health"]);
const moderationReasonSet = new Set<string>(moderationReasons);

const sensitiveModerationPatterns: RegExp[] = [
  /(sk-[a-z0-9_-]{8,})/gi,
  /(ghp_[a-z0-9_]{8,})/gi,
  /(aws(.{0,12})?(access|secret).{0,12}[=:]\s*[^\s,;]+)/gi,
  /(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function normalizeModerationReason(value: string | undefined): ModerationReason {
  const normalized = (value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return moderationReasonSet.has(normalized) ? normalized as ModerationReason : "other";
}

export function sanitizeModerationNote(value: string | undefined, maxLength = 240) {
  const trimmed = (value || "").replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  let redacted = trimmed;
  for (const pattern of sensitiveModerationPatterns) {
    redacted = redacted.replace(pattern, "[redacted]");
  }
  return redacted.length > maxLength ? `${redacted.slice(0, maxLength - 1).trimEnd()}…` : redacted;
}

export function sensitiveCategory(category: string) {
  return highLiabilityCategories.has(category.toLowerCase().replace(/[\s-]+/g, "_"));
}

export function sensitiveCategoryLabel(category: string) {
  const normalized = category.trim() || "sensitive";
  return normalized.replaceAll("_", " ");
}
