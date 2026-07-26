import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, parseJsonBody, validateBody } from "@/lib/api/responses";
import { parseDecisionArtifactLimit, toDecisionArtifactSummary } from "@/lib/archive/decisionArtifact";
import { listDecisionArtifacts } from "@/lib/archive/decisionArtifactStore";
import { analyticsCountBucket, trackEvent } from "@/lib/analytics/events";

export const runtime = "nodejs";

const searchBodySchema = z.object({
  query: z.string().max(320).optional().default(""),
  limit: z.number().int().positive().max(50).optional(),
  includePrompt: z.boolean().optional().default(false),
}).strict();

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim() || "";
    const limit = parseDecisionArtifactLimit(url.searchParams.get("limit"));
    const includePrompt = url.searchParams.get("includePrompt") === "1";
    const artifacts = await searchDecisionArtifacts(query, limit, includePrompt);
    trackAnswerSearch(artifacts.length, includePrompt ? "api_search_with_prompt" : "api_search_compact");

    return NextResponse.json({ query, limit, artifacts });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const body = validateBody(searchBodySchema, await parseJsonBody(request));
    const limit = parseDecisionArtifactLimit(body.limit);
    const artifacts = await searchDecisionArtifacts(body.query.trim(), limit, body.includePrompt);
    trackAnswerSearch(artifacts.length, body.includePrompt ? "api_search_with_prompt" : "api_search_compact");

    return NextResponse.json({ limit, artifacts });
  } catch (error) {
    return handleApiError(error);
  }
}

async function searchDecisionArtifacts(query: string, limit: number, includePrompt: boolean) {
  return (await listDecisionArtifacts({ query, limit })).map((artifact) => toDecisionArtifactSummary(artifact, { includePrompt }));
}

function trackAnswerSearch(resultCount: number, reuseSurface: string) {
  trackEvent("answer_search_performed", {
    artifact_result_count_bucket: analyticsCountBucket(resultCount),
    search_result_count_bucket: analyticsCountBucket(resultCount),
    reuse_surface: reuseSurface,
    artifact_reused: false,
  });
}
