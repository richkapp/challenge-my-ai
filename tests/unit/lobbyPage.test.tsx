import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeEach } from "vitest";
import LobbyPage from "@/app/(app)/lobby/page";
import { listChallenges } from "@/lib/store";
import type { Challenge, ChallengeBrief } from "@/lib/types";
import { createChallengeSemantics } from "@/lib/challenges/intent";

vi.mock("@/lib/store", () => ({
  ensureSeedData: vi.fn(async () => undefined),
  listChallenges: vi.fn(async () => []),
  resetStoreForTests: vi.fn(async () => undefined),
}));

const brief: ChallengeBrief = {
  schema_version: "1.0",
  ...createChallengeSemantics({ intent: "solve", successCriteria: ["Find useful objections"], status: "confirmed", changeReason: "Confirmed lobby fixture criteria." }),
  title: "Lobby fixture",
  category: "product",
  challenge_mode_requested: ["critique"],
  problem_statement: "Pressure-test this Agent answer.",
  original_ai_answer: "Ship the current answer.",
  context: "Lobby test context.",
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
  raw_material_summary: "Lobby unit-test challenge",
};

function challenge(overrides: Partial<Challenge> & { id: string; title: string }): Challenge {
  return {
    id: overrides.id,
    createdAt: overrides.createdAt || "2026-07-04T10:00:00.000Z",
    updatedAt: overrides.updatedAt || overrides.createdAt || "2026-07-04T10:00:00.000Z",
    posterId: "poster",
    status: overrides.status || "open",
    title: overrides.title,
    category: overrides.category || "product",
    visibility: "public",
    reward: overrides.reward ?? 20,
    requestedModes: overrides.requestedModes || ["critique"],
    brief: { ...brief, title: overrides.title, category: overrides.category || "product", challenge_mode_requested: overrides.requestedModes || ["critique"], problem_statement: overrides.brief?.problem_statement || brief.problem_statement },
    safetyFlags: [],
    contributionCount: overrides.contributionCount ?? 0,
    activeCriteriaVersion: 1,
    publicEligibility: { eligible: true, reasons: [], criteriaVersion: 1, assessedAt: overrides.updatedAt || "2026-07-04T10:00:00.000Z" },
  };
}

const mockedListChallenges = listChallenges as unknown as {
  mockReset(): void;
  mockResolvedValue(value: Challenge[]): void;
};

describe("lobby requested perspective copy", () => {
  beforeEach(() => {
    mockedListChallenges.mockReset();
    mockedListChallenges.mockResolvedValue([]);
  });

  it("shows normal useful angles and hides judge from the filter surface", async () => {
    const element = await LobbyPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("Find a challenge.");
    expect(html).toContain("Defend / steelman");
    expect(html).toContain("Answer state");
    expect(html).toContain("No challenges yet.");
    expect(html).toContain("Post an AI answer worth challenging.");
    expect(html).toContain("Post a challenge");
    expect(html).not.toContain("judge the answer");
    expect(html).not.toContain(">Judge<");
  });

  it("filters and sorts discovery cards with launch-relevant metadata", async () => {
    mockedListChallenges.mockResolvedValue([
      challenge({ id: "copy", title: "Landing page positioning", category: "copy", reward: 25, requestedModes: ["critique", "alternate_proposal"] }),
      challenge({ id: "pricing", title: "Plus launch decision", category: "business_decision", reward: 80, requestedModes: ["risk_audit"], status: "contributing", contributionCount: 1 }),
    ]);

    const element = await LobbyPage({ searchParams: Promise.resolve({ category: "business decision", minReward: "50", sort: "reward" }) });
    const html = renderToStaticMarkup(element);

    expect(html).toContain("1 challenge");
    expect(html).toContain("business decision");
    expect(html).toContain("80 credits");
    expect(html).toContain("1 perspective");
    expect(html).toContain("Risk audit");
    expect(html).not.toContain("Landing page positioning");
  });
});
