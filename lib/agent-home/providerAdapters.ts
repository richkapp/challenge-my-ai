import type { AgentConnectionDelegation, ContributionMode, ModelProvenanceEvidenceType, ModelProvenanceVerificationStatus } from "@/lib/types";

export const agentConnectionKinds = ["oauth", "device_code", "provider_key", "connector", "test_fake"] as const;
export type AgentConnectionKind = (typeof agentConnectionKinds)[number];

export const agentConnectionStatuses = ["ready", "setup_required", "paused", "expired", "smoke_failed", "needs_reconnect", "revoked"] as const;
export type AgentConnectionStatus = (typeof agentConnectionStatuses)[number];

export const agentSmokeStatuses = ["passed", "failed", "not_run"] as const;
export type AgentSmokeStatus = (typeof agentSmokeStatuses)[number];

export type AgentRequestClass = ContributionMode | "contribution_card";

export type AgentConnectionSmokeResult = {
  status: AgentSmokeStatus;
  checkedAt: string;
  message?: string;
  providerResponseId?: string;
};

export type AgentConnectionMetadataVerification = {
  providerModelVerified: boolean;
  verificationStatus: ModelProvenanceVerificationStatus;
  evidenceType?: ModelProvenanceEvidenceType;
  notes: string;
};

export type AgentModelDescriptor = {
  id: string;
  displayName: string;
  providerModelVerified: boolean;
};

export type AgentConnection = {
  id: string;
  ownerId: string;
  agentHomeId: string;
  provider: string;
  connectionKind: AgentConnectionKind;
  displayLabel: string;
  status: AgentConnectionStatus;
  credentialRef: string;
  defaultModel: string;
  allowedModels: string[];
  allowedRequestClasses: AgentRequestClass[];
  metadataVerification: AgentConnectionMetadataVerification;
  lastSmoke: AgentConnectionSmokeResult;
  expiresAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type RedactedAgentConnection = Omit<AgentConnection, "credentialRef"> & {
  brokerCredentialAvailable: boolean;
};

export type AgentConnectionRunRequest = {
  runId: string;
  challengeId: string;
  contributorId: string;
  contributionMode: ContributionMode;
  requestedModel?: string;
  requestClass?: AgentRequestClass;
  maxSpendCents?: number;
  expiresInMs?: number;
};

export type ChildRunExecutionMode = "model_proxy" | "codex_session" | "claude_code_session";

export type ChildRunDelegationConfig = {
  execution_mode?: ChildRunExecutionMode;
  run_id: string;
  delegation_id: string;
  agent_connection_id: string;
  provider: string;
  allowed_model?: string;
  allowed_request_class?: string;
  expires_at: string;
  max_requests: number;
  max_spend_cents?: number;
  model_proxy_url?: string;
};

export type ProviderDelegationGrant = {
  delegation: AgentConnectionDelegation;
  childRunConfig: ChildRunDelegationConfig;
  metadataVerification: AgentConnectionMetadataVerification;
};

export type MintProviderDelegationInput = {
  connection: AgentConnection;
  request: AgentConnectionRunRequest;
  delegation: AgentConnectionDelegation;
  modelProxyUrl?: string;
};

export type RevokeProviderDelegationInput = {
  connection: AgentConnection;
  delegation: AgentConnectionDelegation;
  reason?: string;
};

export type AgentProviderAdapter = {
  provider: string;
  connectionKind: AgentConnectionKind;
  modelDiscovery(connection: AgentConnection): Promise<AgentModelDescriptor[]>;
  smokeTest(connection: AgentConnection): Promise<AgentConnectionSmokeResult>;
  mintDelegation(input: MintProviderDelegationInput): Promise<ProviderDelegationGrant>;
  revokeDelegation(input: RevokeProviderDelegationInput): Promise<void>;
  metadataVerification(connection: AgentConnection): AgentConnectionMetadataVerification;
};

export type AgentCredentialRecord = {
  ref: string;
  provider: string;
  value: unknown;
  createdAt: string;
  updatedAt?: string;
  revision?: number;
  expiresAt?: string;
};

export type AgentCredentialVault = {
  putCredential(record: AgentCredentialRecord): Promise<void>;
  getCredential(ref: string): Promise<AgentCredentialRecord | undefined>;
  deleteCredential(ref: string): Promise<void>;
};
