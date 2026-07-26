import { describe, expect, it } from "vitest";
import { isAccountRequiredAppPath, shouldRedirectLocalAppRequest } from "@/proxy";
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

describe("app-route auth proxy gate", () => {
  it("keeps public post discovery and thread routes readable without an account", () => {
    expect(isAccountRequiredAppPath("/lobby")).toBe(false);
    expect(isAccountRequiredAppPath("/answers")).toBe(false);
    expect(isAccountRequiredAppPath("/profile/agent-redteam-demo")).toBe(false);
    expect(isAccountRequiredAppPath("/challenges/seed-reddit-ai-debate-feed")).toBe(false);
    expect(shouldRedirectLocalAppRequest({ pathname: "/lobby", hasLocalUserCookie: false, runtime: runtime({ CMAI_RUNTIME_ENV: "preview" }) })).toBe(false);
    expect(shouldRedirectLocalAppRequest({ pathname: "/answers", hasLocalUserCookie: false, runtime: runtime({ CMAI_RUNTIME_ENV: "preview" }) })).toBe(false);
    expect(shouldRedirectLocalAppRequest({ pathname: "/profile/agent-redteam-demo", hasLocalUserCookie: false, runtime: runtime({ CMAI_RUNTIME_ENV: "preview" }) })).toBe(false);
  });

  it("redirects local/preview account-only routes when no local account cookie is present", () => {
    expect(shouldRedirectLocalAppRequest({ pathname: "/challenges/new", hasLocalUserCookie: false, runtime: runtime({ CMAI_RUNTIME_ENV: "preview" }) })).toBe(true);
    expect(shouldRedirectLocalAppRequest({ pathname: "/dashboard", hasLocalUserCookie: false, runtime: runtime({ CMAI_RUNTIME_ENV: "preview" }) })).toBe(true);
  });

  it("allows account-only routes with a local account cookie", () => {
    expect(shouldRedirectLocalAppRequest({ pathname: "/challenges/new", hasLocalUserCookie: true, runtime: runtime({ CMAI_RUNTIME_ENV: "preview" }) })).toBe(false);
  });

  it("does not gate public routes or explicit demo fallback mode", () => {
    expect(shouldRedirectLocalAppRequest({ pathname: "/", hasLocalUserCookie: false, runtime: runtime({ CMAI_RUNTIME_ENV: "preview" }) })).toBe(false);
    expect(shouldRedirectLocalAppRequest({ pathname: "/dashboard", hasLocalUserCookie: false, runtime: runtime({ CMAI_RUNTIME_ENV: "preview", CMAI_ENABLE_DEMO_AUTH: "1" }) })).toBe(false);
  });
});
