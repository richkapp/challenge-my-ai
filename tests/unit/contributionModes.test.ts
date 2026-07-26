import { describe, expect, it } from "vitest";
import { contributionModes } from "@/lib/types";
import {
  defaultContributionModeForRequestedModes,
  defaultRequestedContributionModes,
  labelForContributionMode,
  maxRequestedPerspectives,
  normalContributionModes,
  normalizeRequestedContributionModes,
  parseNormalContributionModeFilter,
  requestedContributionModesForNormalSurface,
} from "@/lib/contributionModes";

describe("contribution mode presentation metadata", () => {
  it("keeps the full compatibility enum intact", () => {
    expect(contributionModes).toEqual([
      "critique",
      "red_team",
      "alternate_proposal",
      "steelman",
      "risk_audit",
      "judge",
    ]);
  });

  it("uses critique as the default requested perspective", () => {
    expect(defaultRequestedContributionModes).toEqual(["critique"]);
    expect(maxRequestedPerspectives).toBe(3);
  });

  it("excludes judge from the normal picker surface", () => {
    expect(normalContributionModes).toContain("critique");
    expect(normalContributionModes).toContain("red_team");
    expect(normalContributionModes).toContain("alternate_proposal");
    expect(normalContributionModes).toContain("risk_audit");
    expect(normalContributionModes).toContain("steelman");
    expect(normalContributionModes).not.toContain("judge");
  });

  it("renders human labels without underscores", () => {
    expect(labelForContributionMode("red_team")).toBe("Red-team");
    expect(labelForContributionMode("alternate_proposal")).toBe("Alternate proposal");
    expect(labelForContributionMode("steelman")).toBe("Defend / steelman");
  });

  it("defaults legacy advanced-only requested perspectives back to critique", () => {
    expect(defaultContributionModeForRequestedModes(["judge"])).toBe("critique");
  });

  it("preserves poster-requested order while filtering hidden advanced modes", () => {
    expect(requestedContributionModesForNormalSurface(["red_team", "judge", "critique", "red_team"])).toEqual(["red_team", "critique"]);
    expect(defaultContributionModeForRequestedModes(["red_team", "critique"])).toBe("red_team");
  });

  it("normalizes normal surfaces to visible requested perspectives only", () => {
    expect(requestedContributionModesForNormalSurface(["judge"])).toEqual(["critique"]);
    expect(normalizeRequestedContributionModes(["judge", "critique", "red_team", "alternate_proposal", "risk_audit"])).toEqual(["critique", "red_team", "alternate_proposal"]);
  });

  it("ignores hidden advanced modes in normal lobby filters", () => {
    expect(parseNormalContributionModeFilter("red_team")).toBe("red_team");
    expect(parseNormalContributionModeFilter("judge")).toBeUndefined();
    expect(parseNormalContributionModeFilter("unknown")).toBeUndefined();
  });
});
