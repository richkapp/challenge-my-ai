import type { AgentConnection, AgentConnectionKind, AgentConnectionMetadataVerification, AgentConnectionRunRequest, AgentCredentialRecord, AgentCredentialVault, AgentModelDescriptor, AgentProviderAdapter } from "@/lib/agent-home/providerAdapters";
import { providerDelegationGrant } from "@/lib/agent-home/delegations";

export class InMemoryAgentCredentialVault implements AgentCredentialVault {
  private readonly records = new Map<string, AgentCredentialRecord>();

  async putCredential(record: AgentCredentialRecord): Promise<void> {
    this.records.set(record.ref, { ...record });
  }

  async getCredential(ref: string): Promise<AgentCredentialRecord | undefined> {
    const record = this.records.get(ref);
    if (!record) return undefined;
    if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) return undefined;
    return { ...record };
  }

  async deleteCredential(ref: string): Promise<void> {
    this.records.delete(ref);
  }
}

export type FakeProviderAdapterOptions = {
  provider?: string;
  connectionKind?: AgentConnectionKind;
  vault?: AgentCredentialVault;
  providerModelVerified?: boolean;
  modelProxyUrl?: string;
  models?: AgentModelDescriptor[];
};

const defaultModel = "fake-frontier-model";
const defaultModelProxyUrl = "https://broker.example.test/model-proxy";

export function fakeMetadataVerification(providerModelVerified = false): AgentConnectionMetadataVerification {
  return {
    providerModelVerified,
    verificationStatus: providerModelVerified ? "metadata_verified" : "sandbox_recorded",
    evidenceType: providerModelVerified ? "provider_metadata" : "hermes_run_receipt",
    notes: providerModelVerified
      ? "The fake adapter simulates provider-returned model metadata for exact-model verification tests."
      : "The fake adapter can prove sandbox execution, but not exact model identity.",
  };
}

export function createFakeAgentConnection(overrides: Partial<AgentConnection> = {}): AgentConnection {
  const now = "2026-06-28T00:00:00.000Z";
  return {
    id: "conn_fake_1",
    ownerId: "user_1",
    agentHomeId: "home_1",
    provider: "fake-provider",
    connectionKind: "test_fake",
    displayLabel: "Fake connected Agent",
    status: "ready",
    credentialRef: "cred_fake_1",
    defaultModel,
    allowedModels: [defaultModel, "fake-judge-model"],
    allowedRequestClasses: ["contribution_card", "critique", "red_team", "alternate_proposal", "steelman", "risk_audit", "judge"],
    metadataVerification: fakeMetadataVerification(false),
    lastSmoke: { status: "passed", checkedAt: now, message: "fake smoke passed" },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function createFakeProviderAdapter(options: FakeProviderAdapterOptions = {}): AgentProviderAdapter {
  const provider = options.provider || "fake-provider";
  const vault = options.vault || new InMemoryAgentCredentialVault();
  const providerModelVerified = options.providerModelVerified || false;
  const metadata = fakeMetadataVerification(providerModelVerified);
  const models = options.models || [{ id: defaultModel, displayName: "Fake Frontier Model", providerModelVerified }];

  return {
    provider,
    connectionKind: options.connectionKind || "test_fake",
    async modelDiscovery() {
      return models.map((model) => ({ ...model }));
    },
    async smokeTest(connection) {
      const credential = await vault.getCredential(connection.credentialRef);
      if (!credential) return { status: "failed", checkedAt: new Date().toISOString(), message: "Missing broker-side credential reference." };
      return { status: "passed", checkedAt: new Date().toISOString(), message: "Fake provider smoke test passed." };
    },
    async mintDelegation({ connection, request, delegation, modelProxyUrl }) {
      const credential = await vault.getCredential(connection.credentialRef);
      if (!credential) throw new Error("Missing broker-side credential reference.");
      return providerDelegationGrant({
        delegation,
        request: request as AgentConnectionRunRequest,
        metadataVerification: this.metadataVerification(connection),
        modelProxyUrl: modelProxyUrl || options.modelProxyUrl || defaultModelProxyUrl,
      });
    },
    async revokeDelegation() {
      return undefined;
    },
    metadataVerification() {
      return metadata;
    },
  };
}
