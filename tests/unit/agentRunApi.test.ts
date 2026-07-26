import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as createAgentRunPost } from "@/app/api/challenges/[id]/agent-runs/route";
import { GET as getAgentRun } from "@/app/api/agent-runs/[id]/route";
import { createAgentRunForChallenge, runDelegationService } from "@/lib/agent-home/runRequests";
import {
  createAgentHomeConnection,
  createAgentRun,
  createChallenge,
  createJob,
  getAgentConnectionCredential,
  getAgentHomeConnection,
  getJob,
  listContributions,
  listAgentRuns,
  recordAgentConnectionSmoke,
  reserveAgentRun,
  resetStoreForTests,
  updateAgentRun,
} from "@/lib/store";
import type { ChallengeBrief, ContributionMode } from "@/lib/types";
import { isFakeOrDevAgentProvider, isProductionBlockedAgentConnection } from "@/lib/agent-home/connectionPolicy";
import { resetRateLimitsForTests } from "@/lib/security/rateLimit";
import { createChallengeSemantics } from "@/lib/challenges/intent";

const brief: ChallengeBrief = {
  schema_version: "1.0",
  ...createChallengeSemantics({ intent: "solve", successCriteria: ["Find risky assumptions"], status: "confirmed", changeReason: "Confirmed Agent run fixture criteria." }),
  title: "Agent run challenge",
  category: "product",
  challenge_mode_requested: ["critique"],
  problem_statement: "Pressure-test this answer.",
  original_ai_answer: "Ship it as-is.",
  context: "Local test context.",
  constraints: ["No challenge-provided code execution."],
  success_criteria: ["Find risky assumptions"],
  assumptions_to_test: ["Users want this exact flow"],
  claims_to_check: ["The answer is safe to act on"],
  known_risks: ["False confidence"],
  what_a_useful_response_should_address: ["Risks", "Alternatives"],
  privacy_sensitivity: "public_ok",
  redactions_made: [],
  abuse_or_safety_flags: [],
  missing_information: [],
  raw_material_summary: "Agent-run API test challenge",
};

function request(body: unknown, userId = "runner-user", headers: Record<string, string> = {}) {
  return new Request("http://test.local/api", {
    method: "POST",
    headers: { "content-type": "application/json", "x-cmai-user-id": userId, ...headers },
    body: JSON.stringify(body),
  });
}

async function readyConnection(ownerId = "runner-user", allowedRequestClasses: ContributionMode[] = ["critique"]) {
  const { connection } = await createAgentHomeConnection({ ownerId, ownerLabel: "Runner User", provider: "fake-provider", defaultModel: "fake-frontier-model", allowedModels: ["fake-frontier-model"], allowedRequestClasses });
  const smoke = await recordAgentConnectionSmoke({ ownerId, connectionId: connection.id, ok: true, message: "Fake smoke passed." });
  return smoke.connection;
}

async function readyProviderConnection(ownerId = "runner-user", provider = "openrouter") {
  const model = `${provider}/frontier-model`;
  const { connection } = await createAgentHomeConnection({ ownerId, ownerLabel: "Runner User", provider, defaultModel: model, allowedModels: [model], allowedRequestClasses: ["critique"] });
  const smoke = await recordAgentConnectionSmoke({ ownerId, connectionId: connection.id, ok: true, message: "Provider smoke passed." });
  return smoke.connection;
}

const codexSessionSecret = JSON.stringify({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: {
    id_token: "codex-run-id-token-fixture-123456789",
    access_token: "codex-run-access-token-fixture-123456789",
    refresh_token: "codex-run-refresh-token-fixture-123456789",
    account_id: "acct_codex_run_fixture_123456789",
  },
  last_refresh: "2026-07-02T12:10:00.000Z",
});

const runnerUser = { id: "runner-user", name: "Runner User", role: "user" as const, authSource: "local-dev" as const };
const envStubs = new Map<string, string | undefined>();

function setEnv(key: string, value: string) {
  if (!envStubs.has(key)) envStubs.set(key, process.env[key]);
  process.env[key] = value;
}

function restoreEnv() {
  for (const [key, value] of envStubs) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  envStubs.clear();
}

function stubProductionEnv(overrides: Record<string, string> = {}) {
  setEnv("CMAI_RUNTIME_ENV", "production");
  setEnv("NODE_ENV", "test");
  for (const [key, value] of Object.entries(overrides)) setEnv(key, value);
}

describe("agent run request APIs", () => {
  beforeEach(async () => {
    await resetStoreForTests();
    resetRateLimitsForTests();
  });

  afterEach(() => {
    restoreEnv();
    resetRateLimitsForTests();
  });

  it("identifies fake/dev Agent connections that production must not run even if stale persisted", () => {
    expect(isFakeOrDevAgentProvider("local_fake")).toBe(true);
    expect(isFakeOrDevAgentProvider("fake-provider")).toBe(true);
    expect(isFakeOrDevAgentProvider("test_fake_provider")).toBe(true);
    expect(isFakeOrDevAgentProvider("openrouter")).toBe(false);
    expect(isProductionBlockedAgentConnection({ provider: "openrouter", connectionKind: "provider_key" })).toBe(false);
    expect(isProductionBlockedAgentConnection({ provider: "openrouter", connectionKind: "test_fake" })).toBe(true);
    expect(isProductionBlockedAgentConnection({ provider: "local_fake", connectionKind: "provider_key" })).toBe(true);
  });

  it("creates a trusted Agent run for a ready connection and records a redacted completed lifecycle", async () => {
    const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 10, brief });
    const connection = await readyConnection();

    const response = await createAgentRunPost(request({ connectionId: connection.id, approved: true, idempotencyKey: "run-key-1" }), { params: Promise.resolve({ id: challenge.id }) });
    expect(response.status).toBe(200);
    const json = await response.json();

    expect(json.reused).toBe(false);
    expect(json.run).toMatchObject({ status: "contributed", contributionMode: "critique", sandboxProvider: "local_fake", trustLabel: "sandboxed Hermes run" });
    expect(json.run.contributionId).toBeTruthy();
    expect(json.run.receiptSummary).toMatchObject({ sandboxProvider: "local_fake", networkIsolation: "ISOLATED", teardownCompleted: true, provider: "fake-provider" });
    expect(JSON.stringify(json.run)).not.toContain("signature");
    expect(JSON.stringify(json.run)).not.toContain("transcript");

    const contributions = await listContributions(challenge.id);
    expect(contributions).toHaveLength(1);
    expect(contributions[0]?.card.model_provenance).toMatchObject({ source: "hermes_sandbox_run", run_id: json.run.id, sandbox_provider: "local_fake" });
    const job = await getJob(json.run.jobId);
    expect(job).toMatchObject({ kind: "agent_run", status: "succeeded", provider: "fake-provider", model: "fake-frontier-model" });
  });

  it("blocks API-only real-provider connections from normal-user Run my Agent here readiness", async () => {
    const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 10, brief });
    const connection = await readyProviderConnection();

    const response = await createAgentRunPost(request({ connectionId: connection.id, approved: true, idempotencyKey: "real-provider-no-adapter-key" }), { params: Promise.resolve({ id: challenge.id }) });
    expect(response.status).toBe(409);
    const json = await response.json();

    expect(json).toMatchObject({ code: "agent_connection_not_ready", details: { issues: expect.arrayContaining([expect.stringContaining("not normal-user plan auth")]) } });
    expect(JSON.stringify(json)).not.toContain("local_dev_credential");
    expect(await listContributions(challenge.id)).toHaveLength(0);
  });

  it("keeps the configured model proxy URL inside child-run config and out of public run payloads", async () => {
    setEnv("CMAI_MODEL_PROXY_URL", "https://model-proxy.internal.example/run");
    const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 10, brief });
    const connection = await readyConnection();

    const service = runDelegationService(connection);
    const grant = await service.mintDelegation({
      runId: "run_model_proxy",
      challengeId: challenge.id,
      contributor: { id: "runner-user", label: "Runner User", ownerId: "runner-user" },
      connection: { id: connection.id, provider: connection.provider, requestedModel: connection.defaultModel },
      contributionMode: "critique",
    });
    expect(grant.childRunConfig?.model_proxy_url).toBe("https://model-proxy.internal.example/run");

    const response = await createAgentRunPost(request({ connectionId: connection.id, approved: true, idempotencyKey: "model-proxy-public-key" }), { params: Promise.resolve({ id: challenge.id }) });
    const json = await response.json();
    expect(json.run).toMatchObject({ status: "contributed" });
    expect(JSON.stringify(json)).not.toContain("model-proxy.internal.example");
  });

  it("keeps OpenRouter model-proxy scaffolding available but blocks normal-user trusted runs", async () => {
    setEnv("OPENROUTER_API_KEY", "sk-or-secret-api-key");
    setEnv("CMAI_MODEL_PROXY_URL", "https://model-proxy.internal.example/api/agent-home/model-proxy");
    const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 10, brief });
    const connection = await readyProviderConnection();

    const service = runDelegationService(connection);
    const grant = await service.mintDelegation({
      runId: "run_openrouter_proxy",
      challengeId: challenge.id,
      contributor: { id: "runner-user", label: "Runner User", ownerId: "runner-user" },
      connection: { id: connection.id, provider: connection.provider, requestedModel: connection.defaultModel },
      contributionMode: "critique",
    });
    expect(grant.childRunConfig).toMatchObject({
      provider: "openrouter",
      allowed_model: connection.defaultModel,
      model_proxy_url: "https://model-proxy.internal.example/api/agent-home/model-proxy",
      max_requests: 1,
    });
    expect(JSON.stringify(grant)).not.toContain("sk-or-secret-api-key");

    const response = await createAgentRunPost(request({ connectionId: connection.id, approved: true, idempotencyKey: "openrouter-model-proxy-key" }), { params: Promise.resolve({ id: challenge.id }) });
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json).toMatchObject({ code: "agent_connection_not_ready", details: { issues: expect.arrayContaining([expect.stringContaining("not normal-user plan auth")]) } });
    const publicPayload = JSON.stringify(json);
    expect(publicPayload).not.toContain("«redacted:sk-…»");
    expect(publicPayload).not.toContain("model-proxy.internal.example");
    expect(await listContributions(challenge.id)).toHaveLength(0);
  });

  it("keeps Anthropic API scaffolding separate from the Claude Code plan path", async () => {
    setEnv("CMAI_MODEL_PROXY_URL", "https://model-proxy.internal.example/api/agent-home/model-proxy");
    const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 10, brief });
    const { connection: created } = await createAgentHomeConnection({
      ownerId: "runner-user",
      ownerLabel: "Runner User",
      provider: "anthropic",
      providerSecret: "anthropic-secret-key",
      defaultModel: "claude-sonnet-4-20250514",
      allowedModels: ["claude-sonnet-4-20250514"],
      allowedRequestClasses: ["critique"],
    });
    const { connection } = await recordAgentConnectionSmoke({ ownerId: "runner-user", connectionId: created.id, ok: true, message: "Anthropic smoke passed." });

    const service = runDelegationService(connection);
    const grant = await service.mintDelegation({
      runId: "run_anthropic_proxy",
      challengeId: challenge.id,
      contributor: { id: "runner-user", label: "Runner User", ownerId: "runner-user" },
      connection: { id: connection.id, provider: connection.provider, requestedModel: connection.defaultModel },
      contributionMode: "critique",
    });
    expect(grant.childRunConfig).toMatchObject({
      provider: "anthropic",
      allowed_model: "claude-sonnet-4-20250514",
      model_proxy_url: "https://model-proxy.internal.example/api/agent-home/model-proxy",
      max_requests: 1,
    });
    expect(JSON.stringify(grant)).not.toContain("anthropic-secret-key");

    const response = await createAgentRunPost(request({ connectionId: connection.id, approved: true, idempotencyKey: "anthropic-model-proxy-key" }), { params: Promise.resolve({ id: challenge.id }) });
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json).toMatchObject({ code: "agent_connection_not_ready", details: { issues: expect.arrayContaining([expect.stringContaining("separate `claude_code` official-CLI path")]) } });
    const publicPayload = JSON.stringify(json);
    expect(publicPayload).not.toContain("anthropic-secret-key");
    expect(publicPayload).not.toContain("model-proxy.internal.example");
    expect(await listContributions(challenge.id)).toHaveLength(0);
  });

  it("keeps OpenAI Responses API scaffolding separate from the Codex/ChatGPT plan path", async () => {
    setEnv("CMAI_MODEL_PROXY_URL", "https://model-proxy.internal.example/api/agent-home/model-proxy");
    const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 10, brief });
    const { connection: created } = await createAgentHomeConnection({
      ownerId: "runner-user",
      ownerLabel: "Runner User",
      provider: "openai",
      providerSecret: "sk-openai-secret",
      defaultModel: "gpt-5.6-sol",
      allowedModels: ["gpt-5.6-sol"],
      allowedRequestClasses: ["critique"],
    });
    const { connection } = await recordAgentConnectionSmoke({ ownerId: "runner-user", connectionId: created.id, ok: true, message: "OpenAI smoke passed." });

    const service = runDelegationService(connection);
    const grant = await service.mintDelegation({
      runId: "run_openai_proxy",
      challengeId: challenge.id,
      contributor: { id: "runner-user", label: "Runner User", ownerId: "runner-user" },
      connection: { id: connection.id, provider: connection.provider, requestedModel: connection.defaultModel },
      contributionMode: "critique",
    });
    expect(grant.childRunConfig).toMatchObject({
      provider: "openai",
      allowed_model: "gpt-5.6-sol",
      model_proxy_url: "https://model-proxy.internal.example/api/agent-home/model-proxy",
      max_requests: 1,
    });
    expect(JSON.stringify(grant)).not.toContain("sk-openai-secret");

    const response = await createAgentRunPost(request({ connectionId: connection.id, approved: true, idempotencyKey: "openai-model-proxy-key" }), { params: Promise.resolve({ id: challenge.id }) });
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json).toMatchObject({ code: "agent_connection_not_ready", details: { issues: expect.arrayContaining([expect.stringContaining("not Codex/ChatGPT subscription auth")]) } });
    const publicPayload = JSON.stringify(json);
    expect(publicPayload).not.toContain("«redacted:sk-…»");
    expect(publicPayload).not.toContain("model-proxy.internal.example");
    expect(await listContributions(challenge.id)).toHaveLength(0);
  });

  it("authenticates Codex once, requires fresh approval for two challenges, and keeps separate receipts and sandboxes", async () => {
    setEnv("CMAI_MODEL_PROXY_URL", "https://model-proxy.internal.example/api/agent-home/model-proxy");
    const challengeA = await createChallenge({ posterId: "poster", visibility: "public", reward: 10, brief: { ...brief, title: "Codex reuse challenge A" } });
    const challengeB = await createChallenge({ posterId: "poster", visibility: "public", reward: 10, brief: { ...brief, title: "Codex reuse challenge B" } });
    const { connection: created } = await createAgentHomeConnection({
      ownerId: "runner-user",
      ownerLabel: "Runner User",
      provider: "codex",
      providerSecret: codexSessionSecret,
      defaultModel: "gpt-5.6-sol",
      allowedModels: ["gpt-5.6-sol"],
      allowedRequestClasses: ["critique"],
    });
    const { connection } = await recordAgentConnectionSmoke({ ownerId: "runner-user", connectionId: created.id, ok: true, message: "Codex device login completed." });
    const connectedCredential = await getAgentConnectionCredential({ ownerId: "runner-user", connectionId: connection.id });
    expect(connectedCredential?.revision).toBe(1);

    const missingApprovalA = await createAgentRunPost(request({ connectionId: connection.id, idempotencyKey: "codex-reuse-a-unapproved" }), { params: Promise.resolve({ id: challengeA.id }) });
    expect(missingApprovalA.status).toBe(400);
    expect(await missingApprovalA.json()).toMatchObject({ code: "approval_required" });

    const responseA = await createAgentRunPost(request({ connectionId: connection.id, approved: true, idempotencyKey: "codex-reuse-a" }), { params: Promise.resolve({ id: challengeA.id }) });
    expect(responseA.status).toBe(200);
    const jsonA = await responseA.json();
    expect(jsonA.run).toMatchObject({ status: "contributed", contributionMode: "critique", receiptSummary: expect.objectContaining({ provider: "codex", requestedModel: "gpt-5.6-sol", providerModelVerified: false }) });

    const betweenRuns = await getAgentHomeConnection({ ownerId: "runner-user", connectionId: connection.id });
    expect(betweenRuns).toMatchObject({ id: connection.id, status: "ready", readiness: expect.objectContaining({ canRunHere: true }) });

    const missingApprovalB = await createAgentRunPost(request({ connectionId: connection.id, idempotencyKey: "codex-reuse-b-unapproved" }), { params: Promise.resolve({ id: challengeB.id }) });
    expect(missingApprovalB.status).toBe(400);
    expect(await missingApprovalB.json()).toMatchObject({ code: "approval_required" });

    const responseB = await createAgentRunPost(request({ connectionId: connection.id, approved: true, idempotencyKey: "codex-reuse-b" }), { params: Promise.resolve({ id: challengeB.id }) });
    expect(responseB.status).toBe(200);
    const jsonB = await responseB.json();
    expect(jsonB.run).toMatchObject({ status: "contributed", contributionMode: "critique", receiptSummary: expect.objectContaining({ provider: "codex", requestedModel: "gpt-5.6-sol", providerModelVerified: false }) });

    expect(jsonA.run.id).not.toBe(jsonB.run.id);
    expect(jsonA.run.contributionId).not.toBe(jsonB.run.contributionId);
    const storedRuns = await listAgentRuns({ ownerId: "runner-user" });
    const storedA = storedRuns.find((run) => run.id === jsonA.run.id);
    const storedB = storedRuns.find((run) => run.id === jsonB.run.id);
    expect(storedA?.receiptSummary?.receiptId).toBeTruthy();
    expect(storedB?.receiptSummary?.receiptId).toBeTruthy();
    expect(storedA?.receiptSummary?.receiptId).not.toBe(storedB?.receiptSummary?.receiptId);
    expect(storedA?.receiptSummary?.receiptSha256).not.toBe(storedB?.receiptSummary?.receiptSha256);
    expect(storedA?.receiptSummary?.sandboxId).not.toBe(storedB?.receiptSummary?.sandboxId);
    expect(await listContributions(challengeA.id)).toHaveLength(1);
    expect(await listContributions(challengeB.id)).toHaveLength(1);
    expect(storedRuns).toHaveLength(2);

    const afterRuns = await getAgentHomeConnection({ ownerId: "runner-user", connectionId: connection.id });
    const afterCredential = await getAgentConnectionCredential({ ownerId: "runner-user", connectionId: connection.id });
    expect(afterRuns).toMatchObject({ id: connection.id, status: "ready", readiness: expect.objectContaining({ canRunHere: true }) });
    expect(afterCredential?.revision).toBe(1);

    const serialized = JSON.stringify({ jsonA, jsonB, afterRuns });
    expect(serialized).not.toContain("codex-run-access-token-fixture");
    expect(serialized).not.toContain("codex-run-refresh-token-fixture");
    expect(serialized).not.toContain("model-proxy.internal.example");
  });

  it("fails closed for production Agent-run setup before posting contributions", async () => {
    const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 10, brief });
    const realConnection = await readyProviderConnection();
    const fakeConnection = await readyConnection();

    stubProductionEnv();
    await expect(createAgentRunForChallenge(request({ connectionId: fakeConnection.id, approved: true, idempotencyKey: "prod-fake-key" }), challenge.id, runnerUser)).rejects.toMatchObject({
      status: 409,
      code: "agent_connection_provider_not_allowed",
    });

    await expect(createAgentRunForChallenge(request({ connectionId: realConnection.id, approved: true, idempotencyKey: "prod-api-only-key" }), challenge.id, runnerUser)).rejects.toMatchObject({
      status: 409,
      code: "agent_connection_not_ready",
      details: { issues: expect.arrayContaining([expect.stringContaining("not normal-user plan auth")]) },
    });
    expect(await listContributions(challenge.id)).toHaveLength(0);
  });

  it("requires explicit approval before creating a run", async () => {
    const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 10, brief });
    const connection = await readyConnection();

    const response = await createAgentRunPost(request({ connectionId: connection.id }), { params: Promise.resolve({ id: challenge.id }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "approval_required" });
    expect(await listContributions(challenge.id)).toHaveLength(0);
  });

  it("requires an idempotency key before creating an approved run", async () => {
    const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 10, brief });
    const connection = await readyConnection();

    const response = await createAgentRunPost(request({ connectionId: connection.id, approved: true }), { params: Promise.resolve({ id: challenge.id }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "idempotency_key_required" });
    expect(await listContributions(challenge.id)).toHaveLength(0);
  });

  it("allows a valid non-requested contribution angle when the connection supports it", async () => {
    const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 10, brief });
    const connection = await readyConnection("runner-user", ["critique", "red_team"]);

    const response = await createAgentRunPost(request({ connectionId: connection.id, approved: true, contributionMode: "red_team", idempotencyKey: "other-angle-key" }), { params: Promise.resolve({ id: challenge.id }) });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.run).toMatchObject({ status: "contributed", contributionMode: "red_team" });
  });

  it("defaults advanced-only requested perspectives to critique when no contribution angle is provided", async () => {
    const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 10, brief: { ...brief, challenge_mode_requested: ["judge"] } });
    const connection = await readyConnection();

    const response = await createAgentRunPost(request({ connectionId: connection.id, approved: true, idempotencyKey: "advanced-default-key" }), { params: Promise.resolve({ id: challenge.id }) });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.run).toMatchObject({ status: "contributed", contributionMode: "critique" });
  });

  it("rejects missing readiness, connection-blocked modes, private challenges, and wrong owners with stable errors", async () => {
    const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 10, brief });
    const privateChallenge = await createChallenge({ posterId: "poster", visibility: "private", reward: 10, brief: { ...brief, title: "Private" } });
    const { connection: unready } = await createAgentHomeConnection({ ownerId: "runner-user", provider: "fake-provider", allowedRequestClasses: ["critique"] });
    const ready = await readyConnection("other-user");
    const readySelf = await readyConnection("runner-user");

    const unreadyResponse = await createAgentRunPost(request({ connectionId: unready.id, approved: true, idempotencyKey: "unready-key" }), { params: Promise.resolve({ id: challenge.id }) });
    expect(unreadyResponse.status).toBe(409);
    expect(await unreadyResponse.json()).toMatchObject({ code: "agent_connection_not_ready" });

    const wrongOwner = await createAgentRunPost(request({ connectionId: ready.id, approved: true, idempotencyKey: "wrong-owner-key" }), { params: Promise.resolve({ id: challenge.id }) });
    expect(wrongOwner.status).toBe(404);
    expect(await wrongOwner.json()).toMatchObject({ code: "agent_connection_not_found" });

    const unsupported = await createAgentRunPost(request({ connectionId: readySelf.id, approved: true, contributionMode: "red_team", idempotencyKey: "unsupported-key" }), { params: Promise.resolve({ id: challenge.id }) });
    expect(unsupported.status).toBe(409);
    expect(await unsupported.json()).toMatchObject({ code: "agent_connection_not_ready" });

    const privateResponse = await createAgentRunPost(request({ connectionId: unready.id, approved: true, idempotencyKey: "private-key" }), { params: Promise.resolve({ id: privateChallenge.id }) });
    expect(privateResponse.status).toBe(404);
  });

  it("replays an idempotency key without double-posting a contribution", async () => {
    setEnv("CMAI_ENFORCE_RATE_LIMITS", "1");
    setEnv("CMAI_AGENT_RUN_COOLDOWN_MS", "0");
    setEnv("CMAI_AGENT_RUN_OWNER_DAILY_LIMIT", "1");
    const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 10, brief });
    const connection = await readyConnection();
    const first = await createAgentRunPost(request({ connectionId: connection.id, approved: true, idempotencyKey: "same-key" }), { params: Promise.resolve({ id: challenge.id }) });
    const firstJson = await first.json();

    const second = await createAgentRunPost(request({ connectionId: connection.id, approved: true, idempotencyKey: "same-key" }), { params: Promise.resolve({ id: challenge.id }) });
    const secondJson = await second.json();

    expect(secondJson.reused).toBe(true);
    expect(secondJson.run.id).toBe(firstJson.run.id);
    expect(secondJson.run.contributionId).toBe(firstJson.run.contributionId);
    expect(await listContributions(challenge.id)).toHaveLength(1);
    expect(await listAgentRuns({ ownerId: "runner-user" })).toHaveLength(1);
  });

  it("blocks a new trusted run before side effects when the owner has an active run", async () => {
    setEnv("CMAI_ENFORCE_RATE_LIMITS", "1");
    const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 10, brief });
    const connection = await readyConnection();
    const job = await createJob({ challengeId: challenge.id, kind: "agent_run", provider: connection.provider, model: connection.defaultModel, promptVersion: "agent-run-v1" });
    await createAgentRun({ agentHomeId: connection.agentHomeId, connectionId: connection.id, challengeId: challenge.id, contributorId: "runner-user", requestedMode: "critique", requestedModel: connection.defaultModel, idempotencyKey: "active-existing", jobId: job.id });

    const response = await createAgentRunPost(request({ connectionId: connection.id, approved: true, idempotencyKey: "active-blocked" }), { params: Promise.resolve({ id: challenge.id }) });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "agent_run_concurrency_limit", details: { policy: "active_owner_limit", manualPasteFallback: expect.stringContaining("Manual paste") } });
    expect(await listAgentRuns({ ownerId: "runner-user" })).toHaveLength(1);
    expect(await listContributions(challenge.id)).toHaveLength(0);
  });

  it("reserves trusted Agent runs atomically with idempotency and cap checks", async () => {
    setEnv("CMAI_ENFORCE_RATE_LIMITS", "1");
    const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 10, brief });
    const connection = await readyConnection();
    const first = await reserveAgentRun({
      agentHomeId: connection.agentHomeId,
      connectionId: connection.id,
      challengeId: challenge.id,
      contributorId: "runner-user",
      requestedMode: "critique",
      requestedModel: connection.defaultModel,
      provider: connection.provider,
      idempotencyKey: "reserve-key-1",
      promptVersion: "agent-run-v1",
    });

    expect(first).toMatchObject({ reused: false, run: { status: "queued", jobId: first.job?.id }, job: { kind: "agent_run", status: "queued" } });
    await expect(reserveAgentRun({
      agentHomeId: connection.agentHomeId,
      connectionId: connection.id,
      challengeId: challenge.id,
      contributorId: "runner-user",
      requestedMode: "critique",
      requestedModel: connection.defaultModel,
      provider: connection.provider,
      idempotencyKey: "reserve-key-2",
      promptVersion: "agent-run-v1",
    })).rejects.toMatchObject({ code: "agent_run_concurrency_limit" });

    const replay = await reserveAgentRun({
      agentHomeId: connection.agentHomeId,
      connectionId: connection.id,
      challengeId: challenge.id,
      contributorId: "runner-user",
      requestedMode: "critique",
      requestedModel: connection.defaultModel,
      provider: connection.provider,
      idempotencyKey: "reserve-key-1",
      promptVersion: "agent-run-v1",
    });
    expect(replay).toMatchObject({ reused: true, run: { id: first.run.id, jobId: first.job?.id } });
    expect(await listAgentRuns({ ownerId: "runner-user" })).toHaveLength(1);
    expect(await getJob(first.job?.id || "missing")).toMatchObject({ status: "queued", provider: connection.provider, model: connection.defaultModel });
  });

  it("blocks trusted runs after the owner daily cap before creating a new run", async () => {
    setEnv("CMAI_ENFORCE_RATE_LIMITS", "1");
    setEnv("CMAI_AGENT_RUN_COOLDOWN_MS", "0");
    setEnv("CMAI_AGENT_RUN_OWNER_DAILY_LIMIT", "1");
    setEnv("CMAI_AGENT_RUN_CHALLENGE_DAILY_LIMIT", "99");
    const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 10, brief });
    const connection = await readyConnection();
    const job = await createJob({ challengeId: challenge.id, kind: "agent_run", provider: connection.provider, model: connection.defaultModel, promptVersion: "agent-run-v1" });
    const previous = await createAgentRun({ agentHomeId: connection.agentHomeId, connectionId: connection.id, challengeId: challenge.id, contributorId: "runner-user", requestedMode: "critique", requestedModel: connection.defaultModel, idempotencyKey: "daily-existing", jobId: job.id });
    await updateAgentRun({ id: previous.id, status: "contributed" });

    const response = await createAgentRunPost(request({ connectionId: connection.id, approved: true, idempotencyKey: "daily-blocked" }), { params: Promise.resolve({ id: challenge.id }) });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "agent_run_daily_cap_exceeded", details: { policy: "owner_daily_limit", limit: 1, count: 1, retryAfterMs: expect.any(Number), manualPasteFallback: expect.stringContaining("Manual paste") } });
    expect(await listAgentRuns({ ownerId: "runner-user" })).toHaveLength(1);
  });

  it("polls completed and failed runs without returning raw receipt or transcript data", async () => {
    const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 10, brief });
    const connection = await readyConnection();
    const created = await createAgentRunPost(request({ connectionId: connection.id, approved: true, idempotencyKey: "poll-key" }), { params: Promise.resolve({ id: challenge.id }) });
    const createdJson = await created.json();

    const poll = await getAgentRun(new Request("http://test.local/api/agent-runs/one", { headers: { "x-cmai-user-id": "runner-user" } }), { params: Promise.resolve({ id: createdJson.run.id }) });
    expect(poll.status).toBe(200);
    const polled = await poll.json();
    expect(polled.run).toMatchObject({ id: createdJson.run.id, status: "contributed", contributionId: createdJson.run.contributionId });
    expect(polled.run.receiptSummary.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(polled.run)).not.toContain("signature");
    expect(JSON.stringify(polled.run)).not.toContain("transcript");

    const job = await createJob({ challengeId: challenge.id, kind: "agent_run", provider: "fake-provider", model: "fake-frontier-model", promptVersion: "agent-run-v1" });
    const failed = await createAgentRun({ agentHomeId: connection.agentHomeId, connectionId: connection.id, challengeId: challenge.id, contributorId: "runner-user", requestedMode: "critique", requestedModel: "fake-frontier-model", jobId: job.id });
    await updateAgentRun({ id: failed.id, status: "failed", failure: { code: "sandbox_run_failed", message: "Fake failure", failedAt: "2026-06-28T00:00:00.000Z" } });

    const failedPoll = await getAgentRun(new Request("http://test.local/api/agent-runs/fail", { headers: { "x-cmai-user-id": "runner-user" } }), { params: Promise.resolve({ id: failed.id }) });
    expect(failedPoll.status).toBe(200);
    expect(await failedPoll.json()).toMatchObject({ run: { status: "failed", failure: { code: "sandbox_run_failed" }, manualPasteFallback: expect.stringContaining("Manual paste") } });
  });
});
