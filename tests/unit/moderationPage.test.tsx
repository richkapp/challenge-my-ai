import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import ModerationPage from "@/app/(app)/moderation/page";
import { createChallenge, createContribution, reportTarget, resetStoreForTests, suppressContribution } from "@/lib/store";
import type { ChallengeBrief, ContributionCard } from "@/lib/types";
import { createChallengeSemantics } from "@/lib/challenges/intent";

const brief: ChallengeBrief = {
  schema_version: "1.0",
  ...createChallengeSemantics({ intent: "solve", successCriteria: ["Reports are visible"], status: "confirmed", changeReason: "Confirmed moderation page fixture criteria." }),
  title: "Moderation queue fixture",
  category: "product",
  challenge_mode_requested: ["critique"],
  problem_statement: "Show a usable moderation queue before launch.",
  original_ai_answer: "Keep the queue as a placeholder.",
  context: "Operators need to review reports and suppress bad content.",
  constraints: [],
  success_criteria: ["Reports are visible"],
  assumptions_to_test: [],
  claims_to_check: [],
  known_risks: [],
  what_a_useful_response_should_address: ["audit trail", "moderator controls"],
  privacy_sensitivity: "public_ok",
  redactions_made: [],
  abuse_or_safety_flags: [],
  missing_information: [],
  raw_material_summary: "Moderation queue fixture",
};

function card(challengeId: string): ContributionCard {
  return {
    schema_version: "1.0",
    challenge_id: challengeId,
    contribution_mode: "critique",
    contributor_ai_label: "Queue Agent",
    skills_or_context_used: [],
    verdict: "The moderation page needs actionable rows.",
    original_answer_grade: { score_0_to_10: 4, grade_label: "weak", why: "Placeholder queue is not enough." },
    answer_to_challenge_poster: "Add reports, target status, and suppress/restore controls.",
    reasoning_summary: "Queue fixture.",
    strongest_objections: [],
    missing_assumptions_or_context: [],
    alternative_recommendation: "Ship a basic operator queue.",
    risks_and_failure_modes: [],
    claims_to_verify: [],
    confidence: { level: "medium", why: "Deterministic fixture." },
    what_would_change_my_mind: [],
    suggested_follow_up_questions: [],
    safety_or_scope_notes: [],
    abuse_or_prompt_injection_flags: [],
    raw_output_summary: "Queue fixture card",
  };
}

describe("moderation queue page", () => {
  beforeEach(async () => {
    await resetStoreForTests();
  });

  it("renders report audit rows with target status and moderator action controls", async () => {
    const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 10, brief });
    const contribution = await createContribution({ challengeId: challenge.id, contributorId: "agent", card: card(challenge.id) });
    await reportTarget({ targetType: "challenge", targetId: challenge.id, actorId: "reader", reason: "unsafe_content", note: "Needs moderator review" });
    await suppressContribution(contribution.id, "off_topic_or_low_quality", "mod-1", "Queue cleanup");

    const html = renderToStaticMarkup(await ModerationPage());

    expect(html).toContain("Reports, suppressions, and restores");
    expect(html).toContain("Reports");
    expect(html).toContain("Suppressions");
    expect(html).toContain("Unsafe content");
    expect(html).toContain("Off-topic/low quality");
    expect(html).toContain("Moderation queue fixture");
    expect(html).toContain("The moderation page needs actionable rows");
    expect(html).toContain("Needs moderator review");
    expect(html).toContain("Suppress target");
    expect(html).toContain("Restore target");
    expect(html).toContain(`href="/challenges/${challenge.id}"`);
  });
});
