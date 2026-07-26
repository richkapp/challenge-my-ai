import { NextResponse } from "next/server";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { nanoid } from "nanoid";
import { HttpError, parseJsonBody, validateBody } from "@/lib/api/responses";
import { requireUser } from "@/lib/auth";
import { ClaudeCodeCliError, claudeCodeLoginProductionTimeoutMs, runClaudeCodeLogin, type ClaudeCodeLoginEvent } from "@/lib/agent-home/claudeCodeCli";
import { serializeClaudeCodeCredential } from "@/lib/agent-home/claudeCodeSession";
import { smokeClaudeCodeManagedAuth } from "@/lib/agent-home/claudeCodeAdapter";
import { env, loadEnv } from "@/lib/config/env";
import { beginClaudeCodeLoginAttempt, createAgentHomeConnection, getAgentHomeConnection, recordAgentConnectionSmoke, releaseClaudeCodeLoginAttempt, resolveAgentHome, takeClaudeCodeLoginCode, updateAgentHomeConnection } from "@/lib/store";
import { assertSameOrigin } from "@/lib/security/origin";

export const runtime = "nodejs";
export const maxDuration = 300;

const requestSchema = z.object({
  connectionId: z.string().trim().min(1).max(120).optional(),
  displayLabel: z.string().trim().min(1).max(80).optional(),
}).strict();

const encoder = new TextEncoder();

function eventLine(event: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(event)}\n`);
}

function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof ClaudeCodeCliError) return { code: error.code.toLowerCase(), message: error.message };
  return { code: "claude_code_login_failed", message: "Claude Code login could not be completed." };
}

function assertClaudeSameOrigin(request: Request): void {
  try {
    assertSameOrigin(request);
  } catch (error) {
    if (error instanceof HttpError && error.code === "origin_mismatch") {
      throw new HttpError(403, "Cross-origin Claude Code login is not allowed.", "claude_code_login_origin_invalid");
    }
    throw error;
  }
}

async function waitForAuthorizationCode(input: { ownerId: string; attemptId: string; signal: AbortSignal }): Promise<string> {
  while (!input.signal.aborted) {
    const code = await takeClaudeCodeLoginCode({ ownerId: input.ownerId, attemptId: input.attemptId });
    if (code) return code;
    try {
      await delay(500, undefined, { signal: input.signal, ref: false });
    } catch {
      break;
    }
  }
  throw new ClaudeCodeCliError("CLAUDE_CODE_LOGIN_CANCELLED", "Claude Code login was cancelled.", 499);
}

export async function POST(request: Request) {
  let attempt: { ownerId: string; attemptId: string } | undefined;
  const releaseAttempt = async () => {
    const current = attempt;
    if (!current) return;
    attempt = undefined;
    await releaseClaudeCodeLoginAttempt(current);
  };

  try {
    assertClaudeSameOrigin(request);
    const user = await requireUser(request);
    const body = validateBody(requestSchema, await parseJsonBody(request));
    const attemptId = nanoid(20);
    const acquired = await beginClaudeCodeLoginAttempt({
      ownerId: user.id,
      attemptId,
      expiresAt: new Date(Date.now() + maxDuration * 1_000).toISOString(),
    });
    if (!acquired) throw new HttpError(409, "A Claude Code login is already active for this account.", "claude_code_login_already_active");
    attempt = { ownerId: user.id, attemptId };

    let targetConnectionId = body.connectionId;
    if (targetConnectionId) {
      const connection = await getAgentHomeConnection({ ownerId: user.id, connectionId: targetConnectionId });
      if (!connection || connection.provider !== "claude_code") throw new HttpError(404, "Claude Code connection not found.", "claude_code_connection_not_found");
    } else {
      const home = await resolveAgentHome({ ownerId: user.id, ownerLabel: user.name });
      targetConnectionId = home.connections.find((connection) => connection.provider === "claude_code" && connection.status !== "revoked")?.id;
    }

    const controller = new AbortController();
    request.signal.addEventListener("abort", () => controller.abort(), { once: true });
    let streamClosed = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(streamController) {
        const emit = (event: unknown) => {
          if (streamClosed || controller.signal.aborted) return;
          try {
            streamController.enqueue(eventLine(event));
          } catch {
            streamClosed = true;
            controller.abort();
          }
        };
        try {
          const login = await runClaudeCodeLogin({
            signal: controller.signal,
            timeoutMs: claudeCodeLoginProductionTimeoutMs,
            onEvent: async (event: ClaudeCodeLoginEvent) => emit({ ...event, attemptId }),
            getAuthorizationCode: () => waitForAuthorizationCode({ ownerId: user.id, attemptId, signal: controller.signal }),
          });
          const providerSecret = serializeClaudeCodeCredential(login.credential);
          const saved = targetConnectionId
            ? await updateAgentHomeConnection({ ownerId: user.id, connectionId: targetConnectionId, action: "reconnect", providerSecret })
            : await createAgentHomeConnection({
                ownerId: user.id,
                ownerLabel: user.name,
                displayLabel: body.displayLabel || "My Claude Code Agent",
                provider: "claude_code",
                providerSecret,
              });
          const runtime = loadEnv(process.env);
          const smoke = await smokeClaudeCodeManagedAuth({
            credential: login.credential,
            modelProxyUrl: process.env.CMAI_MODEL_PROXY_URL || runtime.CMAI_MODEL_PROXY_URL || env.CMAI_MODEL_PROXY_URL || undefined,
          });
          const ready = await recordAgentConnectionSmoke({
            ownerId: user.id,
            connectionId: saved.connection.id,
            ok: smoke.status === "passed",
            message: smoke.message,
            failureCode: smoke.status === "passed" ? undefined : "smoke_failed",
            redacted: true,
          });
          emit({ type: "ready", connection: ready.connection, agentHome: ready.agentHome });
        } catch (error) {
          emit({ type: "error", ...publicError(error) });
        } finally {
          controller.abort();
          await releaseAttempt();
          if (!streamClosed) {
            streamClosed = true;
            try {
              streamController.close();
            } catch {
              // The browser may cancel between the final event and close.
            }
          }
        }
      },
      cancel() {
        streamClosed = true;
        controller.abort();
        void releaseAttempt();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store, max-age=0",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    await releaseAttempt();
    if (error instanceof HttpError) {
      return NextResponse.json({ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) }, { status: error.status });
    }
    return NextResponse.json({ error: "Claude Code login could not start.", code: "claude_code_login_failed" }, { status: 500 });
  }
}
