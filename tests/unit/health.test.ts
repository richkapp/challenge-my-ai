import { describe, expect, it } from "vitest";
import { GET as healthGet, buildSystemHealthSnapshot } from "@/app/api/system/health/route";
import { loadEnv } from "@/lib/config/env";
import { APPROVED_UNTRUSTED_RUNNER_CHECKPOINT } from "@/lib/sandbox/policy";

describe("system health route", () => {
  it("returns non-secret runtime/provider status", async () => {
    const response = await healthGet();
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("\"googleAuth\":");
    expect(text).toContain("\"supabaseAdmin\":");
    const json = JSON.parse(text);
    expect(json).toMatchObject({ ok: true, mode: "test", productionReady: false, providers: expect.any(Object) });
    expect(text).not.toContain("sk-");
    expect(text).not.toContain("postgres://");
    expect(text).not.toContain("service_role");
    expect(json.publicRuntime).toHaveProperty("supabaseAnonKeyPresent");
    expect(json.publicRuntime).toHaveProperty("googleAuthConfigured");
    expect(json.publicRuntime).toHaveProperty("authMode");
    expect(json.publicRuntime).toHaveProperty("storeDriver");
    expect(json.publicRuntime).toHaveProperty("productionLike");
    expect(json.publicRuntime.billingReadiness).toMatchObject({ status: "waitlisted", activeCheckoutKinds: [], readyForCheckout: false, stripeConfigured: expect.any(Boolean) });
    expect(json.productionData).toMatchObject({
      status: "local_only",
      schema: expect.objectContaining({ table: "cmai_state", adapter: "jsonb_state_snapshot", schemaVersion: expect.any(Number) }),
      backup: expect.objectContaining({ stateCollections: expect.arrayContaining(["challenges", "contributions", "creditEvents", "agentRuns"]), uncoveredCollections: [] }),
    });
    expect(text).toContain("\"productionData\":");
    expect(text).not.toContain("RESTORE_DATABASE_URL=");
    expect(json.trustedAgentRun).toMatchObject({
      ready: true,
      status: "local_only",
      components: expect.objectContaining({
        receiptSigningConfigured: true,
        railwayRunCellsConfigured: true,
        brokerVaultConfigured: true,
        modelProxyConfigured: true,
      }),
      proof: expect.objectContaining({
        substrate: "local_fake",
        brokerReceipt: "local_fake",
        modelProxy: "local_fake",
        providerSigned: "not_implemented",
      }),
    });
  });

  it("blocks production health when production-data rollback target identity is unknown", () => {
    const snapshot = buildSystemHealthSnapshot(loadEnv({
      NODE_ENV: "production",
      CMAI_RUNTIME_ENV: "production",
      CMAI_AUTH_MODE: "supabase",
      CMAI_STORE_DRIVER: "postgres",
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-public-value",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-secret",
      DATABASE_URL: "postgresql://user:password@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
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
    }));
    expect(snapshot.ok).toBe(false);
    expect(snapshot.productionReady).toBe(false);
    expect(snapshot.productionData).toMatchObject({ status: "blocked", productionLike: true, providers: { vercelProject: "unknown" } });
    expect(snapshot.productionData.issues).toContain("CMAI_VERCEL_PROJECT_LINKED=1 or .vercel/project.json is required for production deploy/rollback targeting");
    expect(snapshot.productionConfigIssues).toEqual(expect.arrayContaining(snapshot.productionData.issues));
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("user:password");
    expect(serialized).not.toContain("service-role-secret");
    expect(serialized).not.toContain("railway-secret-token");
    expect(serialized).not.toContain("vault.internal.example");
    expect(serialized).not.toContain("model-proxy.internal.example");
  });
});
