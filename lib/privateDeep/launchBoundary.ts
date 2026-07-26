export const privateDeepLaunchState = "waitlisted" as const;

export const supportedActiveChallengeVisibility = ["public"] as const;
export const supportedActiveCheckoutKinds: string[] = [];

export const plannedPrivateDeepCapabilities = [
  "private challenge rooms",
  "deep challenge packs",
  "priority synthesis",
  "saved decision history",
  "exports and share controls",
] as const;

export const requiredBeforePrivateDeepLaunch = [
  "owner-gated access control",
  "billing entitlements",
  "moderation visibility rules",
  "retention and export rules",
  "production smoke evidence",
] as const;

export const privateDeepWaitlistCopy = {
  short: "Public rooms are live now; private/deep rooms are waitlisted.",
  noGuarantee: "No private-room privacy guarantee exists yet. Rewrite protected material as public-safe or wait for owner-gated private routing.",
  dashboard: "Private/deep rooms are waitlisted while the product proves the public loop first.",
} as const;

export function privateChallengeNotReadyDetails(requestedVisibility: string) {
  return {
    requestedVisibility,
    supportedVisibility: [...supportedActiveChallengeVisibility],
    privateDeepState: privateDeepLaunchState,
    plannedCapabilities: [...plannedPrivateDeepCapabilities],
    requiredBeforeLaunch: [...requiredBeforePrivateDeepLaunch],
  };
}

export function privateDeepCheckoutNotReadyDetails(kind: string) {
  return {
    kind,
    privateDeepState: privateDeepLaunchState,
    supportedActiveKinds: [...supportedActiveCheckoutKinds],
    plannedCapabilities: [...plannedPrivateDeepCapabilities],
    requiredBeforeLaunch: [...requiredBeforePrivateDeepLaunch],
  };
}

export function normalizeCheckoutKind(value: unknown) {
  const kind = typeof value === "string" && value.trim() ? value.trim() : "private-challenge";
  return kind.slice(0, 80);
}
