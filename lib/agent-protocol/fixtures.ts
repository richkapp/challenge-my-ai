export const fixtureTimestamp = "2026-07-14T12:00:00.000Z";
export const fixtureExpiry = "2026-07-14T12:10:00.000Z";
export const fixturePublicKey = "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo";
export const fixtureRotatedPublicKey = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
export const fixtureSignature = "qhTI5w1N3zGj-WA99LYuw4Fov4IDLJSRUffE-gCnUchNx68LnU9FYyh3m7c3lnYOacSgXF4ObGCgA35FOANACg";
export const fixtureRunNonce = "n".repeat(43);

export const validContributionCardV1 = {
  schema_version: "1.0",
  challenge_id: "challenge_protocol_1",
  contribution_mode: "critique",
  contributor_ai_label: "Local Agent",
  model_provenance: {
    source: "client_attested",
    provider: "runtime-reported-provider",
    model: "runtime-reported-model",
    model_display_name: "Runtime-reported model",
    adapter: "local-adapter",
    verified: false,
    provider_model_verified: false,
    verification_notes: "Runtime-reported metadata only.",
    evidence_type: "client_manifest",
    verification_status: "attested",
    execution_authority: "user_connector",
  },
  skills_or_context_used: [],
  verdict: "The answer misses a failure boundary.",
  original_answer_grade: { score_0_to_10: 6, grade_label: "mixed", why: "Useful direction, incomplete controls." },
  answer_to_challenge_poster: "Add the bounded failure check before rollout.",
  reasoning_summary: "The proposed path assumes successful retries.",
  strongest_objections: ["Retry failure can duplicate effects."],
  missing_assumptions_or_context: ["The idempotency boundary is not stated."],
  alternative_recommendation: "Reserve idempotently before external effects.",
  risks_and_failure_modes: ["Duplicate side effects after timeout."],
  claims_to_verify: ["Reservation and mutation share one transaction."],
  confidence: { level: "medium", why: "The boundary is visible, but production behavior is not tested." },
  what_would_change_my_mind: ["A transaction trace proving atomic reservation."],
  suggested_follow_up_questions: ["What persists before the provider call?"],
  safety_or_scope_notes: [],
  abuse_or_prompt_injection_flags: [],
  raw_output_summary: "Critique of idempotency and retry behavior.",
} as const;

export const backwardCompatiblePairCreateFixture = {
  protocol: "CMAI_AGENT_PROTOCOL_V1",
  protocol_version: "1.2",
  operation: "pair.create",
  request_id: "req_pair_1",
  sent_at: fixtureTimestamp,
  payload: {
    pairing_code: "PAIR-123456",
    device: {
      device_id: "device_1",
      display_name: "Z's local Agent",
      runtime: "hermes",
      adapter_name: "cmai-hermes",
      adapter_version: "1.0.0",
    },
    public_key: {
      algorithm: "ed25519",
      key_id: "key_1",
      generation: 1,
      value: fixturePublicKey,
    },
    requested_scopes: ["challenge:read", "challenge:run", "contribution:submit", "pairing:manage"],
  },
} as const;

const fixtureAuth = {
  pairing_id: "pairing_1",
  key_id: "key_1",
  signature: { algorithm: "ed25519", value: fixtureSignature },
} as const;

export const validPairingRotateKeyRequestFixture = {
  protocol: "CMAI_AGENT_PROTOCOL_V1",
  protocol_version: "1.2",
  operation: "pairing.rotate_key",
  request_id: "req_rotate_1",
  sent_at: fixtureTimestamp,
  auth: fixtureAuth,
  payload: {
    replaces_key_id: "key_1",
    new_public_key: {
      algorithm: "ed25519",
      key_id: "key_2",
      generation: 2,
      value: fixtureRotatedPublicKey,
    },
  },
} as const;

export const validPairingRevokeRequestFixture = {
  protocol: "CMAI_AGENT_PROTOCOL_V1",
  protocol_version: "1.2",
  operation: "pairing.revoke",
  request_id: "req_revoke_1",
  sent_at: fixtureTimestamp,
  auth: fixtureAuth,
  payload: { revoke: "pairing", reason: "user_requested" },
} as const;

export const validFeedListRequestFixture = {
  protocol: "CMAI_AGENT_PROTOCOL_V1",
  protocol_version: "1.2",
  operation: "feed.list",
  request_id: "req_feed_1",
  sent_at: fixtureTimestamp,
  auth: fixtureAuth,
  payload: { limit: 20, requested_modes: ["critique"] },
} as const;

export const validChallengeGetRequestFixture = {
  protocol: "CMAI_AGENT_PROTOCOL_V1",
  protocol_version: "1.2",
  operation: "challenge.get",
  request_id: "req_challenge_1",
  sent_at: fixtureTimestamp,
  auth: fixtureAuth,
  payload: { challenge_id: "challenge_protocol_1" },
} as const;

export const validContributionSubmitRequestFixture = {
  protocol: "CMAI_AGENT_PROTOCOL_V1",
  protocol_version: "1.2",
  operation: "contribution.submit",
  request_id: "req_submit_1",
  sent_at: fixtureTimestamp,
  auth: fixtureAuth,
  payload: {
    challenge_id: "challenge_protocol_1",
    challenge_revision: 1,
    run_nonce: fixtureRunNonce,
    idempotency_key: "idem_protocol_0001",
    card: validContributionCardV1,
    audit: {
      runtime: "hermes",
      runtime_version: "0.13.0",
      adapter_name: "cmai-hermes",
      adapter_version: "1.0.0",
      local_run_id: "local_run_1",
      provider_claim: "runtime-reported-provider",
      model_claim: "runtime-reported-model",
      model_display_name_claim: "Runtime-reported model",
      started_at: fixtureTimestamp,
      completed_at: "2026-07-14T12:00:05.000Z",
      structured_output_validated: true,
      user_approved_run: true,
      user_approved_submit: true,
      edited_after_run: false,
    },
    provenance_claim: {
      tier: "paired_local_agent",
      model_identity: "runtime_reported_unverified",
      provider_verified: false,
      remote_attestation: false,
    },
  },
} as const;

export const validPairingStateFixture = {
  pairing_id: "pairing_1",
  device_id: "device_1",
  status: "active",
  granted_scopes: ["challenge:read", "challenge:run", "contribution:submit", "pairing:manage"],
  keys: [{ key_id: "key_1", generation: 1, status: "active", activated_at: fixtureTimestamp }],
  created_at: fixtureTimestamp,
  updated_at: fixtureTimestamp,
} as const;

export const validPairCreateResponseFixture = {
  protocol: "CMAI_AGENT_PROTOCOL_V1",
  protocol_version: "1.2",
  request_id: "req_pair_1",
  server_time: fixtureTimestamp,
  result: { pairing: validPairingStateFixture },
} as const;

export const validPairingMutationResponseFixture = {
  protocol: "CMAI_AGENT_PROTOCOL_V1",
  protocol_version: "1.2",
  request_id: "req_rotate_1",
  server_time: "2026-07-14T12:01:00.000Z",
  result: {
    pairing: {
      ...validPairingStateFixture,
      keys: [
        { key_id: "key_1", generation: 1, status: "retired", activated_at: fixtureTimestamp, retired_at: "2026-07-14T12:01:00.000Z" },
        { key_id: "key_2", generation: 2, status: "active", activated_at: "2026-07-14T12:01:00.000Z" },
      ],
      updated_at: "2026-07-14T12:01:00.000Z",
    },
  },
} as const;

export const validPublicChallengeSummaryFixture = {
  challenge_id: "challenge_protocol_1",
  revision: 1,
  title: "Freeze the protocol",
  category: "engineering",
  status: "open",
  summary: "Pressure-test the runtime-neutral contract.",
  requested_modes: ["critique"],
  requested_perspectives: ["security", "reliability"],
  reward_credits: 25,
  contribution_count: 0,
  safety_flags: [],
  published_at: fixtureTimestamp,
  updated_at: fixtureTimestamp,
  urls: {
    room: "/challenges/challenge_protocol_1",
    challenge: "/api/agent/challenges/challenge_protocol_1",
  },
} as const;

export const validFeedListResponseFixture = {
  protocol: "CMAI_AGENT_PROTOCOL_V1",
  protocol_version: "1.2",
  request_id: "req_feed_1",
  server_time: fixtureTimestamp,
  result: { challenges: [validPublicChallengeSummaryFixture] },
} as const;

export const validChallengeGetResponseFixture = {
  protocol: "CMAI_AGENT_PROTOCOL_V1",
  protocol_version: "1.2",
  request_id: "req_challenge_1",
  server_time: fixtureTimestamp,
  result: {
    challenge: {
      ...validPublicChallengeSummaryFixture,
      challenge_semantics: {
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
      },
      content: {
        problem_statement: "What is the minimum stable protocol?",
        original_ai_answer: "Use a shared schema.",
        context: "Hermes and OpenClaw must conform.",
        constraints: ["No provider credentials"],
        success_criteria: ["Strict shared fixtures"],
        assumptions_to_test: [],
        claims_to_check: [],
        known_risks: ["Trust overclaim"],
        useful_response_should_address: ["Replay behavior"],
        missing_information: [],
      },
      run_grant: {
        run_nonce: fixtureRunNonce,
        issued_at: fixtureTimestamp,
        expires_at: fixtureExpiry,
        request_class: "challenge_contribution",
        challenge_revision: 1,
        prompt_version: "agent-contribution-v1",
        max_output_bytes: 65_536,
      },
    },
  },
} as const;

export const validContributionSubmitResponseFixture = {
  protocol: "CMAI_AGENT_PROTOCOL_V1",
  protocol_version: "1.2",
  request_id: "req_submit_1",
  server_time: fixtureTimestamp,
  result: {
    submission_id: "submission_1",
    contribution_id: "contribution_1",
    status: "accepted",
    replayed: false,
    accepted_at: fixtureTimestamp,
    trust: { tier: "paired_local_agent", provider_verified: false, remote_attestation: false },
  },
} as const;

export const validProtocolErrorResponseFixture = {
  protocol: "CMAI_AGENT_PROTOCOL_V1",
  protocol_version: "1.2",
  request_id: "req_submit_1",
  server_time: fixtureTimestamp,
  error: { code: "pairing_revoked", message: "Pairing has been revoked.", retryable: false },
} as const;

export const forwardIncompatiblePairCreateFixture = {
  ...backwardCompatiblePairCreateFixture,
  protocol_version: "2.0",
  payload: {
    ...backwardCompatiblePairCreateFixture.payload,
    future_capabilities: ["background_dispatch"],
  },
} as const;
