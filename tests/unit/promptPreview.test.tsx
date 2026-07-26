// @vitest-environment jsdom
// @ts-expect-error jsdom has no local type package in this MVP test harness.
import { JSDOM } from "jsdom";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Challenge } from "@/lib/types";
import { copyPromptWarningsFromFlags } from "@/lib/safety/copyPromptSafety";

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
const { PromptPreview } = await import("@/components/contribution/PromptPreview");

function challenge(overrides: Partial<Challenge> = {}): Challenge {
  return {
    id: "challenge-1",
    createdAt: "2026-07-04T10:00:00.000Z",
    updatedAt: "2026-07-04T10:00:00.000Z",
    posterId: "poster-1",
    status: "open",
    title: "Audit risky launch plan",
    category: "strategy",
    visibility: "public",
    reward: 20,
    requestedModes: ["critique", "risk_audit", "steelman"],
    safetyFlags: [],
    contributionCount: 0,
    brief: {
      schema_version: "1.0",
      title: "Audit risky launch plan",
      category: "strategy",
      challenge_mode_requested: ["critique", "risk_audit", "steelman"],
      problem_statement: "Should we launch this plan?",
      original_ai_answer: "Launch now.",
      context: "Public-safe context.",
      constraints: [],
      success_criteria: [],
      assumptions_to_test: [],
      claims_to_check: [],
      known_risks: [],
      what_a_useful_response_should_address: [],
      privacy_sensitivity: "public_ok",
      redactions_made: [],
      abuse_or_safety_flags: [],
      missing_information: [],
      raw_material_summary: "Unit test challenge",
    },
    ...overrides,
  };
}

function jsonResponse(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
  Object.defineProperty(globals.navigator, "clipboard", { value: undefined, configurable: true });
});

afterAll(() => {
  dom.window.close();
});

describe("PromptPreview", () => {
  it("shows the generated prompt before any clipboard write", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globals.navigator, "clipboard", { value: { writeText }, configurable: true });
    globalThis.fetch = vi.fn(() => jsonResponse({ prompt: "VISIBLE_PROMPT", safetyFlags: [], safetyWarnings: [] })) as unknown as typeof fetch;

    const view = render(<PromptPreview challenge={challenge()} />);

    expect(writeText).not.toHaveBeenCalled();
    expect(await view.findByDisplayValue("VISIBLE_PROMPT")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Copy prompt" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("VISIBLE_PROMPT"));
    expect(view.getByText("Only the visible preview text was copied.")).toBeTruthy();
  });

  it("requires explicit warning review before copying risky prompts", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(globals.navigator, "clipboard", { value: { writeText }, configurable: true });
    globalThis.fetch = vi.fn(() => jsonResponse({
      prompt: "RISKY_VISIBLE_PROMPT",
      safetyFlags: ["privacy_risk", "unsafe_link"],
      safetyWarnings: copyPromptWarningsFromFlags(["privacy_risk", "unsafe_link"]),
    })) as unknown as typeof fetch;

    const view = render(<PromptPreview challenge={challenge({ safetyFlags: ["privacy_risk"] })} />);

    expect(await view.findByText("privacy risk:")).toBeTruthy();
    const blockedButton = view.getByRole("button", { name: "Review warnings to copy" }) as HTMLButtonElement;
    expect(blockedButton.disabled).toBe(true);
    expect(writeText).not.toHaveBeenCalled();

    fireEvent.click(view.getByLabelText(/I reviewed the warning list/i));
    const copyButton = view.getByRole("button", { name: "Copy prompt" }) as HTMLButtonElement;
    expect(copyButton.disabled).toBe(false);
    fireEvent.click(copyButton);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("RISKY_VISIBLE_PROMPT"));
  });

  it("requests a fresh visible prompt when the contributor changes angle", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      return jsonResponse({ prompt: url.includes("risk_audit") ? "RISK_PROMPT" : "CRITIQUE_PROMPT", safetyFlags: [], safetyWarnings: [] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const view = render(<PromptPreview challenge={challenge()} />);
    expect(await view.findByDisplayValue("CRITIQUE_PROMPT")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Risk audit" }));
    expect(await view.findByDisplayValue("RISK_PROMPT")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith("/api/challenges/challenge-1/prompt?mode=risk_audit", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
});
