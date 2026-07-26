import { createHmac } from "node:crypto";

export const telemetryPseudonymKinds = [
  "actor",
  "challenge",
  "contribution",
  "pairing",
  "run",
  "answer",
  "reward",
  "dispute",
  "moderation",
  "notification",
  "cohort",
  "event",
] as const;

export type TelemetryPseudonymKind = (typeof telemetryPseudonymKinds)[number];

export type ForbiddenTelemetryFinding = {
  path: string;
  reason:
    | "content_key"
    | "url_value"
    | "email_value"
    | "credential_value"
    | "pairing_code_value"
    | "cyclic_value";
};

export class TelemetryPrivacyError extends Error {
  readonly code = "telemetry_privacy_rejected" as const;

  constructor(readonly findings: readonly ForbiddenTelemetryFinding[]) {
    super(`Telemetry payload rejected at ${findings.map((finding) => finding.path).join(", ")}.`);
    this.name = "TelemetryPrivacyError";
  }
}

const safePseudonymousIdentifierKeys = new Set([
  "challenge_id",
  "contribution_id",
  "pairing_id",
  "run_id",
  "answer_id",
  "reward_id",
  "dispute_id",
  "moderation_id",
  "notification_id",
  "cohort_id",
]);

const contentKeyPattern = /(?:^|_)(?:prompt|answer|transcript|url|uri|query(?:_string)?|search_query|email|social(?:_url)?|credential|secret|api_key|access_token|refresh_token|authorization|password|pairing_code|private_challenge|challenge_text|problem_statement|original_ai_answer|model_output|raw|body|message|display_name|full_name)(?:$|_)/i;
const urlValuePattern = /(?:https?:\/\/|www\.)/i;
const emailValuePattern = /\b[^\s@]+@[^\s@]+\.[^\s@]+\b/i;
const credentialValuePattern = /(?:\bBearer\s+[A-Za-z0-9._~-]+|\b(?:sk|pk|rk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;
const pairingCodeValuePattern = /\bPAIR(?:ING)?[-_ ][A-Z0-9]{4,}(?:[-_ ][A-Z0-9]{4,})*\b/i;
const pseudonymPattern = /^psn_([a-z]+)_([a-f0-9]{24})$/;

function sensitiveStringReasons(value: string): ForbiddenTelemetryFinding["reason"][] {
  const reasons: ForbiddenTelemetryFinding["reason"][] = [];
  if (urlValuePattern.test(value)) reasons.push("url_value");
  if (emailValuePattern.test(value)) reasons.push("email_value");
  if (credentialValuePattern.test(value)) reasons.push("credential_value");
  if (pairingCodeValuePattern.test(value)) reasons.push("pairing_code_value");
  return reasons;
}

function sensitiveKeyReasons(key: string): ForbiddenTelemetryFinding["reason"][] {
  return sensitiveStringReasons(key).filter(
    (reason) => reason !== "pairing_code_value" || !/^[a-z][a-z0-9_]{0,63}$/.test(key),
  );
}

function safeTelemetryPathForKey(path: string, key: string, index: number): string {
  const normalized = normalizeTelemetryKey(key);
  if (
    isForbiddenTelemetryKey(key)
    || sensitiveKeyReasons(key).length > 0
    || !/^[a-z][a-z0-9_]{0,63}$/.test(normalized)
  ) {
    return `${path}.[redacted_key_${index}]`;
  }
  return `${path}.${normalized}`;
}

export function normalizeTelemetryKey(key: string): string {
  return key
    .normalize("NFKC")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

export function isForbiddenTelemetryKey(key: string): boolean {
  const normalized = normalizeTelemetryKey(key);
  return !safePseudonymousIdentifierKeys.has(normalized) && contentKeyPattern.test(normalized);
}

export function findForbiddenTelemetryData(value: unknown): ForbiddenTelemetryFinding[] {
  const findings: ForbiddenTelemetryFinding[] = [];
  const ancestors = new WeakSet<object>();

  const visit = (current: unknown, path: string): void => {
    if (typeof current === "string") {
      for (const reason of sensitiveStringReasons(current)) findings.push({ path, reason });
      return;
    }
    if (!current || typeof current !== "object") return;
    if (ancestors.has(current)) {
      findings.push({ path, reason: "cyclic_value" });
      return;
    }

    ancestors.add(current);
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`));
    } else {
      for (const [index, [key, nested]] of Object.entries(current as Record<string, unknown>).entries()) {
        const nestedPath = safeTelemetryPathForKey(path, key, index);
        if (isForbiddenTelemetryKey(key)) findings.push({ path: nestedPath, reason: "content_key" });
        for (const reason of sensitiveKeyReasons(key)) findings.push({ path: nestedPath, reason });
        visit(nested, nestedPath);
      }
    }
    ancestors.delete(current);
  };

  visit(value, "$");
  return findings;
}

export function assertNoForbiddenTelemetryData(value: unknown): void {
  const findings = findForbiddenTelemetryData(value);
  if (findings.length > 0) throw new TelemetryPrivacyError(findings);
}

export function pseudonymizeTelemetryId(
  kind: TelemetryPseudonymKind,
  rawId: string,
  secret: string,
): string {
  if (!telemetryPseudonymKinds.includes(kind)) throw new Error(`Unsupported telemetry pseudonym kind: ${kind}.`);
  if (!rawId.trim()) throw new Error("Telemetry pseudonym source must not be empty.");
  if (secret.length < 32) throw new Error("Telemetry pseudonym secret must be at least 32 characters.");
  const digest = createHmac("sha256", secret)
    .update(`CMAI_TELEMETRY_PSEUDONYM_V1\0${kind}\0${rawId}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `psn_${kind}_${digest}`;
}

export function isTelemetryPseudonym(
  value: unknown,
  allowedKinds: readonly TelemetryPseudonymKind[] = telemetryPseudonymKinds,
): value is string {
  if (typeof value !== "string") return false;
  const match = pseudonymPattern.exec(value);
  return Boolean(match && allowedKinds.includes(match[1] as TelemetryPseudonymKind));
}
