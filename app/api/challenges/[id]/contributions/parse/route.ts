import { NextResponse } from "next/server";
import { handleApiError, parseJsonBody } from "@/lib/api/responses";
import { sanitizeManualContributionCard } from "@/lib/provenance/manual";
import { parseContributionCard } from "@/lib/validation/contributionCard";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { raw } = await parseJsonBody(request) as { raw?: unknown };
    const parsed = parseContributionCard(String(raw || ""));
    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.error, code: "invalid_contribution_card", issues: parsed.issues ?? [], repair: parsed.repair ?? [] },
        { status: 400 },
      );
    }
    const card = sanitizeManualContributionCard(parsed.value);
    const mismatch = card.challenge_id !== id;
    return NextResponse.json({
      card,
      mismatch,
      repair: mismatch ? [`Set \`challenge_id\` to \`${id}\` before publishing this card in this room.`] : [],
      provenanceLabel: "self-submitted / user-trusted",
    });
  } catch (error) {
    return handleApiError(error);
  }
}
