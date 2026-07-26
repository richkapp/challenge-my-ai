import { describe, expect, it } from "vitest";
import { buildAnswerArchive } from "@/lib/archive/search";
import type { Challenge, Contribution, SynthesisBrief } from "@/lib/types";
import { createChallengeSemantics } from "@/lib/challenges/intent";

const baseChallenge: Challenge = {
  id: "archive-bug-thread",
  createdAt: "2026-06-23T10:00:00.000Z",
  updatedAt: "2026-06-23T10:30:00.000Z",
  posterId: "poster",
  status: "synthesized",
  title: "Avoid a Next.js deploy bug",
  category: "engineering",
  visibility: "public",
  reward: 40,
  requestedModes: ["critique", "risk_audit"],
  safetyFlags: [],
  contributionCount: 1,
  activeCriteriaVersion: 1,
  publicEligibility: { eligible: true, reasons: [], criteriaVersion: 1, assessedAt: "2026-06-23T10:30:00.000Z" },
  brief: {
    schema_version: "1.0",
    ...createChallengeSemantics({ intent: "solve", successCriteria: ["Find the smallest safe fix"], status: "confirmed", changeReason: "Confirmed answer archive fixture criteria." }),
    title: "Avoid a Next.js deploy bug",
    category: "engineering",
    challenge_mode_requested: ["critique", "risk_audit"],
    problem_statement: "The build keeps failing after a routing change.",
    original_ai_answer: "Rewrite the whole app router.",
    context: "A Vercel deployment started failing after middleware changed.",
    constraints: ["Do not rewrite working routes"],
    success_criteria: ["Find the smallest safe fix"],
    assumptions_to_test: ["Routing is the root cause"],
    claims_to_check: ["Middleware can refresh cookies safely"],
    known_risks: ["Overbuilding"],
    what_a_useful_response_should_address: ["deployment failure", "routing"],
    privacy_sensitivity: "public_ok",
    redactions_made: [],
    abuse_or_safety_flags: [],
    missing_information: [],
    raw_material_summary: "Vercel routing obstacle",
  },
};

const contribution: Contribution = {
  id: "contribution-1",
  challengeId: baseChallenge.id,
  contributorId: "agent-debugger",
  contributorKind: "agent",
  contributorLabel: "Debugger Agent",
  createdAt: "2026-06-23T10:35:00.000Z",
  status: "posted",
  externallyGenerated: true,
  communityScore: 2,
  opRating: { id: "rating-1", contributionId: "contribution-1", raterId: "poster", usefulness: 8, novelty: 7, correctness: 8, safety: 8, comment: "Useful", createdAt: "2026-06-23T10:40:00.000Z" },
  card: {
    schema_version: "1.0",
    challenge_id: baseChallenge.id,
    contribution_mode: "risk_audit",
    contributor_ai_label: "Debugger Agent",
    skills_or_context_used: ["Next.js"],
    verdict: "The rewrite is unnecessary.",
    original_answer_grade: { score_0_to_10: 3, grade_label: "weak", why: "It skips the smaller fix." },
    answer_to_challenge_poster: "Inspect middleware cookies before changing routes.",
    reasoning_summary: "The bug sounds like proxy/session handling, not an app-router failure.",
    strongest_objections: ["A rewrite hides the real regression."],
    missing_assumptions_or_context: ["Exact redirect status"],
    alternative_recommendation: "Patch the proxy cookie refresh and re-run the deployment.",
    risks_and_failure_modes: ["Session loops", "Stale cookies"],
    claims_to_verify: ["Proxy returns a valid redirect"],
    confidence: { level: "medium", why: "Known deployment pattern." },
    what_would_change_my_mind: ["A framework bug reproduction"],
    suggested_follow_up_questions: ["Which route redirects?"],
    safety_or_scope_notes: [],
    abuse_or_prompt_injection_flags: [],
    raw_output_summary: "Audit the proxy before rewriting routes.",
  },
};

const synthesis: SynthesisBrief = {
  id: "synthesis-1",
  challengeId: baseChallenge.id,
  createdAt: "2026-06-23T10:45:00.000Z",
  improvedAnswer: "Fix proxy cookie handling and verify redirects before rewriting routes.",
  whatChanged: ["The current answer moved from rewriting routes to patching proxy cookie handling."],
  strongestObjections: ["The proposed rewrite is too broad for a session bug."],
  risks: ["Session loops", "Lost auth cookies"],
  confidence: "medium",
  unresolvedDisagreements: ["Whether middleware or app-router code owns the bug."],
  nextTests: ["Smoke the deployment redirect", "Check cookie refresh headers"],
  jobId: "job-1",
};

describe("answer archive search", () => {
  it("returns a synthesized answer when the query matches reusable risks", () => {
    const results = buildAnswerArchive({
      challenges: [baseChallenge],
      contributionsByChallengeId: { [baseChallenge.id]: [contribution] },
      synthesesByChallengeId: { [baseChallenge.id]: synthesis },
      query: "session loops",
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: baseChallenge.id,
      currentAnswer: synthesis.improvedAnswer,
      hasSynthesis: true,
      url: `/challenges/${baseChallenge.id}`,
    });
    expect(results[0].risks).toContain("Session loops");
    expect(results[0].matchReasons).toContain("risk");
  });

  it("returns hot public answers for an empty query", () => {
    const plainChallenge = { ...baseChallenge, id: "plain-thread", title: "Plain thread", reward: 0, contributionCount: 0, updatedAt: "2026-06-23T09:00:00.000Z" };
    const results = buildAnswerArchive({
      challenges: [plainChallenge, baseChallenge],
      contributionsByChallengeId: { [baseChallenge.id]: [contribution] },
      synthesesByChallengeId: { [baseChallenge.id]: synthesis },
    });

    expect(results.map((item) => item.id)).toEqual([baseChallenge.id, plainChallenge.id]);
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("excludes private and suppressed challenges", () => {
    const privateChallenge: Challenge = { ...baseChallenge, id: "private-thread", visibility: "private" };
    const suppressedChallenge: Challenge = { ...baseChallenge, id: "suppressed-thread", status: "suppressed" };

    const results = buildAnswerArchive({ challenges: [privateChallenge, suppressedChallenge, baseChallenge], query: "routing" });

    expect(results.map((item) => item.id)).toEqual([baseChallenge.id]);
  });
});
