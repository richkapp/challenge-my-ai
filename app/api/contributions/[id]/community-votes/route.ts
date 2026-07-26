import { NextResponse } from "next/server";
import { z } from "zod";
import { trackEvent } from "@/lib/analytics/events";
import { requireUser } from "@/lib/auth";
import { communityVote, getChallenge, getContribution } from "@/lib/store";
import { handleApiError, HttpError, parseJsonBody, validateBody } from "@/lib/api/responses";
import { CommunityVoteRejectedError } from "@/lib/community/voting";
import { assertRateLimitPolicy } from "@/lib/security/rateLimit";
import { isChallengePubliclyEligible } from "@/lib/challenges/intent";

export const runtime = "nodejs";

const voteSchema = z.object({ value: z.union([z.literal(1), z.literal(-1), z.number()]) }).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    const contribution = await getContribution(id);
    if (!contribution || contribution.status !== "posted") throw new HttpError(404, "Contribution not found.", "not_found");
    const challenge = await getChallenge(contribution.challengeId);
    if (!challenge || !isChallengePubliclyEligible(challenge)) throw new HttpError(404, "Challenge not found.", "not_found");
    assertRateLimitPolicy("community_vote", `user:${user.id}:contribution:${id}`);
    const body = validateBody(voteSchema, await parseJsonBody(request));
    const value = Number(body.value) >= 0 ? 1 : -1;
    const result = await communityVote(id, value as 1 | -1, user.id);
    trackEvent("community_vote_cast", {
      challenge_id: challenge.id,
      contribution_id: contribution.id,
      contribution_mode: contribution.card.contribution_mode,
      contribution_trust: contribution.contributorKind === "agent" ? "trusted_agent" : "manual_paste",
      provenance_tier: contribution.card.model_provenance?.source || "self_attested",
      community_vote: value > 0 ? "up" : "down",
    });
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof CommunityVoteRejectedError) {
      return handleApiError(new HttpError(error.status, error.message, error.code, error.details));
    }
    return handleApiError(error);
  }
}
