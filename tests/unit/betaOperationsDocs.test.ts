import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const runbook = readFileSync("docs/product/2026-07-06-beta-cohort-operations-support-runbook.md", "utf8");
const plan = readFileSync("docs/plans/2026-07-06-005-feat-card-26-beta-operations-support-plan.md", "utf8");

describe("Card 26 beta operations runbook", () => {
  it("defines the builder/operator beta cohort and honest invite path", () => {
    expect(runbook).toContain("agent-native builders, operators, founders, creators, or power users");
    expect(runbook).toContain("public-safe builder/operator challenges");
    expect(runbook).toContain("/challenges/new?ref=beta-cohort");
    expect(runbook).toContain("Copy prompt → paste local output");
    expect(runbook).toContain("Run my Agent here");
    expect(runbook).toContain("Plus, private rooms, deep challenges, and one-off review are waitlisted");
  });

  it("separates feedback and support paths without storing sensitive raw material", () => {
    for (const bucket of ["bug", "bad_synthesis", "confusing_ux", "safety_report", "contribution_quality", "paid_intent", "trusted_lane_readiness"]) {
      expect(runbook).toContain(bucket);
    }
    expect(runbook).toContain("Never paste raw secrets, private transcripts, provider tokens, full user chats, or raw `.env` values");
    expect(runbook).toContain("smoke_or_test_artifact");
    expect(runbook).toContain("CMAI_SMOKE_CLEANUP_MODE=moderator_suppress");
  });

  it("keeps production mutation and Card 26 closeout boundaries explicit", () => {
    expect(runbook).toContain("no deploy, rollback, live smoke, or production data mutation happens from this runbook alone");
    expect(runbook).toContain("Production should not seed fake public activity on page reads");
    expect(plan).toContain("No production deploy, live smoke, external email/CRM/support-tool setup");
    expect(plan).toContain("Card 26 was explicitly approved by Z/rkt");
  });
});
