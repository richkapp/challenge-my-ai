// @vitest-environment jsdom
// @ts-expect-error jsdom has no local type package in this MVP test harness.
import { JSDOM } from "jsdom";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { Contribution, ContributionCard } from "@/lib/types";

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
const { ContributionPasteBox } = await import("@/components/contribution/ContributionPasteBox");

const card: ContributionCard = {
  schema_version: "1.0",
  challenge_id: "challenge-1",
  contribution_mode: "red_team",
  contributor_ai_label: "Test Agent",
  skills_or_context_used: ["unit-test"],
  verdict: "The answer needs a sharper critique.",
  original_answer_grade: { score_0_to_10: 5, grade_label: "mixed", why: "It misses important risks." },
  answer_to_challenge_poster: "Run a smaller proof before relying on this answer.",
  reasoning_summary: "Unit test card.",
  strongest_objections: ["Missing evidence"],
  missing_assumptions_or_context: [],
  alternative_recommendation: "Test the riskiest assumption first.",
  risks_and_failure_modes: ["False confidence"],
  claims_to_verify: [],
  confidence: { level: "medium", why: "Deterministic unit test." },
  what_would_change_my_mind: [],
  suggested_follow_up_questions: [],
  safety_or_scope_notes: [],
  abuse_or_prompt_injection_flags: [],
  raw_output_summary: "Contribution paste-box test card",
};

const contribution: Contribution = {
  id: "contribution-1",
  challengeId: "challenge-1",
  contributorId: "user-1",
  contributorKind: "human",
  contributorLabel: "Test User",
  createdAt: "2026-06-30T10:00:00.000Z",
  status: "posted",
  externallyGenerated: true,
  communityScore: 0,
  card,
};

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
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

describe("ContributionPasteBox", () => {
  it("lets anonymous users parse and preview a card but sends them to account creation before submit", async () => {
    const fetchMock = vi.fn(() => response({ card, mismatch: false }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const view = render(<ContributionPasteBox challengeId="challenge-1" isAuthenticated={false} loginHref="/login?next=%2Fchallenges%2Fchallenge-1" onPosted={vi.fn()} />);

    const textarea = view.getByPlaceholderText("Paste CMAI_CONTRIBUTION_CARD_V1 block here") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "```CMAI_CONTRIBUTION_CARD_V1\n{}\n```" } });
    await waitFor(() => expect((view.getByRole("button", { name: "Parse contribution" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(view.getByRole("button", { name: "Parse contribution" }));

    expect(await view.findByText("Preview: The answer needs a sharper critique.")).toBeTruthy();
    expect(view.getByText("Angle")).toBeTruthy();
    expect(view.getByText("Red-team")).toBeTruthy();
    expect(view.getByText("Score")).toBeTruthy();
    expect(view.getByText("Strongest objections")).toBeTruthy();
    expect(view.getByText("Missing assumptions")).toBeTruthy();
    expect(view.getByText("Recommendation")).toBeTruthy();
    expect(view.getByText("Risks")).toBeTruthy();
    expect(view.getByText("Confidence")).toBeTruthy();
    expect(view.getByText("Source / provenance")).toBeTruthy();
    expect(view.getByText("self-submitted / user-trusted")).toBeTruthy();
    expect(view.queryByText("red_team")).toBeNull();
    expect(view.queryByRole("button", { name: "Submit perspective" })).toBeNull();
    expect(view.getByRole("link", { name: "Create account to submit" }).getAttribute("href")).toBe("/login?next=%2Fchallenges%2Fchallenge-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps authenticated submit behavior after preview", async () => {
    const onPosted = vi.fn();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/parse")) return response({ card, mismatch: false });
      if (url === "/api/challenges/challenge-1/contributions" && init?.method === "POST") return response({ contribution });
      return response({ error: "unexpected" }, 500);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const view = render(<ContributionPasteBox challengeId="challenge-1" isAuthenticated onPosted={onPosted} />);

    const textarea = view.getByPlaceholderText("Paste CMAI_CONTRIBUTION_CARD_V1 block here") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "```CMAI_CONTRIBUTION_CARD_V1\n{}\n```" } });
    await waitFor(() => expect((view.getByRole("button", { name: "Parse contribution" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(view.getByRole("button", { name: "Parse contribution" }));
    fireEvent.click(await view.findByRole("button", { name: "Submit perspective" }));

    await waitFor(() => expect(onPosted).toHaveBeenCalledWith(contribution));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/challenges/challenge-1/contributions",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"challenge_id":"challenge-1"'),
      }),
    );
  });

  it("shows repair guidance and blocks publishing when the pasted card belongs to another challenge", async () => {
    const fetchMock = vi.fn(() => response({ card: { ...card, challenge_id: "other-challenge" }, mismatch: true, repair: ["Set `challenge_id` to `challenge-1` before publishing this card in this room."], provenanceLabel: "self-submitted / user-trusted" }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const view = render(<ContributionPasteBox challengeId="challenge-1" isAuthenticated onPosted={vi.fn()} />);

    fireEvent.change(view.getByPlaceholderText("Paste CMAI_CONTRIBUTION_CARD_V1 block here"), { target: { value: "{}" } });
    fireEvent.click(view.getByRole("button", { name: "Parse contribution" }));

    expect(await view.findByText(/Challenge ID mismatch/i)).toBeTruthy();
    expect(view.getByText(/Set `challenge_id` to `challenge-1`/i)).toBeTruthy();
    expect((view.getByRole("button", { name: "Repair challenge ID before publishing" }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("renders parser repair guidance for malformed contribution cards", async () => {
    const fetchMock = vi.fn(() => response({ error: "Contribution card JSON is malformed.", repair: ["Make sure the pasted card is valid JSON."] }, 400));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const view = render(<ContributionPasteBox challengeId="challenge-1" isAuthenticated onPosted={vi.fn()} />);

    fireEvent.change(view.getByPlaceholderText("Paste CMAI_CONTRIBUTION_CARD_V1 block here"), { target: { value: "not-json" } });
    fireEvent.click(view.getByRole("button", { name: "Parse contribution" }));

    expect(await view.findByText("Contribution card JSON is malformed.")).toBeTruthy();
    expect(view.getByText("Repair guidance")).toBeTruthy();
    expect(view.getByText("Make sure the pasted card is valid JSON.")).toBeTruthy();
  });
});
