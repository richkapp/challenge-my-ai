import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { parseJsonBody, validateBody } from "@/lib/api/responses";
import { handlePairingRouteError } from "@/lib/agent-pairing/http";
import { platformPairingService } from "@/lib/agent-pairing/runtime";

export const runtime = "nodejs";

const ownerRevokeSchema = z.object({
  reason: z.enum(["user_requested", "device_lost", "suspected_compromise"]).default("user_requested"),
}).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const body = validateBody(ownerRevokeSchema, await parseJsonBody(request, { maxBytes: 2_048 }));
    const pairing = await platformPairingService().revokeByOwner({
      ownerId: user.id,
      pairingId: id,
      reason: body.reason,
    });
    return NextResponse.json({ pairing }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handlePairingRouteError(error, { surface: "agent_pairing_owner_revoke" });
  }
}
