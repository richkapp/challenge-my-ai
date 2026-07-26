import { sanitizeTelemetryProperties, type TelemetryPropertiesResult } from "../../../lib/telemetry/collector";
import { telemetryEventDefinitions } from "../../../lib/telemetry/contract";

export const cmaiOpenClawTelemetryEvents = {
  installCompleted: "adapter.install.completed",
  installFailed: "adapter.install.failed",
} as const;

export type OpenClawInstallTelemetryInput = {
  installChannel: "local_package" | "disposable_test";
  installScope: "user_profile" | "disposable_test";
};

/** Validate but do not emit lifecycle telemetry from discovery or registration. */
export function validateOpenClawInstallTelemetry(input: OpenClawInstallTelemetryInput): TelemetryPropertiesResult {
  if (telemetryEventDefinitions[cmaiOpenClawTelemetryEvents.installCompleted].owner !== "runtime_adapters") {
    throw new Error("CMAI telemetry ownership mismatch for the OpenClaw adapter.");
  }
  return sanitizeTelemetryProperties(cmaiOpenClawTelemetryEvents.installCompleted, {
    runtime: "openclaw",
    install_channel: input.installChannel,
    install_scope: input.installScope,
  });
}
