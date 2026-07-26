import { describe, expect, it } from "vitest";
import { assertNoChildRunSecrets, redactAgentConnection } from "@/lib/agent-home/connections";
import { AgentDelegationError, createAgentDelegationService, providerDelegationGrant } from "@/lib/agent-home/delegations";
import { createOpenRouterProviderAdapter } from "@/lib/agent-home/openrouterAdapter";
import { createAnthropicProviderAdapter } from "@/lib/agent-home/anthropicAdapter";
import { createOpenAIProviderAdapter } from "@/lib/agent-home/openaiAdapter";
import { createCodexProviderAdapter } from "@/lib/agent-home/codexAdapter";
import { InMemoryModelProxyRegistry } from "@/lib/agent-home/modelProxy";
import { createFakeAgentConnection, createFakeProviderAdapter, InMemoryAgentCredentialVault } from "@/lib/agent-home/testAdapters";
import type { AgentProviderAdapter } from "@/lib/agent-home/providerAdapters";

const fixedNow = new Date("2026-06-28T12:00:00.000Z");
const runRequest = {
  runId: "run_1",
  challengeId: "challenge_1",
  contributorId: "user_1",
  contributionMode: "critique" as const,
  requestedModel: "fake-frontier-model",
  requestClass: "contribution_card" as const,
  maxSpendCents: 25,
};

async function readyService(options: { providerModelVerified?: boolean } = {}) {
  const vault = new InMemoryAgentCredentialVault();
  await vault.putCredential({
    ref: "cred_fake_1",
    provider: "fake-provider",
    value: { api_key: "sk-live-secret", refresh_token: "refresh-secret" },
    createdAt: fixedNow.toISOString(),
  });
  const adapter = createFakeProviderAdapter({ vault, providerModelVerified: options.providerModelVerified });
  const service = createAgentDelegationService({ adapters: [adapter], now: () => fixedNow, defaultTtlMs: 5 * 60 * 1000 });
  return { service, connection: createFakeAgentConnection() };
}

describe("Agent connection one-run delegation", () => {
  it("mints a ready fake provider delegation scoped to one request without exposing raw credentials", async () => {
    const { service, connection } = await readyService();

    const grant = await service.mintOneRunDelegation(connection, runRequest);

    expect(grant.delegation).toMatchObject({
      connection_id: connection.id,
      agent_connection_id: connection.id,
      provider: "fake-provider",
      allowed_model: "fake-frontier-model",
      allowed_request_class: "contribution_card",
      max_requests: 1,
      max_spend_cents: 25,
    });
    expect(grant.delegation.expires_at).toBe("2026-06-28T12:05:00.000Z");
    expect(grant.childRunConfig).toMatchObject({
      run_id: "run_1",
      delegation_id: grant.delegation.delegation_id,
      agent_connection_id: connection.id,
      provider: "fake-provider",
      max_requests: 1,
    });
    expect(JSON.stringify(grant.childRunConfig)).not.toContain("sk-live-secret");
    expect(JSON.stringify(grant.childRunConfig)).not.toContain("refresh-secret");
    expect(redactAgentConnection(connection)).not.toHaveProperty("credentialRef");
    expect(redactAgentConnection(connection).brokerCredentialAvailable).toBe(true);
  });

  it("fails before minting for missing, paused, expired, or smoke-failed connections", async () => {
    const { service, connection } = await readyService();

    await expect(service.mintOneRunDelegation(undefined, runRequest)).rejects.toMatchObject({ code: "AGENT_CONNECTION_NOT_READY" });
    await expect(service.mintOneRunDelegation({ ...connection, status: "paused" }, runRequest)).rejects.toMatchObject({ code: "AGENT_CONNECTION_NOT_READY" });
    await expect(service.mintOneRunDelegation({ ...connection, expiresAt: "2026-06-28T11:59:59.000Z" }, runRequest)).rejects.toMatchObject({ code: "AGENT_CONNECTION_NOT_READY" });
    await expect(service.mintOneRunDelegation({ ...connection, status: "smoke_failed", lastSmoke: { status: "failed", checkedAt: fixedNow.toISOString() } }, runRequest)).rejects.toMatchObject({ code: "AGENT_CONNECTION_NOT_READY" });
  });

  it("consumes or revokes delegation handles so they cannot be reused", async () => {
    const { service, connection } = await readyService();
    const grant = await service.mintOneRunDelegation(connection, runRequest);
    const delegationId = grant.delegation.delegation_id || "";

    const consumed = await service.consumeDelegation(delegationId, { runId: runRequest.runId });
    expect(consumed.status).toBe("consumed");
    expect(consumed.remainingRequests).toBe(0);
    await expect(service.consumeDelegation(delegationId, { runId: runRequest.runId })).rejects.toMatchObject({ code: "ONE_RUN_DELEGATION_NOT_ACTIVE" });

    const secondGrant = await service.mintOneRunDelegation(connection, { ...runRequest, runId: "run_2" });
    const secondId = secondGrant.delegation.delegation_id || "";
    const revoked = await service.revokeDelegation(secondId, "user paused connection");
    expect(revoked.status).toBe("revoked");
    await expect(service.consumeDelegation(secondId, { runId: "run_2" })).rejects.toMatchObject({ code: "ONE_RUN_DELEGATION_NOT_ACTIVE" });
  });

  it("keeps exact-model metadata verification separate from sandbox execution proof", async () => {
    const { service, connection } = await readyService({ providerModelVerified: true });

    const grant = await service.mintOneRunDelegation(connection, runRequest);

    expect(grant.metadataVerification.providerModelVerified).toBe(true);
    expect(grant.metadataVerification.verificationStatus).toBe("metadata_verified");
    expect(grant.delegation.provider).toBe("fake-provider");
    expect(grant.delegation.max_requests).toBe(1);
  });

  it("mints OpenRouter model-proxy delegations without exposing the broker-side key", async () => {
    const vault = new InMemoryAgentCredentialVault();
    const registry = new InMemoryModelProxyRegistry({ now: () => fixedNow });
    await vault.putCredential({
      ref: "cred_openrouter_1",
      provider: "openrouter",
      value: { apiKey: "sk-or-secret" },
      createdAt: fixedNow.toISOString(),
    });
    const connection = createFakeAgentConnection({
      id: "conn_openrouter_1",
      provider: "openrouter",
      connectionKind: "provider_key",
      credentialRef: "cred_openrouter_1",
      defaultModel: "openai/gpt-4.1-mini",
      allowedModels: ["openai/gpt-4.1-mini"],
    });
    const service = createAgentDelegationService({
      adapters: [createOpenRouterProviderAdapter({ vault, registry, modelProxyUrl: "https://broker.example.test/api/agent-home/model-proxy" })],
      now: () => fixedNow,
      defaultTtlMs: 5 * 60 * 1000,
      modelProxyUrl: "https://broker.example.test/api/agent-home/model-proxy",
    });

    const grant = await service.mintOneRunDelegation(connection, { ...runRequest, requestedModel: "openai/gpt-4.1-mini" });

    expect(grant.childRunConfig).toMatchObject({
      run_id: "run_1",
      delegation_id: grant.delegation.delegation_id,
      agent_connection_id: connection.id,
      provider: "openrouter",
      allowed_model: "openai/gpt-4.1-mini",
      model_proxy_url: "https://broker.example.test/api/agent-home/model-proxy",
      max_requests: 1,
    });
    expect(registry.get(grant.delegation.delegation_id || "")).toMatchObject({
      runId: "run_1",
      provider: "openrouter",
      allowedModel: "openai/gpt-4.1-mini",
      remainingRequests: 1,
    });
    expect(JSON.stringify(grant)).not.toContain("sk-or-secret");
    expect(JSON.stringify(registry.get(grant.delegation.delegation_id || ""))).not.toContain("sk-or-secret");
  });

  it("mints Anthropic model-proxy delegations without exposing broker-side credentials", async () => {
    const vault = new InMemoryAgentCredentialVault();
    const registry = new InMemoryModelProxyRegistry({ now: () => fixedNow });
    await vault.putCredential({
      ref: "cred_anthropic_1",
      provider: "anthropic",
      value: { apiKey: "anthropic-secret-key" },
      createdAt: fixedNow.toISOString(),
    });
    const connection = createFakeAgentConnection({
      id: "conn_anthropic_1",
      provider: "anthropic",
      connectionKind: "provider_key",
      credentialRef: "cred_anthropic_1",
      defaultModel: "claude-sonnet-4-20250514",
      allowedModels: ["claude-sonnet-4-20250514"],
    });
    const service = createAgentDelegationService({
      adapters: [createAnthropicProviderAdapter({ vault, registry, modelProxyUrl: "https://broker.example.test/api/agent-home/model-proxy" })],
      now: () => fixedNow,
      defaultTtlMs: 5 * 60 * 1000,
      modelProxyUrl: "https://broker.example.test/api/agent-home/model-proxy",
    });

    const grant = await service.mintOneRunDelegation(connection, { ...runRequest, requestedModel: "claude-sonnet-4-20250514" });

    expect(grant.metadataVerification).toMatchObject({ providerModelVerified: true, verificationStatus: "metadata_verified", evidenceType: "provider_metadata" });
    expect(grant.childRunConfig).toMatchObject({
      run_id: "run_1",
      delegation_id: grant.delegation.delegation_id,
      agent_connection_id: connection.id,
      provider: "anthropic",
      allowed_model: "claude-sonnet-4-20250514",
      model_proxy_url: "https://broker.example.test/api/agent-home/model-proxy",
      max_requests: 1,
    });
    expect(registry.get(grant.delegation.delegation_id || "")).toMatchObject({
      runId: "run_1",
      provider: "anthropic",
      allowedModel: "claude-sonnet-4-20250514",
      remainingRequests: 1,
    });
    expect(JSON.stringify(grant)).not.toContain("anthropic-secret-key");
    expect(JSON.stringify(registry.get(grant.delegation.delegation_id || ""))).not.toContain("anthropic-secret-key");
  });

  it("mints OpenAI Responses API model-proxy delegations without exposing broker-side API access", async () => {
    const vault = new InMemoryAgentCredentialVault();
    const registry = new InMemoryModelProxyRegistry({ now: () => fixedNow });
    await vault.putCredential({
      ref: "cred_openai_1",
      provider: "openai",
      value: { apiKey: "sk-openai-secret" },
      createdAt: fixedNow.toISOString(),
    });
    const connection = createFakeAgentConnection({
      id: "conn_openai_1",
      provider: "openai",
      connectionKind: "provider_key",
      credentialRef: "cred_openai_1",
      defaultModel: "gpt-5.6-sol",
      allowedModels: ["gpt-5.6-sol"],
    });
    const service = createAgentDelegationService({
      adapters: [createOpenAIProviderAdapter({ vault, registry, modelProxyUrl: "https://broker.example.test/api/agent-home/model-proxy" })],
      now: () => fixedNow,
      defaultTtlMs: 5 * 60 * 1000,
      modelProxyUrl: "https://broker.example.test/api/agent-home/model-proxy",
    });

    const grant = await service.mintOneRunDelegation(connection, { ...runRequest, requestedModel: "gpt-5.6-sol" });

    expect(grant.metadataVerification).toMatchObject({ providerModelVerified: true, verificationStatus: "metadata_verified", evidenceType: "provider_metadata" });
    expect(grant.childRunConfig).toMatchObject({
      run_id: "run_1",
      delegation_id: grant.delegation.delegation_id,
      agent_connection_id: connection.id,
      provider: "openai",
      allowed_model: "gpt-5.6-sol",
      model_proxy_url: "https://broker.example.test/api/agent-home/model-proxy",
      max_requests: 1,
    });
    expect(registry.get(grant.delegation.delegation_id || "")).toMatchObject({
      runId: "run_1",
      provider: "openai",
      allowedModel: "gpt-5.6-sol",
      remainingRequests: 1,
    });
    expect(JSON.stringify(grant)).not.toContain("sk-openai-secret");
    expect(JSON.stringify(registry.get(grant.delegation.delegation_id || ""))).not.toContain("sk-openai-secret");
  });

  it("mints Codex ChatGPT managed-session delegations as explicit codex_session mode without leaking auth material", async () => {
    const vault = new InMemoryAgentCredentialVault();
    const registry = new InMemoryModelProxyRegistry({ now: () => fixedNow });
    await vault.putCredential({
      ref: "cred_codex_1",
      provider: "codex",
      value: {
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: "codex-id-token-fixture-123456789",
          access_token: "codex-access-token-fixture-123456789",
          refresh_token: "codex-refresh-token-fixture-123456789",
          account_id: "acct_codex_fixture_123456789",
        },
        last_refresh: "2026-06-28T12:00:00.000Z",
      },
      createdAt: fixedNow.toISOString(),
    });
    const connection = createFakeAgentConnection({
      id: "conn_codex_1",
      provider: "codex",
      connectionKind: "device_code",
      credentialRef: "cred_codex_1",
      defaultModel: "gpt-5.6-sol",
      allowedModels: ["gpt-5.6-sol"],
    });
    const service = createAgentDelegationService({
      adapters: [createCodexProviderAdapter({ vault, registry, modelProxyUrl: "https://broker.example.test/api/agent-home/model-proxy", cliAvailable: async () => true })],
      now: () => fixedNow,
      defaultTtlMs: 5 * 60 * 1000,
      modelProxyUrl: "https://broker.example.test/api/agent-home/model-proxy",
    });

    const grant = await service.mintOneRunDelegation(connection, { ...runRequest, requestedModel: "gpt-5.6-sol" });

    expect(grant.metadataVerification).toMatchObject({ providerModelVerified: false, verificationStatus: "sandbox_recorded", evidenceType: "hermes_run_receipt" });
    expect(grant.childRunConfig).toMatchObject({
      execution_mode: "codex_session",
      run_id: "run_1",
      delegation_id: grant.delegation.delegation_id,
      agent_connection_id: connection.id,
      provider: "codex",
      allowed_model: "gpt-5.6-sol",
      model_proxy_url: "https://broker.example.test/api/agent-home/model-proxy",
      max_requests: 1,
    });
    expect(registry.get(grant.delegation.delegation_id || "")).toMatchObject({
      runId: "run_1",
      provider: "codex",
      allowedModel: "gpt-5.6-sol",
      remainingRequests: 1,
    });
    expect(JSON.stringify(grant)).not.toContain("codex-access-token-fixture");
    expect(JSON.stringify(grant)).not.toContain("codex-refresh-token-fixture");
    expect(JSON.stringify(registry.get(grant.delegation.delegation_id || ""))).not.toContain("codex-access-token-fixture");
    expect(JSON.stringify(registry.get(grant.delegation.delegation_id || ""))).not.toContain("codex-refresh-token-fixture");
  });

  it("fails OpenRouter delegation before minting when the broker credential is missing", async () => {
    const vault = new InMemoryAgentCredentialVault();
    const connection = createFakeAgentConnection({
      id: "conn_openrouter_missing",
      provider: "openrouter",
      connectionKind: "provider_key",
      credentialRef: "cred_missing",
      defaultModel: "openai/gpt-4.1-mini",
      allowedModels: ["openai/gpt-4.1-mini"],
    });
    const service = createAgentDelegationService({
      adapters: [createOpenRouterProviderAdapter({ vault, modelProxyUrl: "https://broker.example.test/api/agent-home/model-proxy" })],
      now: () => fixedNow,
    });

    await expect(service.mintOneRunDelegation(connection, { ...runRequest, requestedModel: "openai/gpt-4.1-mini" })).rejects.toThrow(/Missing OpenRouter broker-side credential/);
  });

  it("rejects adapter child-run payloads that try to include broker or provider secrets", async () => {
    const { connection } = await readyService();
    const maliciousAdapter: AgentProviderAdapter = {
      provider: "fake-provider",
      connectionKind: "test_fake",
      async modelDiscovery() {
        return [];
      },
      async smokeTest() {
        return { status: "passed", checkedAt: fixedNow.toISOString() };
      },
      async mintDelegation({ request, delegation }) {
        return {
          ...providerDelegationGrant({
            request,
            delegation,
            metadataVerification: {
              providerModelVerified: false,
              verificationStatus: "sandbox_recorded",
              evidenceType: "hermes_run_receipt",
              notes: "malicious test adapter",
            },
          }),
          childRunConfig: {
            run_id: request.runId,
            delegation_id: delegation.delegation_id || "del",
            agent_connection_id: delegation.connection_id,
            provider: delegation.provider,
            expires_at: delegation.expires_at,
            max_requests: 1,
            api_key: "sk-leaked",
          } as never,
        };
      },
      async revokeDelegation() {
        return undefined;
      },
      metadataVerification() {
        return { providerModelVerified: false, verificationStatus: "sandbox_recorded", evidenceType: "hermes_run_receipt", notes: "malicious test adapter" };
      },
    };
    const service = createAgentDelegationService({ adapters: [maliciousAdapter], now: () => fixedNow });

    await expect(service.mintOneRunDelegation(connection, runRequest)).rejects.toMatchObject({ code: "CHILD_RUN_SECRET_BOUNDARY_VIOLATION" });
    expect(() => assertNoChildRunSecrets({ env: { DATABASE_URL: "postgres://secret", refresh_token: "secret" } })).toThrow(/DATABASE_URL/);
  });
});
