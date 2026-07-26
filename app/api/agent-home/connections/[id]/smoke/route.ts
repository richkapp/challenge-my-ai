import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handleApiError, HttpError, parseJsonBody, validateBody } from "@/lib/api/responses";
import { env, isProductionLike, loadEnv } from "@/lib/config/env";
import { redactSecretLikeText } from "@/lib/agent-home/brokerVault";
import { providerCatalogEntry } from "@/lib/agent-home/providerCatalog";
import { createOpenRouterProviderAdapter } from "@/lib/agent-home/openrouterAdapter";
import { createAnthropicProviderAdapter } from "@/lib/agent-home/anthropicAdapter";
import { createOpenAIProviderAdapter } from "@/lib/agent-home/openaiAdapter";
import { createCodexProviderAdapter } from "@/lib/agent-home/codexAdapter";
import { createClaudeCodeProviderAdapter } from "@/lib/agent-home/claudeCodeAdapter";
import { createUnavailableProviderAdapter } from "@/lib/agent-home/genericProviderAdapter";
import { InMemoryAgentCredentialVault } from "@/lib/agent-home/testAdapters";
import type { AgentConnection as ProviderAgentConnection } from "@/lib/agent-home/providerAdapters";
import { getAgentConnectionCredential, getAgentHomeConnection, recordAgentConnectionSmoke } from "@/lib/store";

export const runtime = "nodejs";

const smokeRequestSchema = z.object({
  simulateFailure: z.boolean().optional(),
  failureMessage: z.string().max(500).optional(),
}).strict();

function providerConnectionFromStore(connection: NonNullable<Awaited<ReturnType<typeof getAgentHomeConnection>>>): ProviderAgentConnection {
  return {
    id: connection.id,
    ownerId: connection.ownerId,
    agentHomeId: connection.agentHomeId,
    provider: connection.provider,
    connectionKind: connection.connectionKind === "fake_dev" ? "test_fake" : connection.connectionKind,
    displayLabel: connection.displayLabel,
    status: connection.status === "revoked" ? "needs_reconnect" : connection.status,
    credentialRef: `cred_${connection.id}`,
    defaultModel: connection.defaultModel,
    allowedModels: [...connection.allowedModels],
    allowedRequestClasses: ["contribution_card", ...connection.allowedRequestClasses],
    metadataVerification: {
      providerModelVerified: connection.exactModelMetadata,
      verificationStatus: connection.metadataVerification,
      notes: connection.sandboxTrustLabel,
    },
    lastSmoke: {
      status: connection.lastSmoke.status,
      checkedAt: connection.lastSmoke.checkedAt || connection.updatedAt,
      message: connection.lastSmoke.message,
    },
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const body = validateBody(smokeRequestSchema, await parseJsonBody(request));
    const connection = await getAgentHomeConnection({ ownerId: user.id, connectionId: id });
    if (!connection) throw new HttpError(404, "Agent connection not found.", "agent_connection_not_found");
    if (connection.status === "revoked") {
      throw new HttpError(409, "This Agent connection was revoked. Reconnect provider access before smoke testing.", "agent_connection_revoked");
    }

    let ok = false;
    let rawMessage = "Smoke test did not run.";
    let failureCode: string | undefined;

    if (!isProductionLike() && body.simulateFailure) {
      rawMessage = body.failureMessage || "Smoke test failed before the provider returned a safe marker.";
      failureCode = "smoke_failed";
    } else if (providerCatalogEntry(connection.provider).id === "local_fake") {
      if (isProductionLike()) throw new HttpError(400, "The local fake Agent provider is not available in production.", "local_fake_provider_not_allowed");
      ok = true;
      rawMessage = "Smoke test passed. The child run path can request one approved sandbox run without raw credentials.";
    } else {
      const vault = new InMemoryAgentCredentialVault();
      const credential = await getAgentConnectionCredential({ ownerId: user.id, connectionId: connection.id });
      if (credential) await vault.putCredential({ ...credential, ref: `cred_${connection.id}`, provider: connection.provider });
      const runtime = loadEnv(process.env);
      const modelProxyUrl = process.env.CMAI_MODEL_PROXY_URL || runtime.CMAI_MODEL_PROXY_URL || env.CMAI_MODEL_PROXY_URL || undefined;
      const entry = providerCatalogEntry(connection.provider);
      const adapter = connection.provider === "openrouter"
        ? createOpenRouterProviderAdapter({ vault, modelProxyUrl })
        : connection.provider === "anthropic"
          ? createAnthropicProviderAdapter({ vault, modelProxyUrl })
          : connection.provider === "openai"
            ? createOpenAIProviderAdapter({ vault, modelProxyUrl })
          : connection.provider === "codex"
            ? createCodexProviderAdapter({ vault, modelProxyUrl })
            : connection.provider === "claude_code"
              ? createClaudeCodeProviderAdapter({ vault, modelProxyUrl })
            : createUnavailableProviderAdapter(entry);
      const smoke = await adapter.smokeTest(providerConnectionFromStore(connection));
      ok = smoke.status === "passed";
      rawMessage = smoke.message || (ok ? `${entry.label} smoke test passed.` : `${entry.label} smoke test failed.`);
      failureCode = ok ? undefined : "smoke_failed";
    }

    const { text, redacted } = redactSecretLikeText(rawMessage);
    const result = await recordAgentConnectionSmoke({
      ownerId: user.id,
      connectionId: id,
      ok,
      message: text,
      failureCode,
      redacted,
    });
    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
