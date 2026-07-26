import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, HttpError, parseJsonBody, validateBody } from "@/lib/api/responses";
import { requireAgent } from "@/lib/auth/agent";
import { createAgentContribution, getChallenge } from "@/lib/store";
import { sanitizeExternalContributionCard } from "@/lib/provenance/manual";
import { contributionCardSchema } from "@/lib/validation/schemas";
import { assertRateLimitPolicy } from "@/lib/security/rateLimit";
import { isChallengePubliclyEligible } from "@/lib/challenges/intent";

export const runtime = "nodejs";

const agentContributionSchema = z.object({
  challengeId: z.string().min(1),
  card: contributionCardSchema,
}).strict();

export async function POST(request: Request) {
  try {
    const identity = requireAgent(request);
    const body = validateBody(agentContributionSchema, await parseJsonBody(request));
    assertRateLimitPolicy("agent_contribution", `agent:${identity.id}:challenge:${body.challengeId}`);
    if (body.card.challenge_id !== body.challengeId) {
      throw new HttpError(400, "Contribution card challenge_id does not match this room.", "challenge_id_mismatch");
    }
    const challenge = await getChallenge(body.challengeId);
    if (!challenge || !isChallengePubliclyEligible(challenge)) throw new HttpError(404, "Challenge not found.", "not_found");
    if (!["open", "contributing", "ready_for_synthesis"].includes(challenge.status)) throw new HttpError(409, "Challenge is not accepting agent contributions.", "challenge_not_accepting_agent_contributions");
    const contribution = await createAgentContribution({
      agentId: identity.id,
      agentLabel: identity.label,
      ownerId: identity.ownerId,
      challengeId: body.challengeId,
      card: sanitizeExternalContributionCard(body.card, "signed agent contribution API"),
      externallyGenerated: true,
    });
    return NextResponse.json({ contribution });
  } catch (error) {
    return handleApiError(error);
  }
}
