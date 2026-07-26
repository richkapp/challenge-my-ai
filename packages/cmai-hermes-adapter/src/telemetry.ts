import { sanitizeTelemetryProperties, type TelemetryPropertiesResult } from "../../../lib/telemetry/collector";
import { telemetryEventDefinitions } from "../../../lib/telemetry/contract";

export const cmaiHermesTelemetryEvents = {
  installCompleted: "adapter.install.completed",
  installFailed: "adapter.install.failed",
} as const;

export type HermesInstallTelemetryInput = {
  installChannel: "local_package" | "disposable_test";
  installScope: "user_profile" | "disposable_test";
};

/**
 * Validate the adapter-owned install event against CMAI_TELEMETRY_V1.
 * This card deliberately does not emit it from plugin registration: discovery
 * and enablement have no lifecycle network call or automatic persistent write.
 */
export function validateHermesInstallTelemetry(input: HermesInstallTelemetryInput): TelemetryPropertiesResult {
  if (telemetryEventDefinitions[cmaiHermesTelemetryEvents.installCompleted].owner !== "runtime_adapters") {
    throw new Error("CMAI telemetry ownership mismatch for the Hermes adapter.");
  }
  return sanitizeTelemetryProperties(cmaiHermesTelemetryEvents.installCompleted, {
    runtime: "hermes",
    install_channel: input.installChannel,
    install_scope: input.installScope,
  });
}
