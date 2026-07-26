import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { handleApiError, HttpError, parseJsonBody, validateBody } from "@/lib/api/responses";
import { isProductionLike } from "@/lib/config/env";
import { contributionModes } from "@/lib/types";
import { supportedAgentProviders } from "@/lib/agent-home/providerCatalog";
import { createAgentHomeConnection, resolveAgentHome } from "@/lib/store";

export const runtime = "nodejs";

const connectionRequestSchema = z.object({
  provider: z.enum(supportedAgentProviders).default("local_fake"),
  displayLabel: z.string().trim().min(1).max(80).optional(),
  defaultModel: z.string().trim().min(1).max(120).optional(),
  allowedModels: z.array(z.string().trim().min(1).max(120)).min(1).max(20).optional(),
  allowedRequestClasses: z.array(z.enum(contributionModes)).min(1).max(contributionModes.length).optional(),
  providerSecret: z.string().trim().min(1).max(4000).optional(),
}).strict();

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const agentHome = await resolveAgentHome({ ownerId: user.id, ownerLabel: user.name });
    return NextResponse.json({ agentHome, connections: agentHome.connections });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = validateBody(connectionRequestSchema, await parseJsonBody(request));
    if (isProductionLike() && body.provider === "local_fake") {
      throw new HttpError(400, "The local fake Agent provider is not available in production.", "local_fake_provider_not_allowed");
    }
    if (body.provider === "codex") {
      throw new HttpError(409, "Use Connect Codex to complete the official ChatGPT device-login flow.", "codex_device_login_required");
    }
    if (body.provider === "claude_code") {
      throw new HttpError(409, "Use Connect Claude Code to complete the official managed login flow.", "claude_code_login_required");
    }
    const result = await createAgentHomeConnection({ ownerId: user.id, ownerLabel: user.name, ...body });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
