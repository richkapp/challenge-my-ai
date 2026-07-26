import { NextResponse } from "next/server";
import { z } from "zod";
import { analyticsCountBucket, trackEvent } from "@/lib/analytics/events";
import { assertChallengePoster, requireUser } from "@/lib/auth";
import { handleApiError, HttpError, parseJsonBody, validateBody } from "@/lib/api/responses";
import { getChallenge, getContribution, listCreditEvents, rateContribution } from "@/lib/store";
import { assertRateLimitPolicy } from "@/lib/security/rateLimit";
import { isChallengePubliclyEligible } from "@/lib/challenges/intent";

export const runtime = "nodejs";

const ratingRequestSchema = z.object({
  usefulness: z.number().min(0).max(10),
  novelty: z.number().min(0).max(10).optional(),
  correctness: z.number().min(0).max(10).optional(),
  safety: z.number().min(0).max(10).optional(),
  comment: z.string().optional(),
}).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const contribution = await getContribution(id);
    if (!contribution || contribution.status !== "posted") throw new HttpError(404, "Contribution not found.", "not_found");
    const challenge = await getChallenge(contribution.challengeId);
    if (!challenge || !isChallengePubliclyEligible(challenge)) throw new HttpError(404, "Challenge not found.", "not_found");
    assertChallengePoster(user, challenge);
    assertRateLimitPolicy("contribution_rating", `user:${user.id}:contribution:${id}`);
    const body = validateBody(ratingRequestSchema, await parseJsonBody(request));
    const beforeEvents = await listCreditEvents(contribution.contributorId);
    const before = beforeEvents.filter((event) => event.contributionId === contribution.id).reduce((sum, event) => sum + event.amount, 0);
    const rating = await rateContribution({ contributionId: id, raterId: user.id, ...body });
    const afterEvents = await listCreditEvents(contribution.contributorId);
    const after = afterEvents.filter((event) => event.contributionId === contribution.id).reduce((sum, event) => sum + event.amount, 0);
    const creditDelta = after - before;
    const common = {
      challenge_id: challenge.id,
      contribution_id: contribution.id,
      contribution_mode: contribution.card.contribution_mode,
      contribution_trust: contribution.contributorKind === "agent" ? "trusted_agent" : "manual_paste",
      provenance_tier: contribution.card.model_provenance?.source || "self_attested",
      rating_bucket: scoreBucket(body.usefulness),
      usefulness_bucket: scoreBucket(body.usefulness),
      credit_delta_bucket: signedBucket(creditDelta),
    };
    trackEvent("contribution_rated", common);
    if (creditDelta !== 0) trackEvent("credit_awarded", common);
    return NextResponse.json({ rating, creditDelta, creditTotal: after });
  } catch (error) {
    return handleApiError(error);
  }
}

function scoreBucket(value: number) {
  if (value >= 8) return "high";
  if (value >= 5) return "medium";
  return "low";
}

function signedBucket(value: number) {
  if (value === 0) return "0";
  return `${value > 0 ? "plus" : "minus"}_${analyticsCountBucket(Math.abs(value))}`;
}
