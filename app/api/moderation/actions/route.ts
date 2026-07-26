import { NextResponse } from "next/server";
import { z } from "zod";
import { trackEvent } from "@/lib/analytics/events";
import { requireModerator } from "@/lib/auth";
import { handleApiError, HttpError, parseJsonBody, validateBody } from "@/lib/api/responses";
import { moderateTarget } from "@/lib/store";
import { moderationReasons, moderationTargetTypes, type ModerationTargetType } from "@/lib/types";

export const runtime = "nodejs";

const legacyModerationActions = ["suppress_challenge", "restore_challenge", "suppress_contribution", "restore_contribution"] as const;

const actionRequestSchema = z.object({
  action: z.union([z.enum(["suppress", "restore"]), z.enum(legacyModerationActions)]),
  targetType: z.enum(moderationTargetTypes).optional(),
  targetId: z.string().trim().min(1),
  reason: z.enum(moderationReasons).default("other"),
  note: z.string().max(1_000).optional(),
}).strict();

type ActionRequest = z.infer<typeof actionRequestSchema>;

export async function POST(request: Request) {
  try {
    const user = await requireModerator(request);
    const body = validateBody(actionRequestSchema, await parseJsonBody(request));
    const normalized = normalizeActionRequest(body);
    const result = await moderateTarget({ ...normalized, actorId: user.id });
    trackEvent("moderation_action_taken", {
      challenge_id: result.event.resolvedTargetType === "challenge" ? result.event.resolvedTargetId : result.challenge?.id,
      contribution_id: result.event.resolvedTargetType === "contribution" ? result.event.resolvedTargetId : result.contribution?.id,
      moderation_reason_group: result.event.reason,
      moderation_action: result.event.action,
      moderation_queue_bucket: result.event.targetType,
    });
    return NextResponse.json({ action: result.event, challenge: result.challenge, contribution: result.contribution });
  } catch (error) {
    return handleApiError(error, { surface: "api/moderation/actions" });
  }
}

function normalizeActionRequest(body: ActionRequest): { action: "suppress" | "restore"; targetType: ModerationTargetType; targetId: string; reason: ActionRequest["reason"]; note?: string } {
  if (body.action === "suppress" || body.action === "restore") {
    if (!body.targetType) throw new HttpError(422, "targetType is required for generic moderation actions.", "invalid_schema", [{ path: "targetType", message: "Required" }]);
    return { action: body.action, targetType: body.targetType, targetId: body.targetId, reason: body.reason, note: body.note };
  }
  const action = body.action.startsWith("restore") ? "restore" : "suppress";
  const targetType = body.action.endsWith("contribution") ? "contribution" : "challenge";
  return { action, targetType, targetId: body.targetId, reason: body.reason, note: body.note };
}
