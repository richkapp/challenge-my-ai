import { NextResponse } from "next/server";
import { agentProtocolBodyLimits } from "@/lib/agent-protocol/constants";
import { parseAgentProtocolJson } from "@/lib/agent-protocol/parse";
import { agentPairCreateRequestSchema } from "@/lib/agent-protocol/schemas";
import { requireUser } from "@/lib/auth";
import {
  agentProtocolSuccess,
  forbidPairingCodeInQuery,
  handlePairingRouteError,
  pairingRequestIdentity,
  readBoundedRequestText,
} from "@/lib/agent-pairing/http";
import { platformPairingService } from "@/lib/agent-pairing/runtime";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    forbidPairingCodeInQuery(request);
    const user = await requireUser(request);
    return NextResponse.json(await platformPairingService().listOwnerPairings(user.id), {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return handlePairingRouteError(error, { surface: "agent_pairing_list" });
  }
}

export async function POST(request: Request) {
  let requestId: string | undefined;
  try {
    const service = platformPairingService();
    const networkIdentity = pairingRequestIdentity(request);
    await service.assertPairingNetworkRateLimit({ identity: networkIdentity });
    const raw = await readBoundedRequestText(request, agentProtocolBodyLimits["pair.create"]);
    const envelope = parseAgentProtocolJson("pair.create", raw, agentPairCreateRequestSchema);
    requestId = envelope.request_id;
    const pairing = await service.redeemPairing(envelope, {
      rateLimitKey: networkIdentity,
    });
    return agentProtocolSuccess(requestId, { pairing }, 201);
  } catch (error) {
    return handlePairingRouteError(error, { requestId, protocol: true, surface: "agent_pairing_create" });
  }
}
