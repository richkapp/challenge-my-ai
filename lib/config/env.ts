import { z } from "zod";
import { billingReadiness } from "@/lib/billing/catalog";
import { APPROVED_UNTRUSTED_RUNNER_CHECKPOINT } from "@/lib/sandbox/policy";

const adapterModeSchema = z.enum(["local", "supabase", "test"]);
const storeDriverSchema = z.enum(["local", "postgres"]);
const agentBrokerVaultModeSchema = z.enum(["memory", "env", "external"]);
const modelProxyGrantStoreSchema = z.enum(["memory", "broker_state"]);
const railwaySandboxAuthModeSchema = z.enum(["api_token", "oauth_refresh"]);

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  VERCEL_ENV: z.string().optional().default(""),
  CMAI_RUNTIME_ENV: z.enum(["local", "preview", "production", "test"]).optional(),
  CMAI_AUTH_MODE: adapterModeSchema.optional(),
  CMAI_STORE_DRIVER: storeDriverSchema.optional(),
  CMAI_ENABLE_DEMO_AUTH: z.string().optional().default(""),
  CMAI_GOOGLE_AUTH_ENABLED: z.string().optional().default(""),
  CMAI_AGENT_API_SECRET: z.string().optional().default(""),
  CMAI_VERCEL_PROJECT_LINKED: z.string().optional().default(""),
  CMAI_AGENT_BROKER_VAULT_MODE: agentBrokerVaultModeSchema.optional(),
  CMAI_AGENT_BROKER_VAULT_SECRET: z.string().optional().default(""),
  CMAI_AGENT_BROKER_VAULT_URL: z.string().optional().default(""),
  CMAI_MODEL_PROXY_URL: z.string().optional().default(""),
  CMAI_MODEL_PROXY_GRANT_STORE: modelProxyGrantStoreSchema.optional(),
  CMAI_RECEIPT_SIGNING_KEY_ID: z.string().optional().default(""),
  CMAI_RECEIPT_SIGNING_SECRET: z.string().optional().default(""),
  RAILWAY_API_TOKEN: z.string().optional().default(""),
  RAILWAY_ENVIRONMENT_ID: z.string().optional().default(""),
  RAILWAY_SANDBOX_CHECKPOINT: z.string().optional().default(""),
  RAILWAY_SANDBOX_AUTH_MODE: railwaySandboxAuthModeSchema.optional(),
  RAILWAY_OAUTH_REFRESH_TOKEN: z.string().optional().default(""),
  RAILWAY_OAUTH_CLIENT_ID: z.string().optional().default(""),
  RAILWAY_OAUTH_CLIENT_SECRET: z.string().optional().default(""),
  RAILWAY_OAUTH_TOKEN_URL: z.string().optional().default(""),
  DATABASE_URL: z.string().optional().default(""),
  NEXT_PUBLIC_APP_URL: z.string().optional().default("http://localhost:3000"),
  NEXT_PUBLIC_SUPABASE_URL: z.string().optional().default(""),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().optional().default(""),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().default(""),
  OPENROUTER_API_KEY: z.string().optional().default(""),
  OPENROUTER_MODEL: z.string().optional().default("openai/gpt-4.1-mini"),
  STRIPE_SECRET_KEY: z.string().optional().default(""),
  STRIPE_PRICE_PLUS: z.string().optional().default(""),
  STRIPE_PRICE_PRIVATE_CHALLENGE: z.string().optional().default(""),
  STRIPE_PRICE_DEEP_CHALLENGE: z.string().optional().default(""),
  STRIPE_PRICE_ONE_OFF_REVIEW: z.string().optional().default(""),
  NEXT_PUBLIC_POSTHOG_KEY: z.string().optional().default(""),
  NEXT_PUBLIC_POSTHOG_HOST: z.string().optional().default("https://us.i.posthog.com"),
  SENTRY_DSN: z.string().optional().default(""),
  LANGFUSE_PUBLIC_KEY: z.string().optional().default(""),
  LANGFUSE_SECRET_KEY: z.string().optional().default(""),
  TRIGGER_SECRET_KEY: z.string().optional().default(""),
});

export type RuntimeEnv = z.infer<typeof envSchema>;
export type AuthMode = z.infer<typeof adapterModeSchema>;
export type StoreDriver = z.infer<typeof storeDriverSchema>;
export type AgentBrokerVaultMode = z.infer<typeof agentBrokerVaultModeSchema>;
export type ModelProxyGrantStore = z.infer<typeof modelProxyGrantStoreSchema>;
export type RailwaySandboxAuthMode = z.infer<typeof railwaySandboxAuthModeSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): RuntimeEnv {
  return envSchema.parse(source);
}

export const env = loadEnv();

export function runtimeMode(runtime: RuntimeEnv = env) {
  if (runtime.CMAI_RUNTIME_ENV) return runtime.CMAI_RUNTIME_ENV;
  if (isTestLike(runtime)) return "test";
  if (runtime.VERCEL_ENV === "preview") return "preview";
  if (runtime.NODE_ENV === "production" || runtime.VERCEL_ENV === "production") return "production";
  return "local";
}

export function isProductionLike(runtime: RuntimeEnv = env) {
  return runtimeMode(runtime) === "production";
}

export function isTestLike(runtime: RuntimeEnv = env) {
  return runtime.NODE_ENV === "test" || runtime.CMAI_RUNTIME_ENV === "test";
}

export function authMode(runtime: RuntimeEnv = env): AuthMode {
  if (runtime.CMAI_AUTH_MODE) return runtime.CMAI_AUTH_MODE;
  if (isTestLike(runtime)) return "test";
  if (isProductionLike(runtime)) return "supabase";
  return "local";
}

export function storeDriver(runtime: RuntimeEnv = env): StoreDriver {
  if (runtime.CMAI_STORE_DRIVER) return runtime.CMAI_STORE_DRIVER;
  if (isProductionLike(runtime)) return "postgres";
  return "local";
}

export function demoAuthAllowed(runtime: RuntimeEnv = env) {
  return !isProductionLike(runtime) && (isTestLike(runtime) || authMode(runtime) === "local" || runtime.CMAI_ENABLE_DEMO_AUTH === "1");
}

export function supabaseConfigured(runtime: RuntimeEnv = env) {
  return Boolean(runtime.NEXT_PUBLIC_SUPABASE_URL && runtime.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

export function googleAuthConfigured(runtime: RuntimeEnv = env) {
  const enabled = ["1", "true", "yes"].includes((runtime.CMAI_GOOGLE_AUTH_ENABLED || "").toLowerCase());
  return supabaseConfigured(runtime) && enabled;
}

export function postgresConfigured(runtime: RuntimeEnv = env) {
  return Boolean(runtime.DATABASE_URL);
}

export function agentBrokerVaultMode(runtime: RuntimeEnv = env): AgentBrokerVaultMode {
  if (runtime.CMAI_AGENT_BROKER_VAULT_MODE) return runtime.CMAI_AGENT_BROKER_VAULT_MODE;
  return isProductionLike(runtime) ? "external" : "memory";
}

export function agentBrokerVaultConfigured(runtime: RuntimeEnv = env) {
  const mode = agentBrokerVaultMode(runtime);
  if (mode === "memory") return !isProductionLike(runtime);
  if (mode === "env") return Boolean(runtime.CMAI_AGENT_BROKER_VAULT_SECRET);
  return Boolean(runtime.CMAI_AGENT_BROKER_VAULT_URL && runtime.CMAI_AGENT_BROKER_VAULT_SECRET);
}

export function agentBrokerVaultIssues(runtime: RuntimeEnv = env) {
  const mode = agentBrokerVaultMode(runtime);
  const issues: string[] = [];
  if (isProductionLike(runtime) && mode === "memory") {
    issues.push("CMAI_AGENT_BROKER_VAULT_MODE=memory is not allowed in production");
  }
  if (mode === "env" && !runtime.CMAI_AGENT_BROKER_VAULT_SECRET) {
    issues.push("CMAI_AGENT_BROKER_VAULT_SECRET is required when broker vault mode is env");
  }
  if (mode === "external" && !runtime.CMAI_AGENT_BROKER_VAULT_URL) {
    issues.push("CMAI_AGENT_BROKER_VAULT_URL is required when broker vault mode is external");
  }
  if (mode === "external" && !runtime.CMAI_AGENT_BROKER_VAULT_SECRET) {
    issues.push("CMAI_AGENT_BROKER_VAULT_SECRET is required to seal external broker vault references");
  }
  return issues;
}

export function missingProductionKeys(runtime: RuntimeEnv = env) {
  if (!isProductionLike(runtime)) return [];
  const required: Array<[string, string]> = [
    ["CMAI_RUNTIME_ENV", runtime.CMAI_RUNTIME_ENV === "production" ? runtime.CMAI_RUNTIME_ENV : ""],
    ["NEXT_PUBLIC_SUPABASE_URL", runtime.NEXT_PUBLIC_SUPABASE_URL],
    ["NEXT_PUBLIC_SUPABASE_ANON_KEY", runtime.NEXT_PUBLIC_SUPABASE_ANON_KEY],
    ["SUPABASE_SERVICE_ROLE_KEY", runtime.SUPABASE_SERVICE_ROLE_KEY],
    ["DATABASE_URL", runtime.DATABASE_URL],
    ["CMAI_AGENT_API_SECRET", runtime.CMAI_AGENT_API_SECRET],
  ];
  return required.filter(([, value]) => !value).map(([key]) => key);
}

export function productionConfigIssues(runtime: RuntimeEnv = env) {
  const issues = [...missingProductionKeys(runtime)];
  if (isProductionLike(runtime) && authMode(runtime) !== "supabase") issues.push("CMAI_AUTH_MODE must be supabase in production");
  if (isProductionLike(runtime) && storeDriver(runtime) !== "postgres") issues.push("CMAI_STORE_DRIVER must be postgres in production");
  return issues;
}

export function agentRunReceiptSigningIssues(runtime: RuntimeEnv = env) {
  if (!isProductionLike(runtime)) return [];
  const issues: string[] = [];
  if (!runtime.CMAI_RECEIPT_SIGNING_KEY_ID) issues.push("CMAI_RECEIPT_SIGNING_KEY_ID is required for production Agent run receipts");
  if (!runtime.CMAI_RECEIPT_SIGNING_SECRET) issues.push("CMAI_RECEIPT_SIGNING_SECRET is required for production Agent run receipts");
  return issues;
}

export function railwaySandboxConfigIssues(runtime: RuntimeEnv = env) {
  if (!isProductionLike(runtime)) return [];
  const issues: string[] = [];
  const authMode = railwaySandboxAuthMode(runtime);
  if (authMode === "api_token" && !runtime.RAILWAY_API_TOKEN) issues.push("RAILWAY_API_TOKEN is required for production Agent run cells");
  if (authMode === "oauth_refresh") {
    if (!runtime.RAILWAY_OAUTH_REFRESH_TOKEN) issues.push("RAILWAY_OAUTH_REFRESH_TOKEN is required for production Agent run cells when RAILWAY_SANDBOX_AUTH_MODE=oauth_refresh");
    if (!runtime.RAILWAY_OAUTH_CLIENT_ID) issues.push("RAILWAY_OAUTH_CLIENT_ID is required for production Agent run cells when RAILWAY_SANDBOX_AUTH_MODE=oauth_refresh");
  }
  if (!runtime.RAILWAY_ENVIRONMENT_ID) issues.push("RAILWAY_ENVIRONMENT_ID is required for production Agent run cells");
  if (runtime.RAILWAY_SANDBOX_CHECKPOINT && runtime.RAILWAY_SANDBOX_CHECKPOINT !== APPROVED_UNTRUSTED_RUNNER_CHECKPOINT) {
    issues.push(`RAILWAY_SANDBOX_CHECKPOINT must be the approved ${APPROVED_UNTRUSTED_RUNNER_CHECKPOINT} checkpoint for production Agent run cells`);
  }
  return issues;
}

export function railwaySandboxAuthMode(runtime: RuntimeEnv = env): RailwaySandboxAuthMode {
  return runtime.RAILWAY_SANDBOX_AUTH_MODE || "api_token";
}

export function railwaySandboxDurableAuthIssues(runtime: RuntimeEnv = env) {
  if (!isProductionLike(runtime)) return [];
  const mode = railwaySandboxAuthMode(runtime);
  if (mode === "oauth_refresh") {
    return [];
  }
  return ["RAILWAY_API_TOKEN is proof-only until a non-expiring Sandbox.create credential is verified or broker-side Railway OAuth refresh is implemented"];
}

export function modelProxyConfigIssues(runtime: RuntimeEnv = env) {
  if (!isProductionLike(runtime)) return [];
  const issues: string[] = [];
  if (!runtime.CMAI_MODEL_PROXY_URL) issues.push("CMAI_MODEL_PROXY_URL is required for production Agent model-proxy runs");
  if (modelProxyGrantStore(runtime) === "memory") issues.push("CMAI_MODEL_PROXY_GRANT_STORE=memory is not allowed in production");
  if (modelProxyGrantStore(runtime) === "broker_state" && storeDriver(runtime) !== "postgres") issues.push("CMAI_STORE_DRIVER=postgres is required for production durable model-proxy grants");
  return issues;
}

export function modelProxyGrantStore(runtime: RuntimeEnv = env): ModelProxyGrantStore {
  if (runtime.CMAI_MODEL_PROXY_GRANT_STORE) return runtime.CMAI_MODEL_PROXY_GRANT_STORE;
  return isProductionLike(runtime) ? "broker_state" : "memory";
}

export function modelProxyGrantStoreConfigured(runtime: RuntimeEnv = env) {
  const grantStore = modelProxyGrantStore(runtime);
  if (grantStore === "memory") return !isProductionLike(runtime);
  return storeDriver(runtime) === "postgres" || !isProductionLike(runtime);
}

export function trustedAgentRunConfigIssues(runtime: RuntimeEnv = env) {
  if (!isProductionLike(runtime)) return [];
  return [
    ...agentRunReceiptSigningIssues(runtime),
    ...railwaySandboxConfigIssues(runtime),
    ...railwaySandboxDurableAuthIssues(runtime),
    ...agentBrokerVaultIssues(runtime),
    ...modelProxyConfigIssues(runtime),
  ];
}

export function trustedAgentRunReadiness(runtime: RuntimeEnv = env) {
  const receiptSigningIssues = agentRunReceiptSigningIssues(runtime);
  const railwayRunCellIssues = railwaySandboxConfigIssues(runtime);
  const railwayDurableAuthIssues = railwaySandboxDurableAuthIssues(runtime);
  const brokerVaultIssues = agentBrokerVaultIssues(runtime);
  const modelProxyIssues = modelProxyConfigIssues(runtime);
  const configIssues = [
    ...receiptSigningIssues,
    ...railwayRunCellIssues,
    ...railwayDurableAuthIssues,
    ...brokerVaultIssues,
    ...modelProxyIssues,
  ];
  const productionLike = isProductionLike(runtime);
  const ready = productionLike ? configIssues.length === 0 : true;

  return {
    ready,
    status: productionLike
      ? ready ? "configured_needs_live_proof" : "launch_blocked"
      : "local_only",
    configIssues,
    components: {
      receiptSigningConfigured: receiptSigningIssues.length === 0,
      railwayRunCellsConfigured: railwayRunCellIssues.length === 0,
      railwayDurableAuthConfigured: railwayDurableAuthIssues.length === 0,
      railwaySandboxAuthMode: railwaySandboxAuthMode(runtime),
      brokerVaultConfigured: brokerVaultIssues.length === 0,
      modelProxyConfigured: modelProxyIssues.length === 0,
      modelProxyGrantStore: modelProxyGrantStore(runtime),
      modelProxyGrantStoreConfigured: modelProxyGrantStoreConfigured(runtime),
    },
    proof: {
      substrate: railwayRunCellIssues.length === 0 && railwayDurableAuthIssues.length === 0 ? (productionLike ? "configured" : "local_fake") : "unavailable",
      brokerReceipt: receiptSigningIssues.length === 0 && railwayRunCellIssues.length === 0 && railwayDurableAuthIssues.length === 0 ? (productionLike ? "configured" : "local_fake") : "unavailable",
      modelProxy: modelProxyIssues.length === 0 ? (productionLike ? "configured" : "local_fake") : "unavailable",
      providerMetadata: ready ? "requires_trusted_run" : "unavailable",
      providerSigned: "not_implemented",
    },
  };
}

export function assertProductionSafeConfig(runtime: RuntimeEnv = env) {
  const issues = productionConfigIssues(runtime);
  if (issues.length) {
    throw new Error(`Challenge My AI production configuration is incomplete: ${issues.join(", ")}`);
  }
}

export function publicRuntimeEnv(runtime: RuntimeEnv = env) {
  return {
    appUrl: runtime.NEXT_PUBLIC_APP_URL,
    supabaseUrl: runtime.NEXT_PUBLIC_SUPABASE_URL,
    supabaseAnonKeyPresent: Boolean(runtime.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    googleAuthConfigured: googleAuthConfigured(runtime),
    posthogKeyPresent: Boolean(runtime.NEXT_PUBLIC_POSTHOG_KEY),
    posthogHost: runtime.NEXT_PUBLIC_POSTHOG_HOST,
    runtimeMode: runtimeMode(runtime),
    authMode: authMode(runtime),
    storeDriver: storeDriver(runtime),
    agentBrokerVaultMode: agentBrokerVaultMode(runtime),
    agentBrokerVaultConfigured: agentBrokerVaultConfigured(runtime),
    modelProxyGrantStore: modelProxyGrantStore(runtime),
    modelProxyGrantStoreConfigured: modelProxyGrantStoreConfigured(runtime),
    modelProxyConfigured: Boolean(runtime.CMAI_MODEL_PROXY_URL),
    productionLike: isProductionLike(runtime),
    billingReadiness: billingReadiness(runtime),
    missingProductionKeys: missingProductionKeys(runtime),
  };
}
