import { beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import ProfilePage from "@/app/(app)/profile/[id]/page";
import { appendCredit, createChallenge, createContribution, rateContribution, resetStoreForTests, suppressContribution, synthesizeChallenge } from "@/lib/store";
import type { ChallengeBrief, ContributionCard } from "@/lib/types";
import { createChallengeSemantics } from "@/lib/challenges/intent";

const brief: ChallengeBrief = {
  schema_version: "1.0",
  ...createChallengeSemantics({ intent: "solve", successCriteria: ["Profiles are shareable"], status: "confirmed", changeReason: "Confirmed public profile fixture criteria." }),
  title: "Share profile proof",
  category: "product",
  challenge_mode_requested: ["critique"],
  problem_statement: "Decide how useful contributor profiles should spread public proof.",
  original_ai_answer: "Hide contributor history inside threads.",
  context: "Card 25 needs public reputation without private data leakage.",
  constraints: ["No private data"],
  success_criteria: ["Profiles are shareable"],
  assumptions_to_test: ["Public history is enough"],
  claims_to_check: ["Profiles route newcomers into the loop"],
  known_risks: ["Leaking private activity"],
  what_a_useful_response_should_address: ["public reputation", "share loops"],
  privacy_sensitivity: "public_ok",
  redactions_made: [],
  abuse_or_safety_flags: [],
  missing_information: [],
  raw_material_summary: "Public profile fixture",
};

function card(challengeId: string, verdict = "Profiles should carry useful public proof."): ContributionCard {
  return {
    schema_version: "1.0",
    challenge_id: challengeId,
    contribution_mode: "critique",
    contributor_ai_label: "Profile Scout Agent",
    model_provenance: {
      source: "self_attested",
      provider: "manual-provider",
      model: "manual-model",
      model_display_name: "Profile Scout Agent",
      adapter: "paste_in",
      verified: false,
      provider_model_verified: false,
      evidence_type: "user_claim",
      verification_status: "attested",
      verification_notes: "Manual paste: no provider verification.",
    },
    skills_or_context_used: ["profile-test"],
    verdict,
    original_answer_grade: { score_0_to_10: 6, grade_label: "mixed", why: "History helps but privacy matters." },
    answer_to_challenge_poster: "Show only public, unsuppressed contribution history with links back to debates and artifacts.",
    reasoning_summary: "Public reputation should be useful without exposing raw private data.",
    strongest_objections: ["Private or suppressed work must not appear."],
    missing_assumptions_or_context: [],
    alternative_recommendation: "Build a public contributor profile with share CTAs.",
    risks_and_failure_modes: ["Turning reputation into model-spend bragging."],
    claims_to_verify: ["Badge scoring ignores raw volume alone."],
    confidence: { level: "medium", why: "Based on the public loop." },
    what_would_change_my_mind: [],
    suggested_follow_up_questions: [],
    safety_or_scope_notes: [],
    abuse_or_prompt_injection_flags: [],
    raw_output_summary: "Public profile contribution.",
  };
}

describe("contributor profile page", () => {
  beforeEach(async () => {
    await resetStoreForTests();
  });

  it("renders useful public contribution history with profile sharing and referral routes", async () => {
    const publicChallenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 20, brief });
    const contribution = await createContribution({
      challengeId: publicChallenge.id,
      contributorId: "profile-scout",
      contributorLabel: "Profile Scout",
      card: card(publicChallenge.id),
    });
    await rateContribution({ contributionId: contribution.id, raterId: "poster", usefulness: 8, safety: 8 });
    await synthesizeChallenge(publicChallenge.id);

    const html = renderToStaticMarkup(await ProfilePage({ params: Promise.resolve({ id: "profile-scout" }) }));

    expect(html).toContain("Contributor");
    expect(html).toContain("Profile Scout");
    expect(html).toContain("Reputation");
    expect(html).toContain("Credits earned");
    expect(html).toContain("Share profile proof");
    expect(html).toContain("Profiles should carry useful public proof");
    expect(html).toContain("useful 8/10");
    expect(html).toContain("Open artifact");
    expect(html).toContain(`href="/answers/${publicChallenge.id}"`);
    expect(html).toContain("Copy profile link");
    expect(html).toContain("Browse challenges");
    expect(html).toContain('href="/lobby?ref=profile%3Aprofile-scout"');
    expect(html).toContain('href="/challenges/new?ref=profile%3Aprofile-scout"');
    expect(html).toContain('href="/answers?ref=profile%3Aprofile-scout"');
    expect(html).toContain("Public usefulness inside Challenge My AI");
    expect(html).not.toContain("Model/provenance label");
    expect(html).not.toContain("manual-provider");
    expect(html).not.toContain("manual-model");
  });

  it("excludes private and suppressed contribution history from public profiles", async () => {
    const publicChallenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 20, brief: { ...brief, title: "Visible public challenge" } });
    const visible = await createContribution({ challengeId: publicChallenge.id, contributorId: "profile-scout", contributorLabel: "Profile Scout", card: card(publicChallenge.id, "Visible public verdict") });
    await rateContribution({ contributionId: visible.id, raterId: "poster", usefulness: 8, safety: 8 });

    const privateChallenge = await createChallenge({ posterId: "poster", visibility: "private", reward: 20, brief: { ...brief, title: "Private hidden challenge" } });

    const suppressedChallenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 20, brief: { ...brief, title: "Suppressed public challenge" } });
    const suppressed = await createContribution({ challengeId: suppressedChallenge.id, contributorId: "profile-scout", contributorLabel: "Profile Scout", card: card(suppressedChallenge.id, "Suppressed hidden verdict") });
    await suppressContribution(suppressed.id, "unsafe_content", "mod");

    const html = renderToStaticMarkup(await ProfilePage({ params: Promise.resolve({ id: "profile-scout" }) }));

    expect(html).toContain("Visible public challenge");
    expect(html).toContain("Visible public verdict");
    expect(html).not.toContain("Private hidden challenge");
    expect(html).not.toContain("Private hidden verdict");
    expect(html).not.toContain("Suppressed public challenge");
    expect(html).not.toContain("Suppressed hidden verdict");
    expect(html).not.toContain("password");
    expect(html).not.toContain("transcript.jsonl");
  });

  it("keeps private-only credit events out of public profile reputation", async () => {
    const privateChallenge = await createChallenge({ posterId: "poster", visibility: "private", reward: 20, brief: { ...brief, title: "Private credited challenge" } });
    await appendCredit({ userId: "private-profile-scout", challengeId: privateChallenge.id, contributionId: `${privateChallenge.id}-private-contribution`, amount: 20, reason: "Private challenge fixture credit", kind: "usefulness_reward", source: "challenge_poster" });

    const html = renderToStaticMarkup(await ProfilePage({ params: Promise.resolve({ id: "private-profile-scout" }) }));

    expect(html).toContain("Credits earned");
    expect(html).toContain("No public history yet.");
    expect(html).not.toContain("Private credited challenge");
    expect(html).not.toContain("Private credited verdict");
    expect(html).not.toContain('>20</p>');
  });

  it("keeps email-looking contributor labels out of public profiles", async () => {
    const publicChallenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 20, brief: { ...brief, title: "Email label challenge" } });
    const contribution = await createContribution({ challengeId: publicChallenge.id, contributorId: "email-label-user", contributorLabel: "person@example.com", card: card(publicChallenge.id, "Email label verdict") });
    await rateContribution({ contributionId: contribution.id, raterId: "poster", usefulness: 8, safety: 8 });

    const html = renderToStaticMarkup(await ProfilePage({ params: Promise.resolve({ id: "email-label-user" }) }));

    expect(html).toContain("Contributor email-label-user");
    expect(html).toContain("Email label challenge");
    expect(html).not.toContain("person@example.com");
  });
});
