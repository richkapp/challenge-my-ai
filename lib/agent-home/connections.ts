import type { AgentConnectionDelegation } from "@/lib/types";
import type { AgentConnection, AgentConnectionRunRequest, ChildRunDelegationConfig, RedactedAgentConnection } from "@/lib/agent-home/providerAdapters";

const deniedChildRunKeys = new Set([
  "api_key",
  "apikey",
  "access_token",
  "refresh_token",
  "oauth_access_token",
  "oauth_refresh_token",
  "authorization",
  "bearer_token",
  "database_url",
  "postgres_url",
  "supabase_service_role_key",
  "receipt_signing_key",
  "receipt_signing_secret",
  "broker_token",
  "broker_internal_token",
  "provider_secret",
  "client_secret",
  "credential_ref",
  "credentialref",
  "encrypted_credential_ref",
  "encryptedcredentialref",
  "secret",
]);

export class ChildRunSecretBoundaryError extends Error {
  readonly code = "CHILD_RUN_SECRET_BOUNDARY_VIOLATION";

  constructor(readonly paths: string[], readonly context = "Child run payload") {
    super(`${context} contains broker/provider secret fields: ${paths.join(", ")}`);
  }
}

export type ConnectionReadinessResult = {
  ready: boolean;
  issues: string[];
};

function normalizeConfigKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-.\s]+/g, "_").toLowerCase();
}

function scanDeniedKeys(value: unknown, path: string[] = [], issues: string[] = []): string[] {
  if (!value || typeof value !== "object") return issues;
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanDeniedKeys(item, [...path, String(index)], issues));
    return issues;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeConfigKey(key);
    if (deniedChildRunKeys.has(normalized)) issues.push([...path, key].join("."));
    scanDeniedKeys(child, [...path, key], issues);
  }
  return issues;
}

export function findChildRunSecretFields(value: unknown): string[] {
  return scanDeniedKeys(value);
}

export function assertNoChildRunSecrets(value: unknown, context = "Child run payload"): void {
  const paths = findChildRunSecretFields(value);
  if (paths.length > 0) throw new ChildRunSecretBoundaryError(paths, context);
}

export function redactAgentConnection(connection: AgentConnection): RedactedAgentConnection {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { credentialRef: _credentialRef, ...redacted } = connection;
  return { ...redacted, brokerCredentialAvailable: Boolean(connection.credentialRef) };
}

export function isAgentConnectionExpired(connection: AgentConnection, now: Date = new Date()): boolean {
  return Boolean(connection.expiresAt && Date.parse(connection.expiresAt) <= now.getTime());
}

export function assessAgentConnectionReadiness(connection: AgentConnection | undefined, request?: Partial<AgentConnectionRunRequest>, now: Date = new Date()): ConnectionReadinessResult {
  if (!connection) return { ready: false, issues: ["Agent connection is missing."] };

  const issues: string[] = [];
  if (connection.status !== "ready") issues.push(`Agent connection is ${connection.status}.`);
  if (!connection.credentialRef) issues.push("Agent connection is missing a broker credential reference.");
  if (isAgentConnectionExpired(connection, now)) issues.push("Agent connection has expired.");
  if (connection.lastSmoke.status !== "passed") issues.push("Agent connection smoke test has not passed.");

  const requestedModel = request?.requestedModel || connection.defaultModel;
  if (requestedModel && !connection.allowedModels.includes(requestedModel)) {
    issues.push(`Requested model ${requestedModel} is not allowed for this connection.`);
  }

  const requestClass = request?.requestClass || "contribution_card";
  if (!connection.allowedRequestClasses.includes(requestClass)) {
    issues.push(`Request class ${requestClass} is not allowed for this connection.`);
  }

  return { ready: issues.length === 0, issues };
}

export function assertAgentConnectionReady(connection: AgentConnection | undefined, request: AgentConnectionRunRequest, now: Date = new Date()): AgentConnection {
  const readiness = assessAgentConnectionReadiness(connection, request, now);
  if (!readiness.ready) {
    const error = new Error(`Agent connection is not ready: ${readiness.issues.join("; ")}`) as Error & { code: string; issues: string[] };
    error.code = "AGENT_CONNECTION_NOT_READY";
    error.issues = readiness.issues;
    throw error;
  }
  if (!connection) {
    const error = new Error("Agent connection is not ready: Agent connection is missing.") as Error & { code: string; issues: string[] };
    error.code = "AGENT_CONNECTION_NOT_READY";
    error.issues = ["Agent connection is missing."];
    throw error;
  }
  return connection;
}

export function childRunDelegationConfig(input: {
  runId: string;
  delegation: AgentConnectionDelegation;
  modelProxyUrl?: string;
}): ChildRunDelegationConfig {
  const config: ChildRunDelegationConfig = {
    run_id: input.runId,
    delegation_id: input.delegation.delegation_id || input.delegation.connection_id,
    agent_connection_id: input.delegation.agent_connection_id || input.delegation.connection_id,
    provider: input.delegation.provider,
    allowed_model: input.delegation.allowed_model,
    allowed_request_class: input.delegation.allowed_request_class,
    expires_at: input.delegation.expires_at,
    max_requests: input.delegation.max_requests || 1,
    max_spend_cents: input.delegation.max_spend_cents,
    model_proxy_url: input.modelProxyUrl,
  };
  assertNoChildRunSecrets(config);
  return config;
}
