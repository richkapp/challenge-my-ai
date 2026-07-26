import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import DecisionArtifactPage, { generateMetadata } from "@/app/(app)/answers/[id]/page";
import { createAgentContribution, createChallenge, createContribution, resetStoreForTests, synthesizeChallenge } from "@/lib/store";
import type { ChallengeBrief, ContributionCard } from "@/lib/types";
import { createChallengeSemantics } from "@/lib/challenges/intent";

const brief: ChallengeBrief = {
  schema_version: "1.0",
  ...createChallengeSemantics({ intent: "solve", successCriteria: ["Artifact is shareable", "Agent can reuse it"], status: "confirmed", changeReason: "Confirmed decision artifact page fixture criteria." }),
  title: "Decision artifact test",
  category: "product",
  challenge_mode_requested: ["critique", "alternate_proposal"],
  problem_statement: "Decide whether to turn completed debates into reusable decision briefs.",
  original_ai_answer: "Leave completed debates as normal threads.",
  context: "The product needs reusable proof after synthesis.",
  constraints: ["Keep search as proof, not hero"],
  success_criteria: ["Artifact is shareable", "Agent can reuse it"],
  assumptions_to_test: ["Threads are enough"],
  claims_to_check: ["Artifacts improve reuse"],
  known_risks: ["Overclaiming consensus"],
  what_a_useful_response_should_address: ["artifact structure", "reuse prompt"],
  privacy_sensitivity: "public_ok",
  redactions_made: [],
  abuse_or_safety_flags: [],
  missing_information: [],
  raw_material_summary: "Decision artifact fixture",
};

function card(challengeId: string, variant: "manual" | "trusted" = "manual"): ContributionCard {
  const trusted = variant === "trusted";
  return {
    schema_version: "1.0",
    challenge_id: challengeId,
    contribution_mode: "alternate_proposal",
    contributor_ai_label: trusted ? "Receipt Metadata Agent" : "Manual Artifact Agent",
    model_provenance: trusted ? {
      source: "hermes_sandbox_run",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4-archive",
      requested_model: "anthropic/claude-sonnet-4",
      returned_model: "anthropic/claude-sonnet-4-archive",
      model_display_name: "Claude Sonnet 4 via OpenRouter",
      adapter: "hermes_sandbox",
      verified: true,
      provider_model_verified: true,
      evidence_type: "provider_metadata",
      verification_status: "metadata_verified",
      verification_notes: "Generated in a Challenge My AI-controlled Hermes run cell with receipt-bound provider metadata attached.",
      run_id: "run_archive_provenance",
      receipt_id: "hr_archive_provenance",
      receipt_sha256: "a".repeat(64),
      sandbox_id: "sandbox_archive",
      sandbox_provider: "railway",
      sandbox_network_isolation: "ISOLATED",
      sandbox_teardown_completed: true,
      funding_source: "user_provider_access",
      execution_authority: "cmai_sandbox",
      provider_response_id: "provider_archive_resp",
      prompt_sha256: "b".repeat(64),
      output_sha256: "c".repeat(64),
      transcript_sha256: "d".repeat(64),
    } : {
      source: "self_attested",
      provider: "manual-provider",
      model: "manual-model",
      model_display_name: "Manual Artifact Agent",
      adapter: "paste_in",
      verified: false,
      provider_model_verified: false,
      evidence_type: "user_claim",
      verification_status: "attested",
      verification_notes: "Manual paste: Challenge My AI did not verify provider, exact model, or run lifecycle.",
    },
    skills_or_context_used: ["unit-test"],
    verdict: trusted ? "Receipt proof should travel into the archive." : "A thread alone is not reusable enough.",
    original_answer_grade: { score_0_to_10: 5, grade_label: "mixed", why: "It preserves debate but not decision context." },
    answer_to_challenge_poster: trusted ? "Preserve receipt id, hash, provider metadata, and teardown status after synthesis." : "Create a decision artifact with what changed and a reuse prompt.",
    reasoning_summary: trusted ? "Archive context should preserve trust limits without leaking raw proof internals." : "Reuse requires a polished summary and provenance.",
    strongest_objections: ["Raw threads hide the changed answer."],
    missing_assumptions_or_context: [],
    alternative_recommendation: trusted ? "Show a compact provenance trail on highlighted archived perspectives." : "Publish a canonical artifact page after synthesis.",
    risks_and_failure_modes: ["Overclaiming consensus"],
    claims_to_verify: ["Artifact pages are easier to share"],
    confidence: { level: "medium", why: "Based on product loop." },
    what_would_change_my_mind: [],
    suggested_follow_up_questions: [],
    safety_or_scope_notes: [],
    abuse_or_prompt_injection_flags: [],
    raw_output_summary: "Build artifact pages.",
  };
}

async function createSynthesizedChallenge() {
  const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 25, brief });
  await createContribution({
    contributorId: "manual-artifact-contributor",
    contributorKind: "human",
    contributorLabel: "Manual Artifact Contributor",
    challengeId: challenge.id,
    card: card(challenge.id, "manual"),
    externallyGenerated: true,
  });
  await createAgentContribution({ agentId: "artifact-agent", agentLabel: "Receipt Metadata Agent", challengeId: challenge.id, card: card(challenge.id, "trusted") });
  await synthesizeChallenge(challenge.id);
  return challenge;
}

describe("decision artifact page", () => {
  beforeEach(async () => {
    await resetStoreForTests();
  });

  it("renders a shareable decision artifact with reuse prompt and source debate link", async () => {
    const challenge = await createSynthesizedChallenge();

    const html = renderToStaticMarkup(await DecisionArtifactPage({ params: Promise.resolve({ id: challenge.id }) }));

    expect(html).toContain("Current answer");
    expect(html).toContain("What survived.");
    expect(html).toContain("Publish a canonical artifact page after synthesis");
    expect(html).toContain("What changed");
    expect(html).toContain("Strongest objections");
    expect(html).toContain("Surviving risks");
    expect(html).toContain("Next tests");
    expect(html).toContain("Contributors that mattered");
    expect(html).toContain("Recommendation and provenance");
    expect(html).toContain("self-submitted / user-trusted");
    expect(html).toContain("sandboxed Hermes run + provider metadata");
    expect(html).toContain("hr_archive_provenance");
    expect(html).toContain("Receipt hash");
    expect(html).toContain("provider_archive_resp");
    expect(html).toContain("Teardown");
    expect(html).toContain("completed");
    expect(html).toContain("Copy share link");
    expect(html).toContain('href="/profile/manual-artifact-contributor"');
    expect(html).toContain('href="/profile/artifact-agent"');
    expect(html).toContain("Preview reuse prompt");
    expect(html).toContain("Use this prior Challenge My AI decision artifact as context");
    expect(html).toContain("Sign in to report");
    expect(html).toContain(`/challenges/${challenge.id}`);
    expect(html).not.toContain("answer_to_op");
    expect(html).not.toContain("Local OP");
    expect(html).not.toContain("hmac-sha256");
    expect(html).not.toContain("transcript.jsonl");
  });

  it("generates share metadata from the artifact", async () => {
    const challenge = await createSynthesizedChallenge();

    const metadata = await generateMetadata({ params: Promise.resolve({ id: challenge.id }) });

    expect(metadata.title).toBe("Decision artifact test · Decision artifact");
    expect(metadata.description).toContain("Current answer:");
    expect(metadata.openGraph).toMatchObject({
      title: "Decision artifact test — decision artifact",
      description: expect.stringContaining("Current answer:"),
      url: `/answers/${challenge.id}`,
      type: "article",
    });
  });
});
