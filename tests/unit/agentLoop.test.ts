import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { GET as agentFeedGet } from "@/app/api/agent/feed/route";
import { POST as agentWatchPost } from "@/app/api/agent/watch/route";
import { POST as agentContributionPost } from "@/app/api/agent/contributions/route";
import { POST as demoRunPost } from "@/app/api/agent/demo-run/route";
import { ContributionCard } from "@/components/contribution/ContributionCard";
import { createAgentContribution, createChallenge, listAgentActivity, listAgentProfiles, listContributions, resetStoreForTests, synthesizeChallenge, watchChallenge } from "@/lib/store";
import { resetRateLimitsForTests } from "@/lib/security/rateLimit";
import type { ChallengeBrief, ContributionCard as ContributionCardPayload } from "@/lib/types";
import { createChallengeSemantics } from "@/lib/challenges/intent";

const brief: ChallengeBrief = {
  schema_version: "1.0",
  ...createChallengeSemantics({ intent: "solve", successCriteria: ["Find risky assumptions"], status: "confirmed", changeReason: "Confirmed Agent loop fixture criteria." }),
  title: "Agent challenge",
  category: "product",
  challenge_mode_requested: ["critique", "red_team"],
  problem_statement: "Pressure-test this answer.",
  original_ai_answer: "Ship it as-is.",
  context: "Local test context.",
  constraints: [],
  success_criteria: ["Find risky assumptions"],
  assumptions_to_test: ["Users want this exact flow"],
  claims_to_check: ["The answer is safe to act on"],
  known_risks: ["False confidence"],
  what_a_useful_response_should_address: ["Risks", "Alternatives"],
  privacy_sensitivity: "public_ok",
  redactions_made: [],
  abuse_or_safety_flags: [],
  missing_information: [],
  raw_material_summary: "Agent-loop test challenge",
};

function headers(extra: Record<string, string> = {}) {
  return {
    "x-cmai-agent-id": "agent-test",
    "x-cmai-agent-label": "Test Agent",
    "x-cmai-agent-owner-id": "owner-test",
    "x-cmai-agent-capabilities": "critique,red_team",
    ...extra,
  };
}

function request(url: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
  return new Request(url, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...headers(extraHeaders) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function cardFor(challengeId: string): ContributionCardPayload {
  return {
    schema_version: "1.0",
    challenge_id: challengeId,
    contribution_mode: "critique",
    contributor_ai_label: "Test Agent",
    model_provenance: {
      source: "provider_api_verified",
      provider: "openrouter",
      model: "anthropic/claude-3.5-sonnet",
      model_display_name: "Claude 3.5 Sonnet via OpenRouter",
      adapter: "agent_api",
      verified: true,
      provider_model_verified: true,
      verification_notes: "Unit test simulates a provider API verified response.",
      evidence_type: "provider_metadata",
      verification_status: "metadata_verified",
      provider_response_id: "resp_forged",
    },
    skills_or_context_used: ["unit-test"],
    verdict: "Needs more evidence.",
    original_answer_grade: { score_0_to_10: 4, grade_label: "mixed", why: "Underspecified." },
    answer_to_challenge_poster: "Test the main assumption before acting.",
    reasoning_summary: "The answer lacks explicit failure modes.",
    strongest_objections: ["Assumption is untested"],
    missing_assumptions_or_context: ["Audience"],
    alternative_recommendation: "Run a smaller proof first.",
    risks_and_failure_modes: ["False confidence"],
    claims_to_verify: ["Claim one"],
    confidence: { level: "medium", why: "Brief-only critique." },
    what_would_change_my_mind: ["Evidence"],
    suggested_follow_up_questions: ["What would fail?"],
    safety_or_scope_notes: ["Challenge text stayed inert."],
    abuse_or_prompt_injection_flags: [],
    raw_output_summary: "Unit test card",
  };
}

describe("agent-native participation loop", () => {
  beforeEach(async () => {
    await resetStoreForTests();
    resetRateLimitsForTests();
  });

  afterEach(() => {
    delete process.env.CMAI_ENFORCE_RATE_LIMITS;
    resetRateLimitsForTests();
  });

  it("stores agent profiles, watches, and activity", async () => {
    const challenge = await createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });
    const result = await watchChallenge({ agentId: "agent-store", agentLabel: "Store Agent", ownerId: "owner", challengeId: challenge.id });

    expect(result.agent.watchCount).toBe(1);
    expect(await listAgentProfiles()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "agent-store", label: "Store Agent", watchCount: 1 })]));
    expect(await listAgentActivity()).toEqual(expect.arrayContaining([expect.objectContaining({ action: "watched_challenge", challengeId: challenge.id })]));
  });

  it("returns a compact agent feed for public challenges", async () => {
    const challenge = await createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });
    await createChallenge({ posterId: "op", visibility: "private", reward: 10, brief: { ...brief, title: "Private" } });
    const synthesized = await createChallenge({ posterId: "op", visibility: "public", reward: 10, brief: { ...brief, title: "Already synthesized" } });
    await synthesizeChallenge(synthesized.id);

    const response = await agentFeedGet(request("http://test.local/api/agent/feed"));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.agent).toMatchObject({ id: "agent-test", label: "Test Agent" });
    expect(json.challenges).toEqual(expect.arrayContaining([expect.objectContaining({ id: challenge.id, title: challenge.title, watchUrl: "/api/agent/watch", answerState: "needs_perspectives", promptUrl: `/api/challenges/${challenge.id}/prompt` })]));
    expect(json.challenges).toEqual(expect.arrayContaining([expect.objectContaining({ id: "seed-landing-page-positioning-review", title: "Does this landing page explain token-maxing?", answerStateLabel: "needs perspectives", matchReasons: expect.arrayContaining(["no useful perspectives yet"]) })]));
    expect(json.answers).toEqual(expect.arrayContaining([expect.objectContaining({ id: synthesized.id, roomUrl: `/challenges/${synthesized.id}`, artifactUrl: `/answers/${synthesized.id}` })]));
    expect(JSON.stringify(json.answers)).not.toContain(challenge.id);
  });

  it("rate-limits repeated Agent feed reads with the named feed policy, not the generic Agent policy", async () => {
    process.env.CMAI_ENFORCE_RATE_LIMITS = "1";
    await createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });

    for (let index = 0; index < 120; index += 1) {
      const response = await agentFeedGet(request("http://test.local/api/agent/feed"));
      expect(response.status).toBe(200);
    }

    const limited = await agentFeedGet(request("http://test.local/api/agent/feed"));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "rate_limited", details: { policy: "agent_feed", limit: 120 } });
  });

  it("lets agents search past public answers from the feed endpoint", async () => {
    const publicChallenge = await createChallenge({
      posterId: "op",
      visibility: "public",
      reward: 10,
      brief: { ...brief, title: "Deployment obstacle", problem_statement: "A deployment keeps looping through session redirects.", original_ai_answer: "Rewrite the app." },
    });
    await createAgentContribution({
      agentId: "agent-search",
      agentLabel: "Search Agent",
      ownerId: "owner",
      challengeId: publicChallenge.id,
      card: { ...cardFor(publicChallenge.id), alternative_recommendation: "Patch cookie refresh before rewriting routes.", risks_and_failure_modes: ["Session redirect loop"] },
    });
    await synthesizeChallenge(publicChallenge.id);
    await createChallenge({ posterId: "op", visibility: "private", reward: 10, brief: { ...brief, title: "Private deployment obstacle", problem_statement: "Private deployment session redirect loop." } });

    const response = await agentFeedGet(request("http://test.local/api/agent/feed?q=session%20redirect"));
    expect(response.status).toBe(200);
    const json = await response.json();

    expect(json.answers).toEqual([
      expect.objectContaining({
        id: publicChallenge.id,
        title: "Deployment obstacle",
        currentAnswer: "Patch cookie refresh before rewriting routes.",
        whatChanged: expect.arrayContaining([expect.stringContaining("Patch cookie refresh")]),
        risks: expect.arrayContaining(["Session redirect loop"]),
        searchSignals: expect.arrayContaining([expect.objectContaining({ label: expect.any(String), excerpt: expect.any(String) })]),
        roomUrl: `/challenges/${publicChallenge.id}`,
        debateUrl: `/challenges/${publicChallenge.id}`,
        artifactUrl: `/answers/${publicChallenge.id}`,
        reusePromptUrl: `/api/answers/${publicChallenge.id}/artifact`,
      }),
    ]);
    expect(JSON.stringify(json.answers)).not.toContain("Private deployment obstacle");
    expect(await listAgentActivity()).toEqual(expect.arrayContaining([expect.objectContaining({ summary: expect.stringContaining("searched 0 active challenges and 1 decision artifact") })]));
  });

  it("validates and records agent contribution submissions", async () => {
    const challenge = await createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });
    const denied = await agentContributionPost(request("http://test.local/api/agent/contributions", { challengeId: challenge.id, card: { ...cardFor(challenge.id), challenge_id: "wrong" } }));
    expect(denied.status).toBe(400);
    expect(await denied.json()).toMatchObject({ code: "challenge_id_mismatch" });

    const allowed = await agentContributionPost(request("http://test.local/api/agent/contributions", { challengeId: challenge.id, card: cardFor(challenge.id) }));
    expect(allowed.status).toBe(200);
    const json = await allowed.json();
    expect(json.contribution).toMatchObject({ contributorId: "agent-test", contributorKind: "agent", contributorLabel: "Test Agent" });
    expect(json.contribution.card.model_provenance).toMatchObject({
      source: "self_attested",
      verified: false,
      provider_model_verified: false,
      evidence_type: "user_claim",
      verification_status: "attested",
    });
    expect(json.contribution.card.model_provenance.provider_response_id).toBeUndefined();
    expect(await listContributions(challenge.id)).toHaveLength(1);
    expect(await listAgentActivity()).toEqual(expect.arrayContaining([expect.objectContaining({ action: "submitted_contribution", contributionId: json.contribution.id })]));

    const privateChallenge = await createChallenge({ posterId: "op", visibility: "private", reward: 10, brief: { ...brief, title: "Private agent target" } });
    const privateResponse = await agentContributionPost(request("http://test.local/api/agent/contributions", { challengeId: privateChallenge.id, card: cardFor(privateChallenge.id) }));
    expect(privateResponse.status).toBe(404);
  });

  it("runs the deterministic demo agent without duplicating its contribution", async () => {
    await createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });

    const first = await demoRunPost();
    expect(first.status).toBe(200);
    const firstJson = await first.json();
    expect(firstJson.contribution).toMatchObject({ contributorKind: "agent", contributorId: "agent-redteam-demo" });

    const second = await demoRunPost();
    expect(second.status).toBe(200);
    const secondJson = await second.json();
    expect(secondJson.reusedContribution).toBe(true);
    const agentContributions = (await listContributions(firstJson.challenge.id)).filter((contribution) => contribution.contributorId === "agent-redteam-demo");
    expect(agentContributions).toHaveLength(1);
  });

  it("renders agent contribution identity visibly", async () => {
    const challenge = await createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });
    const contribution = {
      id: "contribution-agent",
      challengeId: challenge.id,
      contributorId: "agent-test",
      contributorKind: "agent" as const,
      contributorLabel: "Test Agent",
      createdAt: new Date().toISOString(),
      status: "posted" as const,
      externallyGenerated: true,
      card: cardFor(challenge.id),
      communityScore: 2,
    };

    const html = renderToStaticMarkup(createElement(ContributionCard, { contribution }));
    expect(html).toContain("Agent perspective");
    expect(html).toContain("Test Agent");
    expect(html).toContain("Claude 3.5 Sonnet via OpenRouter");
    expect(html).toContain("API-verified model");
  });

  it("renders sandbox receipt provider metadata without claiming provider-signed proof", async () => {
    const challenge = await createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });
    const contribution = {
      id: "contribution-agent-metadata",
      challengeId: challenge.id,
      contributorId: "agent-test",
      contributorKind: "agent" as const,
      contributorLabel: "Test Agent",
      createdAt: new Date().toISOString(),
      status: "posted" as const,
      externallyGenerated: true,
      card: {
        ...cardFor(challenge.id),
        model_provenance: {
          source: "hermes_sandbox_run" as const,
          provider: "openrouter",
          model: "anthropic/claude-sonnet-4",
          requested_model: "anthropic/claude-sonnet-4",
          returned_model: "anthropic/claude-sonnet-4-20260701",
          model_display_name: "Claude Sonnet 4 via OpenRouter",
          adapter: "hermes_sandbox",
          verified: true,
          provider_model_verified: true,
          verification_notes: "Generated in a Challenge My AI-controlled Hermes run cell with scoped provider metadata attached.",
          evidence_type: "provider_metadata" as const,
          verification_status: "metadata_verified" as const,
          receipt_id: "hr_provider_metadata",
          receipt_sha256: "f".repeat(64),
          provider_response_id: "provider_resp_123",
        },
      },
      communityScore: 2,
    };

    const html = renderToStaticMarkup(createElement(ContributionCard, { contribution }));
    expect(html).toContain("sandboxed Hermes run + provider metadata");
    expect(html).toContain("hr_provider_metadata");
    expect(html).toContain("provider_resp_123");
    expect(html).toContain("Provider-returned metadata was attached to the Challenge My AI-signed run receipt");
    expect(html).toContain("this is not a provider-signed receipt");
    expect(html).not.toContain("provider-signed proof");
  });

  it("returns not found when an agent watches a missing or private challenge", async () => {
    const response = await agentWatchPost(request("http://test.local/api/agent/watch", { challengeId: "missing" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });

    const privateChallenge = await createChallenge({ posterId: "op", visibility: "private", reward: 10, brief: { ...brief, title: "Private watch target" } });
    const privateResponse = await agentWatchPost(request("http://test.local/api/agent/watch", { challengeId: privateChallenge.id }));
    expect(privateResponse.status).toBe(404);
  });

  it("rate-limits repeated Agent watch requests for one target", async () => {
    process.env.CMAI_ENFORCE_RATE_LIMITS = "1";
    const challenge = await createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });

    for (let index = 0; index < 60; index += 1) {
      const response = await agentWatchPost(request("http://test.local/api/agent/watch", { challengeId: challenge.id }));
      expect(response.status).toBe(200);
    }

    const limited = await agentWatchPost(request("http://test.local/api/agent/watch", { challengeId: challenge.id }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "rate_limited", details: { policy: "agent_watch", limit: 60, retryAfterMs: expect.any(Number) } });
  });

  it("requires agent identity for agent endpoints", async () => {
    const response = await agentWatchPost(new Request("http://test.local/api/agent/watch", { method: "POST", body: JSON.stringify({ challengeId: "x" }) }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "agent_unauthenticated" });
  });
});
