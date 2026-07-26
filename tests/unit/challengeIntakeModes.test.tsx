// @vitest-environment jsdom
// @ts-expect-error jsdom has no local type package in this MVP test harness.
import { JSDOM } from "jsdom";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ChallengeBrief } from "@/lib/types";
import { createChallengeSemantics, defaultSuccessCriteria } from "@/lib/challenges/intent";

vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("not_found"); },
  useRouter: () => ({ push: vi.fn() }),
}));

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
const { ChallengeIntake } = await import("@/components/challenge/ChallengeIntake");

const confirmedCriteria = defaultSuccessCriteria("pressure_test");
const brief: ChallengeBrief = {
  schema_version: "1.0",
  ...createChallengeSemantics({ intent: "pressure_test", successCriteria: confirmedCriteria, status: "confirmed", changeReason: "Confirmed intake fixture criteria." }),
  title: "Perspective test",
  category: "product",
  challenge_mode_requested: ["critique"],
  problem_statement: "Pressure-test this answer.",
  original_ai_answer: "Ship it unchanged.",
  context: "Unit test context.",
  constraints: [],
  success_criteria: confirmedCriteria,
  assumptions_to_test: [],
  claims_to_check: [],
  known_risks: [],
  what_a_useful_response_should_address: [],
  privacy_sensitivity: "public_ok",
  redactions_made: [],
  abuse_or_safety_flags: [],
  missing_information: [],
  raw_material_summary: "Unit test brief",
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

describe("ChallengeIntake requested perspectives", () => {
  it("lets posters start from launch wedge templates without a long form", () => {
    const view = render(<ChallengeIntake />);

    fireEvent.click(view.getByRole("button", { name: /Feature spec review/i }));

    const textarea = view.getByLabelText("Problem and current AI answer") as HTMLTextAreaElement;
    expect(textarea.value).toContain("I need to decide whether this feature spec is strong enough to build next");
    expect(textarea.value).toContain("My Agent's current answer:");
    expect(textarea.value).toContain("Remove customer names, private metrics, roadmap secrets");
  });

  it("renders a capped normal picker that hides judge", async () => {
    globalThis.fetch = vi.fn(() => response({ brief, policy: { blockers: [], warnings: [], safetyFlags: [] } })) as unknown as typeof fetch;

    const view = render(<ChallengeIntake />);
    fireEvent.click(view.getByRole("button", { name: "Structure post" }));

    expect((await view.findAllByText("Requested perspectives")).length).toBeGreaterThan(0);
    expect(view.getByText("Pick up to 3 useful angles.")).toBeTruthy();
    expect(view.getByRole("button", { name: "Critique" }).getAttribute("aria-pressed")).toBe("true");
    expect(view.queryByRole("button", { name: "Judge" })).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Red-team" }));
    fireEvent.click(view.getByRole("button", { name: "Alternate proposal" }));
    expect((view.getByRole("button", { name: "Risk audit" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps critique selected when the user tries to remove the last normal perspective", async () => {
    globalThis.fetch = vi.fn(() => response({ brief, policy: { blockers: [], warnings: [], safetyFlags: [] } })) as unknown as typeof fetch;

    const view = render(<ChallengeIntake />);
    fireEvent.click(view.getByRole("button", { name: "Structure post" }));
    const critique = await view.findByRole("button", { name: "Critique" });

    fireEvent.click(critique);
    expect(view.getByRole("button", { name: "Critique" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("renders all seven intents and requires explicit criteria confirmation for modern drafts", async () => {
    const unconfirmedCriteria = defaultSuccessCriteria("decide");
    const unconfirmedBrief: ChallengeBrief = {
      ...brief,
      ...createChallengeSemantics({ intent: "decide", successCriteria: unconfirmedCriteria, status: "criteria_unconfirmed", changeReason: "Agent proposed criteria for review." }),
      success_criteria: unconfirmedCriteria,
    };
    globalThis.fetch = vi.fn(() => response({ brief: unconfirmedBrief, policy: { blockers: [], warnings: [], safetyFlags: [] } })) as unknown as typeof fetch;

    const view = render(<ChallengeIntake />);
    fireEvent.click(view.getByRole("button", { name: "Structure post" }));

    const intentSelect = await view.findByRole("combobox", { name: "Challenge intent" });
    expect(intentSelect.querySelectorAll("option")).toHaveLength(7);
    expect((intentSelect as HTMLSelectElement).value).toBe("decide");
    expect(view.getAllByText("Criteria need confirmation").length).toBeGreaterThan(0);
    expect(view.getByText("Publication confirmation")).toBeTruthy();
    expect(view.getByText("Declared missing information")).toBeTruthy();
    expect(view.getByText("Marked public-safe")).toBeTruthy();
    expect(view.getByText("Declarative reward posture")).toBeTruthy();
    expect(view.getByText("May be considered after poster-confirmed completion")).toBeTruthy();
    expect(view.getByText(/No credit reservation or settlement is represented/)).toBeTruthy();
    expect((view.getByRole("button", { name: "Resolve safety review" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(view.getByLabelText(/I confirm these criteria are attainable/));
    expect(view.getAllByText("Criteria confirmed").length).toBeGreaterThan(0);
    await waitFor(() => expect((view.getByRole("button", { name: "Publish challenge" }) as HTMLButtonElement).disabled).toBe(false));

    fireEvent.change(view.getByRole("textbox", { name: "Title" }), { target: { value: "Changed after review" } });
    expect(view.getAllByText("Criteria need confirmation").length).toBeGreaterThan(0);
    expect((view.getByRole("button", { name: "Resolve safety review" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("surfaces similar decision artifacts after structuring a draft", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/challenges/parse") return response({ brief, policy: { blockers: [], warnings: [], safetyFlags: [] } });
      if (url === "/api/answers" && init?.method === "POST") return response({
        artifacts: [
          {
            id: "artifact-1",
            title: "Prior builder beta decision",
            category: "product",
            artifactUrl: "/answers/artifact-1",
            debateUrl: "/challenges/artifact-1",
            shareSummary: "Current answer: start with a narrower builder beta.",
            currentBestAnswer: "Start with a narrower builder beta.",
            reusePrompt: "Use this prior Challenge My AI decision artifact as context.",
            matchReasons: ["problem", "risk"],
          },
        ],
      });
      return response({ error: "unexpected" }, 500);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const view = render(<ChallengeIntake />);
    fireEvent.click(view.getByRole("button", { name: "Structure post" }));

    expect(await view.findByText("Similar decision artifacts")).toBeTruthy();
    expect(view.getByText("Prior builder beta decision")).toBeTruthy();
    expect(view.getByRole("link", { name: "Open artifact" }).getAttribute("href")).toBe("/answers/artifact-1");
    expect(view.getByRole("button", { name: "Copy reuse prompt" })).toBeTruthy();
    const relatedCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/answers");
    expect(relatedCall?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(relatedCall?.[1]?.body))).toEqual(expect.objectContaining({ includePrompt: true, limit: 3 }));
    expect(String(relatedCall?.[1]?.body)).not.toContain(brief.problem_statement);
  });

  it("does not search artifacts for drafts blocked by privacy review", async () => {
    const privateBrief = { ...brief, privacy_sensitivity: "private_only" as const, problem_statement: "Customer secret ACME-123 should not enter URLs." };
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/challenges/parse") return response({ brief: privateBrief, policy: { blockers: ["private_only"], warnings: [], safetyFlags: [] } });
      return response({ error: "unexpected" }, 500);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const view = render(<ChallengeIntake />);
    fireEvent.click(view.getByRole("button", { name: "Structure post" }));

    expect(await view.findByText(/Similar artifact search is off/)).toBeTruthy();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain("/api/answers");
    expect(fetchMock.mock.calls.map(([input]) => String(input)).join(" ")).not.toContain("ACME-123");
  });

  it("normalizes legacy or over-cap requested modes before publishing", async () => {
    const legacyBrief: ChallengeBrief = {
      ...brief,
      challenge_mode_requested: ["judge", "critique", "red_team", "alternate_proposal", "risk_audit"],
    };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/challenges/parse") return response({ brief: legacyBrief, policy: { blockers: [], warnings: [], safetyFlags: [] } });
      if (url === "/api/challenges") return response({ challenge: { id: "challenge-1" }, policy: { blockers: [], warnings: [], safetyFlags: [] } });
      return response({ error: "unexpected" }, 500);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const view = render(<ChallengeIntake />);
    fireEvent.click(view.getByRole("button", { name: "Structure post" }));

    expect((await view.findByRole("button", { name: "Critique" })).getAttribute("aria-pressed")).toBe("true");
    expect(view.getByRole("button", { name: "Red-team" }).getAttribute("aria-pressed")).toBe("true");
    expect(view.getByRole("button", { name: "Alternate proposal" }).getAttribute("aria-pressed")).toBe("true");
    expect(view.queryByRole("button", { name: "Judge" })).toBeNull();
    expect((view.getByRole("button", { name: "Risk audit" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(view.getByLabelText(/I confirm these criteria are attainable/));
    await waitFor(() => expect((view.getByRole("button", { name: "Publish challenge" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(view.getByRole("button", { name: "Publish challenge" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/challenges",
      expect.objectContaining({ method: "POST" }),
    ));
    const postCall = fetchMock.mock.calls.find(([input]) => String(input) === "/api/challenges");
    expect(JSON.parse(String(postCall?.[1]?.body)).brief.challenge_mode_requested).toEqual(["critique", "red_team", "alternate_proposal"]);
  });

  it("shows public-safety override state before publish", async () => {
    const needsReviewBrief: ChallengeBrief = { ...brief, privacy_sensitivity: "unknown" };
    globalThis.fetch = vi.fn(() => response({ brief: needsReviewBrief, policy: { blockers: ["confirmPrivacyOverride is required before posting this brief publicly."], warnings: ["privacy sensitivity requires explicit public-post override."], safetyFlags: [] } })) as unknown as typeof fetch;

    const view = render(<ChallengeIntake />);
    fireEvent.click(view.getByRole("button", { name: "Structure post" }));

    fireEvent.click(await view.findByLabelText(/I confirm these criteria are attainable/));
    expect(await view.findByText("Public-safety review needs your explicit override.")).toBeTruthy();
    const blockedPublish = view.getByRole("button", { name: "Resolve safety review" }) as HTMLButtonElement;
    expect(blockedPublish.disabled).toBe(true);

    fireEvent.click(view.getByLabelText(/I reviewed privacy/));
    expect(view.getByText("Override recorded for public posting warnings.")).toBeTruthy();
    await waitFor(() => expect((view.getByRole("button", { name: "Publish challenge" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("keeps private-only drafts gated even if the reviewer checkbox is checked", async () => {
    const privateBrief: ChallengeBrief = { ...brief, privacy_sensitivity: "private_only" };
    globalThis.fetch = vi.fn(() => response({ brief: privateBrief, policy: { blockers: ["private_only briefs cannot be posted publicly."], warnings: [], safetyFlags: [] } })) as unknown as typeof fetch;

    const view = render(<ChallengeIntake />);
    fireEvent.click(view.getByRole("button", { name: "Structure post" }));

    expect(await view.findByText("Cannot publish this as a public challenge yet.")).toBeTruthy();
    fireEvent.click(view.getByLabelText(/I reviewed privacy/));
    expect((view.getByRole("button", { name: "Resolve safety review" }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.getByText(/private\/deep rooms are not live yet/)).toBeTruthy();
  });
});
