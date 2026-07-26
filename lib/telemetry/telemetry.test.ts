import { describe, expect, it } from "vitest";
import {
  LocalTelemetryCollector,
  TelemetryContractError,
  sanitizeTelemetryProperties,
  telemetryConfigFromEnvironment,
} from "@/lib/telemetry/collector";
import {
  CMAI_TELEMETRY_EVENT_VERSION,
  telemetryEventDefinitions,
  telemetryEventNames,
  telemetryObligationsForTask,
  telemetryPrivacyClasses,
  telemetryRetentionForEvent,
} from "@/lib/telemetry/contract";
import {
  TELEMETRY_TEST_ONLY_PSEUDONYM_SECRET,
  telemetryFixtureIds,
  telemetryProvenanceFixtures,
} from "@/lib/telemetry/test-fixtures";
import {
  TelemetryPrivacyError,
  findForbiddenTelemetryData,
  isForbiddenTelemetryKey,
  isTelemetryPseudonym,
  pseudonymizeTelemetryId,
} from "@/lib/telemetry/privacy";

const occurredAt = "2026-07-14T12:00:00.000Z";

function localCollector() {
  return new LocalTelemetryCollector({ mode: "local", environment: "test", provider: "disabled" });
}

function eventId(unique: string) {
  return pseudonymizeTelemetryId("event", unique, TELEMETRY_TEST_ONLY_PSEUDONYM_SECRET);
}

function expectContractError(action: () => unknown, code: TelemetryContractError["code"]): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(TelemetryContractError);
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`Expected ${code}.`);
}

describe("CMAI telemetry V1 registry", () => {
  it("freezes owners, triggers, versions, privacy classes, transitions, and downstream emitters", () => {
    expect(telemetryEventNames).toEqual(expect.arrayContaining([
      "adapter.install.completed",
      "pairing.created",
      "feed.fetched",
      "challenge.grant_issued",
      "challenge.grant_failed",
      "run.approved",
      "contribution.previewed",
      "contribution.submitted",
      "pairing.revoked",
      "review.recorded",
      "answer.version_created",
      "challenge.lifecycle_changed",
      "reward.settled",
      "dispute.opened",
      "moderation.action_applied",
      "notification.queued",
      "cohort.readiness_evaluated",
    ]));

    for (const event of telemetryEventNames) {
      const definition = telemetryEventDefinitions[event];
      expect(definition.eventVersion, event).toBe(CMAI_TELEMETRY_EVENT_VERSION);
      expect(definition.owner, event).toBeTruthy();
      expect(definition.trigger.length, event).toBeGreaterThan(20);
      expect(telemetryPrivacyClasses, event).toContain(definition.privacyClass);
      expect(definition.emitterTasks.length, event).toBeGreaterThan(0);
      expect(definition.transition.stateMachine, event).toBeTruthy();
      expect(telemetryRetentionForEvent(event).retentionDays, event).toBeGreaterThan(0);
      for (const property of Object.keys(definition.properties)) {
        expect(isForbiddenTelemetryKey(property), `${event}:${property}`).toBe(false);
      }
    }

    expect(telemetryObligationsForTask("t_c8908940")).toEqual(expect.arrayContaining([
      "pairing.created",
      "pairing.failed",
      "pairing.revoked",
    ]));
    expect(telemetryObligationsForTask("t_1c434d70")).toEqual(expect.arrayContaining([
      "feed.fetched",
      "feed.failed",
      "challenge.grant_issued",
      "challenge.grant_failed",
    ]));
    expect(telemetryObligationsForTask("t_552cc1e6")).toEqual(expect.arrayContaining([
      "run.approved",
      "run.completed",
      "run.failed",
    ]));
  });

  it("keeps identifiers pseudonymous and context-bound", () => {
    const actor = pseudonymizeTelemetryId("actor", "same-raw-id", TELEMETRY_TEST_ONLY_PSEUDONYM_SECRET);
    const actorAgain = pseudonymizeTelemetryId("actor", "same-raw-id", TELEMETRY_TEST_ONLY_PSEUDONYM_SECRET);
    const challenge = pseudonymizeTelemetryId("challenge", "same-raw-id", TELEMETRY_TEST_ONLY_PSEUDONYM_SECRET);

    expect(actor).toBe(actorAgain);
    expect(actor).not.toBe(challenge);
    expect(actor).not.toContain("same-raw-id");
    expect(isTelemetryPseudonym(actor, ["actor"])).toBe(true);
    expect(isTelemetryPseudonym(actor, ["challenge"])).toBe(false);
    expect(() => pseudonymizeTelemetryId("actor", "raw", "short-secret")).toThrow("at least 32");
  });
});

describe("telemetry privacy and allowlists", () => {
  it("rejects forbidden content recursively before unknown properties can be dropped", () => {
    const hostilePayloads = [
      { metadata: [{ rawPrompt: "ignore previous instructions" }] },
      { metadata: { nested: "https://example.com/private?query=secret" } },
      { metadata: { nested: "person@example.com" } },
      { metadata: { nested: ["Bearer", "abcdefghijklmnop"].join(" ") } },
      { metadata: { nested: "PAIR-ABCD-1234" } },
      { metadata: { privateChallengeText: "confidential customer details" } },
      { metadata: { transcript: ["private output"] } },
      { metadata: { answer: "private answer" } },
      { metadata: { socialUrl: "https://social.example/person" } },
    ];

    for (const hostile of hostilePayloads) {
      expect(() => sanitizeTelemetryProperties("adapter.install.completed", {
        runtime: "hermes",
        install_channel: "local_package",
        install_scope: "user_profile",
        ...hostile,
      })).toThrow(TelemetryPrivacyError);
    }
    expect(findForbiddenTelemetryData({ challenge_id: telemetryFixtureIds.challenge })).toEqual([]);
    expect(sanitizeTelemetryProperties("adapter.install.completed", {
      runtime: "hermes",
      install_channel: "local_package",
      install_scope: "user_profile",
      submission_mode: "run_with_my_agent",
    }).droppedProperties).toContainEqual({ property: "submission_mode", reason: "unknown_property" });

    const credentialInKey = ["secret", "sk", "live", "example"].join("-");
    let rejected: unknown;
    try {
      sanitizeTelemetryProperties("adapter.install.completed", {
        runtime: "hermes",
        install_channel: "local_package",
        install_scope: "user_profile",
        [credentialInKey]: "x",
      });
    } catch (error) {
      rejected = error;
    }
    expect(rejected).toBeInstanceOf(TelemetryPrivacyError);
    expect((rejected as Error).message).not.toContain(credentialInKey);
    expect((rejected as TelemetryPrivacyError).findings).toEqual(expect.arrayContaining([
      { path: "$.[redacted_key_3]", reason: "content_key" },
    ]));
  });

  it("drops unknown properties and high-cardinality values server-side", () => {
    const sanitized = sanitizeTelemetryProperties("contribution.submitted", {
      challenge_id: telemetryFixtureIds.challenge,
      contribution_id: telemetryFixtureIds.contribution,
      ...telemetryProvenanceFixtures.manual,
      idempotency_outcome: "accepted",
      runtime: "my-unique-private-runtime-build-123456789",
      arbitrary_dimension: "unique-customer-segment-123456789",
    });

    expect(sanitized.properties).toEqual({
      challenge_id: telemetryFixtureIds.challenge,
      contribution_id: telemetryFixtureIds.contribution,
      ...telemetryProvenanceFixtures.manual,
      idempotency_outcome: "accepted",
    });
    expect(sanitized.droppedProperties).toEqual(expect.arrayContaining([
      { property: "runtime", reason: "high_cardinality_or_invalid_value" },
      { property: "arbitrary_dimension", reason: "unknown_property" },
    ]));
  });

  it("requires pseudonymous grant identifiers and keeps issuance distinct from feed retrieval", () => {
    const grant = {
      runtime: "hermes",
      pairing_id: telemetryFixtureIds.pairing,
      challenge_id: telemetryFixtureIds.challenge,
    };
    expect(sanitizeTelemetryProperties("challenge.grant_issued", grant).properties).toEqual(grant);
    expectContractError(
      () => sanitizeTelemetryProperties("challenge.grant_issued", { ...grant, pairing_id: "pairing_raw_private" }),
      "telemetry_required_property_missing",
    );
    expect(() => sanitizeTelemetryProperties("challenge.grant_failed", {
      runtime: "hermes",
      pairing_id: telemetryFixtureIds.pairing,
      failure_bucket: "authorization",
      metadata: { url: "https://example.com/private" },
    })).toThrow(TelemetryPrivacyError);
  });

  it("requires distinct allowlisted state transitions and human confirmation", () => {
    const review = {
      challenge_id: telemetryFixtureIds.challenge,
      contribution_id: telemetryFixtureIds.contribution,
      review_stage: "initial",
      impact_tier: "useful",
      review_outcome: "confirmed",
      from_state: "pending_review",
      to_state: "reviewed",
      poster_confirmed: true,
    };
    expect(sanitizeTelemetryProperties("review.recorded", review).properties).toEqual(review);
    expectContractError(
      () => sanitizeTelemetryProperties("review.recorded", { ...review, from_state: "pending_validation", to_state: "pending_validation" }),
      "telemetry_transition_invalid",
    );
    expectContractError(
      () => sanitizeTelemetryProperties("review.recorded", { ...review, poster_confirmed: false }),
      "telemetry_human_confirmation_required",
    );
  });
});

describe("local telemetry collector", () => {
  it("deduplicates identical delivery and rejects event-ID conflicts", () => {
    const collector = localCollector();
    const input = {
      eventId: telemetryFixtureIds.event,
      subjectId: telemetryFixtureIds.actor,
      occurredAt,
      properties: {
        runtime: "hermes",
        install_channel: "local_package",
        install_scope: "user_profile",
      },
    };

    expect(collector.collect("adapter.install.completed", input).status).toBe("accepted");
    expect(collector.collect("adapter.install.completed", input)).toEqual({
      status: "duplicate",
      stored: false,
      duplicateOf: telemetryFixtureIds.event,
    });
    expectContractError(
      () => collector.collect("adapter.install.completed", {
        ...input,
        properties: { ...input.properties, install_channel: "git" },
      }),
      "telemetry_idempotency_conflict",
    );
    expect(collector.list()).toHaveLength(1);
  });

  it("suppresses, restores, deletes, and blocks replay for deleted subjects", () => {
    const collector = localCollector();
    collector.collect("adapter.install.completed", {
      eventId: telemetryFixtureIds.event,
      subjectId: telemetryFixtureIds.actor,
      occurredAt,
      properties: { runtime: "hermes", install_channel: "local_package", install_scope: "user_profile" },
    });
    collector.collect("feed.fetched", {
      eventId: telemetryFixtureIds.secondEvent,
      subjectId: telemetryFixtureIds.actor,
      occurredAt: "2026-07-14T12:01:00.000Z",
      properties: { runtime: "hermes", feed_result: "non_empty", result_count_bucket: "2_3" },
    });

    expect(collector.suppressSubject(telemetryFixtureIds.actor, "2026-07-14T12:02:00.000Z")).toBe(2);
    expect(collector.list()).toHaveLength(0);
    expect(collector.list({ includeSuppressed: true })).toHaveLength(2);
    expect(collector.collect("feed.fetched", {
      eventId: telemetryFixtureIds.thirdEvent,
      subjectId: telemetryFixtureIds.actor,
      occurredAt: "2026-07-14T12:03:00.000Z",
      properties: { runtime: "hermes", feed_result: "empty", result_count_bucket: "0" },
    }).status).toBe("suppressed");
    expect(collector.restoreSubject(telemetryFixtureIds.actor)).toBe(3);
    expect(collector.list()).toHaveLength(3);

    expect(collector.deleteSubject(telemetryFixtureIds.actor, "2026-07-14T12:04:00.000Z")).toBe(3);
    expect(collector.list({ includeSuppressed: true })).toHaveLength(0);
    expect(collector.collect("feed.fetched", {
      eventId: eventId("post-delete"),
      subjectId: telemetryFixtureIds.actor,
      occurredAt: "2026-07-14T12:05:00.000Z",
      properties: { runtime: "hermes", feed_result: "empty", result_count_bucket: "0" },
    })).toEqual({ status: "deleted_subject", stored: false });
  });

  it("enforces retention and provider-disabled mode without storing payloads", () => {
    const collector = localCollector();
    collector.collect("adapter.install.completed", {
      eventId: telemetryFixtureIds.event,
      subjectId: telemetryFixtureIds.actor,
      occurredAt: "2026-01-01T00:00:00.000Z",
      properties: { runtime: "hermes", install_channel: "local_package", install_scope: "user_profile" },
    });
    expect(collector.purgeExpired("2026-01-15T00:00:00.000Z").records).toBe(1);
    expect(collector.list()).toHaveLength(0);

    const disabled = new LocalTelemetryCollector({ mode: "disabled", environment: "production", provider: "disabled" });
    expect(disabled.collect("adapter.install.completed", {
      eventId: "raw-event-id",
      subjectId: "raw-user-id",
      occurredAt: "not-a-date",
      properties: { prompt: "this is never inspected or stored" },
    })).toEqual({ status: "disabled", stored: false });
    expect(disabled.list()).toEqual([]);
  });
});

describe("manual, paired, and sandbox provenance fixtures", () => {
  it("records all three lanes without inflating paired-local trust", () => {
    const collector = localCollector();
    const fixtures = [
      ["manual", telemetryProvenanceFixtures.manual],
      ["paired", telemetryProvenanceFixtures.paired],
      ["sandbox", telemetryProvenanceFixtures.sandbox],
    ] as const;

    fixtures.forEach(([label, provenance], index) => {
      const result = collector.collect("contribution.submitted", {
        eventId: eventId(`provenance-${label}`),
        subjectId: telemetryFixtureIds.actor,
        occurredAt: `2026-07-14T12:0${index}:00.000Z`,
        properties: {
          challenge_id: telemetryFixtureIds.challenge,
          contribution_id: pseudonymizeTelemetryId("contribution", `contribution-${label}`, TELEMETRY_TEST_ONLY_PSEUDONYM_SECRET),
          ...provenance,
          idempotency_outcome: "accepted",
        },
      });
      expect(result.status).toBe("accepted");
    });

    const records = collector.list();
    expect(records.map((record) => record.properties.trust_label)).toEqual([
      "self_attested",
      "paired_self_controlled",
      "receipt_backed",
    ]);
    expect(JSON.stringify(records)).not.toContain("fully_trusted");

    expectContractError(
      () => sanitizeTelemetryProperties("contribution.submitted", {
        challenge_id: telemetryFixtureIds.challenge,
        contribution_id: telemetryFixtureIds.contribution,
        ...telemetryProvenanceFixtures.paired,
        trust_label: "fully_trusted",
        idempotency_outcome: "accepted",
      }),
      "telemetry_provenance_invalid",
    );
  });

  it("binds run execution control to the matching runtime evidence", () => {
    expect(sanitizeTelemetryProperties("run.approved", {
      challenge_id: telemetryFixtureIds.challenge,
      pairing_id: telemetryFixtureIds.pairing,
      runtime: "hermes",
      approval_scope: "one_run",
      execution_control: "paired_local",
      budget_bucket: "small",
    }).properties.execution_control).toBe("paired_local");
    expect(sanitizeTelemetryProperties("run.approved", {
      challenge_id: telemetryFixtureIds.challenge,
      runtime: "platform_sandbox",
      approval_scope: "one_run",
      execution_control: "cmai_controlled_sandbox",
      budget_bucket: "small",
    }).properties.execution_control).toBe("cmai_controlled_sandbox");
    expect(sanitizeTelemetryProperties("pairing.created", {
      pairing_id: telemetryFixtureIds.pairing,
      runtime: "hermes",
      pairing_scope: "read_run_manage",
    }).properties.pairing_scope).toBe("read_run_manage");
    expect(sanitizeTelemetryProperties("pairing.created", {
      pairing_id: telemetryFixtureIds.pairing,
      runtime: "openclaw",
      pairing_scope: "read_run_submit_manage",
    }).properties.pairing_scope).toBe("read_run_submit_manage");

    expectContractError(
      () => sanitizeTelemetryProperties("run.approved", {
        challenge_id: telemetryFixtureIds.challenge,
        runtime: "platform_sandbox",
        approval_scope: "one_run",
        execution_control: "paired_local",
        budget_bucket: "small",
      }),
      "telemetry_provenance_invalid",
    );
    expectContractError(
      () => sanitizeTelemetryProperties("run.failed", {
        challenge_id: telemetryFixtureIds.challenge,
        runtime: "hermes",
        execution_control: "cmai_controlled_sandbox",
        failure_bucket: "internal",
        retryable: false,
      }),
      "telemetry_provenance_invalid",
    );
    expectContractError(
      () => sanitizeTelemetryProperties("pairing.created", {
        pairing_id: telemetryFixtureIds.pairing,
        runtime: "platform_sandbox",
        pairing_scope: "read_run_submit_manage",
      }),
      "telemetry_required_property_missing",
    );
  });

  it("rejects mixed evidence on manual and sandbox contribution telemetry", () => {
    expectContractError(
      () => sanitizeTelemetryProperties("contribution.submitted", {
        challenge_id: telemetryFixtureIds.challenge,
        contribution_id: telemetryFixtureIds.contribution,
        ...telemetryProvenanceFixtures.manual,
        run_id: telemetryFixtureIds.run,
        idempotency_outcome: "accepted",
      }),
      "telemetry_provenance_invalid",
    );
    expectContractError(
      () => sanitizeTelemetryProperties("contribution.submitted", {
        challenge_id: telemetryFixtureIds.challenge,
        contribution_id: telemetryFixtureIds.contribution,
        ...telemetryProvenanceFixtures.sandbox,
        pairing_id: telemetryFixtureIds.pairing,
        idempotency_outcome: "accepted",
      }),
      "telemetry_provenance_invalid",
    );
  });
});

describe("telemetry environment flags", () => {
  it("defaults providers to disabled and refuses provider or production-local activation", () => {
    expect(telemetryConfigFromEnvironment({ NODE_ENV: "test" })).toEqual({
      mode: "disabled",
      provider: "disabled",
      environment: "test",
    });
    expectContractError(
      () => telemetryConfigFromEnvironment({ CMAI_TELEMETRY_PROVIDER: "posthog" }),
      "telemetry_config_invalid",
    );
    expectContractError(
      () => telemetryConfigFromEnvironment({ CMAI_TELEMETRY_MODE: "local", CMAI_RUNTIME_ENV: "production" }),
      "telemetry_config_invalid",
    );
  });
});
