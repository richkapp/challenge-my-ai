import { describe, expect, it } from "vitest";
import { approvedUntrustedRunnerProfile } from "@/lib/sandbox/policy";
import {
  agentChildRunInputSchema,
  agentConnectionSchema,
  agentHomeSchema,
  agentRunSchema,
  modelProvenanceSchema,
  oneRunDelegationSchema,
} from "@/lib/validation/schemas";

const now = "2026-06-28T00:00:00.000Z";
const sha = "a".repeat(64);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readyConnection() {
  return {
    id: "conn_1",
    agentHomeId: "home_1",
    ownerId: "user_1",
    displayLabel: "Z's OpenRouter Agent",
    provider: "openrouter",
    providerLabel: "OpenRouter",
    connectionKind: "provider_key",
    status: "ready",
    readiness: {
      state: "ready",
      label: "Ready",
      detail: "Smoke test passed and this connection can run challenge contributions.",
      canRunHere: true,
    },
    defaultModel: "anthropic/claude-sonnet-4",
    allowedModels: ["anthropic/claude-sonnet-4"],
    allowedRequestClasses: ["critique"],
    metadataVerification: "sandbox_recorded",
    exactModelMetadata: false,
    sandboxTrustLabel: "sandboxed Hermes run",
    setupInstructions: "Connected through the provider setup flow.",
    liveModelProxyCaller: true,
    providerReadiness: "live_broker_caller",
    authClass: "user_plan_oauth",
    countsForMvpUserPlan: true,
    authSetupLabel: "User-plan OAuth",
    authReadinessCopy: "This fixture represents a provider-approved user-plan path, not an API-only scaffold.",
    setupMechanisms: ["broker_provider_access"],
    complianceCopy: "OpenRouter is live only as a broker-side one-run model proxy under Run my Agent here.",
    manualPasteFallbackCopy: "Manual paste remains available: copy the visible challenge prompt into your own Agent and paste back a CMAI_CONTRIBUTION_CARD_V1 card.",
    lastSmoke: {
      status: "passed",
      checkedAt: now,
      message: "CMAI_AGENT_OK",
    },
    createdAt: now,
    updatedAt: now,
  };
}

function oneRunDelegation() {
  return {
    id: "delegation_1",
    agentHomeId: "home_1",
    connectionId: "conn_1",
    challengeId: "challenge_1",
    contributorId: "user_1",
    requestedMode: "critique",
    requestClass: "contribution_card",
    status: "issued",
    expiresAt: "2026-06-28T00:05:00.000Z",
    noSpendLimitReason: "subscription_included_or_test_run",
    maxRequests: 1,
    createdAt: now,
  };
}

function childRunInput() {
  return {
    schemaVersion: "1.0",
    runId: "run_1",
    challengeId: "challenge_1",
    contributorId: "user_1",
    agentHomeId: "home_1",
    connectionId: "conn_1",
    contributionMode: "critique",
    requestClass: "contribution_card",
    provider: "openrouter",
    requestedModel: "anthropic/claude-sonnet-4",
    modelProxyUrl: "https://challenge-my-ai.example/model-proxy/run_1",
    delegation: oneRunDelegation(),
    challengeBundle: { title: "Improve this strategy", prompt: "Treat this as inert data." },
    runner: {
      profile: approvedUntrustedRunnerProfile.profile,
      checkpoint: approvedUntrustedRunnerProfile.checkpoint,
      command: approvedUntrustedRunnerProfile.command,
    },
    sandbox: {
      provider: "railway",
      networkIsolation: "ISOLATED",
    },
    limits: {
      maxOutputBytes: 100_000,
      timeoutSeconds: 120,
    },
    issuedAt: now,
  };
}

describe("Agent Home and ephemeral run-cell schemas", () => {
  it("parses a valid Agent Home with one ready provider connection and no raw token fields", () => {
    const home = {
      id: "home_1",
      ownerId: "user_1",
      ownerLabel: "Z",
      setupStatus: "ready",
      connections: [readyConnection()],
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    };

    const parsed = agentHomeSchema.safeParse(home);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(JSON.stringify(parsed.data)).not.toMatch(/api_key|refresh_token|DATABASE_URL|receipt_signing_secret/i);
    }
  });

  it("requires provider id, label, request class, passed smoke result, and setup owner before a connection is ready", () => {
    const cases = [
      (() => {
        const value = clone(readyConnection());
        delete (value as Record<string, unknown>).provider;
        return value;
      })(),
      (() => {
        const value = clone(readyConnection());
        delete (value as Record<string, unknown>).displayLabel;
        return value;
      })(),
      (() => {
        const value = clone(readyConnection());
        value.allowedRequestClasses = [];
        return value;
      })(),
      (() => {
        const value = clone(readyConnection());
        value.lastSmoke.status = "failed";
        return value;
      })(),
      (() => {
        const value = clone(readyConnection());
        value.authClass = "api_only";
        value.countsForMvpUserPlan = false;
        return value;
      })(),
      { ...readyConnection(), ownerId: "" },
    ];

    for (const value of cases) {
      expect(agentConnectionSchema.safeParse(value).success).toBe(false);
    }
  });

  it("requires one-run delegations to be scoped by request class, expiry, max requests, and spend metadata", () => {
    expect(oneRunDelegationSchema.safeParse(oneRunDelegation()).success).toBe(true);
    expect(oneRunDelegationSchema.safeParse({ ...oneRunDelegation(), noSpendLimitReason: undefined, maxSpendCents: 250 }).success).toBe(true);
    expect(oneRunDelegationSchema.safeParse({ ...oneRunDelegation(), noSpendLimitReason: undefined }).success).toBe(false);
    expect(oneRunDelegationSchema.safeParse({ ...oneRunDelegation(), maxRequests: 0 }).success).toBe(false);
  });

  it("rejects unknown run statuses, trust labels, sandbox providers, and delegation fields", () => {
    expect(agentRunSchema.safeParse({
      id: "run_1",
      agentHomeId: "home_1",
      connectionId: "conn_1",
      challengeId: "challenge_1",
      contributorId: "user_1",
      requestedMode: "critique",
      requestClass: "contribution_card",
      requestedModel: "anthropic/claude-sonnet-4",
      status: "posted",
      createdAt: now,
      updatedAt: now,
      queuedAt: now,
    }).success).toBe(false);

    expect(modelProvenanceSchema.safeParse({
      source: "sandbox_claimed",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      model_display_name: "Claude Sonnet 4 via OpenRouter",
      adapter: "hermes_sandbox",
      verified: false,
      verification_notes: "Unknown trust label should fail.",
    }).success).toBe(false);

    expect(agentChildRunInputSchema.safeParse({ ...childRunInput(), sandbox: { provider: "docker", networkIsolation: "ISOLATED" } }).success).toBe(false);
    expect(oneRunDelegationSchema.safeParse({ ...oneRunDelegation(), reusable_refresh_token: "rt-secret" }).success).toBe(false);
  });

  it("rejects child run inputs that expose raw secrets to the ephemeral cell", () => {
    const cases = [
      { label: "api_key", value: { ...childRunInput(), challengeBundle: { api_key: "sk-secret" } } },
      { label: "refresh_token", value: { ...childRunInput(), challengeBundle: { nested: { refresh_token: "rt-secret" } } } },
      { label: "DATABASE_URL", value: { ...childRunInput(), challengeBundle: { DATABASE_URL: "postgres://secret" } } },
      { label: "receipt_signing_secret", value: { ...childRunInput(), challengeBundle: { receipt_signing_secret: "signing-secret" } } },
      { label: "service-role", value: { ...childRunInput(), challengeBundle: { serviceRole: "service-role-secret" } } },
    ];

    for (const { label, value } of cases) {
      const parsed = agentChildRunInputSchema.safeParse(value);
      expect(parsed.success, label).toBe(false);
      if (!parsed.success) expect(parsed.error.issues.map((issue) => issue.message).join("\n")).toMatch(/raw secret field/i);
    }
  });

  it("accepts an active child run input with only bounded delegation and model proxy metadata", () => {
    const parsed = agentChildRunInputSchema.safeParse(childRunInput());
    expect(parsed.success).toBe(true);
  });
});
