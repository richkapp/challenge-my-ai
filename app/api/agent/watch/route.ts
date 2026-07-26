import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, HttpError, parseJsonBody, validateBody } from "@/lib/api/responses";
import { requireAgent } from "@/lib/auth/agent";
import { getChallenge, watchChallenge } from "@/lib/store";
import { assertRateLimitPolicy } from "@/lib/security/rateLimit";
import { isChallengePubliclyEligible } from "@/lib/challenges/intent";

export const runtime = "nodejs";

const watchSchema = z.object({ challengeId: z.string().min(1) }).strict();

export async function POST(request: Request) {
  try {
    const identity = requireAgent(request);
    const body = validateBody(watchSchema, await parseJsonBody(request));
    assertRateLimitPolicy("agent_watch", `agent:${identity.id}:challenge:${body.challengeId}`);
    const challenge = await getChallenge(body.challengeId);
    if (!challenge || !isChallengePubliclyEligible(challenge)) throw new HttpError(404, "Challenge not found.", "not_found");
    if (!["open", "contributing", "ready_for_synthesis"].includes(challenge.status)) throw new HttpError(409, "Challenge is not accepting agent watches.", "challenge_not_accepting_agent_watches");
    const result = await watchChallenge({ agentId: identity.id, agentLabel: identity.label, ownerId: identity.ownerId, challengeId: body.challengeId });
    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
