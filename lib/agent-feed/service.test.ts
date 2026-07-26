import { describe, expect, it } from "vitest";
import { validFeedListResponseFixture } from "@/lib/agent-protocol/fixtures";
import { agentPublicChallengeSummarySchema } from "@/lib/agent-protocol/schemas";
import { utf8JsonBytes } from "@/lib/agent-feed/egress";
import { buildBoundedAgentFeedListResponse } from "@/lib/agent-feed/service";

const requestId = "req_bounded_feed_1";
const serverTime = "2026-07-15T12:00:00.000Z";

describe("Agent feed response byte budgeting", () => {
  it("returns the largest bounded prefix and resumes at the first unreturned snapshot item", () => {
    const base = agentPublicChallengeSummarySchema.parse(validFeedListResponseFixture.result.challenges[0]);
    const entries = [1, 2, 3].map((offset) => ({
      summary: { ...base, challenge_id: `challenge_budget_${offset}`, summary: "x".repeat(2_000) },
      resumeOffset: offset,
    }));
    const twoItemEnvelope = {
      protocol: "CMAI_AGENT_PROTOCOL_V1",
      protocol_version: "1.2",
      request_id: requestId,
      server_time: serverTime,
      result: {
        challenges: entries.slice(0, 2).map((entry) => entry.summary),
        next_cursor: "cursor-2",
      },
    };

    const response = buildBoundedAgentFeedListResponse({
      requestId,
      serverTime,
      entries,
      cursorForOffset: (offset) => `cursor-${offset}`,
      byteLimit: utf8JsonBytes(twoItemEnvelope),
    });

    expect(response.result.challenges.map((challenge) => challenge.challenge_id)).toEqual([
      "challenge_budget_1",
      "challenge_budget_2",
    ]);
    expect(response.result.next_cursor).toBe("cursor-2");
    expect(utf8JsonBytes(response)).toBeLessThanOrEqual(utf8JsonBytes(twoItemEnvelope));
  });

  it("fails closed when even one projected summary cannot fit", () => {
    const base = agentPublicChallengeSummarySchema.parse(validFeedListResponseFixture.result.challenges[0]);
    expect(() => buildBoundedAgentFeedListResponse({
      requestId,
      serverTime,
      entries: [{ summary: { ...base, summary: "x".repeat(2_000) }, resumeOffset: 1 }],
      cursorForOffset: (offset) => `cursor-${offset}`,
      byteLimit: 128,
    })).toThrow("One Agent feed summary exceeds");
  });
});
