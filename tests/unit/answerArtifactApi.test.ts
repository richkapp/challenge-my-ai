import { beforeEach, describe, expect, it } from "vitest";
import { GET as answerSearchGet, POST as answerSearchPost } from "@/app/api/answers/route";
import { GET as artifactGet } from "@/app/api/answers/[id]/artifact/route";
import { createAgentContribution, createChallenge, resetStoreForTests, suppressChallenge, synthesizeChallenge } from "@/lib/store";
import type { ChallengeBrief, ContributionCard } from "@/lib/types";
import { createChallengeSemantics } from "@/lib/challenges/intent";

const brief: ChallengeBrief = {
  schema_version: "1.0",
  ...createChallengeSemantics({ intent: "solve", successCriteria: ["Find the safer sequence"], status: "confirmed", changeReason: "Confirmed artifact API fixture criteria." }),
  title: "Artifact API challenge",
  category: "product",
  challenge_mode_requested: ["critique", "risk_audit"],
  problem_statement: "A launch plan needs a narrower builder beta before a public announcement.",
  original_ai_answer: "Announce the product broadly first.",
  context: "The user wants reusable proof from prior debates.",
  constraints: ["Keep public details safe"],
  success_criteria: ["Find the safer sequence"],
  assumptions_to_test: ["A broad public announcement is best"],
  claims_to_check: ["Builder beta improves learning"],
  known_risks: ["Generic launch"],
  what_a_useful_response_should_address: ["sequencing", "risk"],
  privacy_sensitivity: "public_ok",
  redactions_made: [],
  abuse_or_safety_flags: [],
  missing_information: [],
  raw_material_summary: "Artifact API fixture",
};

function card(challengeId: string): ContributionCard {
  return {
    schema_version: "1.0",
    challenge_id: challengeId,
    contribution_mode: "risk_audit",
    contributor_ai_label: "Test Agent",
    skills_or_context_used: ["unit-test"],
    verdict: "The broad launch is too generic.",
    original_answer_grade: { score_0_to_10: 4, grade_label: "weak", why: "Too broad." },
    answer_to_challenge_poster: "Use a builder beta first.",
    reasoning_summary: "A narrower first wedge gives better critiques.",
    strongest_objections: ["Broad audience feedback is low signal."],
    missing_assumptions_or_context: [],
    alternative_recommendation: "Run a builder beta before announcing broadly.",
    risks_and_failure_modes: ["Generic launch"],
    claims_to_verify: ["Beta feedback is more useful"],
    confidence: { level: "medium", why: "Known launch pattern." },
    what_would_change_my_mind: [],
    suggested_follow_up_questions: [],
    safety_or_scope_notes: [],
    abuse_or_prompt_injection_flags: [],
    raw_output_summary: "Builder beta first.",
  };
}

function request(path: string) {
  return new Request(`http://test.local${path}`);
}

function postRequest(path: string, body: unknown) {
  return new Request(`http://test.local${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

async function createArtifactReadyChallenge() {
  const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 20, brief });
  await createAgentContribution({ agentId: "agent-artifact", challengeId: challenge.id, card: card(challenge.id) });
  await synthesizeChallenge(challenge.id);
  return challenge;
}

describe("answer artifact API", () => {
  beforeEach(async () => {
    await resetStoreForTests();
  });

  it("returns a full artifact for a synthesized public challenge", async () => {
    const challenge = await createArtifactReadyChallenge();

    const response = await artifactGet(request(`/api/answers/${challenge.id}/artifact`), { params: Promise.resolve({ id: challenge.id }) });
    expect(response.status).toBe(200);
    const json = await response.json();

    expect(json.artifact).toMatchObject({
      id: challenge.id,
      artifactUrl: `/answers/${challenge.id}`,
      debateUrl: `/challenges/${challenge.id}`,
      currentBestAnswer: "Run a builder beta before announcing broadly.",
    });
    expect(json.artifact.reusePrompt).toContain("Use this prior Challenge My AI decision artifact as context");
  });

  it("searches compact public artifacts", async () => {
    const challenge = await createArtifactReadyChallenge();

    const response = await answerSearchGet(request("/api/answers?q=builder%20beta&limit=3"));
    expect(response.status).toBe(200);
    const json = await response.json();

    expect(json.query).toBe("builder beta");
    expect(json.artifacts).toEqual([
      expect.objectContaining({
        id: challenge.id,
        artifactUrl: `/answers/${challenge.id}`,
        debateUrl: `/challenges/${challenge.id}`,
        currentBestAnswer: "Run a builder beta before announcing broadly.",
        reusePromptUrl: `/api/answers/${challenge.id}/artifact`,
        whatChanged: expect.arrayContaining([expect.stringContaining("builder beta")]),
        searchScore: expect.any(Number),
        searchSignals: expect.arrayContaining([expect.objectContaining({ label: expect.any(String), excerpt: expect.any(String) })]),
      }),
    ]);
    expect(json.artifacts[0].reusePrompt).toBeUndefined();

    const promptResponse = await answerSearchPost(postRequest("/api/answers", { query: "builder beta", limit: 3, includePrompt: true }));
    const promptJson = await promptResponse.json();
    expect(promptJson.query).toBeUndefined();
    expect(promptJson.artifacts[0].reusePrompt).toContain("Use this prior Challenge My AI decision artifact as context");
    expect(promptJson.artifacts[0].reusePrompt).toContain("What transfers from the prior artifact");
  });

  it("excludes private, suppressed, and unsynthesized challenges", async () => {
    const publicChallenge = await createArtifactReadyChallenge();
    const privateChallenge = await createChallenge({ posterId: "poster", visibility: "private", reward: 20, brief: { ...brief, title: "Private artifact" } });
    const suppressedChallenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 20, brief: { ...brief, title: "Suppressed artifact" } });
    await createAgentContribution({ agentId: "agent-suppressed", challengeId: suppressedChallenge.id, card: card(suppressedChallenge.id) });
    await synthesizeChallenge(suppressedChallenge.id);
    await suppressChallenge(suppressedChallenge.id, "unsafe");
    await createChallenge({ posterId: "poster", visibility: "public", reward: 20, brief: { ...brief, title: "Unsynthesized artifact" } });

    const searchResponse = await answerSearchGet(request("/api/answers?q=builder%20beta&limit=99"));
    const searchJson = await searchResponse.json();
    expect(searchJson.artifacts.map((artifact: { id: string }) => artifact.id)).toEqual([publicChallenge.id]);

    const privateResponse = await artifactGet(request(`/api/answers/${privateChallenge.id}/artifact`), { params: Promise.resolve({ id: privateChallenge.id }) });
    expect(privateResponse.status).toBe(404);
    const suppressedResponse = await artifactGet(request(`/api/answers/${suppressedChallenge.id}/artifact`), { params: Promise.resolve({ id: suppressedChallenge.id }) });
    expect(suppressedResponse.status).toBe(404);
  });

  it("finds the seeded artifact from concise cross-field terms", async () => {
    const response = await answerSearchGet(request("/api/answers?q=right%20rail&limit=3"));
    expect(response.status).toBe(200);
    const json = await response.json();

    expect(json.artifacts.map((artifact: { id: string }) => artifact.id)).toContain("seed-reddit-ai-debate-feed");
  });

  it("clamps excessive limits", async () => {
    await createArtifactReadyChallenge();

    const response = await answerSearchGet(request("/api/answers?limit=500"));
    expect(response.status).toBe(200);
    const json = await response.json();

    expect(json.limit).toBe(50);
    expect(json.artifacts.length).toBeLessThanOrEqual(50);
  });
});
