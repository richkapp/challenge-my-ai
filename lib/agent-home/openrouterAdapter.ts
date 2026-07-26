import { providerDelegationGrant } from "@/lib/agent-home/delegations";
import { defaultModelProxyRegistry, type ModelProxyRegistry } from "@/lib/agent-home/modelProxy";
import type { AgentConnection, AgentConnectionMetadataVerification, AgentConnectionRunRequest, AgentCredentialVault, AgentModelDescriptor, AgentProviderAdapter } from "@/lib/agent-home/providerAdapters";

export type OpenRouterProviderAdapterOptions = {
  vault: AgentCredentialVault;
  modelProxyUrl?: string;
  registry?: ModelProxyRegistry;
  models?: AgentModelDescriptor[];
};

const defaultModels: AgentModelDescriptor[] = [
  { id: "openai/gpt-4.1-mini", displayName: "OpenAI GPT-4.1 Mini via OpenRouter", providerModelVerified: true },
];

function metadata(): AgentConnectionMetadataVerification {
  return {
    providerModelVerified: true,
    verificationStatus: "metadata_verified",
    evidenceType: "provider_metadata",
    notes: "OpenRouter is called broker-side through the one-run model proxy, which can capture returned model and provider response id metadata without exposing provider access to the child run cell.",
  };
}

function delegationId(delegation: { delegation_id?: string; connection_id: string }) {
  return delegation.delegation_id || delegation.connection_id;
}

export function createOpenRouterProviderAdapter(options: OpenRouterProviderAdapterOptions): AgentProviderAdapter {
  const registry = options.registry || defaultModelProxyRegistry();
  const models = options.models?.length ? options.models : defaultModels;
  return {
    provider: "openrouter",
    connectionKind: "provider_key",
    async modelDiscovery() {
      return models.map((model) => ({ ...model }));
    },
    async smokeTest(connection) {
      const credential = await options.vault.getCredential(connection.credentialRef);
      if (!credential) return { status: "failed", checkedAt: new Date().toISOString(), message: "Missing OpenRouter broker-side credential reference." };
      if (!options.modelProxyUrl) return { status: "failed", checkedAt: new Date().toISOString(), message: "CMAI_MODEL_PROXY_URL is required before OpenRouter can run through the model proxy." };
      return { status: "passed", checkedAt: new Date().toISOString(), message: "OpenRouter broker credential and model proxy URL are configured." };
    },
    async mintDelegation({ connection, request, delegation, modelProxyUrl }) {
      const credential = await options.vault.getCredential(connection.credentialRef);
      const proxyUrl = modelProxyUrl || options.modelProxyUrl;
      if (!credential) throw new Error("Missing OpenRouter broker-side credential reference.");
      if (!proxyUrl) throw new Error("CMAI_MODEL_PROXY_URL is required before OpenRouter can mint a model-proxy delegation.");
      const requestForConfig = request as AgentConnectionRunRequest;
      await registry.register({
        runId: requestForConfig.runId,
        ownerId: connection.ownerId,
        delegation,
        agentConnectionId: connection.id,
        provider: "openrouter",
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
