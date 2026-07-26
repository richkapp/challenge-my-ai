import type { AgentConnectionDelegation, ContributionCard, ContributionMode, HermesRunReceipt, ModelFundingSource, SandboxProvider } from "@/lib/types";
import { attachReceiptProvenanceToCard, buildHermesRunReceipt, createReceiptId, sha256Hex, type HermesReceiptSigningKey } from "@/lib/provenance/receipts";
import { approvedUntrustedRunnerProfile, defaultContributionSandboxPolicy, railwayNetworkIsolationForPolicy, validateChallengeSandboxRunRequest, type ChallengeSandboxPolicy, type SandboxRunnerOverride } from "@/lib/sandbox/policy";
import { contributionCardSchema } from "@/lib/validation/schemas";

export class SandboxRunPolicyError extends Error {
  readonly code = "SANDBOX_RUN_POLICY_REJECTED";

  constructor(readonly issues: string[]) {
    super(`Sandbox run policy rejected: ${issues.join("; ")}`);
  }
}

export class SandboxRunArtifactError extends Error {
  readonly code = "SANDBOX_RUN_ARTIFACT_REJECTED";

  constructor(readonly issues: string[]) {
    super(`Sandbox run artifact rejected: ${issues.join("; ")}`);
  }
}

export type HermesRunRequest = {
  runId?: string;
  challengeId: string;
  contributorId: string;
  contributionMode: ContributionMode;
  challengeBundle: unknown;
  provider: string;
  requestedModel: string;
  returnedModel?: string;
  modelDisplayName?: string;
  providerResponseId?: string;
  providerModelVerified?: boolean;
  fundingSource?: ModelFundingSource;
  agentConnection?: AgentConnectionDelegation;
  childRunConfig?: unknown;
  policy?: Partial<ChallengeSandboxPolicy>;
  trustedInternal?: boolean;
  runner?: SandboxRunnerOverride;
  config?: unknown;
  clock?: () => Date;
};

export type SandboxRunEvidence = {
  card: ContributionCard;
  transcript: string | readonly unknown[];
  stdout?: string;
  stderr?: string;
  sandboxId: string;
  sandboxProvider: SandboxProvider;
  teardownCompleted: boolean;
  teardownError?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  hermesVersion?: string;
  containerImageDigest?: string;
};

export type SandboxRunCellAdapter = {
  name: string;
  sandboxProvider: SandboxProvider;
  run(request: NormalizedHermesRunRequest): Promise<SandboxRunEvidence>;
};

export type NormalizedHermesRunRequest = Omit<HermesRunRequest, "runId" | "policy" | "runner" | "fundingSource" | "modelDisplayName" | "providerModelVerified"> & {
  runId: string;
  fundingSource: ModelFundingSource;
  modelDisplayName: string;
  providerModelVerified: boolean;
  policy: ChallengeSandboxPolicy;
  runner: typeof approvedUntrustedRunnerProfile;
};

export type HermesRunOutcome = {
  runId: string;
  challengeId: string;
  contributorId: string;
  card: ContributionCard;
  rawCard: ContributionCard;
  receipt: HermesRunReceipt;
  transcript: string | readonly unknown[];
  stdout: string;
  stderr: string;
  destroyed: boolean;
  adapter: string;
};

export type HermesRunBroker = {
  run(request: HermesRunRequest): Promise<HermesRunOutcome>;
};

function createRunId(request: HermesRunRequest): string {
  return `run_${sha256Hex(`${request.challengeId}:${request.contributorId}:${request.contributionMode}:${request.requestedModel}`).slice(0, 18)}`;
}

function normalizeRequest(request: HermesRunRequest): NormalizedHermesRunRequest {
  return {
    ...request,
    runId: request.runId || createRunId(request),
    modelDisplayName: request.modelDisplayName || request.returnedModel || request.requestedModel,
    providerModelVerified: request.providerModelVerified || false,
    fundingSource: request.fundingSource || "user_provider_access",
    policy: defaultContributionSandboxPolicy(request.policy),
    runner: approvedUntrustedRunnerProfile,
  };
}

function policyConfigFor(request: Pick<HermesRunRequest, "config" | "childRunConfig">): unknown {
  if (request.config === undefined && request.childRunConfig === undefined) return undefined;
  return {
    config: request.config,
    child_run_config: request.childRunConfig,
  };
}

type ModelProxyTranscriptEvidence = {
  returnedModel?: string;
  modelDisplayName?: string;
  providerResponseId?: string;
  providerModelVerified: boolean;
};

const brokerResponseEvents = new Set(["model_proxy_response", "codex_session_response", "claude_code_session_response"]);

function transcriptRecords(transcript: string | readonly unknown[]): Record<string, unknown>[] {
  const values = typeof transcript === "string"
    ? transcript.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return undefined;
      }
    })
    : [...transcript];

  return values.filter((value): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value)));
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function modelProxyEventMatchesRun(record: Record<string, unknown>, request: NormalizedHermesRunRequest): boolean {
  const eventName = String(record.event);
  if (!brokerResponseEvents.has(eventName)) return false;
  if (!request.agentConnection) return false;
  const expectedEvent = request.provider === "codex"
    ? "codex_session_response"
    : request.provider === "claude_code"
      ? "claude_code_session_response"
      : "model_proxy_response";
  if (eventName !== expectedEvent) return false;
  const delegationId = request.agentConnection.delegation_id || request.agentConnection.connection_id;
  const agentConnectionId = request.agentConnection.agent_connection_id || request.agentConnection.connection_id;
  return stringField(record, "run_id") === request.runId
    && stringField(record, "delegation_id") === delegationId
    && stringField(record, "agent_connection_id") === agentConnectionId
    && stringField(record, "provider") === request.provider
    && stringField(record, "request_class") === (request.agentConnection.allowed_request_class || "contribution_card")
    && stringField(record, "requested_model") === request.requestedModel
    && record.remaining_requests === 0;
}

export function modelProxyEvidenceFromTranscript(transcript: string | readonly unknown[], request: NormalizedHermesRunRequest): ModelProxyTranscriptEvidence | undefined {
  const event = transcriptRecords(transcript).find((record) => modelProxyEventMatchesRun(record, request));
  if (!event) return undefined;
  const returnedModel = stringField(event, "returned_model");
  const providerResponseId = stringField(event, "provider_response_id");
  return {
    returnedModel,
    modelDisplayName: stringField(event, "model_display_name") || returnedModel,
    providerResponseId,
    providerModelVerified: event.provider_model_verified === true && Boolean(returnedModel || providerResponseId),
  };
}

export function validateHermesRunRequest(request: HermesRunRequest, sandboxProvider: SandboxProvider = "local_fake"): string[] {
  const normalized = normalizeRequest(request);
  return validateChallengeSandboxRunRequest({
    challengeId: normalized.challengeId,
    contributionMode: normalized.contributionMode,
    adapter: sandboxProvider === "railway" ? "railway_sandbox" : "local_fake",
    policy: normalized.policy,
    trustedInternal: normalized.trustedInternal,
    agentConnection: normalized.agentConnection,
    runner: request.runner,
    config: policyConfigFor(normalized),
  });
}

function validateEvidenceCardMatchesRun(card: ContributionCard, request: NormalizedHermesRunRequest): ContributionCard {
  const parsed = contributionCardSchema.safeParse(card);
  if (!parsed.success) {
    throw new SandboxRunArtifactError(parsed.error.issues.map((issue) => `${issue.path.join(".") || "card"}: ${issue.message}`));
  }

  const issues: string[] = [];
  if (parsed.data.challenge_id !== request.challengeId) {
    issues.push(`card.challenge_id must match approved run challenge_id ${request.challengeId}`);
  }
  if (parsed.data.contribution_mode !== request.contributionMode) {
    issues.push(`card.contribution_mode must match approved run contribution_mode ${request.contributionMode}`);
  }
  if (issues.length > 0) throw new SandboxRunArtifactError(issues);
  return parsed.data;
}

export async function executeHermesRunWithAdapter(adapter: SandboxRunCellAdapter, request: HermesRunRequest, signingKey: HermesReceiptSigningKey): Promise<HermesRunOutcome> {
  const normalized = normalizeRequest(request);
  const issues = validateHermesRunRequest(request, adapter.sandboxProvider);
  if (issues.length > 0) throw new SandboxRunPolicyError(issues);

  const evidence = await adapter.run(normalized);
  const outputCard = validateEvidenceCardMatchesRun(evidence.card, normalized);
  const startedAt = evidence.startedAt || normalized.clock?.().toISOString() || new Date().toISOString();
  const completedAt = evidence.completedAt || normalized.clock?.().toISOString() || new Date().toISOString();
  const durationMs = evidence.durationMs ?? Math.max(0, Date.parse(completedAt) - Date.parse(startedAt));
  const receiptId = createReceiptId(normalized.runId, normalized.challengeId, normalized.contributorId);
  const modelProxyEvidence = modelProxyEvidenceFromTranscript(evidence.transcript, normalized);

  const receipt = buildHermesRunReceipt({
    receipt_id: receiptId,
    run_id: normalized.runId,
    challenge_id: normalized.challengeId,
    contributor_id: normalized.contributorId,
    funding_source: normalized.fundingSource,
    execution_authority: normalized.trustedInternal ? "cmai_broker" : "cmai_sandbox",
    delegation: normalized.agentConnection,
    provider: {
      provider: normalized.provider,
      requested_model: normalized.requestedModel,
      returned_model: modelProxyEvidence?.returnedModel || normalized.returnedModel,
      model_display_name: modelProxyEvidence?.modelDisplayName || modelProxyEvidence?.returnedModel || normalized.modelDisplayName || normalized.requestedModel,
      provider_response_id: modelProxyEvidence?.providerResponseId || normalized.providerResponseId,
      provider_model_verified: modelProxyEvidence?.providerModelVerified ?? normalized.providerModelVerified ?? false,
    },
    runner: {
      profile: approvedUntrustedRunnerProfile.profile,
      checkpoint: approvedUntrustedRunnerProfile.checkpoint,
      hermes_version: evidence.hermesVersion,
      container_image_digest: evidence.containerImageDigest,
    },
    sandbox: {
      provider: evidence.sandboxProvider,
      sandbox_id: evidence.sandboxId,
      network_isolation: railwayNetworkIsolationForPolicy(normalized.policy),
      teardown_completed: evidence.teardownCompleted,
      teardown_error: evidence.teardownError,
    },
    tool_policy: approvedUntrustedRunnerProfile.command,
    network_policy: `${railwayNetworkIsolationForPolicy(normalized.policy)}/secrets=${normalized.policy.secrets}/destroy=${normalized.policy.destroyOnCompletion}`,
    promptBundle: normalized.challengeBundle,
    outputCard,
    transcript: evidence.transcript,
    timing: { started_at: startedAt, completed_at: completedAt, duration_ms: durationMs },
    signingKey,
  });

  return {
    runId: normalized.runId,
    challengeId: normalized.challengeId,
    contributorId: normalized.contributorId,
    card: attachReceiptProvenanceToCard(outputCard, receipt),
    rawCard: outputCard,
    receipt,
    transcript: evidence.transcript,
    stdout: evidence.stdout || "",
    stderr: evidence.stderr || "",
    destroyed: receipt.sandbox.teardown_completed,
    adapter: adapter.name,
  };
}
