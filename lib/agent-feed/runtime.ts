import { createHash } from "node:crypto";
import { AgentProtocolError } from "@/lib/agent-protocol/errors";
import { agentFeedTelemetrySinkFromEnvironment } from "@/lib/agent-feed/telemetry";
import { AgentFeedProtocolService } from "@/lib/agent-feed/service";
import { platformPairingService } from "@/lib/agent-pairing/runtime";
import { env, isProductionLike } from "@/lib/config/env";
import { submitAgentFeedContribution, transactAgentFeedRequest } from "@/lib/store";

let overrideService: AgentFeedProtocolService | undefined;
let platformService: AgentFeedProtocolService | undefined;

function cursorSecret(): string {
  const source = env.CMAI_AGENT_API_SECRET || (!isProductionLike(env) ? "cmai-local-agent-feed-development-secret" : "");
  if (!source) {
    throw new AgentProtocolError(
      "service_unavailable",
      "Agent feed service is temporarily unavailable.",
      503,
      true,
      undefined,
      1,
    );
  }
  return createHash("sha256")
    .update("CMAI_AGENT_FEED_CURSOR_V1\0", "utf8")
    .update(source, "utf8")
    .digest("base64url");
}

export function platformAgentFeedProtocolService(): AgentFeedProtocolService {
  if (overrideService) return overrideService;
  platformService ??= new AgentFeedProtocolService({
    pairingService: platformPairingService(),
    store: { transactAgentFeedRequest, submitAgentFeedContribution },
    cursorSecret: cursorSecret(),
    telemetry: agentFeedTelemetrySinkFromEnvironment(process.env),
  });
  return platformService;
}

export function setPlatformAgentFeedProtocolServiceForTests(service?: AgentFeedProtocolService): void {
  overrideService = service;
}
