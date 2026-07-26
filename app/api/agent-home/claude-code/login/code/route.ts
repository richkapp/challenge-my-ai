import { NextResponse } from "next/server";
import { z } from "zod";
import { HttpError, parseJsonBody, validateBody } from "@/lib/api/responses";
import { requireUser } from "@/lib/auth";
import { submitClaudeCodeLoginCode } from "@/lib/store";
import { assertSameOrigin } from "@/lib/security/origin";

export const runtime = "nodejs";

const requestSchema = z.object({
  attemptId: z.string().trim().min(12).max(120),
  authorizationCode: z.string().trim().min(1).max(4_096).refine((value) => !/[\r\n\0]/.test(value), "Authorization code cannot contain control characters."),
}).strict();

function assertClaudeSameOrigin(request: Request): void {
  try {
    assertSameOrigin(request);
  } catch (error) {
    if (error instanceof HttpError && error.code === "origin_mismatch") {
      throw new HttpError(403, "Cross-origin Claude Code login is not allowed.", "claude_code_login_origin_invalid");
    }
    throw error;
  }
}

export async function POST(request: Request) {
  try {
    assertClaudeSameOrigin(request);
    const user = await requireUser(request);
    const body = validateBody(requestSchema, await parseJsonBody(request));
    const accepted = await submitClaudeCodeLoginCode({
      ownerId: user.id,
      attemptId: body.attemptId,
      code: body.authorizationCode,
    });
    if (!accepted) {
      throw new HttpError(409, "This Claude Code login expired, was already completed, or does not belong to this account.", "claude_code_login_code_not_accepted");
    }
    return NextResponse.json({ accepted: true }, { headers: { "cache-control": "no-store, max-age=0" } });
  } catch (error) {
    if (error instanceof HttpError) {
      return NextResponse.json({ error: error.message, code: error.code, ...(error.details ? { details: error.details } : {}) }, { status: error.status });
    }
    return NextResponse.json({ error: "Claude Code authorization code could not be accepted.", code: "claude_code_login_code_failed" }, { status: 500 });
  }
}
