import { agentProtocolBodyLimits } from "@/lib/agent-protocol/constants";
import { parseAgentProtocolJson } from "@/lib/agent-protocol/parse";
import { agentPairingRotateKeyRequestSchema } from "@/lib/agent-protocol/schemas";
import { agentProtocolSuccess, handlePairingRouteError, pairingRequestIdentity, readBoundedRequestText } from "@/lib/agent-pairing/http";
import { platformPairingService } from "@/lib/agent-pairing/runtime";

export const runtime = "nodejs";

export async function POST(request: Request) {
  let requestId: string | undefined;
  try {
    const service = platformPairingService();
    const networkIdentity = pairingRequestIdentity(request);
    await service.assertPairingNetworkRateLimit({ identity: networkIdentity });
    const raw = await readBoundedRequestText(request, agentProtocolBodyLimits["pairing.rotate_key"]);
    const envelope = parseAgentProtocolJson("pairing.rotate_key", raw, agentPairingRotateKeyRequestSchema);
    requestId = envelope.request_id;
    const pairing = await service.rotateKey(envelope);
    return agentProtocolSuccess(requestId, { pairing });
  } catch (error) {
    return handlePairingRouteError(error, { requestId, protocol: true, surface: "agent_pairing_rotate" });
  }
}
