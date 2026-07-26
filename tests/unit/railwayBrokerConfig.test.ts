import { describe, expect, it } from "vitest";
import { SandboxRunPolicyError } from "@/lib/sandbox/broker";
import { createRailwaySandboxBroker, DEFAULT_RAILWAY_SANDBOX_CHECKPOINT, normalizeRailwaySandboxBrokerConfig, RAILWAY_SANDBOX_UNAVAILABLE, RailwaySandboxUnavailableError, validateRailwaySandboxBrokerConfig } from "@/lib/sandbox/railwayBroker";

const signingKey = { keyId: "railway-test", secret: "railway-secret" };

const request = {
  challengeId: "challenge-1",
  contributorId: "user-1",
  contributionMode: "critique" as const,
  challengeBundle: { title: "Test challenge", original_ai_answer: "Original" },
  provider: "fake-provider",
  requestedModel: "fake-model",
  agentConnection: {
    connection_id: "conn_1",
    provider: "fake-provider",
    allowed_model: "fake-model",
    expires_at: "2026-06-28T01:00:00.000Z",
    max_requests: 1,
  },
};

describe("Railway sandbox broker seam", () => {
  it("defaults to isolated networking and the approved checkpoint", () => {
    expect(normalizeRailwaySandboxBrokerConfig({ environmentId: "env_123" })).toMatchObject({
      environmentId: "env_123",
      checkpoint: DEFAULT_RAILWAY_SANDBOX_CHECKPOINT,
      networkIsolation: "ISOLATED",
      idleTimeoutMinutes: 5,
    });
    expect(validateRailwaySandboxBrokerConfig({ environmentId: "env_123" })).toEqual([]);
  });

  it("rejects private networking and checkpoint overrides for untrusted Railway config", () => {
    const issues = validateRailwaySandboxBrokerConfig({ environmentId: "env_123", networkIsolation: "PRIVATE", checkpoint: "attacker" });
    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining("ISOLATED"),
      expect.stringContaining("approved CMAI Hermes runner checkpoint"),
    ]));
  });

  it("fails safely when the Railway environment id is missing", async () => {
    const broker = createRailwaySandboxBroker({}, signingKey);
    await expect(broker.run(request)).rejects.toMatchObject({ code: RAILWAY_SANDBOX_UNAVAILABLE });
  });

  it("imports and fails with a stable unavailable error when SDK credentials are not wired", async () => {
    const broker = createRailwaySandboxBroker({ environmentId: "env_123" }, signingKey);
    await expect(broker.run(request)).rejects.toBeInstanceOf(RailwaySandboxUnavailableError);
  });

  it("rejects untrusted private networking before attempting Railway execution", async () => {
    const broker = createRailwaySandboxBroker({ environmentId: "env_123", networkIsolation: "PRIVATE" }, signingKey);
    await expect(broker.run(request)).rejects.toBeInstanceOf(SandboxRunPolicyError);
  });

  it("rejects broker/provider secrets in Railway sandbox config", async () => {
    const broker = createRailwaySandboxBroker({ environmentId: "env_123" }, signingKey);
    await expect(broker.run({
      ...request,
      config: { env: { DATABASE_URL: "postgres://secret", OPENAI_API_KEY: "sk-secret" } },
    })).rejects.toBeInstanceOf(SandboxRunPolicyError);
  });
});
