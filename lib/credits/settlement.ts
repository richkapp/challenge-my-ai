import { creditLedgerPolicy } from "@/lib/credits/ledger";

export function rewardForUsefulness(usefulness: number): number {
  if (!Number.isFinite(usefulness)) return 0;
  if (usefulness < 4) return 0;
  return Math.max(0, Math.min(creditLedgerPolicy.maxUsefulnessReward, Math.round(usefulness * 2.5)));
}

export function rewardForRating(input: { usefulness: number; safety: number; challengeReward: number }) {
  if (!Number.isFinite(input.usefulness) || !Number.isFinite(input.safety)) return 0;
  if (input.safety <= 2 || input.usefulness < 4) return 0;
  return Math.max(0, Math.min(input.challengeReward, rewardForUsefulness(input.usefulness)));
}

export function ratingCreditEventKind(delta: number) {
  return delta >= 0 ? "usefulness_reward" : "reversal";
}
