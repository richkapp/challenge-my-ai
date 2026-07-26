const allowedProtocolFields = new Set([
  "idempotency_key",
  "key_id",
  "pairing_code",
  "public_key",
  "run_nonce",
  "signature",
]);

const credentialSegments = new Set([
  "authorization",
  "bearer",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "password",
  "passwords",
  "secret",
  "secrets",
  "token",
  "tokens",
]);

export const CREDENTIAL_FIELD_ISSUE_PREFIX = "credential_field_forbidden:";

function normalizeFieldName(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function isCredentialField(key: string): boolean {
  const normalized = normalizeFieldName(key);
  if (allowedProtocolFields.has(normalized)) return false;
  const segments = normalized.split("_").filter(Boolean);
  return segments.some((segment) => credentialSegments.has(segment))
    || normalized === "api_key"
    || normalized.endsWith("_api_key")
    || normalized === "private_key"
    || normalized.endsWith("_private_key")
    || normalized === "service_role"
    || normalized.startsWith("service_role_");
}

export function findCredentialShapedFields(value: unknown, rootPath = "$", findings: string[] = []): string[] {
  const pending: Array<{ value: unknown; path: string }> = [{ value, path: rootPath }];
  const seen = new WeakSet<object>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current?.value || typeof current.value !== "object" || seen.has(current.value)) continue;
    seen.add(current.value);

    if (Array.isArray(current.value)) {
      current.value.forEach((child, index) => pending.push({ value: child, path: `${current.path}[${index}]` }));
      continue;
    }

    for (const [key, child] of Object.entries(current.value as Record<string, unknown>)) {
      const childPath = `${current.path}.${key}`;
      if (isCredentialField(key)) findings.push(childPath);
      pending.push({ value: child, path: childPath });
    }
  }

  return findings;
}
