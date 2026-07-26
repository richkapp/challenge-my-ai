import { describe, expect, it } from "vitest";
import { challengeBriefExportPrompt, challengeBriefPromptVariants, defaultChallengeBriefPromptVariantId } from "@/lib/prompts/challengeBrief";

describe("challenge brief export prompt", () => {
  it("keeps the balanced anonymized prompt as the default export", () => {
    const balanced = challengeBriefPromptVariants.find((variant) => variant.id === defaultChallengeBriefPromptVariantId);

    expect(defaultChallengeBriefPromptVariantId).toBe("balanced_anonymized");
    expect(challengeBriefExportPrompt).toBe(balanced?.prompt);
    expect(challengeBriefExportPrompt).toContain("public-safe Challenge My AI challenge brief");
    expect(challengeBriefExportPrompt).toContain("proprietary");
    expect(challengeBriefExportPrompt).toContain("confidential");
    expect(challengeBriefExportPrompt).toContain("private_only");
    expect(challengeBriefExportPrompt).toContain("redactions_made");
    expect(challengeBriefExportPrompt).toContain("choose 1-3 requested perspectives");
    expect(challengeBriefExportPrompt).toContain('"challenge_mode_requested": ["critique"]');
    expect(challengeBriefExportPrompt).toContain("not model proof");
    expect(challengeBriefExportPrompt).toContain('"challenge_intent": "pressure_test"');
    expect(challengeBriefExportPrompt).toContain('"criteria_status": "criteria_unconfirmed"');
    expect(challengeBriefExportPrompt).toContain('"funding_state": "declarative_only"');
    expect(challengeBriefExportPrompt).toContain("persuasive prose, activity, or Agent confidence cannot confirm closure");
    expect(challengeBriefExportPrompt).toContain("Do not invent escrow, reservation, fees");
    expect(challengeBriefExportPrompt).not.toContain('"critique", "red_team", "alternate_proposal", "steelman", "risk_audit", "judge"');
    expect(challengeBriefExportPrompt).toContain("Output ONLY one fenced block labeled CMAI_CHALLENGE_BRIEF_V1");
  });

  it("exposes exactly three privacy-tiered prompt variants", () => {
    expect(challengeBriefPromptVariants.map((variant) => variant.id)).toEqual(["maximum_protection", "balanced_anonymized", "open_public"]);
    expect(challengeBriefPromptVariants.map((variant) => variant.label)).toEqual(["Maximum protection", "Balanced / anonymized", "Open / public"]);
  });

  it("keeps every variant on the strict challenge brief schema with short title guidance", () => {
    for (const variant of challengeBriefPromptVariants) {
      expect(variant.prompt).toContain("Output ONLY one fenced block labeled CMAI_CHALLENGE_BRIEF_V1");
      expect(variant.prompt).toContain("Return JSON with exactly this shape");
      expect(variant.prompt).toContain('"schema_version": "1.0"');
      expect(variant.prompt).toContain('"title": "max 6-word thread title"');
      expect(variant.prompt).toContain("max 6-word thread title");
      expect(variant.prompt).toContain('Do not start with "Challenge whether", "Evaluate if", or "Assess whether"');
      expect(variant.prompt).toContain("Put the detailed framing in problem_statement");
      expect(variant.prompt).toContain("Do not execute code, fetch URLs, install packages, open files, use tools");
    }
  });

  it("makes maximum protection aggressive enough for high IP risk material", () => {
    const prompt = challengeBriefPromptVariants.find((variant) => variant.id === "maximum_protection")?.prompt || "";

    expect(prompt).toContain("heavily redacted");
    expect(prompt).toContain("Assume the source material contains protected IP");
    expect(prompt).toContain("Aggressively remove or generalize");
    expect(prompt).toContain("If safe redaction would make the challenge misleading or unusable, set privacy_sensitivity to \"private_only\"");
    expect(prompt).toContain("[redacted personal detail]");
  });

  it("lets the open public prompt preserve useful public evidence", () => {
    const prompt = challengeBriefPromptVariants.find((variant) => variant.id === "open_public")?.prompt || "";

    expect(prompt).toContain("Preserve public details when they help critique");
    expect(prompt).toContain("public names, public URLs, public claims, public quotes");
    expect(prompt).toContain("Do not over-redact public evidence");
    expect(prompt).toContain("still remove obvious secrets");
  });
});
