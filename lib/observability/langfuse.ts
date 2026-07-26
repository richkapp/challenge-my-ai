import { trackEvent } from "@/lib/analytics/events";
import { env, type RuntimeEnv } from "@/lib/config/env";

export type LlmTraceKind = "synthesis" | "trusted_run" | "model_proxy" | "support_review";
export type LlmTraceStatus = "completed" | "failed" | "skipped";

export type SafeLlmTraceInput = {
  traceKind: LlmTraceKind;
  status: LlmTraceStatus;
  provider?: string;
  failureCode?: string;
  challengeId?: string;
  agentRunId?: string;
};

export function langfuseReadiness(runtime: RuntimeEnv = env) {
  const publicKeyPresent = Boolean(runtime.LANGFUSE_PUBLIC_KEY);
  const secretKeyPresent = Boolean(runtime.LANGFUSE_SECRET_KEY);
  const configured = publicKeyPresent && secretKeyPresent;
  return {
    provider: "langfuse" as const,
    status: configured ? "configured" as const : "not_configured" as const,
    configured,
    publicKeyPresent,
    secretKeyPresent,
    delivery: configured ? "queued_via_server_shim" as const : "disabled_until_configured" as const,
  };
}

export function langfuseConfigured(runtime: RuntimeEnv = env) {
  return langfuseReadiness(runtime).configured;
}

export function recordLlmTrace(input: SafeLlmTraceInput, runtime: RuntimeEnv = env) {
  const readiness = langfuseReadiness(runtime);
  const payload = trackEvent("llm_trace_recorded", {
    challenge_id: input.challengeId,
    agent_run_id: input.agentRunId,
    llm_trace_kind: input.traceKind,
    llm_trace_status: input.status,
    trusted_provider: input.provider,
    trusted_failure_code: input.failureCode,
    observability_provider: "langfuse",
    delivery_status: readiness.configured ? "queued" : "not_configured",
  });
  return {
    provider: "langfuse" as const,
    recorded: readiness.configured,
    status: readiness.configured ? "queued" as const : "not_configured" as const,
    event: payload,
  };
}
