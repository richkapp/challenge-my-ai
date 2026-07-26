import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { loadEnv, modelProxyGrantStore } from "@/lib/config/env";
import { consumeModelProxyGrant, markAgentConnectionNeedsReconnect, registerModelProxyGrant, replaceAgentConnectionCredential, revokeModelProxyGrant } from "@/lib/store";
import type { AgentConnectionDelegation, ModelProxyGrantRecord } from "@/lib/types";
import type { AgentCredentialRecord } from "@/lib/agent-home/providerAdapters";
import { parseCodexAuthCache, parseCodexAuthCacheSecret, serializeCodexAuthCache, type CodexAuthCache } from "@/lib/agent-home/codexSession";
import { codexProcessEnv, resolveCodexCommand } from "@/lib/agent-home/codexCli";
import { ClaudeCodeCliError, runClaudeCodeSession } from "@/lib/agent-home/claudeCodeCli";
import { parseClaudeCodeCredential } from "@/lib/agent-home/claudeCodeSession";
import { HttpError } from "@/lib/api/responses";
import { assertRateLimitPolicy } from "@/lib/security/rateLimit";

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1).max(20000),
}).strict();

export const modelProxyRequestSchema = z.object({
  schema_version: z.literal("1.0"),
  run_id: z.string().min(1).max(160),
  delegation_id: z.string().min(1).max(160),
  agent_connection_id: z.string().min(1).max(160),
  provider: z.string().min(1).max(80),
  model: z.string().min(1).max(160),
  request_class: z.string().min(1).max(80).default("contribution_card"),
  messages: z.array(messageSchema).min(1).max(12),
  response_format: z.enum(["text", "json_object"]).optional().default("text"),
}).strict();

export type ModelProxyMessage = z.infer<typeof messageSchema>;
export type ModelProxyRequest = z.infer<typeof modelProxyRequestSchema>;

export type ModelProxyProviderResult = {
  content: string;
  provider: string;
  requestedModel: string;
  returnedModel?: string;
  modelDisplayName?: string;
  providerResponseId?: string;
  providerModelVerified: boolean;
  credentialUpdate?: unknown;
};

export const modelProxyResponseSchema = z.object({
  ok: z.literal(true),
  content: z.string().min(1),
  provider: z.string().min(1),
  requested_model: z.string().min(1),
  returned_model: z.string().min(1).optional(),
  model_display_name: z.string().min(1),
  provider_response_id: z.string().min(1).optional(),
  provider_model_verified: z.boolean(),
  remaining_requests: z.number().int().nonnegative(),
}).strict();

export type ModelProxyResponse = z.infer<typeof modelProxyResponseSchema>;

export type ModelProxyGrantInput = {
  runId: string;
  ownerId?: string;
  delegation: AgentConnectionDelegation;
  agentConnectionId: string;
  provider: string;
  allowedModel: string;
  allowedRequestClass: string;
  expiresAt: string;
  maxRequests?: number;
  maxSpendCents?: number;
  credential: AgentCredentialRecord;
};

type StoredModelProxyGrant = ModelProxyGrantInput & {
  ownerId: string;
  delegationId: string;
  remainingRequests: number;
  consumedAt?: string;
  revokedAt?: string;
};

export type ModelProxyRegistry = {
  register(input: ModelProxyGrantInput): { delegationId: string; expiresAt: string; remainingRequests: number } | Promise<{ delegationId: string; expiresAt: string; remainingRequests: number }>;
  get(delegationId: string): Omit<StoredModelProxyGrant, "credential"> | ModelProxyGrantRecord | undefined | Promise<Omit<StoredModelProxyGrant, "credential"> | ModelProxyGrantRecord | undefined>;
  revoke(delegationId: string, reason?: string): void | Promise<void>;
  dispatch(body: unknown, caller?: ModelProxyDispatchCaller): Promise<ModelProxyResponse>;
};

export class ModelProxyError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400, readonly issues: string[] = [], readonly details?: unknown) {
    super(message);
  }
}

export type ModelProxyProviderCaller = (input: {
  request: ModelProxyRequest;
  credential: AgentCredentialRecord;
  grant: Readonly<StoredModelProxyGrant>;
}) => Promise<ModelProxyProviderResult>;

export type ModelProxyProviderCallerRegistry = {
  callerFor(provider: string): ModelProxyProviderCaller | undefined;
};

export class StaticModelProxyProviderCallerRegistry implements ModelProxyProviderCallerRegistry {
  private readonly callers = new Map<string, ModelProxyProviderCaller>();

  constructor(entries: Array<[string, ModelProxyProviderCaller]> = []) {
    for (const [provider, caller] of entries) this.register(provider, caller);
  }

  register(provider: string, caller: ModelProxyProviderCaller): void {
    this.callers.set(provider, caller);
  }

  callerFor(provider: string): ModelProxyProviderCaller | undefined {
    return this.callers.get(provider);
  }
}

type ModelProxyDispatchCaller = ModelProxyProviderCaller | ModelProxyProviderCallerRegistry;

function dispatchCallerIsRegistry(caller: ModelProxyDispatchCaller): caller is ModelProxyProviderCallerRegistry {
  return typeof caller !== "function";
}

const defaultProviderCallerRegistry = new StaticModelProxyProviderCallerRegistry();

export function defaultModelProxyProviderCallerRegistry(): ModelProxyProviderCallerRegistry {
  return defaultProviderCallerRegistry;
}

function providerCallerFor(provider: string, caller: ModelProxyDispatchCaller = defaultProviderCallerRegistry): ModelProxyProviderCaller {
  if (!dispatchCallerIsRegistry(caller)) return caller;
  const resolved = caller.callerFor(provider);
  if (!resolved) throw new ModelProxyError("MODEL_PROXY_PROVIDER_UNAVAILABLE", `No broker model proxy caller is registered for ${provider}.`, 503);
  return resolved;
}

function delegationIdFor(delegation: AgentConnectionDelegation): string {
  return delegation.delegation_id || delegation.connection_id;
}

function nowMs(now: () => Date): number {
  return now().getTime();
}

function parseRequest(body: unknown): ModelProxyRequest {
  const parsed = modelProxyRequestSchema.safeParse(body);
  if (!parsed.success) {
    throw new ModelProxyError("MODEL_PROXY_BAD_REQUEST", "Model proxy request was invalid.", 400, parsed.error.issues.map((issue) => issue.path.join(".") || issue.message));
  }
  return parsed.data;
}

function modelProxyRateLimitKey(scope: Pick<StoredModelProxyGrant, "delegationId" | "runId" | "agentConnectionId">): string {
  return [
    `delegation:${scope.delegationId}`,
    `run:${scope.runId}`,
    `connection:${scope.agentConnectionId}`,
  ].join(":");
}

function assertModelProxyDispatchRateLimit(scope: Pick<StoredModelProxyGrant, "delegationId" | "runId" | "agentConnectionId">): void {
  try {
    assertRateLimitPolicy("model_proxy_dispatch", modelProxyRateLimitKey(scope));
  } catch (error) {
    if (error instanceof HttpError && error.code === "rate_limited") {
      throw new ModelProxyError("MODEL_PROXY_RATE_LIMITED", error.message, 429, [], error.details);
    }
    throw error;
  }
}

function credentialString(credential: AgentCredentialRecord, keys: string[]): string | undefined {
  const value = credential.value;
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}

function openRouterApiKey(credential: AgentCredentialRecord): string | undefined {
  return credentialString(credential, ["apiKey", "api_key", "openrouterApiKey", "openrouter_api_key"]);
}

function anthropicApiKey(credential: AgentCredentialRecord): string | undefined {
  return credentialString(credential, ["apiKey", "api_key", "anthropicApiKey", "anthropic_api_key"]);
}

function anthropicBearerToken(credential: AgentCredentialRecord): string | undefined {
  return credentialString(credential, ["accessToken", "access_token", "bearerToken", "bearer_token", "wifBearerToken", "wif_bearer_token"]);
}

function openAiApiKey(credential: AgentCredentialRecord): string | undefined {
  return credentialString(credential, ["apiKey", "api_key", "openAiApiKey", "openaiApiKey", "openai_api_key"]);
}

function openAiBearerToken(credential: AgentCredentialRecord): string | undefined {
  return credentialString(credential, ["accessToken", "access_token", "bearerToken", "bearer_token", "wifBearerToken", "wif_bearer_token"]);
}


function codexSessionCredential(credential: AgentCredentialRecord) {
  try {
    return parseCodexAuthCache(credential.value);
  } catch (error) {
    throw new ModelProxyError("MODEL_PROXY_CODEX_SESSION_INVALID", "Codex ChatGPT authentication needs to be reconnected.", 503, error instanceof Error ? [error.message] : []);
  }
}

function claudeCodeSessionCredential(credential: AgentCredentialRecord) {
  try {
    return parseClaudeCodeCredential(credential.value);
  } catch (error) {
    throw new ModelProxyError("MODEL_PROXY_CLAUDE_CODE_SESSION_INVALID", "Claude Code authentication needs to be reconnected.", 503, error instanceof Error ? [error.message] : []);
  }
}

function codexPromptFromRequest(request: ModelProxyRequest): string {
  return request.messages.map((message) => `${message.role.toUpperCase()}:\n${message.content}`).join("\n\n---\n\n");
}

type CommandResult = { exitCode: number | null; stdout: string; stderr: string };

type SpawnOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
};

const maxCodexCommandOutputBytes = 1_000_000;

async function readUtf8FileBounded(filePath: string, errorCode: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(maxCodexCommandOutputBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxCodexCommandOutputBytes) {
      throw new ModelProxyError(errorCode, "Codex CLI returned more data than the broker permits.", 502);
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function runCommand(command: string, args: string[], options: SpawnOptions = {}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      reject(error);
    };
    timeout = options.timeoutMs ? setTimeout(() => {
      fail(new ModelProxyError("MODEL_PROXY_CODEX_CLI_TIMEOUT", "Codex CLI timed out before returning a contribution card.", 504));
    }, options.timeoutMs) : undefined;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      const value = String(chunk);
      stdoutBytes += Buffer.byteLength(value);
      if (stdoutBytes > maxCodexCommandOutputBytes) return fail(new ModelProxyError("MODEL_PROXY_CODEX_CLI_OUTPUT_TOO_LARGE", "Codex CLI stdout exceeded the broker limit.", 502));
      stdout += value;
    });
    child.stderr?.on("data", (chunk) => {
      const value = String(chunk);
      stderrBytes += Buffer.byteLength(value);
      if (stderrBytes > maxCodexCommandOutputBytes) return fail(new ModelProxyError("MODEL_PROXY_CODEX_CLI_OUTPUT_TOO_LARGE", "Codex CLI stderr exceeded the broker limit.", 502));
      stderr += value;
    });
    child.on("error", fail);
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve({ exitCode, stdout, stderr });
    });
    if (options.input !== undefined && child.stdin) {
      child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}

export async function isCodexCliAvailable(command?: string): Promise<boolean> {
  try {
    const resolved = command ? { command, prefixArgs: [] as string[] } : resolveCodexCommand();
    const result = await runCommand(resolved.command, [...resolved.prefixArgs, "--version"], { env: codexProcessEnv(tmpdir()), timeoutMs: 10_000 });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

async function runCodexCliSession(input: { authCache: CodexAuthCache; model: string; prompt: string }): Promise<{ content: string; stdout: string; stderr: string; refreshedAuthCache?: CodexAuthCache }> {
  const resolved = resolveCodexCommand();
  const codexHome = await mkdtemp(join(tmpdir(), "cmai-codex-"));
  const outputPath = join(codexHome, "last-message.txt");
  const authPath = join(codexHome, "auth.json");
  const envForCodex = codexProcessEnv(codexHome);
  try {
    await writeFile(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\n', { encoding: "utf8", mode: 0o600 });
    await writeFile(authPath, serializeCodexAuthCache(input.authCache), { encoding: "utf8", mode: 0o600 });
    const exec = await runCommand(resolved.command, [
      ...resolved.prefixArgs,
      "exec",
      "--strict-config",
      "--ignore-user-config",
      "--ignore-rules",
      "--config",
      'approval_policy="never"',
      "--disable",
      "shell_tool",
      "--disable",
      "browser_use",
      "--disable",
      "computer_use",
      "--disable",
      "in_app_browser",
      "--disable",
      "multi_agent",
      "--disable",
      "image_generation",
      "--disable",
      "apps",
      "--disable",
      "hooks",
      "--disable",
      "plugins",
      "--disable",
      "tool_suggest",
      "--ephemeral",
      "--json",
      "--skip-git-repo-check",
      "--output-last-message",
      outputPath,
      "--model",
      input.model,
      "--sandbox",
      "read-only",
      input.prompt,
    ], { cwd: codexHome, env: envForCodex, timeoutMs: Number(process.env.CMAI_CODEX_EXEC_TIMEOUT_MS || 180_000) });
    if (exec.exitCode !== 0) {
      const authenticationFailed = /not logged in|authentication|unauthorized|refresh token|token refresh|\b401\b/i.test(exec.stderr);
      throw new ModelProxyError(
        authenticationFailed ? "MODEL_PROXY_CODEX_AUTH_FAILED" : "MODEL_PROXY_CODEX_EXEC_FAILED",
        authenticationFailed ? "Codex ChatGPT authentication needs to be reconnected." : "Codex CLI failed before returning a contribution card.",
        authenticationFailed ? 401 : 502,
      );
    }
    let content = "";
    try {
      content = (await readUtf8FileBounded(outputPath, "MODEL_PROXY_CODEX_CLI_OUTPUT_TOO_LARGE")).trim();
    } catch {
      content = exec.stdout.trim();
    }
    if (!content) throw new ModelProxyError("MODEL_PROXY_PROVIDER_EMPTY_RESPONSE", "Codex CLI did not return a final message.", 502);
    const refreshed = parseCodexAuthCacheSecret(await readUtf8FileBounded(authPath, "MODEL_PROXY_CODEX_SESSION_INVALID"));
    const refreshedAuthCache = serializeCodexAuthCache(refreshed) === serializeCodexAuthCache(input.authCache) ? undefined : refreshed;
    return { content, stdout: exec.stdout, stderr: exec.stderr, refreshedAuthCache };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ModelProxyError("MODEL_PROXY_CODEX_CLI_UNAVAILABLE", "Codex CLI is not installed or not executable on the broker host.", 503);
    }
    throw error;
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
}

function assertGrantCanAttempt(grant: StoredModelProxyGrant, now: () => Date): void {
  if (grant.revokedAt) throw new ModelProxyError("MODEL_PROXY_DELEGATION_REVOKED", "Model proxy delegation has been revoked.", 403);
  if (Date.parse(grant.expiresAt) <= nowMs(now)) throw new ModelProxyError("MODEL_PROXY_DELEGATION_EXPIRED", "Model proxy delegation has expired.", 403);
  if (grant.remainingRequests < 1) throw new ModelProxyError("MODEL_PROXY_DELEGATION_CONSUMED", "Model proxy delegation has already been consumed.", 409);
}

function assertGrantMatchesRequest(grant: StoredModelProxyGrant, request: ModelProxyRequest): void {
  if (request.run_id !== grant.runId) throw new ModelProxyError("MODEL_PROXY_RUN_MISMATCH", "Model proxy delegation is scoped to a different run.", 403);
  if (request.agent_connection_id !== grant.agentConnectionId) throw new ModelProxyError("MODEL_PROXY_AGENT_CONNECTION_MISMATCH", "Model proxy delegation is scoped to a different Agent connection.", 403);
  if (request.provider !== grant.provider) throw new ModelProxyError("MODEL_PROXY_PROVIDER_MISMATCH", "Model proxy delegation is scoped to a different provider.", 403);
  if (request.model !== grant.allowedModel) throw new ModelProxyError("MODEL_PROXY_MODEL_MISMATCH", "Model proxy delegation is scoped to a different model.", 403);
  if (request.request_class !== grant.allowedRequestClass) throw new ModelProxyError("MODEL_PROXY_REQUEST_CLASS_MISMATCH", "Model proxy delegation is scoped to a different request class.", 403);
}

function providerResponseFromResult(request: ModelProxyRequest, grant: Pick<StoredModelProxyGrant, "provider" | "allowedModel" | "remainingRequests">, result: ModelProxyProviderResult): ModelProxyResponse {
  if (result.provider !== request.provider || result.provider !== grant.provider || result.requestedModel !== request.model || result.requestedModel !== grant.allowedModel) {
    throw new ModelProxyError("MODEL_PROXY_PROVIDER_SCOPE_MISMATCH", "Model proxy provider caller returned metadata outside the scoped delegation.", 502);
  }
  const returnedModel = result.returnedModel?.trim() || undefined;
  const providerResponseId = result.providerResponseId?.trim() || undefined;
  const providerModelVerified = result.providerModelVerified === true && Boolean(returnedModel || providerResponseId);
  const modelDisplayName = result.modelDisplayName?.trim() || returnedModel || request.model;
  const response: ModelProxyResponse = {
    ok: true,
    content: result.content,
    provider: request.provider,
    requested_model: request.model,
    model_display_name: modelDisplayName,
    provider_model_verified: providerModelVerified,
    remaining_requests: grant.remainingRequests,
  };
  if (returnedModel) response.returned_model = returnedModel;
  if (providerResponseId) response.provider_response_id = providerResponseId;
  return response;
}

export class InMemoryModelProxyRegistry {
  private readonly grants = new Map<string, StoredModelProxyGrant>();

  constructor(private readonly options: { now?: () => Date } = {}) {}

  private now() {
    return this.options.now || (() => new Date());
  }

  register(input: ModelProxyGrantInput): { delegationId: string; expiresAt: string; remainingRequests: number } {
    const delegationId = delegationIdFor(input.delegation);
    const maxRequests = input.maxRequests ?? input.delegation.max_requests ?? 1;
    if (maxRequests !== 1) throw new ModelProxyError("MODEL_PROXY_DELEGATION_SCOPE_INVALID", "Model proxy delegations must be scoped to exactly one request.", 400);
    if (!input.credential.ref) throw new ModelProxyError("MODEL_PROXY_CREDENTIAL_MISSING", "Model proxy credential reference is missing.", 503);
    this.grants.set(delegationId, {
      ...input,
      ownerId: input.ownerId || "broker",
      delegationId,
      maxRequests,
      remainingRequests: maxRequests,
    });
    return { delegationId, expiresAt: input.expiresAt, remainingRequests: maxRequests };
  }

  get(delegationId: string): Omit<StoredModelProxyGrant, "credential"> | undefined {
    const grant = this.grants.get(delegationId);
    if (!grant) return undefined;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { credential: _credential, ...safeGrant } = grant;
    return { ...safeGrant };
  }

  revoke(delegationId: string, reason = "revoked"): void {
    const grant = this.grants.get(delegationId);
    if (!grant) return;
    grant.revokedAt = this.now()().toISOString();
    grant.remainingRequests = 0;
    void reason;
  }

  clear(): void {
    this.grants.clear();
  }

  async dispatch(body: unknown, caller: ModelProxyDispatchCaller = defaultProviderCallerRegistry): Promise<ModelProxyResponse> {
    const request = parseRequest(body);
    const grant = this.grants.get(request.delegation_id);
    if (!grant) throw new ModelProxyError("MODEL_PROXY_DELEGATION_NOT_FOUND", "Model proxy delegation was not found.", 404);
    assertGrantCanAttempt(grant, this.now());
    assertModelProxyDispatchRateLimit(grant);
    assertGrantMatchesRequest(grant, request);
    const providerCaller = providerCallerFor(grant.provider, caller);

    // Consume before calling the provider so replay cannot multiply spend if the child retries.
    grant.remainingRequests -= 1;
    grant.consumedAt = this.now()().toISOString();

    const result = await providerCaller({ request, credential: grant.credential, grant: { ...grant } });
    if (result.credentialUpdate !== undefined) {
      const nowIso = this.now()().toISOString();
      grant.credential = {
        ...grant.credential,
        value: result.credentialUpdate,
        revision: (grant.credential.revision || 1) + 1,
        updatedAt: nowIso,
      };
    }
    return providerResponseFromResult(request, grant, result);
  }
}

function toModelProxyError(error: unknown): ModelProxyError {
  const err = error as Error & { code?: string; status?: number; issues?: string[]; details?: unknown };
  if (err instanceof ModelProxyError) return err;
  return new ModelProxyError(err.code || "MODEL_PROXY_ERROR", err.message || "Model proxy request failed.", err.status || 500, err.issues || [], err.details);
}

export class StoreBackedModelProxyRegistry implements ModelProxyRegistry {
  constructor(private readonly options: { now?: () => Date } = {}) {}

  private now() {
    return this.options.now || (() => new Date());
  }

  async register(input: ModelProxyGrantInput): Promise<{ delegationId: string; expiresAt: string; remainingRequests: number }> {
    const delegationId = delegationIdFor(input.delegation);
    const maxRequests = input.maxRequests ?? input.delegation.max_requests ?? 1;
    if (maxRequests !== 1) throw new ModelProxyError("MODEL_PROXY_DELEGATION_SCOPE_INVALID", "Model proxy delegations must be scoped to exactly one request.", 400);
    if (!input.ownerId) throw new ModelProxyError("MODEL_PROXY_OWNER_MISSING", "Model proxy grant owner is missing.", 503);
    if (!input.credential.ref) throw new ModelProxyError("MODEL_PROXY_CREDENTIAL_MISSING", "Model proxy credential reference is missing.", 503);
    await registerModelProxyGrant({
      delegationId,
      runId: input.runId,
      ownerId: input.ownerId,
      agentConnectionId: input.agentConnectionId,
      provider: input.provider,
      allowedModel: input.allowedModel,
      allowedRequestClass: input.allowedRequestClass,
      expiresAt: input.expiresAt,
      maxRequests,
      remainingRequests: maxRequests,
      credentialRef: input.credential.ref,
      maxSpendCents: input.maxSpendCents,
      createdAt: this.now()().toISOString(),
    });
    return { delegationId, expiresAt: input.expiresAt, remainingRequests: maxRequests };
  }

  async get(_delegationId: string): Promise<undefined> {
    return undefined;
  }

  async revoke(delegationId: string, reason = "revoked"): Promise<void> {
    await revokeModelProxyGrant({ delegationId, reason });
  }

  async dispatch(body: unknown, caller: ModelProxyDispatchCaller = defaultProviderCallerRegistry): Promise<ModelProxyResponse> {
    const request = parseRequest(body);
    const providerCaller = providerCallerFor(request.provider, caller);
    let consumed: Awaited<ReturnType<typeof consumeModelProxyGrant>>;
    try {
      consumed = await consumeModelProxyGrant({
        delegationId: request.delegation_id,
        runId: request.run_id,
        agentConnectionId: request.agent_connection_id,
        provider: request.provider,
        model: request.model,
        requestClass: request.request_class,
        nowIso: this.now()().toISOString(),
      });
    } catch (error) {
      throw toModelProxyError(error);
    }

    const storedGrant = {
      runId: consumed.grant.runId,
      ownerId: consumed.grant.ownerId,
      delegation: {
        connection_id: consumed.grant.agentConnectionId,
        agent_connection_id: consumed.grant.agentConnectionId,
        delegation_id: consumed.grant.delegationId,
        provider: consumed.grant.provider,
        allowed_model: consumed.grant.allowedModel,
        allowed_request_class: consumed.grant.allowedRequestClass,
        expires_at: consumed.grant.expiresAt,
        max_requests: consumed.grant.maxRequests,
        max_spend_cents: consumed.grant.maxSpendCents,
      },
      agentConnectionId: consumed.grant.agentConnectionId,
      provider: consumed.grant.provider,
      allowedModel: consumed.grant.allowedModel,
      allowedRequestClass: consumed.grant.allowedRequestClass,
      expiresAt: consumed.grant.expiresAt,
      maxRequests: consumed.grant.maxRequests,
      maxSpendCents: consumed.grant.maxSpendCents,
      credential: consumed.credential,
      delegationId: consumed.grant.delegationId,
      remainingRequests: consumed.grant.remainingRequests,
      consumedAt: consumed.grant.consumedAt,
      revokedAt: consumed.grant.revokedAt,
    } satisfies StoredModelProxyGrant;

    let result: ModelProxyProviderResult;
    try {
      result = await providerCaller({ request, credential: consumed.credential, grant: storedGrant });
    } catch (error) {
      const code = error instanceof ModelProxyError ? error.code : undefined;
      if (consumed.grant.provider === "codex" && (code === "MODEL_PROXY_CODEX_AUTH_FAILED" || code === "MODEL_PROXY_CODEX_SESSION_INVALID")) {
        await markAgentConnectionNeedsReconnect({
          ownerId: consumed.grant.ownerId,
          connectionId: consumed.grant.agentConnectionId,
          reason: "Codex ChatGPT authentication expired or was revoked. Reconnect Codex before the next run.",
        });
      }
      if (consumed.grant.provider === "claude_code" && (code === "MODEL_PROXY_CLAUDE_CODE_AUTH_FAILED" || code === "MODEL_PROXY_CLAUDE_CODE_SESSION_INVALID")) {
        await markAgentConnectionNeedsReconnect({
          ownerId: consumed.grant.ownerId,
          connectionId: consumed.grant.agentConnectionId,
          reason: "Claude Code authentication expired or was revoked. Reconnect Claude Code before the next run.",
        });
      }
      throw error;
    }
    if (result.credentialUpdate !== undefined) {
      await replaceAgentConnectionCredential({
        ownerId: consumed.grant.ownerId,
        connectionId: consumed.grant.agentConnectionId,
        expectedRevision: consumed.credential.revision || 1,
        value: result.credentialUpdate,
      });
    }
    return providerResponseFromResult(request, storedGrant, result);
  }
}

const defaultRegistry = new InMemoryModelProxyRegistry();
const defaultStoreBackedRegistry = new StoreBackedModelProxyRegistry();

export function defaultModelProxyRegistry(): InMemoryModelProxyRegistry {
  return defaultRegistry;
}

export function activeModelProxyRegistry(): ModelProxyRegistry {
  return modelProxyGrantStore(loadEnv(process.env)) === "broker_state" ? defaultStoreBackedRegistry : defaultRegistry;
}

export function resetDefaultModelProxyRegistryForTests(): void {
  defaultRegistry.clear();
}

export async function executeDefaultModelProxyRequest(body: unknown): Promise<ModelProxyResponse> {
  return activeModelProxyRegistry().dispatch(body);
}

export async function callOpenRouterModelProxy(input: { request: ModelProxyRequest; credential: AgentCredentialRecord }): Promise<ModelProxyProviderResult> {
  const apiKey = openRouterApiKey(input.credential);
  if (!apiKey) throw new ModelProxyError("MODEL_PROXY_CREDENTIAL_MISSING", "OpenRouter broker credential is not configured.", 503);

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      "http-referer": process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
      "x-title": "Challenge My AI",
    },
    body: JSON.stringify({
      model: input.request.model,
      messages: input.request.messages,
      response_format: input.request.response_format === "json_object" ? { type: "json_object" } : undefined,
    }),
  });

  if (!response.ok) {
    throw new ModelProxyError("MODEL_PROXY_PROVIDER_ERROR", "OpenRouter model proxy request failed.", 502);
  }

  const json = await response.json() as {
    id?: string;
    model?: string;
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = json.choices?.[0]?.message?.content;
  if (!content) throw new ModelProxyError("MODEL_PROXY_PROVIDER_EMPTY_RESPONSE", "OpenRouter model proxy response did not include content.", 502);

  return {
    content,
    provider: "openrouter",
    requestedModel: input.request.model,
    returnedModel: json.model,
    modelDisplayName: json.model || input.request.model,
    providerResponseId: json.id,
    providerModelVerified: Boolean(json.model),
  };
}

export async function callAnthropicModelProxy(input: { request: ModelProxyRequest; credential: AgentCredentialRecord }): Promise<ModelProxyProviderResult> {
  const apiKey = anthropicApiKey(input.credential);
  const bearerToken = apiKey ? undefined : anthropicBearerToken(input.credential);
  if (!apiKey && !bearerToken) throw new ModelProxyError("MODEL_PROXY_CREDENTIAL_MISSING", "Anthropic broker credential is not configured.", 503);

  const system = input.request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n") || undefined;
  const messages = input.request.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role as "user" | "assistant", content: message.content }));
  if (messages.length === 0) {
    throw new ModelProxyError("MODEL_PROXY_BAD_REQUEST", "Anthropic model proxy request requires at least one user or assistant message.", 400);
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (apiKey) headers["x-api-key"] = apiKey;
  else if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: input.request.model,
      max_tokens: 4096,
      system,
      messages,
    }),
  });

  if (!response.ok) {
    throw new ModelProxyError("MODEL_PROXY_PROVIDER_ERROR", "Anthropic model proxy request failed.", 502);
  }

  const json = await response.json() as {
    id?: string;
    model?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
  const content = json.content?.filter((block) => block.type === "text" && block.text).map((block) => block.text).join("\n").trim();
  if (!content) throw new ModelProxyError("MODEL_PROXY_PROVIDER_EMPTY_RESPONSE", "Anthropic model proxy response did not include text content.", 502);

  return {
    content,
    provider: "anthropic",
    requestedModel: input.request.model,
    returnedModel: json.model,
    modelDisplayName: json.model || input.request.model,
    providerResponseId: json.id,
    providerModelVerified: Boolean(json.model),
  };
}

export async function callOpenAIModelProxy(input: { request: ModelProxyRequest; credential: AgentCredentialRecord }): Promise<ModelProxyProviderResult> {
  const apiKey = openAiApiKey(input.credential);
  const bearerToken = apiKey ? undefined : openAiBearerToken(input.credential);
  if (!apiKey && !bearerToken) throw new ModelProxyError("MODEL_PROXY_CREDENTIAL_MISSING", "OpenAI broker credential is not configured.", 503);

  const instructions = input.request.messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n") || undefined;
  const messages = input.request.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({ role: message.role as "user" | "assistant", content: message.content }));
  if (messages.length === 0) {
    throw new ModelProxyError("MODEL_PROXY_BAD_REQUEST", "OpenAI model proxy request requires at least one user or assistant message.", 400);
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey || bearerToken}`,
    },
    body: JSON.stringify({
      model: input.request.model,
      instructions,
      input: messages,
      max_output_tokens: 4096,
      store: false,
      text: input.request.response_format === "json_object" ? { format: { type: "json_object" } } : undefined,
    }),
  });

  if (!response.ok) {
    throw new ModelProxyError("MODEL_PROXY_PROVIDER_ERROR", "OpenAI model proxy request failed.", 502);
  }

  const json = await response.json() as {
    id?: string;
    model?: string;
    status?: string;
    output_text?: string;
    output?: Array<{ type?: string; role?: string; content?: Array<{ type?: string; text?: string; refusal?: string }> }>;
    incomplete_details?: { reason?: string };
  };
  if (json.status && json.status !== "completed") {
    const reason = json.incomplete_details?.reason ? ` (${json.incomplete_details.reason})` : "";
    throw new ModelProxyError("MODEL_PROXY_PROVIDER_INCOMPLETE_RESPONSE", `OpenAI model proxy response was not completed${reason}.`, 502);
  }
  const content = (json.output_text || json.output
    ?.filter((item) => item.type === "message" && item.role === "assistant")
    .flatMap((item) => item.content || [])
    .filter((block) => block.type === "output_text" && block.text)
    .map((block) => block.text)
    .join("\n") || "").trim();
  if (!content) throw new ModelProxyError("MODEL_PROXY_PROVIDER_EMPTY_RESPONSE", "OpenAI model proxy response did not include text content.", 502);

  return {
    content,
    provider: "openai",
    requestedModel: input.request.model,
    returnedModel: json.model,
    modelDisplayName: json.model || input.request.model,
    providerResponseId: json.id,
    providerModelVerified: Boolean(json.model),
  };
}


export async function callCodexSessionModelProxy(input: { request: ModelProxyRequest; credential: AgentCredentialRecord }): Promise<ModelProxyProviderResult> {
  const session = codexSessionCredential(input.credential);
  const result = await runCodexCliSession({
    authCache: session,
    model: input.request.model,
    prompt: codexPromptFromRequest(input.request),
  });
  return {
    content: result.content,
    provider: "codex",
    requestedModel: input.request.model,
    returnedModel: input.request.model,
    modelDisplayName: `${input.request.model} via ChatGPT plan`,
    providerModelVerified: false,
    credentialUpdate: result.refreshedAuthCache,
  };
}

export async function callClaudeCodeSessionModelProxy(input: { request: ModelProxyRequest; credential: AgentCredentialRecord }): Promise<ModelProxyProviderResult> {
  const credential = claudeCodeSessionCredential(input.credential);
  try {
    const result = await runClaudeCodeSession({
      credential,
      model: input.request.model,
      prompt: codexPromptFromRequest(input.request),
    });
    return {
      content: result.content,
      provider: "claude_code",
      requestedModel: input.request.model,
      returnedModel: result.returnedModel,
      modelDisplayName: result.returnedModel ? `${result.returnedModel} via Claude plan` : `${input.request.model} via Claude plan`,
      providerModelVerified: false,
      credentialUpdate: result.refreshedCredential,
    };
  } catch (error) {
    if (error instanceof ClaudeCodeCliError) {
      throw new ModelProxyError(
        error.code === "CLAUDE_CODE_AUTH_REQUIRED" ? "MODEL_PROXY_CLAUDE_CODE_AUTH_FAILED" : `MODEL_PROXY_${error.code}`,
        error.message,
        error.status,
      );
    }
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ModelProxyError("MODEL_PROXY_CLAUDE_CODE_CLI_UNAVAILABLE", "The official Claude Code CLI is not installed or executable on the broker host.", 503);
    }
    throw error;
  }
}

defaultProviderCallerRegistry.register("openrouter", callOpenRouterModelProxy);
defaultProviderCallerRegistry.register("anthropic", callAnthropicModelProxy);
defaultProviderCallerRegistry.register("openai", callOpenAIModelProxy);
defaultProviderCallerRegistry.register("codex", callCodexSessionModelProxy);
defaultProviderCallerRegistry.register("claude_code", callClaudeCodeSessionModelProxy);
