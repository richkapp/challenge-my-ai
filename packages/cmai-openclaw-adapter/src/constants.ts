export const CMAI_OPENCLAW_PLUGIN_ID = "cmai-openclaw" as const;
export const CMAI_OPENCLAW_ADAPTER_NAME = "cmai-openclaw" as const;
export const CMAI_OPENCLAW_ADAPTER_VERSION = "0.1.0" as const;
export const CMAI_OPENCLAW_VERIFIED_VERSION = "2026.7.1" as const;
export const CMAI_OPENCLAW_SUPPORTED_RANGE = ">=2026.7.1 <2026.8.0" as const;
export const CMAI_OPENCLAW_PLUGIN_API_RANGE = ">=2026.7.1 <2026.8.0" as const;
export const CMAI_OPENCLAW_MIN_VERSION = [2026, 7, 1] as const;
export const CMAI_OPENCLAW_MAX_EXCLUSIVE = [2026, 8, 0] as const;

export type OpenClawCompatibility = {
  supported: boolean;
  installedVersion: string;
  supportedRange: typeof CMAI_OPENCLAW_SUPPORTED_RANGE;
  pluginApiRange: typeof CMAI_OPENCLAW_PLUGIN_API_RANGE;
  reason?: "version_unreadable" | "version_prerelease" | "version_too_old" | "version_too_new";
};

function compare(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function evaluateOpenClawCompatibility(installedVersion: string): OpenClawCompatibility {
  const normalized = installedVersion.trim().replace(/^v/, "");
  const match = /^(\d+)\.(\d+)\.(\d+)(.*)$/.exec(normalized);
  const base = {
    installedVersion,
    supportedRange: CMAI_OPENCLAW_SUPPORTED_RANGE,
    pluginApiRange: CMAI_OPENCLAW_PLUGIN_API_RANGE,
  } as const;
  if (!match) return { ...base, supported: false, reason: "version_unreadable" };
  if (match[4]?.startsWith("-")) return { ...base, supported: false, reason: "version_prerelease" };
  const parsed = match.slice(1, 4).map(Number);
  if (compare(parsed, CMAI_OPENCLAW_MIN_VERSION) < 0) {
    return { ...base, supported: false, reason: "version_too_old" };
  }
  if (compare(parsed, CMAI_OPENCLAW_MAX_EXCLUSIVE) >= 0) {
    return { ...base, supported: false, reason: "version_too_new" };
  }
  return { ...base, supported: true };
}
