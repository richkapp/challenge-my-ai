import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  AgentFeedProjectionError,
  agentProtocolResponseByteLimits,
  assertAgentProtocolResponseSize,
  assertSafeAgentRelativePath,
  truncateCodePoints,
  utf8JsonBytes,
} from "@/lib/agent-feed/egress";

describe("Agent feed egress boundary", () => {
  it("enforces aggregate UTF-8 response limits", () => {
    expect(utf8JsonBytes({ value: "😀" })).toBe(Buffer.byteLength(JSON.stringify({ value: "😀" }), "utf8"));
    expect(() => assertAgentProtocolResponseSize("feed.list", { value: "x".repeat(agentProtocolResponseByteLimits["feed.list"]) }))
      .toThrow(AgentFeedProjectionError);
    expect(() => assertAgentProtocolResponseSize("challenge.get", { value: "safe" })).not.toThrow();
  });

  it("accepts only canonical fixed origin-relative paths", () => {
    expect(assertSafeAgentRelativePath("/room/challenge_1")).toBe("/room/challenge_1");
    for (const unsafe of [
      "https://example.com/challenge",
      "//example.com/challenge",
      "/room/challenge?secret=1",
      "/room/challenge#fragment",
      "/room\\challenge",
      "/room/%2f%2fevil.example",
      "/room/\u202echallenge",
    ]) {
      expect(() => assertSafeAgentRelativePath(unsafe), unsafe).toThrow(AgentFeedProjectionError);
    }
  });

  it("truncates by Unicode code point without splitting surrogate pairs", () => {
    expect(truncateCodePoints("A😀B", 2)).toBe("A😀");
    expect(truncateCodePoints("A😀B", 0)).toBe("");
    expect(() => truncateCodePoints("x", -1)).toThrow(RangeError);
  });
});
