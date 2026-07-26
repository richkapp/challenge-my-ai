import { HttpError } from "@/lib/api/responses";
import { agentRunManualPasteFallback } from "@/lib/agent-home/runState";
import type { AgentRun } from "@/lib/types";

export type AgentRunCapPolicy = {
  ownerDailyLimit: number;
  perChallengeDailyLimit: number;
  activeOwnerLimit: number;
  cooldownMs: number;
  dailyWindowMs: number;
};

export const agentRunCapDefaults: AgentRunCapPolicy = {
  ownerDailyLimit: 8,
  perChallengeDailyLimit: 3,
  activeOwnerLimit: 1,
  cooldownMs: 30_000,
  dailyWindowMs: 24 * 60 * 60_000,
};

const activeRunStatuses = new Set<AgentRun["status"]>(["queued", "preparing_delegation", "running_cell", "validating_artifacts"]);

export type AgentRunCapInput = {
  ownerId: string;
  challengeId: string;
  runs: AgentRun[];
  nowMs?: number;
  enforce?: boolean;
  policy?: Partial<AgentRunCapPolicy>;
};

function envInt(key: string, fallback: number): number {
  const value = process.env[key];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export function agentRunCapPolicy(overrides: Partial<AgentRunCapPolicy> = {}): AgentRunCapPolicy {
  return {
    ownerDailyLimit: overrides.ownerDailyLimit ?? envInt("CMAI_AGENT_RUN_OWNER_DAILY_LIMIT", agentRunCapDefaults.ownerDailyLimit),
    perChallengeDailyLimit: overrides.perChallengeDailyLimit ?? envInt("CMAI_AGENT_RUN_CHALLENGE_DAILY_LIMIT", agentRunCapDefaults.perChallengeDailyLimit),
    activeOwnerLimit: overrides.activeOwnerLimit ?? envInt("CMAI_AGENT_RUN_ACTIVE_OWNER_LIMIT", agentRunCapDefaults.activeOwnerLimit),
    cooldownMs: overrides.cooldownMs ?? envInt("CMAI_AGENT_RUN_COOLDOWN_MS", agentRunCapDefaults.cooldownMs),
    dailyWindowMs: overrides.dailyWindowMs ?? envInt("CMAI_AGENT_RUN_DAILY_WINDOW_MS", agentRunCapDefaults.dailyWindowMs),
  };
}

function capsBypassed(enforce?: boolean) {
  return !enforce && process.env.CMAI_ENFORCE_RATE_LIMITS !== "1" && process.env.NODE_ENV === "test";
}

function createdMs(run: AgentRun) {
  const parsed = Date.parse(run.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function oldestResetAt(runs: AgentRun[], windowMs: number, nowMs: number) {
  const oldest = runs.reduce<number | undefined>((current, run) => {
    const created = createdMs(run);
    return current === undefined || created < current ? created : current;
  }, undefined);
  const resetAtMs = (oldest ?? nowMs) + windowMs;
  return {
    resetAt: new Date(resetAtMs).toISOString(),
    retryAfterMs: Math.max(0, resetAtMs - nowMs),
  };
}

function capError(input: { status: number; code: string; message: string; details: Record<string, unknown> }): never {
  throw new HttpError(input.status, input.message, input.code, {
    ...input.details,
    manualPasteFallback: agentRunManualPasteFallback,
  });
}

export function assertAgentRunCaps(input: AgentRunCapInput): { allowed: true; policy: AgentRunCapPolicy; activeCount: number; ownerDailyCount: number; challengeDailyCount: number } {
  const policy = agentRunCapPolicy(input.policy);
  if (capsBypassed(input.enforce)) {
    return { allowed: true, policy, activeCount: 0, ownerDailyCount: 0, challengeDailyCount: 0 };
  }

  const nowMs = input.nowMs ?? Date.now();
  const windowStartMs = nowMs - policy.dailyWindowMs;
  const ownerRuns = input.runs.filter((run) => run.contributorId === input.ownerId);
  const activeRuns = ownerRuns.filter((run) => activeRunStatuses.has(run.status));
  if (activeRuns.length >= policy.activeOwnerLimit) {
    capError({
      status: 409,
      code: "agent_run_concurrency_limit",
      message: "You already have a trusted Agent run in progress.",
      details: { policy: "active_owner_limit", limit: policy.activeOwnerLimit, activeCount: activeRuns.length },
    });
  }

  const recentRuns = ownerRuns.filter((run) => createdMs(run) >= windowStartMs);
  const latestRun = recentRuns.reduce<AgentRun | undefined>((current, run) => !current || createdMs(run) > createdMs(current) ? run : current, undefined);
  if (policy.cooldownMs > 0 && latestRun) {
    const cooldownResetMs = createdMs(latestRun) + policy.cooldownMs;
    if (cooldownResetMs > nowMs) {
      capError({
        status: 429,
        code: "agent_run_cooldown",
        message: "Run my Agent here is cooling down after your last trusted run.",
        details: { policy: "owner_cooldown", limit: 1, windowMs: policy.cooldownMs, resetAt: new Date(cooldownResetMs).toISOString(), retryAfterMs: cooldownResetMs - nowMs },
      });
    }
  }

  const challengeRuns = recentRuns.filter((run) => run.challengeId === input.challengeId);
  if (challengeRuns.length >= policy.perChallengeDailyLimit) {
    capError({
      status: 429,
      code: "agent_run_challenge_cap_exceeded",
      message: "This challenge has reached your trusted Agent-run cap for now.",
      details: { policy: "per_challenge_daily_limit", limit: policy.perChallengeDailyLimit, count: challengeRuns.length, windowMs: policy.dailyWindowMs, ...oldestResetAt(challengeRuns, policy.dailyWindowMs, nowMs) },
    });
  }

  if (recentRuns.length >= policy.ownerDailyLimit) {
    capError({
      status: 429,
      code: "agent_run_daily_cap_exceeded",
      message: "You have reached the trusted Agent-run cap for today.",
      details: { policy: "owner_daily_limit", limit: policy.ownerDailyLimit, count: recentRuns.length, windowMs: policy.dailyWindowMs, ...oldestResetAt(recentRuns, policy.dailyWindowMs, nowMs) },
    });
  }

  return { allowed: true, policy, activeCount: activeRuns.length, ownerDailyCount: recentRuns.length, challengeDailyCount: challengeRuns.length };
}
