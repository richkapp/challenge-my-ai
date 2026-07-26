import { env, type RuntimeEnv } from "@/lib/config/env";

export type CapturedErrorSummary = {
  provider: "sentry";
  captured: boolean;
  status: "queued" | "not_configured";
  errorCode: string;
  surface: string;
};

export function sentryReadiness(runtime: RuntimeEnv = env) {
  const configured = Boolean(runtime.SENTRY_DSN);
  return {
    provider: "sentry" as const,
    status: configured ? "configured" as const : "not_configured" as const,
    configured,
    dsnPresent: configured,
    delivery: configured ? "queued_via_server_shim" as const : "disabled_until_configured" as const,
  };
}

export function sentryConfigured(runtime: RuntimeEnv = env) {
  return sentryReadiness(runtime).configured;
}

export function captureError(error: unknown, context: { surface?: string; code?: string } = {}): CapturedErrorSummary {
  const readiness = sentryReadiness();
  const summary: CapturedErrorSummary = {
    provider: "sentry",
    captured: readiness.configured,
    status: readiness.configured ? "queued" : "not_configured",
    errorCode: safeErrorCode(context.code || codeFromError(error)),
    surface: safeSurface(context.surface || "server"),
  };
  if (process.env.NODE_ENV !== "test") {
    const prefix = readiness.configured ? "[sentry]" : "[sentry:not_configured]";
    console.error(prefix, summary);
  }
  return summary;
}

function codeFromError(error: unknown) {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") return (error as { code: string }).code;
  if (error instanceof Error && error.name) return error.name;
  return "unknown_error";
}

function safeErrorCode(value: string) {
  return normalizeTelemetryLabel(value) || "unknown_error";
}

function safeSurface(value: string) {
  return normalizeTelemetryLabel(value) || "server";
}

function normalizeTelemetryLabel(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9._:/-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 96);
}
