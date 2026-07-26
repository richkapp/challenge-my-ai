import { childRunDelegationConfig } from "@/lib/agent-home/connections";
import { defaultModelProxyRegistry, type ModelProxyRegistry } from "@/lib/agent-home/modelProxy";
import { isClaudeCodeCliAvailable } from "@/lib/agent-home/claudeCodeCli";
import { parseClaudeCodeCredential } from "@/lib/agent-home/claudeCodeSession";
import type { AgentConnectionMetadataVerification, AgentConnectionRunRequest, AgentCredentialVault, AgentModelDescriptor, AgentProviderAdapter } from "@/lib/agent-home/providerAdapters";

export type ClaudeCodeProviderAdapterOptions = {
  vault: AgentCredentialVault;
  modelProxyUrl?: string;
  registry?: ModelProxyRegistry;
  models?: AgentModelDescriptor[];
  cliAvailable?: () => Promise<boolean>;
};

const defaultModels: AgentModelDescriptor[] = [
  { id: "sonnet", displayName: "Claude Sonnet via Claude plan", providerModelVerified: false },
  { id: "opus", displayName: "Claude Opus via Claude plan", providerModelVerified: false },
  { id: "haiku", displayName: "Claude Haiku via Claude plan", providerModelVerified: false },
];

export async function smokeClaudeCodeManagedAuth(input: {
  credential: unknown;
  modelProxyUrl?: string;
  cliAvailable?: () => Promise<boolean>;
}) {
  if (!input.credential) return { status: "failed" as const, checkedAt: new Date().toISOString(), message: "Missing Claude Code managed authentication reference." };
  try {
    parseClaudeCodeCredential(input.credential);
  } catch {
    return { status: "failed" as const, checkedAt: new Date().toISOString(), message: "Stored Claude Code authentication is invalid. Reconnect Claude Code plan access." };
  }
  if (!input.modelProxyUrl) return { status: "failed" as const, checkedAt: new Date().toISOString(), message: "CMAI_MODEL_PROXY_URL is required before Claude Code can run through the one-run broker path." };
  if (!await (input.cliAvailable || isClaudeCodeCliAvailable)()) return { status: "failed" as const, checkedAt: new Date().toISOString(), message: "The official Claude Code CLI is not installed or executable on the broker host." };
  return { status: "passed" as const, checkedAt: new Date().toISOString(), message: "Claude Code managed auth, broker URL, and the official CLI are available for one-run execution with refresh persistence." };
}

function metadata(): AgentConnectionMetadataVerification {
  return {
    providerModelVerified: false,
    verificationStatus: "sandbox_recorded",
    evidenceType: "hermes_run_receipt",
    notes: "Claude is invoked broker-side through the official Claude Code CLI with managed subscription auth. The Challenge My AI receipt proves the run lifecycle and funding path; exact model identity remains sandbox-recorded unless receipt-bound CLI output establishes it.",
  };
}

function delegationId(delegation: { delegation_id?: string; connection_id: string }) {
  return delegation.delegation_id || delegation.connection_id;
}

export function createClaudeCodeProviderAdapter(options: ClaudeCodeProviderAdapterOptions): AgentProviderAdapter {
  const registry = options.registry || defaultModelProxyRegistry();
  const models = options.models?.length ? options.models : defaultModels;
  const cliAvailable = options.cliAvailable || isClaudeCodeCliAvailable;
  return {
    provider: "claude_code",
    connectionKind: "oauth",
    async modelDiscovery() {
      return models.map((model) => ({ ...model }));
    },
    async smokeTest(connection) {
      const credential = await options.vault.getCredential(connection.credentialRef);
      return smokeClaudeCodeManagedAuth({ credential: credential?.value, modelProxyUrl: options.modelProxyUrl, cliAvailable });
    },
    async mintDelegation({ connection, request, delegation, modelProxyUrl }) {
      const credential = await options.vault.getCredential(connection.credentialRef);
      const proxyUrl = modelProxyUrl || options.modelProxyUrl;
      if (!credential) throw new Error("Missing Claude Code managed authentication reference.");
      parseClaudeCodeCredential(credential.value);
      if (!proxyUrl) throw new Error("CMAI_MODEL_PROXY_URL is required before Claude Code can mint a one-run session delegation.");
      const requestForConfig = request as AgentConnectionRunRequest;
      await registry.register({
        runId: requestForConfig.runId,
        ownerId: connection.ownerId,
        delegation,
        agentConnectionId: connection.id,
        provider: "claude_code",
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
          execution_mode: "claude_code_session",
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
