import { describe, expect, it } from "vitest";
import { HttpError } from "@/lib/api/responses";
import { assertAgentRunCaps } from "@/lib/agent-home/runCaps";
import type { AgentRun } from "@/lib/types";

function run(overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id: "run_test",
    agentHomeId: "home_test",
    connectionId: "conn_test",
    challengeId: "challenge_test",
    contributorId: "runner-user",
    requestedMode: "critique",
    requestedModel: "fake-frontier-model",
    requestClass: "contribution_card",
    status: "contributed",
    idempotencyKey: "key_test",
    createdAt: "1970-01-01T00:00:10.000Z",
    updatedAt: "1970-01-01T00:00:10.000Z",
    queuedAt: "1970-01-01T00:00:10.000Z",
    ...overrides,
  };
}

describe("Agent run caps", () => {
  it("bypasses caps in ordinary test runs unless explicitly enforced", () => {
    expect(assertAgentRunCaps({ ownerId: "runner-user", challengeId: "challenge_test", runs: [run({ status: "queued" })] })).toMatchObject({ allowed: true, activeCount: 0 });
  });

  it("blocks cooldown retries with reset metadata", () => {
    let thrown: unknown;
    try {
      assertAgentRunCaps({
        ownerId: "runner-user",
        challengeId: "challenge_next",
        runs: [run({ createdAt: "1970-01-01T00:00:10.000Z" })],
        nowMs: 12_000,
        enforce: true,
        policy: { cooldownMs: 5_000, ownerDailyLimit: 10, perChallengeDailyLimit: 10 },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpError);
    expect(thrown).toMatchObject({
      status: 429,
      code: "agent_run_cooldown",
      details: {
        policy: "owner_cooldown",
        resetAt: "1970-01-01T00:00:15.000Z",
        retryAfterMs: 3_000,
        manualPasteFallback: expect.stringContaining("Manual paste"),
      },
    });
  });

  it("blocks per-challenge cap while allowing old runs outside the window", () => {
    expect(() => assertAgentRunCaps({
      ownerId: "runner-user",
      challengeId: "challenge_test",
      runs: [run({ createdAt: "1970-01-01T00:00:10.000Z" })],
      nowMs: 20_000,
      enforce: true,
      policy: { cooldownMs: 0, dailyWindowMs: 60_000, perChallengeDailyLimit: 1, ownerDailyLimit: 10 },
    })).toThrow(HttpError);

    expect(assertAgentRunCaps({
      ownerId: "runner-user",
      challengeId: "challenge_test",
      runs: [run({ createdAt: "1970-01-01T00:00:10.000Z" })],
      nowMs: 80_001,
      enforce: true,
      policy: { cooldownMs: 0, dailyWindowMs: 60_000, perChallengeDailyLimit: 1, ownerDailyLimit: 10 },
    })).toMatchObject({ allowed: true, challengeDailyCount: 0 });
  });
});
