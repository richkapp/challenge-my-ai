import { describe, expect, it } from "vitest";
import { parseChallengeBrief, structureRawChallenge } from "@/lib/validation/challengeBrief";
import { createChallengeSemantics, defaultSuccessCriteria } from "@/lib/challenges/intent";

const validBrief = {
  schema_version: "1.0",
  title: "T",
  category: "code",
  challenge_mode_requested: ["critique"],
  problem_statement: "Problem",
  original_ai_answer: "Answer",
  context: "Context",
  constraints: ["C1"],
  success_criteria: ["S1"],
  assumptions_to_test: ["A1"],
  claims_to_check: ["Claim"],
  known_risks: ["Risk"],
  what_a_useful_response_should_address: ["Address"],
  privacy_sensitivity: "public_ok",
  redactions_made: [],
  abuse_or_safety_flags: [],
  missing_information: [],
  raw_material_summary: "Summary",
} as const;

describe("challenge brief parser", () => {
  it("parses a fenced CMAI_CHALLENGE_BRIEF_V1 block", () => {
    const result = parseChallengeBrief(`\`\`\`CMAI_CHALLENGE_BRIEF_V1\n${JSON.stringify(validBrief)}\n\`\`\` `);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.title).toBe("T");
  });

  it("parses bare JSON challenge briefs when chat copy strips the fence label", () => {
    const result = parseChallengeBrief(JSON.stringify(validBrief, null, 2));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe("T");
      expect(result.value.original_ai_answer).toBe("Answer");
      expect(result.value.constraints).toEqual(["C1"]);
    }
  });

  it("parses generic json fences when chat clients normalize the code fence language", () => {
    const result = parseChallengeBrief(`\`\`\`json\n${JSON.stringify(validBrief)}\n\`\`\``);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.problem_statement).toBe("Problem");
  });

  it("parses a valid brief object embedded in pasted chat text", () => {
    const result = parseChallengeBrief(`Here is the brief:\n${JSON.stringify(validBrief, null, 2)}\nHope this helps.`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.raw_material_summary).toBe("Summary");
  });

  it("keeps legacy all-mode briefs valid for compatibility", () => {
    const payload = { schema_version: "1.0", title: "T", category: "product", challenge_mode_requested: ["critique", "red_team", "alternate_proposal", "steelman", "risk_audit", "judge"], problem_statement: "P", original_ai_answer: "A", context: "C", constraints: [], success_criteria: [], assumptions_to_test: [], claims_to_check: [], known_risks: [], what_a_useful_response_should_address: [], privacy_sensitivity: "public_ok", redactions_made: [], abuse_or_safety_flags: [], missing_information: [], raw_material_summary: "S" };
    const result = parseChallengeBrief(`\`\`\`CMAI_CHALLENGE_BRIEF_V1\n${JSON.stringify(payload)}\n\`\`\``);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.challenge_mode_requested).toContain("judge");
  });

  it("structures raw text with review warnings", () => {
    const brief = structureRawChallenge("Should I ship this plan?");
    expect(brief.title).toContain("Should I ship");
    expect(brief.challenge_mode_requested).toEqual(["critique"]);
    expect(brief.missing_information.length).toBeGreaterThan(0);
    expect(brief.challenge_intent).toBe("pressure_test");
    expect(brief.criteria_status).toBe("criteria_unconfirmed");
    expect(brief.success_criteria).toHaveLength(2);
  });

  it("structures paste-first problem and Agent-answer sections into a reviewable brief", () => {
    const brief = structureRawChallenge(`Problem:
I need to decide whether this implementation plan is safe to ship next week.

My Agent's current answer:
Ship the migration in one batch and skip a rollback plan because the table is small.

Context:
Next.js app, Postgres store, one operator, no maintenance window yet.

What I want challenged:
- rollback risk
- missing tests

Claims to check:
- the table is small enough for a one-shot migration

Privacy note:
Remove customer names, internal roadmap detail, and source code before publishing.`);

    expect(brief.title).toBe("I need to decide whether this");
    expect(brief.category).toBe("code");
    expect(brief.problem_statement).toContain("implementation plan is safe");
    expect(brief.original_ai_answer).toContain("skip a rollback plan");
    expect(brief.context).toContain("Postgres store");
    expect(brief.what_a_useful_response_should_address).toEqual(["rollback risk", "missing tests"]);
    expect(brief.claims_to_check).toEqual(["the table is small enough for a one-shot migration"]);
    expect(brief.privacy_sensitivity).toBe("anonymize_first");
    expect(brief.redactions_made[0]).toContain("private names");
  });

  it("rejects modern briefs with an invalid intent/outcome pair", () => {
    const criteria = defaultSuccessCriteria("solve");
    const semantics = createChallengeSemantics({ intent: "solve", successCriteria: criteria, status: "confirmed", changeReason: "Initial criteria." });
    const payload = {
      ...validBrief,
      ...semantics,
      success_criteria: criteria,
      successful_outcomes: ["decision_ready"],
      criteria_history: semantics.criteria_history.map((entry) => ({ ...entry, successful_outcomes: ["decision_ready"] })),
    };
    const result = parseChallengeBrief(`\`\`\`CMAI_CHALLENGE_BRIEF_V1\n${JSON.stringify(payload)}\n\`\`\``);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues?.some((issue) => issue.path === "successful_outcomes")).toBe(true);
  });
});
