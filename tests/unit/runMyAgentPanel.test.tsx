// @vitest-environment jsdom
// @ts-expect-error jsdom has no local type package in this MVP test harness.
import { JSDOM } from "jsdom";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Contribution } from "@/lib/types";

const originalFetch = globalThis.fetch;
const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://test.local" });
const globals = globalThis as typeof globalThis & {
  window: Window & typeof globalThis;
  document: Document;
  navigator: Navigator;
  HTMLElement: typeof HTMLElement;
  Element: typeof Element;
  Node: typeof Node;
};
globals.window = dom.window as unknown as Window & typeof globalThis;
globals.document = dom.window.document;
globals.navigator = dom.window.navigator;
globals.HTMLElement = dom.window.HTMLElement;
globals.Element = dom.window.Element;
globals.Node = dom.window.Node;

const { cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
const { RunMyAgentPanel } = await import("@/components/contribution/RunMyAgentPanel");

const contribution: Contribution = {
  id: "contribution-sandboxed",
  challengeId: "challenge-1",
  contributorId: "agent-home-user",
  contributorKind: "agent",
  contributorLabel: "Sandboxed Agent",
  createdAt: "2026-06-28T10:00:00.000Z",
  status: "posted",
  externallyGenerated: true,
  communityScore: 0,
  card: {
    schema_version: "1.0",
    challenge_id: "challenge-1",
    contribution_mode: "critique",
    contributor_ai_label: "Sandboxed Agent",
    model_provenance: {
      source: "hermes_sandbox_run",
      provider: "fake-provider",
      model: "fake-model",
      model_display_name: "Fake Model",
      adapter: "hermes_sandbox",
      verified: false,
      verification_notes: "Generated in a Challenge My AI-controlled Hermes run cell; exact provider model identity is not independently API-verified.",
      receipt_id: "hr_test",
      receipt_sha256: "a".repeat(64),
      sandbox_provider: "local_fake",
      sandbox_network_isolation: "ISOLATED",
      sandbox_teardown_completed: true,
    },
    skills_or_context_used: ["unit-test"],
    verdict: "The answer needs a sandboxed critique.",
    original_answer_grade: { score_0_to_10: 6, grade_label: "mixed", why: "Useful but incomplete." },
    answer_to_challenge_poster: "Treat this as a receipt-backed critique.",
    reasoning_summary: "Unit test contribution.",
    strongest_objections: ["Missing evidence"],
    missing_assumptions_or_context: [],
    alternative_recommendation: "Run a smaller proof.",
    risks_and_failure_modes: ["False confidence"],
    claims_to_verify: [],
    confidence: { level: "medium", why: "Deterministic test." },
    what_would_change_my_mind: [],
    suggested_follow_up_questions: [],
    safety_or_scope_notes: [],
    abuse_or_prompt_injection_flags: [],
    raw_output_summary: "Sandboxed test card",
  },
};

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

function readyPayload() {
  return {
    ready: true,
    connection: {
      id: "conn-ready",
      status: "ready",
      providerLabel: "Test Provider",
      modelLabel: "Fake Model",
      trustLabel: "sandbox-recorded",
    },
    readiness: { status: "ready", message: "Agent Home is ready." },
  };
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

afterAll(() => {
  dom.window.close();
});

function stubFetch(fetchMock: ReturnType<typeof vi.fn>) {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
}

describe("RunMyAgentPanel", () => {
  it("account-gates Run my Agent here for anonymous readers without hiding manual paste", async () => {
    const fetchMock = vi.fn(() => response({ error: "should not fetch" }, 500));
    stubFetch(fetchMock);

    const view = render(<RunMyAgentPanel challengeId="challenge-1" requestedModes={["critique"]} isAuthenticated={false} loginHref="/login?next=%2Fchallenges%2Fchallenge-1" onContributed={vi.fn()} />);

    expect(await view.findByText("setup needed")).toBeTruthy();
    expect(view.getByText("Create an account to use Run my Agent here. Manual copy/paste still works before login.")).toBeTruthy();
    expect(view.getByRole("link", { name: "Create account for Run my Agent here" }).getAttribute("href")).toBe("/login?next=%2Fchallenges%2Fchallenge-1");
    expect(view.getByText(/Manual copy\/paste remains available in Lane 1/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows setup-needed state with Agent Home link and manual paste fallback", async () => {
    stubFetch(vi.fn(() => response({ error: "Agent Home needs setup first." }, 404)));

    const view = render(<RunMyAgentPanel challengeId="challenge-1" requestedModes={["critique"]} onContributed={vi.fn()} />);

    expect(await view.findByText("setup needed")).toBeTruthy();
    expect(view.getByText("Agent Home needs setup first.")).toBeTruthy();
    expect(view.getByText("Connect Codex")).toBeTruthy();
    expect(view.getByText("Open full Agent Home").getAttribute("href")).toBe("/agents");
    expect(view.getByText(/Manual copy\/paste remains available in Lane 1/)).toBeTruthy();
  });

  it("keeps Lane 2 blocked when a saved connection says ready but run readiness says no", async () => {
    stubFetch(vi.fn(() => response({
      ready: false,
      connection: { id: "conn-stale-ready", status: "ready", providerLabel: "Claude Code" },
      readiness: { status: "setup_required", canRunHere: false, message: "Broker smoke must pass before this connection can run." },
    })));

    const view = render(<RunMyAgentPanel challengeId="challenge-1" requestedModes={["critique"]} onContributed={vi.fn()} />);

    expect(await view.findByText("setup needed")).toBeTruthy();
    expect(view.getByText("Broker smoke must pass before this connection can run.")).toBeTruthy();
    expect(view.queryByRole("checkbox")).toBeNull();
    expect(view.queryByRole("button", { name: "Start sandbox run" })).toBeNull();
    expect(view.getByText(/Manual copy\/paste remains available in Lane 1/)).toBeTruthy();
  });

  it("starts a run only after explicit approval", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/agent-home") return response(readyPayload());
      if (url === "/api/challenges/challenge-1/agent-runs" && init?.method === "POST") {
        return response({ run: { id: "run-1", status: "queued", message: "Queued." } });
      }
      return response({ run: { id: "run-1", status: "failed", message: "Stopped for test." } });
    });
    stubFetch(fetchMock);

    const view = render(<RunMyAgentPanel challengeId="challenge-1" requestedModes={["critique"]} onContributed={vi.fn()} pollIntervalMs={10000} />);

    expect(await view.findByText("ready")).toBeTruthy();
    const startButton = view.getByRole("button", { name: "Start sandbox run" }) as HTMLButtonElement;
    expect(startButton.disabled).toBe(true);

    fireEvent.click(view.getByRole("checkbox"));
    expect(startButton.disabled).toBe(false);
    fireEvent.click(startButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/challenges/challenge-1/agent-runs",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"approved":true'),
      }),
    ));
    const postCall = fetchMock.mock.calls.find(([input, init]) => String(input) === "/api/challenges/challenge-1/agent-runs" && init?.method === "POST");
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({
      approved: true,
      connectionId: "conn-ready",
      contributionMode: "critique",
    });
    expect(JSON.parse(String(postCall?.[1]?.body)).idempotencyKey).toMatch(/^challenge-1:conn-ready:critique:/);
    expect(JSON.parse(String(postCall?.[1]?.body))).not.toHaveProperty("clientIdempotencyKey");
  });

  it("reuses the same idempotency key when retrying a lost start-run response", async () => {
    let firstPost = true;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/agent-home") return response(readyPayload());
      if (url === "/api/challenges/challenge-1/agent-runs" && init?.method === "POST") {
        if (firstPost) {
          firstPost = false;
          throw new Error("lost response after server accepted request");
        }
        return response({ run: { id: "run-1", status: "queued", message: "Queued." } });
      }
      return response({ run: { id: "run-1", status: "failed", message: "Stopped for test." } });
    });
    stubFetch(fetchMock);

    const view = render(<RunMyAgentPanel challengeId="challenge-1" requestedModes={["critique"]} onContributed={vi.fn()} pollIntervalMs={10000} />);

    await view.findByText("ready");
    fireEvent.click(view.getByRole("checkbox"));
    fireEvent.click(view.getByRole("button", { name: "Start sandbox run" }));
    expect(await view.findByText("Could not start the sandbox run. You can still use manual paste.")).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Start sandbox run" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input, init]) => String(input) === "/api/challenges/challenge-1/agent-runs" && init?.method === "POST")).toHaveLength(2));
    const postBodies = fetchMock.mock.calls
      .filter(([input, init]) => String(input) === "/api/challenges/challenge-1/agent-runs" && init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)) as { idempotencyKey: string });
    expect(postBodies[1]?.idempotencyKey).toBe(postBodies[0]?.idempotencyKey);
  });

  it("polls queued/running states and reports a sandboxed contribution once", async () => {
    const onContributed = vi.fn();
    const pollResponses = [
      { run: { id: "run-1", status: "running_cell", message: "Fresh child run cell is running." } },
      {
        run: {
          id: "run-1",
          status: "contributed",
          message: "Contribution posted with sandbox provenance.",
          receiptSummary: {
            receiptId: "hr_test",
            receiptSha256: "a".repeat(64),
            sandboxProvider: "railway",
            sandboxId: "sandbox_123",
            networkIsolation: "PRIVATE",
            teardownCompleted: true,
            provider: "openrouter",
            model: "anthropic/claude-sonnet-4-20260701",
            modelDisplayName: "Claude Sonnet 4 via OpenRouter",
            providerResponseId: "provider_resp_123",
            providerModelVerified: true,
            trustLabel: "sandboxed Hermes run + provider metadata",
          },
        },
        contribution,
      },
    ];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/agent-home") return response(readyPayload());
      if (url === "/api/challenges/challenge-1/agent-runs" && init?.method === "POST") {
        return response({ run: { id: "run-1", status: "queued", message: "Run queued." }, contribution });
      }
      if (url === "/api/agent-runs/run-1") return response(pollResponses.shift() || pollResponses[pollResponses.length - 1]);
      return response({ error: "unexpected" }, 500);
    });
    stubFetch(fetchMock);

    const view = render(<RunMyAgentPanel challengeId="challenge-1" requestedModes={["critique"]} onContributed={onContributed} pollIntervalMs={1} />);

    await view.findByText("ready");
    fireEvent.click(view.getByRole("checkbox"));
    fireEvent.click(view.getByRole("button", { name: "Start sandbox run" }));

    expect(await view.findByText("contributed")).toBeTruthy();
    expect(view.getByText("Receipt-backed provenance")).toBeTruthy();
    expect(view.getByText("hr_test")).toBeTruthy();
    expect(view.getByText("Claude Sonnet 4 via OpenRouter")).toBeTruthy();
    expect(view.getByText("provider_resp_123")).toBeTruthy();
    expect(view.getByText("sandboxed Hermes run + provider metadata")).toBeTruthy();
    expect(view.getByText("Teardown")).toBeTruthy();
    expect(view.getByText("completed")).toBeTruthy();
    expect(view.getByText(/Provider-returned model metadata was attached to the signed sandbox receipt\. This is not a provider-signed receipt\./)).toBeTruthy();
    expect(view.getByText(/does not expose raw transcripts, signatures, credential references, or broker secrets/)).toBeTruthy();
    await waitFor(() => expect(onContributed).toHaveBeenCalledTimes(1));
    expect((view.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect((view.getByRole("button", { name: "Start sandbox run" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders stable failed state and keeps manual paste fallback", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/agent-home") return response(readyPayload());
      if (url === "/api/challenges/challenge-1/agent-runs" && init?.method === "POST") {
        return response({ run: { id: "run-1", status: "queued", message: "Run queued." } });
      }
      if (url === "/api/agent-runs/run-1") {
        return response({ run: { id: "run-1", status: "failed", message: "Delegation expired before the child run started.", failureCode: "delegation_expired" } });
      }
      return response({ error: "unexpected" }, 500);
    });
    stubFetch(fetchMock);

    const view = render(<RunMyAgentPanel challengeId="challenge-1" requestedModes={["critique"]} onContributed={vi.fn()} pollIntervalMs={1} />);

    await view.findByText("ready");
    fireEvent.click(view.getByRole("checkbox"));
    fireEvent.click(view.getByRole("button", { name: "Start sandbox run" }));

    expect(await view.findByText("failed")).toBeTruthy();
    expect(view.getByText("Delegation expired before the child run started.")).toBeTruthy();
    expect(view.getByText("delegation_expired")).toBeTruthy();
    expect(view.getByText(/Manual copy\/paste remains available in Lane 1/)).toBeTruthy();
  });
});
