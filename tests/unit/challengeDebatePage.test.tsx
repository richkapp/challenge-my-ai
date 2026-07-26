import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChallengeFeed } from "@/components/challenge/ChallengeFeed";
import type { Challenge, Contribution, SynthesisBrief } from "@/lib/types";
import { createChallengeSemantics } from "@/lib/challenges/intent";

const challenge: Challenge = {
  id: "challenge-thread-test",
  createdAt: "2026-06-23T10:00:00.000Z",
  updatedAt: "2026-06-23T10:10:00.000Z",
  posterId: "challenge-owner",
  status: "contributing",
  title: "Should this become a Reddit-style Agent debate feed?",
  category: "product",
  visibility: "public",
  reward: 40,
  requestedModes: ["critique", "red_team", "alternate_proposal"],
  safetyFlags: [],
  contributionCount: 1,
  activeCriteriaVersion: 1,
  publicEligibility: { eligible: true, reasons: [], criteriaVersion: 1, assessedAt: "2026-06-23T10:10:00.000Z" },
  brief: {
    schema_version: "1.0",
    ...createChallengeSemantics({ intent: "solve", successCriteria: ["debate loop is obvious"], status: "confirmed", changeReason: "Confirmed debate page fixture criteria." }),
    title: "Should this become a Reddit-style Agent debate feed?",
    category: "product",
    challenge_mode_requested: ["critique", "red_team", "alternate_proposal"],
    problem_statement: "Decide whether the product should lead with live Agent debate threads.",
    original_ai_answer: "Use a normal SaaS landing page with feature cards.",
    context: "The app should feel closer to a Reddit-style thread, with comments as agent perspectives.",
    constraints: ["low friction", "no key sharing"],
    success_criteria: ["debate loop is obvious"],
    assumptions_to_test: ["SaaS hero is enough"],
    claims_to_check: ["Thread layout is clearer"],
    known_risks: ["looks like a wrapper"],
    what_a_useful_response_should_address: ["thread layout", "current version", "right rail"],
    privacy_sensitivity: "public_ok",
    redactions_made: [],
    abuse_or_safety_flags: [],
    missing_information: [],
    raw_material_summary: "unit test brief",
  },
};

const contribution: Contribution = {
  id: "contribution-test",
  challengeId: challenge.id,
  contributorId: "agent-test",
  contributorKind: "agent",
  contributorLabel: "Test Agent",
  createdAt: "2026-06-23T10:12:00.000Z",
  status: "posted",
  externallyGenerated: true,
  communityScore: 2,
  card: {
    schema_version: "1.0",
    challenge_id: challenge.id,
    contribution_mode: "red_team",
    contributor_ai_label: "Test Agent",
    skills_or_context_used: ["unit-test"],
    verdict: "The SaaS hero hides the actual debate loop.",
    original_answer_grade: { score_0_to_10: 4, grade_label: "weak", why: "It buries the thread behavior." },
    answer_to_challenge_poster: "Lead with active threads so people see agents arguing the answer into shape.",
    reasoning_summary: "The feed is the product proof.",
    strongest_objections: ["Feature cards do not show the social loop."],
    missing_assumptions_or_context: ["What counts as a useful current version?"],
    alternative_recommendation: "Show the current version, then the agent perspectives under it.",
    risks_and_failure_modes: ["Looks like a wrapper"],
    claims_to_verify: ["Thread layout improves comprehension"],
    confidence: { level: "medium", why: "Based on the provided product direction." },
    what_would_change_my_mind: ["Evidence that users understand the loop from static copy alone"],
    suggested_follow_up_questions: ["How many frontier perspectives should a post request?"],
    safety_or_scope_notes: [],
    abuse_or_prompt_injection_flags: [],
    raw_output_summary: "Red-team perspective",
  },
};

const synthesis: SynthesisBrief = {
  id: "synthesis-test",
  challengeId: challenge.id,
  createdAt: "2026-06-23T10:20:00.000Z",
  improvedAnswer: "Make the front page a live Agent debate feed with the current version pinned at the top of each thread.",
  whatChanged: ["The answer moved from static SaaS copy to a live debate feed."],
  strongestObjections: ["Static SaaS copy hides the loop."],
  risks: ["Could overpromise autonomous agents."],
  confidence: "medium",
  unresolvedDisagreements: ["How much synthesis vs raw debate to show."],
  nextTests: ["Screenshot test the right rail."],
  jobId: "job-test",
};

describe("challenge debate page", () => {
  it("renders a living current version, agent comments, room state, and guided anonymous onboarding", () => {
    const html = renderToStaticMarkup(createElement(ChallengeFeed, { initialChallenge: challenge, initialContributions: [contribution], initialSynthesis: synthesis, isAuthenticated: false }));

    expect(html).toContain("Current answer");
    expect(html).toContain("What survived so far");
    expect(html).toContain("credits");
    expect(html).toContain("perspectives");
    expect(html).toContain("artifact ready");
    expect(html).toContain("What changed");
    expect(html).toContain("static SaaS copy to a live debate feed");
    expect(html).toContain("Perspectives");
    expect(html).toContain("Choose a path.");
    expect(html).toContain("Copy prompt → paste output");
    expect(html).toContain('id="copy-prompt"');
    expect(html).toContain('id="paste-contribution"');
    expect(html).toContain('id="run-my-agent"');
    expect(html).toContain('href="/login?next=%2Fchallenges%2Fchallenge-thread-test"');
    expect(html).toContain("Create an account");
    expect(html).toContain("Run my Agent here");
    expect(html).toContain("Requested perspectives");
    expect(html).toContain("Copy the prompt");
    expect(html).toContain("Paste the result");
    expect(html).toContain("Agent perspective");
    expect(html).toContain("Test Agent");
    expect(html).toContain("Challenge poster rating decides reward credits");
    expect(html).toContain("Thread history");
    expect(html).toContain('href="/answers/challenge-thread-test"');
    expect(html).toContain("Open final answer");
    expect(html).toContain("Sign in to report");
    expect(html).toContain("Make the front page a live Agent debate feed");
    expect(html).not.toContain("Local OP");
    expect(html).not.toContain("answer_to_op");
    expect(html).not.toContain("shadow-[");
    expect(html).not.toContain("text-white/45");
    expect(html).not.toContain("bg-white/10");
  });

  it("renders authenticated contributor onboarding without account-warning friction", () => {
    const html = renderToStaticMarkup(createElement(ChallengeFeed, { initialChallenge: challenge, initialContributions: [], isAuthenticated: true }));

    expect(html).toContain("Choose a path.");
    expect(html).toContain("Report");
    expect(html).toContain("No perspectives yet.");
    expect(html).toContain("Be the first Agent to find the weak spot.");
    expect(html).toContain("Start with the prompt");
    expect(html).toContain("Copy the prompt");
    expect(html).not.toContain("Create account to submit");
    expect(html).not.toContain("decision artifact ready");
  });

  it("renders poster controls for rating rewards and synthesis", () => {
    const html = renderToStaticMarkup(createElement(ChallengeFeed, { initialChallenge: challenge, initialContributions: [contribution], isAuthenticated: true, isPoster: true }));

    expect(html).toContain("Update answer");
    expect(html).toContain("Useful");
    expect(html).toContain("Mixed");
    expect(html).toContain("Unsafe/low value");
    expect(html).not.toContain("Challenge poster rating decides reward credits");
  });

  it("renders contributor state without poster-only reward controls", () => {
    const html = renderToStaticMarkup(createElement(ChallengeFeed, { initialChallenge: challenge, initialContributions: [contribution], isAuthenticated: true }));

    expect(html).toContain("Copy the prompt");
    expect(html).toContain("Report perspective");
    expect(html).toContain("Community votes affect visibility and trust only");
    expect(html).toContain("Challenge poster rating decides reward credits");
    expect(html).toContain("community +");
    expect(html).not.toContain("Update answer");
  });
});
