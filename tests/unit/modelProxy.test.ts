import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as modelProxyPost } from "@/app/api/agent-home/model-proxy/route";
import { InMemoryModelProxyRegistry, callClaudeCodeSessionModelProxy, defaultModelProxyRegistry, resetDefaultModelProxyRegistryForTests, type ModelProxyRequest } from "@/lib/agent-home/modelProxy";
import { resetRateLimitsForTests } from "@/lib/security/rateLimit";
import type { AgentConnectionDelegation } from "@/lib/types";

const fixedNow = new Date("2026-07-02T12:00:00.000Z");
const expiresAt = "2026-07-02T12:10:00.000Z";
const apiKey = "«redacted:sk-…»";
const anthropicKey = "anthropic-test-key";

const delegation: AgentConnectionDelegation = {
  delegation_id: "del_openrouter_once",
  connection_id: "conn_openrouter_1",
  agent_connection_id: "conn_openrouter_1",
  provider: "openrouter",
  allowed_model: "openai/gpt-4.1-mini",
  allowed_request_class: "contribution_card",
  expires_at: expiresAt,
  max_requests: 1,
};

function request(overrides: Partial<ModelProxyRequest> = {}): ModelProxyRequest {
  return {
    schema_version: "1.0",
    run_id: "run_openrouter_1",
    delegation_id: "del_openrouter_once",
    agent_connection_id: "conn_openrouter_1",
    provider: "openrouter",
    model: "openai/gpt-4.1-mini",
    request_class: "contribution_card",
    messages: [{ role: "user", content: "Return a contribution card." }],
    response_format: "json_object",
    ...overrides,
  };
}

function register(registry = new InMemoryModelProxyRegistry({ now: () => fixedNow }), expiresAtValue = expiresAt) {
  const scopedDelegation = { ...delegation, expires_at: expiresAtValue };
  registry.register({
    runId: "run_openrouter_1",
    delegation: scopedDelegation,
    agentConnectionId: "conn_openrouter_1",
    provider: "openrouter",
    allowedModel: "openai/gpt-4.1-mini",
    allowedRequestClass: "contribution_card",
    expiresAt: expiresAtValue,
    maxRequests: 1,
    credential: {
      ref: "cred_openrouter_1",
      provider: "openrouter",
      value: { apiKey },
      createdAt: fixedNow.toISOString(),
    },
  });
  return registry;
}

function registerProvider(options: { provider: string; model: string; credentialValue?: unknown; delegationId?: string; connectionId?: string }, registry = new InMemoryModelProxyRegistry({ now: () => fixedNow })) {
  const delegationId = options.delegationId || `del_${options.provider}_once`;
  const connectionId = options.connectionId || `conn_${options.provider}_1`;
  registry.register({
    runId: "run_openrouter_1",
    delegation: {
      delegation_id: delegationId,
      connection_id: connectionId,
      agent_connection_id: connectionId,
      provider: options.provider,
      allowed_model: options.model,
      allowed_request_class: "contribution_card",
      expires_at: expiresAt,
      max_requests: 1,
    },
    agentConnectionId: connectionId,
    provider: options.provider,
    allowedModel: options.model,
    allowedRequestClass: "contribution_card",
    expiresAt,
    maxRequests: 1,
    credential: {
      ref: `cred_${options.provider}_1`,
      provider: options.provider,
      value: options.credentialValue ?? { apiKey },
      createdAt: fixedNow.toISOString(),
    },
  });
  return { registry, delegationId, connectionId };
}

function providerRequest(options: { provider: string; model: string; delegationId?: string; connectionId?: string; messages?: ModelProxyRequest["messages"] }): ModelProxyRequest {
  return request({
    delegation_id: options.delegationId || `del_${options.provider}_once`,
    agent_connection_id: options.connectionId || `conn_${options.provider}_1`,
    provider: options.provider,
    model: options.model,
    messages: options.messages || request().messages,
  });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CMAI_ENFORCE_RATE_LIMITS;
  delete process.env.CMAI_CODEX_CLI_BIN;
  delete process.env.CMAI_CODEX_EXEC_TIMEOUT_MS;
  delete process.env.CMAI_CLAUDE_CODE_EXECUTABLE;
  delete process.env.CMAI_SERVER_SECRET_SENTINEL;
  resetDefaultModelProxyRegistryForTests();
  resetRateLimitsForTests();
});

describe("Agent Home model proxy", () => {
  it("dispatches one scoped provider request without exposing broker credentials", async () => {
    const registry = register();
    const providerCall = vi.fn(async () => ({
      content: "{\"ok\":true}",
      provider: "openrouter",
      requestedModel: "openai/gpt-4.1-mini",
      returnedModel: "openai/gpt-4.1-mini",
      modelDisplayName: "openai/gpt-4.1-mini",
      providerResponseId: "gen_123",
      providerModelVerified: true,
    }));

    const response = await registry.dispatch(request(), providerCall);

    expect(response).toMatchObject({
      ok: true,
      provider: "openrouter",
      requested_model: "openai/gpt-4.1-mini",
      returned_model: "openai/gpt-4.1-mini",
      provider_response_id: "gen_123",
      provider_model_verified: true,
      remaining_requests: 0,
    });
    expect(providerCall).toHaveBeenCalledTimes(1);
    const publicGrant = registry.get("del_openrouter_once");
    expect(JSON.stringify(publicGrant)).not.toContain(apiKey);
    expect(JSON.stringify(response)).not.toContain(apiKey);
    await expect(registry.dispatch(request(), providerCall)).rejects.toMatchObject({ code: "MODEL_PROXY_DELEGATION_CONSUMED" });
    expect(providerCall).toHaveBeenCalledTimes(1);
  });

  it("rejects run/model/request-class mismatches before provider fetch", async () => {
    const registry = register();
    const providerCall = vi.fn();

    await expect(registry.dispatch(request({ run_id: "run_wrong" }), providerCall)).rejects.toMatchObject({ code: "MODEL_PROXY_RUN_MISMATCH" });
    await expect(registry.dispatch(request({ model: "anthropic/claude-sonnet-4" }), providerCall)).rejects.toMatchObject({ code: "MODEL_PROXY_MODEL_MISMATCH" });
    await expect(registry.dispatch(request({ request_class: "red_team" }), providerCall)).rejects.toMatchObject({ code: "MODEL_PROXY_REQUEST_CLASS_MISMATCH" });
    expect(providerCall).not.toHaveBeenCalled();
  });

  it("rate-limits repeated model-scope mismatches for one in-memory delegation before provider fetch", async () => {
    process.env.CMAI_ENFORCE_RATE_LIMITS = "1";
    const registry = register();
    const providerCall = vi.fn();
    const badModel = request({ model: "anthropic/claude-sonnet-4" });

    for (let index = 0; index < 3; index += 1) {
      await expect(registry.dispatch(badModel, providerCall)).rejects.toMatchObject({ code: "MODEL_PROXY_MODEL_MISMATCH" });
    }
    await expect(registry.dispatch(badModel, providerCall)).rejects.toMatchObject({ code: "MODEL_PROXY_RATE_LIMITED", status: 429 });
    expect(providerCall).not.toHaveBeenCalled();
    expect(registry.get("del_openrouter_once")).toMatchObject({ remainingRequests: 1 });
  });

  it("rejects expired grants before provider fetch", async () => {
    const registry = new InMemoryModelProxyRegistry({ now: () => new Date("2026-07-02T12:11:00.000Z") });
    register(registry);
    const providerCall = vi.fn();

    await expect(registry.dispatch(request(), providerCall)).rejects.toMatchObject({ code: "MODEL_PROXY_DELEGATION_EXPIRED" });
    expect(providerCall).not.toHaveBeenCalled();
  });

  it("model-proxy route calls OpenRouter broker-side and never echoes the API key", async () => {
    register(defaultModelProxyRegistry(), "2099-07-02T12:10:00.000Z");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${apiKey}` });
      expect(init?.body?.toString()).toContain("openai/gpt-4.1-mini");
      return new Response(JSON.stringify({
        id: "openrouter_resp_1",
        model: "openai/gpt-4.1-mini",
        choices: [{ message: { content: "{\"schema_version\":\"1.0\"}" } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await modelProxyPost(new Request("http://test.local/api/agent-home/model-proxy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request()),
    }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      ok: true,
      provider: "openrouter",
      requested_model: "openai/gpt-4.1-mini",
      returned_model: "openai/gpt-4.1-mini",
      provider_response_id: "openrouter_resp_1",
      provider_model_verified: true,
      remaining_requests: 0,
    });
    expect(JSON.stringify(json)).not.toContain(apiKey);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const replay = await modelProxyPost(new Request("http://test.local/api/agent-home/model-proxy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request()),
    }));
    expect(replay.status).toBe(409);
    expect(await replay.json()).toMatchObject({ code: "MODEL_PROXY_DELEGATION_CONSUMED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("routes Anthropic grants through the Messages API caller and maps response metadata", async () => {
    const model = "claude-sonnet-4-20250514";
    const { registry, delegationId, connectionId } = registerProvider({ provider: "anthropic", model, credentialValue: { apiKey: anthropicKey } });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(_input.toString()).toBe("https://api.anthropic.com/v1/messages");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ "x-api-key": anthropicKey, "anthropic-version": "2023-06-01" });
      const body = JSON.parse(init?.body?.toString() || "{}") as { model?: string; max_tokens?: number; messages?: Array<{ role: string; content: string }> };
      expect(body).toMatchObject({ model, max_tokens: 4096 });
      expect(body.messages).toEqual([{ role: "user", content: "Return a contribution card." }]);
      return new Response(JSON.stringify({
        id: "msg_anthropic_1",
        model,
        content: [{ type: "text", text: "{\"schema_version\":\"1.0\"}" }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await registry.dispatch(providerRequest({ provider: "anthropic", model, delegationId, connectionId }));

    expect(response).toMatchObject({
      ok: true,
      provider: "anthropic",
      requested_model: model,
      returned_model: model,
      provider_response_id: "msg_anthropic_1",
      provider_model_verified: true,
      remaining_requests: 0,
    });
    expect(JSON.stringify(response)).not.toContain(anthropicKey);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("routes OpenAI Responses API grants through the Responses API caller and maps response metadata", async () => {
    const model = "gpt-5.6-sol";
    const openAiKey = "sk-openai-secret";
    const { registry, delegationId, connectionId } = registerProvider({ provider: "openai", model, credentialValue: { apiKey: openAiKey } });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(_input.toString()).toBe("https://api.openai.com/v1/responses");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${openAiKey}` });
      const body = JSON.parse(init?.body?.toString() || "{}") as { model?: string; instructions?: string; max_output_tokens?: number; store?: boolean; text?: { format?: { type?: string } }; input?: Array<{ role: string; content: string }> };
      expect(body).toMatchObject({ model, instructions: "Stay inside the contribution-card schema.", max_output_tokens: 4096, store: false, text: { format: { type: "json_object" } } });
      expect(body.input).toEqual([{ role: "user", content: "Return a contribution card." }]);
      return new Response(JSON.stringify({
        id: "resp_openai_1",
        model,
        status: "completed",
        output_text: "{\"schema_version\":\"1.0\"}",
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const response = await registry.dispatch(providerRequest({ provider: "openai", model, delegationId, connectionId, messages: [
      { role: "system", content: "Stay inside the contribution-card schema." },
      { role: "user", content: "Return a contribution card." },
    ] }));

    expect(response).toMatchObject({
      ok: true,
      provider: "openai",
      requested_model: model,
      returned_model: model,
      provider_response_id: "resp_openai_1",
      provider_model_verified: true,
      remaining_requests: 0,
    });
    expect(JSON.stringify(response)).not.toContain(openAiKey);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("seeds Codex-managed auth, preserves CLI refreshes, and never exposes session material", async () => {
    const model = "gpt-5.6-sol";
    const codexDir = await mkdtemp(join(tmpdir(), "cmai-fake-codex-"));
    const fakeCodex = join(codexDir, "codex");
    const observedAuth = join(codexDir, "observed-auth.json");
    const observedArgs = join(codexDir, "observed-args.txt");
    const observedEnv = join(codexDir, "observed-env.txt");
    const outputCard = JSON.stringify({ schema_version: "1.0", challenge_id: "challenge-codex", contribution_mode: "critique" }).replace(/'/g, "'\\''");
    await writeFile(fakeCodex, `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--version" ]; then
  echo "codex fake 0.0.0"
  exit 0
fi
if [ "\${1:-}" = "login" ]; then
  exit 77
fi
if [ "\${1:-}" = "exec" ]; then
  printf '%s\n' "$@" > "${observedArgs}"
  env | sort > "${observedEnv}"
  cp "$CODEX_HOME/auth.json" "${observedAuth}"
  python - "$CODEX_HOME/auth.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["tokens"]["refresh_token"] = "codex-refresh-token-rotated-123456789"
d["last_refresh"] = "2026-07-11T14:00:00.000Z"
json.dump(d, open(p, "w"))
PY
  output=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--output-last-message" ]; then
      shift
      output="$1"
    fi
    shift || true
  done
  mkdir -p "$(dirname "$output")"
  printf '%s' '${outputCard}' > "$output"
  echo '{"event":"fake_codex_exec_done"}'
  exit 0
fi
exit 9
`, "utf8");
    await chmod(fakeCodex, 0o755);
    process.env.CMAI_CODEX_CLI_BIN = fakeCodex;
    process.env.CMAI_CODEX_EXEC_TIMEOUT_MS = "10000";
    process.env.CMAI_SERVER_SECRET_SENTINEL = "must-not-reach-codex";

    try {
      const { registry, delegationId, connectionId } = registerProvider({
        provider: "codex",
        model,
        credentialValue: {
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: {
            id_token: "codex-id-token-fixture-123456789",
            access_token: "codex-access-token-fixture-123456789",
            refresh_token: "codex-refresh-token-fixture-123456789",
            account_id: "acct_codex_fixture_123456789",
          },
          last_refresh: "2026-07-11T13:00:00.000Z",
        },
      });

      const response = await registry.dispatch(providerRequest({ provider: "codex", model, delegationId, connectionId }));

      expect(response).toMatchObject({
        ok: true,
        provider: "codex",
        requested_model: model,
        returned_model: model,
        model_display_name: "gpt-5.6-sol via ChatGPT plan",
        provider_model_verified: false,
        remaining_requests: 0,
      });
      expect(response.content).toContain("challenge-codex");
      expect(JSON.stringify(response)).not.toContain("codex-access-token-fixture");
      expect(JSON.stringify(response)).not.toContain("codex-refresh-token-rotated");
      const seeded = JSON.parse(await readFile(observedAuth, "utf8")) as { auth_mode: string; tokens: { refresh_token: string } };
      expect(seeded).toMatchObject({ auth_mode: "chatgpt", tokens: { refresh_token: "codex-refresh-token-fixture-123456789" } });
      const argv = (await readFile(observedArgs, "utf8")).trim().split("\n");
      expect(argv).toEqual(expect.arrayContaining([
        "--strict-config",
        "--ignore-user-config",
        "--ignore-rules",
        'approval_policy="never"',
        "shell_tool",
        "browser_use",
        "computer_use",
        "--ephemeral",
      ]));
      expect(argv).not.toContain("--ask-for-approval");
      const subprocessEnv = await readFile(observedEnv, "utf8");
      expect(subprocessEnv).toContain("CODEX_HOME=");
      expect(subprocessEnv).not.toContain("CMAI_SERVER_SECRET_SENTINEL");
      expect(subprocessEnv).not.toContain("must-not-reach-codex");
      await expect(registry.dispatch(providerRequest({ provider: "codex", model, delegationId, connectionId }))).rejects.toMatchObject({ code: "MODEL_PROXY_DELEGATION_CONSUMED" });
    } finally {
      await rm(codexDir, { recursive: true, force: true });
    }
  });

  it("runs official Claude Code print mode, persists refresh output, and scrubs broker secrets", async () => {
    const claudeDir = await mkdtemp(join(tmpdir(), "cmai-fake-claude-proxy-"));
    const fakeClaude = join(claudeDir, "claude.cjs");
    const observedCredential = join(claudeDir, "observed-credential.json");
    const observedArgs = join(claudeDir, "observed-args.json");
    const observedEnv = join(claudeDir, "observed-env.json");
    const observedPrompt = join(claudeDir, "observed-prompt.txt");
    const initialCredential = {
      claudeAiOauth: {
        accessToken: "claude-proxy-access-token-fixture-123456",
        refreshToken: "claude-proxy-refresh-token-fixture-123456",
        expiresAt: Date.parse("2030-01-01T00:00:00.000Z"),
        subscriptionType: "max",
      },
    };
    await writeFile(fakeClaude, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.copyFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"), ${JSON.stringify(observedCredential)});
fs.writeFileSync(${JSON.stringify(observedArgs)}, JSON.stringify(process.argv.slice(2)));
fs.writeFileSync(${JSON.stringify(observedEnv)}, JSON.stringify(process.env));
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk.toString(); });
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(observedPrompt)}, prompt);
  const credentialPath = path.join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json");
  const credential = JSON.parse(fs.readFileSync(credentialPath, "utf8"));
  credential.claudeAiOauth.accessToken = "claude-proxy-access-token-rotated-123456";
  credential.claudeAiOauth.refreshToken = "claude-proxy-refresh-token-rotated-123456";
  fs.writeFileSync(credentialPath, JSON.stringify(credential));
  process.stdout.write(JSON.stringify({ type: "result", result: "{\\\"schema_version\\\":\\\"1.0\\\"}", is_error: false, modelUsage: { "claude-sonnet-4-6": { inputTokens: 1 } } }));
});
`, { mode: 0o755 });
    await chmod(fakeClaude, 0o755);
    process.env.CMAI_CLAUDE_CODE_EXECUTABLE = fakeClaude;
    process.env.CMAI_SERVER_SECRET_SENTINEL = "must-not-reach-claude";

    try {
      const request = providerRequest({ provider: "claude_code", model: "sonnet" });
      const result = await callClaudeCodeSessionModelProxy({
        request,
        credential: { ref: "cred_claude_proxy", provider: "claude_code", value: initialCredential, createdAt: fixedNow.toISOString(), revision: 1 },
      });

      expect(result).toMatchObject({
        content: '{"schema_version":"1.0"}',
        provider: "claude_code",
        requestedModel: "sonnet",
        returnedModel: "claude-sonnet-4-6",
        providerModelVerified: false,
        credentialUpdate: { claudeAiOauth: { refreshToken: "claude-proxy-refresh-token-rotated-123456" } },
      });
      expect(JSON.stringify(result)).not.toContain("claude-proxy-access-token-fixture");
      const seeded = JSON.parse(await readFile(observedCredential, "utf8")) as typeof initialCredential;
      expect(seeded).toEqual(initialCredential);
      const args = JSON.parse(await readFile(observedArgs, "utf8")) as string[];
      expect(args).toEqual(expect.arrayContaining(["-p", "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands", "--no-chrome", "--tools", "--model", "sonnet"]));
      expect(args).not.toContain("must-not-reach-claude");
      const subprocessEnv = JSON.parse(await readFile(observedEnv, "utf8")) as Record<string, string>;
      expect(subprocessEnv.CLAUDE_CONFIG_DIR).toBeTruthy();
      expect(subprocessEnv.CMAI_SERVER_SECRET_SENTINEL).toBeUndefined();
      expect(await readFile(observedPrompt, "utf8")).toContain("Return a contribution card");
    } finally {
      await rm(claudeDir, { recursive: true, force: true });
    }
  });

  it("fails unknown provider grants without provider fetch", async () => {
    const { registry, delegationId, connectionId } = registerProvider({ provider: "custom", model: "custom-model" });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(registry.dispatch(providerRequest({ provider: "custom", model: "custom-model", delegationId, connectionId }))).rejects.toMatchObject({ code: "MODEL_PROXY_PROVIDER_UNAVAILABLE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rate-limits repeated model-proxy dispatch attempts before provider resolution", async () => {
    process.env.CMAI_ENFORCE_RATE_LIMITS = "1";
    const { registry, delegationId, connectionId } = registerProvider({ provider: "custom", model: "custom-model" });
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const scopedRequest = providerRequest({ provider: "custom", model: "custom-model", delegationId, connectionId });

    for (let index = 0; index < 3; index += 1) {
      await expect(registry.dispatch(scopedRequest)).rejects.toMatchObject({ code: "MODEL_PROXY_PROVIDER_UNAVAILABLE" });
    }

    await expect(registry.dispatch(scopedRequest)).rejects.toMatchObject({
      code: "MODEL_PROXY_RATE_LIMITED",
      status: 429,
      details: { policy: "model_proxy_dispatch", limit: 3, retryAfterMs: expect.any(Number) },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(JSON.stringify(registry.get(delegationId))).not.toContain(apiKey);
  });

  it("rejects provider caller scope mismatches after consumption without returning forged metadata", async () => {
    const registry = register();
    const providerCall = vi.fn(async () => ({
      content: "{\"ok\":true}",
      provider: "anthropic",
      requestedModel: "claude-sonnet-4-20250514",
      returnedModel: "claude-sonnet-4-20250514",
      modelDisplayName: "Forged model",
      providerResponseId: "forged_resp_1",
      providerModelVerified: true,
    }));

    await expect(registry.dispatch(request(), providerCall)).rejects.toMatchObject({ code: "MODEL_PROXY_PROVIDER_SCOPE_MISMATCH" });
    expect(registry.get("del_openrouter_once")).toMatchObject({ remainingRequests: 0 });
    await expect(registry.dispatch(request(), providerCall)).rejects.toMatchObject({ code: "MODEL_PROXY_DELEGATION_CONSUMED" });
    expect(providerCall).toHaveBeenCalledTimes(1);
  });

  it("does not mark caller output as provider-verified without returned model or response id evidence", async () => {
    const registry = register();
    const providerCall = vi.fn(async () => ({
      content: "{\"ok\":true}",
      provider: "openrouter",
      requestedModel: "openai/gpt-4.1-mini",
      providerModelVerified: true,
    }));

    const response = await registry.dispatch(request(), providerCall);

    expect(response).toMatchObject({
      ok: true,
      provider: "openrouter",
      requested_model: "openai/gpt-4.1-mini",
      provider_model_verified: false,
      remaining_requests: 0,
    });
    expect(response).not.toHaveProperty("provider_response_id");
    expect(response).not.toHaveProperty("returned_model");
  });

  it("consumes Anthropic one-run grants before provider errors so retries cannot multiply spend", async () => {
    const model = "claude-sonnet-4-20250514";
    const { registry, delegationId, connectionId } = registerProvider({ provider: "anthropic", model, credentialValue: { apiKey: anthropicKey } });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: "provider down" } }), { status: 429, headers: { "content-type": "application/json" } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(registry.dispatch(providerRequest({ provider: "anthropic", model, delegationId, connectionId }))).rejects.toMatchObject({ code: "MODEL_PROXY_PROVIDER_ERROR" });
    expect(registry.get(delegationId)).toMatchObject({ remainingRequests: 0 });
    await expect(registry.dispatch(providerRequest({ provider: "anthropic", model, delegationId, connectionId }))).rejects.toMatchObject({ code: "MODEL_PROXY_DELEGATION_CONSUMED" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
