import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentHomePanel } from "@/components/agent/AgentHomePanel";
import type { AgentConnection, AgentHome } from "@/lib/types";

const baseHome: AgentHome = {
  id: "agent-home-user",
  ownerId: "user-agent-home",
  ownerLabel: "Agent Home User",
  setupStatus: "setup_required",
  connections: [],
  createdAt: "2026-06-28T10:00:00.000Z",
  updatedAt: "2026-06-28T10:00:00.000Z",
  lastActivityAt: "2026-06-28T10:00:00.000Z",
};

function connection(overrides: Partial<AgentConnection> = {}): AgentConnection {
  return {
    id: "agent-connection-ready",
    agentHomeId: baseHome.id,
    ownerId: baseHome.ownerId,
    displayLabel: "Local fake Hermes Agent",
    provider: "local_fake",
    providerLabel: "Local fake provider",
    connectionKind: "fake_dev",
    status: "ready",
    readiness: {
      state: "ready",
      label: "Ready for Run my Agent here",
      detail: "Smoke test passed. The child run path can request one approved sandbox run without raw credentials.",
      canRunHere: true,
    },
    defaultModel: "deterministic-demo-agent",
    allowedModels: ["deterministic-demo-agent"],
    allowedRequestClasses: ["critique", "red_team"],
    metadataVerification: "sandbox_recorded",
    exactModelMetadata: false,
    sandboxTrustLabel: "Sandbox-recorded only; exact model metadata is not verified.",
    setupInstructions: "Development adapter.",
    liveModelProxyCaller: true,
    providerReadiness: "dev_only",
    authClass: "manual_only",
    countsForMvpUserPlan: false,
    authSetupLabel: "Development-only fake provider",
    authReadinessCopy: "Local fake runs are allowed only for development proof paths and never count as production user-plan auth.",
    setupMechanisms: ["local_dev"],
    complianceCopy: "Development-only fake provider for proving Agent Home mechanics.",
    manualPasteFallbackCopy: "Manual paste remains available: copy the visible challenge prompt into your own Agent and paste back a CMAI_CONTRIBUTION_CARD_V1 card.",
    lastSmoke: { status: "passed", checkedAt: "2026-06-28T10:01:00.000Z", message: "Smoke test passed." },
    createdAt: "2026-06-28T10:00:00.000Z",
    updatedAt: "2026-06-28T10:01:00.000Z",
    ...overrides,
  };
}

describe("Agent Home setup panel", () => {
  it("renders setup-needed state with manual paste fallback", () => {
    const html = renderToStaticMarkup(createElement(AgentHomePanel, { agentHome: baseHome }));

    expect(html).toContain("Connect once. Approve each run.");
    expect(html).toContain("Setup needed");
    expect(html).toContain("Connect an Agent");
    expect(html).toContain("Manual paste remains available");
    expect(html).toContain("OpenAI Responses API");
    expect(html).toContain("Codex / ChatGPT plan");
    expect(html).toContain("Broker caller live");
    expect(html).toContain("Connect Codex");
    expect(html).toContain("No connection yet.");
    expect(html).not.toContain("Local OP");
  });

  it("renders a ready fake connection without claiming exact model proof", () => {
    const html = renderToStaticMarkup(createElement(AgentHomePanel, { agentHome: { ...baseHome, setupStatus: "ready", connections: [connection()] } }));

    expect(html).toContain("Ready · 1 ready");
    expect(html).toContain("Run-ready");
    expect(html).toContain("Local fake provider");
    expect(html).toContain("deterministic-demo-agent");
    expect(html).toContain("Sandbox-recorded only; exact model metadata is not verified.");
    expect(html).not.toContain("codex-access-token-fixture");
    expect(html).not.toContain("codex-refresh-token-fixture");
  });

  it("does not advertise hidden advanced request classes in the normal Agent Home summary", () => {
    const html = renderToStaticMarkup(createElement(AgentHomePanel, {
      agentHome: { ...baseHome, setupStatus: "ready", connections: [connection({ allowedRequestClasses: ["critique", "red_team", "alternate_proposal", "risk_audit", "steelman", "judge"] })] },
    }));

    expect(html).toContain("Critique, Red-team, Alternative, Risk audit, Steelman");
    expect(html).not.toContain("Judge");
  });

  it("renders failed smoke as setup-needed and keeps the trusted lane disabled", () => {
    const failed = connection({
      id: "agent-connection-failed",
      status: "smoke_failed",
      readiness: {
        state: "smoke_failed",
        label: "Setup needs attention",
        detail: "Smoke failed. Manual paste still works while you fix the connection.",
        canRunHere: false,
      },
      lastSmoke: { status: "failed", checkedAt: "2026-06-28T10:02:00.000Z", message: "Smoke failed." },
    });
    const html = renderToStaticMarkup(createElement(AgentHomePanel, { agentHome: { ...baseHome, connections: [failed] } }));

    expect(html).toContain("Setup needs attention");
    expect(html).toContain("Run smoke test");
    expect(html).not.toContain("Run-ready");
  });

  it("renders paused and revoked lifecycle states with honest controls", () => {
    const paused = connection({
      id: "agent-connection-paused",
      status: "paused",
      readiness: {
        state: "paused",
        label: "Paused",
        detail: "This connection is paused and cannot run on challenges until it is resumed.",
        canRunHere: false,
      },
    });
    const revoked = connection({
      id: "agent-connection-revoked",
      displayLabel: "Revoked OpenRouter Agent",
      provider: "openrouter",
      providerLabel: "OpenRouter",
      connectionKind: "provider_key",
      status: "revoked",
      readiness: {
        state: "unavailable",
        label: "Revoked",
        detail: "This provider connection was revoked. Reconnect provider access before using Run my Agent here.",
        canRunHere: false,
      },
      brokerCredentialAvailable: false,
      lastSmoke: { status: "not_run", message: "Provider access was revoked." },
    });
    const html = renderToStaticMarkup(createElement(AgentHomePanel, { agentHome: { ...baseHome, connections: [paused, revoked] } }));

    expect(html).toContain("Paused");
    expect(html).toContain("Resume");
    expect(html).toContain("Revoked");
    expect(html).toContain("Reconnect");
    expect(html).toContain("Fresh provider access");
    expect(html).not.toContain("Run-ready");
  });

  it("renders unsupported provider connections as saved setup, not runnable trusted runs", () => {
    const unsupported = connection({
      id: "agent-connection-unsupported",
      displayLabel: "Gemini Agent",
      provider: "gemini",
      providerLabel: "Gemini",
      connectionKind: "provider_key",
      status: "ready",
      readiness: {
        state: "unavailable",
        label: "Provider adapter pending",
        detail: "Gemini setup is saved, but a live broker caller is not enabled yet. Manual paste remains available.",
        canRunHere: false,
      },
      liveModelProxyCaller: false,
      providerReadiness: "compliance_review",
      authClass: "compliance_blocked",
      countsForMvpUserPlan: false,
      authSetupLabel: "Provider auth blocked pending consent review",
      authReadinessCopy: "Gemini auth needs consent and production credential handling decisions before it can count as user-plan auth.",
      complianceCopy: "Gemini remains fail-closed until auth-key migration, OAuth consent, and broker-side credential handling are represented safely.",
    });
    const html = renderToStaticMarkup(createElement(AgentHomePanel, { agentHome: { ...baseHome, connections: [unsupported] } }));

    expect(html).toContain("Provider adapter pending");
    expect(html).toContain("Gemini setup is saved, but a live broker caller is not enabled yet.");
    expect(html).not.toContain("Run-ready");
  });

  it("hides local dev connection setup when production mode disables it", () => {
    const html = renderToStaticMarkup(createElement(AgentHomePanel, { agentHome: baseHome, devConnectionEnabled: false }));

    expect(html).not.toContain("Connect dev sandbox");
    expect(html).toContain("Manual paste still works while Agent Home setup is incomplete.");
  });

  it("does not render stale ready fake/dev connections as runnable in production mode", () => {
    const html = renderToStaticMarkup(createElement(AgentHomePanel, { agentHome: { ...baseHome, setupStatus: "ready", connections: [connection()] }, devConnectionEnabled: false }));

    expect(html).toContain("Setup needed · 0 ready");
    expect(html).toContain("Persisted local/dev Agent connections are ignored in production.");
    expect(html).toContain("Production-disabled dev connection");
    expect(html).toContain("This dev connection is ignored in production.");
    expect(html).not.toContain("Agent Home is ready for approved sandbox runs.");
    expect(html).not.toContain("Run-ready");
  });

  it("does not render ready real-provider connections as runnable when production run setup is incomplete", () => {
    const providerConnection = connection({
      provider: "openrouter",
      providerLabel: "OpenRouter",
      connectionKind: "provider_key",
      displayLabel: "OpenRouter Agent",
      defaultModel: "anthropic/claude-sonnet-4",
      allowedModels: ["anthropic/claude-sonnet-4"],
    });
    const html = renderToStaticMarkup(createElement(AgentHomePanel, {
      agentHome: { ...baseHome, setupStatus: "ready", connections: [providerConnection] },
      devConnectionEnabled: false,
      trustedRunConfigIssues: ["RAILWAY_ENVIRONMENT_ID is required for production Agent run cells"],
    }));

    expect(html).toContain("Setup needed · 0 ready");
    expect(html).toContain("Agent Home has connection state, but production broker, receipt signing, model proxy, or sandbox run cells are not configured yet.");
    expect(html).toContain("Production run setup incomplete");
    expect(html).toContain("Production broker, receipt signing, model proxy, or sandbox run cells are incomplete.");
    expect(html).not.toContain("Agent Home is ready for approved sandbox runs.");
    expect(html).not.toContain("Run-ready");
  });
});
