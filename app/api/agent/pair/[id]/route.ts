import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { parseJsonBody, validateBody } from "@/lib/api/responses";
import { handlePairingRouteError } from "@/lib/agent-pairing/http";
import { platformPairingService } from "@/lib/agent-pairing/runtime";

export const runtime = "nodejs";

const renamePairingSchema = z.object({ display_name: z.string().min(1).max(80) }).strict();

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const body = validateBody(renamePairingSchema, await parseJsonBody(request, { maxBytes: 2_048 }));
    const pairing = await platformPairingService().renamePairing({
      ownerId: user.id,
      pairingId: id,
      displayName: body.display_name,
    });
    return NextResponse.json({ pairing }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handlePairingRouteError(error, { surface: "agent_pairing_rename" });
  }
}
