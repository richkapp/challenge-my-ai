import { z } from "zod";
import {
  challengeCriteriaHistorySchema,
  challengeCriteriaStatusSchema,
  challengeCriteriaVersionSchema,
  challengeIntentSchema,
  challengeSemanticsVersionSchema,
  challengeSuccessfulOutcomesSchema,
  declarativeRewardPostureSchema,
} from "@/lib/challenges/intent";
import {
  agentConnectionKinds,
  agentConnectionReadinessStates,
  agentConnectionSmokeStatuses,
  agentConnectionStatuses,
  agentProviderAuthClasses,
  agentHomeSetupStatuses,
  agentRequestClasses,
  agentRunStatuses,
  contributionModes,
  modelExecutionAuthorities,
  modelFundingSources,
  modelProvenanceEvidenceTypes,
  modelProvenanceSources,
  modelProvenanceVerificationStatuses,
  sandboxNetworkIsolations,
  sandboxProviders,
} from "@/lib/types";

const modeSchema = z.enum(contributionModes);
const modelProvenanceSourceSchema = z.enum(modelProvenanceSources);
const modelFundingSourceSchema = z.enum(modelFundingSources);
const modelExecutionAuthoritySchema = z.enum(modelExecutionAuthorities);
const modelProvenanceEvidenceTypeSchema = z.enum(modelProvenanceEvidenceTypes);
const modelProvenanceVerificationStatusSchema = z.enum(modelProvenanceVerificationStatuses);
const sandboxProviderSchema = z.enum(sandboxProviders);
const sandboxNetworkIsolationSchema = z.enum(sandboxNetworkIsolations);
const agentConnectionStatusSchema = z.enum(agentConnectionStatuses);
const agentProviderAuthClassSchema = z.enum(agentProviderAuthClasses);
const agentConnectionKindSchema = z.enum(agentConnectionKinds);
const agentConnectionAuthModeSchema = agentConnectionKindSchema;
const agentConnectionReadinessStateSchema = z.enum(agentConnectionReadinessStates);
const agentHomeSetupStatusSchema = z.enum(agentHomeSetupStatuses);
const agentHomeStatusSchema = agentHomeSetupStatusSchema;
const agentRequestClassSchema = z.enum(agentRequestClasses);
const agentRunStatusSchema = z.enum(agentRunStatuses);
const agentConnectionSmokeStatusSchema = z.enum(agentConnectionSmokeStatuses);
const agentSmokeTestStatusSchema = agentConnectionSmokeStatusSchema;
const stringArray = z.array(z.string());
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/i);

const deniedChildRunKeys = new Set([
  "api_key",
  "access_token",
  "refresh_token",
  "oauth_access_token",
  "oauth_refresh_token",
  "database_url",
  "postgres_url",
  "receipt_signing_key",
  "receipt_signing_secret",
  "broker_token",
  "broker_internal_token",
  "service_role",
  "service_role_key",
  "supabase_service_role_key",
]);

function normalizeSecretKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[-.\s]+/g, "_").toLowerCase();
}

function addDeniedChildRunKeyIssues(value: unknown, ctx: z.RefinementCtx, path: (string | number)[] = []): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((child, index) => addDeniedChildRunKeyIssues(child, ctx, [...path, index]));
    return;
  }

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (deniedChildRunKeys.has(normalizeSecretKey(key))) {
      ctx.addIssue({ code: "custom", path: [...path, key], message: `Child run input must not include raw secret field ${[...path, key].join(".")}.` });
    }
    addDeniedChildRunKeyIssues(child, ctx, [...path, key]);
  }
}
export const agentConnectionDelegationSchema = z.object({
  delegation_id: z.string().min(1).optional(),
  connection_id: z.string().min(1),
  agent_connection_id: z.string().min(1).optional(),
  provider: z.string().min(1),
  allowed_model: z.string().min(1).optional(),
  allowed_request_class: z.string().min(1).optional(),
  expires_at: z.string().min(1),
  max_spend_cents: z.number().int().nonnegative().optional(),
  no_spend_reason: z.string().min(1).optional(),
  max_requests: z.number().int().positive().optional(),
}).strict();

export const oneRunDelegationSchema = z.object({
  id: z.string().min(1),
  agentHomeId: z.string().min(1),
  connectionId: z.string().min(1),
  challengeId: z.string().min(1),
  contributorId: z.string().min(1),
  requestedMode: modeSchema,
  requestClass: z.string().min(1),
  status: z.enum(["issued", "consumed", "revoked", "expired"]),
  expiresAt: z.string().min(1),
  maxRequests: z.number().int().positive(),
  maxSpendCents: z.number().int().nonnegative().optional(),
  noSpendLimitReason: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  consumedAt: z.string().min(1).optional(),
  revokedAt: z.string().min(1).optional(),
}).strict().superRefine((delegation, ctx) => {
  if (delegation.maxSpendCents === undefined && !delegation.noSpendLimitReason) {
    ctx.addIssue({ code: "custom", path: ["maxSpendCents"], message: "One-run delegation requires either maxSpendCents or noSpendLimitReason." });
  }
});

export const agentConnectionSmokeResultSchema = z.object({
  status: agentConnectionSmokeStatusSchema,
  checkedAt: z.string().min(1).optional(),
  message: z.string().min(1),
  failureCode: z.string().min(1).optional(),
  redacted: z.boolean().optional(),
}).strict();

export const agentConnectionReadinessSchema = z.object({
  state: agentConnectionReadinessStateSchema,
  label: z.string().min(1),
  detail: z.string().min(1),
  canRunHere: z.boolean(),
}).strict();

export const agentConnectionSchema = z.object({
  id: z.string().min(1),
  agentHomeId: z.string().min(1),
  ownerId: z.string().min(1),
  displayLabel: z.string().min(1),
  provider: z.string().min(1),
  providerLabel: z.string().min(1),
  connectionKind: agentConnectionKindSchema,
  status: agentConnectionStatusSchema,
  readiness: agentConnectionReadinessSchema,
  defaultModel: z.string().min(1),
  allowedModels: z.array(z.string().min(1)),
  allowedRequestClasses: z.array(modeSchema),
  metadataVerification: modelProvenanceVerificationStatusSchema,
  exactModelMetadata: z.boolean(),
  sandboxTrustLabel: z.string().min(1),
  setupInstructions: z.string().min(1),
  liveModelProxyCaller: z.boolean(),
  providerReadiness: z.string().min(1),
  authClass: agentProviderAuthClassSchema,
  countsForMvpUserPlan: z.boolean(),
  authSetupLabel: z.string().min(1),
  authReadinessCopy: z.string().min(1),
  setupMechanisms: z.array(z.string().min(1)),
  complianceCopy: z.string().min(1),
  manualPasteFallbackCopy: z.string().min(1),
  brokerCredentialAvailable: z.boolean().optional(),
  credentialUpdatedAt: z.string().min(1).optional(),
  credentialRotatedAt: z.string().min(1).optional(),
  credentialExpiresAt: z.string().min(1).optional(),
  credentialPublicMetadata: z.record(z.string(), z.string()).optional(),
  lastSmoke: agentConnectionSmokeResultSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict().superRefine((connection, ctx) => {
  if (connection.status !== "ready") return;
  if (connection.countsForMvpUserPlan && (!connection.readiness.canRunHere || connection.readiness.state !== "ready")) ctx.addIssue({ code: "custom", path: ["readiness"], message: "MVP user-plan ready connections require ready, runnable readiness." });
  if (!connection.countsForMvpUserPlan && connection.readiness.canRunHere) ctx.addIssue({ code: "custom", path: ["readiness"], message: "API-only or non-MVP connections must not be runnable as normal-user trusted runs." });
  if (connection.allowedRequestClasses.length === 0) ctx.addIssue({ code: "custom", path: ["allowedRequestClasses"], message: "Ready connections require at least one allowed request class." });
  if (connection.allowedModels.length === 0) ctx.addIssue({ code: "custom", path: ["allowedModels"], message: "Ready connections require at least one allowed model." });
  if (connection.lastSmoke.status !== "passed") ctx.addIssue({ code: "custom", path: ["lastSmoke"], message: "Ready connections require a passed smoke test result." });
  if (!connection.ownerId) ctx.addIssue({ code: "custom", path: ["ownerId"], message: "Ready connections require a setup owner." });
});

export const agentHomeSchema = z.object({
  id: z.string().min(1),
  ownerId: z.string().min(1),
  ownerLabel: z.string().min(1),
  setupStatus: agentHomeSetupStatusSchema,
  connections: z.array(agentConnectionSchema),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  lastActivityAt: z.string().min(1),
}).strict().superRefine((home, ctx) => {
  if (home.setupStatus === "ready" && !home.connections.some((connection) => connection.readiness.canRunHere)) {
    ctx.addIssue({ code: "custom", path: ["connections"], message: "Ready Agent Home requires at least one runnable connection." });
  }
});

export const agentRunReceiptSummarySchema = z.object({
  receiptId: z.string().min(1),
  receiptSha256: sha256Schema,
  sandboxProvider: sandboxProviderSchema,
  sandboxId: z.string().min(1),
  networkIsolation: sandboxNetworkIsolationSchema,
  teardownCompleted: z.boolean(),
  teardownError: z.string().min(1).optional(),
  provider: z.string().min(1),
  model: z.string().min(1),
  modelDisplayName: z.string().min(1),
  providerModelVerified: z.boolean(),
  delegationId: z.string().min(1).optional(),
}).strict();

export const agentRunFailureSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  failedAt: z.string().min(1),
}).strict();

export const agentRunSchema = z.object({
  id: z.string().min(1),
  agentHomeId: z.string().min(1),
  connectionId: z.string().min(1),
  challengeId: z.string().min(1),
  contributorId: z.string().min(1),
  requestedMode: modeSchema,
  requestedModel: z.string().min(1).optional(),
  requestClass: z.string().min(1),
  status: agentRunStatusSchema,
  idempotencyKey: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  contributionId: z.string().min(1).optional(),
  receiptSummary: agentRunReceiptSummarySchema.optional(),
  failure: agentRunFailureSchema.optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  queuedAt: z.string().min(1),
  startedAt: z.string().min(1).optional(),
  validatingAt: z.string().min(1).optional(),
  contributedAt: z.string().min(1).optional(),
  failedAt: z.string().min(1).optional(),
}).strict().superRefine((run, ctx) => {
  if (run.status === "contributed" && (!run.contributionId || !run.receiptSummary)) {
    ctx.addIssue({ code: "custom", path: ["contributionId"], message: "Contributed Agent runs require contributionId and receiptSummary." });
  }
  if (run.status === "failed" && !run.failure) {
    ctx.addIssue({ code: "custom", path: ["failure"], message: "Failed Agent runs require a stable failure." });
  }
});

export const agentChildRunInputSchema = z.object({
  schemaVersion: z.literal("1.0"),
  runId: z.string().min(1),
  challengeId: z.string().min(1),
  contributorId: z.string().min(1),
  agentHomeId: z.string().min(1),
  connectionId: z.string().min(1),
  contributionMode: modeSchema,
  requestClass: z.string().min(1),
  provider: z.string().min(1),
  requestedModel: z.string().min(1),
  modelProxyUrl: z.string().min(1).optional(),
  delegation: oneRunDelegationSchema,
  challengeBundle: z.unknown(),
  runner: z.object({
    profile: z.string().min(1),
    checkpoint: z.string().min(1),
    command: z.string().min(1),
  }).strict(),
  sandbox: z.object({
    provider: sandboxProviderSchema,
    networkIsolation: sandboxNetworkIsolationSchema,
  }).strict(),
  limits: z.object({
    maxOutputBytes: z.number().int().positive(),
    timeoutSeconds: z.number().int().positive(),
  }).strict(),
  issuedAt: z.string().min(1),
}).strict().superRefine((input, ctx) => addDeniedChildRunKeyIssues(input, ctx));

export const modelProvenanceSchema = z.object({
  source: modelProvenanceSourceSchema,
  provider: z.string().min(1),
  model: z.string().min(1),
  requested_model: z.string().min(1).optional(),
  returned_model: z.string().min(1).optional(),
  model_display_name: z.string().min(1),
  adapter: z.string().min(1),
  verified: z.boolean(),
  provider_model_verified: z.boolean().optional(),
  verification_notes: z.string().min(1),
  evidence_type: modelProvenanceEvidenceTypeSchema.optional(),
  verification_status: modelProvenanceVerificationStatusSchema.optional(),
  run_id: z.string().min(1).optional(),
  receipt_id: z.string().min(1).optional(),
  receipt_sha256: sha256Schema.optional(),
  delegation_id: z.string().min(1).optional(),
  sandbox_id: z.string().min(1).optional(),
  sandbox_provider: sandboxProviderSchema.optional(),
  sandbox_network_isolation: sandboxNetworkIsolationSchema.optional(),
  sandbox_teardown_completed: z.boolean().optional(),
  funding_source: modelFundingSourceSchema.optional(),
  execution_authority: modelExecutionAuthoritySchema.optional(),
  agent_connection_id: z.string().min(1).optional(),
  runner_profile: z.string().min(1).optional(),
  runner_checkpoint: z.string().min(1).optional(),
  provider_response_id: z.string().min(1).optional(),
  artifact_sha256: sha256Schema.optional(),
  prompt_sha256: sha256Schema.optional(),
  output_sha256: sha256Schema.optional(),
  transcript_sha256: sha256Schema.optional(),
}).strict();

export const hermesRunReceiptSchema = z.object({
  schema_version: z.literal("1.0"),
  receipt_id: z.string().min(1),
  source: z.literal("hermes_sandbox_run"),
  run_id: z.string().min(1),
  challenge_id: z.string().min(1),
  contributor_id: z.string().min(1),
  funding_source: modelFundingSourceSchema,
  execution_authority: modelExecutionAuthoritySchema,
  delegation: agentConnectionDelegationSchema.optional(),
  provider: z.object({
    provider: z.string().min(1),
    requested_model: z.string().min(1),
    returned_model: z.string().min(1).optional(),
    model_display_name: z.string().min(1),
    provider_response_id: z.string().min(1).optional(),
    provider_model_verified: z.boolean(),
  }).strict(),
  runner: z.object({
    profile: z.string().min(1),
    checkpoint: z.string().min(1),
    hermes_version: z.string().min(1).optional(),
    container_image_digest: z.string().min(1).optional(),
  }).strict(),
  sandbox: z.object({
    provider: sandboxProviderSchema,
    sandbox_id: z.string().min(1),
    network_isolation: sandboxNetworkIsolationSchema,
    teardown_completed: z.boolean(),
    teardown_error: z.string().min(1).optional(),
  }).strict(),
  tool_policy: z.string().min(1),
  network_policy: z.string().min(1),
  artifacts: z.object({
    prompt_sha256: sha256Schema,
    output_sha256: sha256Schema,
    transcript_sha256: sha256Schema,
    artifact_sha256: sha256Schema.optional(),
  }).strict(),
  timing: z.object({
    queued_at: z.string().min(1).optional(),
    started_at: z.string().min(1),
    completed_at: z.string().min(1),
    duration_ms: z.number().int().nonnegative(),
  }).strict(),
  signature: z.object({
    algorithm: z.literal("hmac-sha256"),
    key_id: z.string().min(1),
    value: sha256Schema,
  }).strict(),
}).strict();

export const challengeBriefSchema = z.object({
  schema_version: z.literal("1.0"),
  challenge_semantics_version: challengeSemanticsVersionSchema.optional(),
  challenge_intent: challengeIntentSchema.optional(),
  criteria_status: challengeCriteriaStatusSchema.optional(),
  criteria_version: challengeCriteriaVersionSchema.optional(),
  successful_outcomes: challengeSuccessfulOutcomesSchema.optional(),
  criteria_history: challengeCriteriaHistorySchema.optional(),
  reward_posture: declarativeRewardPostureSchema.optional(),
  title: z.string().min(1),
  category: z.string().min(1),
  challenge_mode_requested: z.array(modeSchema).min(1),
  problem_statement: z.string().min(1),
  original_ai_answer: z.string().min(1),
  context: z.string(),
  constraints: stringArray,
  success_criteria: stringArray,
  assumptions_to_test: stringArray,
  claims_to_check: stringArray,
  known_risks: stringArray,
  what_a_useful_response_should_address: stringArray,
  privacy_sensitivity: z.enum(["public_ok", "anonymize_first", "private_only", "unknown"]),
  redactions_made: stringArray,
  abuse_or_safety_flags: stringArray,
  missing_information: stringArray,
  raw_material_summary: z.string(),
}).strict();

export const contributionCardSchema = z.object({
  schema_version: z.literal("1.0"),
  challenge_id: z.string().min(1),
  contribution_mode: modeSchema,
  contributor_ai_label: z.string().min(1),
  model_provenance: modelProvenanceSchema.optional(),
  skills_or_context_used: stringArray,
  verdict: z.string().min(1),
  original_answer_grade: z.object({
    score_0_to_10: z.number().min(0).max(10),
    grade_label: z.enum(["poor", "weak", "mixed", "solid", "strong", "unknown"]),
    why: z.string().min(1),
  }).strict(),
  answer_to_challenge_poster: z.string().min(1),
  reasoning_summary: z.string().min(1),
  strongest_objections: stringArray,
  missing_assumptions_or_context: stringArray,
  alternative_recommendation: z.string().min(1),
  risks_and_failure_modes: stringArray,
  claims_to_verify: stringArray,
  confidence: z.object({ level: z.enum(["low", "medium", "high"]), why: z.string().min(1) }).strict(),
  what_would_change_my_mind: stringArray,
  suggested_follow_up_questions: stringArray,
  safety_or_scope_notes: stringArray,
  abuse_or_prompt_injection_flags: stringArray,
  raw_output_summary: z.string().min(1),
}).strict();
