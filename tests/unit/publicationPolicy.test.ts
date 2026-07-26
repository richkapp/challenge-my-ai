import { describe, expect, it } from "vitest";
import { evaluateChallengePublicationPolicy } from "@/lib/moderation/publicationPolicy";

const brief = { schema_version: "1.0" as const, title: "T", category: "product", challenge_mode_requested: ["critique" as const], problem_statement: "P", original_ai_answer: "A", context: "C", constraints: [], success_criteria: [], assumptions_to_test: [], claims_to_check: [], known_risks: [], what_a_useful_response_should_address: [], privacy_sensitivity: "public_ok" as const, redactions_made: [], abuse_or_safety_flags: [], missing_information: [], raw_material_summary: "S" };

describe("publication policy", () => {
  it("blocks public posting for private-only briefs even with public-post override", () => {
    const policy = evaluateChallengePublicationPolicy({ brief: { ...brief, privacy_sensitivity: "private_only" }, visibility: "public", confirmPrivacyOverride: true });
    expect(policy.ok).toBe(false);
    expect(policy.riskLevel).toBe("blocked");
    expect(policy.canOverride).toBe(false);
    expect(policy.blockers.join(" ")).toContain("private_only");
    expect(policy.relatedArtifactSearchAllowed).toBe(false);
  });

  it("keeps private-room visibility separate from public-safety policy", () => {
    const policy = evaluateChallengePublicationPolicy({ brief: { ...brief, privacy_sensitivity: "private_only" }, visibility: "private" });
    expect(policy.ok).toBe(true);
    expect(policy.riskLevel).toBe("needs_review");
    expect(policy.relatedArtifactSearchAllowed).toBe(false);
    expect(policy.safetyFlags).toContain("privacy_risk");
  });

  it("requires override for unknown privacy sensitivity but allows it after explicit review", () => {
    const blocked = evaluateChallengePublicationPolicy({ brief: { ...brief, privacy_sensitivity: "unknown" }, visibility: "public" });
    expect(blocked.ok).toBe(false);
    expect(blocked.canOverride).toBe(true);

    const allowed = evaluateChallengePublicationPolicy({ brief: { ...brief, privacy_sensitivity: "unknown" }, visibility: "public", confirmPrivacyOverride: true });
    expect(allowed.ok).toBe(true);
    expect(allowed.riskLevel).toBe("needs_review");
    expect(allowed.relatedArtifactSearchAllowed).toBe(false);
  });

  it("blocks anonymize-first briefs until concrete redactions are recorded", () => {
    const missingRedactions = evaluateChallengePublicationPolicy({ brief: { ...brief, privacy_sensitivity: "anonymize_first" }, visibility: "public", confirmPrivacyOverride: true });
    expect(missingRedactions.ok).toBe(false);
    expect(missingRedactions.blockers.join(" ")).toContain("redactions_made");

    const redacted = evaluateChallengePublicationPolicy({
      brief: { ...brief, privacy_sensitivity: "anonymize_first", redactions_made: ["Removed customer names and private roadmap metrics."] },
      visibility: "public",
      confirmPrivacyOverride: true,
    });
    expect(redacted.ok).toBe(true);
    expect(redacted.safetyFlags).toContain("privacy_risk");
  });

  it("blocks obvious secrets in public briefs", () => {
    const policy = evaluateChallengePublicationPolicy({ brief: { ...brief, problem_statement: "API_KEY=abc123" }, visibility: "public", confirmPrivacyOverride: true });
    expect(policy.ok).toBe(false);
    expect(policy.safetyFlags).toContain("secret_exposure");
    expect(policy.blockers.join(" ")).toContain("secrets");
  });

  it("scans array fields, redaction notes, and missing-information notes for secrets and privacy risks", () => {
    const policy = evaluateChallengePublicationPolicy({
      brief: {
        ...brief,
        constraints: ["Use the private repo ghp_abcdefghijklmnopqrstuvwxyz1234"],
        missing_information: ["Customer list was copied from jane@example.com"],
      },
      visibility: "public",
      confirmPrivacyOverride: true,
    });

    expect(policy.ok).toBe(false);
    expect(policy.safetyFlags).toEqual(expect.arrayContaining(["secret_exposure", "privacy_risk"]));
  });

  it("requires redaction evidence before proprietary material can be publicly overridden", () => {
    const missingRedaction = evaluateChallengePublicationPolicy({ brief: { ...brief, context: "This includes confidential customer names from an unreleased roadmap." }, visibility: "public", confirmPrivacyOverride: true });
    expect(missingRedaction.ok).toBe(false);
    expect(missingRedaction.safetyFlags).toContain("privacy_risk");
    expect(missingRedaction.blockers.join(" ")).toContain("redactions_made");

    const redacted = evaluateChallengePublicationPolicy({
      brief: { ...brief, context: "This includes a generalized launch timing concern.", redactions_made: ["Removed confidential customer names and unreleased roadmap specifics."] },
      visibility: "public",
      confirmPrivacyOverride: true,
    });
    expect(redacted.ok).toBe(true);
    expect(redacted.warnings.join(" ")).toContain("proprietary");
  });

  it("does not block clearly public open-source references as private source code", () => {
    const policy = evaluateChallengePublicationPolicy({
      brief: { ...brief, category: "code", context: "This is about an open-source code reference and public implementation details, with no protected repository material." },
      visibility: "public",
      confirmPrivacyOverride: true,
    });

    expect(policy.ok).toBe(true);
    expect(policy.safetyFlags).not.toContain("privacy_risk");
  });

  it("blocks high-liability professional-advice categories for public launch", () => {
    const policy = evaluateChallengePublicationPolicy({
      brief: { ...brief, category: "legal", problem_statement: "Should I sue this vendor? I need legal advice." },
      visibility: "public",
      confirmPrivacyOverride: true,
    });

    expect(policy.ok).toBe(false);
    expect(policy.safetyFlags).toContain("sensitive_category");
    expect(policy.blockers.join(" ")).toContain("not public-launch categories yet");
  });
});
