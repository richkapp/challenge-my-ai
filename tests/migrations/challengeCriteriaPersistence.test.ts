import { beforeEach, describe, expect, it } from "vitest";
import { migrateChallengeCriteriaState } from "@/db/migrations/challenge-criteria-v1";
import { createChallengeSemantics, defaultSuccessCriteria, reviseChallengeCriteria } from "@/lib/challenges/intent";
import {
  createChallenge,
  createContribution,
  evaluateChallengeClosure,
  getChallengeCriteriaHistory,
  listContributions,
  listCreditEvents,
  resetStoreForTests,
  updateChallengeCriteria,
} from "@/lib/store/local";
import * as postgresStore from "@/lib/store/postgres";
import type { Challenge, ChallengeBrief, Contribution, ContributionCard } from "@/lib/types";

function legacyBrief(overrides: Partial<ChallengeBrief> = {}): ChallengeBrief {
  return {
    schema_version: "1.0",
    title: "Persist criteria safely",
    category: "product",
    challenge_mode_requested: ["critique"],
    problem_statement: "Keep challenge criteria attached to the version contributors reviewed.",
    original_ai_answer: "Treat the latest prose as the only criteria.",
    context: "Migration fixture.",
    constraints: ["Do not rewrite prior contributions"],
    success_criteria: ["Historical contributions remain bound to their submitted criteria version."],
    assumptions_to_test: [],
    claims_to_check: [],
    known_risks: [],
    what_a_useful_response_should_address: ["version history"],
    privacy_sensitivity: "public_ok",
    redactions_made: [],
    abuse_or_safety_flags: [],
    missing_information: ["Whether any contribution predates the migration"],
    raw_material_summary: "Criteria persistence migration fixture",
    ...overrides,
  };
}

function modernBrief(intent: "solve" | "pressure_test" = "solve"): ChallengeBrief {
  const criteria = defaultSuccessCriteria(intent);
  return {
    ...legacyBrief({
      challenge_mode_requested: ["critique", "risk_audit"],
      success_criteria: criteria,
      missing_information: [],
    }),
    ...createChallengeSemantics({
      intent,
      successCriteria: criteria,
      status: "confirmed",
      changeReason: "Poster confirmed the initial criteria.",
    }),
  };
}

function card(challengeId: string): ContributionCard {
  return {
    schema_version: "1.0",
    challenge_id: challengeId,
    contribution_mode: "critique",
    contributor_ai_label: "Test Agent",
    skills_or_context_used: [],
    verdict: "Version the criteria before evaluating closure.",
    original_answer_grade: { score_0_to_10: 6, grade_label: "mixed", why: "The draft ignores history." },
    answer_to_challenge_poster: "Persist immutable criteria snapshots.",
    reasoning_summary: "Contributions need the criteria version that was active when they were submitted.",
    strongest_objections: [],
    missing_assumptions_or_context: [],
    alternative_recommendation: "Append criteria versions and bind contributions to the active version.",
    risks_and_failure_modes: [],
    claims_to_verify: [],
    confidence: { level: "high", why: "The invariant is deterministic." },
    what_would_change_my_mind: [],
    suggested_follow_up_questions: [],
    safety_or_scope_notes: [],
    abuse_or_prompt_injection_flags: [],
    raw_output_summary: "Persist versioned criteria.",
  };
}

function storedChallenge(brief: ChallengeBrief, overrides: Partial<Challenge> = {}): Challenge {
  return {
    id: "legacy-challenge",
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-03T12:00:00.000Z",
    posterId: "poster",
    status: "synthesized",
    title: brief.title,
    category: brief.category,
    visibility: "public",
    reward: 20,
    requestedModes: brief.challenge_mode_requested,
    brief,
    safetyFlags: [],
    contributionCount: 9,
    ...overrides,
  };
}

function storedContribution(challengeId: string): Contribution {
  return {
    id: "legacy-contribution",
    challengeId,
    contributorId: "critic",
    contributorKind: "human",
    contributorLabel: "Critic",
    createdAt: "2026-06-02T10:00:00.000Z",
    status: "posted",
    externallyGenerated: true,
    card: card(challengeId),
    communityScore: 99,
  };
}

describe("challenge criteria persistence migration", () => {
  beforeEach(() => resetStoreForTests());

  it("maps legacy rows to an explicit unconfirmed version without inferring success from activity or prose", () => {
    const challenge = storedChallenge(legacyBrief());
    const migration = migrateChallengeCriteriaState({
      challenges: [challenge],
      contributions: [storedContribution(challenge.id)],
    });

    expect(migration.state.challenges[0]).toMatchObject({
      activeCriteriaVersion: 1,
      publicEligibility: {
        eligible: false,
        reasons: ["criteria_unconfirmed"],
        criteriaVersion: 1,
      },
      brief: {
        challenge_intent: "pressure_test",
        criteria_status: "criteria_unconfirmed",
        criteria_version: 1,
      },
    });
    expect(migration.state.challengeCriteriaVersions).toEqual([
      expect.objectContaining({
        challengeId: challenge.id,
        version: 1,
        effectiveAt: challenge.createdAt,
        effectiveAtSource: "challenge_created_at",
        criteriaStatus: "criteria_unconfirmed",
        requestedPerspectives: ["critique"],
        constraints: ["Do not rewrite prior contributions"],
        missingInformation: ["Whether any contribution predates the migration"],
        sensitivity: "public_ok",
        rewardPosture: expect.objectContaining({ funding_state: "declarative_only" }),
      }),
    ]);
    expect(migration.state.contributions[0]).toMatchObject({
      criteriaVersion: 1,
      criteriaStatusAtSubmission: "criteria_unconfirmed",
    });
    expect(migration.report).toMatchObject({ migratedChallenges: 1, quarantinedChallenges: 0 });
  });

  it("is deterministic and idempotent when the migration is repeated", () => {
    const first = migrateChallengeCriteriaState({
      challenges: [storedChallenge(legacyBrief())],
      contributions: [storedContribution("legacy-challenge")],
    });
    const second = migrateChallengeCriteriaState(first.state);

    expect(second.state).toEqual(first.state);
    expect(second.report).toMatchObject({ migratedChallenges: 0, quarantinedChallenges: 0 });
  });

  it("keeps unknown legacy snapshot fields explicit and does not guess a historical contribution version", () => {
    const evolved = reviseChallengeCriteria(modernBrief("solve"), {
      intent: "solve",
      successCriteria: ["The revised result is observed without regression."],
      status: "confirmed",
      contributionCount: 1,
      changeReason: "A historical revision whose exact effective time was not persisted.",
    });
    const challenge = storedChallenge(evolved, { id: "versioned-legacy" });

    const migration = migrateChallengeCriteriaState({
      challenges: [challenge],
      contributions: [storedContribution(challenge.id)],
    });

    expect(migration.state.challengeCriteriaVersions).toEqual([
      expect.objectContaining({
        version: 1,
        snapshotFidelity: "legacy_partial",
        requestedPerspectives: null,
        constraints: null,
        missingInformation: null,
        sensitivity: null,
        publicEligibility: null,
      }),
      expect.objectContaining({ version: 2, snapshotFidelity: "exact" }),
    ]);
    expect(migration.state.contributions[0]).toMatchObject({ criteriaVersion: null, criteriaStatusAtSubmission: null });
    expect(migration.report.boundContributions).toBe(0);
  });

  it("quarantines malformed semantic records without poisoning valid rows", () => {
    const malformed = storedChallenge({
      ...legacyBrief({ title: "Malformed" }),
      challenge_semantics_version: "1.0",
      challenge_intent: "solve",
    } as ChallengeBrief, { id: "malformed", title: "Malformed" });
    const valid = storedChallenge(modernBrief(), { id: "valid", status: "open", contributionCount: 0 });

    const migration = migrateChallengeCriteriaState({ challenges: [malformed, valid], contributions: [] });

    expect(migration.state.challengeCriteriaQuarantine).toEqual([
      expect.objectContaining({ challengeId: "malformed", reason: "invalid_semantics" }),
    ]);
    expect(migration.state.challenges.find((item) => item.id === "valid")).toMatchObject({
      activeCriteriaVersion: 1,
      publicEligibility: { eligible: true, reasons: [] },
    });
    expect(migration.state.challengeCriteriaVersions.some((entry) => entry.challengeId === "valid")).toBe(true);
    expect(migration.report).toMatchObject({ migratedChallenges: 1, quarantinedChallenges: 1 });
  });

  it("contains record-shape exceptions to the malformed row and continues migration", () => {
    const broken = { ...storedChallenge(legacyBrief(), { id: "broken-shape" }), brief: null } as unknown as Challenge;
    const valid = storedChallenge(modernBrief(), { id: "valid-shape" });

    const migration = migrateChallengeCriteriaState({ challenges: [broken, valid], contributions: [] });

    expect(migration.state.challengeCriteriaQuarantine).toContainEqual(expect.objectContaining({
      challengeId: "broken-shape",
      reason: "invalid_semantics",
      issueCodes: ["invalid:record_shape"],
    }));
    expect(migration.state.challenges.find((item) => item.id === "broken-shape")).toMatchObject({ visibility: "private", status: "suppressed" });
    expect(migration.state.challenges.find((item) => item.id === "valid-shape")).toMatchObject({ activeCriteriaVersion: 1 });
  });

  it("quarantines secret-bearing historical criteria without storing the raw value in the audit record", () => {
    const current = reviseChallengeCriteria(modernBrief("solve"), {
      intent: "solve",
      successCriteria: ["The current criterion is safe and observable."],
      status: "confirmed",
      contributionCount: 1,
      changeReason: "Replaced the original threshold after review.",
    });
    const secret = "api_key=aaaaaaaa";
    const unsafe = {
      ...current,
      criteria_history: current.criteria_history.map((entry, index) => index === 0 ? { ...entry, success_criteria: [secret] } : entry),
    };

    const migration = migrateChallengeCriteriaState({
      challenges: [storedChallenge(unsafe, { id: "unsafe-history" })],
      contributions: [],
    });
    const serializedQuarantine = JSON.stringify(migration.state.challengeCriteriaQuarantine);

    expect(migration.state.challengeCriteriaQuarantine).toEqual([
      expect.objectContaining({ challengeId: "unsafe-history", reason: "unsafe_history", issueCodes: ["safety:secret_exposure"] }),
    ]);
    expect(serializedQuarantine).not.toContain(secret);
    expect(migration.state.challengeCriteriaVersions).toEqual([]);
  });
});

describe("challenge criteria repository workflow", () => {
  beforeEach(() => resetStoreForTests());

  it("keeps criteria history, revision, and closure methods available on the durable adapter", () => {
    expect(typeof postgresStore.getChallengeCriteriaHistory).toBe("function");
    expect(typeof postgresStore.updateChallengeCriteria).toBe("function");
    expect(typeof postgresStore.evaluateChallengeClosure).toBe("function");
  });

  it("appends immutable ordered history after the first contribution and leaves that contribution bound to version 1", () => {
    const challenge = createChallenge({ posterId: "poster", visibility: "public", reward: 20, brief: modernBrief("solve") });
    const contribution = createContribution({ challengeId: challenge.id, contributorId: "critic", card: card(challenge.id) });
    const before = getChallengeCriteriaHistory(challenge.id);

    const revised = updateChallengeCriteria({
      challengeId: challenge.id,
      posterId: "poster",
      expectedVersion: 1,
      intent: "solve",
      successCriteria: [
        "The blocker is removed under the stated constraints.",
        "A repeat check confirms the result without a regression.",
      ],
      requestedPerspectives: ["critique", "risk_audit"],
      constraints: ["Do not rewrite prior contributions", "Keep the closure evaluator pure"],
      missingInformation: [],
      sensitivity: "public_ok",
      status: "confirmed",
      changeReason: "Added a repeat-check threshold after the first contribution arrived.",
    });
    const history = getChallengeCriteriaHistory(challenge.id);
    const persistedContribution = listContributions(challenge.id).find((item) => item.id === contribution.id);

    expect(before?.versions).toHaveLength(1);
    expect(history).toMatchObject({ challengeId: challenge.id, activeVersion: 2 });
    expect(history?.versions).toHaveLength(2);
    expect(history?.versions[0]).toEqual(before?.versions[0]);
    expect(history?.versions.map((entry) => entry.version)).toEqual([1, 2]);
    expect(Date.parse(history?.versions[1]?.effectiveAt || "")).not.toBeNaN();
    expect(history?.versions[1]).toMatchObject({
      effectiveAtSource: "criteria_revision",
      changedBy: "poster",
      criteriaStatus: "confirmed",
      requestedPerspectives: ["critique", "risk_audit"],
      constraints: ["Do not rewrite prior contributions", "Keep the closure evaluator pure"],
      publicEligibility: { eligible: true, reasons: [], criteriaVersion: 2 },
    });
    expect(revised).toMatchObject({ activeCriteriaVersion: 2, status: "contributing" });
    expect(persistedContribution).toMatchObject({ criteriaVersion: 1, criteriaStatusAtSubmission: "confirmed" });
  });

  it("regenerates client-supplied history and reward posture as server-owned version 1 fields", () => {
    const clientVersionTwo = reviseChallengeCriteria(modernBrief("solve"), {
      intent: "solve",
      successCriteria: ["The replacement criterion is observed."],
      status: "confirmed",
      contributionCount: 1,
      changeReason: "Client-authored history that must not become authoritative.",
    });

    const challenge = createChallenge({ posterId: "poster", visibility: "public", reward: 20, brief: clientVersionTwo });
    const history = getChallengeCriteriaHistory(challenge.id);

    expect(challenge).toMatchObject({ activeCriteriaVersion: 1, brief: { criteria_version: 1 } });
    expect(history?.versions).toEqual([
      expect.objectContaining({
        version: 1,
        changedBy: "poster",
        changeReason: "Initial challenge criteria persisted by the server.",
        rewardPosture: expect.objectContaining({ basis: "poster_confirmed_impact", funding_state: "declarative_only" }),
      }),
    ]);
  });

  it("rejects a new public record when only client-supplied historical criteria contain a secret", () => {
    const clientVersionTwo = reviseChallengeCriteria(modernBrief("solve"), {
      intent: "solve",
      successCriteria: ["The current criterion is safe and observable."],
      status: "confirmed",
      contributionCount: 1,
      changeReason: "The current public revision is safe.",
    });
    const syntheticSecret = `api_key=${"sk-" + "not-a-real-history-secret-123456"}`;
    clientVersionTwo.criteria_history[0] = {
      ...clientVersionTwo.criteria_history[0],
      success_criteria: [syntheticSecret],
    };

    expect(() => createChallenge({ posterId: "poster", visibility: "public", reward: 20, brief: clientVersionTwo })).toThrow("Challenge content is not eligible for public persistence.");
  });

  it("persists a fail-closed public eligibility projection for unbound privacy states", () => {
    const unknown = createChallenge({
      posterId: "poster",
      visibility: "public",
      reward: 20,
      brief: { ...modernBrief("solve"), privacy_sensitivity: "unknown" },
    });
    const privateOnly = createChallenge({
      posterId: "poster",
      visibility: "public",
      reward: 20,
      brief: { ...modernBrief("solve"), privacy_sensitivity: "private_only" },
    });

    expect(unknown.publicEligibility).toMatchObject({ eligible: false, reasons: ["privacy_approval_missing"] });
    expect(privateOnly.publicEligibility).toMatchObject({ eligible: false, reasons: ["private_only"] });
  });

  it("fails closure closed for unconfirmed legacy criteria until the poster confirms a current version", () => {
    const challenge = createChallenge({
      posterId: "poster",
      visibility: "public",
      reward: 20,
      brief: legacyBrief({ success_criteria: defaultSuccessCriteria("pressure_test"), missing_information: [] }),
    });

    const blocked = evaluateChallengeClosure({
      challengeId: challenge.id,
      posterId: "poster",
      outcome: "review_complete",
      criteriaVersion: 1,
      criterionEvidence: [{ criterion_number: 1, status: "satisfied", evidence: "A review was posted." }],
      missingInformationEvidence: [],
    });

    expect(blocked).toEqual({ eligible: false, reasons: ["criteria_unconfirmed"] });

    updateChallengeCriteria({
      challengeId: challenge.id,
      posterId: "poster",
      expectedVersion: 1,
      intent: "pressure_test",
      successCriteria: defaultSuccessCriteria("pressure_test"),
      status: "confirmed",
      changeReason: "Poster confirmed attainable pressure-test closure criteria.",
    });

    const allowed = evaluateChallengeClosure({
      challengeId: challenge.id,
      posterId: "poster",
      outcome: "review_complete",
      criteriaVersion: 2,
      criterionEvidence: [
        { criterion_number: 1, status: "satisfied", evidence: "Material risks were severity-ranked." },
        { criterion_number: 2, status: "satisfied", evidence: "Each material risk has a recorded disposition." },
      ],
      missingInformationEvidence: [],
    });

    expect(allowed).toEqual({ eligible: true });
    expect(listCreditEvents()).toEqual([]);
  });

  it("rejects stale versions, forged actors, and incomplete evidence without changing lifecycle state", () => {
    const challenge = createChallenge({ posterId: "poster", visibility: "public", reward: 20, brief: modernBrief("solve") });

    expect(evaluateChallengeClosure({
      challengeId: challenge.id,
      posterId: "not-the-poster",
      outcome: "solved",
      criteriaVersion: 1,
      criterionEvidence: [{ criterion_number: 1, status: "satisfied", evidence: "The blocker disappeared." }],
      missingInformationEvidence: [],
    })).toEqual({ eligible: false, reasons: ["poster_authorization_required"] });

    expect(evaluateChallengeClosure({
      challengeId: challenge.id,
      posterId: "poster",
      outcome: "solved",
      criteriaVersion: 999,
      criterionEvidence: [],
      missingInformationEvidence: [],
    })).toEqual({ eligible: false, reasons: ["stale_criteria_version"] });

    expect(evaluateChallengeClosure({
      challengeId: challenge.id,
      posterId: "poster",
      outcome: "solved",
      criteriaVersion: 1,
      criterionEvidence: [],
      missingInformationEvidence: [],
    })).toEqual({ eligible: false, reasons: ["criterion_1_not_satisfied"] });

    expect(createChallenge({ posterId: "poster-2", visibility: "public", reward: 1, brief: modernBrief("solve") }).status).toBe("open");
    expect(listCreditEvents()).toEqual([]);
  });
});
