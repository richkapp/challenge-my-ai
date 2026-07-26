import { childRunDelegationConfig } from "@/lib/agent-home/connections";
import { defaultModelProxyRegistry, isCodexCliAvailable, type ModelProxyRegistry } from "@/lib/agent-home/modelProxy";
import { parseCodexAuthCache } from "@/lib/agent-home/codexSession";
import type { AgentConnectionMetadataVerification, AgentConnectionRunRequest, AgentCredentialVault, AgentModelDescriptor, AgentProviderAdapter } from "@/lib/agent-home/providerAdapters";

export type CodexProviderAdapterOptions = {
  vault: AgentCredentialVault;
  modelProxyUrl?: string;
  registry?: ModelProxyRegistry;
  models?: AgentModelDescriptor[];
  cliAvailable?: () => Promise<boolean>;
};

const defaultModels: AgentModelDescriptor[] = [
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol via ChatGPT plan", providerModelVerified: false },
  { id: "gpt-5.4-mini", displayName: "GPT-5.4 Mini via ChatGPT plan", providerModelVerified: false },
];

function metadata(): AgentConnectionMetadataVerification {
  return {
    providerModelVerified: false,
    verificationStatus: "sandbox_recorded",
    evidenceType: "hermes_run_receipt",
    notes: "Codex is invoked broker-side through Codex-managed ChatGPT plan auth. The Challenge My AI receipt proves the run lifecycle and funding path; exact model identity remains sandbox-recorded until Codex exposes receipt-bound provider metadata.",
  };
}

function delegationId(delegation: { delegation_id?: string; connection_id: string }) {
  return delegation.delegation_id || delegation.connection_id;
}

export function createCodexProviderAdapter(options: CodexProviderAdapterOptions): AgentProviderAdapter {
  const registry = options.registry || defaultModelProxyRegistry();
  const models = options.models?.length ? options.models : defaultModels;
  const cliAvailable = options.cliAvailable || isCodexCliAvailable;
  return {
    provider: "codex",
    connectionKind: "device_code",
    async modelDiscovery() {
      return models.map((model) => ({ ...model }));
    },
    async smokeTest(connection) {
      const credential = await options.vault.getCredential(connection.credentialRef);
      if (!credential) return { status: "failed", checkedAt: new Date().toISOString(), message: "Missing Codex ChatGPT authentication reference." };
      try {
        parseCodexAuthCache(credential.value);
      } catch {
        return { status: "failed", checkedAt: new Date().toISOString(), message: "Stored Codex authentication is invalid. Reconnect Codex/ChatGPT plan access." };
      }
      if (!options.modelProxyUrl) return { status: "failed", checkedAt: new Date().toISOString(), message: "CMAI_MODEL_PROXY_URL is required before Codex can run through the one-run broker path." };
      if (!await cliAvailable()) return { status: "failed", checkedAt: new Date().toISOString(), message: "Codex CLI is not installed or not executable on the broker host; install Codex CLI before enabling ChatGPT plan runs." };
      return { status: "passed", checkedAt: new Date().toISOString(), message: "Codex-managed ChatGPT auth, broker URL, and Codex CLI are available for one-run execution with automatic refresh persistence." };
    },
    async mintDelegation({ connection, request, delegation, modelProxyUrl }) {
      const credential = await options.vault.getCredential(connection.credentialRef);
      const proxyUrl = modelProxyUrl || options.modelProxyUrl;
      if (!credential) throw new Error("Missing Codex ChatGPT authentication reference.");
      parseCodexAuthCache(credential.value);
      if (!proxyUrl) throw new Error("CMAI_MODEL_PROXY_URL is required before Codex can mint a one-run session delegation.");
      const requestForConfig = request as AgentConnectionRunRequest;
      await registry.register({
        runId: requestForConfig.runId,
        ownerId: connection.ownerId,
        delegation,
        agentConnectionId: connection.id,
        provider: "codex",
        allowedModel: requestForConfig.requestedModel || connection.defaultModel,
        allowedRequestClass: requestForConfig.requestClass || "contribution_card",
        expiresAt: delegation.expires_at,
        maxRequests: 1,
        maxSpendCents: delegation.max_spend_cents,
        credential,
      });
      return {
        delegation: { ...delegation, delegation_id: delegationId(delegation), max_requests: 1 },
        childRunConfig: {
          ...childRunDelegationConfig({ runId: requestForConfig.runId, delegation: { ...delegation, delegation_id: delegationId(delegation), max_requests: 1 }, modelProxyUrl: proxyUrl }),
          execution_mode: "codex_session",
        },
        metadataVerification: this.metadataVerification(connection),
      };
    },
    async revokeDelegation({ delegation }) {
      await registry.revoke(delegationId(delegation));
    },
    metadataVerification() {
      return metadata();
    },
  };
}
