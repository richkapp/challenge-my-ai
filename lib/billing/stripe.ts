import Stripe from "stripe";
import { env, isProductionLike } from "@/lib/config/env";
import { HttpError } from "@/lib/api/responses";

export function stripeConfigured() {
  return Boolean(env.STRIPE_SECRET_KEY);
}

export async function createCheckoutSession(input: { kind: string; userId: string; origin: string }) {
  if (!env.STRIPE_SECRET_KEY) {
    if (isProductionLike()) throw new HttpError(503, "Stripe Checkout is not configured.", "billing_provider_not_configured");
    throw new HttpError(503, "Stripe Checkout is not configured; use the local mock billing adapter in local mode.", "billing_provider_not_configured");
  }

  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    client_reference_id: input.userId,
    success_url: `${input.origin}/dashboard?checkout=success`,
    cancel_url: `${input.origin}/dashboard?checkout=cancelled`,
    metadata: { kind: input.kind, userId: input.userId },
    line_items: env.STRIPE_PRICE_PRIVATE_CHALLENGE
      ? [{ price: env.STRIPE_PRICE_PRIVATE_CHALLENGE, quantity: 1 }]
      : [{
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: 500,
            product_data: { name: input.kind === "deep-challenge" ? "Deep Challenge" : "Private Challenge" },
          },
        }],
  });
  if (!session.url) throw new HttpError(502, "Stripe did not return a checkout URL.", "billing_provider_error");
  return { provider: "stripe" as const, checkoutUrl: session.url, sessionId: session.id };
}
