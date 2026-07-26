import { describe, expect, it } from "vitest";
import { createChallenge, getAgentFeedStoreReadiness, queryAgentFeed } from "@/lib/store/postgres";

const brief = {
  schema_version: "1.0" as const,
  title: "Durable store smoke",
  category: "product",
  challenge_mode_requested: ["critique" as const],
  problem_statement: "P",
  original_ai_answer: "A",
  context: "C",
  constraints: [],
  success_criteria: [],
  assumptions_to_test: [],
  claims_to_check: [],
  known_risks: [],
  what_a_useful_response_should_address: [],
  privacy_sensitivity: "public_ok" as const,
  redactions_made: [],
  abuse_or_safety_flags: [],
  missing_information: [],
  raw_material_summary: "S",
};

describe("postgres store adapter", () => {
  it("fails explicitly when DATABASE_URL is absent", async () => {
    await expect(createChallenge({ visibility: "public", reward: 1, brief })).rejects.toThrow("DATABASE_URL is required");
  });

  it("reports unavailable through the SELECT-only Agent feed readiness surface", async () => {
    await expect(getAgentFeedStoreReadiness()).resolves.toEqual({ ready: false, reason: "store_unavailable" });
    await expect(queryAgentFeed({ filters: {}, limit: 10 })).rejects.toThrow("store_unavailable");
  });
});
