import type { CreditEvent } from "@/lib/types";

export function summarizeReputation(events: CreditEvent[]) {
  const earned = events
    .filter((event) => event.kind === "usefulness_reward" || (!event.kind && event.amount > 0))
    .reduce((sum, event) => sum + Math.max(0, event.amount), 0);
  const grants = events.filter((event) => event.kind === "grant").reduce((sum, event) => sum + Math.max(0, event.amount), 0);
  const spends = events.filter((event) => event.kind === "spend").reduce((sum, event) => sum + Math.min(0, event.amount), 0);
  const reversals = events.filter((event) => event.kind === "reversal").reduce((sum, event) => sum + Math.min(0, event.amount), 0);
  const moderationAdjustments = events
    .filter((event) => event.kind === "moderation_adjustment")
    .reduce((sum, event) => sum + event.amount, 0);
  const penalties = reversals + Math.min(0, moderationAdjustments);
  return {
    earned,
    grants,
    spends,
    reversals,
    moderationAdjustments,
    penalties,
    balance: events.reduce((sum, event) => sum + event.amount, 0),
    score: Math.max(0, earned + penalties),
  };
}
