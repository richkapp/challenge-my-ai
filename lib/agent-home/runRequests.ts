import { z } from "zod";
import { HttpError, parseJsonBody, validateBody } from "@/lib/api/responses";
import { env, isProductionLike, loadEnv, railwaySandboxAuthMode, railwaySandboxConfigIssues } from "@/lib/config/env";
import type { AgentConnection as StoreAgentConnection, AgentConnectionDelegation, CurrentUser, ContributionMode, HermesRunReceipt, ModelProvenanceEvidenceType, ModelProvenanceVerificationStatus } from "@/lib/types";
import { contributionModes } from "@/lib/types";
import { defaultContributionModeForRequestedModes } from "@/lib/contributionModes";
import { createFakeHermesRunBroker } from "@/lib/sandbox/fakeHermesRunBroker";
import { createRailwaySandboxBroker } from "@/lib/sandbox/railwayBroker";
import { createRailwayOAuthAccessTokenProvider } from "@/lib/sandbox/railwayOAuthTokenProvider";
import type { HermesRunBroker } from "@/lib/sandbox/broker";
import { executeAgentRunContribution, type AgentRunDelegationService, type AgentRunStateEvent } from "@/lib/agent-home/runExecutor";
import { createAgentDelegationService } from "@/lib/agent-home/delegations";
import { createOpenRouterProviderAdapter } from "@/lib/agent-home/openrouterAdapter";
import { createAnthropicProviderAdapter } from "@/lib/agent-home/anthropicAdapter";
import { createOpenAIProviderAdapter } from "@/lib/agent-home/openaiAdapter";
import { createCodexProviderAdapter } from "@/lib/agent-home/codexAdapter";
import { createClaudeCodeProviderAdapter } from "@/lib/agent-home/claudeCodeAdapter";
import { createUnavailableProviderAdapter } from "@/lib/agent-home/genericProviderAdapter";
import { activeModelProxyRegistry } from "@/lib/agent-home/modelProxy";
import { brokerCredentialRef } from "@/lib/agent-home/brokerVault";
import { providerCatalogEntry } from "@/lib/agent-home/providerCatalog";
import { createFakeProviderAdapter, InMemoryAgentCredentialVault } from "@/lib/agent-home/testAdapters";
import type { AgentConnection as ProviderAgentConnection, AgentConnectionKind as ProviderAgentConnectionKind, AgentConnectionMetadataVerification, AgentRequestClass, AgentProviderAdapter } from "@/lib/agent-home/providerAdapters";
import { agentRunManualPasteFallback, publicAgentRun, receiptSummaryFromReceipt } from "@/lib/agent-home/runState";
import { isFakeOrDevAgentProvider, isProductionBlockedAgentConnection } from "@/lib/agent-home/connectionPolicy";
import { assertRateLimitPolicy } from "@/lib/security/rateLimit";
import { trackEvent } from "@/lib/analytics/events";
import { recordLlmTrace } from "@/lib/observability/langfuse";
import {
  findAgentRunByIdempotencyKey,
  getRuntimeSecret,
  getAgentConnectionCredential,
  getAgentHomeConnection,
  getChallenge,
  reserveAgentRun,
  setRuntimeSecret,
  updateAgentRun,
  updateJob,
} from "@/lib/store";
import type { HermesReceiptSigningKey } from "@/lib/provenance/receipts";
import { isChallengePubliclyEligible } from "@/lib/challenges/intent";

const acceptingChallengeStatuses = new Set(["open", "contributing", "ready_for_synthesis"]);

const createAgentRunBodySchema = z.object({
  connectionId: z.string().min(1),
  contributionMode: z.enum(contributionModes).optional(),
  requestedModel: z.string().min(1).optional(),
  approved: z.boolean().optional(),
  idempotencyKey: z.string().min(1).max(160).optional(),
}).strict();

function activeRuntime() {
  return loadEnv(process.env);
}

function activeProductionLike() {
  return isProductionLike(activeRuntime());
}

export type CreateAgentRunBody = z.infer<typeof createAgentRunBodySchema>;

function receiptSigningKey(): HermesReceiptSigningKey {
  const runtime = activeRuntime();
  const keyId = process.env.CMAI_RECEIPT_SIGNING_KEY_ID || runtime.CMAI_RECEIPT_SIGNING_KEY_ID || env.CMAI_RECEIPT_SIGNING_KEY_ID;
  const secret = process.env.CMAI_RECEIPT_SIGNING_SECRET || runtime.CMAI_RECEIPT_SIGNING_SECRET || env.CMAI_RECEIPT_SIGNING_SECRET;
  if (isProductionLike(runtime) && (!keyId || !secret)) {
    throw new HttpError(503, "Production Agent run receipt signing is not configured.", "agent_run_receipt_signing_unavailable", {
      issues: [
        ...(!keyId ? ["CMAI_RECEIPT_SIGNING_KEY_ID"] : []),
        ...(!secret ? ["CMAI_RECEIPT_SIGNING_SECRET"] : []),
      ],
      manualPasteFallback: agentRunManualPasteFallback,
    });
  }
  return {
    keyId: keyId || "local-agent-run",
    secret: secret || "local-agent-run-secret",
  };
}

function railwayRuntimeWithProcessOverrides(runtime = activeRuntime()) {
  const token = process.env.RAILWAY_API_TOKEN || runtime.RAILWAY_API_TOKEN || env.RAILWAY_API_TOKEN;
  const environmentId = process.env.RAILWAY_ENVIRONMENT_ID || runtime.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_ENVIRONMENT_ID;
  const checkpoint = process.env.RAILWAY_SANDBOX_CHECKPOINT || runtime.RAILWAY_SANDBOX_CHECKPOINT || env.RAILWAY_SANDBOX_CHECKPOINT || undefined;
  const authMode = process.env.RAILWAY_SANDBOX_AUTH_MODE || runtime.RAILWAY_SANDBOX_AUTH_MODE || env.RAILWAY_SANDBOX_AUTH_MODE;
  const refreshToken = process.env.RAILWAY_OAUTH_REFRESH_TOKEN || runtime.RAILWAY_OAUTH_REFRESH_TOKEN || env.RAILWAY_OAUTH_REFRESH_TOKEN;
  const clientId = process.env.RAILWAY_OAUTH_CLIENT_ID || runtime.RAILWAY_OAUTH_CLIENT_ID || env.RAILWAY_OAUTH_CLIENT_ID;
  const clientSecret = process.env.RAILWAY_OAUTH_CLIENT_SECRET || runtime.RAILWAY_OAUTH_CLIENT_SECRET || env.RAILWAY_OAUTH_CLIENT_SECRET;
  const tokenUrl = process.env.RAILWAY_OAUTH_TOKEN_URL || runtime.RAILWAY_OAUTH_TOKEN_URL || env.RAILWAY_OAUTH_TOKEN_URL;
  return {
    ...runtime,
    RAILWAY_API_TOKEN: token,
    RAILWAY_ENVIRONMENT_ID: environmentId,
    RAILWAY_SANDBOX_CHECKPOINT: checkpoint || "",
    RAILWAY_SANDBOX_AUTH_MODE: authMode as typeof runtime.RAILWAY_SANDBOX_AUTH_MODE,
    RAILWAY_OAUTH_REFRESH_TOKEN: refreshToken,
    RAILWAY_OAUTH_CLIENT_ID: clientId,
    RAILWAY_OAUTH_CLIENT_SECRET: clientSecret,
    RAILWAY_OAUTH_TOKEN_URL: tokenUrl,
  };
}

function railwayOAuthTokenProvider(runtime: ReturnType<typeof railwayRuntimeWithProcessOverrides>) {
  return createRailwayOAuthAccessTokenProvider({
    runtime,
    secrets: {
      getRuntimeSecret,
      setRuntimeSecret,
    },
  });
}

function createTrustedRunBroker(signingKey: HermesReceiptSigningKey): HermesRunBroker {
  const runtime = activeRuntime();
  if (!isProductionLike(runtime)) return createFakeHermesRunBroker({ signingKey });

  const runtimeWithProcessOverrides = railwayRuntimeWithProcessOverrides(runtime);
  const authMode = railwaySandboxAuthMode(runtimeWithProcessOverrides);
  const environmentId = runtimeWithProcessOverrides.RAILWAY_ENVIRONMENT_ID;
  const checkpoint = runtimeWithProcessOverrides.RAILWAY_SANDBOX_CHECKPOINT || undefined;
  const issues = railwaySandboxConfigIssues(runtimeWithProcessOverrides);
  if (issues.length > 0) {
    throw new HttpError(503, "Production Agent run cells are not configured.", "agent_run_cells_unavailable", {
      issues,
      manualPasteFallback: agentRunManualPasteFallback,
    });
  }

  return createRailwaySandboxBroker({
    token: authMode === "api_token" ? runtimeWithProcessOverrides.RAILWAY_API_TOKEN : undefined,
    tokenProvider: authMode === "oauth_refresh" ? railwayOAuthTokenProvider(runtimeWithProcessOverrides) : undefined,
    environmentId,
    checkpoint,
  }, signingKey);
}

function assertChallengeEligible(challenge: Awaited<ReturnType<typeof getChallenge>>): asserts challenge is NonNullable<typeof challenge> {
  if (!challenge || !isChallengePubliclyEligible(challenge)) {
    throw new HttpError(404, "Challenge not found.", "not_found");
  }
  if (!acceptingChallengeStatuses.has(challenge.status)) {
    throw new HttpError(409, "Challenge is not accepting trusted Agent runs.", "challenge_not_accepting_agent_runs");
  }
}

function assertApproved(body: CreateAgentRunBody) {
  if (body.approved !== true) {
    throw new HttpError(400, "Run my Agent here requires explicit per-run approval.", "approval_required", {
      manualPasteFallback: agentRunManualPasteFallback,
    });
  }
}

function assertConnectionReady(connection: NonNullable<Awaited<ReturnType<typeof getAgentHomeConnection>>> | undefined, body: CreateAgentRunBody, mode: ContributionMode) {
  if (!connection) throw new HttpError(404, "Agent connection not found.", "agent_connection_not_found");
  const requestedModel = body.requestedModel || connection.defaultModel;
  const issues: string[] = [];
  if (activeProductionLike() && isProductionBlockedAgentConnection(connection)) {
    throw new HttpError(409, "Fake/dev Agent connections cannot run as trusted production evidence.", "agent_connection_provider_not_allowed", {
      provider: connection.provider,
      connectionKind: connection.connectionKind,
      manualPasteFallback: agentRunManualPasteFallback,
    });
  }
  if (connection.status !== "ready") issues.push(`connection status is ${connection.status}`);
  if (!connection.readiness.canRunHere) issues.push(connection.readiness.detail);
  if (connection.lastSmoke.status !== "passed") issues.push("connection smoke test has not passed");
  if (!connection.allowedModels.includes(requestedModel)) issues.push(`model ${requestedModel} is not allowed for this connection`);
  if (!connection.allowedRequestClasses.includes(mode)) issues.push(`mode ${mode} is not allowed for this connection`);
  if (issues.length) {
    throw new HttpError(409, "Agent connection is not ready for Run my Agent here.", "agent_connection_not_ready", {
      issues,
      manualPasteFallback: agentRunManualPasteFallback,
    });
  }
  return { connection, requestedModel };
}

function providerConnectionKindFor(connection: StoreAgentConnection): ProviderAgentConnectionKind {
  return connection.connectionKind === "fake_dev" ? "test_fake" : connection.connectionKind;
}

function metadataEvidenceType(status: ModelProvenanceVerificationStatus, exactModelMetadata: boolean): ModelProvenanceEvidenceType {
  if (exactModelMetadata || status === "metadata_verified") return "provider_metadata";
  return "hermes_run_receipt";
}

function metadataVerificationFor(connection: StoreAgentConnection): AgentConnectionMetadataVerification {
  return {
    providerModelVerified: connection.exactModelMetadata,
    verificationStatus: connection.metadataVerification,
    evidenceType: metadataEvidenceType(connection.metadataVerification, connection.exactModelMetadata),
    notes: connection.sandboxTrustLabel,
  };
}

function providerConnectionFromStore(connection: StoreAgentConnection, credentialRef: string): ProviderAgentConnection {
  const allowedRequestClasses = Array.from(new Set<AgentRequestClass>(["contribution_card", ...connection.allowedRequestClasses]));
  return {
    id: connection.id,
    ownerId: connection.ownerId,
    agentHomeId: connection.agentHomeId,
    provider: connection.provider,
    connectionKind: providerConnectionKindFor(connection),
    displayLabel: connection.displayLabel,
    status: connection.status,
    credentialRef,
    defaultModel: connection.defaultModel,
    allowedModels: [...connection.allowedModels],
    allowedRequestClasses,
    metadataVerification: metadataVerificationFor(connection),
    lastSmoke: {
      status: connection.lastSmoke.status,
      checkedAt: connection.lastSmoke.checkedAt || connection.updatedAt,
      message: connection.lastSmoke.message,
      providerResponseId: undefined,
    },
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

function assertReceiptMatchesDelegation(delegation: AgentConnectionDelegation, context: { runId: string; receipt: HermesRunReceipt }) {
  const delegationId = delegation.delegation_id || delegation.connection_id;
  if (context.receipt.run_id !== context.runId) throw new Error("One-run delegation run id mismatch.");
  if (context.receipt.delegation?.delegation_id && context.receipt.delegation.delegation_id !== delegationId) throw new Error("One-run delegation id mismatch.");
  if (context.receipt.delegation?.connection_id !== delegation.connection_id) throw new Error("One-run delegation connection mismatch.");
  if (context.receipt.delegation?.provider !== delegation.provider) throw new Error("One-run delegation provider mismatch.");
  if (delegation.max_requests !== 1) throw new Error("One-run delegation request count exhausted.");
}

export function runDelegationService(connection: StoreAgentConnection): AgentRunDelegationService {
  const credentialRef = brokerCredentialRef(connection.id);
  const vault = new InMemoryAgentCredentialVault();
  const providerConnection = providerConnectionFromStore(connection, credentialRef);
  const runtime = activeRuntime();
  const modelProxyUrl = process.env.CMAI_MODEL_PROXY_URL || runtime.CMAI_MODEL_PROXY_URL || env.CMAI_MODEL_PROXY_URL || undefined;
  const useLocalFakeAdapter = !activeProductionLike() && (providerConnection.connectionKind === "test_fake" || isFakeOrDevAgentProvider(providerConnection.provider));
  const adapters: AgentProviderAdapter[] = [];
  const initialization: Array<Promise<void>> = [];

  if (useLocalFakeAdapter) {
    initialization.push(vault.putCredential({
      ref: credentialRef,
      provider: connection.provider,
      value: { connection_id: connection.id, provider: connection.provider, local_dev_credential: true },
      createdAt: new Date().toISOString(),
    }));
    adapters.push(createFakeProviderAdapter({ provider: connection.provider, vault, providerModelVerified: connection.exactModelMetadata }));
  }

  if (["openrouter", "anthropic", "openai", "codex", "claude_code"].includes(providerConnection.provider)) {
    initialization.push(getAgentConnectionCredential({ ownerId: connection.ownerId, connectionId: connection.id }).then(async (brokerCredential) => {
      const devApiKey = !activeProductionLike()
        ? providerConnection.provider === "anthropic"
          ? process.env.ANTHROPIC_API_KEY || undefined
          : providerConnection.provider === "openai"
            ? process.env.OPENAI_API_KEY || undefined
          : providerConnection.provider === "codex" || providerConnection.provider === "claude_code"
            ? undefined
            : process.env.OPENROUTER_API_KEY || runtime.OPENROUTER_API_KEY || env.OPENROUTER_API_KEY || undefined
        : undefined;
      const credential = brokerCredential || (devApiKey ? { ref: credentialRef, provider: providerConnection.provider, value: { apiKey: devApiKey }, createdAt: new Date().toISOString() } : undefined);
      if (credential) await vault.putCredential({ ...credential, ref: credentialRef, provider: providerConnection.provider });
    }));
    adapters.push(providerConnection.provider === "anthropic"
      ? createAnthropicProviderAdapter({ vault, modelProxyUrl, registry: activeModelProxyRegistry() })
      : providerConnection.provider === "openai"
        ? createOpenAIProviderAdapter({ vault, modelProxyUrl, registry: activeModelProxyRegistry() })
        : providerConnection.provider === "codex"
          ? createCodexProviderAdapter({ vault, modelProxyUrl, registry: activeModelProxyRegistry() })
          : providerConnection.provider === "claude_code"
            ? createClaudeCodeProviderAdapter({ vault, modelProxyUrl, registry: activeModelProxyRegistry() })
          : createOpenRouterProviderAdapter({ vault, modelProxyUrl, registry: activeModelProxyRegistry() }));
  } else if (!useLocalFakeAdapter) {
    adapters.push(createUnavailableProviderAdapter(providerCatalogEntry(providerConnection.provider)));
  }

  const initialized = Promise.all(initialization).then(() => undefined);
  const service = createAgentDelegationService({
    adapters,
    modelProxyUrl,
  });

  return {
    async mintDelegation(input) {
      await initialized;
      const grant = await service.mintOneRunDelegation(providerConnection, {
        runId: input.runId,
        challengeId: input.challengeId,
        contributorId: input.contributor.id,
        contributionMode: input.contributionMode,
        requestedModel: input.connection.requestedModel,
        requestClass: "contribution_card",
        maxSpendCents: 0,
      });
      return {
        delegation: grant.delegation,
        childRunConfig: grant.childRunConfig,
      };
    },
    async consumeDelegation(delegation, context) {
      assertReceiptMatchesDelegation(delegation, context);
      await service.consumeDelegation(delegation.delegation_id || delegation.connection_id, { runId: context.runId });
    },
    async revokeDelegation(delegation, context) {
      await service.revokeDelegation(delegation.delegation_id || delegation.connection_id, context.reason);
    },
  };
}

async function recordExecutorState(runId: string, event: AgentRunStateEvent) {
  if (event.status === "failed") {
    await updateAgentRun({
      id: runId,
      status: "failed",
      failure: {
        code: event.failureCode || "sandbox_run_failed",
        message: event.failureMessage || "Agent run failed.",
        failedAt: new Date().toISOString(),
      },
    });
    return;
  }
  await updateAgentRun({
    id: runId,
    status: event.status,
    contributionId: event.contributionId,
  });
}

export async function createAgentRunForChallenge(request: Request, challengeId: string, user: CurrentUser) {
  const body = validateBody(createAgentRunBodySchema, await parseJsonBody(request));
  const idempotencyKey = body.idempotencyKey || request.headers.get("idempotency-key")?.trim() || undefined;
  assertApproved(body);
  if (!idempotencyKey) {
    throw new HttpError(400, "Run my Agent here requires an idempotency key so retries cannot double-post.", "idempotency_key_required", {
      manualPasteFallback: agentRunManualPasteFallback,
    });
  }

  const challenge = await getChallenge(challengeId);
  assertChallengeEligible(challenge);
  const mode = body.contributionMode || defaultContributionModeForRequestedModes(challenge.requestedModes);

  if (idempotencyKey) {
    const existing = await findAgentRunByIdempotencyKey({ challengeId, contributorId: user.id, idempotencyKey });
    if (existing) return { run: publicAgentRun(existing), reused: true };
  }

  assertRateLimitPolicy("trusted_agent_run", `user:${user.id}:challenge:${challengeId}`);

  const ready = assertConnectionReady(await getAgentHomeConnection({ ownerId: user.id, connectionId: body.connectionId }), body, mode);
  const signingKey = receiptSigningKey();
  const broker = createTrustedRunBroker(signingKey);
  const reservation = await reserveAgentRun({
    agentHomeId: ready.connection.agentHomeId,
    connectionId: ready.connection.id,
    challengeId,
    contributorId: user.id,
    requestedMode: mode,
    requestedModel: ready.requestedModel,
    provider: ready.connection.provider,
    requestClass: "contribution_card",
    idempotencyKey,
    promptVersion: "agent-run-v1",
  });
  if (reservation.reused) return { run: publicAgentRun(reservation.run), reused: true };
  const { run, job } = reservation;
  if (!job) throw new HttpError(500, "Agent run reservation did not create a job.", "agent_run_reservation_invalid");

  await updateJob({ id: job.id, status: "running" });
  trackEvent("trusted_agent_run_started", {
    challenge_id: challengeId,
    agent_connection_id: ready.connection.id,
    agent_run_id: run.id,
    trusted_readiness_status: ready.connection.readiness.state,
    trusted_lane_available: true,
    manual_paste_available: true,
    trusted_provider: ready.connection.provider,
    trusted_run_status: "running",
    provenance_tier: ready.connection.metadataVerification,
  });
  recordLlmTrace({ traceKind: "trusted_run", status: "skipped", provider: ready.connection.provider, challengeId, agentRunId: run.id });
  const result = await executeAgentRunContribution({
    runId: run.id,
    idempotencyKey,
    challengeId,
    contributor: {
      id: user.id,
      label: ready.connection.displayLabel,
      ownerId: user.id,
    },
    connection: {
      id: ready.connection.id,
      agentConnectionId: ready.connection.id,
      provider: ready.connection.provider,
      requestedModel: ready.requestedModel,
      modelDisplayName: ready.requestedModel,
      providerModelVerified: ready.connection.exactModelMetadata,
      fundingSource: ready.connection.provider === "codex" || ready.connection.provider === "claude_code" ? "external_user_subscription" : "user_provider_access",
    },
    contributionMode: mode,
    broker,
    receiptSigningKey: signingKey,
    delegationService: runDelegationService(ready.connection),
    recordRunState: (event) => recordExecutorState(run.id, event),
  });

  if (result.status === "contributed") {
    const receiptSummary = result.receipt ? receiptSummaryFromReceipt(result.receipt) : undefined;
    const updated = await updateAgentRun({ id: run.id, status: "contributed", contributionId: result.contribution.id, receiptSummary });
    await updateJob({ id: job.id, status: "succeeded", latencyMs: result.receipt?.timing.duration_ms ?? 0, costCents: 0 });
    trackEvent("trusted_agent_run_completed", {
      challenge_id: challengeId,
      contribution_id: result.contribution.id,
      agent_connection_id: ready.connection.id,
      agent_run_id: run.id,
      trusted_readiness_status: ready.connection.readiness.state,
      trusted_lane_available: true,
      manual_paste_available: true,
      trusted_provider: ready.connection.provider,
      trusted_run_status: "contributed",
      provenance_tier: ready.connection.metadataVerification,
    });
    recordLlmTrace({ traceKind: "trusted_run", status: "completed", provider: ready.connection.provider, challengeId, agentRunId: run.id });
    return { run: publicAgentRun(updated), contribution: result.contribution, reused: result.reusedContribution };
  }

  const failed = await updateAgentRun({
    id: run.id,
    status: "failed",
    failure: { code: result.failureCode, message: result.failureMessage, failedAt: new Date().toISOString() },
  });
  await updateJob({ id: job.id, status: "failed", error: result.failureCode });
  trackEvent("trusted_agent_run_failed", {
    challenge_id: challengeId,
    agent_connection_id: ready.connection.id,
    agent_run_id: run.id,
    trusted_readiness_status: ready.connection.readiness.state,
    trusted_lane_available: true,
    manual_paste_available: true,
    trusted_provider: ready.connection.provider,
    trusted_run_status: "failed",
    trusted_failure_code: result.failureCode,
    provenance_tier: ready.connection.metadataVerification,
  });
  recordLlmTrace({ traceKind: "trusted_run", status: "failed", provider: ready.connection.provider, challengeId, agentRunId: run.id, failureCode: result.failureCode });
  return { run: publicAgentRun(failed), reused: false };
}
