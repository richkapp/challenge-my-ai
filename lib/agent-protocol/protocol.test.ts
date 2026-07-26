import { Buffer } from "node:buffer";
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalAgentJson, canonicalAgentSigningBytes } from "@/lib/agent-protocol/canonical";
import { CMAI_AGENT_PROTOCOL_VERSION, agentProtocolBodyLimits, agentProtocolContributionModes } from "@/lib/agent-protocol/constants";
import { findCredentialShapedFields } from "@/lib/agent-protocol/credentials";
import { agentProtocolErrorCodes, agentProtocolErrorHttpStatus, agentProtocolErrorRetryability, AgentProtocolError, type AgentProtocolErrorCode } from "@/lib/agent-protocol/errors";
import {
  backwardCompatiblePairCreateFixture,
  fixturePublicKey,
  fixtureRunNonce,
  fixtureSignature,
  fixtureTimestamp,
  forwardIncompatiblePairCreateFixture,
  validChallengeGetRequestFixture,
  validChallengeGetResponseFixture,
  validContributionCardV1,
  validContributionSubmitRequestFixture,
  validContributionSubmitResponseFixture,
  validFeedListRequestFixture,
  validFeedListResponseFixture,
  validPairCreateResponseFixture,
  validPairingMutationResponseFixture,
  validPairingRevokeRequestFixture,
  validPairingRotateKeyRequestFixture,
  validProtocolErrorResponseFixture,
} from "@/lib/agent-protocol/fixtures";
import { parseAgentProtocolJson } from "@/lib/agent-protocol/parse";
import { normalizePairedAdapterContribution } from "@/lib/agent-protocol/provenance";
import {
  agentContributionSubmitRequestSchema,
  agentContributionSubmitResponseSchema,
  agentChallengeGetRequestSchema,
  agentChallengeGetResponseSchema,
  agentFeedListResponseSchema,
  agentFeedListRequestSchema,
  agentPairCreateRequestSchema,
  agentPairCreateResponseSchema,
  agentPairingMutationResponseSchema,
  agentPairingRevokeRequestSchema,
  agentPairingRotateKeyRequestSchema,
  agentProtocolInitialPublicKeySchema,
  agentProtocolPublicKeySchema,
  agentProtocolErrorResponseSchema,
  pairingStateSchema,
} from "@/lib/agent-protocol/schemas";
import {
  assertAgentProtocolScope,
  assertAgentRequestTime,
  InMemoryPairingKeyRing,
  InMemoryRunNonceStore,
  InMemorySubmissionReplayGuard,
} from "@/lib/agent-protocol/state";
import {
  challengeIntentPolicy,
  challengeIntents,
  challengeSuccessfulOutcomes,
  declarativeRewardPosture,
} from "@/lib/challenges/intent";
import { contributionCardSchema } from "@/lib/validation/schemas";
import { contributionCardV1Schema } from "@/lib/validation/contributionCardProtocol";

function expectProtocolError(action: () => unknown, code: AgentProtocolErrorCode): AgentProtocolError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentProtocolError);
    expect(error).toMatchObject({ code });
    return error as AgentProtocolError;
  }
  throw new Error(`Expected ${code}.`);
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function issueNonce(store: InMemoryRunNonceStore, nonce = fixtureRunNonce): void {
  store.issue({
    nonce,
    pairingId: "pairing_1",
    challengeId: "challenge_protocol_1",
    challengeRevision: 1,
    issuedAt: fixtureTimestamp,
    expiresAt: "2026-07-14T12:10:00.000Z",
  });
}

function registerPairing(store: InMemoryPairingKeyRing, pairingId = "pairing_1"): void {
  store.register({
    pairingId,
    deviceId: `device_${pairingId}`,
    keyId: "key_1",
    grantedScopes: ["challenge:read", "challenge:run", "contribution:submit", "pairing:manage"],
    activatedAt: fixtureTimestamp,
  });
}

describe("CMAI Agent Protocol V1 schemas", () => {
  it("accepts the minimal V1 pairing fixture and rejects unknown fields", () => {
    const parsed = parseAgentProtocolJson("pair.create", JSON.stringify(backwardCompatiblePairCreateFixture), agentPairCreateRequestSchema);
    expect(parsed.payload.device.runtime).toBe("hermes");
    expect(parsed.payload.device.runtime_version).toBeUndefined();

    const withUnknownField = jsonClone(validFeedListRequestFixture) as Record<string, any>;
    withUnknownField.payload.future_flag = true;
    expectProtocolError(
      () => parseAgentProtocolJson("feed.list", JSON.stringify(withUnknownField), agentFeedListRequestSchema),
      "malformed_request",
    );
  });

  it("fails forward-incompatible versions with a stable error", () => {
    const error = expectProtocolError(
      () => parseAgentProtocolJson("pair.create", JSON.stringify(forwardIncompatiblePairCreateFixture), agentPairCreateRequestSchema),
      "unsupported_protocol_version",
    );
    expect(error.field).toBe("$.protocol_version");
  });

  it("rejects legacy 1.1 envelopes instead of silently downgrading", () => {
    const legacy = jsonClone(validFeedListRequestFixture) as Record<string, unknown>;
    legacy.protocol_version = "1.1";
    const error = expectProtocolError(
      () => parseAgentProtocolJson("feed.list", JSON.stringify(legacy), agentFeedListRequestSchema),
      "unsupported_protocol_version",
    );
    expect(error.field).toBe("$.protocol_version");
  });

  it("keeps the Protocol 1.2 documentation, executable errors, and signing vector in lockstep", () => {
    const contract = readFileSync("docs/contracts/cmai-agent-protocol-v1.md", "utf8");
    expect(contract).toContain("Version `1.2`");
    expect(contract).toContain(`signature  = ${fixtureSignature}`);
    for (const code of ["challenge_unavailable", "cursor_invalid", "rate_limited", "capacity_exceeded", "service_unavailable"]) {
      expect(contract).toContain(`\`${code}\``);
    }
    expect(contract).toContain("snapshot protocol");
    expect(contract).toContain("SELECT ... FOR UPDATE");
  });

  it("requires protocol 1.2 canonical public challenge semantics", () => {
    expect(CMAI_AGENT_PROTOCOL_VERSION).toBe("1.2");

    const withSemantics = jsonClone(validChallengeGetResponseFixture) as Record<string, any>;
    withSemantics.protocol_version = "1.2";
    withSemantics.result.challenge.challenge_semantics = {
      challenge_semantics_version: "1.0",
      challenge_intent: "pressure_test",
      criteria_status: "confirmed",
      criteria_version: 1,
      successful_outcomes: ["review_complete"],
      privacy_sensitivity: "public_ok",
      reward_posture: {
        basis: "poster_confirmed_impact",
        funding_state: "declarative_only",
        eligible_impact_tiers: ["signal", "useful", "material", "decisive"],
        completion_bonus: "not_applicable",
      },
    };
    expect(agentChallengeGetResponseSchema.safeParse(withSemantics).success).toBe(true);

    const missingSemantics = jsonClone(withSemantics);
    delete missingSemantics.result.challenge.challenge_semantics;
    expect(agentChallengeGetResponseSchema.safeParse(missingSemantics).success).toBe(false);

    const unconfirmed = jsonClone(withSemantics);
    unconfirmed.result.challenge.challenge_semantics.criteria_status = "criteria_unconfirmed";
    expect(agentChallengeGetResponseSchema.safeParse(unconfirmed).success).toBe(false);

    const nonPublic = jsonClone(withSemantics);
    nonPublic.result.challenge.challenge_semantics.privacy_sensitivity = "anonymize_first";
    expect(agentChallengeGetResponseSchema.safeParse(nonPublic).success).toBe(false);

    const leakedHistory = jsonClone(withSemantics);
    leakedHistory.result.challenge.challenge_semantics.criteria_history = [];
    expect(agentChallengeGetResponseSchema.safeParse(leakedHistory).success).toBe(false);

    const mismatchedOutcome = jsonClone(withSemantics);
    mismatchedOutcome.result.challenge.challenge_semantics.successful_outcomes = ["solved"];
    expect(agentChallengeGetResponseSchema.safeParse(mismatchedOutcome).success).toBe(false);

    const mismatchedReward = jsonClone(withSemantics);
    mismatchedReward.result.challenge.challenge_semantics.reward_posture.completion_bonus = "eligible";
    expect(agentChallengeGetResponseSchema.safeParse(mismatchedReward).success).toBe(false);
  });

  it("rejects unsafe Agent URL projections", () => {
    for (const unsafe of [
      "https://example.com/challenge",
      "//example.com/challenge",
      "/challenges/example?token=secret",
      "/challenges/example#private",
      "/challenges/\u202eexample",
    ]) {
      const response = jsonClone(validFeedListResponseFixture) as Record<string, any>;
      response.result.challenges[0].urls.challenge = unsafe;
      expect(agentFeedListResponseSchema.safeParse(response).success, unsafe).toBe(false);
    }
  });

  it("keeps public challenge semantics canonical across all seven intents", () => {
    expect(challengeIntents).toHaveLength(7);

    for (const intent of challengeIntents) {
      const policy = challengeIntentPolicy(intent);
      const canonical = jsonClone(validChallengeGetResponseFixture) as Record<string, any>;
      canonical.result.challenge.challenge_semantics.challenge_intent = intent;
      canonical.result.challenge.challenge_semantics.successful_outcomes = [...policy.successfulOutcomes];
      canonical.result.challenge.challenge_semantics.reward_posture = declarativeRewardPosture(intent);
      expect(agentChallengeGetResponseSchema.safeParse(canonical).success).toBe(true);

      const allowedOutcomes = new Set<string>(policy.successfulOutcomes);
      const invalidOutcome = challengeSuccessfulOutcomes.find((outcome) => !allowedOutcomes.has(outcome));
      expect(invalidOutcome).toBeDefined();
      const mismatchedOutcome = jsonClone(canonical);
      mismatchedOutcome.result.challenge.challenge_semantics.successful_outcomes = [invalidOutcome];
      expect(agentChallengeGetResponseSchema.safeParse(mismatchedOutcome).success).toBe(false);

      const mismatchedReward = jsonClone(canonical);
      mismatchedReward.result.challenge.challenge_semantics.reward_posture.completion_bonus = policy.completionBonus === "eligible"
        ? "not_applicable"
        : "eligible";
      expect(agentChallengeGetResponseSchema.safeParse(mismatchedReward).success).toBe(false);

      if (policy.successfulOutcomes.length > 1) {
        const reorderedOutcomes = jsonClone(canonical);
        reorderedOutcomes.result.challenge.challenge_semantics.successful_outcomes = [...policy.successfulOutcomes].reverse();
        expect(agentChallengeGetResponseSchema.safeParse(reorderedOutcomes).success).toBe(false);
      }
    }
  });

  it("treats missing protocol fields as malformed rather than unsupported", () => {
    expectProtocolError(
      () => parseAgentProtocolJson("pair.create", JSON.stringify({}), agentPairCreateRequestSchema),
      "malformed_request",
    );
  });

  it("classifies recursive credential variants while preserving protocol fields", () => {
    const forbiddenKeys = [
      "provider_api_key",
      "provider_token",
      "authorization",
      "password_hash",
      "myBearerToken",
      "accessTokens",
      "secret-key",
      "service_role_key",
    ];
    for (const key of forbiddenKeys) {
      const request = jsonClone(validContributionSubmitRequestFixture) as Record<string, any>;
      request.payload.audit.nested = [{ [key]: "must-never-enter-cmai" }];
      const error = expectProtocolError(
        () => parseAgentProtocolJson("contribution.submit", JSON.stringify(request), agentContributionSubmitRequestSchema),
        "credential_field_forbidden",
      );
      expect(error.field).toBe(`$.payload.audit.nested[0].${key}`);
    }

    expect(findCredentialShapedFields({
      public_key: fixturePublicKey,
      key_id: "key_1",
      pairing_code: "PAIR-123456",
      run_nonce: fixtureRunNonce,
      idempotency_key: "idem_protocol_0001",
      signature: fixtureSignature,
    })).toEqual([]);
  });

  it("reports malformed contribution cards separately from malformed envelopes", () => {
    const request = jsonClone(validContributionSubmitRequestFixture) as Record<string, any>;
    delete request.payload.card.verdict;
    const error = expectProtocolError(
      () => parseAgentProtocolJson("contribution.submit", JSON.stringify(request), agentContributionSubmitRequestSchema),
      "contribution_card_malformed",
    );
    expect(error.field).toContain("$.payload.card.verdict");
  });

  it("rejects plugin attempts to claim fully trusted or provider-verified provenance", () => {
    const fullyTrusted = jsonClone(validContributionSubmitRequestFixture) as Record<string, any>;
    fullyTrusted.payload.provenance_claim.fully_trusted = true;
    expectProtocolError(
      () => parseAgentProtocolJson("contribution.submit", JSON.stringify(fullyTrusted), agentContributionSubmitRequestSchema),
      "malformed_request",
    );

    const providerVerified = jsonClone(validContributionSubmitRequestFixture) as Record<string, any>;
    providerVerified.payload.provenance_claim.provider_verified = true;
    expectProtocolError(
      () => parseAgentProtocolJson("contribution.submit", JSON.stringify(providerVerified), agentContributionSubmitRequestSchema),
      "malformed_request",
    );

    const nestedProviderProof = jsonClone(validContributionSubmitRequestFixture) as Record<string, any>;
    nestedProviderProof.payload.card.model_provenance = {
      ...nestedProviderProof.payload.card.model_provenance,
      source: "provider_signed",
      verified: true,
      provider_model_verified: true,
      receipt_id: "fake_receipt",
      provider_response_id: "fake_response",
      execution_authority: "provider",
    };
    expectProtocolError(
      () => parseAgentProtocolJson("contribution.submit", JSON.stringify(nestedProviderProof), agentContributionSubmitRequestSchema),
      "contribution_card_malformed",
    );
  });

  it("enforces operation-specific UTF-8 body limits", () => {
    const oversized = JSON.stringify({ padding: "x".repeat(agentProtocolBodyLimits["feed.list"] + 1) });
    expectProtocolError(
      () => parseAgentProtocolJson("feed.list", oversized, agentFeedListRequestSchema),
      "body_too_large",
    );
  });

  it("freezes a strict canonical fixture for every exported operation and response", () => {
    const contracts = [
      [agentPairCreateRequestSchema, backwardCompatiblePairCreateFixture],
      [agentPairingRotateKeyRequestSchema, validPairingRotateKeyRequestFixture],
      [agentPairingRevokeRequestSchema, validPairingRevokeRequestFixture],
      [agentFeedListRequestSchema, validFeedListRequestFixture],
      [agentChallengeGetRequestSchema, validChallengeGetRequestFixture],
      [agentContributionSubmitRequestSchema, validContributionSubmitRequestFixture],
      [agentPairCreateResponseSchema, validPairCreateResponseFixture],
      [agentPairingMutationResponseSchema, validPairingMutationResponseFixture],
      [agentFeedListResponseSchema, validFeedListResponseFixture],
      [agentChallengeGetResponseSchema, validChallengeGetResponseFixture],
      [agentContributionSubmitResponseSchema, validContributionSubmitResponseFixture],
      [agentProtocolErrorResponseSchema, validProtocolErrorResponseFixture],
    ] as const;

    for (const [schema, fixture] of contracts) {
      expect(schema.safeParse(fixture).success).toBe(true);
      expect(schema.safeParse({ ...fixture, future_field: true }).success).toBe(false);
    }

    for (const [schema, fixture] of contracts.slice(0, 6)) {
      const withUnknownPayloadField = jsonClone(fixture) as Record<string, any>;
      withUnknownPayloadField.payload.future_field = true;
      expect(schema.safeParse(withUnknownPayloadField).success).toBe(false);
    }

    for (const [schema, fixture] of contracts.slice(6, 11)) {
      const withUnknownResultField = jsonClone(fixture) as Record<string, any>;
      withUnknownResultField.result.future_field = true;
      expect(schema.safeParse(withUnknownResultField).success).toBe(false);
    }
    const withUnknownErrorField = jsonClone(validProtocolErrorResponseFixture) as Record<string, any>;
    withUnknownErrorField.error.future_field = true;
    expect(agentProtocolErrorResponseSchema.safeParse(withUnknownErrorField).success).toBe(false);
  });

  it("freezes operation invariants, real timestamps, and initial key generation", () => {
    const wrongInitialGeneration = jsonClone(backwardCompatiblePairCreateFixture) as Record<string, any>;
    wrongInitialGeneration.payload.public_key.generation = 2;
    expect(agentPairCreateRequestSchema.safeParse(wrongInitialGeneration).success).toBe(false);
    expect(agentProtocolInitialPublicKeySchema.safeParse({ ...backwardCompatiblePairCreateFixture.payload.public_key, generation: 1 }).success).toBe(true);

    const sameRotationKey = jsonClone(validPairingRotateKeyRequestFixture) as Record<string, any>;
    sameRotationKey.payload.new_public_key.key_id = sameRotationKey.payload.replaces_key_id;
    expect(agentPairingRotateKeyRequestSchema.safeParse(sameRotationKey).success).toBe(false);

    const pairingRevokeWithKey = jsonClone(validPairingRevokeRequestFixture) as Record<string, any>;
    pairingRevokeWithKey.payload.key_id = "key_1";
    expect(agentPairingRevokeRequestSchema.safeParse(pairingRevokeWithKey).success).toBe(false);

    const mismatchedRevision = jsonClone(validChallengeGetResponseFixture) as Record<string, any>;
    mismatchedRevision.result.challenge.run_grant.challenge_revision = 2;
    expect(agentChallengeGetResponseSchema.safeParse(mismatchedRevision).success).toBe(false);

    const impossibleCalendarDate = jsonClone(validFeedListRequestFixture) as Record<string, any>;
    impossibleCalendarDate.sent_at = "2026-02-30T12:00:00.000Z";
    expect(agentFeedListRequestSchema.safeParse(impossibleCalendarDate).success).toBe(false);
  });

  it("binds each stable error code to retry and detail semantics", () => {
    expect(agentProtocolErrorCodes).toEqual(expect.arrayContaining([
      "challenge_unavailable",
      "cursor_invalid",
      "rate_limited",
      "capacity_exceeded",
      "service_unavailable",
    ]));
    expect(agentProtocolErrorRetryability).toMatchObject({
      challenge_unavailable: false,
      cursor_invalid: false,
      rate_limited: true,
      capacity_exceeded: true,
      service_unavailable: true,
    });
    expect(agentProtocolErrorHttpStatus).toMatchObject({
      challenge_unavailable: 404,
      cursor_invalid: 400,
      rate_limited: 429,
      capacity_exceeded: 503,
      service_unavailable: 503,
    });

    for (const code of agentProtocolErrorCodes) {
      const error: Record<string, unknown> = {
        code,
        message: `${code} fixture`,
        retryable: agentProtocolErrorRetryability[code],
      };
      if (code === "unsupported_protocol_version") error.supported_versions = ["1.2"];
      if (code === "duplicate_submit") error.original_submission_id = "submission_original";
      if (agentProtocolErrorRetryability[code]) error.retry_after_seconds = 1;
      expect(agentProtocolErrorResponseSchema.safeParse({
        protocol: "CMAI_AGENT_PROTOCOL_V1",
        protocol_version: "1.2",
        server_time: fixtureTimestamp,
        error,
      }).success).toBe(true);
    }

    expect(agentProtocolErrorResponseSchema.safeParse({
      ...validProtocolErrorResponseFixture,
      error: { ...validProtocolErrorResponseFixture.error, retryable: true, retry_after_seconds: 10, original_submission_id: "submission_1" },
    }).success).toBe(false);
    expect(agentProtocolErrorResponseSchema.safeParse({
      ...validProtocolErrorResponseFixture,
      error: { code: "unsupported_protocol_version", message: "Unsupported.", retryable: false },
    }).success).toBe(false);
    expect(() => new AgentProtocolError("malformed_request", "Wrong status.", 422, false)).toThrow("must use HTTP 400");
    expect(() => new AgentProtocolError("rate_limited", "Wrong retry flag.", 429, false)).toThrow("fixed retryable=true");
    expect(() => new AgentProtocolError("service_unavailable", "Missing retry delay.", 503, true)).toThrow("requires retryAfterSeconds");
    expect(() => new AgentProtocolError("rate_limited", "Bad retry delay.", 429, true, undefined, 0)).toThrow("retryAfterSeconds");
  });

  it("owns a frozen V1 card schema independently from the application schema", () => {
    expect(agentProtocolContributionModes).toEqual(["critique", "red_team", "alternate_proposal", "steelman", "risk_audit", "judge"]);
    expect(contributionCardV1Schema).not.toBe(contributionCardSchema);
    expect(contributionCardV1Schema.safeParse(validContributionCardV1).success).toBe(true);
    expect(contributionCardSchema.safeParse(validContributionCardV1).success).toBe(true);
  });
});

describe("CMAI Agent Protocol V1 signing and authorization", () => {
  it("freezes canonical signing bytes independent of object key order", () => {
    const request = validContributionSubmitRequestFixture;
    const signingInput = {
      protocol: request.protocol,
      protocol_version: request.protocol_version,
      operation: request.operation,
      request_id: request.request_id,
      sent_at: request.sent_at,
      pairing_id: request.auth.pairing_id,
      key_id: request.auth.key_id,
      payload: request.payload,
    } as const;
    const expected = [
      "CMAI-AGENT-SIGNATURE-V1",
      "CMAI_AGENT_PROTOCOL_V1",
      "1.2",
      "contribution.submit",
      "req_submit_1",
      fixtureTimestamp,
      "pairing_1",
      "key_1",
      "807213c76134ccf02f71bce44ef1b2983220c9eb440d140b018ae518bfca01c5",
      "",
    ].join("\n");
    expect(canonicalAgentSigningBytes(signingInput)).toBe(expected);
    expect(canonicalAgentSigningBytes({ ...signingInput, payload: { provenance_claim: request.payload.provenance_claim, card: request.payload.card, audit: request.payload.audit, idempotency_key: request.payload.idempotency_key, run_nonce: request.payload.run_nonce, challenge_revision: 1, challenge_id: request.payload.challenge_id } })).toBe(expected);

    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(fixturePublicKey, "base64url"),
      ]),
      format: "der",
      type: "spki",
    });
    expect(verify(null, Buffer.from(expected, "utf8"), publicKey, Buffer.from(fixtureSignature, "base64url"))).toBe(true);
    expect(verify(null, Buffer.from(`${expected}tampered`, "utf8"), publicKey, Buffer.from(fixtureSignature, "base64url"))).toBe(false);
  });

  it("accepts only canonical unpadded Ed25519 key and signature encodings", () => {
    expect(agentProtocolPublicKeySchema.safeParse(backwardCompatiblePairCreateFixture.payload.public_key).success).toBe(true);
    expect(agentProtocolPublicKeySchema.safeParse({
      ...backwardCompatiblePairCreateFixture.payload.public_key,
      value: `${fixturePublicKey.slice(0, -1)}B`,
    }).success).toBe(false);

    const nonCanonicalSignature = jsonClone(validFeedListRequestFixture.auth) as Record<string, any>;
    nonCanonicalSignature.signature.value = `${fixtureSignature.slice(0, -1)}B`;
    expect(agentFeedListRequestSchema.safeParse({
      ...validFeedListRequestFixture,
      auth: nonCanonicalSignature,
    }).success).toBe(false);
  });

  it("rejects undefined roots and normalized-key collisions in canonical JSON", () => {
    expect(() => canonicalAgentJson(undefined)).toThrow("cannot encode undefined");
    expect(() => canonicalAgentJson({ "é": 1, "e\u0301": 2 })).toThrow("colliding normalized keys");
    expect(canonicalAgentJson({ negativeZero: -0, large: 1e21 })).toBe('{"large":1e+21,"negativeZero":0}');
  });

  it("enforces scoped operations and bounded request clock skew", () => {
    expect(() => assertAgentProtocolScope("feed.list", ["challenge:read"])).not.toThrow();
    expectProtocolError(() => assertAgentProtocolScope("contribution.submit", ["challenge:read"]), "scope_unauthorized");

    const now = new Date(fixtureTimestamp);
    expect(() => assertAgentRequestTime("2026-07-14T11:55:00.000Z", now)).not.toThrow();
    expect(() => assertAgentRequestTime("2026-07-14T12:05:00.000Z", now)).not.toThrow();
    expectProtocolError(() => assertAgentRequestTime("2026-07-14T11:54:59.999Z", now), "request_time_skew");
    expectProtocolError(() => assertAgentRequestTime("2026-07-14T12:05:00.001Z", now), "request_time_skew");
  });

  it("invalidates retired and revoked pairing keys", () => {
    const keys = new InMemoryPairingKeyRing();
    registerPairing(keys);
    expect(keys.assertActiveKey("pairing_1", "key_1").generation).toBe(1);

    keys.rotate({ pairingId: "pairing_1", replacesKeyId: "key_1", newKeyId: "key_2", generation: 2, rotatedAt: "2026-07-14T12:01:00.000Z" });
    expectProtocolError(() => keys.assertActiveKey("pairing_1", "key_1"), "pairing_key_inactive");
    expect(keys.assertActiveKey("pairing_1", "key_2").generation).toBe(2);

    keys.revokeKey({ pairingId: "pairing_1", keyId: "key_1", revokedAt: "2026-07-14T12:02:00.000Z" });
    expectProtocolError(() => keys.assertActiveKey("pairing_1", "key_1"), "pairing_key_revoked");
    keys.revokeKey({ pairingId: "pairing_1", keyId: "key_2", revokedAt: "2026-07-14T12:03:00.000Z" });
    expectProtocolError(() => keys.assertActiveKey("pairing_1", "key_2"), "pairing_revoked");
    const revokedSnapshot = keys.snapshot("pairing_1");
    expect(pairingStateSchema.safeParse(revokedSnapshot).success).toBe(true);
    expect(agentPairingMutationResponseSchema.safeParse({
      protocol: "CMAI_AGENT_PROTOCOL_V1",
      protocol_version: "1.2",
      request_id: "req_revoke_1",
      server_time: "2026-07-14T12:03:00.000Z",
      result: { pairing: revokedSnapshot },
    }).success).toBe(true);

    const revokedPairing = new InMemoryPairingKeyRing();
    registerPairing(revokedPairing, "pairing_2");
    revokedPairing.revokePairing({ pairingId: "pairing_2", revokedAt: "2026-07-14T12:03:00.000Z" });
    expectProtocolError(() => revokedPairing.assertActiveKey("pairing_2", "key_1"), "pairing_revoked");
  });
});

describe("CMAI Agent Protocol V1 nonce and submission replay behavior", () => {
  it("rejects expired nonces", () => {
    const nonces = new InMemoryRunNonceStore();
    issueNonce(nonces);
    expectProtocolError(() => nonces.consume({
      nonce: fixtureRunNonce,
      pairingId: "pairing_1",
      challengeId: "challenge_protocol_1",
      challengeRevision: 1,
      now: new Date("2026-07-14T12:10:00.000Z"),
    }), "run_nonce_expired");
  });

  it("bounds one-run grants so durable replay receipts outlive every grant", () => {
    const overlong = jsonClone(validChallengeGetResponseFixture) as Record<string, any>;
    overlong.result.challenge.run_grant.expires_at = "2026-07-14T12:15:00.001Z";
    expect(agentChallengeGetResponseSchema.safeParse(overlong).success).toBe(false);
  });

  it("never overwrites an already issued nonce", () => {
    const nonces = new InMemoryRunNonceStore();
    issueNonce(nonces);
    expectProtocolError(() => issueNonce(nonces), "run_nonce_replayed");
  });

  it("distinguishes unknown, mismatched, and replayed nonces", () => {
    const nonces = new InMemoryRunNonceStore();
    expectProtocolError(() => nonces.consume({
      nonce: fixtureRunNonce,
      pairingId: "pairing_1",
      challengeId: "challenge_protocol_1",
      challengeRevision: 1,
      now: new Date("2026-07-14T12:01:00.000Z"),
    }), "run_nonce_unknown");

    issueNonce(nonces);
    expectProtocolError(() => nonces.consume({
      nonce: fixtureRunNonce,
      pairingId: "pairing_other",
      challengeId: "challenge_protocol_1",
      challengeRevision: 1,
      now: new Date("2026-07-14T12:01:00.000Z"),
    }), "run_nonce_mismatch");
    nonces.consume({
      nonce: fixtureRunNonce,
      pairingId: "pairing_1",
      challengeId: "challenge_protocol_1",
      challengeRevision: 1,
      now: new Date("2026-07-14T12:01:00.000Z"),
    });
    expectProtocolError(() => nonces.consume({
      nonce: fixtureRunNonce,
      pairingId: "pairing_1",
      challengeId: "challenge_protocol_1",
      challengeRevision: 1,
      now: new Date("2026-07-14T12:01:01.000Z"),
    }), "run_nonce_replayed");
  });

  it("serializes competing submissions in the atomic in-memory reference", async () => {
    const nonces = new InMemoryRunNonceStore();
    issueNonce(nonces);
    const guard = new InMemorySubmissionReplayGuard(nonces);
    const base = {
      pairingId: "pairing_1",
      challengeId: "challenge_protocol_1",
      challengeRevision: 1,
      runNonce: fixtureRunNonce,
      now: new Date("2026-07-14T12:01:00.000Z"),
    };

    const results = await Promise.allSettled([
      Promise.resolve().then(() => guard.submit({ ...base, idempotencyKey: "idem_concurrent_0001", requestPayload: { attempt: 1 }, normalizedCard: { card: 1 } })),
      Promise.resolve().then(() => guard.submit({ ...base, idempotencyKey: "idem_concurrent_0002", requestPayload: { attempt: 2 }, normalizedCard: { card: 2 } })),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ code: "run_nonce_replayed" });
  });

  it("replays identical idempotent requests and distinguishes conflicts from duplicate cards", () => {
    const nonces = new InMemoryRunNonceStore();
    issueNonce(nonces);
    issueNonce(nonces, "m".repeat(43));
    const guard = new InMemorySubmissionReplayGuard(nonces);
    const rawCardA = jsonClone(validContributionCardV1) as any;
    const rawCardB = jsonClone(validContributionCardV1) as any;
    rawCardA.model_provenance.receipt_id = "fake_receipt_a";
    rawCardB.model_provenance.receipt_id = "fake_receipt_b";
    const normalizedCardA = normalizePairedAdapterContribution(rawCardA, validContributionSubmitRequestFixture.payload.audit);
    const normalizedCardB = normalizePairedAdapterContribution(rawCardB, validContributionSubmitRequestFixture.payload.audit);
    const base = {
      pairingId: "pairing_1",
      challengeId: "challenge_protocol_1",
      challengeRevision: 1,
      idempotencyKey: "idem_protocol_0001",
      runNonce: fixtureRunNonce,
      requestPayload: validContributionSubmitRequestFixture.payload,
      normalizedCard: normalizedCardA,
      now: new Date("2026-07-14T12:01:00.000Z"),
    };

    const accepted = guard.submit(base);
    const replayed = guard.submit(base);
    expect(accepted.kind).toBe("accepted");
    expect(replayed).toMatchObject({ kind: "replayed", record: { submissionId: accepted.record.submissionId } });

    expectProtocolError(() => guard.submit({ ...base, requestPayload: { changed: true } }), "idempotency_conflict");
    expectProtocolError(() => guard.submit({
      ...base,
      idempotencyKey: "idem_protocol_0002",
      runNonce: "m".repeat(43),
      normalizedCard: normalizedCardB,
    }), "duplicate_submit");
  });

  it("bounds local reference stores without evicting replay evidence", () => {
    const nonces = new InMemoryRunNonceStore(1);
    issueNonce(nonces);
    expect(() => issueNonce(nonces, "m".repeat(43))).toThrow(RangeError);

    const pairings = new InMemoryPairingKeyRing(1);
    registerPairing(pairings);
    expect(() => registerPairing(pairings, "pairing_2")).toThrow(RangeError);

    let activeKeyId = "key_1";
    for (let generation = 2; generation <= 20; generation += 1) {
      const nextKeyId = `key_${generation}`;
      pairings.rotate({
        pairingId: "pairing_1",
        replacesKeyId: activeKeyId,
        newKeyId: nextKeyId,
        generation,
        rotatedAt: new Date(Date.parse(fixtureTimestamp) + generation * 1_000).toISOString(),
      });
      activeKeyId = nextKeyId;
    }
    expect(() => pairings.rotate({
      pairingId: "pairing_1",
      replacesKeyId: activeKeyId,
      newKeyId: "key_21",
      generation: 21,
      rotatedAt: "2026-07-14T12:00:21.000Z",
    })).toThrow(RangeError);

    const submissionNonces = new InMemoryRunNonceStore(2);
    issueNonce(submissionNonces);
    issueNonce(submissionNonces, "m".repeat(43));
    const guard = new InMemorySubmissionReplayGuard(submissionNonces, 1);
    guard.submit({
      pairingId: "pairing_1",
      challengeId: "challenge_protocol_1",
      challengeRevision: 1,
      idempotencyKey: "idem_capacity_0001",
      runNonce: fixtureRunNonce,
      requestPayload: { attempt: 1 },
      normalizedCard: { card: 1 },
      now: new Date("2026-07-14T12:01:00.000Z"),
    });
    expect(() => guard.submit({
      pairingId: "pairing_1",
      challengeId: "challenge_protocol_1",
      challengeRevision: 1,
      idempotencyKey: "idem_capacity_0002",
      runNonce: "m".repeat(43),
      requestPayload: { attempt: 2 },
      normalizedCard: { card: 2 },
      now: new Date("2026-07-14T12:01:01.000Z"),
    })).toThrow(RangeError);
  });
});

describe("CMAI Agent Protocol V1 paired provenance", () => {
  it("downgrades privileged card claims to paired local unverified metadata", () => {
    const card = jsonClone(validContributionCardV1) as any;
    card.model_provenance = {
      ...card.model_provenance,
      source: "provider_signed",
      verified: true,
      provider_model_verified: true,
      verification_status: "cryptographically_verified",
      evidence_type: "provider_signature",
      receipt_id: "fake_receipt",
      receipt_sha256: "a".repeat(64),
      provider_response_id: "fake_response",
      execution_authority: "provider",
    };
    const normalized = normalizePairedAdapterContribution(card, validContributionSubmitRequestFixture.payload.audit);
    expect(normalized.model_provenance).toEqual({
      source: "client_attested",
      provider: "runtime-reported-provider",
      model: "runtime-reported-model",
      model_display_name: "Runtime-reported model",
      adapter: "hermes:cmai-hermes@1.0.0",
      verified: false,
      provider_model_verified: false,
      verification_notes: expect.stringContaining("did not remotely attest"),
      evidence_type: "client_manifest",
      verification_status: "attested",
      funding_source: "unknown",
      execution_authority: "user_connector",
    });
    expect(normalized.model_provenance).not.toHaveProperty("receipt_id");
    expect(normalized.model_provenance).not.toHaveProperty("provider_response_id");
  });
});
