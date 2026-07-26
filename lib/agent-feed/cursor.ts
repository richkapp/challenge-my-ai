import { Buffer } from "node:buffer";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { canonicalAgentJson } from "@/lib/agent-protocol/canonical";
import { agentProtocolContributionModes } from "@/lib/agent-protocol/constants";

export const AGENT_FEED_CURSOR_VERSION = "1" as const;
export const AGENT_FEED_CURSOR_TTL_MS = 10 * 60_000;
export const AGENT_FEED_CURSOR_MAX_LENGTH = 300;

const BOUND_HASH_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const allowedRequestedModes = new Set<string>(agentProtocolContributionModes);

export type AgentFeedCursorPayload = {
  version: typeof AGENT_FEED_CURSOR_VERSION;
  snapshot_id: string;
  offset: number;
  filters_hash: string;
  audience_hash: string;
  expires_at: string;
};

type AgentFeedCursorWirePayload = {
  v: typeof AGENT_FEED_CURSOR_VERSION;
  s: string;
  o: number;
  f: string;
  a: string;
  e: string;
};

export type AgentFeedNormalizedFilters = {
  query?: string;
  category?: string;
  requested_modes?: string[];
  min_reward_credits?: number;
};

export class AgentFeedCursorError extends Error {
  constructor() {
    super("Agent feed cursor is invalid or expired.");
    this.name = "AgentFeedCursorError";
  }
}

function assertSecret(secret: string): void {
  if (Buffer.byteLength(secret, "utf8") < 32) throw new Error("Agent feed cursor secret must be at least 32 UTF-8 bytes.");
}

function digest128(value: Buffer): string {
  return value.subarray(0, 16).toString("base64url");
}

function mac(encodedPayload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`CMAI_AGENT_FEED_CURSOR_V1\0${encodedPayload}`, "utf8").digest();
}

function isCursorWirePayload(value: unknown): value is AgentFeedCursorWirePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return Object.keys(candidate).length === 6
    && candidate.v === AGENT_FEED_CURSOR_VERSION
    && typeof candidate.s === "string"
    && /^[A-Za-z0-9_-]{8,64}$/.test(candidate.s)
    && Number.isInteger(candidate.o)
    && Number(candidate.o) >= 1
    && Number(candidate.o) <= 1_000
    && typeof candidate.f === "string"
    && BOUND_HASH_PATTERN.test(candidate.f)
    && typeof candidate.a === "string"
    && BOUND_HASH_PATTERN.test(candidate.a)
    && typeof candidate.e === "string"
    && Number.isFinite(Date.parse(candidate.e));
}

export function normalizeAgentFeedFilters(filters: AgentFeedNormalizedFilters): AgentFeedNormalizedFilters {
  if (filters.query !== undefined && (typeof filters.query !== "string" || filters.query.length > 200)) {
    throw new TypeError("Agent feed query must be a string of at most 200 characters.");
  }
  if (filters.category !== undefined && (typeof filters.category !== "string" || filters.category.length > 100)) {
    throw new TypeError("Agent feed category must be a string of at most 100 characters.");
  }
  if (filters.requested_modes !== undefined && (
    !Array.isArray(filters.requested_modes)
    || filters.requested_modes.length > agentProtocolContributionModes.length
    || filters.requested_modes.some((mode) => typeof mode !== "string" || !allowedRequestedModes.has(mode))
  )) {
    throw new TypeError("Agent feed requested modes are invalid.");
  }
  if (filters.min_reward_credits !== undefined && (
    !Number.isInteger(filters.min_reward_credits)
    || filters.min_reward_credits < 0
  )) {
    throw new TypeError("Agent feed minimum reward must be a non-negative integer.");
  }

  const query = filters.query?.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  const category = filters.category?.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  if (filters.query !== undefined && !query) throw new TypeError("Agent feed query must not normalize to empty text.");
  if (filters.category !== undefined && !category) throw new TypeError("Agent feed category must not normalize to empty text.");
  const requestedModes = filters.requested_modes
    ? [...new Set(filters.requested_modes)].sort()
    : undefined;
  return {
    ...(query ? { query } : {}),
    ...(category ? { category } : {}),
    ...(requestedModes?.length ? { requested_modes: requestedModes } : {}),
    ...(filters.min_reward_credits !== undefined ? { min_reward_credits: filters.min_reward_credits } : {}),
  };
}

export function hashAgentFeedFilters(filters: AgentFeedNormalizedFilters): string {
  return digest128(createHash("sha256").update(canonicalAgentJson(normalizeAgentFeedFilters(filters)), "utf8").digest());
}

export function hashAgentFeedCursorAudience(audience: string, secret: string): string {
  assertSecret(secret);
  const normalized = audience.normalize("NFKC");
  if (!IDENTIFIER_PATTERN.test(normalized)) throw new AgentFeedCursorError();
  return digest128(createHmac("sha256", secret).update(`CMAI_AGENT_FEED_AUDIENCE_V1\0${normalized}`, "utf8").digest());
}

export function encodeAgentFeedCursor(input: {
  snapshotId: string;
  offset: number;
  filtersHash: string;
  audienceHash: string;
  expiresAt: string;
  secret: string;
}): string {
  assertSecret(input.secret);
  const payload: AgentFeedCursorWirePayload = {
    v: AGENT_FEED_CURSOR_VERSION,
    s: input.snapshotId,
    o: input.offset,
    f: input.filtersHash,
    a: input.audienceHash,
    e: input.expiresAt,
  };
  if (!isCursorWirePayload(payload)) throw new AgentFeedCursorError();
  const encoded = Buffer.from(canonicalAgentJson(payload), "utf8").toString("base64url");
  const cursor = `${encoded}.${mac(encoded, input.secret).toString("base64url")}`;
  if (cursor.length > AGENT_FEED_CURSOR_MAX_LENGTH) throw new AgentFeedCursorError();
  return cursor;
}

export function decodeAgentFeedCursor(input: {
  cursor: string;
  expectedFiltersHash: string;
  expectedAudienceHash: string;
  now: Date;
  secret: string;
}): AgentFeedCursorPayload {
  assertSecret(input.secret);
  if (!input.cursor || input.cursor.length > AGENT_FEED_CURSOR_MAX_LENGTH) throw new AgentFeedCursorError();
  const [encoded, signature, ...extra] = input.cursor.split(".");
  if (!encoded || !signature || extra.length) throw new AgentFeedCursorError();
  if (!/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]+$/.test(signature)) throw new AgentFeedCursorError();
  const payloadBytes = Buffer.from(encoded, "base64url");
  const supplied = Buffer.from(signature, "base64url");
  if (payloadBytes.toString("base64url") !== encoded || supplied.toString("base64url") !== signature) throw new AgentFeedCursorError();
  const expected = mac(encoded, input.secret);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new AgentFeedCursorError();
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    throw new AgentFeedCursorError();
  }
  if (!isCursorWirePayload(parsed)) throw new AgentFeedCursorError();
  if (Buffer.from(canonicalAgentJson(parsed), "utf8").toString("base64url") !== encoded) throw new AgentFeedCursorError();
  const expiresAt = Date.parse(parsed.e);
  if (
    parsed.f !== input.expectedFiltersHash
    || parsed.a !== input.expectedAudienceHash
    || expiresAt <= input.now.getTime()
    || expiresAt > input.now.getTime() + AGENT_FEED_CURSOR_TTL_MS
  ) {
    throw new AgentFeedCursorError();
  }
  return {
    version: parsed.v,
    snapshot_id: parsed.s,
    offset: parsed.o,
    filters_hash: parsed.f,
    audience_hash: parsed.a,
    expires_at: parsed.e,
  };
}
