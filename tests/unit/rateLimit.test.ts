import { beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "@/lib/api/responses";
import { assertRateLimit, assertRateLimitPolicy, resetRateLimitsForTests } from "@/lib/security/rateLimit";

describe("rate limit policies", () => {
  beforeEach(() => {
    resetRateLimitsForTests();
  });

  it("allows calls up to the configured policy limit and reports recovery metadata", () => {
    const first = assertRateLimit({ key: "user-1", policy: "challenge_create", limit: 2, windowMs: 1_000, nowMs: 10_000, enforce: true });
    expect(first).toMatchObject({ allowed: true, policy: "challenge_create", limit: 2, windowMs: 1_000, remaining: 1, retryAfterMs: 1_000 });
    expect(first.resetAt).toBe("1970-01-01T00:00:11.000Z");

    const second = assertRateLimit({ key: "user-1", policy: "challenge_create", limit: 2, windowMs: 1_000, nowMs: 10_100, enforce: true });
    expect(second).toMatchObject({ remaining: 0, retryAfterMs: 900 });
  });

  it("rejects over-limit calls with structured 429 details and no raw identity key", () => {
    assertRateLimit({ key: "raw-user-key", policy: "manual_contribution_create", limit: 1, windowMs: 2_000, nowMs: 20_000, enforce: true });

    let thrown: unknown;
    try {
      assertRateLimit({ key: "raw-user-key", policy: "manual_contribution_create", limit: 1, windowMs: 2_000, nowMs: 20_250, enforce: true });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpError);
    expect(thrown).toMatchObject({
      status: 429,
      code: "rate_limited",
      message: "You have submitted several perspectives recently. Try again after the cooldown.",
      details: {
        policy: "manual_contribution_create",
        limit: 1,
        windowMs: 2_000,
        remaining: 0,
        resetAt: "1970-01-01T00:00:22.000Z",
        retryAfterMs: 1_750,
      },
    });
    expect(JSON.stringify((thrown as HttpError).details)).not.toContain("raw-user-key");
  });

  it("resets the bucket after the recovery window", () => {
    assertRateLimit({ key: "user-2", policy: "contribution_rating", limit: 1, windowMs: 500, nowMs: 30_000, enforce: true });
    expect(() => assertRateLimit({ key: "user-2", policy: "contribution_rating", limit: 1, windowMs: 500, nowMs: 30_250, enforce: true })).toThrow(HttpError);

    const recovered = assertRateLimit({ key: "user-2", policy: "contribution_rating", limit: 1, windowMs: 500, nowMs: 30_501, enforce: true });
    expect(recovered).toMatchObject({ remaining: 0, resetAt: "1970-01-01T00:00:31.001Z" });
  });

  it("keeps ordinary test runs bypassed unless the caller explicitly enforces a policy", () => {
    for (let index = 0; index < 10; index += 1) {
      expect(assertRateLimit({ key: "test-user", policy: "community_vote", limit: 1, windowMs: 1_000, nowMs: 40_000 + index })).toMatchObject({ policy: "community_vote", remaining: 1 });
    }

    assertRateLimit({ key: "test-user", policy: "community_vote", limit: 1, windowMs: 1_000, nowMs: 41_000, enforce: true });
    expect(() => assertRateLimit({ key: "test-user", policy: "community_vote", limit: 1, windowMs: 1_000, nowMs: 41_001, enforce: true })).toThrow(HttpError);
  });

  it("offers a typed policy wrapper for callers", () => {
    const result = assertRateLimitPolicy("model_proxy_dispatch", "delegation-1", { limit: 2, windowMs: 3_000, nowMs: 50_000, enforce: true });
    expect(result).toMatchObject({ policy: "model_proxy_dispatch", limit: 2, remaining: 1, retryAfterMs: 3_000 });
  });
});
