import { NextResponse } from "next/server";
import { handleApiError, HttpError } from "@/lib/api/responses";
import { loadDecisionArtifact } from "@/lib/archive/decisionArtifactStore";
import { trackEvent } from "@/lib/analytics/events";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const artifact = await loadDecisionArtifact(id);
    if (!artifact) throw new HttpError(404, "Decision artifact not found.", "not_found");
    trackEvent("answer_artifact_opened", {
      challenge_id: artifact.id,
      artifact_id: artifact.id,
      reuse_surface: "api_artifact",
      artifact_reused: false,
    });
    return NextResponse.json({ artifact });
  } catch (error) {
    return handleApiError(error);
  }
}
