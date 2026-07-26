import { NextResponse } from "next/server";
import { trackEvent } from "@/lib/analytics/events";
import { requireUser } from "@/lib/auth";
import { handleApiError } from "@/lib/api/responses";
import { isProductionLike, trustedAgentRunConfigIssues } from "@/lib/config/env";
import { isProductionBlockedAgentConnection } from "@/lib/agent-home/connectionPolicy";
import { resolveAgentHome } from "@/lib/store";

export const runtime = "nodejs";

function agentHomeReadinessMessage(
  agentHome: Awaited<ReturnType<typeof resolveAgentHome>>,
  readyConnections: Awaited<ReturnType<typeof resolveAgentHome>>["connections"],
  options: { productionMode: boolean; trustedRunConfigIssues: string[] },
) {
  if (readyConnections.length > 0) return "Agent Home is ready for one approved Run my Agent here sandbox run. Each challenge still requires fresh approval.";
  if (options.trustedRunConfigIssues.length > 0) return "Agent Home has connection state, but production broker, receipt signing, model proxy, or sandbox run cells are not configured yet. Manual paste remains available.";
  if (agentHome.connections.length === 0) return "Agent Home needs a provider connection and passing smoke test before Run my Agent here is available. Manual paste remains available.";
  if (options.productionMode && agentHome.connections.some(isProductionBlockedAgentConnection)) return "Persisted local/dev Agent connections are ignored in production. Use manual paste until a provider-backed Agent Home connection is ready.";
  if (agentHome.connections.some((connection) => connection.status === "ready" && !connection.countsForMvpUserPlan)) return "API-only provider setup is saved and may have passed broker smoke, but normal-user plan auth is still missing. Manual paste remains available.";
  if (agentHome.connections.some((connection) => !connection.liveModelProxyCaller || connection.readiness.label === "Provider adapter pending")) return "One or more provider setups are saved, but their broker adapter or compliance path is not live yet. Manual paste remains available.";
  if (agentHome.connections.some((connection) => connection.status === "paused")) return "A connection is paused. Resume it and pass a smoke test before Run my Agent here is available; manual paste still works.";
  if (agentHome.connections.some((connection) => connection.status === "revoked" || connection.status === "needs_reconnect" || connection.status === "expired")) return "A connection needs fresh provider access before it can run. Reconnect and smoke-test it, or use manual paste.";
  if (agentHome.connections.some((connection) => connection.status === "smoke_failed")) return "The latest Agent Home smoke test failed. Fix setup or use manual paste while the trusted lane is unavailable.";
  return "Agent Home has setup state, but no connection has passed a usable smoke test yet. Manual paste remains available.";
}

export function agentHomePayload(agentHome: Awaited<ReturnType<typeof resolveAgentHome>>, options: { productionMode?: boolean; trustedRunConfigIssues?: string[] } = {}) {
  const productionMode = options.productionMode ?? isProductionLike();
  const trustedRunConfigIssues = options.trustedRunConfigIssues ?? (productionMode ? trustedAgentRunConfigIssues() : []);
  const readyConnections = agentHome.connections.filter((connection) => connection.readiness.canRunHere && !(productionMode && isProductionBlockedAgentConnection(connection)) && trustedRunConfigIssues.length === 0);
  const readyConnection = readyConnections[0];
  const readinessMessage = agentHomeReadinessMessage(agentHome, readyConnections, { productionMode, trustedRunConfigIssues });
  return {
    agentHome,
    readyConnection: readyConnection ? {
      id: readyConnection.id,
      status: readyConnection.status,
      providerLabel: readyConnection.providerLabel,
      modelLabel: readyConnection.defaultModel,
      trustLabel: readyConnection.sandboxTrustLabel,
      authClass: readyConnection.authClass,
      countsForMvpUserPlan: readyConnection.countsForMvpUserPlan,
    } : null,
    readiness: {
      status: readyConnections.length > 0 ? "ready" : "setup_required",
      message: readinessMessage,
      issues: trustedRunConfigIssues,
      readyConnectionCount: readyConnections.length,
      canRunHere: readyConnections.length > 0,
      manualPasteFallback: "Copy prompt → paste local output remains available even when Agent Home setup is incomplete.",
    },
  };
}

export async function GET(request: Request) {
  try {
    const user = await requireUser(request);
    const agentHome = await resolveAgentHome({ ownerId: user.id, ownerLabel: user.name });
    const payload = agentHomePayload(agentHome);
    trackEvent("agent_home_readiness_checked", {
      trusted_readiness_status: payload.readiness.status,
      trusted_lane_available: payload.readiness.canRunHere,
      manual_paste_available: true,
      trusted_provider: payload.readyConnection?.providerLabel || "not_configured",
    });
    return NextResponse.json(payload);
  } catch (error) {
    return handleApiError(error, { surface: "api/agent-home" });
  }
}
