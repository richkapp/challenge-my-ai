import { describe, expect, it } from "vitest";
import { createClaudeCodeProviderAdapter } from "@/lib/agent-home/claudeCodeAdapter";
import { createAgentDelegationService } from "@/lib/agent-home/delegations";
import { InMemoryModelProxyRegistry } from "@/lib/agent-home/modelProxy";
import { createFakeAgentConnection, InMemoryAgentCredentialVault } from "@/lib/agent-home/testAdapters";

const fixedNow = new Date("2026-07-11T12:00:00.000Z");
const credential = {
  claudeAiOauth: {
    accessToken: "claude-adapter-access-token-fixture-123456",
    refreshToken: "claude-adapter-refresh-token-fixture-123456",
    expiresAt: Date.parse("2030-01-01T00:00:00.000Z"),
    subscriptionType: "max",
  },
};

describe("Claude Code provider adapter", () => {
  it("mints explicit one-use Claude session config without managed credential material", async () => {
    const vault = new InMemoryAgentCredentialVault();
    const registry = new InMemoryModelProxyRegistry({ now: () => fixedNow });
    await vault.putCredential({ ref: "cred_claude_1", provider: "claude_code", value: credential, createdAt: fixedNow.toISOString() });
    const connection = createFakeAgentConnection({
      id: "conn_claude_1",
      provider: "claude_code",
      connectionKind: "oauth",
      credentialRef: "cred_claude_1",
      defaultModel: "sonnet",
      allowedModels: ["sonnet", "opus"],
    });
    const adapter = createClaudeCodeProviderAdapter({
      vault,
      registry,
      modelProxyUrl: "https://broker.example.test/api/agent-home/model-proxy",
      cliAvailable: async () => true,
    });
    const service = createAgentDelegationService({
      adapters: [adapter],
      now: () => fixedNow,
      defaultTtlMs: 5 * 60 * 1000,
      modelProxyUrl: "https://broker.example.test/api/agent-home/model-proxy",
    });

    const smoke = await adapter.smokeTest(connection);
    expect(smoke).toMatchObject({ status: "passed", message: expect.stringContaining("official CLI") });

    const grant = await service.mintOneRunDelegation(connection, {
      runId: "run_claude_1",
      challengeId: "challenge_claude_1",
      contributorId: "user_claude_1",
      contributionMode: "critique",
      requestedModel: "sonnet",
      requestClass: "contribution_card",
      maxSpendCents: 0,
    });

    expect(grant.metadataVerification).toMatchObject({ providerModelVerified: false, verificationStatus: "sandbox_recorded", evidenceType: "hermes_run_receipt" });
    expect(grant.childRunConfig).toMatchObject({
      execution_mode: "claude_code_session",
      run_id: "run_claude_1",
      delegation_id: grant.delegation.delegation_id,
      agent_connection_id: connection.id,
      provider: "claude_code",
      allowed_model: "sonnet",
      model_proxy_url: "https://broker.example.test/api/agent-home/model-proxy",
      max_requests: 1,
    });
    expect(registry.get(grant.delegation.delegation_id || "")).toMatchObject({
      runId: "run_claude_1",
      provider: "claude_code",
      allowedModel: "sonnet",
      remainingRequests: 1,
    });
    const publicGrant = JSON.stringify(grant);
    expect(publicGrant).not.toContain("claude-adapter-access-token-fixture");
    expect(publicGrant).not.toContain("claude-adapter-refresh-token-fixture");
  });

  it("fails smoke closed when managed credentials or the official CLI are unavailable", async () => {
    const vault = new InMemoryAgentCredentialVault();
    const connection = createFakeAgentConnection({ id: "conn_missing", provider: "claude_code", connectionKind: "oauth", credentialRef: "missing", defaultModel: "sonnet", allowedModels: ["sonnet"] });
    const missing = createClaudeCodeProviderAdapter({ vault, modelProxyUrl: "https://broker.example.test/api/agent-home/model-proxy", cliAvailable: async () => true });
    expect(await missing.smokeTest(connection)).toMatchObject({ status: "failed", message: expect.stringContaining("Missing Claude Code") });

    await vault.putCredential({ ref: "missing", provider: "claude_code", value: credential, createdAt: fixedNow.toISOString() });
    const unavailable = createClaudeCodeProviderAdapter({ vault, modelProxyUrl: "https://broker.example.test/api/agent-home/model-proxy", cliAvailable: async () => false });
    expect(await unavailable.smokeTest(connection)).toMatchObject({ status: "failed", message: expect.stringContaining("not installed") });
  });
});
