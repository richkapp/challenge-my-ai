import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  agentProtocolErrorCodes,
  agentProtocolErrorRetryability,
} from "@/lib/agent-protocol/errors";
import {
  agentProtocolOperations,
  agentProtocolContributionModes,
  agentProtocolScopes,
  agentRuntimeKinds,
  CMAI_AGENT_PROTOCOL,
  CMAI_AGENT_PROTOCOL_VERSION,
  type AgentProtocolOperation,
} from "@/lib/agent-protocol/constants";
import { CREDENTIAL_FIELD_ISSUE_PREFIX, findCredentialShapedFields } from "@/lib/agent-protocol/credentials";
import {
  challengeCriteriaVersionSchema,
  challengeIntentPolicy,
  challengeIntentSchema,
  challengeSemanticsVersionSchema,
  challengeSuccessfulOutcomesSchema,
  declarativeRewardPosture,
  declarativeRewardPostureSchema,
} from "@/lib/challenges/intent";
import { pairedLocalContributionCardV1Schema } from "@/lib/validation/contributionCardProtocol";
import { assertSafeAgentRelativePath } from "@/lib/agent-feed/egress";

const identifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const boundedTextSchema = z.string().max(40_000);
const shortTextSchema = z.string().min(1).max(240);
const isoDateTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/;
const isoDateTimeSchema = z.string().regex(isoDateTimePattern).refine((value) => {
  const match = isoDateTimePattern.exec(value);
  if (!match) return false;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return false;
  return parsed.getUTCFullYear() === Number(match[1])
    && parsed.getUTCMonth() + 1 === Number(match[2])
    && parsed.getUTCDate() === Number(match[3])
    && parsed.getUTCHours() === Number(match[4])
    && parsed.getUTCMinutes() === Number(match[5])
    && parsed.getUTCSeconds() === Number(match[6])
    && parsed.getUTCMilliseconds() === Number(match[7] ?? 0);
}, "Must be a real UTC ISO-8601 calendar timestamp.");

function canonicalBase64UrlSchema(byteLength: number) {
  const encodedLength = Math.ceil((byteLength * 8) / 6);
  return z.string().length(encodedLength).regex(/^[A-Za-z0-9_-]+$/).refine((value) => {
    const decoded = Buffer.from(value, "base64url");
    return decoded.byteLength === byteLength && decoded.toString("base64url") === value;
  }, `Must be canonical unpadded base64url for exactly ${byteLength} bytes.`);
}

const base64UrlPublicKeySchema = canonicalBase64UrlSchema(32);
const base64UrlSignatureSchema = canonicalBase64UrlSchema(64);
const runNonceSchema = z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/);
const idempotencyKeySchema = z.string().min(16).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const stringListSchema = z.array(boundedTextSchema).max(100);
const contributionModeSchema = z.enum(agentProtocolContributionModes);
const scopeSchema = z.enum(agentProtocolScopes);
const runtimeSchema = z.enum(agentRuntimeKinds);
const agentRelativePathSchema = z.string().min(1).max(500).superRefine((value, ctx) => {
  try {
    assertSafeAgentRelativePath(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "Agent URLs must be canonical origin-relative paths." });
  }
});

function uniqueValues(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function addCredentialFieldIssues(value: unknown, ctx: z.RefinementCtx): void {
  for (const path of findCredentialShapedFields(value)) {
    ctx.addIssue({ code: "custom", path: [], message: `${CREDENTIAL_FIELD_ISSUE_PREFIX}${path}` });
  }
}

function credentialSafeSchema<TSchema extends z.ZodType>(schema: TSchema) {
  return z.unknown().superRefine(addCredentialFieldIssues).pipe(schema);
}

export const agentProtocolHeaderSchema = z.object({
  protocol: z.literal(CMAI_AGENT_PROTOCOL),
  protocol_version: z.literal(CMAI_AGENT_PROTOCOL_VERSION),
  request_id: identifierSchema,
  sent_at: isoDateTimeSchema,
}).strict();

export const agentProtocolPublicKeySchema = z.object({
  algorithm: z.literal("ed25519"),
  key_id: identifierSchema,
  generation: z.number().int().positive(),
  value: base64UrlPublicKeySchema,
}).strict();

export const agentProtocolInitialPublicKeySchema = agentProtocolPublicKeySchema.extend({
  generation: z.literal(1),
}).strict();

export const agentDeviceIdentitySchema = z.object({
  device_id: identifierSchema,
  display_name: shortTextSchema,
  runtime: runtimeSchema,
  runtime_version: z.string().min(1).max(80).optional(),
  adapter_name: z.string().min(1).max(80),
  adapter_version: z.string().min(1).max(80),
}).strict();

export const agentPairCreateRequestSchema = credentialSafeSchema(z.object({
  protocol: z.literal(CMAI_AGENT_PROTOCOL),
  protocol_version: z.literal(CMAI_AGENT_PROTOCOL_VERSION),
  operation: z.literal("pair.create"),
  request_id: identifierSchema,
  sent_at: isoDateTimeSchema,
  payload: z.object({
    pairing_code: z.string().min(6).max(64).regex(/^[A-Z0-9-]+$/),
    device: agentDeviceIdentitySchema,
    public_key: agentProtocolInitialPublicKeySchema,
    requested_scopes: z.array(scopeSchema).min(1).max(agentProtocolScopes.length).refine(uniqueValues, "Scopes must be unique."),
  }).strict(),
}).strict());

export const agentProtocolRequestAuthSchema = z.object({
  pairing_id: identifierSchema,
  key_id: identifierSchema,
  signature: z.object({
    algorithm: z.literal("ed25519"),
    value: base64UrlSignatureSchema,
  }).strict(),
}).strict();

function signedRequestSchema<const TOperation extends Exclude<AgentProtocolOperation, "pair.create">, TPayload extends z.ZodType>(
  operation: TOperation,
  payload: TPayload,
) {
  return credentialSafeSchema(z.object({
    protocol: z.literal(CMAI_AGENT_PROTOCOL),
    protocol_version: z.literal(CMAI_AGENT_PROTOCOL_VERSION),
    operation: z.literal(operation),
    request_id: identifierSchema,
    sent_at: isoDateTimeSchema,
    auth: agentProtocolRequestAuthSchema,
    payload,
  }).strict());
}

export const pairingKeyStateSchema = z.object({
  key_id: identifierSchema,
  generation: z.number().int().positive(),
  status: z.enum(["active", "retired", "revoked"]),
  activated_at: isoDateTimeSchema,
  retired_at: isoDateTimeSchema.optional(),
  revoked_at: isoDateTimeSchema.optional(),
}).strict().superRefine((key, ctx) => {
  if (key.status === "active" && (key.retired_at || key.revoked_at)) ctx.addIssue({ code: "custom", path: ["status"], message: "Active keys cannot have retirement or revocation timestamps." });
  if (key.status === "retired" && !key.retired_at) ctx.addIssue({ code: "custom", path: ["retired_at"], message: "Retired keys require retired_at." });
  if (key.status === "revoked" && !key.revoked_at) ctx.addIssue({ code: "custom", path: ["revoked_at"], message: "Revoked keys require revoked_at." });
});

export const pairingStateSchema = z.object({
  pairing_id: identifierSchema,
  device_id: identifierSchema,
  status: z.enum(["active", "revoked"]),
  granted_scopes: z.array(scopeSchema).min(1).max(agentProtocolScopes.length).refine(uniqueValues, "Scopes must be unique."),
  keys: z.array(pairingKeyStateSchema).min(1).max(20),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
  revoked_at: isoDateTimeSchema.optional(),
}).strict().superRefine((pairing, ctx) => {
  const activeKeys = pairing.keys.filter((key) => key.status === "active");
  if (new Set(pairing.keys.map((key) => key.key_id)).size !== pairing.keys.length) ctx.addIssue({ code: "custom", path: ["keys"], message: "Pairing key IDs must be unique." });
  if (new Set(pairing.keys.map((key) => key.generation)).size !== pairing.keys.length) ctx.addIssue({ code: "custom", path: ["keys"], message: "Pairing key generations must be unique." });
  if (pairing.status === "active" && activeKeys.length !== 1) ctx.addIssue({ code: "custom", path: ["keys"], message: "Active pairings require exactly one active key." });
  if (pairing.status === "active" && activeKeys[0]?.generation !== Math.max(...pairing.keys.map((key) => key.generation))) ctx.addIssue({ code: "custom", path: ["keys"], message: "The active key must have the highest generation." });
  if (pairing.status === "active" && pairing.revoked_at) ctx.addIssue({ code: "custom", path: ["revoked_at"], message: "Active pairings cannot have revoked_at." });
  if (pairing.status === "revoked" && !pairing.revoked_at) ctx.addIssue({ code: "custom", path: ["revoked_at"], message: "Revoked pairings require revoked_at." });
  if (pairing.status === "revoked" && activeKeys.length > 0) ctx.addIssue({ code: "custom", path: ["keys"], message: "Revoked pairings cannot retain an active key." });
});

export const agentPairCreateResponseSchema = z.object({
  protocol: z.literal(CMAI_AGENT_PROTOCOL),
  protocol_version: z.literal(CMAI_AGENT_PROTOCOL_VERSION),
  request_id: identifierSchema,
  server_time: isoDateTimeSchema,
  result: z.object({ pairing: pairingStateSchema }).strict(),
}).strict();

export const agentPairingRotateKeyRequestSchema = signedRequestSchema("pairing.rotate_key", z.object({
  replaces_key_id: identifierSchema,
  new_public_key: agentProtocolPublicKeySchema,
}).strict().superRefine((payload, ctx) => {
  if (payload.replaces_key_id === payload.new_public_key.key_id) ctx.addIssue({ code: "custom", path: ["new_public_key", "key_id"], message: "Rotated key_id must be new." });
}));

export const agentPairingRevokeRequestSchema = signedRequestSchema("pairing.revoke", z.object({
  revoke: z.enum(["pairing", "key"]),
  key_id: identifierSchema.optional(),
  reason: z.enum(["user_requested", "device_lost", "suspected_compromise", "rotation_cleanup"]),
}).strict().superRefine((payload, ctx) => {
  if (payload.revoke === "key" && !payload.key_id) ctx.addIssue({ code: "custom", path: ["key_id"], message: "Key revocation requires key_id." });
  if (payload.revoke === "pairing" && payload.key_id) ctx.addIssue({ code: "custom", path: ["key_id"], message: "Pairing revocation must not include key_id." });
}));

const feedQuerySchema = z.object({
  cursor: z.string().min(1).max(300).optional(),
  limit: z.number().int().min(1).max(50),
  query: z.string().max(200).optional(),
  category: z.string().min(1).max(100).optional(),
  requested_modes: z.array(contributionModeSchema).max(agentProtocolContributionModes.length).refine(uniqueValues, "Requested modes must be unique.").optional(),
  min_reward_credits: z.number().int().nonnegative().optional(),
}).strict();

export const agentFeedListRequestSchema = signedRequestSchema("feed.list", feedQuerySchema);
export const agentChallengeGetRequestSchema = signedRequestSchema("challenge.get", z.object({ challenge_id: identifierSchema }).strict());

export const agentPublicChallengeSummarySchema = z.object({
  challenge_id: identifierSchema,
  revision: z.number().int().positive(),
  title: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  status: z.enum(["open", "contributing", "ready_for_synthesis"]),
  summary: boundedTextSchema,
  requested_modes: z.array(contributionModeSchema).min(1).max(agentProtocolContributionModes.length).refine(uniqueValues, "Requested modes must be unique."),
  requested_perspectives: z.array(z.string().min(1).max(240)).min(1).max(12),
  reward_credits: z.number().int().nonnegative(),
  contribution_count: z.number().int().nonnegative(),
  safety_flags: z.array(z.string().min(1).max(160)).max(30),
  published_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
  urls: z.object({
    room: agentRelativePathSchema,
    challenge: agentRelativePathSchema,
  }).strict(),
}).strict();

export const agentFeedListResponseSchema = z.object({
  protocol: z.literal(CMAI_AGENT_PROTOCOL),
  protocol_version: z.literal(CMAI_AGENT_PROTOCOL_VERSION),
  request_id: identifierSchema,
  server_time: isoDateTimeSchema,
  result: z.object({
    challenges: z.array(agentPublicChallengeSummarySchema).max(50),
    next_cursor: z.string().min(1).max(300).optional(),
  }).strict(),
}).strict();

export const agentChallengeRunGrantSchema = z.object({
  run_nonce: runNonceSchema,
  issued_at: isoDateTimeSchema,
  expires_at: isoDateTimeSchema,
  request_class: z.literal("challenge_contribution"),
  challenge_revision: z.number().int().positive(),
  prompt_version: z.string().min(1).max(80),
  max_output_bytes: z.number().int().positive().max(256 * 1024),
}).strict().superRefine((grant, ctx) => {
  const issuedAt = Date.parse(grant.issued_at);
  const expiresAt = Date.parse(grant.expires_at);
  if (expiresAt <= issuedAt) ctx.addIssue({ code: "custom", path: ["expires_at"], message: "Run nonce expiry must be after issue time." });
  if (expiresAt > issuedAt + 10 * 60_000) ctx.addIssue({ code: "custom", path: ["expires_at"], message: "Run nonce lifetime must not exceed 10 minutes." });
});

export const agentPublicChallengeSemanticsSchema = z.object({
  challenge_semantics_version: challengeSemanticsVersionSchema,
  challenge_intent: challengeIntentSchema,
  criteria_status: z.literal("confirmed"),
  criteria_version: challengeCriteriaVersionSchema,
  successful_outcomes: challengeSuccessfulOutcomesSchema,
  privacy_sensitivity: z.literal("public_ok"),
  reward_posture: declarativeRewardPostureSchema,
}).strict().superRefine((value, context) => {
  const expectedOutcomes = challengeIntentPolicy(value.challenge_intent).successfulOutcomes;
  const outcomesMatch = value.successful_outcomes.length === expectedOutcomes.length
    && value.successful_outcomes.every((outcome, index) => outcome === expectedOutcomes[index]);
  if (!outcomesMatch) {
    context.addIssue({
      code: "custom",
      path: ["successful_outcomes"],
      message: `${value.challenge_intent} challenges allow only: ${expectedOutcomes.join(", ")}.`,
    });
  }

  const expectedRewardPosture = declarativeRewardPosture(value.challenge_intent);
  if (JSON.stringify(value.reward_posture) !== JSON.stringify(expectedRewardPosture)) {
    context.addIssue({
      code: "custom",
      path: ["reward_posture"],
      message: "Reward posture must match the selected challenge intent.",
    });
  }
});

export const agentPublicChallengeSchema = agentPublicChallengeSummarySchema.extend({
  challenge_semantics: agentPublicChallengeSemanticsSchema,
  content: z.object({
    problem_statement: boundedTextSchema,
    original_ai_answer: boundedTextSchema,
    context: boundedTextSchema,
    constraints: stringListSchema,
    success_criteria: stringListSchema,
    assumptions_to_test: stringListSchema,
    claims_to_check: stringListSchema,
    known_risks: stringListSchema,
    useful_response_should_address: stringListSchema,
    missing_information: stringListSchema,
  }).strict(),
  run_grant: agentChallengeRunGrantSchema,
}).strict();

export const agentChallengeGetResponseSchema = z.object({
  protocol: z.literal(CMAI_AGENT_PROTOCOL),
  protocol_version: z.literal(CMAI_AGENT_PROTOCOL_VERSION),
  request_id: identifierSchema,
  server_time: isoDateTimeSchema,
  result: z.object({ challenge: agentPublicChallengeSchema }).strict(),
}).strict().superRefine((response, ctx) => {
  if (response.result.challenge.revision !== response.result.challenge.run_grant.challenge_revision) ctx.addIssue({ code: "custom", path: ["result", "challenge", "run_grant", "challenge_revision"], message: "Run grant revision must match the challenge revision." });
});

const pairedAdapterRunAuditFields = {
  runtime: runtimeSchema,
  runtime_version: z.string().min(1).max(80).optional(),
  adapter_name: z.string().min(1).max(80),
  adapter_version: z.string().min(1).max(80),
  local_run_id: identifierSchema,
  provider_claim: z.string().min(1).max(160).optional(),
  model_claim: z.string().min(1).max(240).optional(),
  model_display_name_claim: z.string().min(1).max(240).optional(),
  started_at: isoDateTimeSchema,
  completed_at: isoDateTimeSchema,
  structured_output_validated: z.literal(true),
  user_approved_run: z.literal(true),
  edited_after_run: z.boolean(),
} as const;

function validatePairedAdapterAuditTimes(
  audit: { started_at: string; completed_at: string },
  ctx: z.RefinementCtx,
): void {
  if (Date.parse(audit.completed_at) < Date.parse(audit.started_at)) ctx.addIssue({ code: "custom", path: ["completed_at"], message: "completed_at must not precede started_at." });
}

export const pairedAdapterRunAuditMetadataSchema = z.object(pairedAdapterRunAuditFields)
  .strict()
  .superRefine(validatePairedAdapterAuditTimes);

export const pairedAdapterAuditMetadataSchema = z.object({
  ...pairedAdapterRunAuditFields,
  user_approved_submit: z.literal(true),
}).strict().superRefine(validatePairedAdapterAuditTimes);

export const pairedLocalProvenanceClaimSchema = z.object({
  tier: z.literal("paired_local_agent"),
  model_identity: z.literal("runtime_reported_unverified"),
  provider_verified: z.literal(false),
  remote_attestation: z.literal(false),
}).strict();

export const agentContributionSubmitRequestSchema = signedRequestSchema("contribution.submit", z.object({
  challenge_id: identifierSchema,
  challenge_revision: z.number().int().positive(),
  run_nonce: runNonceSchema,
  idempotency_key: idempotencyKeySchema,
  card: pairedLocalContributionCardV1Schema,
  audit: pairedAdapterAuditMetadataSchema,
  provenance_claim: pairedLocalProvenanceClaimSchema,
}).strict().superRefine((payload, ctx) => {
  if (payload.card.challenge_id !== payload.challenge_id) ctx.addIssue({ code: "custom", path: ["card", "challenge_id"], message: "Contribution card challenge_id must match the submission challenge_id." });
}));

export const agentContributionSubmitResponseSchema = z.object({
  protocol: z.literal(CMAI_AGENT_PROTOCOL),
  protocol_version: z.literal(CMAI_AGENT_PROTOCOL_VERSION),
  request_id: identifierSchema,
  server_time: isoDateTimeSchema,
  result: z.object({
    submission_id: identifierSchema,
    contribution_id: identifierSchema,
    status: z.literal("accepted"),
    replayed: z.boolean(),
    accepted_at: isoDateTimeSchema,
    trust: z.object({
      tier: z.literal("paired_local_agent"),
      provider_verified: z.literal(false),
      remote_attestation: z.literal(false),
    }).strict(),
  }).strict(),
}).strict();

export const agentPairingMutationResponseSchema = z.object({
  protocol: z.literal(CMAI_AGENT_PROTOCOL),
  protocol_version: z.literal(CMAI_AGENT_PROTOCOL_VERSION),
  request_id: identifierSchema,
  server_time: isoDateTimeSchema,
  result: z.object({ pairing: pairingStateSchema }).strict(),
}).strict();

const agentProtocolErrorBodySchema = z.object({
  code: z.enum(agentProtocolErrorCodes),
  message: z.string().min(1).max(500),
  retryable: z.boolean(),
  field: z.string().min(1).max(300).optional(),
  retry_after_seconds: z.number().int().positive().max(86_400).optional(),
  supported_versions: z.array(z.literal(CMAI_AGENT_PROTOCOL_VERSION)).length(1).optional(),
  original_submission_id: identifierSchema.optional(),
}).strict().superRefine((error, ctx) => {
  if (error.retryable !== agentProtocolErrorRetryability[error.code]) {
    ctx.addIssue({ code: "custom", path: ["retryable"], message: `${error.code} has fixed retryable semantics.` });
  }
  if (error.code === "unsupported_protocol_version" && !error.supported_versions) {
    ctx.addIssue({ code: "custom", path: ["supported_versions"], message: "Unsupported-version errors require the supported version list." });
  }
  if (error.code !== "unsupported_protocol_version" && error.supported_versions) {
    ctx.addIssue({ code: "custom", path: ["supported_versions"], message: "supported_versions is reserved for unsupported_protocol_version." });
  }
  if (error.retry_after_seconds && !error.retryable) {
    ctx.addIssue({ code: "custom", path: ["retry_after_seconds"], message: "retry_after_seconds is allowed only on retryable errors." });
  }
  if (error.retryable && !error.retry_after_seconds) {
    ctx.addIssue({ code: "custom", path: ["retry_after_seconds"], message: "Retryable errors require retry_after_seconds." });
  }
  if (error.code !== "duplicate_submit" && error.original_submission_id) {
    ctx.addIssue({ code: "custom", path: ["original_submission_id"], message: "original_submission_id is reserved for duplicate_submit." });
  }
});

export const agentProtocolErrorResponseSchema = z.object({
  protocol: z.literal(CMAI_AGENT_PROTOCOL),
  protocol_version: z.literal(CMAI_AGENT_PROTOCOL_VERSION),
  request_id: identifierSchema.optional(),
  server_time: isoDateTimeSchema,
  error: agentProtocolErrorBodySchema,
}).strict();

export const agentProtocolRequestSchemas = {
  "pair.create": agentPairCreateRequestSchema,
  "pairing.rotate_key": agentPairingRotateKeyRequestSchema,
  "pairing.revoke": agentPairingRevokeRequestSchema,
  "feed.list": agentFeedListRequestSchema,
  "challenge.get": agentChallengeGetRequestSchema,
  "contribution.submit": agentContributionSubmitRequestSchema,
} as const satisfies Record<(typeof agentProtocolOperations)[number], z.ZodType>;

export type AgentPairCreateRequest = z.infer<typeof agentPairCreateRequestSchema>;
export type AgentPairingRotateKeyRequest = z.infer<typeof agentPairingRotateKeyRequestSchema>;
export type AgentPairingRevokeRequest = z.infer<typeof agentPairingRevokeRequestSchema>;
export type AgentFeedListRequest = z.infer<typeof agentFeedListRequestSchema>;
export type AgentChallengeGetRequest = z.infer<typeof agentChallengeGetRequestSchema>;
export type AgentContributionSubmitRequest = z.infer<typeof agentContributionSubmitRequestSchema>;
export type AgentFeedListResponse = z.infer<typeof agentFeedListResponseSchema>;
export type AgentChallengeGetResponse = z.infer<typeof agentChallengeGetResponseSchema>;
export type AgentPublicChallengeSummary = z.infer<typeof agentPublicChallengeSummarySchema>;
export type AgentPublicChallenge = z.infer<typeof agentPublicChallengeSchema>;
export type AgentContributionSubmitResponse = z.infer<typeof agentContributionSubmitResponseSchema>;
export type AgentProtocolErrorResponse = z.infer<typeof agentProtocolErrorResponseSchema>;
export type PairedAdapterAuditMetadata = z.infer<typeof pairedAdapterAuditMetadataSchema>;
export type PairedAdapterRunAuditMetadata = z.infer<typeof pairedAdapterRunAuditMetadataSchema>;
export type AgentChallengeRunGrant = z.infer<typeof agentChallengeRunGrantSchema>;
