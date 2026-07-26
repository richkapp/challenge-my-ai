import { describe, expect, it } from "vitest";
import { APPROVED_UNTRUSTED_RUNNER_CHECKPOINT } from "@/lib/sandbox/policy";
import { durableStateCollections, productionDataBackupSurfaces, productionDataReadiness, productionDataRunbookCommands, renderProductionDataReadinessMarkdown } from "@/lib/operations/productionDataReadiness";
import type { RuntimeEnv } from "@/lib/config/env";

function runtime(overrides: Partial<RuntimeEnv> = {}): RuntimeEnv {
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
    CMAI_MODEL_PROXY_GRANT_STORE: undefined,
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

function productionRuntime(overrides: Partial<RuntimeEnv> = {}) {
  return runtime({
    NODE_ENV: "production",
    CMAI_RUNTIME_ENV: "production",
    CMAI_VERCEL_PROJECT_LINKED: "1",
    CMAI_AUTH_MODE: "supabase",
    CMAI_STORE_DRIVER: "postgres",
    NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-public-value",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
    DATABASE_URL: "postgresql://postgres.secret:password@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
    CMAI_AGENT_API_SECRET: "agent-secret",
    CMAI_RECEIPT_SIGNING_KEY_ID: "receipt-key-id",
    CMAI_RECEIPT_SIGNING_SECRET: "receipt-secret",
    CMAI_AGENT_BROKER_VAULT_MODE: "external",
    CMAI_AGENT_BROKER_VAULT_URL: "https://vault.internal.example/secrets",
    CMAI_AGENT_BROKER_VAULT_SECRET: "vault-secret",
    CMAI_MODEL_PROXY_URL: "https://model-proxy.internal.example/api/agent-home/model-proxy",
    CMAI_MODEL_PROXY_GRANT_STORE: "broker_state",
    RAILWAY_API_TOKEN: "railway-secret-token",
    RAILWAY_ENVIRONMENT_ID: "env_secret_123",
    RAILWAY_SANDBOX_CHECKPOINT: APPROVED_UNTRUSTED_RUNNER_CHECKPOINT,
    ...overrides,
  });
}

describe("production data readiness", () => {
  it("reports local contexts as local-only while still describing every backup surface", () => {
    const readiness = productionDataReadiness(runtime());
    expect(readiness.status).toBe("local_only");
    expect(readiness.ok).toBe(true);
    expect(readiness.schema).toMatchObject({ table: "cmai_state", adapter: "jsonb_state_snapshot", schemaVersion: expect.any(Number) });
    const covered = new Set(productionDataBackupSurfaces.flatMap((surface) => surface.collections));
    expect(durableStateCollections.every((collection) => covered.has(collection))).toBe(true);
    expect(readiness.backup.uncoveredCollections).toEqual([]);
  });

  it("blocks production when required Supabase/Postgres/Vercel/Railway durability state is missing", () => {
    const readiness = productionDataReadiness(runtime({ NODE_ENV: "production", CMAI_RUNTIME_ENV: "production" }), { vercelProjectLinked: false });
    expect(readiness.status).toBe("blocked");
    expect(readiness.ok).toBe(false);
    expect(readiness.issues).toEqual(expect.arrayContaining([
      "NEXT_PUBLIC_SUPABASE_URL",
      "DATABASE_URL",
      "CMAI_VERCEL_PROJECT_LINKED=1 or .vercel/project.json is required for production deploy/rollback targeting",
      "CMAI_RECEIPT_SIGNING_KEY_ID is required for production Agent run receipts",
      "CMAI_RECEIPT_SIGNING_SECRET is required for production Agent run receipts",
      "RAILWAY_API_TOKEN is required for production Agent run cells",
      "RAILWAY_ENVIRONMENT_ID is required for production Agent run cells",
      "CMAI_AGENT_BROKER_VAULT_URL is required when broker vault mode is external",
      "CMAI_AGENT_BROKER_VAULT_SECRET is required to seal external broker vault references",
      "CMAI_MODEL_PROXY_URL is required for production Agent model-proxy runs",
      "RAILWAY_API_TOKEN is proof-only until a non-expiring Sandbox.create credential is verified or broker-side Railway OAuth refresh is implemented",
    ]));
  });

  it("requires an explicit CMAI_RUNTIME_ENV production flag for production launch checks", () => {
    const readiness = productionDataReadiness(productionRuntime({ CMAI_RUNTIME_ENV: undefined }), { vercelProjectLinked: true });
    expect(readiness.status).toBe("blocked");
    expect(readiness.issues).toContain("CMAI_RUNTIME_ENV");
    expect(readiness.requiredEnv.find((item) => item.key === "CMAI_RUNTIME_ENV")).toMatchObject({ present: "missing" });
  });

  it("surfaces trusted-run blockers in top-level issues and Markdown", () => {
    const unapprovedCheckpointIssue = `RAILWAY_SANDBOX_CHECKPOINT must be the approved ${APPROVED_UNTRUSTED_RUNNER_CHECKPOINT} checkpoint for production Agent run cells`;
    const readiness = productionDataReadiness(productionRuntime({
      CMAI_AGENT_BROKER_VAULT_URL: "",
      CMAI_AGENT_BROKER_VAULT_SECRET: "",
      CMAI_MODEL_PROXY_URL: "",
      RAILWAY_SANDBOX_CHECKPOINT: "unapproved-checkpoint",
    }), { vercelProjectLinked: true });
    expect(readiness.issues).toEqual(expect.arrayContaining([
      unapprovedCheckpointIssue,
      "CMAI_AGENT_BROKER_VAULT_URL is required when broker vault mode is external",
      "CMAI_AGENT_BROKER_VAULT_SECRET is required to seal external broker vault references",
      "CMAI_MODEL_PROXY_URL is required for production Agent model-proxy runs",
    ]));
    const markdown = renderProductionDataReadinessMarkdown(readiness);
    expect(markdown).toContain(unapprovedCheckpointIssue);
    expect(markdown).toContain("CMAI_MODEL_PROXY_URL is required for production Agent model-proxy runs");
  });

  it("does not treat a present Railway API token as durable production Sandbox auth", () => {
    const readiness = productionDataReadiness(productionRuntime(), { vercelProjectLinked: true });
    expect(readiness.status).toBe("blocked");
    expect(readiness.providers.railwaySandbox).toMatchObject({
      token: "present",
      environmentId: "present",
      authMode: "api_token",
      durableAuthStatus: "blocked_until_durable_auth",
    });
    expect(readiness.trustedAgentRun).toMatchObject({
      ready: false,
      status: "launch_blocked",
      components: expect.objectContaining({ railwayDurableAuthConfigured: false, railwaySandboxAuthMode: "api_token" }),
      proof: expect.objectContaining({ substrate: "unavailable", brokerReceipt: "unavailable" }),
    });
  });

  it("keeps configured status and runbook output redacted", () => {
    const readiness = productionDataReadiness(productionRuntime({ RAILWAY_SANDBOX_AUTH_MODE: "oauth_refresh", RAILWAY_OAUTH_REFRESH_TOKEN: "refresh-secret", RAILWAY_OAUTH_CLIENT_ID: "railway-client-id" }), { vercelProjectLinked: true });
    const serialized = JSON.stringify(readiness);
    expect(serialized).not.toContain("postgresql://postgres.secret");
    expect(serialized).not.toContain("service-role-secret");
    expect(serialized).not.toContain("railway-secret-token");
    expect(serialized).not.toContain("refresh-secret");
    expect(serialized).not.toContain("railway-client-id");
    expect(serialized).not.toContain("vault.internal.example");
    expect(readiness.issues).not.toContain("Railway OAuth refresh flow is not implemented for production Sandbox.create yet");
    expect(readiness.trustedAgentRun).toMatchObject({
      ready: true,
      status: "configured_needs_live_proof",
      components: expect.objectContaining({ railwayDurableAuthConfigured: true, railwaySandboxAuthMode: "oauth_refresh" }),
    });
    const markdown = renderProductionDataReadinessMarkdown(readiness);
    expect(markdown).toContain("$DATABASE_URL");
    expect(markdown).toContain("$RESTORE_DATABASE_URL");
    expect(markdown).toContain("Dry-run only");
    expect(productionDataRunbookCommands.some((step) => step.id === "restore_drill" && step.destructive)).toBe(true);
  });
});
