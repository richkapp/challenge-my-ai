import { createHash } from "node:crypto";
import {
  CMAI_AGENT_PROTOCOL,
  CMAI_AGENT_PROTOCOL_VERSION,
  CMAI_AGENT_SIGNATURE_CONTEXT,
  type AgentProtocolOperation,
} from "@/lib/agent-protocol/constants";

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n").normalize("NFC");
}

function normalizeJsonValue(value: unknown, path = "$"): unknown {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value === "string") return normalizeText(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Canonical JSON cannot encode a non-finite number at ${path}.`);
    return value;
  }
  if (typeof value !== "object") throw new TypeError(`Canonical JSON cannot encode ${typeof value} at ${path}.`);
  if (Array.isArray(value)) return value.map((item, index) => normalizeJsonValue(item, `${path}[${index}]`) ?? null);

  const normalized: Record<string, unknown> = {};
  const keys = Object.keys(value as Record<string, unknown>)
    .map((key) => ({ key, normalizedKey: normalizeText(key) }))
    .sort((a, b) => a.normalizedKey < b.normalizedKey ? -1 : a.normalizedKey > b.normalizedKey ? 1 : 0);
  for (const { key, normalizedKey } of keys) {
    const child = normalizeJsonValue((value as Record<string, unknown>)[key], `${path}.${key}`);
    if (child === undefined) continue;
    if (Object.hasOwn(normalized, normalizedKey)) throw new TypeError(`Canonical JSON contains colliding normalized keys at ${path}.${key}.`);
    normalized[normalizedKey] = child;
  }
  return normalized;
}

export function canonicalAgentJson(value: unknown): string {
  const normalized = normalizeJsonValue(value);
  if (normalized === undefined) throw new TypeError("Canonical JSON cannot encode undefined at $.");
  return JSON.stringify(normalized);
}

export function agentProtocolSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function hashAgentProtocolPayload(payload: unknown): string {
  return agentProtocolSha256(canonicalAgentJson(payload));
}

export type AgentSigningInput = {
  protocol: typeof CMAI_AGENT_PROTOCOL;
  protocol_version: typeof CMAI_AGENT_PROTOCOL_VERSION;
  operation: AgentProtocolOperation;
  request_id: string;
  sent_at: string;
  pairing_id: string;
  key_id: string;
  payload: unknown;
};

export function canonicalAgentSigningBytes(input: AgentSigningInput): string {
  return [
    CMAI_AGENT_SIGNATURE_CONTEXT,
    input.protocol,
    input.protocol_version,
    input.operation,
    input.request_id,
    input.sent_at,
    input.pairing_id,
    input.key_id,
    hashAgentProtocolPayload(input.payload),
    "",
  ].join("\n");
}
