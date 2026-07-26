import { describe, expect, it } from "vitest";
import { trackEvent } from "@/lib/analytics/events";
import { emitPosthogEvent, posthogReadiness } from "@/lib/analytics/posthog";
import { env } from "@/lib/config/env";
import { observabilityReadiness } from "@/lib/observability/config";
import { langfuseReadiness, recordLlmTrace } from "@/lib/observability/langfuse";
import { launchHealthSnapshot } from "@/lib/observability/launchHealth";
import { captureError, sentryReadiness } from "@/lib/observability/sentry";

const configuredRuntime = {
  ...env,
  NEXT_PUBLIC_POSTHOG_KEY: "ph_test_key",
  NEXT_PUBLIC_POSTHOG_HOST: "https://eu.posthog.example/path/ignored",
  SENTRY_DSN: "https://public@sentry.example/1",
  LANGFUSE_PUBLIC_KEY: "pk-lf",
  LANGFUSE_SECRET_KEY: "sk-lf",
};

describe("observability readiness and redacted delivery", () => {
  it("reports missing providers without leaking secret values", () => {
    const readiness = observabilityReadiness({ ...env, NEXT_PUBLIC_POSTHOG_KEY: "", SENTRY_DSN: "", LANGFUSE_PUBLIC_KEY: "", LANGFUSE_SECRET_KEY: "" });

    expect(readiness.status).toBe("not_configured");
    expect(readiness.missingProviders).toEqual(expect.arrayContaining(["posthog", "sentry", "langfuse"]));
    expect(JSON.stringify(readiness)).not.toContain("sk-");
    expect(readiness.redaction).toMatchObject({ rawPrompts: false, rawTranscripts: false, rawCredentials: false, rawProviderSecrets: false });
  });

  it("reports configured PostHog/Sentry/Langfuse using booleans and safe host labels only", () => {
    expect(posthogReadiness(configuredRuntime)).toMatchObject({ configured: true, keyPresent: true, host: "https://eu.posthog.example" });
    expect(sentryReadiness(configuredRuntime)).toMatchObject({ configured: true, dsnPresent: true });
    expect(langfuseReadiness(configuredRuntime)).toMatchObject({ configured: true, publicKeyPresent: true, secretKeyPresent: true });
    expect(JSON.stringify(observabilityReadiness(configuredRuntime))).not.toContain("sk-lf");
    expect(JSON.stringify(observabilityReadiness(configuredRuntime))).not.toContain("ph_test_key");
  });

  it("drops unsafe telemetry delivery payloads and keeps analytics allowlists content-free", () => {
    const safe = emitPosthogEvent(trackEvent("launch_health_checked", {
      health_area: "system_health",
      observability_provider: "posthog",
      delivery_status: "queued",
      diagnostic_status: "ready",
      raw_prompt: "secret prompt text",
    }), configuredRuntime);
    expect(safe).toMatchObject({ provider: "posthog", delivered: true, status: "queued" });

    const unsafe = emitPosthogEvent({ event: "bad_event", properties: { prompt_text: "do not send" } }, configuredRuntime);
    expect(unsafe).toMatchObject({ provider: "posthog", delivered: false, status: "dropped" });
  });

  it("captures server errors and LLM traces as redacted summaries only", () => {
    const captured = captureError(new Error("raw stack has customer text"), { surface: "api/test surface", code: "Synthesis Failed" });
    expect(captured).toMatchObject({ provider: "sentry", captured: false, status: "not_configured", errorCode: "synthesis_failed", surface: "api/test_surface" });

    const trace = recordLlmTrace({ traceKind: "synthesis", status: "failed", challengeId: "challenge-1", failureCode: "provider_timeout", provider: "openrouter" });
    expect(trace.event).toMatchObject({
      event: "llm_trace_recorded",
      properties: {
        challenge_id: "challenge-1",
        llm_trace_kind: "synthesis",
        llm_trace_status: "failed",
        trusted_provider: "openrouter",
        trusted_failure_code: "provider_timeout",
      },
    });
    expect(JSON.stringify(trace)).not.toContain("raw stack");
    expect(JSON.stringify(trace)).not.toContain("customer text");
  });

  it("builds an operator launch-health checklist across launch areas", () => {
    const snapshot = launchHealthSnapshot({ ...env, NEXT_PUBLIC_POSTHOG_KEY: "", SENTRY_DSN: "", LANGFUSE_PUBLIC_KEY: "", LANGFUSE_SECRET_KEY: "" });
    expect(snapshot.privacy).toMatchObject({ rawPrompts: false, rawChallengeBodies: false, rawTranscripts: false, rawCredentials: false, contentPropertiesAllowed: false });
    expect(snapshot.checks.map((check) => check.area)).toEqual(expect.arrayContaining(["analytics", "errors", "llm_traces", "funnel", "synthesis", "trusted_runs", "billing", "moderation", "support"]));
    expect(snapshot.checks.every((check) => check.redacted)).toBe(true);
  });
});
