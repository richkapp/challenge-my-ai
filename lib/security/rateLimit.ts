import crypto from "node:crypto";
import { HttpError } from "@/lib/api/responses";
import { env, isProductionLike, type RuntimeEnv } from "@/lib/config/env";

export const rateLimitPolicies = {
  authenticated_mutation: { limit: 600, windowMs: 60_000, message: "Too many account actions. Try again shortly." },
  agent_api: { limit: 600, windowMs: 60_000, message: "Too many Agent API requests. Try again shortly." },
  challenge_create: { limit: 6, windowMs: 60 * 60_000, message: "You have posted several challenges recently. Try again after the cooldown." },
  manual_contribution_create: { limit: 20, windowMs: 60 * 60_000, message: "You have submitted several perspectives recently. Try again after the cooldown." },
  manual_contribution_per_challenge: { limit: 8, windowMs: 60 * 60_000, message: "This challenge has received several submissions from you recently. Try again after the cooldown." },
  contribution_rating: { limit: 60, windowMs: 60_000, message: "Too many rating updates. Try again shortly." },
  community_vote: { limit: 120, windowMs: 60_000, message: "Too many community vote updates. Try again shortly." },
  agent_feed: { limit: 120, windowMs: 60_000, message: "Too many Agent feed requests. Try again shortly." },
  agent_watch: { limit: 60, windowMs: 60_000, message: "Too many Agent watch requests. Try again shortly." },
  agent_contribution: { limit: 30, windowMs: 60_000, message: "Too many Agent contribution requests. Try again shortly." },
  trusted_agent_run: { limit: 10, windowMs: 60_000, message: "Too many trusted Agent-run requests. Try again shortly." },
  model_proxy_dispatch: { limit: 3, windowMs: 60_000, message: "Too many model-proxy requests for this run. Try again shortly." },
} as const;

export type RateLimitPolicyName = keyof typeof rateLimitPolicies;

const buckets = new Map<string, { count: number; resetAt: number }>();

export type RateLimitInput = {
  key: string;
  limit?: number;
  windowMs?: number;
  runtime?: RuntimeEnv;
  policy?: RateLimitPolicyName | string;
  enforce?: boolean;
  nowMs?: number;
};

export type RateLimitResult = {
  allowed: true;
  policy: string;
  limit: number;
  windowMs: number;
  remaining: number;
  resetAt: string;
  retryAfterMs: number;
};

function policyDefaults(policy: RateLimitInput["policy"]) {
  return policy && policy in rateLimitPolicies ? rateLimitPolicies[policy as RateLimitPolicyName] : undefined;
}

function shouldBypass(runtime: RuntimeEnv, enforce?: boolean) {
  return !enforce && process.env.CMAI_ENFORCE_RATE_LIMITS !== "1" && !isProductionLike(runtime) && process.env.NODE_ENV === "test";
}

function hashedBucketKey(policy: string, key: string) {
  return crypto.createHash("sha256").update(`${policy}:${key}`).digest("hex");
}

function resultFor(input: { policy: string; limit: number; windowMs: number; count: number; resetAt: number; nowMs: number }): RateLimitResult {
  return {
    allowed: true,
    policy: input.policy,
    limit: input.limit,
    windowMs: input.windowMs,
    remaining: Math.max(0, input.limit - input.count),
    resetAt: new Date(input.resetAt).toISOString(),
    retryAfterMs: Math.max(0, input.resetAt - input.nowMs),
  };
}

export function assertRateLimit(input: RateLimitInput): RateLimitResult {
  const runtime = input.runtime ?? env;
  const defaults = policyDefaults(input.policy);
  const policy = input.policy || "custom";
  const limit = input.limit ?? defaults?.limit ?? 120;
  const windowMs = input.windowMs ?? defaults?.windowMs ?? 60_000;
  const message = defaults?.message || "Rate limit exceeded. Try again shortly.";

  if (shouldBypass(runtime, input.enforce)) {
    return resultFor({ policy, limit, windowMs, count: 0, resetAt: (input.nowMs ?? Date.now()) + windowMs, nowMs: input.nowMs ?? Date.now() });
  }

  const now = input.nowMs ?? Date.now();
  const bucketKey = hashedBucketKey(policy, input.key);
  const bucket = buckets.get(bucketKey);
  if (!bucket || bucket.resetAt <= now) {
    const resetAt = now + windowMs;
    buckets.set(bucketKey, { count: 1, resetAt });
    return resultFor({ policy, limit, windowMs, count: 1, resetAt, nowMs: now });
  }

  bucket.count += 1;
  const result = resultFor({ policy, limit, windowMs, count: bucket.count, resetAt: bucket.resetAt, nowMs: now });
  if (bucket.count > limit) {
    throw new HttpError(429, message, "rate_limited", {
      policy,
      limit,
      windowMs,
      remaining: 0,
      resetAt: result.resetAt,
      retryAfterMs: result.retryAfterMs,
    });
  }
  return result;
}

export function assertRateLimitPolicy(policy: RateLimitPolicyName, key: string, options: Omit<RateLimitInput, "policy" | "key"> = {}) {
  return assertRateLimit({ ...options, key, policy });
}

export function resetRateLimitsForTests() {
  buckets.clear();
}
