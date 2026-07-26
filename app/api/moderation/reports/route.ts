import { NextResponse } from "next/server";
import { z } from "zod";
import { trackEvent } from "@/lib/analytics/events";
import { requireUser } from "@/lib/auth";
import { handleApiError, parseJsonBody, validateBody } from "@/lib/api/responses";
import { reportTarget } from "@/lib/store";
import { moderationReasons, moderationTargetTypes, type ModerationReason } from "@/lib/types";

export const runtime = "nodejs";

const reportRequestSchema = z.object({
  targetType: z.enum(moderationTargetTypes),
  targetId: z.string().trim().min(1),
  reason: z.enum(moderationReasons).default("other"),
  note: z.string().max(1_000).optional(),
}).strict();

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    const body = validateBody(reportRequestSchema, await parseJsonBody(request));
    const report = await reportTarget({ ...body, actorId: user.id });
    trackEvent("moderation_report_created", {
      challenge_id: report.resolvedTargetType === "challenge" ? report.resolvedTargetId : undefined,
      contribution_id: report.resolvedTargetType === "contribution" ? report.resolvedTargetId : undefined,
      moderation_reason_group: report.reason,
      moderation_action: "report",
      moderation_queue_bucket: report.targetType,
    });
    trackEvent("support_feedback_captured", {
      support_feedback_bucket: supportBucketForReason(report.reason),
      diagnostic_status: "queued",
      health_area: report.targetType,
    });
    return NextResponse.json({ report }, { status: 201 });
  } catch (error) {
    return handleApiError(error, { surface: "api/moderation/reports" });
  }
}

function supportBucketForReason(reason: ModerationReason) {
  if (reason === "smoke_or_test_artifact") return "smoke_cleanup";
  if (reason === "off_topic_or_low_quality") return "contribution_quality";
  if (reason === "unsafe_content" || reason === "harassment_or_abuse" || reason === "illegal_or_harmful" || reason === "secrets_or_private_info") return "safety";
  if (reason === "spam") return "spam";
  return "other";
}
