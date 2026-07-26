import { createAgentContribution, getChallenge, listContributions } from "@/lib/store";
import { defaultContributionModeForRequestedModes } from "@/lib/contributionModes";
import { attachReceiptProvenanceToCard, hashOutputCard, sha256Hex, verifyHermesRunReceipt, verifyHermesRunReceiptArtifacts, type HermesReceiptSigningKey } from "@/lib/provenance/receipts";
import { SandboxRunArtifactError, SandboxRunPolicyError, type HermesRunBroker, type HermesRunOutcome, type HermesRunRequest } from "@/lib/sandbox/broker";
import { contributionCardSchema } from "@/lib/validation/schemas";
import type { AgentConnectionDelegation, Challenge, Contribution, ContributionCard, ContributionMode, HermesRunReceipt, ModelFundingSource } from "@/lib/types";
import type { ChildRunDelegationConfig } from "@/lib/agent-home/providerAdapters";
import { isChallengePubliclyEligible } from "@/lib/challenges/intent";

const RAILWAY_SANDBOX_UNAVAILABLE = "RAILWAY_SANDBOX_UNAVAILABLE";
const SANDBOX_FAILURE_DETAIL_LIMIT = 1_200;

const acceptingChallengeStatuses = new Set<Challenge["status"]>(["open", "contributing", "ready_for_synthesis"]);

export type AgentRunExecutorStatus = "queued" | "preparing_delegation" | "running_cell" | "validating_artifacts" | "contributed" | "failed";

export type AgentRunFailureCode =
  | "challenge_not_eligible"
  | "delegation_unavailable"
  | "sandbox_policy_rejected"
  | "railway_sandbox_unavailable"
  | "sandbox_run_failed"
  | "delegation_consumption_failed"
  | "invalid_contribution_card"
  | "receipt_verification_failed"
  | "receipt_artifact_mismatch"
  | "contribution_post_failed";

export type AgentRunContributor = {
  id: string;
  label: string;
  ownerId?: string;
};

export type AgentRunConnectionRequest = {
  id: string;
  agentConnectionId?: string;
  provider: string;
  requestedModel: string;
  returnedModel?: string;
  modelDisplayName?: string;
  providerResponseId?: string;
  providerModelVerified?: boolean;
  fundingSource?: ModelFundingSource;
};

export type AgentRunDelegationRequest = {
  runId: string;
  challengeId: string;
  contributor: AgentRunContributor;
  connection: AgentRunConnectionRequest;
  contributionMode: ContributionMode;
};

export type AgentRunDelegationGrant = {
  delegation: AgentConnectionDelegation;
  childRunConfig?: ChildRunDelegationConfig;
};

export type AgentRunDelegationService = {
  mintDelegation(input: AgentRunDelegationRequest): Promise<AgentRunDelegationGrant>;
  consumeDelegation?(delegation: AgentConnectionDelegation, context: { runId: string; receipt: HermesRunReceipt }): Promise<void>;
  revokeDelegation?(delegation: AgentConnectionDelegation, context: { runId: string; reason: AgentRunFailureCode | string }): Promise<void>;
};

export type AgentRunStateEvent = {
  runId: string;
  challengeId: string;
  contributorId: string;
  status: AgentRunExecutorStatus;
  contributionId?: string;
  receiptId?: string;
  failureCode?: AgentRunFailureCode;
  failureMessage?: string;
  receiptSummary?: {
    receiptId: string;
    sandboxProvider: string;
    sandboxId: string;
    teardownCompleted: boolean;
  };
};

export type AgentRunExecutorInput = {
  runId?: string;
  idempotencyKey?: string;
  challengeId: string;
  contributor: AgentRunContributor;
  connection: AgentRunConnectionRequest;
  contributionMode?: ContributionMode;
  broker: HermesRunBroker;
  receiptSigningKey: HermesReceiptSigningKey;
  delegationService: AgentRunDelegationService;
  brokerPolicy?: HermesRunRequest["policy"];
  trustedInternal?: boolean;
  recordRunState?: (event: AgentRunStateEvent) => void | Promise<void>;
  now?: () => Date;
};

export type AgentRunExecutorContributedResult = {
  status: "contributed";
  runId: string;
  challengeId: string;
  contribution: Contribution;
  receipt?: HermesRunReceipt;
  reusedContribution: boolean;
};

export type AgentRunExecutorFailedResult = {
  status: "failed";
  runId: string;
  challengeId: string;
  failureCode: AgentRunFailureCode;
  failureMessage: string;
};

export type AgentRunExecutorResult = AgentRunExecutorContributedResult | AgentRunExecutorFailedResult;

class AgentRunExecutionFailure extends Error {
  constructor(readonly failureCode: AgentRunFailureCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

function redactSandboxFailureDetails(text: string): string {
  return text
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "sk-or-v1-[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|password|secret|token)(["'\s:=]+)([^"'\s,}]+)/gi, "$1$2[REDACTED]");
}

function sandboxFailureDetailsSummary(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("details" in error)) return undefined;
  const details = (error as { details?: unknown }).details;
  if (typeof details !== "object" || details === null) return undefined;
  const record = details as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of ["exitCode", "timedOut", "truncated", "stdout", "stderr", "destroy_error"] as const) {
    const value = record[key];
    if (value === undefined || value === "") continue;
    summary[key] = typeof value === "string" ? redactSandboxFailureDetails(value).slice(0, SANDBOX_FAILURE_DETAIL_LIMIT) : value;
  }
  if (Object.keys(summary).length === 0) return undefined;
  return redactSandboxFailureDetails(JSON.stringify(summary)).slice(0, SANDBOX_FAILURE_DETAIL_LIMIT);
}

function contributionModeFor(input: AgentRunExecutorInput, challenge?: Challenge): ContributionMode {
  return input.contributionMode || (challenge ? defaultContributionModeForRequestedModes(challenge.requestedModes) : "critique");
}

function createRunId(input: AgentRunExecutorInput, contributionMode: ContributionMode): string {
  if (input.runId) return input.runId;
  const idempotencyKey = input.idempotencyKey || `${input.challengeId}:${input.contributor.id}:${input.connection.id}:${contributionMode}`;
  return `run_${sha256Hex(`agent-run:${idempotencyKey}`).slice(0, 18)}`;
}

function buildChallengeBundle(challenge: Challenge): Record<string, unknown> {
  return {
    schema_version: "1.0",
    challenge_id: challenge.id,
    title: challenge.title,
    category: challenge.category,
    requested_modes: challenge.requestedModes,
    safety_flags: challenge.safetyFlags,
    brief: challenge.brief,
  };
}

function failureFromUnknown(error: unknown): AgentRunExecutionFailure {
  if (error instanceof AgentRunExecutionFailure) return error;
  if (error instanceof SandboxRunPolicyError) {
    return new AgentRunExecutionFailure("sandbox_policy_rejected", "Sandbox run policy rejected the requested contribution run.", { cause: error });
  }
  if (error instanceof SandboxRunArtifactError) {
    return new AgentRunExecutionFailure("invalid_contribution_card", "Sandbox run returned a contribution card that did not match the approved run.", { cause: error });
  }
  if (typeof error === "object" && error !== null && "code" in error && error.code === RAILWAY_SANDBOX_UNAVAILABLE) {
    return new AgentRunExecutionFailure("railway_sandbox_unavailable", "Railway sandbox execution is unavailable in this environment.", { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  const detailsSummary = sandboxFailureDetailsSummary(error);
  return new AgentRunExecutionFailure("sandbox_run_failed", detailsSummary ? `${message || "Sandbox run failed."} Details: ${detailsSummary}` : message || "Sandbox run failed.", { cause: error });
}

function ensureEligibleChallenge(challenge: Challenge | undefined): asserts challenge is Challenge {
  if (!challenge || !isChallengePubliclyEligible(challenge) || !acceptingChallengeStatuses.has(challenge.status)) {
    throw new AgentRunExecutionFailure("challenge_not_eligible", "Challenge is not eligible for trusted Agent runs.");
  }
}

async function findExistingRunContribution(challengeId: string, contributorId: string, runId: string): Promise<Contribution | undefined> {
  const contributions = await listContributions(challengeId);
  return contributions.find((contribution) => (
    contribution.contributorKind === "agent"
    && contribution.contributorId === contributorId
    && contribution.card.model_provenance?.source === "hermes_sandbox_run"
    && contribution.card.model_provenance.run_id === runId
  ));
}

function ensureOutcomeMatchesRun(outcome: HermesRunOutcome, input: AgentRunExecutorInput, runId: string, contributionMode: ContributionMode, delegation: AgentConnectionDelegation, challengeBundle: Record<string, unknown>): ContributionCard {
  const parsedRawCard = contributionCardSchema.safeParse(outcome.rawCard);
  const parsedPostedCard = contributionCardSchema.safeParse(outcome.card);
  if (!parsedRawCard.success || !parsedPostedCard.success) {
    throw new AgentRunExecutionFailure("invalid_contribution_card", "Sandbox run returned an invalid CMAI_CONTRIBUTION_CARD_V1 artifact.");
  }

  if (parsedRawCard.data.contribution_mode !== contributionMode || parsedPostedCard.data.contribution_mode !== contributionMode) {
    throw new AgentRunExecutionFailure("receipt_verification_failed", "Sandbox run contribution mode did not match the approved run.");
  }

  if (!verifyHermesRunReceipt(outcome.receipt, input.receiptSigningKey)) {
    throw new AgentRunExecutionFailure("receipt_verification_failed", "Sandbox run receipt signature could not be verified.");
  }

  if (!verifyHermesRunReceiptArtifacts({
    receipt: outcome.receipt,
    signingKey: input.receiptSigningKey,
    promptBundle: challengeBundle,
    outputCard: parsedRawCard.data,
    transcript: outcome.transcript,
  })) {
    throw new AgentRunExecutionFailure("receipt_artifact_mismatch", "Sandbox run receipt hashes did not match the approved prompt, raw output card, and transcript artifacts.");
  }

  const provenance = parsedPostedCard.data.model_provenance;
  const receipt = outcome.receipt;
  const expectedPostedCard = attachReceiptProvenanceToCard(parsedRawCard.data, receipt);
  const postedCardMatchesReceiptBoundRawCard = hashOutputCard(parsedPostedCard.data) === hashOutputCard(expectedPostedCard);
  const receiptMatchesRun = receipt.run_id === runId
    && receipt.challenge_id === input.challengeId
    && receipt.contributor_id === input.contributor.id
    && receipt.source === "hermes_sandbox_run"
    && receipt.delegation?.connection_id === delegation.connection_id
    && receipt.delegation?.provider === delegation.provider;
  const cardMatchesRun = parsedPostedCard.data.challenge_id === input.challengeId
    && provenance?.source === "hermes_sandbox_run"
    && provenance.run_id === runId
    && provenance.receipt_id === receipt.receipt_id
    && provenance.sandbox_provider === receipt.sandbox.provider
    && provenance.output_sha256 === receipt.artifacts.output_sha256
    && provenance.prompt_sha256 === receipt.artifacts.prompt_sha256
    && provenance.transcript_sha256 === receipt.artifacts.transcript_sha256;

  if (!receiptMatchesRun || !cardMatchesRun || !postedCardMatchesReceiptBoundRawCard) {
    throw new AgentRunExecutionFailure("receipt_verification_failed", "Sandbox run receipt, contribution card, or delegation metadata did not match the approved run.");
  }
  return expectedPostedCard;
}

async function record(input: AgentRunExecutorInput, runId: string, status: AgentRunExecutorStatus, event: Partial<AgentRunStateEvent> = {}) {
  await input.recordRunState?.({
    runId,
    challengeId: input.challengeId,
    contributorId: input.contributor.id,
    status,
    ...event,
  });
}

async function revokeIfPossible(input: AgentRunExecutorInput, runId: string, delegation: AgentConnectionDelegation | undefined, reason: AgentRunFailureCode | string) {
  if (!delegation || !input.delegationService.revokeDelegation) return;
  try {
    await input.delegationService.revokeDelegation(delegation, { runId, reason });
  } catch {
    // Revocation is a cleanup best-effort; the stable run failure should remain the original one.
  }
}

export async function executeAgentRunContribution(input: AgentRunExecutorInput): Promise<AgentRunExecutorResult> {
  const initialMode = contributionModeFor(input);
  const runId = createRunId(input, initialMode);
  let delegation: AgentConnectionDelegation | undefined;
  let delegationConsumed = false;

  try {
    await record(input, runId, "queued");
    const challenge = await getChallenge(input.challengeId);
    ensureEligibleChallenge(challenge);
    const contributionMode = contributionModeFor(input, challenge);

    const existing = await findExistingRunContribution(input.challengeId, input.contributor.id, runId);
    if (existing) {
      await record(input, runId, "contributed", {
        contributionId: existing.id,
        receiptId: existing.card.model_provenance?.receipt_id,
      });
      return { status: "contributed", runId, challengeId: input.challengeId, contribution: existing, reusedContribution: true };
    }

    await record(input, runId, "preparing_delegation");
    let childRunConfig: ChildRunDelegationConfig | undefined;
    try {
      const grant = await input.delegationService.mintDelegation({ runId, challengeId: input.challengeId, contributor: input.contributor, connection: input.connection, contributionMode });
      delegation = grant.delegation;
      childRunConfig = grant.childRunConfig;
    } catch (error) {
      throw new AgentRunExecutionFailure("delegation_unavailable", "Unable to mint a one-run Agent delegation for this contribution.", { cause: error });
    }
    const delegationForRun = delegation;
    if (!delegationForRun) {
      throw new AgentRunExecutionFailure("delegation_unavailable", "Unable to mint a one-run Agent delegation for this contribution.");
    }

    await record(input, runId, "running_cell");
    const challengeBundle = buildChallengeBundle(challenge);
    const outcome = await input.broker.run({
      runId,
      challengeId: input.challengeId,
      contributorId: input.contributor.id,
      contributionMode,
      challengeBundle,
      provider: input.connection.provider || delegationForRun.provider,
      requestedModel: input.connection.requestedModel || delegationForRun.allowed_model || "unknown",
      returnedModel: input.connection.returnedModel,
      modelDisplayName: input.connection.modelDisplayName || input.connection.returnedModel || input.connection.requestedModel || delegationForRun.allowed_model,
      providerResponseId: input.connection.providerResponseId,
      providerModelVerified: input.connection.providerModelVerified || false,
      fundingSource: input.connection.fundingSource || "user_provider_access",
      agentConnection: delegationForRun,
      childRunConfig,
      policy: input.brokerPolicy,
      trustedInternal: input.trustedInternal,
      clock: input.now,
    });

    try {
      await input.delegationService.consumeDelegation?.(delegationForRun, { runId, receipt: outcome.receipt });
      delegationConsumed = true;
    } catch (error) {
      throw new AgentRunExecutionFailure("delegation_consumption_failed", "Unable to mark the one-run delegation as consumed.", { cause: error });
    }

    await record(input, runId, "validating_artifacts", {
      receiptId: outcome.receipt.receipt_id,
      receiptSummary: {
        receiptId: outcome.receipt.receipt_id,
        sandboxProvider: outcome.receipt.sandbox.provider,
        sandboxId: outcome.receipt.sandbox.sandbox_id,
        teardownCompleted: outcome.receipt.sandbox.teardown_completed,
      },
    });
    const receiptBoundCard = ensureOutcomeMatchesRun(outcome, input, runId, contributionMode, delegationForRun, challengeBundle);

    const existingAfterRun = await findExistingRunContribution(input.challengeId, input.contributor.id, runId);
    if (existingAfterRun) {
      await record(input, runId, "contributed", {
        contributionId: existingAfterRun.id,
        receiptId: existingAfterRun.card.model_provenance?.receipt_id,
      });
      return { status: "contributed", runId, challengeId: input.challengeId, contribution: existingAfterRun, receipt: outcome.receipt, reusedContribution: true };
    }

    let contribution: Contribution;
    try {
      contribution = await createAgentContribution({
        agentId: input.contributor.id,
        agentLabel: input.contributor.label,
        ownerId: input.contributor.ownerId,
        challengeId: input.challengeId,
        card: receiptBoundCard,
        externallyGenerated: true,
      });
    } catch (error) {
      throw new AgentRunExecutionFailure("contribution_post_failed", "Trusted Agent run completed but contribution posting failed.", { cause: error });
    }

    await record(input, runId, "contributed", {
      contributionId: contribution.id,
      receiptId: outcome.receipt.receipt_id,
      receiptSummary: {
        receiptId: outcome.receipt.receipt_id,
        sandboxProvider: outcome.receipt.sandbox.provider,
        sandboxId: outcome.receipt.sandbox.sandbox_id,
        teardownCompleted: outcome.receipt.sandbox.teardown_completed,
      },
    });
    return { status: "contributed", runId, challengeId: input.challengeId, contribution, receipt: outcome.receipt, reusedContribution: false };
  } catch (error) {
    const failure = failureFromUnknown(error);
    if (!delegationConsumed) await revokeIfPossible(input, runId, delegation, failure.failureCode);
    await record(input, runId, "failed", { failureCode: failure.failureCode, failureMessage: failure.message });
    return { status: "failed", runId, challengeId: input.challengeId, failureCode: failure.failureCode, failureMessage: failure.message };
  }
}
