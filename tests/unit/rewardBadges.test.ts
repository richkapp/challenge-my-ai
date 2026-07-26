import { describe, expect, it } from "vitest";
import { contributorBadge, contributorRewardScore, initialsForLabel } from "@/lib/rewards/badges";

describe("contributor reward badges", () => {
  it("keeps new contributors at the entry badge", () => {
    const badge = contributorBadge({ creditsEarned: 0, contributionCount: 0 });

    expect(badge.tier).toBe("new_voice");
    expect(badge.label).toBe("New Voice");
    expect(badge.score).toBe(0);
    expect(badge.nextMilestone).toContain("25 reward score");
  });

  it("keeps raw activity volume from promoting contributors by itself", () => {
    const badge = contributorBadge({ creditsEarned: 0, contributionCount: 40, usefulRatings: 0, communityScore: 0 });

    expect(badge.tier).toBe("new_voice");
    expect(badge.score).toBe(0);
  });

  it("keeps community trust from overpowering missing usefulness signals", () => {
    const badge = contributorBadge({ creditsEarned: 0, contributionCount: 4, usefulRatings: 0, communityScore: 999 });

    expect(badge.tier).toBe("new_voice");
    expect(badge.score).toBe(0);
  });

  it("promotes mid-signal contributors from usefulness signals", () => {
    const badge = contributorBadge({ creditsEarned: 20, contributionCount: 2, usefulRatings: 1 });

    expect(badge.tier).toBe("useful_signal");
    expect(badge.label).toBe("Useful Signal");
    expect(badge.score).toBeGreaterThanOrEqual(25);
  });

  it("promotes trusted and top contributors from existing usefulness and trust signals", () => {
    expect(contributorBadge({ creditsEarned: 70, contributionCount: 12, usefulRatings: 1, communityScore: 2 }).tier).toBe("trusted_challenger");
    expect(contributorBadge({ creditsEarned: 150, contributionCount: 30, usefulRatings: 3, communityScore: 5 }).tier).toBe("synthesis_maker");
  });

  it("clamps invalid values before scoring", () => {
    expect(contributorRewardScore({ creditsEarned: -50, contributionCount: Number.NaN, usefulRatings: -1, communityScore: -10 })).toBe(0);
  });

  it("generates compact initials for reward cards", () => {
    expect(initialsForLabel("Debate Scout Agent")).toBe("DS");
    expect(initialsForLabel("zeta")).toBe("ZE");
    expect(initialsForLabel("   ")).toBe("?");
  });
});
