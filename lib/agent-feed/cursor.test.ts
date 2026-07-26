import { describe, expect, it } from "vitest";
import {
  AGENT_FEED_CURSOR_TTL_MS,
  AgentFeedCursorError,
  decodeAgentFeedCursor,
  encodeAgentFeedCursor,
  hashAgentFeedCursorAudience,
  hashAgentFeedFilters,
  normalizeAgentFeedFilters,
} from "@/lib/agent-feed/cursor";

const secret = "agent-feed-cursor-test-secret-32-bytes-minimum";
const now = new Date("2026-07-15T12:00:00.000Z");
const audienceHash = hashAgentFeedCursorAudience("pairing_cursor_1", secret);

function cursor(filtersHash = hashAgentFeedFilters({ category: "security" })) {
  return encodeAgentFeedCursor({
    snapshotId: "snapshot_12345678",
    offset: 25,
    filtersHash,
    audienceHash,
    expiresAt: new Date(now.getTime() + AGENT_FEED_CURSOR_TTL_MS).toISOString(),
    secret,
  });
}

describe("Agent feed cursor", () => {
  it("normalizes filters without retaining raw query order", () => {
    const first = normalizeAgentFeedFilters({
      query: "  RED   Team  ",
      category: " Security ",
      requested_modes: ["steelman", "critique", "steelman"],
      min_reward_credits: 5,
    });
    const second = normalizeAgentFeedFilters({
      query: "red team",
      category: "security",
      requested_modes: ["critique", "steelman"],
      min_reward_credits: 5,
    });
    expect(first).toEqual(second);
    expect(hashAgentFeedFilters(first)).toBe(hashAgentFeedFilters(second));
  });

  it("round-trips a filter- and audience-bound versioned snapshot cursor within the protocol cap", () => {
    const filtersHash = hashAgentFeedFilters({ category: "security" });
    expect(decodeAgentFeedCursor({ cursor: cursor(filtersHash), expectedFiltersHash: filtersHash, expectedAudienceHash: audienceHash, now, secret })).toEqual({
      version: "1",
      snapshot_id: "snapshot_12345678",
      offset: 25,
      filters_hash: filtersHash,
      audience_hash: audienceHash,
      expires_at: new Date(now.getTime() + AGENT_FEED_CURSOR_TTL_MS).toISOString(),
    });
    expect(cursor(filtersHash).length).toBeLessThanOrEqual(300);
  });

  it("fails closed for tampering, cross-filter or cross-audience reuse, expiry, and weak secrets", () => {
    const value = cursor();
    const filtersHash = hashAgentFeedFilters({ category: "security" });
    const tampered = `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
    expect(() => decodeAgentFeedCursor({ cursor: tampered, expectedFiltersHash: filtersHash, expectedAudienceHash: audienceHash, now, secret }))
      .toThrow(AgentFeedCursorError);
    expect(() => decodeAgentFeedCursor({ cursor: value, expectedFiltersHash: hashAgentFeedFilters({ category: "finance" }), expectedAudienceHash: audienceHash, now, secret }))
      .toThrow(AgentFeedCursorError);
    expect(() => decodeAgentFeedCursor({ cursor: value, expectedFiltersHash: filtersHash, expectedAudienceHash: hashAgentFeedCursorAudience("pairing_cursor_2", secret), now, secret }))
      .toThrow(AgentFeedCursorError);
    expect(() => decodeAgentFeedCursor({ cursor: value, expectedFiltersHash: filtersHash, expectedAudienceHash: audienceHash, now: new Date(now.getTime() + AGENT_FEED_CURSOR_TTL_MS), secret }))
      .toThrow(AgentFeedCursorError);
    expect(() => cursor("not-a-hash")).toThrow(AgentFeedCursorError);
    expect(() => decodeAgentFeedCursor({ cursor: `${value}=`, expectedFiltersHash: filtersHash, expectedAudienceHash: audienceHash, now, secret }))
      .toThrow(AgentFeedCursorError);
    const farFuture = encodeAgentFeedCursor({
      snapshotId: "snapshot_12345678",
      offset: 25,
      filtersHash,
      audienceHash,
      expiresAt: new Date(now.getTime() + AGENT_FEED_CURSOR_TTL_MS + 1).toISOString(),
      secret,
    });
    expect(() => decodeAgentFeedCursor({ cursor: farFuture, expectedFiltersHash: filtersHash, expectedAudienceHash: audienceHash, now, secret }))
      .toThrow(AgentFeedCursorError);
    expect(() => decodeAgentFeedCursor({ cursor: value, expectedFiltersHash: filtersHash, expectedAudienceHash: audienceHash, now, secret: "short" }))
      .toThrow("at least 32");
    expect(() => hashAgentFeedCursorAudience("bad audience", secret)).toThrow(AgentFeedCursorError);
  });

  it("rejects malformed filters instead of silently widening or coercing them", () => {
    expect(() => normalizeAgentFeedFilters({ query: "   " })).toThrow(TypeError);
    expect(() => normalizeAgentFeedFilters({ query: "x".repeat(201) })).toThrow(TypeError);
    expect(() => normalizeAgentFeedFilters({ category: "x".repeat(101) })).toThrow(TypeError);
    expect(() => normalizeAgentFeedFilters({ requested_modes: ["not-a-mode"] })).toThrow(TypeError);
    expect(() => normalizeAgentFeedFilters({ min_reward_credits: 1.5 })).toThrow(TypeError);
  });
});
