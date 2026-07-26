import { NextResponse } from "next/server";
import { handleApiError, HttpError } from "@/lib/api/responses";
import { ensureSeedData, getChallenge } from "@/lib/store";
import { contributionModes } from "@/lib/types";
import type { ContributionMode } from "@/lib/types";
import { generateContributionPrompt } from "@/lib/prompts/contributionPrompt";
import { analyzeChallengeCopyPromptSafety } from "@/lib/safety/copyPromptSafety";
import { isChallengePubliclyEligible } from "@/lib/challenges/intent";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const url = new URL(request.url);
    const modeParam = url.searchParams.get("mode") as ContributionMode | null;
    const mode = modeParam && contributionModes.includes(modeParam) ? modeParam : "critique";
    await ensureSeedData();
    const challenge = await getChallenge(id);
    if (!challenge || !isChallengePubliclyEligible(challenge)) throw new HttpError(404, "Challenge not found", "not_found");
    const safety = analyzeChallengeCopyPromptSafety(challenge);
    return NextResponse.json({ prompt: generateContributionPrompt(challenge, mode), mode, safetyFlags: safety.flags, safetyWarnings: safety.warnings });
  } catch (error) {
    return handleApiError(error);
  }
}
