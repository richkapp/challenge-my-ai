import type { SafetyFlag } from "@/lib/types";

const patternGroups: Array<[SafetyFlag, RegExp[]]> = [
  ["prompt_injection", [
    /ignore (all )?(previous|prior|above) instructions/i,
    /reveal (your )?(system|developer|hidden) prompt/i,
    /change the required json schema/i,
    /jailbreak|do anything now|developer mode/i,
  ]],
  ["malicious_code", [
    /rm -rf|curl\s+[^|\n]+\|\s*(sh|bash)|wget\s+[^|\n]+\|\s*(sh|bash)/i,
    /powershell|base64\s+-d|eval\(|document\.cookie|process\.env|exfiltrate/i,
    /chmod\s+\+x|nc\s+-e|bash\s+-c|python\s+-c/i,
  ]],
  ["unsafe_link", [
    /https?:\/\/[^\s)]+/i,
  ]],
  ["secret_exposure", [
    /(api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|secret|client[_-]?secret|password|private[_-]?key)\s*[:=]\s*["']?[A-Za-z0-9_./+=:@-]{3,}/i,
    /\bsk-[A-Za-z0-9_-]{16,}\b/i,
    /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/i,
    /\bAKIA[0-9A-Z]{16}\b/,
    /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/i,
    /\bBearer\s+[A-Za-z0-9._-]{20,}\b/i,
    /\b(?:postgres|postgresql|mysql|mongodb):\/\/[^\s:@]+:[^\s:@]+@/i,
  ]],
  ["privacy_risk", [
    /(home address|phone number|ssn|passport|medical record|proprietary|confidential|trade secret|under nda|\bnda\b|internal[- ]only|non[- ]public|unreleased roadmap|client names?|customer names?|private repo|private document|private source code|proprietary source code|internal source code|internal prompt|private messages?|employee data|customer list|sales pipeline|private metrics?)/i,
    /\b\d{3}-\d{2}-\d{4}\b/,
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
  ]],
  ["tool_use_request", [
    /\b(run|execute|install|open|fetch|browse|clone|download)\s+(?:this|the|a|that)?\s*(command|script|url|repo|repository|files?|packages?|links?)\b/i,
  ]],
  ["sensitive_category", [
    /\b(medical diagnosis|medical advice|doctor|patient|therapy|therapist|mental health|self-harm|legal advice|lawyer|lawsuit|court case|financial advice|investment advice|tax advice|debt advice)\b/i,
  ]],
];

export function analyzeContentSafety(input: string): SafetyFlag[] {
  const flags = new Set<SafetyFlag>();
  for (const [flag, patterns] of patternGroups) {
    if (patterns.some((pattern) => pattern.test(input))) flags.add(flag);
  }
  return [...flags];
}

export function safetyFlagLabel(flag: SafetyFlag): string {
  return flag.replaceAll("_", " ");
}

export function hasCopyRisk(flags: SafetyFlag[]): boolean {
  return flags.some((flag) => ["prompt_injection", "malicious_code", "unsafe_link", "secret_exposure", "privacy_risk", "tool_use_request", "sensitive_category"].includes(flag));
}
