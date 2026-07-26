import type { ContributionCard, ModelFundingSource, ModelProvenance, ModelProvenanceEvidenceType, ModelProvenanceVerificationStatus } from "@/lib/types";

const privilegedSources = new Set<ModelProvenance["source"]>([
  "hermes_sandbox_run",
  "platform_run",
  "provider_api_verified",
  "provider_signed",
]);

const privilegedProofFields: Array<keyof ModelProvenance> = [
  "run_id",
  "receipt_id",
  "receipt_sha256",
  "delegation_id",
  "sandbox_id",
  "sandbox_provider",
  "sandbox_network_isolation",
  "sandbox_teardown_completed",
  "execution_authority",
  "agent_connection_id",
  "runner_profile",
  "runner_checkpoint",
  "provider_response_id",
  "artifact_sha256",
  "prompt_sha256",
  "output_sha256",
  "transcript_sha256",
];

const privilegedEvidenceTypes = new Set<ModelProvenanceEvidenceType>([
  "hermes_run_receipt",
  "provider_metadata",
  "platform_run_record",
  "provider_signature",
]);

const privilegedVerificationStatuses = new Set<ModelProvenanceVerificationStatus>([
  "sandbox_recorded",
  "metadata_verified",
  "platform_verified",
  "cryptographically_verified",
]);

const platformFundingClaims = new Set<ModelFundingSource>([
  "platform_funded",
  "cmai_platform_later",
]);

export function isPrivilegedModelProvenance(provenance?: ModelProvenance): boolean {
  return Boolean(provenance && privilegedSources.has(provenance.source));
}

export function sanitizeExternalModelProvenance(provenance: ModelProvenance, sourceLabel = "external submission"): ModelProvenance {
  const sanitized: ModelProvenance = {
    ...provenance,
    source: privilegedSources.has(provenance.source) ? "self_attested" : provenance.source,
    verified: false,
    provider_model_verified: false,
    evidence_type: provenance.evidence_type && !privilegedEvidenceTypes.has(provenance.evidence_type)
      ? provenance.evidence_type
      : "user_claim",
    verification_status: provenance.verification_status && !privilegedVerificationStatuses.has(provenance.verification_status)
      ? provenance.verification_status
      : "attested",
    funding_source: provenance.funding_source && !platformFundingClaims.has(provenance.funding_source)
      ? provenance.funding_source
      : "unknown",
    verification_notes: `${sourceLabel} supplied model provenance, but Challenge My AI did not verify a server-side receipt/provider signature on this path. Stored as unverified user-attested metadata.`,
  };

  for (const field of privilegedProofFields) {
    delete sanitized[field];
  }

  return sanitized;
}

export function sanitizeExternalContributionCard(card: ContributionCard, sourceLabel = "external submission"): ContributionCard {
  if (!card.model_provenance) return card;
  return {
    ...card,
    model_provenance: sanitizeExternalModelProvenance(card.model_provenance, sourceLabel),
  };
}

export function manualContributionTrustLabel(): string {
  return "self-submitted / user-trusted";
}

export function manualContributionProvenanceSummary(card: ContributionCard): string {
  if (!card.model_provenance) {
    return "No model provenance was supplied. Challenge My AI stores this manual paste as self-submitted / user-trusted and does not verify model identity.";
  }

  return `${card.model_provenance.model_display_name || card.model_provenance.model} via ${card.model_provenance.provider}: ${card.model_provenance.verification_notes}`;
}

export function sanitizeManualModelProvenance(provenance: ModelProvenance): ModelProvenance {
  return sanitizeExternalModelProvenance(provenance, "manual paste");
}

export function sanitizeManualContributionCard(card: ContributionCard): ContributionCard {
  return sanitizeExternalContributionCard(card, "manual paste");
}
