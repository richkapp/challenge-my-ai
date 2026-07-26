import { beforeEach, describe, expect, it } from "vitest";
import { canSpendCredits, creditBalance, creditLedgerPolicy, normalizeChallengeReward } from "@/lib/credits/ledger";
import { summarizeReputation } from "@/lib/credits/reputation";
import { rewardForRating, rewardForUsefulness } from "@/lib/credits/settlement";
import { appendCredit, communityVote, createChallenge, createContribution, listCreditEvents, rateContribution, resetStoreForTests, suppressChallenge } from "@/lib/store";
import type { ChallengeBrief, ContributionCard } from "@/lib/types";
import { createChallengeSemantics } from "@/lib/challenges/intent";

const brief: ChallengeBrief = {
  schema_version: "1.0",
  ...createChallengeSemantics({ intent: "solve", successCriteria: ["Poster confirms the tested reward behavior."], status: "confirmed", changeReason: "Confirmed credit settlement fixture criteria." }),
  title: "T",
  category: "product",
  challenge_mode_requested: ["critique"],
  problem_statement: "P",
  original_ai_answer: "A",
  context: "C",
  constraints: [],
  success_criteria: ["Poster confirms the tested reward behavior."],
  assumptions_to_test: [],
  claims_to_check: [],
  known_risks: [],
  what_a_useful_response_should_address: [],
  privacy_sensitivity: "public_ok",
  redactions_made: [],
  abuse_or_safety_flags: [],
  missing_information: [],
  raw_material_summary: "S",
};

function card(challengeId: string): ContributionCard {
  return {
    schema_version: "1.0",
    challenge_id: challengeId,
    contribution_mode: "critique",
    contributor_ai_label: "test",
    skills_or_context_used: [],
    verdict: "V",
    original_answer_grade: { score_0_to_10: 5, grade_label: "mixed", why: "ok" },
    answer_to_challenge_poster: "Answer",
    reasoning_summary: "Summary",
    strongest_objections: [],
    missing_assumptions_or_context: [],
    alternative_recommendation: "Alt",
    risks_and_failure_modes: [],
    claims_to_verify: [],
    confidence: { level: "medium", why: "ok" },
    what_would_change_my_mind: [],
    suggested_follow_up_questions: [],
    safety_or_scope_notes: [],
    abuse_or_prompt_injection_flags: [],
    raw_output_summary: "S",
  };
}

async function createRatedContribution(input: { contributorId?: string; reward?: number; usefulness?: number; safety?: number } = {}) {
  const challenge = await createChallenge({ posterId: "op", visibility: "public", reward: input.reward ?? 20, brief });
  const contribution = await createContribution({ challengeId: challenge.id, contributorId: input.contributorId ?? "rated-contributor", card: card(challenge.id) });
  await rateContribution({ contributionId: contribution.id, raterId: "op", usefulness: input.usefulness ?? 9, safety: input.safety ?? 5 });
  return { challenge, contribution };
}

describe("credit settlement", () => {
  beforeEach(async () => {
    await resetStoreForTests();
  });

  it("caps challenge rewards and usefulness rewards", async () => {
    expect(rewardForUsefulness(10)).toBe(creditLedgerPolicy.maxUsefulnessReward);
    expect(rewardForUsefulness(3)).toBe(0);
    expect(rewardForUsefulness(99)).toBe(creditLedgerPolicy.maxUsefulnessReward);
    expect(rewardForRating({ usefulness: 9, safety: 1, challengeReward: 50 })).toBe(0);
    expect(normalizeChallengeReward(999)).toBe(creditLedgerPolicy.maxChallengeReward);
    const challenge = await createChallenge({ posterId: "op", visibility: "public", reward: 999, brief });
    expect(challenge.reward).toBe(creditLedgerPolicy.maxChallengeReward);
  });

  it("records grants, spends, balances, and insufficient-credit states", async () => {
    const userId = "ledger-alice";
    const grant = await appendCredit({ userId, amount: creditLedgerPolicy.freeAllowanceCredits, reason: "Launch free allowance", kind: "grant", source: "system" });
    const spend = await appendCredit({ userId, amount: -20, reason: "Challenge reward escrow", kind: "spend", source: "system" });
    const events = await listCreditEvents(userId);

    expect(grant).toMatchObject({ kind: "grant", balanceAfter: creditLedgerPolicy.freeAllowanceCredits });
    expect(spend).toMatchObject({ kind: "spend", balanceAfter: creditLedgerPolicy.freeAllowanceCredits - 20 });
    expect(creditBalance(events)).toBe(creditLedgerPolicy.freeAllowanceCredits - 20);
    expect(canSpendCredits(events, { userId, amount: 90 })).toMatchObject({ ok: false, balance: 80, shortfall: 10 });
    await expect(appendCredit({ userId: "empty-wallet", amount: -1, reason: "Implicit spend" })).rejects.toThrow(/Insufficient credits/);
  });

  it("uses rating deltas so repeat ratings do not mint duplicate credits and downgrades reverse rewards", async () => {
    const contributorId = "delta-contributor";
    const { contribution } = await createRatedContribution({ contributorId, reward: 20, usefulness: 9, safety: 5 });
    await rateContribution({ contributionId: contribution.id, raterId: "op", usefulness: 9, safety: 5 });
    expect(creditBalance(await listCreditEvents(contributorId))).toBe(20);

    await rateContribution({ contributionId: contribution.id, raterId: "op", usefulness: 1, safety: 5 });
    const events = await listCreditEvents(contributorId);
    expect(creditBalance(events)).toBe(0);
    expect(events.map((event) => event.kind)).toContain("usefulness_reward");
    expect(events.map((event) => event.kind)).toContain("reversal");
  });

  it("does not mint credits from Agent self-grades before challenge-poster rating", async () => {
    const challenge = await createChallenge({ posterId: "op", visibility: "public", reward: 20, brief });
    const contributorId = "self-grade-only-contributor";
    await createContribution({ challengeId: challenge.id, contributorId, card: { ...card(challenge.id), original_answer_grade: { score_0_to_10: 10, grade_label: "strong", why: "self-grade only" } } });
    expect(await listCreditEvents(contributorId)).toEqual([]);
  });

  it("applies moderation adjustments without deleting the reward trail", async () => {
    const contributorId = "moderated-contributor";
    const { challenge } = await createRatedContribution({ contributorId, reward: 20, usefulness: 9, safety: 5 });
    await suppressChallenge(challenge.id, "unsafe smoke artifact", "moderator");
    const events = await listCreditEvents(contributorId);
    expect(creditBalance(events)).toBe(0);
    expect(events.map((event) => event.kind)).toContain("moderation_adjustment");
    expect(events.find((event) => event.kind === "moderation_adjustment")?.reason).toContain("unsafe smoke artifact");
  });

  it("caps daily usefulness rewards to prevent farming", async () => {
    for (let index = 0; index < 6; index += 1) {
      await createRatedContribution({ contributorId: "farmer", reward: 80, usefulness: 10, safety: 5 });
    }
    const events = await listCreditEvents("farmer");
    expect(creditBalance(events)).toBe(creditLedgerPolicy.maxEarnedCreditsPerContributorPerDay);
    expect(events.some((event) => event.kind === "usefulness_reward" && event.amount < creditLedgerPolicy.maxUsefulnessReward)).toBe(true);
  });

  it("keeps community votes idempotent and separate from credit rewards", async () => {
    const challenge = await createChallenge({ posterId: "op", visibility: "public", reward: 20, brief });
    const contribution = await createContribution({ challengeId: challenge.id, contributorId: "critic", card: card(challenge.id) });

    const first = await communityVote(contribution.id, 1, "viewer");
    expect(first).toMatchObject({ contribution: { communityScore: 1 }, vote: { counted: true, reason: "counted", scoreDelta: 1 } });
    expect(first.vote.policy).toMatchObject({ affectsCredits: false, influence: "visibility_trust_tiebreaker" });

    const duplicate = await communityVote(contribution.id, 1, "viewer");
    expect(duplicate).toMatchObject({ contribution: { communityScore: 1 }, vote: { counted: false, reason: "duplicate", scoreDelta: 0 } });

    const changed = await communityVote(contribution.id, -1, "viewer");
    expect(changed).toMatchObject({ contribution: { communityScore: -1 }, vote: { counted: true, reason: "changed", scoreDelta: -2, previousValue: 1 } });
    expect(await listCreditEvents("critic")).toEqual([]);
  });

  it("rejects self-votes and suppressed community vote targets", async () => {
    const challenge = await createChallenge({ posterId: "op", visibility: "public", reward: 20, brief });
    const contribution = await createContribution({ challengeId: challenge.id, contributorId: "critic", card: card(challenge.id) });

    await expect(communityVote(contribution.id, 1, "critic")).rejects.toMatchObject({ code: "self_vote_blocked" });
    await suppressChallenge(challenge.id, "unsafe vote target", "moderator");
    await expect(communityVote(contribution.id, 1, "viewer")).rejects.toMatchObject({ code: "vote_target_unavailable" });
  });

  it("summarizes reputation from usefulness while treating grants and spends separately", async () => {
    const userId = "reputation-alice";
    await appendCredit({ userId, amount: 100, reason: "Launch grant", kind: "grant" });
    await appendCredit({ userId, amount: -30, reason: "Challenge spend", kind: "spend" });
    await appendCredit({ userId, amount: 25, reason: "Useful critique", kind: "usefulness_reward" });
    await appendCredit({ userId, amount: -10, reason: "Downgrade", kind: "reversal" });

    expect(summarizeReputation(await listCreditEvents(userId))).toMatchObject({
      grants: 100,
      spends: -30,
      earned: 25,
      reversals: -10,
      balance: 85,
      score: 15,
    });
  });

  it("rejects invalid ratings", async () => {
    const challenge = await createChallenge({ posterId: "op", visibility: "public", reward: 20, brief });
    const contribution = await createContribution({ challengeId: challenge.id, card: card(challenge.id) });
    await expect(rateContribution({ contributionId: contribution.id, usefulness: Number.NaN })).rejects.toThrow(/usefulness/);
  });
});
