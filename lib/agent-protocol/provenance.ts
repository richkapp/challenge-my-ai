import type { PairedAdapterAuditMetadata, PairedAdapterRunAuditMetadata } from "@/lib/agent-protocol/schemas";
import type { ContributionCardV1 } from "@/lib/validation/contributionCardProtocol";

export function normalizePairedAdapterContribution(
  card: ContributionCardV1,
  audit: PairedAdapterAuditMetadata | PairedAdapterRunAuditMetadata,
): ContributionCardV1 {
  const submitted = card.model_provenance;
  const provider = audit.provider_claim || submitted?.provider || "unknown";
  const model = audit.model_claim || submitted?.model || "unknown";
  const modelDisplayName = audit.model_display_name_claim || submitted?.model_display_name || model;

  return {
    ...card,
    model_provenance: {
      source: "client_attested",
      provider,
      model,
      model_display_name: modelDisplayName,
      adapter: `${audit.runtime}:${audit.adapter_name}@${audit.adapter_version}`,
      verified: false,
      provider_model_verified: false,
      verification_notes: `A paired ${audit.runtime} adapter ${"user_approved_submit" in audit ? "submitted" : "produced"} this schema-valid card after a host-owned local Agent call. Challenge My AI did not remotely attest the host or verify provider/model identity.`,
      evidence_type: "client_manifest",
      verification_status: "attested",
      funding_source: "unknown",
      execution_authority: "user_connector",
    },
  };
}
