import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as listChallengesGet, POST as createChallengePost } from "@/app/api/challenges/route";
import { POST as parseChallengePost } from "@/app/api/challenges/parse/route";
import { GET as contributionPromptGet } from "@/app/api/challenges/[id]/prompt/route";
import { GET as listChallengeContributionsGet, POST as createContributionPost } from "@/app/api/challenges/[id]/contributions/route";
import { POST as parseContributionPost } from "@/app/api/challenges/[id]/contributions/parse/route";
import { POST as synthesisPost } from "@/app/api/challenges/[id]/synthesis/route";
import { POST as rateContributionPost } from "@/app/api/contributions/[id]/ratings/route";
import { POST as communityVotePost } from "@/app/api/contributions/[id]/community-votes/route";
import { POST as moderationActionPost } from "@/app/api/moderation/actions/route";
import { POST as moderationReportPost } from "@/app/api/moderation/reports/route";
import { POST as billingCheckoutPost } from "@/app/api/billing/checkout/route";
import { GET as answerSearchGet } from "@/app/api/answers/route";
import { GET as artifactGet } from "@/app/api/answers/[id]/artifact/route";
import { createChallenge, createContribution, getChallenge, listContributions, listCreditEvents, listModerationEvents, resetStoreForTests, suppressChallenge, suppressContribution, synthesizeChallenge, watchChallenge } from "@/lib/store/local";
import { resetRateLimitsForTests } from "@/lib/security/rateLimit";
import { challengeIntents, challengeIntentPolicy, createChallengeSemantics, defaultSuccessCriteria, reviseChallengeCriteria, type ChallengeIntent } from "@/lib/challenges/intent";
import { challengePublicationAcknowledgementPayload } from "@/lib/challenges/intentAcknowledgement";
import { createHash } from "node:crypto";

const criteria = defaultSuccessCriteria("pressure_test");
const brief = { schema_version: "1.0" as const, ...createChallengeSemantics({ intent: "pressure_test", successCriteria: criteria, status: "confirmed", changeReason: "Confirmed API route fixture criteria." }), title: "T", category: "product", challenge_mode_requested: ["critique" as const], problem_statement: "P", original_ai_answer: "A", context: "C", constraints: [], success_criteria: criteria, assumptions_to_test: [], claims_to_check: [], known_risks: [], what_a_useful_response_should_address: [], privacy_sensitivity: "public_ok" as const, redactions_made: [], abuse_or_safety_flags: [], missing_information: [], raw_material_summary: "S" };

function briefForIntent(intent: ChallengeIntent) {
  const successCriteria = defaultSuccessCriteria(intent);
  return {
    ...brief,
    ...createChallengeSemantics({ intent, successCriteria, status: "confirmed", changeReason: `Poster confirmed ${intent} criteria.` }),
    title: `Valid ${intent} challenge`,
    success_criteria: successCriteria,
  };
}

function cardFor(challengeId: string) {
  return {
    schema_version: "1.0" as const,
    challenge_id: challengeId,
    contribution_mode: "critique" as const,
    contributor_ai_label: "test",
    skills_or_context_used: [],
    verdict: "V",
    original_answer_grade: { score_0_to_10: 5, grade_label: "mixed" as const, why: "ok" },
    answer_to_challenge_poster: "Answer",
    reasoning_summary: "Summary",
    strongest_objections: [],
    missing_assumptions_or_context: [],
    alternative_recommendation: "Alt",
    risks_and_failure_modes: [],
    claims_to_verify: [],
    confidence: { level: "medium" as const, why: "ok" },
    what_would_change_my_mind: [],
    suggested_follow_up_questions: [],
    safety_or_scope_notes: [],
    abuse_or_prompt_injection_flags: [],
    raw_output_summary: "S",
  };
}

function jsonRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://test.local/api", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(withChallengeAcknowledgement(body)) });
}

function withChallengeAcknowledgement(body: unknown): unknown {
  if (!body || typeof body !== "object" || !("brief" in body) || !("reward" in body) || !("visibility" in body)) return body;
  const requestBody = body as { brief: typeof brief; confirmPrivacyOverride?: boolean; criteriaAcknowledgement?: unknown; privacyAcknowledgement?: unknown } & Record<string, unknown>;
  if (requestBody.criteriaAcknowledgement) return body;
  try {
    const briefHash = createHash("sha256").update(challengePublicationAcknowledgementPayload(requestBody.brief)).digest("hex");
    return {
      ...requestBody,
      criteriaAcknowledgement: { briefHash },
      privacyAcknowledgement: requestBody.confirmPrivacyOverride ? { briefHash } : requestBody.privacyAcknowledgement,
    };
  } catch {
    return body;
  }
}

describe("API route guards", () => {
  beforeEach(() => {
    resetStoreForTests();
    resetRateLimitsForTests();
  });

  afterEach(() => {
    delete process.env.CMAI_ENFORCE_RATE_LIMITS;
    resetRateLimitsForTests();
  });

  it("returns 401 before parsing anonymous challenge mutations", async () => {
    const response = await createChallengePost(jsonRequest({ brief, reward: 1, visibility: "public" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthenticated" });
  });

  it("accepts all seven canonical intents and returns bounded public semantics without internal history", async () => {
    for (const intent of challengeIntents) {
      const response = await createChallengePost(jsonRequest({ brief: briefForIntent(intent), reward: 12, visibility: "public" }, { "x-cmai-user-id": "op" }));
      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.challenge).toMatchObject({
        title: `Valid ${intent} challenge`,
        activeCriteriaVersion: 1,
        publicEligibility: { eligible: true, criteriaVersion: 1 },
        brief: {
          challenge_intent: intent,
          criteria_status: "confirmed",
          criteria_version: 1,
          successful_outcomes: [...challengeIntentPolicy(intent).successfulOutcomes],
          reward_posture: { basis: "poster_confirmed_impact", funding_state: "declarative_only" },
        },
      });
      expect(json.challenge.brief.criteria_history).toBeUndefined();
      expect(json.challenge.posterId).toBeUndefined();
      expect(json.challenge.publicEligibility.assessedAt).toBeUndefined();
    }

    const list = await listChallengesGet();
    expect(list.status).toBe(200);
    const listed = await list.json();
    expect(listed.challenges.filter((challenge: { title: string }) => challenge.title.startsWith("Valid "))).toHaveLength(challengeIntents.length);
    expect(listed.challenges.every((challenge: Record<string, unknown>) => challenge.posterId === undefined)).toBe(true);
    expect(listed.challenges.every((challenge: { brief: Record<string, unknown> }) => challenge.brief.criteria_history === undefined)).toBe(true);
    expect(listCreditEvents()).toHaveLength(0);
  });

  it("rejects acknowledgements after the reviewed brief changes", async () => {
    const reviewedBrief = briefForIntent("decide");
    const reviewedHash = createHash("sha256").update(challengePublicationAcknowledgementPayload(reviewedBrief)).digest("hex");
    const changedBrief = { ...reviewedBrief, title: "Changed after review" };
    const response = await createChallengePost(jsonRequest({
      brief: changedBrief,
      reward: 12,
      visibility: "public",
      criteriaAcknowledgement: { briefHash: reviewedHash },
    }, { "x-cmai-user-id": "op" }));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: "stale_challenge_acknowledgement",
      details: { path: "criteriaAcknowledgement.briefHash" },
    });
    const changedHash = createHash("sha256").update(challengePublicationAcknowledgementPayload(changedBrief)).digest("hex");
    const privacyResponse = await createChallengePost(jsonRequest({
      brief: changedBrief,
      reward: 12,
      visibility: "public",
      confirmPrivacyOverride: true,
      criteriaAcknowledgement: { briefHash: changedHash },
      privacyAcknowledgement: { briefHash: reviewedHash },
    }, { "x-cmai-user-id": "op" }));
    expect(privacyResponse.status).toBe(422);
    expect(await privacyResponse.json()).toMatchObject({
      code: "stale_challenge_acknowledgement",
      details: { path: "privacyAcknowledgement.briefHash" },
    });
    const list = await listChallengesGet();
    expect(list.status).toBe(200);
    expect((await list.json()).challenges.some((challenge: { title: string }) => challenge.title === changedBrief.title)).toBe(false);
  });

  it("rejects invalid intent/outcome pairs instead of trusting client-authored semantics", async () => {
    const decideBrief = briefForIntent("decide");
    const invalid = {
      ...decideBrief,
      successful_outcomes: ["solved" as const],
      criteria_history: decideBrief.criteria_history.map((entry) => ({ ...entry, successful_outcomes: ["solved" as const] })),
    };
    const response = await createChallengePost(jsonRequest({ brief: invalid, reward: 1, visibility: "public" }, { "x-cmai-user-id": "op" }));

    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.code).toBe("invalid_challenge_intent");
    expect(json.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: "successful_outcomes" })]));
  });

  it("regenerates safe client-authored history and reward posture as server-owned version one fields", async () => {
    const clientVersionTwo = reviseChallengeCriteria(briefForIntent("solve"), {
      intent: "solve",
      successCriteria: ["The replacement blocker is observably removed."],
      status: "confirmed",
      contributionCount: 1,
      changeReason: "Poster replaced the original threshold after review.",
    });
    const response = await createChallengePost(jsonRequest({ brief: clientVersionTwo, reward: 5, visibility: "public" }, { "x-cmai-user-id": "op" }));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.challenge).toMatchObject({ activeCriteriaVersion: 1, brief: { criteria_version: 1, challenge_intent: "solve" } });
    expect(json.challenge.brief.criteria_history).toBeUndefined();
    expect(getChallenge(json.challenge.id)?.brief.criteria_history).toEqual([
      expect.objectContaining({ version: 1, change_reason: "Initial challenge criteria persisted by the server." }),
    ]);
  });

  it("blocks secrets hidden only in client-authored criteria history before persistence", async () => {
    const clientVersionTwo = reviseChallengeCriteria(briefForIntent("solve"), {
      intent: "solve",
      successCriteria: ["The current blocker is observably removed."],
      status: "confirmed",
      contributionCount: 1,
      changeReason: "Poster replaced the original threshold after review.",
    });
    const unsafe = {
      ...clientVersionTwo,
      criteria_history: clientVersionTwo.criteria_history.map((entry, index) => index === 0
        ? { ...entry, success_criteria: ["Use api_key=sk-aaaaaaaaaaaaaaaa when checking the old threshold."] }
        : entry),
    };
    const response = await createChallengePost(jsonRequest({ brief: unsafe, reward: 5, visibility: "public" }, { "x-cmai-user-id": "op" }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "publication_policy_blocked",
      details: { safetyFlags: expect.arrayContaining(["secret_exposure"]), relatedArtifactSearchAllowed: false },
    });
    const list = await listChallengesGet();
    expect((await list.json()).challenges.some((challenge: { id: string }) => !challenge.id.startsWith("seed-"))).toBe(false);

    const unsafeReason = {
      ...clientVersionTwo,
      criteria_history: clientVersionTwo.criteria_history.map((entry, index) => index === 0
        ? { ...entry, change_reason: "Revised after seeing api_key=abcdef123456." }
        : entry),
    };
    const reasonResponse = await createChallengePost(jsonRequest({ brief: unsafeReason, reward: 5, visibility: "public" }, { "x-cmai-user-id": "op" }));
    expect(reasonResponse.status).toBe(409);
    expect((await reasonResponse.json()).details.safetyFlags).toContain("secret_exposure");
  });

  it("returns field-level errors for empty, invalid, oversized, and over-count intake values", async () => {
    const cases = [
      { patch: { title: "   " }, path: "brief.title" },
      { patch: { category: "made_up_category" }, path: "brief.category" },
      { patch: { problem_statement: "x".repeat(4_001) }, path: "brief.problem_statement" },
      { patch: { challenge_mode_requested: ["critique", "red_team", "alternate_proposal", "risk_audit"] }, path: "brief.challenge_mode_requested" },
      { patch: { constraints: Array.from({ length: 13 }, (_, index) => `Constraint ${index}`) }, path: "brief.constraints" },
      { patch: { missing_information: ["x".repeat(241)] }, path: "brief.missing_information.0" },
      { patch: { missing_information: ["Visually spoofed\u202Evalue"] }, path: "brief.missing_information.0" },
    ];

    for (const testCase of cases) {
      const response = await createChallengePost(jsonRequest({ brief: { ...brief, ...testCase.patch }, reward: 1, visibility: "public" }, { "x-cmai-user-id": "op" }));
      expect(response.status).toBe(422);
      const json = await response.json();
      expect(json.code).toBe("invalid_challenge_intake");
      expect(json.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: testCase.path })]));
    }

    const badReward = await createChallengePost(jsonRequest({ brief, reward: -1, visibility: "public" }, { "x-cmai-user-id": "op" }));
    expect(badReward.status).toBe(422);
    expect(await badReward.json()).toMatchObject({ code: "invalid_schema", details: [expect.objectContaining({ path: "reward" })] });

    const missingBrief = await createChallengePost(jsonRequest({ reward: 1, visibility: "public" }, { "x-cmai-user-id": "op" }));
    expect(missingBrief.status).toBe(422);
    expect(await missingBrief.json()).toMatchObject({ code: "invalid_schema", details: [expect.objectContaining({ path: "brief" })] });
  });

  it("rejects oversized create requests before schema or content processing", async () => {
    const payload = JSON.stringify({ brief, reward: 1, visibility: "public", padding: "x".repeat(70_000) });
    const declared = await createChallengePost(new Request("http://test.local/api/challenges", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": String(payload.length), "x-cmai-user-id": "op" },
      body: payload,
    }));
    expect(declared.status).toBe(413);
    expect(await declared.json()).toMatchObject({ code: "request_too_large", details: { maxBytes: 65_536 } });

    const streamed = await createChallengePost(new Request("http://test.local/api/challenges", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cmai-user-id": "op" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(payload.slice(0, 40_000)));
          controller.enqueue(new TextEncoder().encode(payload.slice(40_000)));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" }));
    expect(streamed.status).toBe(413);
    expect(await streamed.json()).toMatchObject({ code: "request_too_large" });
  });

  it("keeps public challenge read APIs open while hiding private direct IDs", async () => {
    const publicChallenge = createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });
    createContribution({ challengeId: publicChallenge.id, contributorId: "bob", card: cardFor(publicChallenge.id) });
    const privateChallenge = createChallenge({ posterId: "op", visibility: "private", reward: 10, brief: { ...brief, title: "Private" } });

    const promptResponse = await contributionPromptGet(new Request(`http://test.local/api/challenges/${publicChallenge.id}/prompt`), { params: Promise.resolve({ id: publicChallenge.id }) });
    expect(promptResponse.status).toBe(200);
    expect(await promptResponse.json()).toMatchObject({ mode: "critique" });

    const contributionsResponse = await listChallengeContributionsGet(new Request(`http://test.local/api/challenges/${publicChallenge.id}/contributions`), { params: Promise.resolve({ id: publicChallenge.id }) });
    expect(contributionsResponse.status).toBe(200);
    expect((await contributionsResponse.json()).contributions).toHaveLength(1);

    const privatePrompt = await contributionPromptGet(new Request(`http://test.local/api/challenges/${privateChallenge.id}/prompt`), { params: Promise.resolve({ id: privateChallenge.id }) });
    expect(privatePrompt.status).toBe(404);
    expect(await privatePrompt.json()).toMatchObject({ code: "not_found" });

    const privateContributions = await listChallengeContributionsGet(new Request(`http://test.local/api/challenges/${privateChallenge.id}/contributions`), { params: Promise.resolve({ id: privateChallenge.id }) });
    expect(privateContributions.status).toBe(404);
  });

  it("keeps seed challenge prompt previews available when local preview pages seed themselves", async () => {
    const response = await contributionPromptGet(new Request("http://test.local/api/challenges/seed-landing-page-positioning-review/prompt?mode=critique"), { params: Promise.resolve({ id: "seed-landing-page-positioning-review" }) });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.prompt).toContain("CMAI_CONTRIBUTION_CARD_V1");
    expect(json.prompt).toContain("Does this landing page explain token-maxing?");
  });

  it("returns 409 when an authenticated user posts a private-only brief publicly", async () => {
    const response = await createChallengePost(jsonRequest({ brief: { ...brief, privacy_sensitivity: "private_only" }, reward: 1, visibility: "public" }, { "x-cmai-user-id": "op" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "publication_policy_blocked", details: { riskLevel: "blocked", relatedArtifactSearchAllowed: false } });
  });

  it("rejects unsupported sensitive professional-advice categories before public launch", async () => {
    const response = await createChallengePost(jsonRequest({
      brief: { ...brief, category: "medical", problem_statement: "I need medical advice about a diagnosis." },
      reward: 1,
      visibility: "public",
      confirmPrivacyOverride: true,
    }, { "x-cmai-user-id": "op" }));

    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.code).toBe("invalid_challenge_intake");
    expect(json.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: "brief.category" })]));
  });

  it("keeps anonymize-first intake fail-closed without a persisted content-bound approval", async () => {
    const blocked = await createChallengePost(jsonRequest({
      brief: { ...brief, privacy_sensitivity: "anonymize_first" },
      reward: 1,
      visibility: "public",
      confirmPrivacyOverride: true,
    }, { "x-cmai-user-id": "op" }));
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).details.blockers.join(" ")).toContain("redactions_made");

    const stillBlocked = await createChallengePost(jsonRequest({
      brief: { ...brief, privacy_sensitivity: "anonymize_first", redactions_made: ["Removed customer names and private roadmap details."] },
      reward: 1,
      visibility: "public",
      confirmPrivacyOverride: true,
    }, { "x-cmai-user-id": "op" }));
    expect(stillBlocked.status).toBe(409);
    expect(await stillBlocked.json()).toMatchObject({
      code: "publication_policy_blocked",
      details: { ok: false, riskLevel: "needs_review", canOverride: false, relatedArtifactSearchAllowed: false },
    });
  });

  it("rejects hidden or over-cap requested perspectives instead of silently truncating intake", async () => {
    const response = await createChallengePost(jsonRequest({
      brief: { ...brief, challenge_mode_requested: ["judge", "critique", "red_team", "alternate_proposal", "risk_audit"] },
      reward: 1,
      visibility: "public",
    }, { "x-cmai-user-id": "op" }));
    expect(response.status).toBe(422);
    const json = await response.json();
    expect(json.code).toBe("invalid_challenge_intake");
    expect(json.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: "brief.challenge_mode_requested" })]));
  });

  it("returns a stable 422 for unconfirmed modern criteria", async () => {
    const unconfirmed = { ...brief, ...createChallengeSemantics({ intent: "pressure_test", successCriteria: criteria, status: "criteria_unconfirmed", changeReason: "Draft criteria await poster confirmation." }) };
    const response = await createChallengePost(jsonRequest({ brief: unconfirmed, reward: 1, visibility: "public" }, { "x-cmai-user-id": "op" }));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: "invalid_challenge_intent",
      details: [expect.objectContaining({ path: "criteria_status" })],
    });
  });

  it("returns a stable 422 for legacy challenge creation even when criteria text exists", async () => {
    const legacy = {
      schema_version: brief.schema_version,
      title: brief.title,
      category: brief.category,
      challenge_mode_requested: brief.challenge_mode_requested,
      problem_statement: brief.problem_statement,
      original_ai_answer: brief.original_ai_answer,
      context: brief.context,
      constraints: brief.constraints,
      success_criteria: ["A usable-looking but unconfirmed legacy criterion."],
      assumptions_to_test: brief.assumptions_to_test,
      claims_to_check: brief.claims_to_check,
      known_risks: brief.known_risks,
      what_a_useful_response_should_address: brief.what_a_useful_response_should_address,
      privacy_sensitivity: brief.privacy_sensitivity,
      redactions_made: brief.redactions_made,
      abuse_or_safety_flags: brief.abuse_or_safety_flags,
      missing_information: brief.missing_information,
      raw_material_summary: brief.raw_material_summary,
    };
    const response = await createChallengePost(jsonRequest({ brief: legacy, reward: 1, visibility: "public" }, { "x-cmai-user-id": "op" }));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      code: "invalid_challenge_intent",
      details: expect.arrayContaining([
        expect.objectContaining({ path: "challenge_intent" }),
        expect.objectContaining({ path: "criteria_status" }),
      ]),
    });
  });

  it("omits legacy criteria_unconfirmed and privacy-ineligible records from public API reads", async () => {
    const legacy = {
      schema_version: brief.schema_version,
      title: "Legacy unconfirmed challenge",
      category: brief.category,
      challenge_mode_requested: brief.challenge_mode_requested,
      problem_statement: brief.problem_statement,
      original_ai_answer: brief.original_ai_answer,
      context: brief.context,
      constraints: brief.constraints,
      success_criteria: ["A legacy criterion that was never confirmed."],
      assumptions_to_test: brief.assumptions_to_test,
      claims_to_check: brief.claims_to_check,
      known_risks: brief.known_risks,
      what_a_useful_response_should_address: brief.what_a_useful_response_should_address,
      privacy_sensitivity: brief.privacy_sensitivity,
      redactions_made: brief.redactions_made,
      abuse_or_safety_flags: brief.abuse_or_safety_flags,
      missing_information: brief.missing_information,
      raw_material_summary: brief.raw_material_summary,
    };
    createChallenge({ id: "legacy-unconfirmed", posterId: "op", visibility: "public", reward: 1, brief: legacy });
    createChallenge({ id: "private-only-public", posterId: "op", visibility: "public", reward: 1, brief: { ...brief, privacy_sensitivity: "private_only" } });

    const response = await listChallengesGet();
    expect(response.status).toBe(200);
    expect((await response.json()).challenges.some((challenge: { id: string }) => ["legacy-unconfirmed", "private-only-public"].includes(challenge.id))).toBe(false);
    const promptResponse = await contributionPromptGet(new Request("http://test.local/api/challenges/legacy-unconfirmed/prompt"), { params: Promise.resolve({ id: "legacy-unconfirmed" }) });
    expect(promptResponse.status).toBe(404);
    expect(() => createContribution({ challengeId: "legacy-unconfirmed", contributorId: "critic", card: cardFor("legacy-unconfirmed") })).toThrow("not accepting contributions");
    expect(() => watchChallenge({ agentId: "agent-legacy", challengeId: "legacy-unconfirmed" })).toThrow("not accepting agent watches");
    expect(() => synthesizeChallenge("legacy-unconfirmed")).toThrow("not eligible for synthesis");
  });

  it("rate-limits repeated public challenge creation with recovery metadata", async () => {
    process.env.CMAI_ENFORCE_RATE_LIMITS = "1";
    for (let index = 0; index < 6; index += 1) {
      const response = await createChallengePost(jsonRequest({ brief: { ...brief, title: `Rate limited challenge ${index}` }, reward: 1, visibility: "public" }, { "x-cmai-user-id": "op" }));
      expect(response.status).toBe(200);
    }

    const limited = await createChallengePost(jsonRequest({ brief: { ...brief, title: "Rate limited challenge over cap" }, reward: 1, visibility: "public" }, { "x-cmai-user-id": "op" }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({
      code: "rate_limited",
      details: { policy: "challenge_create", limit: 6, remaining: 0, retryAfterMs: expect.any(Number) },
    });
  });

  it("rejects direct private challenge creation until private rooms are wired", async () => {
    const response = await createChallengePost(jsonRequest({ brief, reward: 1, visibility: "private" }, { "x-cmai-user-id": "op" }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "private_challenges_not_ready",
      details: {
        requestedVisibility: "private",
        supportedVisibility: ["public"],
        privateDeepState: "waitlisted",
        requiredBeforeLaunch: expect.arrayContaining(["owner-gated access control", "billing entitlements"]),
      },
    });
  });

  it("requires an account before parsing checkout requests", async () => {
    const response = await billingCheckoutPost(jsonRequest({ kind: "plus" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthenticated" });
  });

  it("returns invalid JSON for malformed authenticated checkout requests", async () => {
    const response = await billingCheckoutPost(new Request("http://test.local/api/billing/checkout", { method: "POST", headers: { "x-cmai-user-id": "op", "content-type": "application/json" }, body: "{" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_json" });
  });

  it("waitlists known paid checkout kinds instead of starting mock or Stripe billing", async () => {
    for (const kind of ["plus", "private-challenge", "deep-challenge", "one-off-review"]) {
      const response = await billingCheckoutPost(jsonRequest({ kind }, { "x-cmai-user-id": "op" }));
      expect(response.status).toBe(409);
      const json = await response.json();
      expect(json).toMatchObject({
        code: "paid_path_waitlisted",
        details: {
          kind,
          launchState: "waitlisted",
          activeCheckoutKinds: [],
          waitlistedKinds: expect.arrayContaining(["plus", "private-challenge", "deep-challenge", "one-off-review"]),
          plannedBenefits: expect.any(Array),
          freeLoopStillLive: true,
        },
      });
      expect(JSON.stringify(json)).not.toContain("checkoutUrl");
      expect(JSON.stringify(json)).not.toContain("mock-");
    }
  });

  it("rejects unknown checkout kinds with supported paid-path metadata", async () => {
    const response = await billingCheckoutPost(jsonRequest({ kind: "enterprise-super-plan" }, { "x-cmai-user-id": "op" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "invalid_checkout_kind",
      details: {
        requestedKind: "enterprise-super-plan",
        knownKinds: expect.arrayContaining(["plus", "one-off-review"]),
        activeCheckoutKinds: [],
      },
    });
  });

  it("rejects missing, empty, or non-string checkout kinds instead of defaulting to a paid intent", async () => {
    for (const body of [{}, { kind: "" }, { kind: "   " }, { kind: null }, { kind: 42 }]) {
      const response = await billingCheckoutPost(jsonRequest(body, { "x-cmai-user-id": "op" }));
      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json).toMatchObject({
        code: "invalid_checkout_kind",
        details: {
          requestedKind: "",
          knownKinds: expect.arrayContaining(["plus", "private-challenge", "deep-challenge", "one-off-review"]),
          activeCheckoutKinds: [],
        },
      });
      expect(JSON.stringify(json)).not.toContain("checkoutUrl");
      expect(JSON.stringify(json)).not.toContain("private challenge waitlist");
    }
  });

  it("returns 400 for authenticated malformed JSON", async () => {
    const request = new Request("http://test.local/api", { method: "POST", headers: { "content-type": "application/json", "x-cmai-user-id": "op" }, body: "{" });
    const response = await createChallengePost(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "invalid_json" });
  });

  it("requires an account before parsing challenge intake material", async () => {
    const response = await parseChallengePost(jsonRequest({ raw: "Problem: public launch review" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthenticated" });
  });

  it("rate-limits challenge parsing with the named user and IP policy", async () => {
    process.env.CMAI_ENFORCE_RATE_LIMITS = "1";
    for (let index = 0; index < 20; index += 1) {
      const response = await parseChallengePost(jsonRequest({ raw: `Problem: parse request ${index}` }, { "x-cmai-user-id": "op", "x-forwarded-for": "203.0.113.10" }));
      expect(response.status).toBe(200);
    }
    const limited = await parseChallengePost(jsonRequest({ raw: "Problem: over parse limit" }, { "x-cmai-user-id": "op", "x-forwarded-for": "203.0.113.10" }));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "rate_limited", details: { policy: "challenge_parse", limit: 20 } });
  });

  it("rejects oversized parse requests before parsing raw text", async () => {
    const response = await parseChallengePost(jsonRequest({ raw: "x".repeat(25_000) }, { "x-cmai-user-id": "op" }));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "request_too_large", details: { maxBytes: 24_576 } });
  });

  it("structures bare challenge-brief JSON instead of falling back to raw text", async () => {
    const response = await parseChallengePost(jsonRequest({ raw: JSON.stringify({ ...brief, title: "Structured brief", constraints: ["Keep the original question intact"] }, null, 2) }, { "x-cmai-user-id": "op" }));
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({ parsed: true, brief: { title: "Structured brief", category: "product", original_ai_answer: "A" } });
    expect(json.brief.constraints).toEqual(["Keep the original question intact"]);
  });

  it("structures raw paste-first problem and Agent-answer text through the parse API", async () => {
    const response = await parseChallengePost(jsonRequest({ raw: `Problem:
I need to know if this landing page offer is clear enough for builders.

My Agent's current answer:
Lead with a generic AI productivity headline and a demo screenshot.

What I want challenged:
- positioning risk
- missing proof

Privacy note:
This is public copy; no private customer data included.` }, { "x-cmai-user-id": "op" }));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.parsed).toBe(false);
    expect(json.brief).toMatchObject({
      title: "I need to know if this",
      category: "copy",
      original_ai_answer: expect.stringContaining("generic AI productivity headline"),
      privacy_sensitivity: "public_ok",
    });
    expect(json.policy).toMatchObject({ riskLevel: "clear", relatedArtifactSearchAllowed: true });
    expect(json.brief.what_a_useful_response_should_address).toEqual(["positioning risk", "missing proof"]);
  });

  it("returns blocked parse policy for secrets before publishing", async () => {
    const response = await parseChallengePost(jsonRequest({ raw: `Problem:
Please review this public launch plan.

My Agent's current answer:
Ship it.

Context:
Use API_KEY=abc123 and customer list jane@example.com.` }, { "x-cmai-user-id": "op" }));

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.policy).toMatchObject({ riskLevel: "blocked", relatedArtifactSearchAllowed: false });
    expect(json.policy.safetyFlags).toEqual(expect.arrayContaining(["secret_exposure", "privacy_risk"]));
  });

  it("allows only the challenge poster to rate a contribution", async () => {
    const challenge = createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });
    const contribution = createContribution({ challengeId: challenge.id, contributorId: "bob", card: cardFor(challenge.id) });
    const denied = await rateContributionPost(jsonRequest({ usefulness: 9 }, { "x-cmai-user-id": "bob" }), { params: Promise.resolve({ id: contribution.id }) });
    expect(denied.status).toBe(403);
    const allowed = await rateContributionPost(jsonRequest({ usefulness: 9 }, { "x-cmai-user-id": "op" }), { params: Promise.resolve({ id: contribution.id }) });
    expect(allowed.status).toBe(200);
  });

  it("rate-limits manual contribution spam into one challenge", async () => {
    process.env.CMAI_ENFORCE_RATE_LIMITS = "1";
    const challenge = createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });
    for (let index = 0; index < 8; index += 1) {
      const response = await createContributionPost(jsonRequest({ card: cardFor(challenge.id) }, { "x-cmai-user-id": "alice", "x-cmai-user-name": "Alice" }), { params: Promise.resolve({ id: challenge.id }) });
      expect(response.status).toBe(200);
    }

    const limited = await createContributionPost(jsonRequest({ card: cardFor(challenge.id) }, { "x-cmai-user-id": "alice", "x-cmai-user-name": "Alice" }), { params: Promise.resolve({ id: challenge.id }) });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "rate_limited", details: { policy: "manual_contribution_per_challenge", limit: 8 } });
  });

  it("rate-limits repeated poster rating mutations without exposing raw keys", async () => {
    process.env.CMAI_ENFORCE_RATE_LIMITS = "1";
    const challenge = createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });
    const contribution = createContribution({ challengeId: challenge.id, contributorId: "bob", card: cardFor(challenge.id) });

    for (let index = 0; index < 60; index += 1) {
      const response = await rateContributionPost(jsonRequest({ usefulness: index % 11 }, { "x-cmai-user-id": "op" }), { params: Promise.resolve({ id: contribution.id }) });
      expect(response.status).toBe(200);
    }

    const limited = await rateContributionPost(jsonRequest({ usefulness: 7 }, { "x-cmai-user-id": "op" }), { params: Promise.resolve({ id: contribution.id }) });
    expect(limited.status).toBe(429);
    const json = await limited.json();
    expect(json).toMatchObject({ code: "rate_limited", details: { policy: "contribution_rating", limit: 60, retryAfterMs: expect.any(Number) } });
    expect(JSON.stringify(json.details)).not.toContain("op");
  });

  it("rate-limits repeated community votes with the named policy, not the generic auth policy", async () => {
    process.env.CMAI_ENFORCE_RATE_LIMITS = "1";
    const challenge = createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });
    const contribution = createContribution({ challengeId: challenge.id, contributorId: "bob", card: cardFor(challenge.id) });

    for (let index = 0; index < 120; index += 1) {
      const response = await communityVotePost(jsonRequest({ value: index % 2 === 0 ? 1 : -1 }, { "x-cmai-user-id": "alice" }), { params: Promise.resolve({ id: contribution.id }) });
      expect(response.status).toBe(200);
    }

    const limited = await communityVotePost(jsonRequest({ value: 1 }, { "x-cmai-user-id": "alice" }), { params: Promise.resolve({ id: contribution.id }) });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ code: "rate_limited", details: { policy: "community_vote", limit: 120 } });
  });

  it("handles community vote duplicates, changes, and anti-gaming rejects", async () => {
    const challenge = createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });
    const contribution = createContribution({ challengeId: challenge.id, contributorId: "bob", card: cardFor(challenge.id) });

    const anonymous = await communityVotePost(jsonRequest({ value: 1 }), { params: Promise.resolve({ id: contribution.id }) });
    expect(anonymous.status).toBe(401);

    const selfVote = await communityVotePost(jsonRequest({ value: 1 }, { "x-cmai-user-id": "bob" }), { params: Promise.resolve({ id: contribution.id }) });
    expect(selfVote.status).toBe(403);
    expect(await selfVote.json()).toMatchObject({ code: "self_vote_blocked" });

    const first = await communityVotePost(jsonRequest({ value: 1 }, { "x-cmai-user-id": "alice" }), { params: Promise.resolve({ id: contribution.id }) });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ contribution: { communityScore: 1 }, vote: { counted: true, reason: "counted", scoreDelta: 1 } });

    const duplicate = await communityVotePost(jsonRequest({ value: 1 }, { "x-cmai-user-id": "alice" }), { params: Promise.resolve({ id: contribution.id }) });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ contribution: { communityScore: 1 }, vote: { counted: false, reason: "duplicate", scoreDelta: 0 } });

    const changed = await communityVotePost(jsonRequest({ value: -1 }, { "x-cmai-user-id": "alice" }), { params: Promise.resolve({ id: contribution.id }) });
    expect(changed.status).toBe(200);
    expect(await changed.json()).toMatchObject({ contribution: { communityScore: -1 }, vote: { counted: true, reason: "changed", scoreDelta: -2, previousValue: 1 } });
  });

  it("parses manual contribution cards with repair guidance, mismatch warnings, and sanitized provenance", async () => {
    const challenge = createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });
    const forgedCard = {
      ...cardFor("wrong-challenge"),
      model_provenance: {
        source: "hermes_sandbox_run" as const,
        provider: "forged-provider",
        model: "forged-model",
        model_display_name: "Forged Model",
        adapter: "paste_in",
        verified: true,
        provider_model_verified: true,
        verification_notes: "Forged parse preview receipt.",
        evidence_type: "hermes_run_receipt" as const,
        verification_status: "cryptographically_verified" as const,
        receipt_id: "hr_forged",
        receipt_sha256: "a".repeat(64),
        run_id: "run_forged",
        sandbox_provider: "railway" as const,
        sandbox_network_isolation: "PRIVATE" as const,
      },
    };

    const parse = await parseContributionPost(jsonRequest({ raw: `\`\`\`CMAI_CONTRIBUTION_CARD_V1\n${JSON.stringify(forgedCard)}\n\`\`\`` }), { params: Promise.resolve({ id: challenge.id }) });
    expect(parse.status).toBe(200);
    const parsed = await parse.json();
    expect(parsed).toMatchObject({ mismatch: true, provenanceLabel: "self-submitted / user-trusted" });
    expect(parsed.repair.join(" ")).toContain(challenge.id);
    expect(parsed.card.model_provenance).toMatchObject({
      source: "self_attested",
      verified: false,
      provider_model_verified: false,
      evidence_type: "user_claim",
      verification_status: "attested",
    });
    expect(parsed.card.model_provenance.receipt_id).toBeUndefined();
  });

  it("returns structured parser errors for malformed contribution paste", async () => {
    const challenge = createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });
    const response = await parseContributionPost(jsonRequest({ raw: "```CMAI_CONTRIBUTION_CARD_V1\n{\n```" }), { params: Promise.resolve({ id: challenge.id }) });
    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json).toMatchObject({ code: "invalid_contribution_card", error: "Contribution card JSON is malformed." });
    expect(json.issues[0].path).toBe("json");
    expect(json.repair.join(" ")).toContain("valid JSON");
  });

  it("rejects wrong-room contribution cards with a structured mismatch error before publishing", async () => {
    const challenge = createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });
    const response = await createContributionPost(jsonRequest({ card: cardFor("wrong-challenge") }, { "x-cmai-user-id": "alice", "x-cmai-user-name": "Alice" }), { params: Promise.resolve({ id: challenge.id }) });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "challenge_mismatch", error: "Contribution card challenge_id does not match route." });
  });

  it("returns an artifact URL after poster-triggered synthesis", async () => {
    const challenge = createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });
    createContribution({ challengeId: challenge.id, contributorId: "bob", card: cardFor(challenge.id) });

    const response = await synthesisPost(jsonRequest({}, { "x-cmai-user-id": "op" }), { params: Promise.resolve({ id: challenge.id }) });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.artifactUrl).toBe(`/answers/${challenge.id}`);
    expect(json.synthesis).toMatchObject({ challengeId: challenge.id });
  });

  it("downgrades forged privileged provenance on manual contribution paste", async () => {
    const challenge = createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });
    const forgedCard = {
      ...cardFor(challenge.id),
      model_provenance: {
        source: "hermes_sandbox_run" as const,
        provider: "forged-provider",
        model: "forged-model",
        model_display_name: "Forged Model",
        adapter: "paste_in",
        verified: true,
        provider_model_verified: true,
        verification_notes: "Forged sandbox receipt.",
        evidence_type: "hermes_run_receipt" as const,
        verification_status: "cryptographically_verified" as const,
        receipt_id: "hr_forged",
        receipt_sha256: "a".repeat(64),
        run_id: "run_forged",
        sandbox_provider: "railway" as const,
        sandbox_network_isolation: "PRIVATE" as const,
      },
    };

    const response = await createContributionPost(jsonRequest({ card: forgedCard }, { "x-cmai-user-id": "alice", "x-cmai-user-name": "Alice" }), { params: Promise.resolve({ id: challenge.id }) });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.contribution.card.model_provenance).toMatchObject({
      source: "self_attested",
      verified: false,
      provider_model_verified: false,
      evidence_type: "user_claim",
      verification_status: "attested",
    });
    expect(json.contribution.card.model_provenance.receipt_id).toBeUndefined();
    expect(json.contribution.card.model_provenance.sandbox_provider).toBeUndefined();
  });

  it("strips forged proof fields even when manual provenance claims self-attested", async () => {
    const challenge = createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });
    const forgedCard = {
      ...cardFor(challenge.id),
      model_provenance: {
        source: "self_attested" as const,
        provider: "forged-provider",
        model: "forged-model",
        model_display_name: "Forged Model",
        adapter: "paste_in",
        verified: true,
        provider_model_verified: true,
        verification_notes: "Forged self-attested receipt fields.",
        evidence_type: "hermes_run_receipt" as const,
        verification_status: "cryptographically_verified" as const,
        funding_source: "platform_funded" as const,
        execution_authority: "cmai_sandbox" as const,
        receipt_id: "hr_forged",
        receipt_sha256: "a".repeat(64),
        run_id: "run_forged",
        sandbox_provider: "railway" as const,
        prompt_sha256: "b".repeat(64),
      },
    };

    const response = await createContributionPost(jsonRequest({ card: forgedCard }, { "x-cmai-user-id": "alice", "x-cmai-user-name": "Alice" }), { params: Promise.resolve({ id: challenge.id }) });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.contribution.card.model_provenance).toMatchObject({
      source: "self_attested",
      verified: false,
      provider_model_verified: false,
      evidence_type: "user_claim",
      verification_status: "attested",
      funding_source: "unknown",
    });
    expect(json.contribution.card.model_provenance.execution_authority).toBeUndefined();
    expect(json.contribution.card.model_provenance.receipt_id).toBeUndefined();
    expect(json.contribution.card.model_provenance.sandbox_provider).toBeUndefined();
    expect(json.contribution.card.model_provenance.prompt_sha256).toBeUndefined();
  });

  it("rejects manual contributions to private challenges", async () => {
    const privateChallenge = createChallenge({ posterId: "op", visibility: "private", reward: 10, brief: { ...brief, title: "Private" } });

    const response = await createContributionPost(jsonRequest({ card: cardFor(privateChallenge.id) }, { "x-cmai-user-id": "alice" }), { params: Promise.resolve({ id: privateChallenge.id }) });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "not_found" });
  });

  it("rejects direct actions against suppressed challenges and contributions", async () => {
    const challenge = createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });
    const contribution = createContribution({ challengeId: challenge.id, contributorId: "bob", card: cardFor(challenge.id) });
    suppressContribution(contribution.id, "unsafe_content", "mod");

    const rating = await rateContributionPost(jsonRequest({ usefulness: 8, safety: 8 }, { "x-cmai-user-id": "op" }), { params: Promise.resolve({ id: contribution.id }) });
    expect(rating.status).toBe(404);
    expect(await rating.json()).toMatchObject({ code: "not_found" });

    const vote = await communityVotePost(jsonRequest({ value: 1 }, { "x-cmai-user-id": "alice" }), { params: Promise.resolve({ id: contribution.id }) });
    expect(vote.status).toBe(404);
    expect(await vote.json()).toMatchObject({ code: "not_found" });

    const suppressedChallenge = createChallenge({ posterId: "op", visibility: "public", reward: 10, brief: { ...brief, title: "Suppressed synthesis" } });
    suppressChallenge(suppressedChallenge.id, "unsafe_content", "mod");
    const synthesis = await synthesisPost(jsonRequest({}, { "x-cmai-user-id": "op" }), { params: Promise.resolve({ id: suppressedChallenge.id }) });
    expect(synthesis.status).toBe(404);
  });

  it("records authenticated public reports with structured reasons and redacted notes", async () => {
    const challenge = createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });

    const anonymous = await moderationReportPost(jsonRequest({ targetType: "challenge", targetId: challenge.id, reason: "unsafe_content" }));
    expect(anonymous.status).toBe(401);

    const reported = await moderationReportPost(jsonRequest({ targetType: "challenge", targetId: challenge.id, reason: "secrets_or_private_info", note: "Contains password=hunter2" }, { "x-cmai-user-id": "alice" }));
    expect(reported.status).toBe(201);
    const json = await reported.json();
    expect(json.report).toMatchObject({ targetType: "challenge", targetId: challenge.id, resolvedTargetType: "challenge", resolvedTargetId: challenge.id, actorId: "alice", action: "report", reason: "secrets_or_private_info" });
    expect(json.report.note).toContain("[redacted]");
    expect(json.report.note).not.toContain("hunter2");
  });

  it("allows only moderators to suppress and restore challenges through the moderation route", async () => {
    const challenge = createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });

    const anonymous = await moderationActionPost(jsonRequest({ action: "suppress_challenge", targetId: challenge.id, reason: "smoke_or_test_artifact" }));
    expect(anonymous.status).toBe(401);

    const denied = await moderationActionPost(jsonRequest({ action: "suppress_challenge", targetId: challenge.id, reason: "smoke_or_test_artifact" }, { "x-cmai-user-id": "alice" }));
    expect(denied.status).toBe(403);
    expect(getChallenge(challenge.id)?.status).toBe("open");

    const allowed = await moderationActionPost(jsonRequest({ action: "suppress_challenge", targetId: challenge.id, reason: "smoke_or_test_artifact", note: "smoke cleanup" }, { "x-cmai-user-id": "mod", "x-cmai-role": "moderator" }));
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ action: { action: "suppress", targetType: "challenge", targetId: challenge.id, reason: "smoke_or_test_artifact", actorId: "mod", note: "smoke cleanup" }, challenge: { status: "suppressed" } });
    expect(getChallenge(challenge.id)?.status).toBe("suppressed");

    const restored = await moderationActionPost(jsonRequest({ action: "restore", targetType: "challenge", targetId: challenge.id, reason: "other" }, { "x-cmai-user-id": "mod", "x-cmai-role": "moderator" }));
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ action: { action: "restore", targetType: "challenge", targetId: challenge.id }, challenge: { status: "open" } });
  });

  it("moderates contributions through generic actions and keeps the smoke cleanup legacy action compatible", async () => {
    const challenge = createChallenge({ posterId: "op", visibility: "public", reward: 10, brief });
    const contribution = createContribution({ challengeId: challenge.id, contributorId: "bob", card: cardFor(challenge.id) });

    const suppressed = await moderationActionPost(jsonRequest({ action: "suppress", targetType: "contribution", targetId: contribution.id, reason: "unsafe_content" }, { "x-cmai-user-id": "mod", "x-cmai-role": "moderator" }));
    expect(suppressed.status).toBe(200);
    expect(await suppressed.json()).toMatchObject({ action: { action: "suppress", targetType: "contribution", targetId: contribution.id, reason: "unsafe_content" }, contribution: { status: "suppressed" } });
    expect(listContributions(challenge.id)).toHaveLength(0);

    const restored = await moderationActionPost(jsonRequest({ action: "restore_contribution", targetId: contribution.id, reason: "other" }, { "x-cmai-user-id": "mod", "x-cmai-role": "moderator" }));
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({ action: { action: "restore", targetType: "contribution", targetId: contribution.id }, contribution: { status: "posted" } });
    expect(listContributions(challenge.id)).toHaveLength(1);
  });

  it("hides route-suppressed challenges from answer artifact APIs and search", async () => {
    const challenge = createChallenge({ posterId: "op", visibility: "public", reward: 10, brief: { ...brief, title: "Route suppressed smoke artifact", raw_material_summary: "route-suppressed-smoke" } });
    createContribution({ challengeId: challenge.id, contributorId: "bob", card: cardFor(challenge.id) });
    synthesizeChallenge(challenge.id);

    const before = await artifactGet(new Request(`http://test.local/api/answers/${challenge.id}/artifact`), { params: Promise.resolve({ id: challenge.id }) });
    expect(before.status).toBe(200);

    const suppress = await moderationActionPost(jsonRequest({ action: "suppress_challenge", targetId: challenge.id, reason: "smoke_or_test_artifact", note: "smoke cleanup" }, { "x-cmai-user-id": "mod", "x-cmai-role": "moderator" }));
    expect(suppress.status).toBe(200);

    const artifact = await artifactGet(new Request(`http://test.local/api/answers/${challenge.id}/artifact`), { params: Promise.resolve({ id: challenge.id }) });
    expect(artifact.status).toBe(404);
    const search = await answerSearchGet(new Request("http://test.local/api/answers?q=route-suppressed-smoke&limit=5"));
    expect(search.status).toBe(200);
    expect((await search.json()).artifacts.map((item: { id: string }) => item.id)).not.toContain(challenge.id);
    expect(listModerationEvents(1)[0]).toMatchObject({ targetType: "challenge", targetId: challenge.id, reason: "smoke_or_test_artifact" });
  });
});
