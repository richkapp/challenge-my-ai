// @vitest-environment jsdom
// @ts-expect-error jsdom has no local type package in this MVP test harness.
import { JSDOM } from "jsdom";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { Challenge, Contribution, SynthesisBrief } from "@/lib/types";
import {
  challengeIntentLabel,
  challengeIntentPolicy,
  challengeIntents,
  createChallengeSemantics,
  defaultSuccessCriteria,
  successfulOutcomeLabel,
  type ChallengeIntent,
} from "@/lib/challenges/intent";

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

vi.mock("next/link", () => ({
  default: ({ href, children, className }: { href: string; children: ReactNode; className?: string }) => <a className={className} href={href}>{children}</a>,
}));

const { cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
const { ChallengeFeed } = await import("@/components/challenge/ChallengeFeed");
const { ChallengeCard } = await import("@/components/challenge/ChallengeCard");

const challenge: Challenge = {
  id: "challenge-live-ui",
  createdAt: "2026-07-03T10:00:00.000Z",
  updatedAt: "2026-07-03T10:00:00.000Z",
  posterId: "poster-ui",
  status: "contributing",
  title: "Prove the live loop UI",
  category: "product",
  visibility: "public",
  reward: 30,
  requestedModes: ["critique", "risk_audit"],
  safetyFlags: [],
  contributionCount: 1,
  activeCriteriaVersion: 1,
  publicEligibility: { eligible: true, reasons: [], criteriaVersion: 1, assessedAt: "2026-07-03T10:00:00.000Z" },
  brief: {
    schema_version: "1.0",
    ...createChallengeSemantics({
      intent: "pressure_test",
      successCriteria: ["Two choices are visible", "Posted contributions can be rated", "Synthesis links to the answer artifact"],
      status: "confirmed",
      changeReason: "Confirmed live-loop fixture criteria.",
    }),
    title: "Prove the live loop UI",
    category: "product",
    challenge_mode_requested: ["critique", "risk_audit"],
    problem_statement: "Show both contribution lanes without turning provider setup into a separate lane.",
    original_ai_answer: "Hide manual paste after Agent Home exists.",
    context: "The UI should keep low-friction copy/paste and one approved trusted run side by side.",
    constraints: ["No third lane", "No silent clipboard-only preview"],
    success_criteria: ["Two choices are visible", "Posted contributions can be rated", "Synthesis links to the answer artifact"],
    assumptions_to_test: ["Trusted runs make manual paste unnecessary"],
    claims_to_check: ["Prepending trusted contributions keeps the live room fresh"],
    known_risks: ["Provider plumbing jargon leaks into public copy"],
    what_a_useful_response_should_address: ["lane choice", "rating controls", "answer artifact"],
    privacy_sensitivity: "public_ok",
    redactions_made: [],
    abuse_or_safety_flags: [],
    missing_information: [],
    raw_material_summary: "ChallengeFeed live-loop UI fixture",
  },
};

function contribution(id: string, verdict: string, contributorKind: "human" | "agent", source?: "client_attested" | "hermes_sandbox_run"): Contribution {
  return {
    id,
    challengeId: challenge.id,
    contributorId: `${id}-author`,
    contributorKind,
    contributorLabel: contributorKind === "agent" ? "Trusted UI Agent" : "Manual UI Contributor",
    createdAt: id === "trusted-ui-contribution" ? "2026-07-03T10:02:00.000Z" : "2026-07-03T10:01:00.000Z",
    status: "posted",
    externallyGenerated: true,
    communityScore: 0,
    card: {
      schema_version: "1.0",
      challenge_id: challenge.id,
      contribution_mode: contributorKind === "agent" ? "critique" : "risk_audit",
      contributor_ai_label: contributorKind === "agent" ? "Trusted UI Agent" : "Manual UI Agent",
      model_provenance: source ? {
        source,
        provider: source === "hermes_sandbox_run" ? "local_fake" : "manual-ui",
        model: source === "hermes_sandbox_run" ? "fake-frontier-model" : "manual-ui-model",
        model_display_name: source === "hermes_sandbox_run" ? "Fake Frontier Model" : "Manual UI Model",
        adapter: source === "hermes_sandbox_run" ? "hermes_sandbox" : "manual_copy_paste",
        verified: source === "hermes_sandbox_run",
        verification_notes: source === "hermes_sandbox_run" ? "Signed sandbox receipt attached." : "Self-attested manual paste.",
        receipt_id: source === "hermes_sandbox_run" ? "hr_ui" : undefined,
        receipt_sha256: source === "hermes_sandbox_run" ? "a".repeat(64) : undefined,
        sandbox_provider: source === "hermes_sandbox_run" ? "local_fake" : undefined,
        sandbox_network_isolation: source === "hermes_sandbox_run" ? "ISOLATED" : undefined,
        sandbox_teardown_completed: source === "hermes_sandbox_run" ? true : undefined,
      } : undefined,
      skills_or_context_used: ["unit-test"],
      verdict,
      original_answer_grade: { score_0_to_10: 5, grade_label: "mixed", why: "Needs more pressure testing." },
      answer_to_challenge_poster: "Keep manual paste available and show trusted-run provenance only after approval.",
      reasoning_summary: "UI fixture contribution.",
      strongest_objections: ["Manual paste should remain available."],
      missing_assumptions_or_context: [],
      alternative_recommendation: "Show both lanes, then rate and synthesize useful contributions.",
      risks_and_failure_modes: ["Public copy might imply provider proof."],
      claims_to_verify: ["Contribution prepends into the live room."],
      confidence: { level: "medium", why: "Deterministic UI fixture." },
      what_would_change_my_mind: [],
      suggested_follow_up_questions: [],
      safety_or_scope_notes: ["Challenge text stayed inert."],
      abuse_or_prompt_injection_flags: [],
      raw_output_summary: "UI fixture card",
    },
  };
}

const existingContribution = contribution("manual-ui-contribution", "Existing manual perspective stays visible.", "human", "client_attested");
const trustedContribution = contribution("trusted-ui-contribution", "Trusted run perspective appears first.", "agent", "hermes_sandbox_run");

const synthesis: SynthesisBrief = {
  id: "synthesis-live-ui",
  challengeId: challenge.id,
  createdAt: "2026-07-03T10:05:00.000Z",
  improvedAnswer: "Keep both contribution lanes visible, rate useful contributions, then open the answer artifact.",
  whatChanged: ["The answer now keeps both lanes visible before synthesis."],
  strongestObjections: ["Manual paste should remain available."],
  risks: ["Provider proof copy can overclaim."],
  confidence: "medium",
  unresolvedDisagreements: ["How much provenance detail belongs in the room."],
  nextTests: ["Run the local live-loop smoke."],
  jobId: "job-live-ui",
};

function challengeForIntent(intent: ChallengeIntent, overrides: Partial<Challenge> = {}): Challenge {
  const criteria = defaultSuccessCriteria(intent);
  const title = `${challengeIntentLabel(intent)} fixture`;
  return {
    ...challenge,
    id: `challenge-${intent}`,
    title,
    status: "open",
    contributionCount: 0,
    brief: {
      ...challenge.brief,
      ...createChallengeSemantics({ intent, successCriteria: criteria, status: "confirmed", changeReason: `Confirmed ${intent} presentation criteria.` }),
      title,
      success_criteria: criteria,
    },
    publicEligibility: { eligible: true, reasons: [], criteriaVersion: 1, assessedAt: "2026-07-03T10:00:00.000Z" },
    ...overrides,
  };
}

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

describe("ChallengeFeed live-loop interactions", () => {
  it("keeps both lanes visible, prepends trusted contributions, and exposes rating plus synthesis affordances", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(`/api/challenges/${challenge.id}/prompt`)) return response({ prompt: "Visible CMAI_CONTRIBUTION_CARD_V1 prompt", mode: "critique", safetyFlags: [] });
      if (url === "/api/agent-home") return response({
        ready: true,
        connection: { id: "conn-live-ui", status: "ready", providerLabel: "Local fake", modelLabel: "Fake Frontier Model", trustLabel: "sandbox-recorded" },
        readiness: { status: "ready", message: "Agent Home is ready." },
      });
      if (url === `/api/challenges/${challenge.id}/agent-runs` && init?.method === "POST") return response({
        run: {
          id: "run-live-ui",
          status: "contributed",
          message: "Contribution posted with sandbox provenance.",
          receiptSummary: {
            receiptId: "hr_ui",
            receiptSha256: "a".repeat(64),
            sandboxProvider: "local_fake",
            networkIsolation: "ISOLATED",
            teardownCompleted: true,
            provider: "local_fake",
            model: "fake-frontier-model",
            modelDisplayName: "Fake Frontier Model",
            providerModelVerified: false,
            trustLabel: "sandboxed Hermes run",
          },
        },
        contribution: trustedContribution,
      });
      if (url === `/api/contributions/${existingContribution.id}/ratings` && init?.method === "POST") return response({
        rating: { id: "rating-live-ui", contributionId: existingContribution.id, raterId: challenge.posterId, usefulness: 9, novelty: 9, correctness: 9, safety: 5, comment: "Useful", createdAt: "2026-07-03T10:03:00.000Z" },
        creditDelta: 20,
        creditTotal: 20,
      });
      if (url === `/api/contributions/${existingContribution.id}/community-votes` && init?.method === "POST") return response({
        contribution: { ...existingContribution, communityScore: 1 },
        vote: { counted: true, reason: "counted", scoreDelta: 1, message: "Community vote counted for visibility and trust only. Poster rewards decide credits.", policy: { affectsCredits: false, influence: "visibility_trust_tiebreaker", countedVoteWeight: 1, maxTieBreakerCommunityScore: 99 } },
      });
      if (url === `/api/challenges/${challenge.id}/synthesis` && init?.method === "POST") return response({ synthesis, artifactUrl: `/answers/${challenge.id}` });
      return response({ error: "unexpected fetch" }, 500);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const view = render(<ChallengeFeed initialChallenge={challenge} initialContributions={[existingContribution]} isAuthenticated isPoster />);

    expect(await view.findByDisplayValue("Visible CMAI_CONTRIBUTION_CARD_V1 prompt")).toBeTruthy();
    expect(view.getByText("Choose a path.")).toBeTruthy();
    expect(view.getAllByText("Pressure-test a plan").length).toBeGreaterThan(0);
    expect(view.getAllByText("Criteria confirmed").length).toBeGreaterThan(0);
    expect(view.getByText("What would move this challenge?")).toBeTruthy();
    expect(view.getByText(/30 credits declared for poster-confirmed impact/)).toBeTruthy();
    expect(view.getByText("Copy the prompt")).toBeTruthy();
    expect(view.getAllByText("Run my Agent here").length).toBeGreaterThan(0);
    expect(view.getByText("Paste the result")).toBeTruthy();
    expect(view.getByText("Useful")).toBeTruthy();
    expect(view.getByText("Mixed")).toBeTruthy();
    expect(view.getByText("Unsafe/low value")).toBeTruthy();
    expect(view.getByText("community +")).toBeTruthy();
    expect(view.getByText("community -")).toBeTruthy();
    expect(view.getByText(/Poster usefulness and safety settle reward credits/i)).toBeTruthy();
    expect(view.getByText(/Community votes affect visibility and trust only/i)).toBeTruthy();

    fireEvent.click(view.getByText("Useful"));
    await waitFor(() => expect(view.getByText(/Credit delta: 20/)).toBeTruthy());
    fireEvent.click(view.getByText("community +"));
    await waitFor(() => expect(view.getByText(/visibility and trust only/i)).toBeTruthy());

    await view.findByText("ready");
    fireEvent.click(view.getByLabelText(/I approve one sandbox run/i));
    fireEvent.click(view.getByRole("button", { name: "Start sandbox run" }));

    expect((await view.findAllByText("Trusted run perspective appears first.")).length).toBeGreaterThan(0);
    expect(view.getByText("Receipt-backed provenance")).toBeTruthy();
    expect(view.getAllByText("hr_ui").length).toBeGreaterThan(0);
    expect(view.getByText("Broker proof")).toBeTruthy();
    expect(view.getAllByText("Teardown").length).toBeGreaterThan(0);
    expect(view.getAllByText("completed").length).toBeGreaterThan(0);
    expect(view.getAllByText(/Proof limits:/).length).toBeGreaterThan(0);

    const perspectives = document.querySelector("#agent-perspectives");
    const perspectiveText = perspectives?.textContent || "";
    expect(perspectiveText.indexOf("Trusted run perspective appears first.")).toBeLessThan(perspectiveText.indexOf("Existing manual perspective stays visible."));

    fireEvent.click(view.getByRole("button", { name: "Update answer" }));
    await waitFor(() => expect(view.getByText(`Decision artifact ready at /answers/${challenge.id}.`)).toBeTruthy());
    expect(view.getByRole("link", { name: "Open final answer" }).getAttribute("href")).toBe(`/answers/${challenge.id}`);

    const postCall = fetchMock.mock.calls.find(([input, init]) => String(input) === `/api/challenges/${challenge.id}/agent-runs` && init?.method === "POST");
    expect(JSON.parse(String(postCall?.[1]?.body))).toMatchObject({ approved: true, connectionId: "conn-live-ui", contributionMode: "critique" });
  });
});

describe("public challenge semantics presentation", () => {
  for (const intentName of challengeIntents) {
    it(`renders canonical ${intentName} semantics without treating activity as the outcome`, () => {
      const fixture = challengeForIntent(intentName);
      const view = render(<ChallengeCard challenge={fixture} />);
      const text = view.container.textContent || "";

      expect(text).toContain(challengeIntentLabel(intentName));
      expect(text).toContain("Criteria confirmed");
      expect(text).toContain("Permitted recorded outcome:");
      for (const outcome of challengeIntentPolicy(intentName).successfulOutcomes) expect(text).toContain(successfulOutcomeLabel(outcome));
      expect(text).toContain("Requested perspectives");
      expect(text).toContain("Constraints");
      expect(text).toContain("Declared missing information");
      expect(text).toContain("Marked public-safe");
      expect(text).toContain("Poster-confirmed impact");
      expect(text).toContain("No credit reservation or settlement is represented.");
    });
  }

  it("bounds long hostile criteria behind an explicit expansion and renders hostile text inertly", () => {
    const criteria = [
      `Material risks are ranked while <script>window.pwned=true</script> remains inert. ${"x".repeat(105)}`,
      `Each material finding has a disposition; <img src=x onerror=window.pwned=true> is data only. ${"y".repeat(95)}`,
    ];
    const hostile = challengeForIntent("pressure_test", {
      id: "hostile-public-card",
      title: "<img src=x onerror=alert(1)> hostile title",
      brief: {
        ...challenge.brief,
        ...createChallengeSemantics({ intent: "pressure_test", successCriteria: criteria, status: "confirmed", changeReason: "Confirmed hostile rendering fixture criteria." }),
        title: "<img src=x onerror=alert(1)> hostile title",
        success_criteria: criteria,
        constraints: ["<script>do-not-run()</script> is an inert constraint"],
        missing_information: ["<iframe src=https://attacker.example> is inert missing information"],
      },
    });

    const view = render(<ChallengeCard challenge={hostile} />);
    const text = view.container.textContent || "";
    const previewItem = view.container.querySelector('[aria-label="Active success or closure criteria preview"] li');

    expect(view.container.querySelector("script, img, iframe")).toBeNull();
    expect(text).toContain("<script>window.pwned=true</script>");
    expect(text).toContain("<script>do-not-run()</script>");
    expect(text).toContain("Show all 2 active criteria");
    expect(previewItem?.classList.contains("line-clamp-2")).toBe(true);
  });

  it("omits private and explicitly public-ineligible challenge data", () => {
    const solve = challengeForIntent("solve");
    const privateChallenge: Challenge = {
      ...solve,
      visibility: "private",
      title: "PRIVATE-MARKER",
      brief: { ...solve.brief, title: "PRIVATE-MARKER", problem_statement: "PRIVATE-PROBLEM-MARKER" },
    };
    const ineligibleChallenge: Challenge = {
      ...solve,
      id: "ineligible-public-challenge",
      title: "INELIGIBLE-MARKER",
      brief: { ...solve.brief, title: "INELIGIBLE-MARKER", problem_statement: "INELIGIBLE-PROBLEM-MARKER" },
      publicEligibility: { eligible: false, reasons: ["private_only"], criteriaVersion: 1, assessedAt: "2026-07-03T10:00:00.000Z" },
    };

    const card = render(<><ChallengeCard challenge={privateChallenge} /><ChallengeCard challenge={ineligibleChallenge} /></>);
    expect(card.container.textContent).not.toContain("PRIVATE-MARKER");
    expect(card.container.textContent).not.toContain("INELIGIBLE-MARKER");

    const detail = render(<ChallengeFeed initialChallenge={ineligibleChallenge} initialContributions={[]} />);
    expect(detail.getByText("Challenge is not available for public display.")).toBeTruthy();
    expect(detail.container.textContent).not.toContain("INELIGIBLE-PROBLEM-MARKER");
  });

  it("keeps legacy unconfirmed records factual even with high reward, activity, closure state, and synthesis", async () => {
    const legacyBrief: Challenge["brief"] = {
      schema_version: "1.0",
      ...createChallengeSemantics({
        intent: "pressure_test",
        successCriteria: ["Material risks are identified", "Each material risk receives a disposition"],
        status: "criteria_unconfirmed",
        changeReason: "Legacy fixture requires poster confirmation.",
      }),
      title: "Legacy unconfirmed record",
      category: "product",
      challenge_mode_requested: ["critique"],
      problem_statement: "A legacy record has activity but no poster-confirmed criteria.",
      original_ai_answer: "Treat the activity as proof of success.",
      context: "Legacy compatibility fixture.",
      constraints: ["Do not infer closure from engagement"],
      success_criteria: ["Material risks are identified", "Each material risk receives a disposition"],
      assumptions_to_test: [],
      claims_to_check: [],
      known_risks: [],
      what_a_useful_response_should_address: [],
      privacy_sensitivity: "public_ok",
      redactions_made: [],
      abuse_or_safety_flags: [],
      missing_information: ["Poster confirmation is missing"],
      raw_material_summary: "Legacy criteria compatibility fixture",
    };
    const legacyChallenge: Challenge = {
      ...challenge,
      id: "legacy-unconfirmed",
      title: legacyBrief.title,
      status: "closed",
      reward: 999,
      contributionCount: 999,
      brief: legacyBrief,
      activeCriteriaVersion: 1,
      publicEligibility: { eligible: false, reasons: ["criteria_unconfirmed"], criteriaVersion: 1, assessedAt: "2026-07-03T10:00:00.000Z" },
    };
    globalThis.fetch = vi.fn(() => response({
      prompt: "Legacy unconfirmed prompt",
      mode: "critique",
      safetyFlags: [],
      ready: false,
      readiness: { status: "setup_required", message: "Agent Home setup is not part of this rendering test." },
    })) as unknown as typeof fetch;

    const card = render(<ChallengeCard challenge={legacyChallenge} />);
    expect(card.container.textContent).toBe("");

    const detail = render(<ChallengeFeed initialChallenge={legacyChallenge} initialContributions={[existingContribution]} initialSynthesis={{ ...synthesis, challengeId: legacyChallenge.id }} />);
    const text = detail.container.textContent || "";
    expect(text).toContain("Criteria need confirmation");
    expect(text).toContain("No successful outcome can be recorded until the active criteria are confirmed.");
    expect(text).toContain("Read-only compatibility view");
    expect(text).toContain("Existing manual perspective stays visible.");
    expect(text).not.toContain("What survived so far");
    expect(text).not.toContain("Open decision artifact");
    expect(detail.queryByDisplayValue("Legacy unconfirmed prompt")).toBeNull();
    expect(text).not.toContain("Permitted recorded outcome");
    expect(text).not.toContain("Review Complete");
    expect(detail.queryByRole("link", { name: "Open final answer" })).toBeNull();
  });

  it("renders completion-bonus posture by intent without implying settlement", () => {
    const eligible = render(<ChallengeCard challenge={challengeForIntent("solve")} />);
    expect(eligible.container.textContent).toContain("May be considered after poster-confirmed completion");
    expect(eligible.container.textContent).toContain("Declarative only");
    eligible.unmount();

    const notApplicable = render(<ChallengeCard challenge={challengeForIntent("pressure_test")} />);
    expect(notApplicable.container.textContent).toContain("Not applicable for this intent");
    expect(notApplicable.container.textContent).toContain("Impact tiers are reward-review labels, not closure outcomes.");
  });
});
