export const CMAI_HERMES_ADAPTER_NAME = "cmai-hermes" as const;
export const CMAI_HERMES_ADAPTER_VERSION = "0.1.0" as const;
export const CMAI_HERMES_SUPPORTED_RANGE = ">=0.18.2 <0.20.0" as const;
export const CMAI_HERMES_MIN_VERSION = [0, 18, 2] as const;
export const CMAI_HERMES_MAX_EXCLUSIVE = [0, 20, 0] as const;

export type HermesCompatibility = {
  supported: boolean;
  installedVersion: string;
  supportedRange: typeof CMAI_HERMES_SUPPORTED_RANGE;
  reason?: "version_unreadable" | "version_too_old" | "version_too_new";
};

function compare(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function evaluateHermesCompatibility(installedVersion: string): HermesCompatibility {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(installedVersion.trim());
  if (!match) {
    return {
      supported: false,
      installedVersion,
      supportedRange: CMAI_HERMES_SUPPORTED_RANGE,
      reason: "version_unreadable",
    };
  }
  const parsed = match.slice(1, 4).map(Number);
  if (compare(parsed, CMAI_HERMES_MIN_VERSION) < 0) {
    return {
      supported: false,
      installedVersion,
      supportedRange: CMAI_HERMES_SUPPORTED_RANGE,
      reason: "version_too_old",
    };
  }
  if (compare(parsed, CMAI_HERMES_MAX_EXCLUSIVE) >= 0) {
    return {
      supported: false,
      installedVersion,
      supportedRange: CMAI_HERMES_SUPPORTED_RANGE,
      reason: "version_too_new",
    };
  }
  return { supported: true, installedVersion, supportedRange: CMAI_HERMES_SUPPORTED_RANGE };
}
