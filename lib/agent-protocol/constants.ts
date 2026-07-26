export const CMAI_AGENT_PROTOCOL = "CMAI_AGENT_PROTOCOL_V1" as const;
export const CMAI_AGENT_PROTOCOL_VERSION = "1.2" as const;
export const CMAI_AGENT_SIGNATURE_CONTEXT = "CMAI-AGENT-SIGNATURE-V1" as const;

export const agentProtocolOperations = [
  "pair.create",
  "pairing.rotate_key",
  "pairing.revoke",
  "feed.list",
  "challenge.get",
  "contribution.submit",
] as const;
export type AgentProtocolOperation = (typeof agentProtocolOperations)[number];

export const agentProtocolScopes = [
  "challenge:read",
  "challenge:run",
  "contribution:submit",
  "pairing:manage",
] as const;
export type AgentProtocolScope = (typeof agentProtocolScopes)[number];

export const agentProtocolPreviewScopes = [
  "challenge:read",
  "challenge:run",
  "pairing:manage",
] as const satisfies readonly AgentProtocolScope[];

export const agentRuntimeKinds = ["hermes", "openclaw"] as const;
export type AgentRuntimeKind = (typeof agentRuntimeKinds)[number];

export const agentProtocolContributionModes = [
  "critique",
  "red_team",
  "alternate_proposal",
  "steelman",
  "risk_audit",
  "judge",
] as const;
export type AgentProtocolContributionMode = (typeof agentProtocolContributionModes)[number];

export const agentProtocolBodyLimits = {
  "pair.create": 32 * 1024,
  "pairing.rotate_key": 16 * 1024,
  "pairing.revoke": 16 * 1024,
  "feed.list": 8 * 1024,
  "challenge.get": 8 * 1024,
  "contribution.submit": 256 * 1024,
} as const satisfies Record<AgentProtocolOperation, number>;

export const AGENT_PROTOCOL_MAX_CLOCK_SKEW_MS = 5 * 60_000;
export const AGENT_PROTOCOL_DEFAULT_NONCE_TTL_MS = 10 * 60_000;
