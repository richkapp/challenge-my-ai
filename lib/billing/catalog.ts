import type { RuntimeEnv } from "@/lib/config/env";

export type PaidCheckoutKind = "plus" | "private-challenge" | "deep-challenge" | "one-off-review";
export type PaidLaunchState = "waitlisted" | "active";

export type PaidOffering = {
  kind: PaidCheckoutKind;
  label: string;
  launchState: PaidLaunchState;
  priceEnvKey: keyof Pick<RuntimeEnv, "STRIPE_PRICE_PLUS" | "STRIPE_PRICE_PRIVATE_CHALLENGE" | "STRIPE_PRICE_DEEP_CHALLENGE" | "STRIPE_PRICE_ONE_OFF_REVIEW">;
  plannedBenefits: string[];
};

export const paidOfferings: PaidOffering[] = [
  {
    kind: "plus",
    label: "Plus",
    launchState: "waitlisted",
    priceEnvKey: "STRIPE_PRICE_PLUS",
    plannedBenefits: ["power-user limits", "priority synthesis", "saved decision history", "exports", "private/deep readiness once access controls exist"],
  },
  {
    kind: "private-challenge",
    label: "Private challenge room",
    launchState: "waitlisted",
    priceEnvKey: "STRIPE_PRICE_PRIVATE_CHALLENGE",
    plannedBenefits: ["owner/member-gated challenge rooms", "private moderation visibility", "retention and export controls"],
  },
  {
    kind: "deep-challenge",
    label: "Deep challenge pack",
    launchState: "waitlisted",
    priceEnvKey: "STRIPE_PRICE_DEEP_CHALLENGE",
    plannedBenefits: ["higher-depth synthesis", "larger run packaging", "priority review", "saved decision trail"],
  },
  {
    kind: "one-off-review",
    label: "One-off review",
    launchState: "waitlisted",
    priceEnvKey: "STRIPE_PRICE_ONE_OFF_REVIEW",
    plannedBenefits: ["one-off paid pressure test", "operator-grade review packaging", "exportable decision artifact"],
  },
] as const;

export const paidPathWaitlistCopy = {
  short: "Plus and one-off paid paths are waitlisted.",
  freeLoop: "Free public challenges still work: post, contribute, earn credits, synthesize, and reuse answers.",
  noEntitlement: "No checkout unlocks private/deep access yet.",
  noGuarantee: "No paid privacy or deep-run guarantee is active yet.",
  marketing: "Free public challenges, contribution rewards, synthesis, and reusable answers stay live while Plus and one-off paid paths are waitlisted.",
} as const;

export function normalizePaidCheckoutKind(value: unknown) {
  const kind = typeof value === "string" ? value.trim() : "";
  return kind.slice(0, 80);
}

export function isPaidCheckoutKind(kind: string): kind is PaidCheckoutKind {
  return paidOfferings.some((offering) => offering.kind === kind);
}

export function paidOfferingForKind(kind: PaidCheckoutKind) {
  return paidOfferings.find((offering) => offering.kind === kind)!;
}

export function knownPaidCheckoutKinds() {
  return paidOfferings.map((offering) => offering.kind);
}

export function activeCheckoutKinds() {
  return paidOfferings.filter((offering) => offering.launchState === "active").map((offering) => offering.kind);
}

export function waitlistedCheckoutKinds() {
  return paidOfferings.filter((offering) => offering.launchState === "waitlisted").map((offering) => offering.kind);
}

export function priceConfiguredByKind(runtime: RuntimeEnv) {
  return Object.fromEntries(paidOfferings.map((offering) => [offering.kind, Boolean(runtime[offering.priceEnvKey])])) as Record<PaidCheckoutKind, boolean>;
}

export function billingReadiness(runtime: RuntimeEnv) {
  const activeKinds = activeCheckoutKinds();
  const waitlistedKinds = waitlistedCheckoutKinds();
  const priceByKind = priceConfiguredByKind(runtime);
  const stripeConfigured = Boolean(runtime.STRIPE_SECRET_KEY);
  const allActivePricesConfigured = activeKinds.every((kind) => priceByKind[kind]);
  const readyForCheckout = activeKinds.length > 0 && stripeConfigured && allActivePricesConfigured;

  return {
    status: readyForCheckout ? "ready" : waitlistedKinds.length ? "waitlisted" : stripeConfigured ? "configured_no_active_products" : "not_configured",
    readyForCheckout,
    stripeConfigured,
    activeCheckoutKinds: activeKinds,
    waitlistedKinds,
    knownKinds: knownPaidCheckoutKinds(),
    priceConfiguredByKind: priceByKind,
  };
}

export function paidCheckoutWaitlistDetails(kind: PaidCheckoutKind, runtime: RuntimeEnv) {
  const offering = paidOfferingForKind(kind);
  const readiness = billingReadiness(runtime);
  return {
    kind,
    label: offering.label,
    launchState: offering.launchState,
    activeCheckoutKinds: readiness.activeCheckoutKinds,
    waitlistedKinds: readiness.waitlistedKinds,
    plannedBenefits: offering.plannedBenefits,
    freeLoopStillLive: true,
    readyForCheckout: readiness.readyForCheckout,
    stripeConfigured: readiness.stripeConfigured,
  };
}

export function invalidCheckoutKindDetails(requestedKind: string, runtime: RuntimeEnv) {
  const readiness = billingReadiness(runtime);
  return {
    requestedKind,
    knownKinds: readiness.knownKinds,
    activeCheckoutKinds: readiness.activeCheckoutKinds,
    waitlistedKinds: readiness.waitlistedKinds,
  };
}
