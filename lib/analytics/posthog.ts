import { env, type RuntimeEnv } from "@/lib/config/env";

type AnalyticsPayload = {
  event: string;
  properties: Record<string, unknown>;
};

export type ObservabilityDeliveryStatus = "queued" | "not_configured" | "dropped";

export type ObservabilityDeliveryResult = {
  provider: "posthog";
  delivered: boolean;
  status: ObservabilityDeliveryStatus;
  reason?: string;
};

export function posthogReadiness(runtime: RuntimeEnv = env) {
  const keyPresent = Boolean(runtime.NEXT_PUBLIC_POSTHOG_KEY);
  const host = safeTelemetryHost(runtime.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com");
  return {
    provider: "posthog" as const,
    status: keyPresent ? "configured" as const : "not_configured" as const,
    configured: keyPresent,
    keyPresent,
    host,
    delivery: keyPresent ? "queued_via_server_shim" as const : "disabled_until_configured" as const,
  };
}

export function posthogConfigured(runtime: RuntimeEnv = env) {
  return posthogReadiness(runtime).configured;
}

export function emitPosthogEvent(payload: AnalyticsPayload, runtime: RuntimeEnv = env): ObservabilityDeliveryResult {
  const readiness = posthogReadiness(runtime);
  if (!readiness.configured) {
    return { provider: "posthog", delivered: false, status: "not_configured", reason: "NEXT_PUBLIC_POSTHOG_KEY is not configured" };
  }
  if (!payload.event || Object.keys(payload.properties || {}).some((key) => forbiddenDeliveryKeyPattern.test(key))) {
    return { provider: "posthog", delivered: false, status: "dropped", reason: "payload failed telemetry delivery safety checks" };
  }
  if (process.env.NODE_ENV !== "test") {
    console.info(`[posthog:${payload.event}]`, payload.properties);
  }
  return { provider: "posthog", delivered: true, status: "queued" };
}

export function safeTelemetryHost(value: string) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "invalid_host";
  }
}

const forbiddenDeliveryKeyPattern = /(?:prompt|answer|problem|context|raw|transcript|secret|token|credential|api[_-]?key|password|email|name|title|url|link|body|message|text|card[_-]?json|model[_-]?output)/i;
