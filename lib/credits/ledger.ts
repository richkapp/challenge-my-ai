import type { CreditEvent, CreditEventKind, CreditEventMetadataValue } from "@/lib/types";

export const creditLedgerPolicy = {
  freeAllowanceCredits: 100,
  minChallengeReward: 0,
  maxChallengeReward: 80,
  maxUsefulnessReward: 25,
  maxEarnedCreditsPerContributorPerDay: 120,
  maxModerationAdjustmentAbs: 250,
} as const;

export type CreditEventInput = {
  userId: string;
  challengeId?: string;
  contributionId?: string;
  amount: number;
  reason: string;
  kind?: CreditEventKind;
  source?: CreditEvent["source"];
  idempotencyKey?: string;
  metadata?: Record<string, CreditEventMetadataValue>;
};

export function creditBalance(events: CreditEvent[], userId?: string) {
  return events
    .filter((event) => !userId || event.userId === userId)
    .reduce((sum, event) => sum + event.amount, 0);
}

export function creditBalanceBefore(events: CreditEvent[], input: Pick<CreditEventInput, "userId">) {
  return creditBalance(events, input.userId);
}

export function buildCreditEvent(input: CreditEventInput & { id: string; createdAt: string; balanceAfter?: number }): CreditEvent {
  const amount = Number.isFinite(input.amount) ? Math.round(input.amount) : 0;
  return {
    id: input.id,
    createdAt: input.createdAt,
    userId: input.userId,
    challengeId: input.challengeId,
    contributionId: input.contributionId,
    amount,
    reason: input.reason,
    kind: input.kind ?? (amount >= 0 ? "grant" : "spend"),
    source: input.source ?? "system",
    idempotencyKey: input.idempotencyKey,
    balanceAfter: input.balanceAfter,
    metadata: input.metadata,
  };
}

export function isPosterRatingCreditEvent(event: CreditEvent) {
  return (
    event.source === "challenge_poster" &&
    event.metadata?.settlement === "poster_rating" &&
    (event.kind === "usefulness_reward" || event.kind === "reversal")
  );
}

export function posterRatingCreditTotal(events: CreditEvent[], input: { userId: string; contributionId: string }) {
  return events
    .filter((event) => event.userId === input.userId && event.contributionId === input.contributionId)
    .filter(isPosterRatingCreditEvent)
    .reduce((sum, event) => sum + event.amount, 0);
}

export function normalizeChallengeReward(reward: number) {
  if (!Number.isFinite(reward)) return creditLedgerPolicy.minChallengeReward;
  return Math.max(
    creditLedgerPolicy.minChallengeReward,
    Math.min(creditLedgerPolicy.maxChallengeReward, Math.round(reward)),
  );
}

export function canSpendCredits(events: CreditEvent[], input: { userId: string; amount: number }) {
  const amount = Math.max(0, Math.round(Number.isFinite(input.amount) ? input.amount : 0));
  const balance = creditBalance(events, input.userId);
  return {
    ok: balance >= amount,
    balance,
    amount,
    shortfall: Math.max(0, amount - balance),
  };
}

export function netContributionCredit(events: CreditEvent[], input: { userId: string; contributionId: string }) {
  return events
    .filter((event) => event.userId === input.userId && event.contributionId === input.contributionId)
    .reduce((sum, event) => sum + event.amount, 0);
}

export function earnedToday(events: CreditEvent[], input: { userId: string; nowIso?: string }) {
  const day = (input.nowIso ?? new Date().toISOString()).slice(0, 10);
  return events
    .filter((event) => event.userId === input.userId)
    .filter((event) => event.createdAt.slice(0, 10) === day)
    .filter((event) => event.kind === "usefulness_reward" || (!event.kind && event.amount > 0))
    .reduce((sum, event) => sum + Math.max(0, event.amount), 0);
}

export function capUsefulnessReward(events: CreditEvent[], input: { userId: string; desiredDelta: number; nowIso?: string }) {
  const desired = Math.max(0, Math.round(input.desiredDelta));
  const remaining = Math.max(0, creditLedgerPolicy.maxEarnedCreditsPerContributorPerDay - earnedToday(events, input));
  return Math.min(desired, remaining);
}

export function describeInsufficientCredits(input: { balance: number; amount: number; shortfall: number }) {
  return `Insufficient credits: ${input.amount} requested, ${input.balance} available, ${input.shortfall} short.`;
}
