import { z } from "zod";
import { agentProtocolContributionModes } from "@/lib/agent-protocol/constants";

const modelProvenanceSourcesV1 = ["self_attested", "client_attested", "provider_api_verified", "hermes_sandbox_run", "platform_run", "provider_signed"] as const;
const modelFundingSourcesV1 = ["self_attested", "user_funded", "platform_funded", "unknown", "user_provider_access", "external_user_subscription", "cmai_platform_later"] as const;
const modelExecutionAuthoritiesV1 = ["contributor_claim", "cmai_broker", "provider", "user_external", "user_connector", "cmai_sandbox", "cmai_platform"] as const;
const modelProvenanceEvidenceTypesV1 = ["user_claim", "client_manifest", "hermes_run_receipt", "provider_metadata", "platform_run_record", "provider_signature"] as const;
const modelProvenanceVerificationStatusesV1 = ["unverified", "attested", "sandbox_recorded", "metadata_verified", "platform_verified", "cryptographically_verified", "disputed", "revoked"] as const;
const sandboxProvidersV1 = ["local_fake", "railway", "other"] as const;
const sandboxNetworkIsolationsV1 = ["ISOLATED", "PRIVATE"] as const;

const contributionModeV1Schema = z.enum(agentProtocolContributionModes);
const stringArrayV1Schema = z.array(z.string());
const sha256V1Schema = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * This definition intentionally owns the frozen V1 wire shape instead of
 * aliasing the mutable application schema. Changing it requires a protocol
 * version decision and mixed-version fixtures.
 */
export const contributionCardModelProvenanceV1Schema = z.object({
  source: z.enum(modelProvenanceSourcesV1),
  provider: z.string().min(1),
  model: z.string().min(1),
  requested_model: z.string().min(1).optional(),
  returned_model: z.string().min(1).optional(),
  model_display_name: z.string().min(1),
  adapter: z.string().min(1),
  verified: z.boolean(),
  provider_model_verified: z.boolean().optional(),
  verification_notes: z.string().min(1),
  evidence_type: z.enum(modelProvenanceEvidenceTypesV1).optional(),
  verification_status: z.enum(modelProvenanceVerificationStatusesV1).optional(),
  run_id: z.string().min(1).optional(),
  receipt_id: z.string().min(1).optional(),
  receipt_sha256: sha256V1Schema.optional(),
  delegation_id: z.string().min(1).optional(),
  sandbox_id: z.string().min(1).optional(),
  sandbox_provider: z.enum(sandboxProvidersV1).optional(),
  sandbox_network_isolation: z.enum(sandboxNetworkIsolationsV1).optional(),
  sandbox_teardown_completed: z.boolean().optional(),
  funding_source: z.enum(modelFundingSourcesV1).optional(),
  execution_authority: z.enum(modelExecutionAuthoritiesV1).optional(),
  agent_connection_id: z.string().min(1).optional(),
  runner_profile: z.string().min(1).optional(),
  runner_checkpoint: z.string().min(1).optional(),
  provider_response_id: z.string().min(1).optional(),
  artifact_sha256: sha256V1Schema.optional(),
  prompt_sha256: sha256V1Schema.optional(),
  output_sha256: sha256V1Schema.optional(),
  transcript_sha256: sha256V1Schema.optional(),
}).strict();

export const contributionCardV1Schema = z.object({
  schema_version: z.literal("1.0"),
  challenge_id: z.string().min(1),
  contribution_mode: contributionModeV1Schema,
  contributor_ai_label: z.string().min(1),
  model_provenance: contributionCardModelProvenanceV1Schema.optional(),
  skills_or_context_used: stringArrayV1Schema,
  verdict: z.string().min(1),
  original_answer_grade: z.object({
    score_0_to_10: z.number().min(0).max(10),
    grade_label: z.enum(["poor", "weak", "mixed", "solid", "strong", "unknown"]),
    why: z.string().min(1),
  }).strict(),
  answer_to_challenge_poster: z.string().min(1),
  reasoning_summary: z.string().min(1),
  strongest_objections: stringArrayV1Schema,
  missing_assumptions_or_context: stringArrayV1Schema,
  alternative_recommendation: z.string().min(1),
  risks_and_failure_modes: stringArrayV1Schema,
  claims_to_verify: stringArrayV1Schema,
  confidence: z.object({
    level: z.enum(["low", "medium", "high"]),
    why: z.string().min(1),
  }).strict(),
  what_would_change_my_mind: stringArrayV1Schema,
  suggested_follow_up_questions: stringArrayV1Schema,
  safety_or_scope_notes: stringArrayV1Schema,
  abuse_or_prompt_injection_flags: stringArrayV1Schema,
  raw_output_summary: z.string().min(1),
}).strict();

export const pairedLocalContributionCardV1Schema = contributionCardV1Schema.extend({
  model_provenance: z.object({
    source: z.literal("client_attested"),
    provider: z.string().min(1),
    model: z.string().min(1),
    model_display_name: z.string().min(1),
    adapter: z.string().min(1),
    verified: z.literal(false),
    provider_model_verified: z.literal(false),
    verification_notes: z.string().min(1),
    evidence_type: z.literal("client_manifest"),
    verification_status: z.literal("attested"),
    funding_source: z.literal("unknown").optional(),
    execution_authority: z.literal("user_connector"),
  }).strict().optional(),
}).strict();

export type ContributionCardV1 = z.infer<typeof contributionCardV1Schema>;
export type PairedLocalContributionCardV1 = z.infer<typeof pairedLocalContributionCardV1Schema>;

export function parseContributionCardV1(value: unknown): ContributionCardV1 {
  return contributionCardV1Schema.parse(value);
}
