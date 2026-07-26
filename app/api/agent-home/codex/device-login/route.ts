import { NextResponse } from "next/server";
import { z } from "zod";
import { nanoid } from "nanoid";
import { HttpError, parseJsonBody, validateBody } from "@/lib/api/responses";
import { requireUser } from "@/lib/auth";
import { CodexCliError, codexDeviceLoginProductionTimeoutMs, runCodexDeviceLogin, type CodexDeviceLoginEvent } from "@/lib/agent-home/codexCli";
import { serializeCodexAuthCache } from "@/lib/agent-home/codexSession";
import { acquireCodexLoginLease, createAgentHomeConnection, getAgentHomeConnection, recordAgentConnectionSmoke, releaseCodexLoginLease, resolveAgentHome, updateAgentHomeConnection } from "@/lib/store";
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
  if (error instanceof CodexCliError) return { code: error.code.toLowerCase(), message: error.message };
  return { code: "codex_device_login_failed", message: "Codex device login could not be completed." };
}

function assertCodexSameOrigin(request: Request): void {
  try {
    assertSameOrigin(request);
  } catch (error) {
    if (error instanceof HttpError && error.code === "origin_mismatch") {
      throw new HttpError(403, "Cross-origin Codex login is not allowed.", "codex_login_origin_invalid");
    }
    throw error;
  }
}

export async function POST(request: Request) {
  let lease: { ownerId: string; leaseId: string } | undefined;
  const releaseLease = async () => {
    const current = lease;
    if (!current) return;
    lease = undefined;
    await releaseCodexLoginLease(current);
  };
  try {
    assertCodexSameOrigin(request);
    const user = await requireUser(request);
    const body = validateBody(requestSchema, await parseJsonBody(request));
    const leaseId = nanoid(16);
    const acquired = await acquireCodexLoginLease({
      ownerId: user.id,
      leaseId,
      expiresAt: new Date(Date.now() + maxDuration * 1_000).toISOString(),
    });
    if (!acquired) throw new HttpError(409, "A Codex login is already active for this account.", "codex_login_already_active");
    lease = { ownerId: user.id, leaseId };

    let targetConnectionId = body.connectionId;
    if (targetConnectionId) {
      const connection = await getAgentHomeConnection({ ownerId: user.id, connectionId: targetConnectionId });
      if (!connection || connection.provider !== "codex") throw new HttpError(404, "Codex connection not found.", "codex_connection_not_found");
    } else {
      const home = await resolveAgentHome({ ownerId: user.id, ownerLabel: user.name });
      targetConnectionId = home.connections.find((connection) => connection.provider === "codex" && connection.status !== "revoked")?.id;
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
          const login = await runCodexDeviceLogin({
            signal: controller.signal,
            onEvent: async (event: CodexDeviceLoginEvent) => emit(event),
            timeoutMs: codexDeviceLoginProductionTimeoutMs,
          });
          const providerSecret = serializeCodexAuthCache(login.authCache);
          const saved = targetConnectionId
            ? await updateAgentHomeConnection({ ownerId: user.id, connectionId: targetConnectionId, action: "reconnect", providerSecret })
            : await createAgentHomeConnection({
                ownerId: user.id,
                ownerLabel: user.name,
                displayLabel: body.displayLabel || "My Codex Agent",
                provider: "codex",
                providerSecret,
              });
          const ready = await recordAgentConnectionSmoke({
            ownerId: user.id,
            connectionId: saved.connection.id,
            ok: true,
            message: "Codex ChatGPT device login completed and managed auth is ready.",
            redacted: true,
          });
          emit({ type: "ready", connection: ready.connection, agentHome: ready.agentHome });
        } catch (error) {
          emit({ type: "error", ...publicError(error) });
        } finally {
          await releaseLease();
          if (!streamClosed) {
            streamClosed = true;
            try {
              streamController.close();
            } catch {
              // The browser may have cancelled between the final emit and close.
            }
          }
        }
      },
      cancel() {
        streamClosed = true;
        controller.abort();
        void releaseLease();
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
    await releaseLease();
    if (error instanceof HttpError) {
      return NextResponse.json({ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) }, { status: error.status });
    }
    return NextResponse.json({ error: "Codex device login could not start.", code: "codex_device_login_failed" }, { status: 500 });
  }
}
