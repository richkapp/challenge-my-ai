import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handleApiError, HttpError, parseJsonBody, validateBody } from "@/lib/api/responses";
import { getAgentHomeConnection, updateAgentHomeConnection } from "@/lib/store";

export const runtime = "nodejs";

const connectionActionSchema = z.object({
  action: z.enum(["pause", "resume", "rotate", "reconnect", "revoke"]),
  providerSecret: z.string().trim().min(1).max(4000).optional(),
}).strict();

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const body = validateBody(connectionActionSchema, await parseJsonBody(request));
    const connection = await getAgentHomeConnection({ ownerId: user.id, connectionId: id });
    if (!connection) throw new HttpError(404, "Agent connection not found.", "agent_connection_not_found");
    if ((body.action === "rotate" || body.action === "reconnect") && (connection.provider === "codex" || connection.provider === "claude_code")) {
      throw new HttpError(409, connection.provider === "codex" ? "Use Reconnect Codex to complete the official managed login flow." : "Use Reconnect Claude Code to complete the official managed login flow.", connection.provider === "codex" ? "codex_device_login_required" : "claude_code_login_required");
    }
    if ((body.action === "rotate" || body.action === "reconnect") && !body.providerSecret) {
      throw new HttpError(400, "Provider access is required to rotate or reconnect this Agent connection.", "provider_secret_required");
    }
    const result = await updateAgentHomeConnection({ ownerId: user.id, connectionId: id, action: body.action, providerSecret: body.providerSecret });
    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
