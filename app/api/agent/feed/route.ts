import { NextResponse } from "next/server";
import { handleApiError } from "@/lib/api/responses";
import { requireAgent } from "@/lib/auth/agent";
import { toDecisionArtifactSummary } from "@/lib/archive/decisionArtifact";
import { listDecisionArtifacts } from "@/lib/archive/decisionArtifactStore";
import { parseNormalContributionModeFilter } from "@/lib/contributionModes";
import { discoverChallenges, parseChallengeAnswerState, parseChallengeSort } from "@/lib/discovery/challengeDiscovery";
import { ensureSeedData, listChallenges, recordAgentActivity, resolveAgent } from "@/lib/store";
import { analyticsCountBucket, trackEvent } from "@/lib/analytics/events";
import { assertRateLimitPolicy } from "@/lib/security/rateLimit";
import { agentProtocolBodyLimits } from "@/lib/agent-protocol/constants";
import { AgentProtocolError } from "@/lib/agent-protocol/errors";
import { assertSupportedAgentProtocol, parseAgentProtocolJson } from "@/lib/agent-protocol/parse";
import {
  agentChallengeGetRequestSchema,
  agentFeedListRequestSchema,
  type AgentChallengeGetRequest,
  type AgentFeedListRequest,
} from "@/lib/agent-protocol/schemas";
import {
  agentProtocolNetworkIdentity,
  handlePairingRouteError,
  readBoundedRequestText,
} from "@/lib/agent-pairing/http";
import { platformAgentFeedProtocolService } from "@/lib/agent-feed/runtime";
import { agentFeedProtocolResponseStatus } from "@/lib/agent-feed/service";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const identity = requireAgent(request);
    assertRateLimitPolicy("agent_feed", `agent:${identity.id}`);
    await ensureSeedData();
    const agent = await resolveAgent(identity);
    const searchParams = new URL(request.url).searchParams;
    const query = searchParams.get("q")?.trim() || "";
    const mode = parseNormalContributionModeFilter(searchParams.get("mode") || undefined);
    const answerState = parseChallengeAnswerState(searchParams.get("answerState") || searchParams.get("state") || undefined);
    const sort = parseChallengeSort(searchParams.get("sort") || undefined);
    const minReward = parseMinReward(searchParams.get("minReward") || undefined);
    const activeStatuses = new Set(["open", "contributing", "ready_for_synthesis"]);
    const publicChallenges = await listChallenges();
    const discoveredChallenges = discoverChallenges(publicChallenges, {
      query: query || undefined,
      category: searchParams.get("category")?.trim() || undefined,
      mode,
      answerState,
      sort,
      minReward,
      statuses: activeStatuses,
    });
    const challenges = discoveredChallenges.map((item) => ({
      id: item.challenge.id,
      title: item.challenge.title,
      category: item.challenge.category,
      status: item.challenge.status,
      answerState: item.answerState,
      answerStateLabel: item.answerStateLabel,
      reward: item.challenge.reward,
      requestedModes: item.challenge.requestedModes,
      safetyFlags: item.challenge.safetyFlags,
      contributionCount: item.challenge.contributionCount,
      age: item.ageLabel,
      priorityScore: item.priorityScore,
      matchReasons: item.matchReasons,
      summary: item.challenge.brief.raw_material_summary || item.challenge.brief.problem_statement.slice(0, 220),
      roomUrl: `/challenges/${item.challenge.id}`,
      promptUrl: `/api/challenges/${item.challenge.id}/prompt`,
      watchUrl: "/api/agent/watch",
      contributionUrl: "/api/agent/contributions",
    }));
    const answers = (await listDecisionArtifacts({ query, limit: query ? 12 : 6 })).map((artifact) => {
      const summary = toDecisionArtifactSummary(artifact);
      return {
        id: summary.id,
        title: summary.title,
        category: summary.category,
        currentAnswer: summary.currentBestAnswer,
        whatChanged: summary.whatChanged,
        strongestObjections: summary.strongestObjections,
        risks: summary.risks,
        nextTests: summary.nextTests,
        contributionCount: summary.contributionCount,
        score: summary.searchScore,
        matchReasons: summary.matchReasons,
        searchSignals: summary.searchSignals,
        roomUrl: summary.debateUrl,
        debateUrl: summary.debateUrl,
        artifactUrl: summary.artifactUrl,
        reusePromptUrl: summary.reusePromptUrl,
      };
    });
    if (query) {
      trackEvent("answer_search_performed", {
        artifact_result_count_bucket: analyticsCountBucket(answers.length),
        search_result_count_bucket: analyticsCountBucket(answers.length),
        reuse_surface: "agent_feed_search",
        artifact_reused: false,
      });
    }
    await recordAgentActivity({
      agentId: agent.id,
      agentLabel: agent.label,
      ownerId: agent.ownerId,
      action: "viewed_feed",
      summary: query ? `${agent.label} searched ${challenges.length} active challenge${challenges.length === 1 ? "" : "s"} and ${answers.length} decision artifact${answers.length === 1 ? "" : "s"} for “${query}”.` : `${agent.label} viewed ${challenges.length} prioritized public challenge${challenges.length === 1 ? "" : "s"}.`,
    });
    return NextResponse.json({ agent, challenges, answers, discovery: { sort, mode, answerState, minReward } });
  } catch (error) {
    return handleApiError(error);
  }
}

function parseMinReward(value: string | undefined) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

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

function parseFeedRequest(raw: string): AgentFeedListRequest | AgentChallengeGetRequest {
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
  const operation = (candidate as Record<string, unknown>).operation;
  if (operation === "feed.list") return parseAgentProtocolJson(operation, raw, agentFeedListRequestSchema);
  if (operation === "challenge.get") return parseAgentProtocolJson(operation, raw, agentChallengeGetRequestSchema);
  throw new AgentProtocolError("malformed_request", "This endpoint supports only feed.list and challenge.get.", 400, false, "$.operation");
}

export async function POST(request: Request) {
  let requestId: string | undefined;
  try {
    const service = platformAgentFeedProtocolService();
    const networkIdentity = agentProtocolNetworkIdentity(request);
    await service.assertPreAuthNetworkRateLimit(networkIdentity);
    const raw = await readBoundedRequestText(
      request,
      Math.max(agentProtocolBodyLimits["feed.list"], agentProtocolBodyLimits["challenge.get"]),
    );
    requestId = extractSafeRequestId(raw);
    const envelope = parseFeedRequest(raw);
    const response = await service.execute(
      envelope,
      networkIdentity,
      { networkRateLimitPrecharged: true },
    );
    const headers: Record<string, string> = { "cache-control": "no-store" };
    if ("error" in response && response.error.retry_after_seconds !== undefined) {
      headers["retry-after"] = String(response.error.retry_after_seconds);
    }
    return NextResponse.json(response, { status: agentFeedProtocolResponseStatus(response), headers });
  } catch (error) {
    return handlePairingRouteError(error, {
      requestId,
      protocol: true,
      surface: "agent_feed_protocol",
    });
  }
}
