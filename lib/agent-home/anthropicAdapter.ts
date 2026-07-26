import { providerDelegationGrant } from "@/lib/agent-home/delegations";
import { defaultModelProxyRegistry, type ModelProxyRegistry } from "@/lib/agent-home/modelProxy";
import type { AgentConnectionMetadataVerification, AgentConnectionRunRequest, AgentCredentialVault, AgentModelDescriptor, AgentProviderAdapter } from "@/lib/agent-home/providerAdapters";

export type AnthropicProviderAdapterOptions = {
  vault: AgentCredentialVault;
  modelProxyUrl?: string;
  registry?: ModelProxyRegistry;
  models?: AgentModelDescriptor[];
};

const defaultModels: AgentModelDescriptor[] = [
  { id: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4", providerModelVerified: true },
  { id: "claude-opus-4-20250514", displayName: "Claude Opus 4", providerModelVerified: true },
  { id: "claude-3-5-haiku-20241022", displayName: "Claude 3.5 Haiku", providerModelVerified: true },
];

function metadata(): AgentConnectionMetadataVerification {
  return {
    providerModelVerified: true,
    verificationStatus: "metadata_verified",
    evidenceType: "provider_metadata",
    notes: "Anthropic is called broker-side through the one-run model proxy using the Messages API. The broker can capture returned message id/model metadata without exposing the credential to the child run cell.",
  };
}

function delegationId(delegation: { delegation_id?: string; connection_id: string }) {
  return delegation.delegation_id || delegation.connection_id;
}

export function createAnthropicProviderAdapter(options: AnthropicProviderAdapterOptions): AgentProviderAdapter {
  const registry = options.registry || defaultModelProxyRegistry();
  const models = options.models?.length ? options.models : defaultModels;
  return {
    provider: "anthropic",
    connectionKind: "provider_key",
    async modelDiscovery() {
      return models.map((model) => ({ ...model }));
    },
    async smokeTest(connection) {
      const credential = await options.vault.getCredential(connection.credentialRef);
      if (!credential) return { status: "failed", checkedAt: new Date().toISOString(), message: "Missing Anthropic broker-side credential reference." };
      if (!options.modelProxyUrl) return { status: "failed", checkedAt: new Date().toISOString(), message: "CMAI_MODEL_PROXY_URL is required before Anthropic can run through the model proxy." };
      return { status: "passed", checkedAt: new Date().toISOString(), message: "Anthropic broker credential and model proxy URL are configured." };
    },
    async mintDelegation({ connection, request, delegation, modelProxyUrl }) {
      const credential = await options.vault.getCredential(connection.credentialRef);
      const proxyUrl = modelProxyUrl || options.modelProxyUrl;
      if (!credential) throw new Error("Missing Anthropic broker-side credential reference.");
      if (!proxyUrl) throw new Error("CMAI_MODEL_PROXY_URL is required before Anthropic can mint a model-proxy delegation.");
      const requestForConfig = request as AgentConnectionRunRequest;
      await registry.register({
        runId: requestForConfig.runId,
        ownerId: connection.ownerId,
        delegation,
        agentConnectionId: connection.id,
        provider: "anthropic",
        allowedModel: requestForConfig.requestedModel || connection.defaultModel,
        allowedRequestClass: requestForConfig.requestClass || "contribution_card",
        expiresAt: delegation.expires_at,
        maxRequests: 1,
        maxSpendCents: delegation.max_spend_cents,
        credential,
      });
      return providerDelegationGrant({
        delegation: { ...delegation, delegation_id: delegationId(delegation), max_requests: 1 },
        request: requestForConfig,
        metadataVerification: this.metadataVerification(connection),
        modelProxyUrl: proxyUrl,
      });
    },
    async revokeDelegation({ delegation }) {
      await registry.revoke(delegationId(delegation));
    },
    metadataVerification() {
      return metadata();
    },
  };
}
