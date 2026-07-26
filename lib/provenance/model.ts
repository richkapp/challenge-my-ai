import type { ModelProvenance } from "@/lib/types";

const exactModelVerifiedSources = new Set<ModelProvenance["source"]>(["provider_api_verified", "platform_run", "provider_signed"]);
const sandboxReceiptAuthorities = new Set(["cmai_broker", "cmai_sandbox"]);

export function isVerifiedModelProvenance(provenance?: ModelProvenance): boolean {
  return Boolean(provenance?.verified && exactModelVerifiedSources.has(provenance.source));
}

export function isSandboxRunProvenance(provenance?: ModelProvenance): boolean {
  return provenance?.source === "hermes_sandbox_run";
}

export function isVerifiedSandboxReceiptProof(provenance?: ModelProvenance, options: { receiptVerified?: boolean } = {}): boolean {
  return Boolean(isSandboxRunProvenance(provenance) && options.receiptVerified === true && sandboxReceiptAuthorities.has(provenance?.execution_authority || ""));
}

export function modelProvenanceTrustLabel(provenance?: ModelProvenance): string {
  if (!provenance) return "model unknown";
  if (isVerifiedModelProvenance(provenance)) {
    if (provenance.source === "platform_run") return "verified challenge run";
    if (provenance.source === "provider_signed") return "provider-signed model";
    return "API-verified model";
  }
  if (provenance.source === "hermes_sandbox_run") {
    return provenance.provider_model_verified
      ? "sandboxed Hermes run + provider metadata"
      : "sandboxed Hermes run";
  }
  if (provenance.source === "client_attested") return "connector-attested model";
  return "self-attested model";
}

export function modelDisplayName(provenance?: ModelProvenance, fallback = "unknown model"): string {
  if (!provenance) return fallback;
  return provenance.model_display_name || provenance.returned_model || provenance.model || fallback;
}

export function modelProvenanceSummary(provenance?: ModelProvenance): string {
  if (!provenance) return "Model provenance was not supplied.";
  const model = modelDisplayName(provenance);
  const provider = provenance.provider === "unknown" ? "unknown provider" : provenance.provider;
  const trustLabel = modelProvenanceTrustLabel(provenance);
  const sandboxNote = sandboxProofLimitNote(provenance);
  const teardownNote = provenance.source === "hermes_sandbox_run" && provenance.sandbox_teardown_completed !== undefined
    ? ` Teardown: ${provenance.sandbox_teardown_completed ? "completed" : "not completed / operator follow-up required"}.`
    : "";
  return `${model} via ${provider} (${trustLabel}). ${provenance.verification_notes}${sandboxNote}${teardownNote}`;
}

export function sandboxProofLimitNote(provenance?: ModelProvenance): string {
  if (!provenance || provenance.source !== "hermes_sandbox_run") return "";
  if (provenance.provider_model_verified) {
    return " Provider-returned metadata was attached to the Challenge My AI-signed run receipt; this is not a provider-signed receipt.";
  }
  return " The run receipt verifies the controlled execution path, not exact provider model identity.";
}
