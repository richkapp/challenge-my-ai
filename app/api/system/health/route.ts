import { NextResponse } from "next/server";
import { trackEvent } from "@/lib/analytics/events";
import { env, googleAuthConfigured, missingProductionKeys, postgresConfigured, productionConfigIssues, publicRuntimeEnv, runtimeMode, supabaseConfigured, trustedAgentRunReadiness, type RuntimeEnv } from "@/lib/config/env";
import { billingReadiness } from "@/lib/billing/catalog";
import { launchHealthSnapshot } from "@/lib/observability/launchHealth";
import { productionDataReadiness } from "@/lib/operations/productionDataReadiness";

export const runtime = "nodejs";

export function buildSystemHealthSnapshot(runtimeEnv: RuntimeEnv = env) {
  const mode = runtimeMode(runtimeEnv);
  const productionData = productionDataReadiness(runtimeEnv);
  const issues = Array.from(new Set([
    ...productionConfigIssues(runtimeEnv),
    ...productionData.issues,
  ]));
  const productionReady = mode === "production" && issues.length === 0 && productionData.ok;
  const billing = billingReadiness(runtimeEnv);
  const launchHealth = launchHealthSnapshot(runtimeEnv);
  return {
    ok: mode === "production" ? productionReady : true,
    mode,
    productionReady,
    publicRuntime: publicRuntimeEnv(runtimeEnv),
    trustedAgentRun: trustedAgentRunReadiness(runtimeEnv),
    launchHealth,
    productionData,
    providers: {
      supabaseAuth: supabaseConfigured(runtimeEnv),
      supabaseAdmin: Boolean(runtimeEnv.SUPABASE_SERVICE_ROLE_KEY),
      googleAuth: googleAuthConfigured(runtimeEnv),
      postgresStore: postgresConfigured(runtimeEnv),
      signedAgentApi: Boolean(runtimeEnv.CMAI_AGENT_API_SECRET),
      billing,
      stripe: billing.stripeConfigured,
      openrouter: Boolean(runtimeEnv.OPENROUTER_API_KEY),
      posthog: launchHealth.observability.providers.posthog.configured,
      sentry: launchHealth.observability.providers.sentry.configured,
      langfuse: launchHealth.observability.providers.langfuse.configured,
    },
    missingProductionKeys: missingProductionKeys(runtimeEnv),
    productionConfigIssues: issues,
  };
}

export async function GET() {
  const body = buildSystemHealthSnapshot(env);
  trackEvent("launch_health_checked", {
    health_area: "system_health",
    observability_provider: body.launchHealth.observability.status,
    delivery_status: body.launchHealth.status,
    diagnostic_status: body.launchHealth.status,
  });
  return NextResponse.json(body, { status: body.ok ? 200 : 503 });
}
