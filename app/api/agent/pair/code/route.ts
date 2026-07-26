import { NextResponse } from "next/server";
import { z } from "zod";
import { agentRuntimeKinds } from "@/lib/agent-protocol/constants";
import { requireUser } from "@/lib/auth";
import { parseJsonBody, validateBody } from "@/lib/api/responses";
import { handlePairingRouteError } from "@/lib/agent-pairing/http";
import { platformPairingService } from "@/lib/agent-pairing/runtime";

export const runtime = "nodejs";

const pairingCodeRequestSchema = z.object({
  runtime: z.enum(agentRuntimeKinds),
  display_name: z.string().min(1).max(80),
}).strict();

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = validateBody(pairingCodeRequestSchema, await parseJsonBody(request, { maxBytes: 2_048 }));
    const result = await platformPairingService().issuePairingCode({
      ownerId: user.id,
      runtime: body.runtime,
      displayName: body.display_name,
      rateLimitKey: user.id,
    });
    return NextResponse.json(result, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handlePairingRouteError(error, { surface: "agent_pairing_code" });
  }
}
