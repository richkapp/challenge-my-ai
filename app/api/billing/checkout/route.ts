import { requireUser } from "@/lib/auth";
import { handleApiError, HttpError, parseJsonBody } from "@/lib/api/responses";
import { trackEvent } from "@/lib/analytics/events";
import { env } from "@/lib/config/env";
import { invalidCheckoutKindDetails, isPaidCheckoutKind, normalizePaidCheckoutKind, paidCheckoutWaitlistDetails } from "@/lib/billing/catalog";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    await requireUser(request);
    const body = await parseJsonBody(request) as { kind?: unknown };
    const kind = normalizePaidCheckoutKind(body.kind);
    if (!isPaidCheckoutKind(kind)) {
      throw new HttpError(400, "Unknown checkout kind.", "invalid_checkout_kind", invalidCheckoutKindDetails(kind, env));
    }
    trackEvent("paid_intent_clicked", {
      paid_intent: kind,
      plan_tier: kind,
      billing_surface: "checkout_api",
      private_gate_state: "waitlisted",
    });
    throw new HttpError(409, "Paid checkout is waitlisted. Keep using the free public loop or join the paid-path waitlist.", "paid_path_waitlisted", paidCheckoutWaitlistDetails(kind, env));
  } catch (error) {
    return handleApiError(error, { surface: "api/billing/checkout" });
  }
}
