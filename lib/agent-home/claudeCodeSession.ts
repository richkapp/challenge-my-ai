import { z } from "zod";

const claudeOauthSchema = z.object({
  accessToken: z.string().trim().min(12).max(30_000),
  refreshToken: z.string().trim().min(12).max(30_000),
  expiresAt: z.number().int().positive().max(8_640_000_000_000_000),
  scopes: z.array(z.string().trim().min(1).max(120)).max(64).optional(),
  subscriptionType: z.string().trim().min(1).max(80).optional(),
  rateLimitTier: z.string().trim().min(1).max(120).optional(),
}).passthrough();

export const claudeCodeCredentialSchema = z.object({
  claudeAiOauth: claudeOauthSchema,
}).passthrough();

export type ClaudeCodeCredential = z.output<typeof claudeCodeCredentialSchema>;

export class ClaudeCodeCredentialError extends Error {
  constructor(readonly code: string, message: string, readonly issues: string[] = []) {
    super(message);
  }
}

const rawCredentialPattern = /^(?:sk-ant-|Bearer\s+|cc-)/i;

function fail(code: string, message: string, issues: string[] = []): never {
  throw new ClaudeCodeCredentialError(code, message, issues);
}

function rejectRawCredentialText(value: string): void {
  if (rawCredentialPattern.test(value.trim())) {
    fail("CLAUDE_CODE_CREDENTIAL_TEXT_REJECTED", "Connect Claude Code requires official CLI-managed login, not a pasted API key, bearer token, setup token, or OAuth token.");
  }
}

export function parseClaudeCodeCredential(input: unknown): ClaudeCodeCredential {
  if (typeof input === "string") rejectRawCredentialText(input);
  const parsed = claudeCodeCredentialSchema.safeParse(input);
  if (!parsed.success) {
    fail(
      "CLAUDE_CODE_CREDENTIAL_INVALID",
      "Claude Code credential file failed validation.",
      parsed.error.issues.map((issue) => `${issue.path.join(".") || ".credentials.json"}: ${issue.message}`),
    );
  }
  return parsed.data;
}

export function parseClaudeCodeCredentialSecret(secret: string): ClaudeCodeCredential {
  const trimmed = secret.trim();
  if (!trimmed) fail("CLAUDE_CODE_CREDENTIAL_EMPTY", "Claude Code credential file cannot be empty.");
  rejectRawCredentialText(trimmed);
  let value: unknown;
  try {
    value = JSON.parse(trimmed) as unknown;
  } catch {
    fail("CLAUDE_CODE_CREDENTIAL_NOT_JSON", "Claude Code credential file must be a JSON object produced by the official CLI.");
  }
  return parseClaudeCodeCredential(value);
}

export function serializeClaudeCodeCredential(input: unknown): string {
  return JSON.stringify(parseClaudeCodeCredential(input));
}

export function claudeCodeCredentialExpiresAt(input: unknown): string | undefined {
  const parsed = claudeCodeCredentialSchema.safeParse(input);
  if (!parsed.success) return undefined;
  return new Date(parsed.data.claudeAiOauth.expiresAt).toISOString();
}

export function claudeCodeCredentialPublicMetadata(input: unknown): Record<string, string> | undefined {
  const parsed = claudeCodeCredentialSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const oauth = parsed.data.claudeAiOauth;
  return {
    auth_mode: "claude_subscription",
    expires_at: new Date(oauth.expiresAt).toISOString(),
    ...(oauth.subscriptionType ? { subscription_type: oauth.subscriptionType } : {}),
    ...(oauth.rateLimitTier ? { rate_limit_tier: oauth.rateLimitTier } : {}),
  };
}
