import { launchMetricDefinitions } from "@/lib/analytics/events";
import { billingReadiness } from "@/lib/billing/catalog";
import { env, publicRuntimeEnv, trustedAgentRunReadiness, type RuntimeEnv } from "@/lib/config/env";
import { observabilityReadiness } from "@/lib/observability/config";

export type LaunchHealthArea =
  | "analytics"
  | "errors"
  | "llm_traces"
  | "funnel"
  | "synthesis"
  | "trusted_runs"
  | "billing"
  | "moderation"
  | "support";

export type LaunchHealthStatus = "ready" | "watch" | "blocked";

export type LaunchHealthCheck = {
  area: LaunchHealthArea;
  status: LaunchHealthStatus;
  question: string;
  signal: string;
  redacted: boolean;
};

export function launchHealthSnapshot(runtime: RuntimeEnv = env) {
  const observability = observabilityReadiness(runtime);
  const publicRuntime = publicRuntimeEnv(runtime);
  const trustedRun = trustedAgentRunReadiness(runtime);
  const billing = billingReadiness(runtime);
  const checks: LaunchHealthCheck[] = [
    {
      area: "analytics",
      status: observability.providers.posthog.configured ? "ready" : "watch",
      question: launchMetricDefinitions.first_challenge_completion.weeklyReviewQuestion,
      signal: observability.providers.posthog.configured ? "PostHog key present; events can queue through the server shim." : "PostHog key missing; event payloads still sanitize locally and delivery is skipped.",
      redacted: true,
    },
    {
      area: "errors",
      status: observability.providers.sentry.configured ? "ready" : "watch",
      question: "Can operators see server/API failures without raw request bodies?",
      signal: observability.providers.sentry.configured ? "Sentry DSN present; error summaries can queue through the server shim." : "Sentry DSN missing; captureError returns redacted local summaries only.",
      redacted: true,
    },
    {
      area: "llm_traces",
      status: observability.providers.langfuse.configured ? "ready" : "watch",
      question: "Can synthesis and trusted-run traces be inspected without prompts or transcripts?",
      signal: observability.providers.langfuse.configured ? "Langfuse public/secret keys present; trace summaries can queue." : "Langfuse keys missing; trace summaries still emit sanitized analytics events.",
      redacted: true,
    },
    {
      area: "funnel",
      status: "ready",
      question: launchMetricDefinitions.first_challenge_completion.weeklyReviewQuestion,
      signal: launchMetricDefinitions.first_challenge_completion.dashboardQueryPlan,
      redacted: true,
    },
    {
      area: "synthesis",
      status: "ready",
      question: launchMetricDefinitions.archive_search_reuse.weeklyReviewQuestion,
      signal: "Synthesis success/failure events use IDs, status, buckets, and failure codes only.",
      redacted: true,
    },
    {
      area: "trusted_runs",
      status: trustedRun.ready ? "ready" : "blocked",
      question: launchMetricDefinitions.trusted_run_health.weeklyReviewQuestion,
      signal: trustedRun.status,
      redacted: true,
    },
    {
      area: "billing",
      status: billing.readyForCheckout ? "ready" : "watch",
      question: launchMetricDefinitions.paid_power_user_intent.weeklyReviewQuestion,
      signal: billing.status,
      redacted: true,
    },
    {
      area: "moderation",
      status: "ready",
      question: launchMetricDefinitions.moderation_load.weeklyReviewQuestion,
      signal: launchMetricDefinitions.moderation_load.dashboardQueryPlan,
      redacted: true,
    },
    {
      area: "support",
      status: "ready",
      question: "Which beta feedback buckets need operator response before launch?",
      signal: "support_feedback_captured splits bug, bad synthesis, confusing UX, safety, contribution-quality, paid intent, and trusted-lane readiness without raw support text.",
      redacted: true,
    },
  ];
  return {
    status: checks.some((check) => check.status === "blocked") ? "blocked" as const : checks.some((check) => check.status === "watch") ? "watch" as const : "ready" as const,
    mode: publicRuntime.runtimeMode,
    observability,
    checks,
    privacy: {
      rawPrompts: false,
      rawChallengeBodies: false,
      rawTranscripts: false,
      rawCredentials: false,
      contentPropertiesAllowed: false,
    },
  };
}
