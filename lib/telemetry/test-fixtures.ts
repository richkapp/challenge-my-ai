import { pseudonymizeTelemetryId } from "@/lib/telemetry/privacy";

export const TELEMETRY_TEST_ONLY_PSEUDONYM_SECRET = "cmai-telemetry-test-only-secret-0000000000000000000000000000";

export const telemetryFixtureIds = {
  actor: pseudonymizeTelemetryId("actor", "fixture-user-1", TELEMETRY_TEST_ONLY_PSEUDONYM_SECRET),
  challenge: pseudonymizeTelemetryId("challenge", "fixture-challenge-1", TELEMETRY_TEST_ONLY_PSEUDONYM_SECRET),
  contribution: pseudonymizeTelemetryId("contribution", "fixture-contribution-1", TELEMETRY_TEST_ONLY_PSEUDONYM_SECRET),
  pairing: pseudonymizeTelemetryId("pairing", "fixture-pairing-1", TELEMETRY_TEST_ONLY_PSEUDONYM_SECRET),
  run: pseudonymizeTelemetryId("run", "fixture-run-1", TELEMETRY_TEST_ONLY_PSEUDONYM_SECRET),
  event: pseudonymizeTelemetryId("event", "fixture-event-1", TELEMETRY_TEST_ONLY_PSEUDONYM_SECRET),
  secondEvent: pseudonymizeTelemetryId("event", "fixture-event-2", TELEMETRY_TEST_ONLY_PSEUDONYM_SECRET),
  thirdEvent: pseudonymizeTelemetryId("event", "fixture-event-3", TELEMETRY_TEST_ONLY_PSEUDONYM_SECRET),
} as const;

export const telemetryProvenanceFixtures = {
  manual: {
    submission_mode: "manual_copy_paste",
    provenance_tier: "self_submitted",
    trust_label: "self_attested",
    edited_after_run: true,
  },
  paired: {
    pairing_id: telemetryFixtureIds.pairing,
    run_id: telemetryFixtureIds.run,
    runtime: "hermes",
    submission_mode: "run_with_my_agent",
    provenance_tier: "paired_local_agent",
    trust_label: "paired_self_controlled",
    edited_after_run: false,
  },
  sandbox: {
    run_id: telemetryFixtureIds.run,
    runtime: "platform_sandbox",
    submission_mode: "run_with_my_agent",
    provenance_tier: "cmai_sandbox",
    trust_label: "receipt_backed",
    edited_after_run: false,
  },
} as const;
