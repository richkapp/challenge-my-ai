import { posthogReadiness } from "@/lib/analytics/posthog";
import { env, type RuntimeEnv } from "@/lib/config/env";
import { langfuseReadiness } from "@/lib/observability/langfuse";
import { sentryReadiness } from "@/lib/observability/sentry";

export function observabilityReadiness(runtime: RuntimeEnv = env) {
  const providers = {
    posthog: posthogReadiness(runtime),
    sentry: sentryReadiness(runtime),
    langfuse: langfuseReadiness(runtime),
  };
  const providerValues = Object.values(providers);
  const configuredProviders = providerValues.filter((provider) => provider.configured).map((provider) => provider.provider);
  const missingProviders = providerValues.filter((provider) => !provider.configured).map((provider) => provider.provider);
  return {
    status: configuredProviders.length === providerValues.length ? "configured" as const : configuredProviders.length > 0 ? "partial" as const : "not_configured" as const,
    configuredProviderCount: configuredProviders.length,
    configuredProviders,
    missingProviders,
    providers,
    redaction: {
      rawPrompts: false,
      rawTranscripts: false,
      rawCredentials: false,
      rawProviderSecrets: false,
    },
  };
}
