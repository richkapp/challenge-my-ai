import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { codexSessionExpiresAt, codexSessionPublicMetadata, parseCodexSessionImport, parseCodexSessionSecret } from "@/lib/agent-home/codexSession";
import { claudeCodeCredentialExpiresAt, claudeCodeCredentialPublicMetadata, parseClaudeCodeCredential, parseClaudeCodeCredentialSecret } from "@/lib/agent-home/claudeCodeSession";
import { env, isProductionLike, type RuntimeEnv } from "@/lib/config/env";
import type { AgentCredentialRecord } from "@/lib/agent-home/providerAdapters";

export type SealedAgentCredentialRecord = {
  ref: string;
  ownerId: string;
  connectionId: string;
  provider: string;
  sealedValue: string;
  createdAt: string;
  updatedAt: string;
  rotatedAt?: string;
  revokedAt?: string;
  expiresAt?: string;
  publicMetadata?: Record<string, string>;
  revision?: number;
};

export type SealedRuntimeSecretRecord = {
  ref: string;
  sealedValue: string;
  createdAt: string;
  updatedAt: string;
  rotatedAt?: string;
};

export class BrokerVaultError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

const localDevSecret = "local-dev-agent-broker-vault-secret";

function activeRuntime(): RuntimeEnv {
  return {
    ...env,
    CMAI_AGENT_BROKER_VAULT_SECRET: process.env.CMAI_AGENT_BROKER_VAULT_SECRET || env.CMAI_AGENT_BROKER_VAULT_SECRET,
    CMAI_AGENT_BROKER_VAULT_MODE: (process.env.CMAI_AGENT_BROKER_VAULT_MODE as RuntimeEnv["CMAI_AGENT_BROKER_VAULT_MODE"]) || env.CMAI_AGENT_BROKER_VAULT_MODE,
  };
}

function vaultSecret(runtime: RuntimeEnv = activeRuntime()): string {
  if (runtime.CMAI_AGENT_BROKER_VAULT_SECRET) return runtime.CMAI_AGENT_BROKER_VAULT_SECRET;
  if (!isProductionLike(runtime)) return localDevSecret;
  throw new BrokerVaultError("BROKER_VAULT_SECRET_MISSING", "CMAI_AGENT_BROKER_VAULT_SECRET is required to encrypt broker credentials.");
}

function keyFor(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function brokerCredentialRef(connectionId: string): string {
  return `cred_${connectionId}`;
}

export function credentialValueForProvider(provider: string, secret: string): unknown {
  const trimmed = secret.trim();
  if (!trimmed) throw new BrokerVaultError("BROKER_CREDENTIAL_EMPTY", "Provider credential cannot be empty.");
  if (provider === "codex") return parseCodexSessionSecret(trimmed);
  if (provider === "claude_code") return parseClaudeCodeCredentialSecret(trimmed);
  return { apiKey: trimmed };
}

function credentialExpiresAtForProvider(provider: string, value: unknown): string | undefined {
  if (provider === "codex") return codexSessionExpiresAt(value);
  if (provider === "claude_code") return claudeCodeCredentialExpiresAt(value);
  return undefined;
}

function credentialPublicMetadataForProvider(provider: string, value: unknown): Record<string, string> | undefined {
  if (provider === "codex") return codexSessionPublicMetadata(value);
  if (provider === "claude_code") return claudeCodeCredentialPublicMetadata(value);
  return undefined;
}

export function sealCredentialValue(value: unknown, secret = vaultSecret()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(":");
}

export function unsealCredentialValue(sealedValue: string, secret = vaultSecret()): unknown {
  const [version, ivEncoded, tagEncoded, ciphertextEncoded] = sealedValue.split(":");
  if (version !== "v1" || !ivEncoded || !tagEncoded || !ciphertextEncoded) {
    throw new BrokerVaultError("BROKER_CREDENTIAL_SEAL_INVALID", "Broker credential seal is invalid.");
  }
  const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), Buffer.from(ivEncoded, "base64url"));
  decipher.setAuthTag(Buffer.from(tagEncoded, "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(ciphertextEncoded, "base64url")), decipher.final()]).toString("utf8");
  return JSON.parse(plaintext) as unknown;
}

export function sealRuntimeSecret(input: {
  ref: string;
  value: string;
  now?: Date;
  previous?: SealedRuntimeSecretRecord;
}): SealedRuntimeSecretRecord {
  const at = (input.now || new Date()).toISOString();
  return {
    ref: input.ref,
    sealedValue: sealCredentialValue({ value: input.value }),
    createdAt: input.previous?.createdAt || at,
    updatedAt: at,
    rotatedAt: input.previous ? at : undefined,
  };
}

export function unsealRuntimeSecret(record: SealedRuntimeSecretRecord): string {
  const value = unsealCredentialValue(record.sealedValue);
  if (!value || typeof value !== "object" || typeof (value as Record<string, unknown>).value !== "string") {
    throw new BrokerVaultError("RUNTIME_SECRET_SEAL_INVALID", "Runtime secret seal is invalid.");
  }
  return (value as { value: string }).value;
}

export function sealAgentCredential(input: {
  ownerId: string;
  connectionId: string;
  provider: string;
  secret: string;
  now?: Date;
  previous?: SealedAgentCredentialRecord;
}): SealedAgentCredentialRecord {
  return sealAgentCredentialValue({
    ownerId: input.ownerId,
    connectionId: input.connectionId,
    provider: input.provider,
    value: credentialValueForProvider(input.provider, input.secret),
    now: input.now,
    previous: input.previous,
  });
}

export function sealAgentCredentialValue(input: {
  ownerId: string;
  connectionId: string;
  provider: string;
  value: unknown;
  now?: Date;
  previous?: SealedAgentCredentialRecord;
}): SealedAgentCredentialRecord {
  const at = (input.now || new Date()).toISOString();
  const credentialValue = input.provider === "codex"
    ? parseCodexSessionImport(input.value)
    : input.provider === "claude_code"
      ? parseClaudeCodeCredential(input.value)
      : input.value;
  return {
    ref: brokerCredentialRef(input.connectionId),
    ownerId: input.ownerId,
    connectionId: input.connectionId,
    provider: input.provider,
    sealedValue: sealCredentialValue(credentialValue),
    createdAt: input.previous?.createdAt || at,
    updatedAt: at,
    rotatedAt: input.previous ? at : undefined,
    expiresAt: credentialExpiresAtForProvider(input.provider, credentialValue),
    publicMetadata: credentialPublicMetadataForProvider(input.provider, credentialValue),
    revision: (input.previous?.revision || 0) + 1,
  };
}

export function unsealAgentCredential(record: SealedAgentCredentialRecord): AgentCredentialRecord | undefined {
  if (record.revokedAt) return undefined;
  const refreshableManagedSession = record.provider === "codex" || record.provider === "claude_code";
  if (!refreshableManagedSession && record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) return undefined;
  return {
    ref: record.ref,
    provider: record.provider,
    value: unsealCredentialValue(record.sealedValue),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revision: record.revision || 1,
    expiresAt: record.expiresAt,
  };
}

export function redactSecretLikeText(value: string) {
  let redacted = value.replace(/sk-[A-Za-z0-9_-]{6,}/g, "[redacted-secret]");
  redacted = redacted.replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?id|id[_-]?token|database_url|DATABASE_URL|provider[_-]?credential)\s*[:=]\s*[^\s,;]+/gi, (_match, label: string) => `${label}=[redacted-secret]`);
  redacted = redacted.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgres://[redacted-secret]");
  return { text: redacted, redacted: redacted !== value };
}

export function publicCredentialState(record: SealedAgentCredentialRecord | undefined) {
  if (!record || record.revokedAt) return { brokerCredentialAvailable: false };
  return {
    brokerCredentialAvailable: true,
    credentialUpdatedAt: record.updatedAt,
    credentialRotatedAt: record.rotatedAt,
    credentialExpiresAt: record.expiresAt,
    credentialPublicMetadata: record.publicMetadata,
  };
}
