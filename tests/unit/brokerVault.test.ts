import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelProxyError, StaticModelProxyProviderCallerRegistry, StoreBackedModelProxyRegistry, type ModelProxyRequest } from "@/lib/agent-home/modelProxy";
import { redactSecretLikeText, sealCredentialValue, unsealCredentialValue } from "@/lib/agent-home/brokerVault";
import { createAgentHomeConnection, getAgentConnectionCredential, getAgentHomeConnection, markAgentConnectionNeedsReconnect, replaceAgentConnectionCredential, resetStoreForTests, updateAgentHomeConnection } from "@/lib/store";
import { resetRateLimitsForTests } from "@/lib/security/rateLimit";
import type { AgentConnectionDelegation } from "@/lib/types";

const fixedNow = new Date("2026-07-03T12:00:00.000Z");
const apiKey = "«redacted:sk-…»";
const codexSession = {
  auth_mode: "chatgpt",
  tokens: {
    id_token: "codex-id-token-fixture-123456",
    access_token: "codex-access-token-fixture-123456",
    refresh_token: "codex-refresh-token-fixture-123456",
    account_id: "acct_fixture_123456",
  },
  last_refresh: "2026-07-03T12:00:00.000Z",
};
const claudeCodeCredential = {
  claudeAiOauth: {
    accessToken: "claude-vault-access-token-fixture-123456",
    refreshToken: "claude-vault-refresh-token-fixture-123456",
    expiresAt: Date.parse("2030-01-01T00:00:00.000Z"),
    scopes: ["user:inference"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
  },
};

function request(connectionId: string): ModelProxyRequest {
  return {
    schema_version: "1.0",
    run_id: "run_durable_1",
    delegation_id: "del_durable_once",
    agent_connection_id: connectionId,
    provider: "openrouter",
    model: "openai/gpt-4.1-mini",
    request_class: "contribution_card",
    messages: [{ role: "user", content: "Return JSON." }],
    response_format: "json_object",
  };
}

function delegation(connectionId: string): AgentConnectionDelegation {
  return {
    delegation_id: "del_durable_once",
    connection_id: connectionId,
    agent_connection_id: connectionId,
    provider: "openrouter",
    allowed_model: "openai/gpt-4.1-mini",
    allowed_request_class: "contribution_card",
    expires_at: "2026-07-03T12:10:00.000Z",
    max_requests: 1,
  };
}

describe("broker vault and durable model-proxy grants", () => {
  beforeEach(async () => {
    await resetStoreForTests();
    resetRateLimitsForTests();
  });

  afterEach(() => {
    delete process.env.CMAI_ENFORCE_RATE_LIMITS;
    resetRateLimitsForTests();
  });

  it("seals provider credentials and redacts secret-shaped text", () => {
    const sealed = sealCredentialValue({ apiKey }, "unit-test-vault-secret");
    expect(sealed).not.toContain(apiKey);
    expect(unsealCredentialValue(sealed, "unit-test-vault-secret")).toEqual({ apiKey });

    const redacted = redactSecretLikeText(`api_key=${apiKey} DATABASE_URL=postgres://user:pass@example/db`);
    expect(redacted.redacted).toBe(true);
    expect(redacted.text).toContain("[redacted-secret]");
    expect(redacted.text).not.toContain(apiKey);
    expect(redacted.text).not.toContain("user:pass@example");
  });

  it("stores, rotates, and revokes broker-side credentials without returning raw secret values", async () => {
    const created = await createAgentHomeConnection({ ownerId: "user_1", ownerLabel: "User", provider: "openrouter", providerSecret: apiKey });
    expect(created.connection).toMatchObject({ provider: "openrouter", brokerCredentialAvailable: true, status: "setup_required" });
    expect(JSON.stringify(created.connection)).not.toContain(apiKey);

    const credential = await getAgentConnectionCredential({ ownerId: "user_1", connectionId: created.connection.id });
    expect(credential?.value).toEqual({ apiKey });

    const rotated = await updateAgentHomeConnection({ ownerId: "user_1", connectionId: created.connection.id, action: "rotate", providerSecret: "sk-unit-rotated-secret" });
    expect(rotated.connection).toMatchObject({ brokerCredentialAvailable: true, status: "setup_required", lastSmoke: expect.objectContaining({ status: "not_run" }) });
    expect(JSON.stringify(rotated.connection)).not.toContain("sk-unit-rotated-secret");

    const revoked = await updateAgentHomeConnection({ ownerId: "user_1", connectionId: created.connection.id, action: "revoke" });
    expect(revoked.connection).toMatchObject({ brokerCredentialAvailable: false, status: "revoked", readiness: expect.objectContaining({ canRunHere: false }) });
    await expect(getAgentConnectionCredential({ ownerId: "user_1", connectionId: created.connection.id })).resolves.toBeUndefined();
    await expect(updateAgentHomeConnection({ ownerId: "user_1", connectionId: created.connection.id, action: "resume" })).rejects.toMatchObject({ status: 409, code: "agent_connection_revoked" });
  });

  it("seals Codex-managed auth.json as a non-API-key credential with public metadata only", async () => {
    const created = await createAgentHomeConnection({ ownerId: "user_1", ownerLabel: "User", provider: "codex", providerSecret: JSON.stringify(codexSession) });

    expect(created.connection).toMatchObject({
      provider: "codex",
      connectionKind: "device_code",
      brokerCredentialAvailable: true,
      credentialPublicMetadata: { auth_mode: "chatgpt", last_refresh: "2026-07-03T12:00:00.000Z", account_hint: "…123456" },
      status: "setup_required",
    });
    const publicConnection = JSON.stringify(created.connection);
    expect(publicConnection).not.toContain("codex-access-token-fixture");
    expect(publicConnection).not.toContain("codex-refresh-token-fixture");
    expect(publicConnection).not.toContain("codex-id-token-fixture");

    const credential = await getAgentConnectionCredential({ ownerId: "user_1", connectionId: created.connection.id });
    expect(credential?.value).toMatchObject({ auth_mode: "chatgpt", last_refresh: "2026-07-03T12:00:00.000Z" });
    expect(credential?.revision).toBe(1);
    expect(JSON.stringify(credential?.value)).toContain("codex-access-token-fixture-123456");
  });

  it("returns expired refreshable managed sessions so the official CLI can refresh them", async () => {
    const expiredClaude = {
      claudeAiOauth: {
        ...claudeCodeCredential.claudeAiOauth,
        expiresAt: Date.parse("2020-01-01T00:00:00.000Z"),
      },
    };
    const created = await createAgentHomeConnection({ ownerId: "user_expired_claude", ownerLabel: "Claude User", provider: "claude_code", providerSecret: JSON.stringify(expiredClaude) });
    const credential = await getAgentConnectionCredential({ ownerId: "user_expired_claude", connectionId: created.connection.id });
    expect(credential).toMatchObject({ provider: "claude_code", value: expiredClaude });
  });

  it("seals Claude Code managed auth, persists CLI refreshes, and marks auth failures reconnect-required", async () => {
    const ownerId = "user_claude_vault";
    const created = await createAgentHomeConnection({ ownerId, ownerLabel: "Claude User", provider: "claude_code", providerSecret: JSON.stringify(claudeCodeCredential) });
    expect(created.connection).toMatchObject({
      provider: "claude_code",
      connectionKind: "oauth",
      brokerCredentialAvailable: true,
      credentialPublicMetadata: {
        auth_mode: "claude_subscription",
        subscription_type: "max",
        rate_limit_tier: "default_claude_max_20x",
        expires_at: "2030-01-01T00:00:00.000Z",
      },
    });
    expect(JSON.stringify(created.connection)).not.toMatch(/claude-vault-(?:access|refresh)-token/);

    const first = await getAgentConnectionCredential({ ownerId, connectionId: created.connection.id });
    expect(first).toMatchObject({ provider: "claude_code", revision: 1, value: claudeCodeCredential });
    const refreshed = {
      claudeAiOauth: {
        ...claudeCodeCredential.claudeAiOauth,
        accessToken: "claude-vault-access-token-refreshed-123456",
        refreshToken: "claude-vault-refresh-token-refreshed-123456",
      },
    };
    const replaced = await replaceAgentConnectionCredential({ ownerId, connectionId: created.connection.id, expectedRevision: 1, value: refreshed });
    expect(replaced).toMatchObject({ updated: true, credential: { revision: 2 } });
    const stale = await replaceAgentConnectionCredential({ ownerId, connectionId: created.connection.id, expectedRevision: 1, value: claudeCodeCredential });
    expect(stale).toMatchObject({ updated: false, credential: { revision: 2 } });

    const registry = new StoreBackedModelProxyRegistry({ now: () => fixedNow });
    const delegationId = "del_claude_reconnect_once";
    await registry.register({
      runId: "run_claude_reconnect_1",
      ownerId,
      delegation: {
        delegation_id: delegationId,
        connection_id: created.connection.id,
        agent_connection_id: created.connection.id,
        provider: "claude_code",
        allowed_model: "sonnet",
        allowed_request_class: "contribution_card",
        expires_at: "2026-07-03T12:10:00.000Z",
        max_requests: 1,
      },
      agentConnectionId: created.connection.id,
      provider: "claude_code",
      allowedModel: "sonnet",
      allowedRequestClass: "contribution_card",
      expiresAt: "2026-07-03T12:10:00.000Z",
      maxRequests: 1,
      credential: replaced.credential!,
    });
    await expect(registry.dispatch({
      schema_version: "1.0",
      run_id: "run_claude_reconnect_1",
      delegation_id: delegationId,
      agent_connection_id: created.connection.id,
      provider: "claude_code",
      model: "sonnet",
      request_class: "contribution_card",
      messages: [{ role: "user", content: "Return JSON." }],
      response_format: "json_object",
    }, async () => { throw new ModelProxyError("MODEL_PROXY_CLAUDE_CODE_AUTH_FAILED", "Claude Code authentication needs to be reconnected.", 401); })).rejects.toMatchObject({ code: "MODEL_PROXY_CLAUDE_CODE_AUTH_FAILED" });

    const connection = await getAgentHomeConnection({ ownerId, connectionId: created.connection.id });
    expect(connection).toMatchObject({ status: "needs_reconnect", readiness: expect.objectContaining({ canRunHere: false }), lastSmoke: expect.objectContaining({ failureCode: "claude_code_reconnect_required" }) });
    expect(JSON.stringify(connection)).not.toMatch(/claude-vault-(?:access|refresh)-token/);
  });

  it("persists refreshed Codex auth with compare-and-swap and marks reconnect without leaking credentials", async () => {
    const created = await createAgentHomeConnection({ ownerId: "user_refresh", ownerLabel: "User", provider: "codex", providerSecret: JSON.stringify(codexSession) });
    const first = await getAgentConnectionCredential({ ownerId: "user_refresh", connectionId: created.connection.id });
    expect(first?.revision).toBe(1);

    const refreshed = {
      ...codexSession,
      tokens: { ...codexSession.tokens, access_token: "codex-access-token-refreshed-123456", refresh_token: "codex-refresh-token-refreshed-123456" },
      last_refresh: "2026-07-03T12:05:00.000Z",
    };
    const replaced = await replaceAgentConnectionCredential({ ownerId: "user_refresh", connectionId: created.connection.id, expectedRevision: 1, value: refreshed });
    expect(replaced.updated).toBe(true);
    expect(replaced.credential).toMatchObject({ revision: 2, value: expect.objectContaining({ last_refresh: "2026-07-03T12:05:00.000Z" }) });

    const stale = await replaceAgentConnectionCredential({ ownerId: "user_refresh", connectionId: created.connection.id, expectedRevision: 1, value: codexSession });
    expect(stale.updated).toBe(false);
    expect(stale.credential).toMatchObject({ revision: 2, value: expect.objectContaining({ last_refresh: "2026-07-03T12:05:00.000Z" }) });

    const reconnect = await markAgentConnectionNeedsReconnect({ ownerId: "user_refresh", connectionId: created.connection.id, reason: "Codex authorization needs to be renewed." });
    expect(reconnect).toMatchObject({ status: "needs_reconnect", readiness: expect.objectContaining({ canRunHere: false }) });
    const publicReconnect = JSON.stringify(reconnect);
    expect(publicReconnect).not.toContain("codex-access-token");
    expect(publicReconnect).not.toContain("codex-refresh-token");
  });

  it("persists Codex CLI refreshes from a durable one-run model-proxy dispatch", async () => {
    const created = await createAgentHomeConnection({ ownerId: "user_dispatch_refresh", ownerLabel: "User", provider: "codex", providerSecret: JSON.stringify(codexSession) });
    const credential = await getAgentConnectionCredential({ ownerId: "user_dispatch_refresh", connectionId: created.connection.id });
    const registry = new StoreBackedModelProxyRegistry({ now: () => fixedNow });
    const delegationId = "del_codex_refresh_once";
    await registry.register({
      runId: "run_codex_refresh_1",
      ownerId: "user_dispatch_refresh",
      delegation: {
        delegation_id: delegationId,
        connection_id: created.connection.id,
        agent_connection_id: created.connection.id,
        provider: "codex",
        allowed_model: "gpt-5.6-sol",
        allowed_request_class: "contribution_card",
        expires_at: "2026-07-03T12:10:00.000Z",
        max_requests: 1,
      },
      agentConnectionId: created.connection.id,
      provider: "codex",
      allowedModel: "gpt-5.6-sol",
      allowedRequestClass: "contribution_card",
      expiresAt: "2026-07-03T12:10:00.000Z",
      maxRequests: 1,
      credential: credential!,
    });
    const refreshed = {
      ...codexSession,
      tokens: { ...codexSession.tokens, refresh_token: "codex-refresh-token-dispatch-123456" },
      last_refresh: "2026-07-03T12:06:00.000Z",
    };
    const response = await registry.dispatch({
      schema_version: "1.0",
      run_id: "run_codex_refresh_1",
      delegation_id: delegationId,
      agent_connection_id: created.connection.id,
      provider: "codex",
      model: "gpt-5.6-sol",
      request_class: "contribution_card",
      messages: [{ role: "user", content: "Return JSON." }],
      response_format: "json_object",
    }, async () => ({
      content: "{\"ok\":true}",
      provider: "codex",
      requestedModel: "gpt-5.6-sol",
      returnedModel: "gpt-5.6-sol",
      providerModelVerified: false,
      credentialUpdate: refreshed,
    }));

    expect(response).toMatchObject({ ok: true, remaining_requests: 0 });
    const stored = await getAgentConnectionCredential({ ownerId: "user_dispatch_refresh", connectionId: created.connection.id });
    expect(stored).toMatchObject({ revision: 2, value: expect.objectContaining({ last_refresh: "2026-07-03T12:06:00.000Z" }) });
    expect(JSON.stringify(response)).not.toContain("codex-refresh-token-dispatch");
  });

  it("marks a durable Codex connection as reconnect-required after an auth refresh failure", async () => {
    const created = await createAgentHomeConnection({ ownerId: "user_dispatch_reconnect", ownerLabel: "User", provider: "codex", providerSecret: JSON.stringify(codexSession) });
    const credential = await getAgentConnectionCredential({ ownerId: "user_dispatch_reconnect", connectionId: created.connection.id });
    const registry = new StoreBackedModelProxyRegistry({ now: () => fixedNow });
    const delegationId = "del_codex_reconnect_once";
    await registry.register({
      runId: "run_codex_reconnect_1",
      ownerId: "user_dispatch_reconnect",
      delegation: {
        delegation_id: delegationId,
        connection_id: created.connection.id,
        agent_connection_id: created.connection.id,
        provider: "codex",
        allowed_model: "gpt-5.6-sol",
        allowed_request_class: "contribution_card",
        expires_at: "2026-07-03T12:10:00.000Z",
        max_requests: 1,
      },
      agentConnectionId: created.connection.id,
      provider: "codex",
      allowedModel: "gpt-5.6-sol",
      allowedRequestClass: "contribution_card",
      expiresAt: "2026-07-03T12:10:00.000Z",
      maxRequests: 1,
      credential: credential!,
    });
    await expect(registry.dispatch({
      schema_version: "1.0",
      run_id: "run_codex_reconnect_1",
      delegation_id: delegationId,
      agent_connection_id: created.connection.id,
      provider: "codex",
      model: "gpt-5.6-sol",
      request_class: "contribution_card",
      messages: [{ role: "user", content: "Return JSON." }],
      response_format: "json_object",
    }, async () => { throw new ModelProxyError("MODEL_PROXY_CODEX_AUTH_FAILED", "Codex ChatGPT authentication needs to be reconnected.", 401); })).rejects.toMatchObject({ code: "MODEL_PROXY_CODEX_AUTH_FAILED" });

    const connection = await getAgentHomeConnection({ ownerId: "user_dispatch_reconnect", connectionId: created.connection.id });
    expect(connection).toMatchObject({ status: "needs_reconnect", readiness: expect.objectContaining({ canRunHere: false }) });
    expect(JSON.stringify(connection)).not.toContain("codex-refresh-token");
  });

  it("persists model-proxy grants through the broker state store and consumes them once", async () => {
    const created = await createAgentHomeConnection({ ownerId: "user_1", ownerLabel: "User", provider: "openrouter", providerSecret: apiKey });
    const credential = await getAgentConnectionCredential({ ownerId: "user_1", connectionId: created.connection.id });
    expect(credential).toBeTruthy();

    const registry = new StoreBackedModelProxyRegistry({ now: () => fixedNow });
    await registry.register({
      runId: "run_durable_1",
      ownerId: "user_1",
      delegation: delegation(created.connection.id),
      agentConnectionId: created.connection.id,
      provider: "openrouter",
      allowedModel: "openai/gpt-4.1-mini",
      allowedRequestClass: "contribution_card",
      expiresAt: "2026-07-03T12:10:00.000Z",
      maxRequests: 1,
      credential: credential!,
    });

    const providerCall = vi.fn(async ({ credential: callCredential }) => {
      expect(callCredential.value).toEqual({ apiKey });
      return {
        content: "{\"ok\":true}",
        provider: "openrouter",
        requestedModel: "openai/gpt-4.1-mini",
        returnedModel: "openai/gpt-4.1-mini",
        modelDisplayName: "openai/gpt-4.1-mini",
        providerResponseId: "resp_durable_1",
        providerModelVerified: true,
      };
    });

    const response = await registry.dispatch(request(created.connection.id), providerCall);
    expect(response).toMatchObject({ ok: true, remaining_requests: 0, provider_response_id: "resp_durable_1" });
    expect(JSON.stringify(response)).not.toContain(apiKey);
    await expect(registry.dispatch(request(created.connection.id), providerCall)).rejects.toMatchObject({ code: "MODEL_PROXY_DELEGATION_CONSUMED" });
    expect(providerCall).toHaveBeenCalledTimes(1);
  });

  it("rate-limits repeated durable grant scope mismatches without consuming the grant", async () => {
    process.env.CMAI_ENFORCE_RATE_LIMITS = "1";
    const created = await createAgentHomeConnection({ ownerId: "user_1", ownerLabel: "User", provider: "openrouter", providerSecret: apiKey });
    const credential = await getAgentConnectionCredential({ ownerId: "user_1", connectionId: created.connection.id });
    expect(credential).toBeTruthy();

    const registry = new StoreBackedModelProxyRegistry({ now: () => fixedNow });
    await registry.register({
      runId: "run_durable_1",
      ownerId: "user_1",
      delegation: delegation(created.connection.id),
      agentConnectionId: created.connection.id,
      provider: "openrouter",
      allowedModel: "openai/gpt-4.1-mini",
      allowedRequestClass: "contribution_card",
      expiresAt: "2026-07-03T12:10:00.000Z",
      maxRequests: 1,
      credential: credential!,
    });
    const badModel = { ...request(created.connection.id), model: "anthropic/claude-sonnet-4" };
    const providerCall = vi.fn();

    for (let index = 0; index < 3; index += 1) {
      await expect(registry.dispatch(badModel, providerCall)).rejects.toMatchObject({ code: "MODEL_PROXY_MODEL_MISMATCH" });
    }
    await expect(registry.dispatch(badModel, providerCall)).rejects.toMatchObject({ code: "MODEL_PROXY_RATE_LIMITED", status: 429 });
    await expect(registry.dispatch(request(created.connection.id), providerCall)).rejects.toMatchObject({ code: "MODEL_PROXY_RATE_LIMITED", status: 429 });
    expect(providerCall).not.toHaveBeenCalled();
  });

  it("keeps durable grants reusable when no provider caller is registered", async () => {
    const created = await createAgentHomeConnection({ ownerId: "user_1", ownerLabel: "User", provider: "openrouter", providerSecret: apiKey });
    const credential = await getAgentConnectionCredential({ ownerId: "user_1", connectionId: created.connection.id });
    expect(credential).toBeTruthy();

    const registry = new StoreBackedModelProxyRegistry({ now: () => fixedNow });
    await registry.register({
      runId: "run_durable_1",
      ownerId: "user_1",
      delegation: delegation(created.connection.id),
      agentConnectionId: created.connection.id,
      provider: "openrouter",
      allowedModel: "openai/gpt-4.1-mini",
      allowedRequestClass: "contribution_card",
      expiresAt: "2026-07-03T12:10:00.000Z",
      maxRequests: 1,
      credential: credential!,
    });

    await expect(registry.dispatch(request(created.connection.id), new StaticModelProxyProviderCallerRegistry())).rejects.toMatchObject({
      code: "MODEL_PROXY_PROVIDER_UNAVAILABLE",
    });

    const providerCall = vi.fn(async () => ({
      content: "{\"ok\":true}",
      provider: "openrouter",
      requestedModel: "openai/gpt-4.1-mini",
      returnedModel: "openai/gpt-4.1-mini",
      modelDisplayName: "openai/gpt-4.1-mini",
      providerResponseId: "resp_durable_after_unavailable",
      providerModelVerified: true,
    }));
    await expect(registry.dispatch(request(created.connection.id), providerCall)).resolves.toMatchObject({
      ok: true,
      remaining_requests: 0,
      provider_response_id: "resp_durable_after_unavailable",
    });
    expect(providerCall).toHaveBeenCalledTimes(1);
  });
});
