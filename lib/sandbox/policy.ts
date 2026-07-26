import type { AgentConnectionDelegation, ContributionMode, SandboxNetworkIsolation } from "@/lib/types";

export const sandboxNetworkModes = ["isolated", "private"] as const;
export type SandboxNetworkMode = (typeof sandboxNetworkModes)[number];

export const APPROVED_UNTRUSTED_RUNNER_CHECKPOINT = "cmai-hermes-runner-v1";

export const approvedUntrustedRunnerProfile = {
  profile: APPROVED_UNTRUSTED_RUNNER_CHECKPOINT,
  checkpoint: APPROVED_UNTRUSTED_RUNNER_CHECKPOINT,
  command: "cmai-blank-slate-runner",
} as const;

export type ChallengeSandboxPolicy = {
  network: SandboxNetworkMode;
  idleTimeoutMinutes: number;
  commandTimeoutSeconds: number;
  outputLimitBytes: number;
  secrets: "none" | "scoped_byok" | "broker_only";
  destroyOnCompletion: boolean;
};

export type SandboxRunnerOverride = {
  profile?: string;
  checkpoint?: string;
  command?: string;
  image?: string;
  entrypoint?: string;
  shellArgs?: string[];
  mountedTools?: string[];
  enabledTools?: string[];
};

export type ChallengeSandboxRunRequest = {
  challengeId: string;
  contributionMode: ContributionMode | string;
  adapter: "paste_in" | "provider_api" | "local_connector" | "platform_run" | "railway_sandbox" | "local_fake";
  policy: ChallengeSandboxPolicy;
  trustedInternal?: boolean;
  agentConnection?: AgentConnectionDelegation;
  runner?: SandboxRunnerOverride;
  config?: unknown;
};

export type ChallengeSandboxRunResult = {
  runId: string;
  challengeId: string;
  sandboxId?: string;
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  artifactSha256?: string;
  destroyed: boolean;
};

export const deniedSandboxConfigKeys = new Set([
  "database_url",
  "postgres_url",
  "postgres_prisma_url",
  "postgres_url_non_pooling",
  "pgurl",
  "supabase_service_role_key",
  "receipt_signing_key",
  "receipt_signing_secret",
  "broker_token",
  "broker_internal_token",
  "railway_token",
  "api_key",
  "access_token",
  "refresh_token",
  "session_id",
  "id_token",
  "authorization_code",
  "one_time_code",
  "setup_token",
  "codex_session",
  "claude_code_session",
  "claude_code_credential",
  "oauth_access_token",
  "oauth_refresh_token",
  "openai_api_key",
  "anthropic_api_key",
  "openrouter_api_key",
  "google_api_key",
  "gemini_api_key",
  "mistral_api_key",
]);

export function defaultContributionSandboxPolicy(overrides: Partial<ChallengeSandboxPolicy> = {}): ChallengeSandboxPolicy {
  return {
    network: "isolated",
    idleTimeoutMinutes: 30,
    commandTimeoutSeconds: 120,
    outputLimitBytes: 100_000,
    secrets: "none",
    destroyOnCompletion: true,
    ...overrides,
  };
}

export function railwayNetworkIsolationForPolicy(policy: ChallengeSandboxPolicy): SandboxNetworkIsolation {
  return policy.network === "private" ? "PRIVATE" : "ISOLATED";
}

export function validateUntrustedContributionSandboxPolicy(policy: ChallengeSandboxPolicy): string[] {
  const issues: string[] = [];
  if (!sandboxNetworkModes.includes(policy.network as SandboxNetworkMode)) issues.push("Sandbox network mode must be isolated or private.");
  if (policy.network !== "isolated") issues.push("Untrusted contribution sandboxes must default to isolated networking.");
  if (policy.secrets !== "none") issues.push("Untrusted contribution sandboxes must not receive provider, broker, or production secrets.");
  if (!policy.destroyOnCompletion) issues.push("Untrusted contribution sandboxes must be destroyed after completion.");
  if (policy.idleTimeoutMinutes > 30) issues.push("Idle timeout should stay at or below 30 minutes unless a human approves the cost risk.");
  if (policy.commandTimeoutSeconds > 600) issues.push("Command timeout should stay at or below 10 minutes for contribution runs.");
  if (policy.outputLimitBytes > 1_000_000) issues.push("Output capture should be capped to prevent log/artifact abuse.");
  return issues;
}

export function normalizeSandboxConfigKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-.\s]+/g, "_").toLowerCase();
}

function scanDeniedConfigKeys(value: unknown, path: string[] = [], issues: string[] = []): string[] {
  if (!value || typeof value !== "object") return issues;
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanDeniedConfigKeys(item, [...path, String(index)], issues));
    return issues;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const normalized = normalizeSandboxConfigKey(key);
    if (deniedSandboxConfigKeys.has(normalized)) {
      issues.push(`Sandbox config must not include broker/provider secret field ${[...path, key].join(".")}.`);
    }
    scanDeniedConfigKeys(child, [...path, key], issues);
  }
  return issues;
}

export function validateSandboxConfigForBrokerSecrets(config: unknown): string[] {
  return scanDeniedConfigKeys(config);
}

export function validateAgentConnectionDelegation(delegation?: AgentConnectionDelegation): string[] {
  if (!delegation) return [];
  const issues: string[] = [];
  if (!delegation.connection_id) issues.push("Agent connection delegation requires a connection id.");
  if (!delegation.provider) issues.push("Agent connection delegation requires a provider.");
  if (!delegation.expires_at) issues.push("Agent connection delegation requires an expiry timestamp.");
  if (delegation.max_spend_cents !== undefined && delegation.max_spend_cents < 0) issues.push("Agent connection max spend must be non-negative.");
  if (delegation.max_requests !== undefined && delegation.max_requests < 1) issues.push("Agent connection max requests must be positive when set.");
  return issues;
}

export function validateUntrustedRunnerProfile(runner?: SandboxRunnerOverride): string[] {
  if (!runner) return [];
  const issues: string[] = [];
  if (runner.profile && runner.profile !== approvedUntrustedRunnerProfile.profile) issues.push("Untrusted contribution runs cannot override the approved runner profile.");
  if (runner.checkpoint && runner.checkpoint !== approvedUntrustedRunnerProfile.checkpoint) issues.push("Untrusted contribution runs cannot override the approved runner checkpoint.");
  if (runner.command && runner.command !== approvedUntrustedRunnerProfile.command) issues.push("Untrusted contribution runs cannot override the approved runner command.");
  if (runner.image) issues.push("Untrusted contribution runs cannot choose a container image.");
  if (runner.entrypoint) issues.push("Untrusted contribution runs cannot choose an entrypoint.");
  if (runner.shellArgs?.length) issues.push("Untrusted contribution runs cannot provide shell arguments.");
  if (runner.mountedTools?.length) issues.push("Untrusted contribution runs cannot mount extra tools.");
  if (runner.enabledTools?.length) issues.push("Untrusted contribution runs cannot enable extra tools.");
  return issues;
}

export function validateChallengeSandboxRunRequest(request: ChallengeSandboxRunRequest): string[] {
  const issues: string[] = [];
  const policy = request.policy;
  if (!request.trustedInternal) {
    issues.push(...validateUntrustedContributionSandboxPolicy(policy));
    issues.push(...validateUntrustedRunnerProfile(request.runner));
  }
  issues.push(...validateSandboxConfigForBrokerSecrets(request.config));
  issues.push(...validateAgentConnectionDelegation(request.agentConnection));
  return issues;
}
