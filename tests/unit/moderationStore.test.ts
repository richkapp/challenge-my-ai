import { beforeEach, describe, expect, it } from "vitest";
import { loadDecisionArtifact } from "@/lib/archive/decisionArtifactStore";
import { createChallenge, createContribution, listChallenges, listContributions, listModerationEvents, moderateTarget, rateContribution, reportTarget, resetStoreForTests, restoreChallenge, restoreContribution, suppressChallenge, suppressContribution, synthesizeChallenge } from "@/lib/store";
import type { ChallengeBrief, ContributionCard } from "@/lib/types";
import { createChallengeSemantics } from "@/lib/challenges/intent";

const brief: ChallengeBrief = {
  schema_version: "1.0",
  ...createChallengeSemantics({ intent: "solve", successCriteria: ["Reports are structured", "Suppression hides public surfaces"], status: "confirmed", changeReason: "Confirmed moderation fixture criteria." }),
  title: "Moderation test challenge",
  category: "product",
  challenge_mode_requested: ["critique", "alternate_proposal"],
  problem_statement: "Decide whether the moderation queue hides unsafe public content.",
  original_ai_answer: "Leave reports as free-form notes and handle them manually.",
  context: "The launch needs a safe public social loop.",
  constraints: ["Do not expose raw secrets in audit rows"],
  success_criteria: ["Reports are structured", "Suppression hides public surfaces"],
  assumptions_to_test: ["Suppression works after synthesis"],
  claims_to_check: ["Archive search removes suppressed content"],
  known_risks: ["Report notes can contain secrets"],
  what_a_useful_response_should_address: ["operator workflow", "safe audit trail"],
  privacy_sensitivity: "public_ok",
  redactions_made: [],
  abuse_or_safety_flags: [],
  missing_information: [],
  raw_material_summary: "Moderation fixture",
};

function card(challengeId: string, label = "Moderation Agent"): ContributionCard {
  return {
    schema_version: "1.0",
    challenge_id: challengeId,
    contribution_mode: "critique",
    contributor_ai_label: label,
    model_provenance: {
      source: "self_attested",
      provider: "manual-provider",
      model: "manual-model",
      model_display_name: label,
      adapter: "paste_in",
      verified: false,
      provider_model_verified: false,
      evidence_type: "user_claim",
      verification_status: "attested",
      verification_notes: "Manual paste fixture.",
    },
    skills_or_context_used: ["unit-test"],
    verdict: "The moderation system needs structured reports and suppress/restore actions.",
    original_answer_grade: { score_0_to_10: 4, grade_label: "weak", why: "It lacks public-surface suppression." },
    answer_to_challenge_poster: "Add a moderator audit queue and hide suppressed public content everywhere.",
    reasoning_summary: "The queue should store only safe metadata while public reads filter suppressed content.",
    strongest_objections: ["Free-form report text can leak secrets."],
    missing_assumptions_or_context: [],
    alternative_recommendation: "Use reason enums and redacted notes with moderator actions.",
    risks_and_failure_modes: ["Suppressed content remains in archive search"],
    claims_to_verify: ["Suppressed contributions disappear from artifacts"],
    confidence: { level: "medium", why: "Based on launch safety needs." },
    what_would_change_my_mind: [],
    suggested_follow_up_questions: [],
    safety_or_scope_notes: [],
    abuse_or_prompt_injection_flags: [],
    raw_output_summary: "Moderation workflow fixture.",
  };
}

async function createRatedChallenge() {
  const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 25, brief });
  const first = await createContribution({ challengeId: challenge.id, contributorId: "contributor-a", contributorKind: "human", contributorLabel: "Contributor A", card: card(challenge.id, "A"), externallyGenerated: true });
  const second = await createContribution({ challengeId: challenge.id, contributorId: "contributor-b", contributorKind: "human", contributorLabel: "Contributor B", card: card(challenge.id, "B"), externallyGenerated: true });
  await rateContribution({ contributionId: first.id, raterId: "poster", usefulness: 8, safety: 8, comment: "Useful" });
  await synthesizeChallenge(challenge.id);
  return { challenge, first, second };
}

describe("moderation store workflow", () => {
  beforeEach(async () => {
    await resetStoreForTests();
  });

  it("records structured reports for challenge, contribution, and artifact targets with redacted notes", async () => {
    const { challenge, first } = await createRatedChallenge();

    const challengeReport = await reportTarget({ targetType: "challenge", targetId: challenge.id, actorId: "reader", reason: "unsafe_content", note: "Contains password=hunter2 in the text" });
    const contributionReport = await reportTarget({ targetType: "contribution", targetId: first.id, actorId: "reader", reason: "spam", note: "Repeated low-quality reply" });
    const artifactReport = await reportTarget({ targetType: "artifact", targetId: challenge.id, actorId: "reader", reason: "other", note: "Archive page needs moderator review" });

    expect(challengeReport).toMatchObject({ targetType: "challenge", targetId: challenge.id, resolvedTargetType: "challenge", resolvedTargetId: challenge.id, actorId: "reader", action: "report", reason: "unsafe_content" });
    expect(challengeReport.note).toContain("[redacted]");
    expect(challengeReport.note).not.toContain("hunter2");
    expect(contributionReport).toMatchObject({ targetType: "contribution", targetId: first.id, resolvedTargetType: "contribution", resolvedTargetId: first.id, reason: "spam" });
    expect(artifactReport).toMatchObject({ targetType: "artifact", targetId: challenge.id, resolvedTargetType: "challenge", resolvedTargetId: challenge.id, reason: "other" });
    expect(await listModerationEvents()).toHaveLength(3);
  });

  it("suppresses and restores a contribution while public lists and artifacts filter it", async () => {
    const { challenge, first, second } = await createRatedChallenge();

    const suppressed = await suppressContribution(first.id, "unsafe_content", "mod-1", "Remove the risky contribution only");

    expect(suppressed.event).toMatchObject({ action: "suppress", targetType: "contribution", targetId: first.id, resolvedTargetType: "contribution", reason: "unsafe_content" });
    expect((await listContributions(challenge.id)).map((item) => item.id)).toEqual([second.id]);
    const artifactAfterSuppress = await loadDecisionArtifact(challenge.id);
    expect(artifactAfterSuppress?.contributorHighlights.map((item) => item.contributionId)).not.toContain(first.id);

    const restored = await restoreContribution(first.id, "other", "mod-1", "Safe after review");

    expect(restored.event).toMatchObject({ action: "restore", targetType: "contribution", targetId: first.id });
    expect((await listContributions(challenge.id)).map((item) => item.id)).toContain(first.id);
  });

  it("suppresses and restores a synthesized challenge through challenge and artifact targets", async () => {
    const { challenge } = await createRatedChallenge();

    const suppressResult = await moderateTarget({ targetType: "artifact", targetId: challenge.id, action: "suppress", actorId: "mod-1", reason: "smoke_or_test_artifact", note: "Operator smoke cleanup" });

    expect(suppressResult.event).toMatchObject({ targetType: "artifact", resolvedTargetType: "challenge", action: "suppress", reason: "smoke_or_test_artifact" });
    expect((await listChallenges()).map((item) => item.id)).not.toContain(challenge.id);
    expect(await loadDecisionArtifact(challenge.id)).toBeUndefined();

    const restoreResult = await restoreChallenge(challenge.id, "other", "mod-1", "Restore after review");

    expect(restoreResult.challenge?.status).toBe("synthesized");
    expect((await listChallenges()).map((item) => item.id)).toContain(challenge.id);
    expect(await loadDecisionArtifact(challenge.id)).toBeTruthy();
  });

  it("rejects missing moderation targets without creating orphan audit rows", async () => {
    await expect(reportTarget({ targetType: "contribution", targetId: "missing", reason: "spam", actorId: "reader" })).rejects.toThrow(/not found/i);
    await expect(suppressChallenge("missing", "unsafe_content", "mod-1")).rejects.toThrow(/not found/i);
    expect(await listModerationEvents()).toEqual([]);
  });
});
