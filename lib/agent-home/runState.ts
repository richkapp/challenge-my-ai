import { hashHermesRunReceipt } from "@/lib/provenance/receipts";
import type { AgentRun, AgentRunReceiptSummary, HermesRunReceipt } from "@/lib/types";

export const agentRunManualPasteFallback = "Manual paste remains available: copy the visible challenge prompt into your own Agent and paste back a CMAI_CONTRIBUTION_CARD_V1 card.";

export function trustLabelForReceipt(receipt: HermesRunReceipt): string {
  return receipt.provider.provider_model_verified
    ? "sandboxed Hermes run + provider metadata"
    : "sandboxed Hermes run";
}

export function receiptSummaryFromReceipt(receipt: HermesRunReceipt): AgentRunReceiptSummary {
  return {
    receiptId: receipt.receipt_id,
    receiptSha256: hashHermesRunReceipt(receipt),
    sandboxProvider: receipt.sandbox.provider,
    sandboxId: receipt.sandbox.sandbox_id,
    networkIsolation: receipt.sandbox.network_isolation,
    teardownCompleted: receipt.sandbox.teardown_completed,
    teardownError: receipt.sandbox.teardown_error,
    provider: receipt.provider.provider,
    requestedModel: receipt.provider.requested_model,
    model: receipt.provider.returned_model || receipt.provider.requested_model,
    modelDisplayName: receipt.provider.model_display_name,
    providerResponseId: receipt.provider.provider_response_id,
    providerModelVerified: receipt.provider.provider_model_verified,
    delegationId: receipt.delegation?.delegation_id,
  };
}

export function publicAgentRun(run: AgentRun) {
  const trustLabel = run.receiptSummary?.providerModelVerified
    ? "sandboxed Hermes run + provider metadata"
    : run.receiptSummary
      ? "sandboxed Hermes run"
      : undefined;

  return {
    id: run.id,
    jobId: run.jobId,
    challengeId: run.challengeId,
    contributorId: run.contributorId,
    connectionId: run.connectionId,
    contributionMode: run.requestedMode,
    requestedModel: run.requestedModel,
    status: run.status,
    contributionId: run.contributionId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    queuedAt: run.queuedAt,
    startedAt: run.startedAt,
    validatingAt: run.validatingAt,
    contributedAt: run.contributedAt,
    failedAt: run.failedAt,
    sandboxProvider: run.receiptSummary?.sandboxProvider,
    trustLabel,
    receiptSummary: run.receiptSummary
      ? {
        receiptId: run.receiptSummary.receiptId,
        receiptSha256: run.receiptSummary.receiptSha256,
        sandboxProvider: run.receiptSummary.sandboxProvider,
        sandboxId: run.receiptSummary.sandboxId,
        networkIsolation: run.receiptSummary.networkIsolation,
        teardownCompleted: run.receiptSummary.teardownCompleted,
        teardownError: run.receiptSummary.teardownError,
        provider: run.receiptSummary.provider,
        requestedModel: run.receiptSummary.requestedModel,
        model: run.receiptSummary.model,
        modelDisplayName: run.receiptSummary.modelDisplayName,
        providerResponseId: run.receiptSummary.providerResponseId,
        providerModelVerified: run.receiptSummary.providerModelVerified,
        delegationId: run.receiptSummary.delegationId,
      }
      : undefined,
    failure: run.failure ? { code: run.failure.code, message: run.failure.message, failedAt: run.failure.failedAt } : undefined,
    manualPasteFallback: agentRunManualPasteFallback,
  };
}
