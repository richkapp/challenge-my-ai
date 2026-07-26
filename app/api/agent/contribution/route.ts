import { NextResponse } from "next/server";
import { agentProtocolBodyLimits } from "@/lib/agent-protocol/constants";
import { AgentProtocolError } from "@/lib/agent-protocol/errors";
import { assertSupportedAgentProtocol, parseAgentProtocolJson } from "@/lib/agent-protocol/parse";
import { agentContributionSubmitRequestSchema } from "@/lib/agent-protocol/schemas";
import {
  agentProtocolNetworkIdentity,
  handlePairingRouteError,
  readBoundedRequestText,
} from "@/lib/agent-pairing/http";
import { platformAgentFeedProtocolService } from "@/lib/agent-feed/runtime";
import { agentContributionSubmitResponseStatus } from "@/lib/agent-feed/service";

export const runtime = "nodejs";

function extractSafeRequestId(raw: string): string | undefined {
  try {
    const candidate = JSON.parse(raw) as unknown;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
    const requestId = (candidate as Record<string, unknown>).request_id;
    return typeof requestId === "string"
      && requestId.length <= 128
      && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(requestId)
      ? requestId
      : undefined;
  } catch {
    return undefined;
  }
}

export async function POST(request: Request) {
  let requestId: string | undefined;
  try {
    const service = platformAgentFeedProtocolService();
    const networkIdentity = agentProtocolNetworkIdentity(request);
    await service.assertPreAuthNetworkRateLimit(networkIdentity);
    const raw = await readBoundedRequestText(request, agentProtocolBodyLimits["contribution.submit"]);
    requestId = extractSafeRequestId(raw);
    let candidate: unknown;
    try {
      candidate = JSON.parse(raw);
    } catch {
      throw new AgentProtocolError("malformed_request", "Request body must be valid JSON.", 400, false, "$");
    }
    if (!candidate || typeof candidate !== "object") {
      throw new AgentProtocolError("malformed_request", "Request body failed strict validation.", 400, false, "$");
    }
    assertSupportedAgentProtocol(candidate);
    if ((candidate as Record<string, unknown>).operation !== "contribution.submit") {
      throw new AgentProtocolError("malformed_request", "This endpoint supports only contribution.submit.", 400, false, "$.operation");
    }
    const envelope = parseAgentProtocolJson("contribution.submit", raw, agentContributionSubmitRequestSchema);
    const response = await service.executeSubmission(
      envelope,
      networkIdentity,
      { networkRateLimitPrecharged: true },
    );
    const headers: Record<string, string> = { "cache-control": "no-store" };
    return NextResponse.json(response, { status: agentContributionSubmitResponseStatus(response), headers });
  } catch (error) {
    return handlePairingRouteError(error, {
      requestId,
      protocol: true,
      surface: "agent_contribution_protocol",
    });
  }
}
