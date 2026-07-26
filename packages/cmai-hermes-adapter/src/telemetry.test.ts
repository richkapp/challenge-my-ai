import { describe, expect, it } from "vitest";
import { evaluateHermesCompatibility } from "./constants";
import { validateHermesInstallTelemetry } from "./telemetry";

describe("Hermes adapter compatibility and telemetry contract", () => {
  it("pins the verified Hermes minor lines", () => {
    expect(evaluateHermesCompatibility("0.18.2").supported).toBe(true);
    expect(evaluateHermesCompatibility("0.18.99+local").supported).toBe(true);
    expect(evaluateHermesCompatibility("0.19.0").supported).toBe(true);
    expect(evaluateHermesCompatibility("0.19.99+local").supported).toBe(true);
    expect(evaluateHermesCompatibility("0.18.1")).toMatchObject({ supported: false, reason: "version_too_old" });
    expect(evaluateHermesCompatibility("0.20.0")).toMatchObject({ supported: false, reason: "version_too_new" });
    expect(evaluateHermesCompatibility("unknown")).toMatchObject({ supported: false, reason: "version_unreadable" });
  });

  it("consumes the shared telemetry allowlist without emitting lifecycle events", () => {
    expect(validateHermesInstallTelemetry({ installChannel: "disposable_test", installScope: "disposable_test" })).toEqual({
      properties: { runtime: "hermes", install_channel: "disposable_test", install_scope: "disposable_test" },
      droppedProperties: [],
    });
  });

  it("returns only telemetry-contract allowlisted properties", () => {
    const result = validateHermesInstallTelemetry({ installChannel: "local_package", installScope: "user_profile" });
    expect(Object.keys(result.properties).sort()).toEqual(["install_channel", "install_scope", "runtime"]);
    expect(JSON.stringify(result)).not.toMatch(/token|credential|prompt|response/i);
  });
});
