import { Buffer } from "node:buffer";
import { contributionCardSchema } from "@/lib/validation/schemas";
import { canonicalJson, type HermesReceiptSigningKey } from "@/lib/provenance/receipts";
import { CMAI_RUNNER_PATHS } from "@/lib/runner/paths";
import { executeHermesRunWithAdapter, SandboxRunPolicyError, type HermesRunBroker, type HermesRunOutcome, type HermesRunRequest, type NormalizedHermesRunRequest, type SandboxRunCellAdapter, type SandboxRunEvidence } from "@/lib/sandbox/broker";
import { APPROVED_UNTRUSTED_RUNNER_CHECKPOINT, approvedUntrustedRunnerProfile, defaultContributionSandboxPolicy, validateChallengeSandboxRunRequest } from "@/lib/sandbox/policy";
import type { SandboxNetworkIsolation } from "@/lib/types";

export const RAILWAY_SANDBOX_UNAVAILABLE = "RAILWAY_SANDBOX_UNAVAILABLE" as const;
export const RAILWAY_SANDBOX_EXECUTION_FAILED = "RAILWAY_SANDBOX_EXECUTION_FAILED" as const;
export const DEFAULT_RAILWAY_SANDBOX_CHECKPOINT = APPROVED_UNTRUSTED_RUNNER_CHECKPOINT;
export const RAILWAY_RUN_CELL_CHALLENGE_BUNDLE_LIMIT_BYTES = 64_000;
export const RAILWAY_RUN_CELL_CONFIG_LIMIT_BYTES = 32_000;

const CHALLENGE_BUNDLE_PATH = CMAI_RUNNER_PATHS.challengeInput;
const RUN_CONFIG_PATH = CMAI_RUNNER_PATHS.runConfigInput;
const OUTPUT_CARD_PATH = CMAI_RUNNER_PATHS.outputCard;
const TRANSCRIPT_PATH = CMAI_RUNNER_PATHS.transcript;

export class RailwaySandboxUnavailableError extends Error {
  readonly code = RAILWAY_SANDBOX_UNAVAILABLE;

  constructor(message = "Railway Sandbox SDK/API access is not configured for this environment.", options?: ErrorOptions) {
    super(message, options);
  }
}

export class RailwaySandboxExecutionError extends Error {
  readonly code = RAILWAY_SANDBOX_EXECUTION_FAILED;

  constructor(message: string, readonly details: Record<string, unknown> = {}, options?: ErrorOptions) {
    super(message, options);
  }
}

export type RailwaySandboxBrokerConfig = {
  token?: string;
  tokenProvider?: () => Promise<string>;
  environmentId?: string;
  checkpoint?: string;
  networkIsolation?: SandboxNetworkIsolation;
  idleTimeoutMinutes?: number;
  sdk?: RailwaySandboxSdk;
};

export type NormalizedRailwaySandboxBrokerConfig = Required<Pick<RailwaySandboxBrokerConfig, "checkpoint" | "networkIsolation" | "idleTimeoutMinutes">> & {
  token?: string;
  tokenProvider?: () => Promise<string>;
  environmentId?: string;
  sdk: RailwaySandboxSdk;
};

export type RailwaySandboxExecResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated?: boolean;
  timedOut?: boolean;
};

export type RailwaySandboxHandle = {
  id: string;
  networkIsolation?: SandboxNetworkIsolation;
  files: {
    write(path: string, data: string, options?: { mode?: number }): Promise<void>;
    read(path: string, options?: { format?: "text" }): Promise<string>;
  };
  exec(command: string, options?: { timeoutSec?: number; cwd?: string; env?: Record<string, string> }): Promise<RailwaySandboxExecResult>;
  destroy(): Promise<void>;
};

export type RailwaySandboxCreateOptions = {
  token: string;
  environmentId: string;
  networkIsolation: SandboxNetworkIsolation;
  idleTimeoutMinutes: number;
  env?: Record<string, string>;
};

export type RailwaySandboxSdk = {
  create(checkpoint: string, options: RailwaySandboxCreateOptions): Promise<RailwaySandboxHandle>;
};

const defaultRailwaySandboxSdk: RailwaySandboxSdk = {
  async create(checkpoint, options) {
    const { Sandbox } = await import("railway");
    return Sandbox.create(checkpoint, options);
  },
};

export function normalizeRailwaySandboxBrokerConfig(config: RailwaySandboxBrokerConfig = {}): NormalizedRailwaySandboxBrokerConfig {
  return {
    token: config.token,
    tokenProvider: config.tokenProvider,
    environmentId: config.environmentId,
    checkpoint: config.checkpoint || DEFAULT_RAILWAY_SANDBOX_CHECKPOINT,
    networkIsolation: config.networkIsolation || "ISOLATED",
    idleTimeoutMinutes: config.idleTimeoutMinutes ?? 5,
    sdk: config.sdk || defaultRailwaySandboxSdk,
  };
}

export function validateRailwaySandboxBrokerConfig(config: RailwaySandboxBrokerConfig = {}): string[] {
  const normalized = normalizeRailwaySandboxBrokerConfig(config);
  const issues: string[] = [];
  if (normalized.networkIsolation !== "ISOLATED" && normalized.networkIsolation !== "PRIVATE") issues.push("Railway sandbox network isolation must be ISOLATED or PRIVATE.");
  if (normalized.networkIsolation !== "ISOLATED") issues.push("Untrusted Railway contribution sandboxes must default to ISOLATED networking.");
  if (normalized.checkpoint !== DEFAULT_RAILWAY_SANDBOX_CHECKPOINT) issues.push("Untrusted Railway contribution sandboxes must use the approved CMAI Hermes runner checkpoint.");
  if (normalized.idleTimeoutMinutes > 5) issues.push("Railway sandbox idle timeout must stay at or below 5 minutes for Trial/Free-compatible contribution runs.");
  return issues;
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function railwayErrorLooksLikeSandboxAccessBlocker(error: unknown): boolean {
  const message = stringifyError(error).toLowerCase();
  return [
    "project_sandboxes",
    "priority boarding",
    "sandboxes are not enabled",
    "sandboxes must be enabled",
    "feature is not enabled",
    "not enabled for this workspace",
  ].some((needle) => message.includes(needle));
}

function railwayErrorLooksLikeAuthBlocker(error: unknown): boolean {
  const message = stringifyError(error).toLowerCase();
  return ["not authenticated", "unauthorized", "railway_api_token", "api token", "auth"].some((needle) => message.includes(needle));
}

function railwayErrorLooksLikeCheckpointOrTemplateBlocker(error: unknown): boolean {
  const message = stringifyError(error).toLowerCase();
  return [
    "checkpoint not found",
    "checkpoint does not exist",
    "no such checkpoint",
    "template not found",
    "template does not exist",
    "sandbox template",
    "snapshot not found",
    "image not found",
    "cmai-hermes-runner",
  ].some((needle) => message.includes(needle));
}

function normalizeRailwaySdkError(error: unknown): Error {
  if (error instanceof RailwaySandboxUnavailableError || error instanceof RailwaySandboxExecutionError || error instanceof SandboxRunPolicyError) return error;
  if (railwayErrorLooksLikeSandboxAccessBlocker(error)) {
    return new RailwaySandboxUnavailableError("Railway Sandboxes are not enabled for this workspace. Enable Sandboxes through Railway Priority Boarding, then retry the live smoke.", { cause: error });
  }
  if (railwayErrorLooksLikeCheckpointOrTemplateBlocker(error)) {
    return new RailwaySandboxUnavailableError("Railway sandbox checkpoint/template is not available for this environment. Build or select the approved CMAI Hermes runner checkpoint, then retry the live smoke.", { cause: error });
  }
  if (railwayErrorLooksLikeAuthBlocker(error)) {
    return new RailwaySandboxUnavailableError("Railway SDK authentication failed. Set RAILWAY_API_TOKEN and RAILWAY_ENVIRONMENT_ID for the live sandbox smoke.", { cause: error });
  }
  return error instanceof Error ? error : new Error(stringifyError(error));
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function ensureTextLimit(label: string, text: string, limit: number, kind: "input" | "output"): void {
  const actualBytes = byteLength(text);
  if (actualBytes > limit) {
    throw new RailwaySandboxExecutionError(`Railway sandbox ${label} exceeded ${kind} capture limit.`, { label, limit, actualBytes });
  }
}

function ensureOutputLimit(label: string, text: string, limit: number): void {
  ensureTextLimit(label, text, limit, "output");
}

function serializeRunCellInput(label: string, value: unknown, limit: number): string {
  let text: string;
  try {
    text = `${canonicalJson(value)}\n`;
  } catch (error) {
    throw new RailwaySandboxExecutionError(`Railway sandbox ${label} could not be serialized for the run cell.`, { label }, { cause: error });
  }
  ensureTextLimit(label, text, limit, "input");
  return text;
}

function serializeRunCellInputs(request: NormalizedHermesRunRequest): { challengeBundle: string; runConfig: string } {
  return {
    challengeBundle: serializeRunCellInput("challenge bundle", request.challengeBundle, RAILWAY_RUN_CELL_CHALLENGE_BUNDLE_LIMIT_BYTES),
    runConfig: serializeRunCellInput("run config", buildBoundedRunConfig(request), RAILWAY_RUN_CELL_CONFIG_LIMIT_BYTES),
  };
}

async function readRequiredArtifact(sandbox: RailwaySandboxHandle, path: string, label: string, limit: number): Promise<string> {
  let text: string;
  try {
    text = await sandbox.files.read(path, { format: "text" });
  } catch (error) {
    throw new RailwaySandboxExecutionError(`Railway sandbox did not produce required ${label} artifact.`, { path }, { cause: error });
  }
  ensureOutputLimit(label, text, limit);
  return text;
}

function parseContributionCardArtifact(cardText: string): SandboxRunEvidence["card"] {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(cardText);
  } catch (error) {
    throw new RailwaySandboxExecutionError("Railway sandbox output card was not valid JSON.", {}, { cause: error });
  }

  const parsed = contributionCardSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new RailwaySandboxExecutionError("Railway sandbox output card failed strict CMAI_CONTRIBUTION_CARD_V1 validation.", { issues: parsed.error.issues });
  }
  return parsed.data;
}

function buildBoundedRunConfig(request: NormalizedHermesRunRequest): Record<string, unknown> {
  return {
    schema_version: "1.0",
    run_id: request.runId,
    challenge_id: request.challengeId,
    contributor_id: request.contributorId,
    contribution_mode: request.contributionMode,
    provider: request.provider,
    requested_model: request.requestedModel,
    returned_model: request.returnedModel,
    model_display_name: request.modelDisplayName,
    provider_response_id: request.providerResponseId,
    funding_source: request.fundingSource,
    agent_connection: request.agentConnection ? {
      connection_id: request.agentConnection.connection_id,
      agent_connection_id: request.agentConnection.agent_connection_id,
      delegation_id: request.agentConnection.delegation_id,
      provider: request.agentConnection.provider,
      allowed_model: request.agentConnection.allowed_model,
      allowed_request_class: request.agentConnection.allowed_request_class,
      expires_at: request.agentConnection.expires_at,
      max_spend_cents: request.agentConnection.max_spend_cents,
      max_requests: request.agentConnection.max_requests,
    } : undefined,
    child_run_config: request.childRunConfig,
    substrate_smoke_only: request.config && typeof request.config === "object" && (request.config as Record<string, unknown>).substrate_smoke_only === true ? true : undefined,
    runner: approvedUntrustedRunnerProfile,
    policy: {
      network_isolation: "ISOLATED",
      idle_timeout_minutes: request.policy.idleTimeoutMinutes,
      command_timeout_seconds: request.policy.commandTimeoutSeconds,
      output_limit_bytes: request.policy.outputLimitBytes,
      destroy_on_completion: true,
      secrets: "none",
    },
    input_paths: {
      challenge_bundle: CHALLENGE_BUNDLE_PATH,
      run_config: RUN_CONFIG_PATH,
    },
    output_paths: {
      contribution_card: OUTPUT_CARD_PATH,
      transcript: TRANSCRIPT_PATH,
    },
  };
}

export function createRailwaySandboxCellAdapter(config: NormalizedRailwaySandboxBrokerConfig): SandboxRunCellAdapter {
  return {
    name: "railway-sandbox-broker",
    sandboxProvider: "railway",
    async run(request: NormalizedHermesRunRequest): Promise<SandboxRunEvidence> {
      if (!config.environmentId) throw new RailwaySandboxUnavailableError("Railway sandbox environment id is not configured.");
      const token = config.token || await config.tokenProvider?.();
      if (!token) throw new RailwaySandboxUnavailableError("Railway API token is not configured. Set RAILWAY_API_TOKEN or Railway OAuth refresh config for live Railway sandbox execution.");

      const runCellInputs = serializeRunCellInputs(request);

      const startedAt = new Date().toISOString();
      let sandbox: RailwaySandboxHandle | undefined;
      let teardownCompleted = false;
      let teardownError: string | undefined;

      try {
        sandbox = await config.sdk.create(config.checkpoint, {
          token,
          environmentId: config.environmentId,
          networkIsolation: "ISOLATED",
          idleTimeoutMinutes: config.idleTimeoutMinutes,
        });

        await sandbox.files.write(CHALLENGE_BUNDLE_PATH, runCellInputs.challengeBundle, { mode: 0o644 });
        await sandbox.files.write(RUN_CONFIG_PATH, runCellInputs.runConfig, { mode: 0o644 });

        const execResult = await sandbox.exec(approvedUntrustedRunnerProfile.command, {
          timeoutSec: request.policy.commandTimeoutSeconds,
        });

        ensureOutputLimit("stdout", execResult.stdout || "", request.policy.outputLimitBytes);
        ensureOutputLimit("stderr", execResult.stderr || "", request.policy.outputLimitBytes);

        if (execResult.timedOut) {
          throw new RailwaySandboxExecutionError("Railway sandbox runner timed out before producing a trusted contribution card.", { stdout: execResult.stdout, stderr: execResult.stderr });
        }
        if (execResult.truncated) {
          throw new RailwaySandboxExecutionError("Railway sandbox runner output was truncated before validation.", { stdout: execResult.stdout, stderr: execResult.stderr });
        }
        if (execResult.exitCode !== 0) {
          throw new RailwaySandboxExecutionError("Railway sandbox runner exited non-zero before producing a trusted contribution card.", { exitCode: execResult.exitCode, stdout: execResult.stdout, stderr: execResult.stderr });
        }

        const cardText = await readRequiredArtifact(sandbox, OUTPUT_CARD_PATH, "contribution card", request.policy.outputLimitBytes);
        const transcript = await readRequiredArtifact(sandbox, TRANSCRIPT_PATH, "transcript", request.policy.outputLimitBytes);

        try {
          await sandbox.destroy();
          teardownCompleted = true;
        } catch (error) {
          teardownError = stringifyError(error);
        }

        const completedAt = new Date().toISOString();
        return {
          card: parseContributionCardArtifact(cardText),
          transcript,
          stdout: execResult.stdout || "",
          stderr: execResult.stderr || "",
          sandboxId: sandbox.id,
          sandboxProvider: "railway",
          teardownCompleted,
          teardownError,
          startedAt,
          completedAt,
          durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(startedAt)),
        };
      } catch (error) {
        if (sandbox && !teardownCompleted) {
          try {
            await sandbox.destroy();
          } catch (destroyError) {
            if (error instanceof RailwaySandboxExecutionError) {
              error.details.destroy_error = stringifyError(destroyError);
            }
          }
        }
        throw normalizeRailwaySdkError(error);
      }
    },
  };
}

export function createRailwaySandboxBroker(config: RailwaySandboxBrokerConfig, signingKey: HermesReceiptSigningKey): HermesRunBroker {
  const normalizedConfig = normalizeRailwaySandboxBrokerConfig(config);
  const adapter = createRailwaySandboxCellAdapter(normalizedConfig);

  return {
    async run(request: HermesRunRequest): Promise<HermesRunOutcome> {
      const policy = defaultContributionSandboxPolicy({
        network: normalizedConfig.networkIsolation === "PRIVATE" ? "private" : "isolated",
        idleTimeoutMinutes: normalizedConfig.idleTimeoutMinutes,
      });
      const issues = [
        ...validateRailwaySandboxBrokerConfig(config),
        ...validateChallengeSandboxRunRequest({
          challengeId: request.challengeId,
          contributionMode: request.contributionMode,
          adapter: "railway_sandbox",
          policy,
          trustedInternal: request.trustedInternal,
          agentConnection: request.agentConnection,
          runner: request.runner || {
            profile: approvedUntrustedRunnerProfile.profile,
            checkpoint: normalizedConfig.checkpoint,
            command: approvedUntrustedRunnerProfile.command,
          },
          config: request.config,
        }),
      ];
      if (issues.length > 0) throw new SandboxRunPolicyError(issues);
      return executeHermesRunWithAdapter(adapter, { ...request, policy }, signingKey);
    },
  };
}
