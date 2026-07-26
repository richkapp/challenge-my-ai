import { Buffer } from "node:buffer";
import type { AgentProtocolOperation } from "@/lib/agent-protocol/constants";

export const agentProtocolResponseByteLimits = {
  "feed.list": 256 * 1024,
  "challenge.get": 512 * 1024,
} as const satisfies Partial<Record<AgentProtocolOperation, number>>;

const UNSAFE_PATH_PATTERN = /[\\\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/u;

export class AgentFeedProjectionError extends Error {
  constructor(readonly code: "response_too_large" | "unsafe_relative_url" | "projection_invalid", message: string) {
    super(message);
    this.name = "AgentFeedProjectionError";
  }
}

export function utf8JsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function assertAgentProtocolResponseSize(
  operation: "feed.list" | "challenge.get",
  value: unknown,
): void {
  const bytes = utf8JsonBytes(value);
  const limit = agentProtocolResponseByteLimits[operation];
  if (bytes > limit) {
    throw new AgentFeedProjectionError("response_too_large", `${operation} response exceeds ${limit} UTF-8 bytes.`);
  }
}

export function assertSafeAgentRelativePath(path: string): string {
  if (
    !path.startsWith("/")
    || path.startsWith("//")
    || path.includes("?")
    || path.includes("#")
    || path.includes(":")
    || path.includes("%")
    || UNSAFE_PATH_PATTERN.test(path)
  ) {
    throw new AgentFeedProjectionError("unsafe_relative_url", "Agent URLs must be fixed origin-relative paths without authority, query, or fragment components.");
  }
  const parsed = new URL(path, "https://cmai.invalid");
  if (parsed.origin !== "https://cmai.invalid" || parsed.pathname !== path) {
    throw new AgentFeedProjectionError("unsafe_relative_url", "Agent URLs must be canonical origin-relative paths.");
  }
  return path;
}

export function truncateCodePoints(value: string, maxCodePoints: number): string {
  if (!Number.isInteger(maxCodePoints) || maxCodePoints < 0) throw new RangeError("maxCodePoints must be a non-negative integer.");
  return Array.from(value).slice(0, maxCodePoints).join("");
}
