import { beforeEach, describe, expect, it } from "vitest";
import { createChallenge, createContribution, getChallenge, getJob, rateContribution, resetStoreForTests, suppressChallenge, synthesizeChallenge } from "@/lib/store";
import type { ChallengeBrief, ContributionCard } from "@/lib/types";
import { createChallengeSemantics } from "@/lib/challenges/intent";

const brief: ChallengeBrief = {
  schema_version: "1.0",
  ...createChallengeSemantics({ intent: "solve", successCriteria: ["A narrower launch sequence is testable"], status: "confirmed", changeReason: "Confirmed synthesis fixture criteria." }),
  title: "Improve synthesis quality",
  category: "startup",
  challenge_mode_requested: ["critique", "risk_audit"],
  problem_statement: "The launch plan might over-focus on a broad public announcement.",
  original_ai_answer: "Launch broadly to everyone first, then learn from the market.",
  context: "The poster needs a safer public launch sequence.",
  constraints: ["Keep public claims conservative"],
  success_criteria: ["A narrower launch sequence is testable"],
  assumptions_to_test: ["Broad launch feedback is useful"],
  claims_to_check: ["A narrow builder beta creates better critique"],
  known_risks: ["This can sound like professional launch advice; validate against current business constraints."],
  what_a_useful_response_should_address: ["audience wedge", "sequencing", "risk"],
  privacy_sensitivity: "public_ok",
  redactions_made: [],
  abuse_or_safety_flags: [],
  missing_information: [],
  raw_material_summary: "Synthesis fixture",
};

function card(challengeId: string, overrides: Partial<ContributionCard> = {}): ContributionCard {
  return {
    schema_version: "1.0",
    challenge_id: challengeId,
    contribution_mode: "critique",
    contributor_ai_label: "Synthesis Agent",
    skills_or_context_used: ["unit-test"],
    verdict: "Broad launch hides the real learning loop.",
    original_answer_grade: { score_0_to_10: 4, grade_label: "weak", why: "Too broad." },
    answer_to_challenge_poster: "Start with a builder beta before widening.",
    reasoning_summary: "A narrower beta produces stronger feedback and reusable proof.",
    strongest_objections: ["Broad launch feedback is low-signal."],
    missing_assumptions_or_context: ["Which builder segment feels urgent pain?"],
    alternative_recommendation: "Run a focused builder beta, then publish the objections that changed the answer.",
    risks_and_failure_modes: ["Generic positioning"],
    claims_to_verify: ["Builder beta feedback beats broad feedback"],
    confidence: { level: "medium", why: "Known launch pattern." },
    what_would_change_my_mind: ["Evidence the broad audience is already waiting."],
    suggested_follow_up_questions: ["Which segment has the sharpest pain?"],
    safety_or_scope_notes: [],
    abuse_or_prompt_injection_flags: [],
    raw_output_summary: "Narrow the launch.",
    ...overrides,
  };
}

describe("local synthesis", () => {
  beforeEach(async () => {
    await resetStoreForTests();
  });

  it("selects the highest-signal answer, dedupes repetition, and preserves disagreement plus safety notes", async () => {
    const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 30, brief });
    const weak = await createContribution({
      challengeId: challenge.id,
      contributorId: "weak-contributor",
      card: card(challenge.id, {
        verdict: "Launch broad, but add a disclaimer.",
        alternative_recommendation: "Keep the broad launch but soften the copy.",
        strongest_objections: ["Broad launch feedback is low-signal.", "Broad launch feedback is low-signal."],
        risks_and_failure_modes: ["Generic positioning"],
        confidence: { level: "low", why: "Thin evidence." },
        safety_or_scope_notes: ["This is strategic advice, not legal or financial advice."],
      }),
    });
    const strong = await createContribution({
      challengeId: challenge.id,
      contributorId: "strong-contributor",
      card: card(challenge.id, {
        verdict: "Do not launch broadly until the builder wedge proves repeatable.",
        alternative_recommendation: "Run a focused builder beta, synthesize objections, then widen once the answer survives critique.",
        strongest_objections: ["Broad launch feedback is low-signal.", "The plan does not name the first wedge."],
        risks_and_failure_modes: ["Generic positioning", "Premature public proof"],
        claims_to_verify: ["Builder beta feedback beats broad feedback", "Repeat users return after synthesis"],
        confidence: { level: "high", why: "Directly addresses sequencing." },
      }),
    });
    await rateContribution({ contributionId: weak.id, raterId: "poster", usefulness: 3, safety: 4, comment: "Too thin" });
    await rateContribution({ contributionId: strong.id, raterId: "poster", usefulness: 9, safety: 8, comment: "Changed the plan" });

    const synthesis = await synthesizeChallenge(challenge.id);

    expect(synthesis.improvedAnswer).toBe("Run a focused builder beta, synthesize objections, then widen once the answer survives critique.");
    expect(synthesis.whatChanged.join(" ")).toContain("Run a focused builder beta");
    expect(synthesis.strongestObjections.filter((item) => item === "Broad launch feedback is low-signal.")).toHaveLength(1);
    expect(synthesis.strongestObjections).toContain("The plan does not name the first wedge.");
    expect(synthesis.risks).toEqual(expect.arrayContaining(["Generic positioning", "Premature public proof", "This is strategic advice, not legal or financial advice."]));
    expect(synthesis.unresolvedDisagreements).toEqual(expect.arrayContaining(["Launch broad, but add a disclaimer.", "Do not launch broadly until the builder wedge proves repeatable."]));
    expect(synthesis.nextTests).toEqual(expect.arrayContaining(["A narrow builder beta creates better critique", "Repeat users return after synthesis"]));
    expect(synthesis.nextTests.join(" ")).toContain("professional-advice caveats");
    expect(synthesis.confidence).toBe("medium");
  });

  it("promotes challenge lifecycle from open to ready and then synthesized", async () => {
    const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 20, brief });
    expect(challenge.status).toBe("open");

    const first = await createContribution({ challengeId: challenge.id, contributorId: "first", card: card(challenge.id) });
    expect((await getChallenge(challenge.id))?.status).toBe("contributing");

    await rateContribution({ contributionId: first.id, raterId: "poster", usefulness: 8, safety: 8, comment: "Enough signal" });
    expect((await getChallenge(challenge.id))?.status).toBe("ready_for_synthesis");

    const synthesis = await synthesizeChallenge(challenge.id);
    expect((await getChallenge(challenge.id))?.status).toBe("synthesized");
    expect(await getJob(synthesis.jobId)).toMatchObject({ kind: "synthesis", status: "succeeded" });
  });

  it("marks a debate ready after multiple posted perspectives even before poster rating", async () => {
    const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 20, brief });
    await createContribution({ challengeId: challenge.id, contributorId: "first", card: card(challenge.id) });
    await createContribution({ challengeId: challenge.id, contributorId: "second", card: card(challenge.id, { verdict: "Second distinct perspective." }) });

    expect((await getChallenge(challenge.id))?.status).toBe("ready_for_synthesis");
  });

  it("rejects synthesis for suppressed challenges", async () => {
    const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 20, brief });
    await createContribution({ challengeId: challenge.id, contributorId: "critic", card: card(challenge.id) });
    await suppressChallenge(challenge.id, "unsafe synthesis target", "moderator");

    await expect(synthesizeChallenge(challenge.id)).rejects.toThrow("Challenge is suppressed.");
  });
});
