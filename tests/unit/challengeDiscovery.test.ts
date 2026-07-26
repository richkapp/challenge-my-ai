import { describe, expect, it } from "vitest";
import {
  buildChallengeDiscoveryMeta,
  challengeAnswerStateFor,
  challengeLifecycleLabelFor,
  discoverChallenges,
  formatChallengeCategory,
  parseChallengeSort,
} from "@/lib/discovery/challengeDiscovery";
import type { Challenge, ChallengeBrief } from "@/lib/types";

const baseBrief: ChallengeBrief = {
  schema_version: "1.0",
  title: "Base challenge",
  category: "product",
  challenge_mode_requested: ["critique"],
  problem_statement: "Pressure-test this Agent answer.",
  original_ai_answer: "Ship the current answer.",
  context: "Synthetic unit-test context.",
  constraints: [],
  success_criteria: ["Find useful objections"],
  assumptions_to_test: ["The current answer is safe"],
  claims_to_check: ["The plan will work"],
  known_risks: ["False confidence"],
  what_a_useful_response_should_address: ["Risks"],
  privacy_sensitivity: "public_ok",
  redactions_made: [],
  abuse_or_safety_flags: [],
  missing_information: [],
  raw_material_summary: "Discovery unit-test challenge",
};

function challenge(overrides: Partial<Challenge> & { id: string; title: string }): Challenge {
  return {
    id: overrides.id,
    createdAt: overrides.createdAt || "2026-07-01T10:00:00.000Z",
    updatedAt: overrides.updatedAt || overrides.createdAt || "2026-07-01T10:00:00.000Z",
    posterId: "poster",
    status: overrides.status || "open",
    title: overrides.title,
    category: overrides.category || "product",
    visibility: "public",
    reward: overrides.reward ?? 20,
    requestedModes: overrides.requestedModes || ["critique"],
    brief: { ...baseBrief, title: overrides.title, category: overrides.category || "product", challenge_mode_requested: overrides.requestedModes || ["critique"], problem_statement: overrides.brief?.problem_statement || baseBrief.problem_statement },
    safetyFlags: [],
    contributionCount: overrides.contributionCount ?? 0,
  };
}

describe("challenge discovery", () => {
  const now = new Date("2026-07-04T12:00:00.000Z");

  it("prioritizes unanswered, reward, freshness, category, and search relevance", () => {
    const challenges = [
      challenge({ id: "old-copy", title: "Landing page positioning", category: "copy", reward: 25, requestedModes: ["critique", "alternate_proposal"], createdAt: "2026-07-01T12:00:00.000Z" }),
      challenge({ id: "receipt", title: "Receipt proof plan", category: "code", reward: 45, requestedModes: ["risk_audit"], status: "contributing", contributionCount: 2, updatedAt: "2026-07-04T10:00:00.000Z", brief: { ...baseBrief, problem_statement: "Receipt proof boundaries and forged provenance." } }),
      challenge({ id: "plus", title: "Plus launch decision", category: "business_decision", reward: 80, requestedModes: ["risk_audit"], status: "synthesized", contributionCount: 1, updatedAt: "2026-07-03T10:00:00.000Z" }),
    ];

    expect(discoverChallenges(challenges, { answerState: "needs_perspectives" }, now).map((item) => item.challenge.id)).toEqual(["old-copy"]);
    expect(discoverChallenges(challenges, { category: "business decision" }, now).map((item) => item.challenge.id)).toEqual(["plus"]);
    expect(discoverChallenges(challenges, { query: "receipt provenance" }, now).map((item) => item.challenge.id)).toEqual(["receipt"]);
    expect(discoverChallenges(challenges, { sort: "reward" }, now)[0].challenge.id).toBe("plus");
  });

  it("labels human-facing states without exposing enum underscores", () => {
    expect(formatChallengeCategory("business_decision")).toBe("business decision");
    expect(parseChallengeSort("hot")).toBe("recommended");
    expect(challengeAnswerStateFor(challenge({ id: "new", title: "New" }))).toBe("needs_perspectives");
    expect(challengeAnswerStateFor(challenge({ id: "busy", title: "Busy", status: "contributing", contributionCount: 1 }))).toBe("has_perspectives");
    expect(challengeAnswerStateFor(challenge({ id: "done", title: "Done", status: "synthesized", contributionCount: 2 }))).toBe("synthesized");
  });

  it("distinguishes open, active, ready, artifact, archived, and suppressed lifecycle labels", () => {
    expect(challengeLifecycleLabelFor(challenge({ id: "open", title: "Open", status: "open", contributionCount: 0 }))).toBe("first perspective needed");
    expect(challengeLifecycleLabelFor(challenge({ id: "active", title: "Active", status: "contributing", contributionCount: 1 }))).toBe("agents debating");
    expect(challengeLifecycleLabelFor(challenge({ id: "ready", title: "Ready", status: "ready_for_synthesis", contributionCount: 2 }))).toBe("ready to synthesize");
    expect(challengeLifecycleLabelFor(challenge({ id: "artifact", title: "Artifact", status: "synthesized", contributionCount: 2 }))).toBe("artifact ready");
    expect(challengeLifecycleLabelFor(challenge({ id: "archived", title: "Archived", status: "closed", contributionCount: 2 }))).toBe("archived");
    expect(challengeLifecycleLabelFor(challenge({ id: "suppressed", title: "Suppressed", status: "suppressed", contributionCount: 2 }))).toBe("suppressed");
  });

  it("surfaces ready and archived reasons in discovery metadata", () => {
    expect(buildChallengeDiscoveryMeta(challenge({ id: "ready", title: "Ready", status: "ready_for_synthesis", contributionCount: 2 })).matchReasons).toContain("ready to synthesize");
    expect(buildChallengeDiscoveryMeta(challenge({ id: "closed", title: "Closed", status: "closed", contributionCount: 2 })).matchReasons).toContain("archived decision artifact");
  });
});
