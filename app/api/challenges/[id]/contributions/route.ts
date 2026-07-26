import { NextResponse } from "next/server";
import { analyticsCountBucket, trackEvent } from "@/lib/analytics/events";
import { handleApiError, HttpError, parseJsonBody } from "@/lib/api/responses";
import { requireUser } from "@/lib/auth";
import { createContribution, getChallenge, listContributions } from "@/lib/store";
import { sanitizeManualContributionCard } from "@/lib/provenance/manual";
import { contributionCardSchema } from "@/lib/validation/schemas";
import type { Challenge } from "@/lib/types";
import { assertRateLimitPolicy } from "@/lib/security/rateLimit";
import { isChallengePubliclyEligible } from "@/lib/challenges/intent";

const acceptingManualContributionStatuses = new Set<Challenge["status"]>(["open", "contributing", "ready_for_synthesis"]);

export const runtime = "nodejs";

function assertPublicChallenge(challenge: Challenge | undefined): asserts challenge is Challenge {
  if (!challenge || !isChallengePubliclyEligible(challenge)) {
    throw new HttpError(404, "Challenge not found.", "not_found");
  }
}

function assertAcceptingManualContributions(challenge: Challenge): void {
  if (!acceptingManualContributionStatuses.has(challenge.status)) {
    throw new HttpError(409, "Challenge is not accepting contributions.", "challenge_not_accepting_contributions");
  }
}

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const challenge = await getChallenge(id);
    assertPublicChallenge(challenge);
    return NextResponse.json({ contributions: await listContributions(id) });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser(request);
    const { id } = await params;
    assertRateLimitPolicy("manual_contribution_create", `user:${user.id}`);
    assertRateLimitPolicy("manual_contribution_per_challenge", `user:${user.id}:challenge:${id}`);
    const body = await parseJsonBody(request) as { card?: unknown };
    const card = sanitizeManualContributionCard(contributionCardSchema.parse(body.card));
    if (card.challenge_id !== id) throw new HttpError(400, "Contribution card challenge_id does not match route.", "challenge_mismatch");

    const challenge = await getChallenge(id);
    assertPublicChallenge(challenge);
    assertAcceptingManualContributions(challenge);

    const contribution = await createContribution({
      challengeId: id,
      contributorId: user.id,
      contributorKind: "human",
      contributorLabel: user.name,
      card,
      externallyGenerated: true,
    });
    const contributionCount = (await listContributions(id)).length;
    trackEvent("contribution_posted", {
      challenge_id: id,
      contribution_id: contribution.id,
      contribution_mode: card.contribution_mode,
      contribution_trust: "manual_paste",
      provenance_tier: card.model_provenance?.source || "self_attested",
      contribution_count_bucket: analyticsCountBucket(contributionCount),
    });
    return NextResponse.json({ contribution });
  } catch (error) {
    return handleApiError(error);
  }
}
