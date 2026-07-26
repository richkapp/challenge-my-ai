import crypto from "node:crypto";
import { HttpError } from "@/lib/api/responses";
import { contributionModes, type ContributionMode } from "@/lib/types";
import { env, isProductionLike, isTestLike, type RuntimeEnv } from "@/lib/config/env";
import { assertRateLimitPolicy } from "@/lib/security/rateLimit";

export type AgentIdentity = {
  id: string;
  label: string;
  ownerId: string;
  description?: string;
  capabilities: ContributionMode[];
};

function parseCapabilities(value: string | null): ContributionMode[] {
  if (!value) return ["critique"];
  const modes = value
    .split(",")
    .map((item) => item.trim())
    .filter((item): item is ContributionMode => (contributionModes as readonly string[]).includes(item));
  return modes.length ? modes : ["critique"];
}

function timingSafeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function signAgentRequest(input: { agentId: string; timestamp: string; secret: string }) {
  return crypto.createHmac("sha256", input.secret).update(`${input.agentId}.${input.timestamp}`).digest("hex");
}

function hasValidProductionSignature(headers: Headers, agentId: string, runtime: RuntimeEnv) {
  if (!runtime.CMAI_AGENT_API_SECRET) return false;
  const timestamp = headers.get("x-cmai-agent-timestamp")?.trim();
  const signature = headers.get("x-cmai-agent-signature")?.trim();
  if (!timestamp || !signature) return false;
  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs)) return false;
  if (Math.abs(Date.now() - timestampMs) > 5 * 60_000) return false;
  const expected = signAgentRequest({ agentId, timestamp, secret: runtime.CMAI_AGENT_API_SECRET });
  return timingSafeEqual(signature, expected);
}

export function agentFromHeaders(headers: Headers, options: { runtime?: RuntimeEnv } = {}): AgentIdentity | null {
  const runtime = options.runtime ?? env;
  const id = headers.get("x-cmai-agent-id")?.trim();
  if (!id) return null;
  if (isProductionLike(runtime) && !isTestLike(runtime) && !hasValidProductionSignature(headers, id, runtime)) return null;
  return {
    id,
    label: headers.get("x-cmai-agent-label")?.trim() || id,
    ownerId: headers.get("x-cmai-agent-owner-id")?.trim() || "local-owner",
    description: headers.get("x-cmai-agent-description")?.trim() || undefined,
    capabilities: parseCapabilities(headers.get("x-cmai-agent-capabilities")),
  };
}

export function requireAgent(request: Request): AgentIdentity {
  const agent = agentFromHeaders(request.headers);
  if (!agent) throw new HttpError(401, "Agent identity required.", "agent_unauthenticated");
  assertRateLimitPolicy("agent_api", `agent:${agent.id}:${new URL(request.url).pathname}`);
  return agent;
}
