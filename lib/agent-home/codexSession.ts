import { z } from "zod";

const codexTokenBundleSchema = z.object({
  id_token: z.string().trim().min(12).max(20000),
  access_token: z.string().trim().min(12).max(20000),
  refresh_token: z.string().trim().min(12).max(20000),
  account_id: z.string().trim().min(1).max(512).optional(),
}).passthrough();

export const codexAuthCacheSchema = z.object({
  auth_mode: z.literal("chatgpt"),
  tokens: codexTokenBundleSchema,
  last_refresh: z.string().trim().datetime({ offset: true }),
  OPENAI_API_KEY: z.union([z.string().trim().min(12).max(20000), z.null()]).optional(),
}).passthrough();

export type CodexAuthCache = z.output<typeof codexAuthCacheSchema>;

export class CodexSessionImportError extends Error {
  constructor(readonly code: string, message: string, readonly issues: string[] = []) {
    super(message);
  }
}

const rawApiKeyPattern = /^(sk-|sess-|or-)[A-Za-z0-9_\-.]{8,}/;
const bearerPattern = /^Bearer\s+/i;

function fail(code: string, message: string, issues: string[] = []): never {
  throw new CodexSessionImportError(code, message, issues);
}

function rejectRawCredentialText(value: string): void {
  const trimmed = value.trim();
  if (rawApiKeyPattern.test(trimmed) || bearerPattern.test(trimmed)) {
    fail("CODEX_AUTH_CACHE_API_KEY_REJECTED", "Connect Codex requires Codex-managed ChatGPT auth, not an API key or bearer token.");
  }
}

export function parseCodexAuthCache(input: unknown): CodexAuthCache {
  if (typeof input === "string") rejectRawCredentialText(input);
  const parsed = codexAuthCacheSchema.safeParse(input);
  if (!parsed.success) {
    fail(
      "CODEX_AUTH_CACHE_INVALID",
      "Codex auth cache failed validation.",
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "auth.json"}: ${issue.message}`),
    );
  }
  return parsed.data;
}

export function parseCodexAuthCacheSecret(secret: string): CodexAuthCache {
  const trimmed = secret.trim();
  if (!trimmed) fail("CODEX_AUTH_CACHE_EMPTY", "Codex auth cache cannot be empty.");
  rejectRawCredentialText(trimmed);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(trimmed);
  } catch {
    fail("CODEX_AUTH_CACHE_NOT_JSON", "Codex auth cache must be a JSON object produced by Codex.");
  }
  return parseCodexAuthCache(parsedJson);
}

export function serializeCodexAuthCache(input: unknown): string {
  return JSON.stringify(parseCodexAuthCache(input));
}

function accountHint(accountId: string | undefined): string | undefined {
  if (!accountId) return undefined;
  return `…${accountId.slice(-6)}`;
}

export function codexAuthCachePublicMetadata(value: unknown): Record<string, string> | undefined {
  const parsed = codexAuthCacheSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return {
    auth_mode: "chatgpt",
    last_refresh: parsed.data.last_refresh,
    ...(accountHint(parsed.data.tokens.account_id) ? { account_hint: accountHint(parsed.data.tokens.account_id)! } : {}),
  };
}

// Compatibility aliases for the existing provider seam while the device-login route replaces
// direct session-import APIs. They now validate the official managed auth.json shape.
export const codexSessionImportSchema = codexAuthCacheSchema;
export type CodexSessionImport = z.input<typeof codexAuthCacheSchema>;
export type CodexSessionCredentialValue = CodexAuthCache;
export const parseCodexSessionImport = parseCodexAuthCache;
export const parseCodexSessionSecret = parseCodexAuthCacheSecret;
export const serializeCodexSessionImport = serializeCodexAuthCache;
export const codexSessionPublicMetadata = codexAuthCachePublicMetadata;
export function codexSessionExpiresAt(_value: unknown): undefined {
  return undefined;
}
