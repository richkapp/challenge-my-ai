import { describe, expect, it } from "vitest";
import { billingReadiness } from "@/lib/billing/catalog";
import { agentBrokerVaultConfigured, agentBrokerVaultIssues, agentBrokerVaultMode, agentRunReceiptSigningIssues, authMode, googleAuthConfigured, isProductionLike, missingProductionKeys, modelProxyConfigIssues, productionConfigIssues, publicRuntimeEnv, railwaySandboxAuthMode, railwaySandboxConfigIssues, railwaySandboxDurableAuthIssues, runtimeMode, storeDriver, trustedAgentRunConfigIssues, trustedAgentRunReadiness, type RuntimeEnv } from "@/lib/config/env";
import { APPROVED_UNTRUSTED_RUNNER_CHECKPOINT } from "@/lib/sandbox/policy";

function env(overrides: Partial<RuntimeEnv> = {}): RuntimeEnv {
  return {
    NODE_ENV: "development",
    VERCEL_ENV: "",
    CMAI_ENABLE_DEMO_AUTH: "",
    CMAI_GOOGLE_AUTH_ENABLED: "",
    CMAI_AGENT_API_SECRET: "",
    CMAI_VERCEL_PROJECT_LINKED: "",
    CMAI_AGENT_BROKER_VAULT_MODE: undefined,
    CMAI_AGENT_BROKER_VAULT_SECRET: "",
    CMAI_AGENT_BROKER_VAULT_URL: "",
    CMAI_MODEL_PROXY_URL: "",
    DATABASE_URL: "",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    NEXT_PUBLIC_SUPABASE_URL: "",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    OPENROUTER_API_KEY: "",
    OPENROUTER_MODEL: "openai/gpt-4.1-mini",
    STRIPE_SECRET_KEY: "",
    STRIPE_PRICE_PLUS: "",
    STRIPE_PRICE_PRIVATE_CHALLENGE: "",
    STRIPE_PRICE_DEEP_CHALLENGE: "",
    STRIPE_PRICE_ONE_OFF_REVIEW: "",
    NEXT_PUBLIC_POSTHOG_KEY: "",
    NEXT_PUBLIC_POSTHOG_HOST: "https://us.i.posthog.com",
    SENTRY_DSN: "",
    LANGFUSE_PUBLIC_KEY: "",
    LANGFUSE_SECRET_KEY: "",
    TRIGGER_SECRET_KEY: "",
    CMAI_RECEIPT_SIGNING_KEY_ID: "",
    CMAI_RECEIPT_SIGNING_SECRET: "",
    RAILWAY_API_TOKEN: "",
    RAILWAY_ENVIRONMENT_ID: "",
    RAILWAY_SANDBOX_CHECKPOINT: "",
    RAILWAY_SANDBOX_AUTH_MODE: undefined,
    RAILWAY_OAUTH_REFRESH_TOKEN: "",
    RAILWAY_OAUTH_CLIENT_ID: "",
    RAILWAY_OAUTH_CLIENT_SECRET: "",
    RAILWAY_OAUTH_TOKEN_URL: "",
    ...overrides,
  };
}

describe("runtime environment modes", () => {
  it("defaults local development to local auth and local storage", () => {
    const runtime = env();
    expect(authMode(runtime)).toBe("local");
    expect(storeDriver(runtime)).toBe("local");
    expect(missingProductionKeys(runtime)).toEqual([]);
  });

  it("defaults production to Supabase auth and Postgres storage", () => {
    const runtime = env({ NODE_ENV: "production" });
    expect(authMode(runtime)).toBe("supabase");
    expect(storeDriver(runtime)).toBe("postgres");
  });

  it("reports missing production backend keys", () => {
    expect(missingProductionKeys(env({ NODE_ENV: "production" }))).toEqual([
      "CMAI_RUNTIME_ENV",
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "DATABASE_URL",
      "CMAI_AGENT_API_SECRET",
    ]);
  });

  it("rejects explicit local auth/store modes in production", () => {
    const issues = productionConfigIssues(env({ NODE_ENV: "production", CMAI_AUTH_MODE: "local", CMAI_STORE_DRIVER: "local" }));
    expect(issues).toContain("CMAI_AUTH_MODE must be supabase in production");
    expect(issues).toContain("CMAI_STORE_DRIVER must be postgres in production");
  });

  it("lets an explicit preview runtime override Vercel production for demo deployments", () => {
    const runtime = env({ NODE_ENV: "production", VERCEL_ENV: "production", CMAI_RUNTIME_ENV: "preview" });
    expect(runtimeMode(runtime)).toBe("preview");
    expect(isProductionLike(runtime)).toBe(false);
    expect(authMode(runtime)).toBe("local");
    expect(storeDriver(runtime)).toBe("local");
  });

  it("public runtime env does not expose secret values", () => {
    const publicEnv = publicRuntimeEnv(env({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://secret",
      CMAI_AGENT_BROKER_VAULT_MODE: "env",
      CMAI_AGENT_BROKER_VAULT_SECRET: "vault-secret-value",
      CMAI_AGENT_BROKER_VAULT_URL: "https://vault.internal.example/secrets",
      CMAI_MODEL_PROXY_URL: "https://model-proxy.internal.example/run",
      RAILWAY_API_TOKEN: "railway-secret-token",
      RAILWAY_ENVIRONMENT_ID: "env_secret_123",
      RAILWAY_SANDBOX_CHECKPOINT: "checkpoint-secret-name",
      RAILWAY_OAUTH_REFRESH_TOKEN: "railway-refresh-secret",
      RAILWAY_OAUTH_CLIENT_ID: "railway-client-id",
      RAILWAY_OAUTH_CLIENT_SECRET: "railway-client-secret",
      STRIPE_SECRET_KEY: "***",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value",
      OPENROUTER_API_KEY: "or_secret",
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-public-value",
      NEXT_PUBLIC_POSTHOG_KEY: "ph_public",
    }));
    const publicEnvJson = JSON.stringify(publicEnv);
    expect(publicEnvJson).not.toContain("postgres://secret");
    expect(publicEnvJson).not.toContain("vault-secret-value");
    expect(publicEnvJson).not.toContain("vault.internal.example");
    expect(publicEnvJson).not.toContain("model-proxy.internal.example");
    expect(publicEnvJson).not.toContain("railway-secret-token");
    expect(publicEnvJson).not.toContain("env_secret_123");
    expect(publicEnvJson).not.toContain("checkpoint-secret-name");
    expect(publicEnvJson).not.toContain("railway-refresh-secret");
    expect(publicEnvJson).not.toContain("railway-client-secret");
    expect(publicEnvJson).not.toContain("***");
    expect(publicEnvJson).not.toContain("service-role-secret-value");
    expect(publicEnvJson).not.toContain("or_secret");
    expect(publicEnvJson).not.toContain("anon-public-value");
    expect(publicEnv.supabaseAnonKeyPresent).toBe(true);
    expect(publicEnv.googleAuthConfigured).toBe(false);
    expect(publicEnv.runtimeMode).toBe("production");
    expect(publicEnv.authMode).toBe("supabase");
    expect(publicEnv.storeDriver).toBe("postgres");
    expect(publicEnv.productionLike).toBe(true);
    expect(publicEnv.missingProductionKeys).toEqual(["CMAI_RUNTIME_ENV", "CMAI_AGENT_API_SECRET"]);
    expect(publicEnv.agentBrokerVaultMode).toBe("env");
    expect(publicEnv.agentBrokerVaultConfigured).toBe(true);
    expect(publicEnv.modelProxyConfigured).toBe(true);
    expect(publicEnv.billingReadiness).toMatchObject({
      status: "waitlisted",
      stripeConfigured: true,
      activeCheckoutKinds: [],
      waitlistedKinds: expect.arrayContaining(["plus", "private-challenge", "deep-challenge", "one-off-review"]),
    });
    expect(publicEnvJson).not.toContain("price_");
  });

  it("keeps paid checkout readiness separate from Stripe provider presence", () => {
    expect(billingReadiness(env())).toMatchObject({
      status: "waitlisted",
      stripeConfigured: false,
      activeCheckoutKinds: [],
      waitlistedKinds: expect.arrayContaining(["plus", "one-off-review"]),
      readyForCheckout: false,
    });
    expect(billingReadiness(env({ NODE_ENV: "production", STRIPE_SECRET_KEY: "stripe-secret-for-test", STRIPE_PRICE_PLUS: "price_plus" }))).toMatchObject({
      status: "waitlisted",
      stripeConfigured: true,
      priceConfiguredByKind: expect.objectContaining({ plus: true, "private-challenge": false }),
      activeCheckoutKinds: [],
      readyForCheckout: false,
    });
  });

  it("keeps broker credential vault configuration gated by environment", () => {
    expect(agentBrokerVaultMode(env())).toBe("memory");
    expect(agentBrokerVaultConfigured(env())).toBe(true);
    expect(agentBrokerVaultMode(env({ NODE_ENV: "production" }))).toBe("external");
    expect(agentBrokerVaultConfigured(env({ NODE_ENV: "production" }))).toBe(false);
    expect(agentBrokerVaultIssues(env({ NODE_ENV: "production" }))).toContain("CMAI_AGENT_BROKER_VAULT_URL is required when broker vault mode is external");
    expect(agentBrokerVaultIssues(env({ NODE_ENV: "production" }))).toContain("CMAI_AGENT_BROKER_VAULT_SECRET is required to seal external broker vault references");
    expect(agentBrokerVaultIssues(env({ NODE_ENV: "production", CMAI_AGENT_BROKER_VAULT_MODE: "memory" }))).toContain("CMAI_AGENT_BROKER_VAULT_MODE=memory is not allowed in production");
    expect(agentBrokerVaultConfigured(env({ NODE_ENV: "production", CMAI_AGENT_BROKER_VAULT_MODE: "env", CMAI_AGENT_BROKER_VAULT_SECRET: "vault-secret" }))).toBe(true);
  });

  it("requires Supabase config and an explicit flag before Google auth is ready", () => {
    expect(googleAuthConfigured(env({ CMAI_GOOGLE_AUTH_ENABLED: "1" }))).toBe(false);
    expect(googleAuthConfigured(env({ NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon" }))).toBe(false);
    expect(googleAuthConfigured(env({ NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon", CMAI_GOOGLE_AUTH_ENABLED: "1" }))).toBe(true);
  });

  it("reports missing production receipt signing and Railway run-cell configuration", () => {
    const runtime = env({ NODE_ENV: "production" });
    expect(agentRunReceiptSigningIssues(runtime)).toEqual([
      "CMAI_RECEIPT_SIGNING_KEY_ID is required for production Agent run receipts",
      "CMAI_RECEIPT_SIGNING_SECRET is required for production Agent run receipts",
    ]);
    expect(railwaySandboxConfigIssues(runtime)).toEqual([
      "RAILWAY_API_TOKEN is required for production Agent run cells",
      "RAILWAY_ENVIRONMENT_ID is required for production Agent run cells",
    ]);
    expect(railwaySandboxConfigIssues(env({
      NODE_ENV: "production",
      RAILWAY_API_TOKEN: "present",
      RAILWAY_ENVIRONMENT_ID: "env_123",
      RAILWAY_SANDBOX_CHECKPOINT: "unapproved-checkpoint",
    }))).toEqual([
      `RAILWAY_SANDBOX_CHECKPOINT must be the approved ${APPROVED_UNTRUSTED_RUNNER_CHECKPOINT} checkpoint for production Agent run cells`,
    ]);
    expect(railwaySandboxConfigIssues(env({
      NODE_ENV: "production",
      RAILWAY_API_TOKEN: "present",
      RAILWAY_ENVIRONMENT_ID: "env_123",
      RAILWAY_SANDBOX_CHECKPOINT: APPROVED_UNTRUSTED_RUNNER_CHECKPOINT,
    }))).toEqual([]);
    expect(railwaySandboxAuthMode(runtime)).toBe("api_token");
    expect(railwaySandboxDurableAuthIssues(env({
      NODE_ENV: "production",
      RAILWAY_API_TOKEN: "present",
      RAILWAY_ENVIRONMENT_ID: "env_123",
    }))).toEqual([
      "RAILWAY_API_TOKEN is proof-only until a non-expiring Sandbox.create credential is verified or broker-side Railway OAuth refresh is implemented",
    ]);
    expect(railwaySandboxConfigIssues(env({
      NODE_ENV: "production",
      RAILWAY_SANDBOX_AUTH_MODE: "oauth_refresh",
      RAILWAY_OAUTH_REFRESH_TOKEN: "refresh-token",
      RAILWAY_ENVIRONMENT_ID: "env_123",
    }))).toEqual([
      "RAILWAY_OAUTH_CLIENT_ID is required for production Agent run cells when RAILWAY_SANDBOX_AUTH_MODE=oauth_refresh",
    ]);
    expect(railwaySandboxConfigIssues(env({
      NODE_ENV: "production",
      RAILWAY_SANDBOX_AUTH_MODE: "oauth_refresh",
      RAILWAY_OAUTH_REFRESH_TOKEN: "refresh-token",
      RAILWAY_OAUTH_CLIENT_ID: "client-id",
      RAILWAY_ENVIRONMENT_ID: "env_123",
      RAILWAY_SANDBOX_CHECKPOINT: APPROVED_UNTRUSTED_RUNNER_CHECKPOINT,
    }))).toEqual([]);
    expect(railwaySandboxDurableAuthIssues(env({
      NODE_ENV: "production",
      RAILWAY_SANDBOX_AUTH_MODE: "oauth_refresh",
      RAILWAY_OAUTH_REFRESH_TOKEN: "refresh-token",
      RAILWAY_OAUTH_CLIENT_ID: "client-id",
      RAILWAY_ENVIRONMENT_ID: "env_123",
    }))).toEqual([]);
    expect(modelProxyConfigIssues(runtime)).toEqual([
      "CMAI_MODEL_PROXY_URL is required for production Agent model-proxy runs",
    ]);
    expect(trustedAgentRunConfigIssues(runtime)).toEqual([
      "CMAI_RECEIPT_SIGNING_KEY_ID is required for production Agent run receipts",
      "CMAI_RECEIPT_SIGNING_SECRET is required for production Agent run receipts",
      "RAILWAY_API_TOKEN is required for production Agent run cells",
      "RAILWAY_ENVIRONMENT_ID is required for production Agent run cells",
      "RAILWAY_API_TOKEN is proof-only until a non-expiring Sandbox.create credential is verified or broker-side Railway OAuth refresh is implemented",
      "CMAI_AGENT_BROKER_VAULT_URL is required when broker vault mode is external",
      "CMAI_AGENT_BROKER_VAULT_SECRET is required to seal external broker vault references",
      "CMAI_MODEL_PROXY_URL is required for production Agent model-proxy runs",
    ]);
    expect(trustedAgentRunReadiness(runtime)).toMatchObject({
      ready: false,
      status: "launch_blocked",
      components: {
        receiptSigningConfigured: false,
        railwayRunCellsConfigured: false,
        railwayDurableAuthConfigured: false,
        railwaySandboxAuthMode: "api_token",
        brokerVaultConfigured: false,
        modelProxyConfigured: false,
        modelProxyGrantStore: "broker_state",
        modelProxyGrantStoreConfigured: true,
      },
      proof: {
        substrate: "unavailable",
        brokerReceipt: "unavailable",
        modelProxy: "unavailable",
        providerMetadata: "unavailable",
        providerSigned: "not_implemented",
      },
    });
  });
});
