import { NextResponse } from "next/server";
import { handleApiError, HttpError, parseJsonBody } from "@/lib/api/responses";
import { requireUser } from "@/lib/auth";
import { parseChallengeBrief, structureRawChallenge } from "@/lib/validation/challengeBrief";
import { evaluateChallengePublicationPolicy } from "@/lib/moderation/publicationPolicy";
import { assertRateLimit } from "@/lib/security/rateLimit";

export const runtime = "nodejs";

const PARSE_CHALLENGE_MAX_BYTES = 24 * 1024;
const PARSE_RATE_LIMIT = { limit: 20, windowMs: 60_000, policy: "challenge_parse" } as const;

export async function POST(request: Request) {
  try {
    assertRateLimit({ ...PARSE_RATE_LIMIT, key: `ip:${clientAddress(request)}` });
    const user = await requireUser(request);
    assertRateLimit({ ...PARSE_RATE_LIMIT, key: `user:${user.id}` });
    const body = await parseJsonBody(request, { maxBytes: PARSE_CHALLENGE_MAX_BYTES }) as { raw?: unknown };
    if (typeof body.raw !== "string") {
      throw new HttpError(422, "Challenge parse input failed validation.", "invalid_schema", [{ path: "raw", message: "raw must be a string." }]);
    }
    const text = body.raw;
    const parsed = parseChallengeBrief(text);
    if (!text.trim()) return NextResponse.json({ error: "Paste challenge material first.", code: "empty_input" }, { status: 400 });
    const brief = parsed.ok ? parsed.value : structureRawChallenge(text);
    const policy = evaluateChallengePublicationPolicy({ brief, visibility: "public" });
    return NextResponse.json({ brief, parsed: parsed.ok, warning: parsed.ok ? undefined : parsed.error, issues: parsed.ok ? undefined : parsed.issues, policy });
  } catch (error) {
    return handleApiError(error);
  }
}

function clientAddress(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (forwarded || request.headers.get("x-real-ip")?.trim() || "unknown").slice(0, 64);
}
