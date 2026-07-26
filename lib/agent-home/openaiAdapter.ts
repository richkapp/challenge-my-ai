import { providerDelegationGrant } from "@/lib/agent-home/delegations";
import { defaultModelProxyRegistry, type ModelProxyRegistry } from "@/lib/agent-home/modelProxy";
import type { AgentConnectionMetadataVerification, AgentConnectionRunRequest, AgentCredentialVault, AgentModelDescriptor, AgentProviderAdapter } from "@/lib/agent-home/providerAdapters";

export type OpenAIProviderAdapterOptions = {
  vault: AgentCredentialVault;
  modelProxyUrl?: string;
  registry?: ModelProxyRegistry;
  models?: AgentModelDescriptor[];
};

const defaultModels: AgentModelDescriptor[] = [
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", providerModelVerified: true },
  { id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini", providerModelVerified: true },
  { id: "gpt-4.1-mini", displayName: "GPT-4.1 Mini", providerModelVerified: true },
];

function metadata(): AgentConnectionMetadataVerification {
  return {
    providerModelVerified: true,
    verificationStatus: "metadata_verified",
    evidenceType: "provider_metadata",
    notes: "OpenAI is called broker-side through the one-run model proxy using the Responses API. The broker can capture returned response id/model metadata without exposing OpenAI access to the child run cell.",
  };
}

function delegationId(delegation: { delegation_id?: string; connection_id: string }) {
  return delegation.delegation_id || delegation.connection_id;
}

export function createOpenAIProviderAdapter(options: OpenAIProviderAdapterOptions): AgentProviderAdapter {
  const registry = options.registry || defaultModelProxyRegistry();
  const models = options.models?.length ? options.models : defaultModels;
  return {
    provider: "openai",
    connectionKind: "provider_key",
    async modelDiscovery() {
      return models.map((model) => ({ ...model }));
    },
    async smokeTest(connection) {
      const credential = await options.vault.getCredential(connection.credentialRef);
      if (!credential) return { status: "failed", checkedAt: new Date().toISOString(), message: "Missing OpenAI broker-side credential reference." };
      if (!options.modelProxyUrl) return { status: "failed", checkedAt: new Date().toISOString(), message: "CMAI_MODEL_PROXY_URL is required before OpenAI can run through the model proxy." };
      return { status: "passed", checkedAt: new Date().toISOString(), message: "OpenAI broker credential and model proxy URL are configured." };
    },
    async mintDelegation({ connection, request, delegation, modelProxyUrl }) {
      const credential = await options.vault.getCredential(connection.credentialRef);
      const proxyUrl = modelProxyUrl || options.modelProxyUrl;
      if (!credential) throw new Error("Missing OpenAI broker-side credential reference.");
      if (!proxyUrl) throw new Error("CMAI_MODEL_PROXY_URL is required before OpenAI can mint a model-proxy delegation.");
      const requestForConfig = request as AgentConnectionRunRequest;
      await registry.register({
        runId: requestForConfig.runId,
        ownerId: connection.ownerId,
        delegation,
        agentConnectionId: connection.id,
        provider: "openai",
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
