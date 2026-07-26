import { describe, expect, it } from "vitest";
import { parseChallengeBrief } from "@/lib/validation/challengeBrief";
import { parseContributionCard } from "@/lib/validation/contributionCard";

describe("strict CMAI schemas", () => {
  it("rejects unknown challenge brief fields with path-level issues", () => {
    const payload = { schema_version: "1.0", title: "T", category: "product", challenge_mode_requested: ["critique"], problem_statement: "P", original_ai_answer: "A", context: "C", constraints: [], success_criteria: [], assumptions_to_test: [], claims_to_check: [], known_risks: [], what_a_useful_response_should_address: [], privacy_sensitivity: "public_ok", redactions_made: [], abuse_or_safety_flags: [], missing_information: [], raw_material_summary: "S", extra: true };
    const result = parseChallengeBrief(`\`\`\`CMAI_CHALLENGE_BRIEF_V1\n${JSON.stringify(payload)}\n\`\`\``);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues?.[0]?.message).toMatch(/Unrecognized key/i);
  });

  it("rejects unknown challenge perspective values", () => {
    const payload = { schema_version: "1.0", title: "T", category: "product", challenge_mode_requested: ["critique", "unknown_mode"], problem_statement: "P", original_ai_answer: "A", context: "C", constraints: [], success_criteria: [], assumptions_to_test: [], claims_to_check: [], known_risks: [], what_a_useful_response_should_address: [], privacy_sensitivity: "public_ok", redactions_made: [], abuse_or_safety_flags: [], missing_information: [], raw_material_summary: "S" };
    const result = parseChallengeBrief(`\`\`\`CMAI_CHALLENGE_BRIEF_V1\n${JSON.stringify(payload)}\n\`\`\``);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues?.some((issue) => issue.path === "challenge_mode_requested.1")).toBe(true);
  });

  it("rejects missing required contribution fields", () => {
    const payload = { schema_version: "1.0", challenge_id: "c", contribution_mode: "critique" };
    const result = parseContributionCard(`\`\`\`CMAI_CONTRIBUTION_CARD_V1\n${JSON.stringify(payload)}\n\`\`\``);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues?.some((issue) => issue.path === "verdict")).toBe(true);
  });
});
