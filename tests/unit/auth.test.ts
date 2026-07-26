import { describe, expect, it } from "vitest";
import { assertCsrfIfCookieSession, userFromHeaders } from "@/lib/auth";
import { agentFromHeaders, signAgentRequest } from "@/lib/auth/agent";
import { currentUserFromSupabaseUser } from "@/lib/auth/supabase";
import type { RuntimeEnv } from "@/lib/config/env";
import type { User } from "@supabase/supabase-js";

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

describe("auth helper", () => {
  it("returns null when no credential and dev fallback is disabled", () => {
    expect(userFromHeaders(new Headers(), { allowDevFallback: false })).toBeNull();
  });

  it("reads local user headers in test mode", () => {
    const headers = new Headers({ "x-cmai-user-id": "alice", "x-cmai-role": "moderator" });
    expect(userFromHeaders(headers, { allowDevFallback: false })).toMatchObject({ id: "alice", role: "moderator" });
  });

  it("rejects header identity in production mode", () => {
    const headers = new Headers({ "x-cmai-user-id": "alice", "x-cmai-role": "moderator" });
    expect(userFromHeaders(headers, { runtime: runtime({ NODE_ENV: "production" }) })).toBeNull();
  });

  it("does not create a hardcoded local-dev user unless demo fallback is explicit", () => {
    expect(userFromHeaders(new Headers(), { runtime: runtime({ CMAI_RUNTIME_ENV: "preview" }) })).toBeNull();
    expect(userFromHeaders(new Headers(), { runtime: runtime({ CMAI_RUNTIME_ENV: "preview", CMAI_ENABLE_DEMO_AUTH: "1" }) })).toMatchObject({ id: "local-op", authSource: "local-dev" });
  });

  it("requires csrf token for local cookie mutations", () => {
    const user = { id: "local-op", name: "Demo user", role: "user" as const, authSource: "cookie" as const };
    const request = new Request("http://test.local/api/challenges", { method: "POST", headers: { cookie: "cmai_user_id=local-op" } });
    expect(() => assertCsrfIfCookieSession(request, user)).toThrow("CSRF token required");
  });

  it("accepts matching csrf token and same-origin cookie mutations", () => {
    const user = { id: "local-op", name: "Demo user", role: "user" as const, authSource: "cookie" as const };
    const request = new Request("http://test.local/api/challenges", { method: "POST", headers: { cookie: "cmai_user_id=local-op; cmai_csrf=abc", "x-cmai-csrf": "abc", origin: "http://test.local" } });
    expect(() => assertCsrfIfCookieSession(request, user)).not.toThrow();
  });

  it("rejects cross-origin cookie mutations", () => {
    const user = { id: "local-op", name: "Demo user", role: "user" as const, authSource: "cookie" as const };
    const request = new Request("http://test.local/api/challenges", { method: "POST", headers: { cookie: "cmai_user_id=local-op; cmai_csrf=abc", "x-cmai-csrf": "abc", origin: "https://evil.example" } });
    expect(() => assertCsrfIfCookieSession(request, user)).toThrow("Cross-origin mutation rejected");
  });

  it("trusts moderator role only from admin-controlled Supabase app metadata", () => {
    const baseUser = { id: "supabase-user", email: "user@example.com", app_metadata: {}, user_metadata: {} } as User;
    expect(currentUserFromSupabaseUser({ ...baseUser, user_metadata: { cmai_role: "moderator" } })).toMatchObject({ role: "user" });
    expect(currentUserFromSupabaseUser({ ...baseUser, app_metadata: { cmai_role: "moderator" } })).toMatchObject({ role: "moderator" });
  });
});

describe("agent auth helper", () => {
  it("allows simple agent headers outside production", () => {
    const headers = new Headers({ "x-cmai-agent-id": "agent-a", "x-cmai-agent-capabilities": "critique,red_team" });
    expect(agentFromHeaders(headers, { runtime: runtime() })).toMatchObject({ id: "agent-a", capabilities: ["critique", "red_team"] });
  });

  it("rejects unsigned agent headers in production", () => {
    const headers = new Headers({ "x-cmai-agent-id": "agent-a" });
    expect(agentFromHeaders(headers, { runtime: runtime({ NODE_ENV: "production", CMAI_AGENT_API_SECRET: "secret" }) })).toBeNull();
  });

  it("accepts signed agent headers in production", () => {
    const timestamp = String(Date.now());
    const signature = signAgentRequest({ agentId: "agent-a", timestamp, secret: "secret" });
    const headers = new Headers({ "x-cmai-agent-id": "agent-a", "x-cmai-agent-timestamp": timestamp, "x-cmai-agent-signature": signature });
    expect(agentFromHeaders(headers, { runtime: runtime({ NODE_ENV: "production", CMAI_AGENT_API_SECRET: "secret" }) })).toMatchObject({ id: "agent-a" });
  });
});
