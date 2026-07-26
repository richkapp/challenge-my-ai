import { beforeEach, describe, expect, it } from "vitest";
import { agentHomePayload, GET as agentHomeGet } from "@/app/api/agent-home/route";
import { GET as connectionsGet, POST as connectionsPost } from "@/app/api/agent-home/connections/route";
import { PATCH as connectionPatch } from "@/app/api/agent-home/connections/[id]/route";
import { POST as smokePost } from "@/app/api/agent-home/connections/[id]/smoke/route";
import { createAgentHomeConnection, recordAgentConnectionSmoke, resetStoreForTests } from "@/lib/store";

function request(url: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return new Request(url, {
    method: options.method || (options.body === undefined ? "GET" : "POST"),
    headers: {
      "content-type": "application/json",
      "x-cmai-user-id": "user-agent-home",
      "x-cmai-user-name": "Agent Home User",
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function anonymousRequest(url: string, body?: unknown) {
  return new Request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createConnection() {
  const response = await connectionsPost(request("http://test.local/api/agent-home/connections", { body: { provider: "local_fake", displayLabel: "Unit Test Agent" } }));
  expect(response.status).toBe(201);
  return await response.json();
}

const codexAuthCache = {
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: {
    id_token: "codex-id-token-fixture-123456",
    access_token: "codex-access-token-fixture-123456",
    refresh_token: "codex-refresh-token-fixture-123456",
    account_id: "acct_codex_fixture_123456",
  },
  last_refresh: "2026-07-11T13:00:00.000Z",
};

describe("Agent Home API", () => {
  beforeEach(async () => {
    await resetStoreForTests();
  });

  it("returns an authenticated user's empty Agent Home with manual fallback copy", async () => {
    const response = await agentHomeGet(request("http://test.local/api/agent-home"));
    expect(response.status).toBe(200);
    const json = await response.json();

    expect(json.agentHome).toMatchObject({ ownerId: "user-agent-home", ownerLabel: "Agent Home User", setupStatus: "setup_required", connections: [] });
    expect(json.readiness).toMatchObject({
      canRunHere: false,
      manualPasteFallback: expect.stringContaining("Copy prompt"),
      message: expect.stringContaining("Agent Home needs a provider connection"),
    });
  });

  it("creates and lists a setup-needed fake provider connection", async () => {
    const created = await createConnection();
    expect(created.connection).toMatchObject({ displayLabel: "Unit Test Agent", provider: "local_fake", status: "setup_required", exactModelMetadata: false });
    expect(created.connection.allowedRequestClasses).toEqual(["critique", "red_team", "alternate_proposal", "risk_audit", "steelman"]);
    expect(created.connection.allowedRequestClasses).not.toContain("judge");
    expect(JSON.stringify(created.connection)).not.toMatch(/api_key|refresh_token|DATABASE_URL/i);

    const listed = await connectionsGet(request("http://test.local/api/agent-home/connections"));
    expect(listed.status).toBe(200);
    const listedJson = await listed.json();
    expect(listedJson.connections).toEqual([expect.objectContaining({ id: created.connection.id, readiness: expect.objectContaining({ canRunHere: false }) })]);
  });

  it("accepts real provider metadata without marking the connection trusted before smoke", async () => {
    const response = await connectionsPost(request("http://test.local/api/agent-home/connections", {
      body: {
        provider: "openrouter",
        displayLabel: "OpenRouter Agent",
        defaultModel: "anthropic/claude-sonnet-4",
        allowedModels: ["anthropic/claude-sonnet-4"],
        allowedRequestClasses: ["critique"],
      },
    }));
    expect(response.status).toBe(201);
    const json = await response.json();
    expect(json.connection).toMatchObject({
      provider: "openrouter",
      providerLabel: "OpenRouter",
      connectionKind: "provider_key",
      status: "setup_required",
      defaultModel: "anthropic/claude-sonnet-4",
      allowedModels: ["anthropic/claude-sonnet-4"],
      allowedRequestClasses: ["critique"],
      authClass: "api_only",
      countsForMvpUserPlan: false,
      readiness: expect.objectContaining({ canRunHere: false }),
      setupInstructions: expect.stringContaining("broker-side"),
    });
    expect(JSON.stringify(json.connection)).not.toMatch(/api_key|refresh_token|DATABASE_URL/i);
  });

  it("requires official Codex device login and rejects every direct credential-import path", async () => {
    const routeOnlyBodies = [
      { provider: "codex", displayLabel: "Codex Plan Agent" },
      { provider: "codex", displayLabel: "Codex Plan Agent", providerSecret: "«redacted:sk-…»" },
    ];

    for (const body of routeOnlyBodies) {
      const response = await connectionsPost(request("http://test.local/api/agent-home/connections", { body }));
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "codex_device_login_required" });
    }

    for (const codexSession of [codexAuthCache, { apiKey: "not-a-codex-auth-cache" }]) {
      const imported = await connectionsPost(request("http://test.local/api/agent-home/connections", {
        body: { provider: "codex", displayLabel: "Codex Plan Agent", codexSession },
      }));
      expect(imported.status).toBe(422);
      const importedJson = await imported.json();
      expect(importedJson).toMatchObject({ code: "invalid_schema" });
      expect(JSON.stringify(importedJson)).not.toContain("codex-access-token-fixture");
      expect(JSON.stringify(importedJson)).not.toContain("«redacted:sk-…»");
    }
  });

  it("requires official Claude Code login and rejects direct credential imports", async () => {
    for (const body of [
      { provider: "claude_code", displayLabel: "Claude Plan Agent" },
      { provider: "claude_code", displayLabel: "Claude Plan Agent", providerSecret: "sk-ant-api03-not-accepted" },
    ]) {
      const response = await connectionsPost(request("http://test.local/api/agent-home/connections", { body }));
      expect(response.status).toBe(409);
      const json = await response.json();
      expect(json).toMatchObject({ code: "claude_code_login_required" });
      expect(JSON.stringify(json)).not.toContain("sk-ant-api03-not-accepted");
    }
  });

  it("stores and smokes Anthropic broker access without exposing credentials or proxy URLs", async () => {
    const previousModelProxyUrl = process.env.CMAI_MODEL_PROXY_URL;
    process.env.CMAI_MODEL_PROXY_URL = "https://broker.internal.example/api/agent-home/model-proxy";
    try {
      const created = await connectionsPost(request("http://test.local/api/agent-home/connections", {
        body: {
          provider: "anthropic",
          displayLabel: "Anthropic Agent",
          providerSecret: "anthropic-secret-key",
          defaultModel: "claude-sonnet-4-20250514",
          allowedModels: ["claude-sonnet-4-20250514"],
          allowedRequestClasses: ["critique"],
        },
      }));
      expect(created.status).toBe(201);
      const createdJson = await created.json();
      expect(createdJson.connection).toMatchObject({
        provider: "anthropic",
        providerLabel: "Anthropic",
        exactModelMetadata: true,
        metadataVerification: "metadata_verified",
        liveModelProxyCaller: true,
        providerReadiness: "live_broker_caller",
        authClass: "api_only",
        countsForMvpUserPlan: false,
        brokerCredentialAvailable: true,
        readiness: expect.objectContaining({ canRunHere: false }),
      });

      const smoke = await smokePost(request(`http://test.local/api/agent-home/connections/${createdJson.connection.id}/smoke`, { body: {} }), { params: Promise.resolve({ id: createdJson.connection.id }) });
      expect(smoke.status).toBe(200);
      const smokeJson = await smoke.json();
      expect(smokeJson.connection).toMatchObject({
        status: "ready",
        readiness: expect.objectContaining({ canRunHere: false, label: "API-only scaffold ready" }),
        lastSmoke: expect.objectContaining({ status: "passed", message: "Anthropic broker credential and model proxy URL are configured." }),
      });
      expect(smokeJson.agentHome).toMatchObject({ setupStatus: "setup_required" });
      const serialized = JSON.stringify(smokeJson);
      expect(serialized).not.toContain("anthropic-secret-key");
      expect(serialized).not.toContain("broker.internal.example");
    } finally {
      if (previousModelProxyUrl === undefined) delete process.env.CMAI_MODEL_PROXY_URL;
      else process.env.CMAI_MODEL_PROXY_URL = previousModelProxyUrl;
    }
  });

  it("stores and smokes OpenAI Responses API access without exposing credentials or proxy URLs", async () => {
    const previousModelProxyUrl = process.env.CMAI_MODEL_PROXY_URL;
    process.env.CMAI_MODEL_PROXY_URL = "https://broker.internal.example/api/agent-home/model-proxy";
    try {
      const created = await connectionsPost(request("http://test.local/api/agent-home/connections", {
        body: {
          provider: "openai",
          displayLabel: "OpenAI Responses API Agent",
          providerSecret: "sk-openai-secret",
          defaultModel: "gpt-5.6-sol",
          allowedModels: ["gpt-5.6-sol"],
          allowedRequestClasses: ["critique"],
        },
      }));
      expect(created.status).toBe(201);
      const createdJson = await created.json();
      expect(createdJson.connection).toMatchObject({
        provider: "openai",
        providerLabel: "OpenAI Responses API",
        exactModelMetadata: true,
        metadataVerification: "metadata_verified",
        liveModelProxyCaller: true,
        providerReadiness: "live_broker_caller",
        authClass: "api_only",
        countsForMvpUserPlan: false,
        brokerCredentialAvailable: true,
        readiness: expect.objectContaining({ canRunHere: false }),
      });

      const smoke = await smokePost(request(`http://test.local/api/agent-home/connections/${createdJson.connection.id}/smoke`, { body: {} }), { params: Promise.resolve({ id: createdJson.connection.id }) });
      expect(smoke.status).toBe(200);
      const smokeJson = await smoke.json();
      expect(smokeJson.connection).toMatchObject({
        status: "ready",
        readiness: expect.objectContaining({ canRunHere: false, label: "API-only scaffold ready" }),
        lastSmoke: expect.objectContaining({ status: "passed", message: "OpenAI broker credential and model proxy URL are configured." }),
      });
      expect(smokeJson.agentHome).toMatchObject({ setupStatus: "setup_required" });
      const serialized = JSON.stringify(smokeJson);
      expect(serialized).not.toContain("sk-openai-secret");
      expect(serialized).not.toContain("broker.internal.example");
    } finally {
      if (previousModelProxyUrl === undefined) delete process.env.CMAI_MODEL_PROXY_URL;
      else process.env.CMAI_MODEL_PROXY_URL = previousModelProxyUrl;
    }
  });

  it("does not advertise unsupported stale provider connections as runnable", async () => {
    const created = await connectionsPost(request("http://test.local/api/agent-home/connections", {
      body: { provider: "gemini", providerSecret: "gemini-secret-key", defaultModel: "gemini-2.5-flash", allowedModels: ["gemini-2.5-flash"], allowedRequestClasses: ["critique"] },
    }));
    const createdJson = await created.json();
    const stale = await recordAgentConnectionSmoke({ ownerId: "user-agent-home", connectionId: createdJson.connection.id, ok: true, message: "Stale smoke pass from an older adapter." });

    expect(stale.connection).toMatchObject({
      status: "ready",
      liveModelProxyCaller: false,
      providerReadiness: "compliance_review",
      readiness: expect.objectContaining({ canRunHere: false, label: "Provider adapter pending" }),
    });
    expect(stale.agentHome).toMatchObject({ setupStatus: "setup_required" });
    expect(stale.connection.complianceCopy).toContain("Gemini remains fail-closed");
  });

  it("rejects anonymous mutations and malformed provider payloads", async () => {
    const anonymous = await connectionsPost(anonymousRequest("http://test.local/api/agent-home/connections", { provider: "local_fake" }));
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ code: "unauthenticated" });

    const malformed = await connectionsPost(request("http://test.local/api/agent-home/connections", { body: { provider: "raw_api_key_lane" } }));
    expect(malformed.status).toBe(422);
    expect(await malformed.json()).toMatchObject({ code: "invalid_schema" });

    const secretShaped = await connectionsPost(request("http://test.local/api/agent-home/connections", { body: { provider: "secret-shaped-provider-fixture" } }));
    expect(secretShaped.status).toBe(422);
    expect(await secretShaped.json()).toMatchObject({ code: "invalid_schema" });

    const emptyAllowlists = await connectionsPost(request("http://test.local/api/agent-home/connections", {
      body: { provider: "openrouter", allowedModels: [], allowedRequestClasses: [] },
    }));
    expect(emptyAllowlists.status).toBe(422);
    expect(await emptyAllowlists.json()).toMatchObject({ code: "invalid_schema" });
  });

  it("records a passing smoke test and marks the connection ready for Run my Agent here", async () => {
    const created = await createConnection();
    const response = await smokePost(request(`http://test.local/api/agent-home/connections/${created.connection.id}/smoke`, { body: {} }), { params: Promise.resolve({ id: created.connection.id }) });
    expect(response.status).toBe(200);
    const json = await response.json();

    expect(json.connection).toMatchObject({ status: "ready", readiness: expect.objectContaining({ canRunHere: true, label: "Ready for Run my Agent here" }), lastSmoke: expect.objectContaining({ status: "passed" }) });
    expect(json.agentHome).toMatchObject({ setupStatus: "ready" });
    expect(agentHomePayload(json.agentHome, { productionMode: false }).readiness.message).toContain("one approved Run my Agent here sandbox run");
  });

  it("routes Claude Code connection smoke through the official CLI adapter", async () => {
    const previousExecutable = process.env.CMAI_CLAUDE_CODE_EXECUTABLE;
    const previousProxyUrl = process.env.CMAI_MODEL_PROXY_URL;
    process.env.CMAI_CLAUDE_CODE_EXECUTABLE = "/bin/true";
    process.env.CMAI_MODEL_PROXY_URL = "http://test.local/api/agent-home/model-proxy";
    try {
      const created = await createAgentHomeConnection({
        ownerId: "user-agent-home",
        ownerLabel: "Agent Home User",
        provider: "claude_code",
        providerSecret: JSON.stringify({ claudeAiOauth: { accessToken: "claude-smoke-access-token-fixture", refreshToken: "claude-smoke-refresh-token-fixture", expiresAt: Date.parse("2030-01-01T00:00:00.000Z"), scopes: ["user:inference"] } }),
      });
      const response = await smokePost(request(`http://test.local/api/agent-home/connections/${created.connection.id}/smoke`, { body: {} }), { params: Promise.resolve({ id: created.connection.id }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        connection: { provider: "claude_code", status: "ready", readiness: expect.objectContaining({ canRunHere: true }), lastSmoke: expect.objectContaining({ status: "passed" }) },
      });
    } finally {
      if (previousExecutable === undefined) delete process.env.CMAI_CLAUDE_CODE_EXECUTABLE;
      else process.env.CMAI_CLAUDE_CODE_EXECUTABLE = previousExecutable;
      if (previousProxyUrl === undefined) delete process.env.CMAI_MODEL_PROXY_URL;
      else process.env.CMAI_MODEL_PROXY_URL = previousProxyUrl;
    }
  });

  it("exposes pause, resume, revoke, and reconnect states without leaking credentials", async () => {
    const createdJson = await createConnection();
    const connectionId = createdJson.connection.id;
    await smokePost(request(`http://test.local/api/agent-home/connections/${connectionId}/smoke`, { body: {} }), { params: Promise.resolve({ id: connectionId }) });

    const paused = await connectionPatch(request(`http://test.local/api/agent-home/connections/${connectionId}`, { method: "PATCH", body: { action: "pause" } }), { params: Promise.resolve({ id: connectionId }) });
    expect(paused.status).toBe(200);
    const pausedJson = await paused.json();
    expect(pausedJson.connection).toMatchObject({ status: "paused", readiness: expect.objectContaining({ canRunHere: false, label: "Paused" }) });
    expect(agentHomePayload(pausedJson.agentHome, { productionMode: false }).readiness.message).toContain("paused");

    const resumed = await connectionPatch(request(`http://test.local/api/agent-home/connections/${connectionId}`, { method: "PATCH", body: { action: "resume" } }), { params: Promise.resolve({ id: connectionId }) });
    const resumedJson = await resumed.json();
    expect(resumedJson.connection).toMatchObject({ status: "ready", readiness: expect.objectContaining({ canRunHere: true }) });

    const revoked = await connectionPatch(request(`http://test.local/api/agent-home/connections/${connectionId}`, { method: "PATCH", body: { action: "revoke" } }), { params: Promise.resolve({ id: connectionId }) });
    const revokedJson = await revoked.json();
    expect(revokedJson.connection).toMatchObject({ status: "revoked", brokerCredentialAvailable: false, readiness: expect.objectContaining({ canRunHere: false, label: "Revoked" }) });
    expect(agentHomePayload(revokedJson.agentHome, { productionMode: false }).readiness.message).toContain("fresh provider access");

    const revokedSmoke = await smokePost(request(`http://test.local/api/agent-home/connections/${connectionId}/smoke`, { body: {} }), { params: Promise.resolve({ id: connectionId }) });
    expect(revokedSmoke.status).toBe(409);

    const revokedResume = await connectionPatch(request(`http://test.local/api/agent-home/connections/${connectionId}`, { method: "PATCH", body: { action: "resume" } }), { params: Promise.resolve({ id: connectionId }) });
    expect(revokedResume.status).toBe(409);
    expect(await revokedResume.json()).toMatchObject({ code: "agent_connection_revoked" });

    const reconnected = await connectionPatch(request(`http://test.local/api/agent-home/connections/${connectionId}`, { method: "PATCH", body: { action: "reconnect", providerSecret: "fresh-openrouter-secret" } }), { params: Promise.resolve({ id: connectionId }) });
    const reconnectedJson = await reconnected.json();
    expect(reconnectedJson.connection).toMatchObject({ status: "setup_required", brokerCredentialAvailable: true, readiness: expect.objectContaining({ canRunHere: false }) });
    expect(JSON.stringify(reconnectedJson)).not.toContain("fresh-openrouter-secret");
  });

  it("does not advertise stale ready fake/dev connections in production Agent Home payloads", async () => {
    const created = await createConnection();
    const smoke = await smokePost(request(`http://test.local/api/agent-home/connections/${created.connection.id}/smoke`, { body: {} }), { params: Promise.resolve({ id: created.connection.id }) });
    const { agentHome } = await smoke.json();

    expect(agentHomePayload(agentHome, { productionMode: false }).readiness).toMatchObject({ canRunHere: true, readyConnectionCount: 1, status: "ready" });
    const productionPayload = agentHomePayload(agentHome, { productionMode: true });
    expect(productionPayload.readyConnection).toBeNull();
    expect(productionPayload.readiness).toMatchObject({ canRunHere: false, readyConnectionCount: 0, status: "setup_required" });
  });

  it("does not advertise ready real-provider connections when production run cells or receipt signing are unavailable", async () => {
    const created = await connectionsPost(request("http://test.local/api/agent-home/connections", {
      body: { provider: "openrouter", defaultModel: "anthropic/claude-sonnet-4", allowedModels: ["anthropic/claude-sonnet-4"], allowedRequestClasses: ["critique"] },
    }));
    const createdJson = await created.json();
    const smoke = await smokePost(request(`http://test.local/api/agent-home/connections/${createdJson.connection.id}/smoke`, { body: {} }), { params: Promise.resolve({ id: createdJson.connection.id }) });
    const { agentHome } = await smoke.json();

    const productionPayload = agentHomePayload(agentHome, { productionMode: true, trustedRunConfigIssues: ["RAILWAY_ENVIRONMENT_ID is required for production Agent run cells"] });
    expect(productionPayload.readyConnection).toBeNull();
    expect(productionPayload.readiness).toMatchObject({ canRunHere: false, readyConnectionCount: 0, status: "setup_required" });
    expect(productionPayload.readiness.message).toContain("production broker, receipt signing, model proxy, or sandbox run cells are not configured");
  });

  it("redacts secret-looking smoke failures and keeps sandbox runs disabled", async () => {
    const created = await createConnection();
    const response = await smokePost(request(`http://test.local/api/agent-home/connections/${created.connection.id}/smoke`, {
      body: { simulateFailure: true, failureMessage: "provider said api_key=abc123 DATABASE_URL=postgres://user:***@example/db" },
    }), { params: Promise.resolve({ id: created.connection.id }) });
    expect(response.status).toBe(200);
    const json = await response.json();
    const serialized = JSON.stringify(json);

    expect(json.connection).toMatchObject({ status: "smoke_failed", readiness: expect.objectContaining({ canRunHere: false }), lastSmoke: expect.objectContaining({ status: "failed", redacted: true }) });
    expect(serialized).not.toContain("sk-liveSECRET123");
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("user:pass@example");
    expect(serialized).toContain("[redacted-secret]");
  });
});
