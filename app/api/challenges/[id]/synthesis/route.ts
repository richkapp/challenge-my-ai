import { NextResponse } from "next/server";
import { analyticsCountBucket, trackEvent } from "@/lib/analytics/events";
import { assertChallengePoster, requireUser } from "@/lib/auth";
import { handleApiError, HttpError } from "@/lib/api/responses";
import { getChallenge, getJob, listContributions, synthesizeChallenge } from "@/lib/store";
import { recordLlmTrace } from "@/lib/observability/langfuse";
import { isChallengePubliclyEligible } from "@/lib/challenges/intent";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let challengeId = "unknown";
  const startedAt = Date.now();
  try {
    const user = await requireUser(request);
    const { id } = await params;
    challengeId = id;
    const challenge = await getChallenge(id);
    if (!challenge || !isChallengePubliclyEligible(challenge)) throw new HttpError(404, "Challenge not found.", "not_found");
    assertChallengePoster(user, challenge);
    const contributionCount = (await listContributions(id)).length;
    const synthesis = await synthesizeChallenge(id);
    const job = await getJob(synthesis.jobId);
    trackEvent("synthesis_created", {
      challenge_id: challenge.id,
      artifact_id: synthesis.id,
      synthesis_status: "succeeded",
      contribution_count_bucket: analyticsCountBucket(contributionCount),
      synthesis_duration_bucket: analyticsCountBucket(Date.now() - startedAt),
    });
    recordLlmTrace({ traceKind: "synthesis", status: "completed", challengeId: challenge.id });
    return NextResponse.json({ synthesis, artifactUrl: `/answers/${challenge.id}`, job });
  } catch (error) {
    trackEvent("synthesis_failed", {
      challenge_id: challengeId,
      synthesis_status: "failed",
      error_code: codeFromError(error),
      synthesis_duration_bucket: analyticsCountBucket(Date.now() - startedAt),
    });
    recordLlmTrace({ traceKind: "synthesis", status: "failed", challengeId, failureCode: codeFromError(error) });
    return handleApiError(error, { surface: "api/challenges/synthesis" });
  }
}

function codeFromError(error: unknown) {
  if (error instanceof HttpError) return error.code;
  if (error instanceof Error && error.name) return error.name;
  return "unknown_error";
}
