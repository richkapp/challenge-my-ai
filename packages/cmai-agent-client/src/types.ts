import type { z } from "zod";
import type { AgentProtocolOperation, AgentRuntimeKind } from "../../../lib/agent-protocol/constants";
import type {
  AgentChallengeGetRequest,
  AgentContributionSubmitRequest,
  AgentFeedListRequest,
  AgentPairCreateRequest,
  AgentPairingRevokeRequest,
  AgentPairingRotateKeyRequest,
} from "../../../lib/agent-protocol/schemas";
import {
  agentChallengeGetResponseSchema,
  agentContributionSubmitResponseSchema,
  agentFeedListResponseSchema,
  agentPairCreateResponseSchema,
  agentPairingMutationResponseSchema,
} from "../../../lib/agent-protocol/schemas";
import type { ContributionCardV1 } from "../../../lib/validation/contributionCardProtocol";
import type { CmaiAgentClientErrorSnapshot } from "./errors";

export type AgentPairCreateResponse = z.infer<typeof agentPairCreateResponseSchema>;
export type AgentPairingMutationResponse = z.infer<typeof agentPairingMutationResponseSchema>;
export type AgentFeedListResponse = z.infer<typeof agentFeedListResponseSchema>;
export type AgentChallengeGetResponse = z.infer<typeof agentChallengeGetResponseSchema>;
export type AgentContributionSubmitResponse = z.infer<typeof agentContributionSubmitResponseSchema>;

export type AgentPairingState = AgentPairCreateResponse["result"]["pairing"];
export type AgentPublicChallenge = AgentChallengeGetResponse["result"]["challenge"];
export type AgentPublicChallengeSummary = AgentFeedListResponse["result"]["challenges"][number];

export type AgentProtocolRequestMap = {
  "pair.create": AgentPairCreateRequest;
  "pairing.rotate_key": AgentPairingRotateKeyRequest;
  "pairing.revoke": AgentPairingRevokeRequest;
  "feed.list": AgentFeedListRequest;
  "challenge.get": AgentChallengeGetRequest;
  "contribution.submit": AgentContributionSubmitRequest;
};

export type AgentProtocolResponseMap = {
  "pair.create": AgentPairCreateResponse;
  "pairing.rotate_key": AgentPairingMutationResponse;
  "pairing.revoke": AgentPairingMutationResponse;
  "feed.list": AgentFeedListResponse;
  "challenge.get": AgentChallengeGetResponse;
  "contribution.submit": AgentContributionSubmitResponse;
};

export type CmaiAgentTransportRequest<TOperation extends AgentProtocolOperation = AgentProtocolOperation> = {
  operation: TOperation;
  envelope: AgentProtocolRequestMap[TOperation];
};

export type CmaiAgentTransportResponse = {
  status: number;
  body: unknown;
};

export type CmaiAgentTransportOptions = {
  signal: AbortSignal;
  timeoutMs: number;
  requestId: string;
};

/**
 * Platform adapters choose the HTTP path, headers, and serialization. The
 * shared client owns the exact protocol envelope and validates the response.
 */
export interface CmaiAgentTransport {
  send<TOperation extends AgentProtocolOperation>(
    request: CmaiAgentTransportRequest<TOperation>,
    options: CmaiAgentTransportOptions,
  ): Promise<CmaiAgentTransportResponse>;
}

/** Host-owned signing seam. Private-key material never enters the client. */
export interface CmaiAgentSigner {
  readonly keyId: string;
  sign(signingBytes: string): Promise<string>;
}

export type CmaiAgentRuntimeIdentity = {
  runtime: AgentRuntimeKind;
  runtimeVersion?: string;
  adapterName: string;
  adapterVersion: string;
};

export type CmaiAgentRunInput = {
  challenge: AgentPublicChallenge;
  promptVersion: string;
  maxOutputBytes: number;
};

export type CmaiAgentRunResult = {
  identity: CmaiAgentRuntimeIdentity;
  localRunId: string;
  card: unknown;
  providerClaim?: string;
  modelClaim?: string;
  modelDisplayNameClaim?: string;
  startedAt: string;
  completedAt: string;
  structuredOutputValidated: true;
};

/**
 * Runtime packages implement only this bounded model-call seam. The shared
 * client deliberately does not call it: the command/UI must obtain explicit
 * cost approval before invoking execute and then pass the result to preview.
 */
export interface CmaiAgentRuntimeAdapter {
  readonly identity: CmaiAgentRuntimeIdentity;
  execute(input: CmaiAgentRunInput, options: { signal?: AbortSignal }): Promise<CmaiAgentRunResult>;
}

export type CmaiAgentClientPhase =
  | "unpaired"
  | "paired"
  | "challenge_ready"
  | "preview"
  | "submitting"
  | "submit_failed"
  | "submitted"
  | "discarded"
  | "revoked";

export type CmaiAgentPreview = {
  card: ContributionCardV1;
  editedAfterRun: boolean;
  localRunId: string;
};

export type CmaiAgentClientSnapshot = {
  phase: CmaiAgentClientPhase;
  pairing?: AgentPairingState;
  challenge?: {
    challengeId: string;
    revision: number;
    runNonceExpiresAt: string;
  };
  preview?: CmaiAgentPreview;
  submission?: AgentContributionSubmitResponse["result"];
  lastError?: CmaiAgentClientErrorSnapshot;
};
