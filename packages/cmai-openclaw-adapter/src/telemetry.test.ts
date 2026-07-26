import { describe, expect, it } from "vitest";
import { evaluateOpenClawCompatibility } from "./constants";
import { validateOpenClawInstallTelemetry } from "./telemetry";

describe("OpenClaw compatibility and telemetry contract", () => {
  it("pins the verified OpenClaw minor line and rejects prereleases", () => {
    expect(evaluateOpenClawCompatibility("2026.7.1").supported).toBe(true);
    expect(evaluateOpenClawCompatibility("2026.7.99+local").supported).toBe(true);
    expect(evaluateOpenClawCompatibility("2026.7.1-beta.1")).toMatchObject({ supported: false, reason: "version_prerelease" });
    expect(evaluateOpenClawCompatibility("2026.7.0")).toMatchObject({ supported: false, reason: "version_too_old" });
    expect(evaluateOpenClawCompatibility("2026.8.0")).toMatchObject({ supported: false, reason: "version_too_new" });
    expect(evaluateOpenClawCompatibility("unknown")).toMatchObject({ supported: false, reason: "version_unreadable" });
  });

  it("validates only allowlisted install telemetry without emitting it", () => {
    expect(validateOpenClawInstallTelemetry({ installChannel: "disposable_test", installScope: "disposable_test" })).toEqual({
      properties: { runtime: "openclaw", install_channel: "disposable_test", install_scope: "disposable_test" },
      droppedProperties: [],
    });
  });

  it("cannot include secrets, prompts, or response data", () => {
    const result = validateOpenClawInstallTelemetry({ installChannel: "local_package", installScope: "user_profile" });
    expect(Object.keys(result.properties).sort()).toEqual(["install_channel", "install_scope", "runtime"]);
    expect(JSON.stringify(result)).not.toMatch(/token|credential|prompt|response/i);
  });
});
