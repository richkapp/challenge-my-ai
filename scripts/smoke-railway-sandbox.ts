import { pathToFileURL } from "node:url";
import { MODEL_PROXY_RESPONSE_EVENT } from "../lib/runner/modelProxyContributionRunner";
import { SandboxRunPolicyError, type HermesRunBroker, type HermesRunOutcome, type HermesRunRequest } from "../lib/sandbox/broker";
import { createRailwaySandboxBroker, DEFAULT_RAILWAY_SANDBOX_CHECKPOINT, RAILWAY_SANDBOX_UNAVAILABLE, RailwaySandboxExecutionError, RailwaySandboxUnavailableError } from "../lib/sandbox/railwayBroker";

export const RAILWAY_SMOKE_UNAVAILABLE_EXIT_CODE = 78;

export type RailwaySmokeEnv = Record<string, string | undefined>;
export type RailwaySmokeLogger = (line: string) => void;
export type RailwaySmokeCheckpointSource = "default" | "canonical_env" | "legacy_env";
export type RailwaySmokeCheckpointStatus = "approved" | "unsupported";
export const RAILWAY_SANDBOX_CHECKPOINT_ENV = "RAILWAY_SANDBOX_CHECKPOINT";
export const LEGACY_RAILWAY_SANDBOX_CHECKPOINT_ENV = "CMAI_RAILWAY_SANDBOX_CHECKPOINT";
export const RAILWAY_SMOKE_PROXY_MODE_ENV = "CMAI_RAILWAY_SMOKE_PROXY";
export const RAILWAY_SMOKE_MODEL_PROXY_URL_ENV = "CMAI_MODEL_PROXY_URL";
export type RailwaySmokeCheckpointEnvKey = typeof RAILWAY_SANDBOX_CHECKPOINT_ENV | typeof LEGACY_RAILWAY_SANDBOX_CHECKPOINT_ENV;
export type RailwaySmokeCheckpointSelection = {
  checkpoint: string;
  source: RailwaySmokeCheckpointSource;
  envKey?: RailwaySmokeCheckpointEnvKey;
  status: RailwaySmokeCheckpointStatus;
};
export type RailwaySmokePreflight = {
  ok: boolean;
  reason?: string;
  config: {
    api_token: "present" | "missing";
    environment_id: "present" | "missing";
    checkpoint: RailwaySmokeCheckpointStatus;
    checkpoint_source: RailwaySmokeCheckpointSource;
    checkpoint_env_key?: RailwaySmokeCheckpointEnvKey;
    network_isolation: "ISOLATED";
  };
};
export type RailwaySmokeBrokerFactory = (args: {
  token: string;
  environmentId: string;
  checkpoint: string;
}) => HermesRunBroker;
export type RailwaySmokeRunnerProxyStatus = "unconfigured" | "configured_unverified" | "verified";

function defaultBrokerFactory({ token, environmentId, checkpoint }: { token: string; environmentId: string; checkpoint: string }): HermesRunBroker {
  return createRailwaySandboxBroker({ token, environmentId, checkpoint }, {
    keyId: process.env.CMAI_RECEIPT_SIGNING_KEY_ID || "railway-smoke-local",
    secret: process.env.CMAI_RECEIPT_SIGNING_SECRET || "railway-smoke-local-secret",
  });
}

function checkpointStatus(checkpoint: string): RailwaySmokeCheckpointStatus {
  return checkpoint === DEFAULT_RAILWAY_SANDBOX_CHECKPOINT ? "approved" : "unsupported";
}

export function railwaySmokeCheckpoint(env: RailwaySmokeEnv): RailwaySmokeCheckpointSelection {
  if (env[RAILWAY_SANDBOX_CHECKPOINT_ENV]) {
    const checkpoint = env[RAILWAY_SANDBOX_CHECKPOINT_ENV] as string;
    return { checkpoint, source: "canonical_env", envKey: RAILWAY_SANDBOX_CHECKPOINT_ENV, status: checkpointStatus(checkpoint) };
  }
  if (env[LEGACY_RAILWAY_SANDBOX_CHECKPOINT_ENV]) {
    const checkpoint = env[LEGACY_RAILWAY_SANDBOX_CHECKPOINT_ENV] as string;
    return { checkpoint, source: "legacy_env", envKey: LEGACY_RAILWAY_SANDBOX_CHECKPOINT_ENV, status: checkpointStatus(checkpoint) };
  }
  return { checkpoint: DEFAULT_RAILWAY_SANDBOX_CHECKPOINT, source: "default", status: "approved" };
}

function unsupportedCheckpointReason(selected: RailwaySmokeCheckpointSelection): string {
  return selected.envKey ? `unsupported ${selected.envKey}` : "unsupported Railway sandbox checkpoint";
}

export function preflightRailwaySandboxSmoke(env: RailwaySmokeEnv): RailwaySmokePreflight {
  const selected = railwaySmokeCheckpoint(env);
  const config: RailwaySmokePreflight["config"] = {
    api_token: env.RAILWAY_API_TOKEN ? "present" : "missing",
    environment_id: env.RAILWAY_ENVIRONMENT_ID ? "present" : "missing",
    checkpoint: selected.status,
    checkpoint_source: selected.source,
    checkpoint_env_key: selected.envKey,
    network_isolation: "ISOLATED",
  };
  if (selected.status !== "approved") return { ok: false, reason: unsupportedCheckpointReason(selected), config };
  if (!env.RAILWAY_ENVIRONMENT_ID) return { ok: false, reason: "missing RAILWAY_ENVIRONMENT_ID", config };
  if (!env.RAILWAY_API_TOKEN) return { ok: false, reason: "missing RAILWAY_API_TOKEN", config };
  if (railwaySmokeProxyMode(env) && !railwaySmokeModelProxyUrl(env)) return { ok: false, reason: `missing ${RAILWAY_SMOKE_MODEL_PROXY_URL_ENV} for Railway proxy smoke`, config };
  return { ok: true, config };
}

export function railwaySmokeUnavailableReason(env: RailwaySmokeEnv): string | null {
  return preflightRailwaySandboxSmoke(env).reason || null;
}

export function railwaySmokeProxyMode(env: RailwaySmokeEnv): boolean {
  return ["1", "true", "yes"].includes((env[RAILWAY_SMOKE_PROXY_MODE_ENV] || "").toLowerCase());
}

function railwaySmokeModelProxyUrl(env: RailwaySmokeEnv): string | undefined {
  return env[RAILWAY_SMOKE_MODEL_PROXY_URL_ENV];
}

function buildSmokeRequest(env: RailwaySmokeEnv): HermesRunRequest {
  const modelProxyUrl = railwaySmokeProxyMode(env) ? railwaySmokeModelProxyUrl(env) : undefined;
  return {
    runId: "railway-smoke-run",
    challengeId: "railway-smoke-challenge",
    contributorId: "railway-smoke-contributor",
    contributionMode: "critique",
    challengeBundle: {
      title: "Smoke test Railway sandboxed Hermes run broker",
      original_ai_answer: "Trust the sandbox without receipt proof.",
      constraints: ["Railway ISOLATED network", "Broker signs receipts outside the sandbox", "No broker secrets in run config"],
    },
    provider: "user-provider-smoke",
    requestedModel: "user-model-smoke",
    modelDisplayName: "User model smoke",
    childRunConfig: modelProxyUrl ? {
      run_id: "railway-smoke-run",
      delegation_id: "del_railway_smoke_one_run",
      agent_connection_id: "conn_railway_smoke",
      provider: "user-provider-smoke",
      allowed_model: "user-model-smoke",
      allowed_request_class: "contribution_card",
      expires_at: "2099-06-28T01:00:00.000Z",
      max_requests: 1,
      model_proxy_url: modelProxyUrl,
    } : undefined,
    config: modelProxyUrl ? undefined : { substrate_smoke_only: true },
    agentConnection: {
      connection_id: "conn_railway_smoke",
      agent_connection_id: "conn_railway_smoke",
      delegation_id: "del_railway_smoke_one_run",
      provider: "user-provider-smoke",
      allowed_model: "user-model-smoke",
      allowed_request_class: "contribution_card",
      expires_at: "2099-06-28T01:00:00.000Z",
      max_requests: 1,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function childRunConfigFrom(request: HermesRunRequest): Record<string, unknown> | undefined {
  return isRecord(request.childRunConfig) ? request.childRunConfig : undefined;
}

function isModelProxyResponseEvent(event: unknown, expectedChildRunConfig?: Record<string, unknown>): boolean {
  if (!isRecord(event) || event.event !== MODEL_PROXY_RESPONSE_EVENT) return false;
  if (!expectedChildRunConfig) return false;
  return event.run_id === expectedChildRunConfig.run_id
    && event.delegation_id === expectedChildRunConfig.delegation_id
    && event.agent_connection_id === expectedChildRunConfig.agent_connection_id
    && event.provider === expectedChildRunConfig.provider
    && event.request_class === expectedChildRunConfig.allowed_request_class
    && event.requested_model === expectedChildRunConfig.allowed_model
    && event.remaining_requests === 0;
}

function transcriptHasModelProxyResponseEvent(transcript: HermesRunOutcome["transcript"], expectedChildRunConfig?: Record<string, unknown>): boolean {
  if (typeof transcript === "string") {
    return transcript.split(/\n+/).some((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      try {
        return isModelProxyResponseEvent(JSON.parse(trimmed), expectedChildRunConfig);
      } catch {
        return false;
      }
    });
  }
  return transcript.some((event) => isModelProxyResponseEvent(event, expectedChildRunConfig));
}

export function railwaySmokeRunnerProxyStatus(outcome: HermesRunOutcome, configured: boolean, expectedChildRunConfig?: Record<string, unknown>): RailwaySmokeRunnerProxyStatus {
  if (!configured) return "unconfigured";
  return transcriptHasModelProxyResponseEvent(outcome.transcript, expectedChildRunConfig) ? "verified" : "configured_unverified";
}

function configStatus(preflight: RailwaySmokePreflight): Record<string, unknown> {
  return {
    api_token: preflight.config.api_token,
    environment_id: preflight.config.environment_id,
    checkpoint: preflight.config.checkpoint,
    checkpoint_source: preflight.config.checkpoint_source,
    checkpoint_env_key: preflight.config.checkpoint_env_key,
    network_isolation: preflight.config.network_isolation,
  };
}

export function summarizeRailwaySmokeOutcome(outcome: HermesRunOutcome, preflight?: RailwaySmokePreflight, options: { runnerProxyConfigured?: boolean; expectedChildRunConfig?: Record<string, unknown> } = {}): Record<string, unknown> {
  const runnerProxyConfigured = options.runnerProxyConfigured ?? false;
  return {
    ok: true,
    source: outcome.card.model_provenance?.source,
    sandbox_provider: outcome.receipt.sandbox.provider,
    sandbox_id: outcome.receipt.sandbox.sandbox_id,
    network: outcome.receipt.sandbox.network_isolation,
    runner_proxy: railwaySmokeRunnerProxyStatus(outcome, runnerProxyConfigured, options.expectedChildRunConfig),
    config_status: preflight ? configStatus(preflight) : undefined,
    receipt_id: outcome.receipt.receipt_id,
    prompt_sha256: outcome.receipt.artifacts.prompt_sha256,
    output_sha256: outcome.receipt.artifacts.output_sha256,
    transcript_sha256: outcome.receipt.artifacts.transcript_sha256,
    destroyed: outcome.destroyed,
    teardown_error: outcome.receipt.sandbox.teardown_error,
  };
}

function redactRailwaySmokeText(text: string, env?: RailwaySmokeEnv): string {
  if (!env) return text;
  const rawValues = [
    env.RAILWAY_API_TOKEN,
    env.RAILWAY_ENVIRONMENT_ID,
    env[RAILWAY_SMOKE_MODEL_PROXY_URL_ENV],
    env[RAILWAY_SANDBOX_CHECKPOINT_ENV],
    env[LEGACY_RAILWAY_SANDBOX_CHECKPOINT_ENV],
  ]
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => b.length - a.length);
  return rawValues.reduce((redacted, value) => redacted.split(value).join("[redacted]"), text);
}

function unavailableNextStep(reason: string, preflight?: RailwaySmokePreflight): string {
  const lowered = reason.toLowerCase();
  if (lowered.includes("priority") || lowered.includes("sandboxes")) return "Enable Railway Sandboxes through Priority Boarding, then rerun bun run smoke:railway-sandbox.";
  if (lowered.includes("model proxy") || lowered.includes("model_proxy") || lowered.includes("cmai_model_proxy_url") || lowered.includes("proxy smoke")) return `Set ${RAILWAY_SMOKE_MODEL_PROXY_URL_ENV} to a reachable app endpoint with a matching one-run grant, then rerun ${RAILWAY_SMOKE_PROXY_MODE_ENV}=1 bun run smoke:railway-sandbox.`;
  if (lowered.includes("checkpoint")) {
    const checkpointEnv = preflight?.config.checkpoint_env_key || `${RAILWAY_SANDBOX_CHECKPOINT_ENV} / ${LEGACY_RAILWAY_SANDBOX_CHECKPOINT_ENV}`;
    return `Unset ${checkpointEnv} or set it to the approved CMAI Hermes runner checkpoint, then rerun bun run smoke:railway-sandbox.`;
  }
  return "Set RAILWAY_API_TOKEN and RAILWAY_ENVIRONMENT_ID, then rerun bun run smoke:railway-sandbox.";
}

function unavailablePayload(reason: string, preflight?: RailwaySmokePreflight, env?: RailwaySmokeEnv): Record<string, unknown> {
  const redactedReason = redactRailwaySmokeText(reason, env);
  return {
    ok: false,
    code: RAILWAY_SANDBOX_UNAVAILABLE,
    reason: redactedReason,
    config_status: preflight ? configStatus(preflight) : undefined,
    next_step: unavailableNextStep(reason, preflight),
  };
}

export async function runRailwaySandboxSmoke(options: {
  env?: RailwaySmokeEnv;
  stdout?: RailwaySmokeLogger;
  stderr?: RailwaySmokeLogger;
  brokerFactory?: RailwaySmokeBrokerFactory;
} = {}): Promise<number> {
  const env = options.env || process.env;
  const stdout = options.stdout || console.log;
  const stderr = options.stderr || console.error;
  const preflight = preflightRailwaySandboxSmoke(env);
  if (!preflight.ok) {
    stdout(JSON.stringify(unavailablePayload(preflight.reason || "Railway sandbox smoke is unavailable.", preflight, env), null, 2));
    return RAILWAY_SMOKE_UNAVAILABLE_EXIT_CODE;
  }

  const token = env.RAILWAY_API_TOKEN as string;
  const environmentId = env.RAILWAY_ENVIRONMENT_ID as string;
  const checkpoint = railwaySmokeCheckpoint(env).checkpoint;
  const brokerFactory = options.brokerFactory || defaultBrokerFactory;

  try {
    const broker = brokerFactory({ token, environmentId, checkpoint });
    const request = buildSmokeRequest(env);
    const configured = Boolean(request.childRunConfig && typeof request.childRunConfig === "object" && "model_proxy_url" in request.childRunConfig);
    const expectedChildRunConfig = childRunConfigFrom(request);
    const outcome = await broker.run(request);
    stdout(JSON.stringify(summarizeRailwaySmokeOutcome(outcome, preflight, { runnerProxyConfigured: configured, expectedChildRunConfig }), null, 2));
    return 0;
  } catch (error) {
    if (error instanceof RailwaySandboxUnavailableError) {
      stdout(JSON.stringify(unavailablePayload(error.message, preflight, env), null, 2));
      return RAILWAY_SMOKE_UNAVAILABLE_EXIT_CODE;
    }
    if (error instanceof RailwaySandboxExecutionError || error instanceof SandboxRunPolicyError) {
      stderr(JSON.stringify({ ok: false, code: error.code, reason: redactRailwaySmokeText(error.message, env) }, null, 2));
      return 1;
    }
    const reason = redactRailwaySmokeText(error instanceof Error ? error.message : String(error), env);
    stderr(JSON.stringify({ ok: false, code: "RAILWAY_SANDBOX_SMOKE_FAILED", reason }, null, 2));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const exitCode = await runRailwaySandboxSmoke();
  process.exitCode = exitCode;
}
