import { providerDelegationGrant } from "@/lib/agent-home/delegations";
import type { AgentConnection, AgentConnectionMetadataVerification, AgentProviderAdapter } from "@/lib/agent-home/providerAdapters";
import type { ProviderCatalogEntry } from "@/lib/agent-home/providerCatalog";

export class ProviderAdapterUnavailableError extends Error {
  readonly code = "AGENT_PROVIDER_ADAPTER_UNAVAILABLE";

  constructor(provider: string) {
    super(`${provider} provider setup is recognized, but its broker-side model proxy adapter is not enabled yet.`);
  }
}

function unavailableMetadata(entry: ProviderCatalogEntry): AgentConnectionMetadataVerification {
  return {
    providerModelVerified: false,
    verificationStatus: entry.metadataVerification,
    evidenceType: "hermes_run_receipt",
    notes: entry.sandboxTrustLabel,
  };
}

export function createUnavailableProviderAdapter(entry: ProviderCatalogEntry): AgentProviderAdapter {
  return {
    provider: entry.id,
    connectionKind: entry.connectionKind === "fake_dev" ? "test_fake" : entry.connectionKind,
    async modelDiscovery() {
      return entry.allowedModels.map((model) => ({ id: model, displayName: model, providerModelVerified: false }));
    },
    async smokeTest() {
      return {
        status: "failed",
        checkedAt: new Date().toISOString(),
        message: `${entry.complianceCopy} ${entry.manualPasteFallbackCopy}`,
      };
    },
    async mintDelegation({ request, delegation }) {
      void providerDelegationGrant({
        delegation,
        request,
        metadataVerification: unavailableMetadata(entry),
      });
      throw new ProviderAdapterUnavailableError(entry.label);
    },
    async revokeDelegation() {
      return undefined;
    },
    metadataVerification(_connection: AgentConnection) {
      return unavailableMetadata(entry);
    },
  };
}
