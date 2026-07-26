import { describe, expect, it } from "vitest";
import { createFakeHermesRunBroker } from "@/lib/sandbox/fakeHermesRunBroker";
import { createRailwaySandboxBroker, DEFAULT_RAILWAY_SANDBOX_CHECKPOINT, RailwaySandboxUnavailableError } from "@/lib/sandbox/railwayBroker";
import { RAILWAY_SMOKE_UNAVAILABLE_EXIT_CODE, preflightRailwaySandboxSmoke, railwaySmokeCheckpoint, runRailwaySandboxSmoke } from "../../scripts/smoke-railway-sandbox";

const secretToken = "railway-secret-token";
const secretEnvironmentId = "env_secret_123";
const secretCheckpoint = "custom-secret-checkpoint";

function parseOnlyJsonLine(lines: string[]): Record<string, unknown> {
  return JSON.parse(lines.join("\n"));
}

describe("Railway sandbox live smoke script", () => {
  it("preflights required config without leaking raw values", () => {
    const missingEnv = preflightRailwaySandboxSmoke({ RAILWAY_API_TOKEN: secretToken });
    expect(missingEnv).toMatchObject({ ok: false, reason: "missing RAILWAY_ENVIRONMENT_ID", config: { api_token: "present", environment_id: "missing", checkpoint: "approved", network_isolation: "ISOLATED" } });
    expect(JSON.stringify(missingEnv)).not.toContain(secretToken);

    const ready = preflightRailwaySandboxSmoke({ RAILWAY_API_TOKEN: secretToken, RAILWAY_ENVIRONMENT_ID: secretEnvironmentId });
    expect(ready).toMatchObject({ ok: true, config: { api_token: "present", environment_id: "present", checkpoint: "approved", checkpoint_source: "default" } });
    expect(JSON.stringify(ready)).not.toContain(secretToken);
    expect(JSON.stringify(ready)).not.toContain(secretEnvironmentId);
  });

  it("uses the canonical checkpoint env before the legacy fallback", () => {
    expect(railwaySmokeCheckpoint({})).toEqual({ checkpoint: DEFAULT_RAILWAY_SANDBOX_CHECKPOINT, source: "default", status: "approved" });
    expect(railwaySmokeCheckpoint({ CMAI_RAILWAY_SANDBOX_CHECKPOINT: "legacy-checkpoint" })).toEqual({ checkpoint: "legacy-checkpoint", source: "legacy_env", envKey: "CMAI_RAILWAY_SANDBOX_CHECKPOINT", status: "unsupported" });
    expect(railwaySmokeCheckpoint({ RAILWAY_SANDBOX_CHECKPOINT: "canonical-checkpoint", CMAI_RAILWAY_SANDBOX_CHECKPOINT: "legacy-checkpoint" })).toEqual({ checkpoint: "canonical-checkpoint", source: "canonical_env", envKey: "RAILWAY_SANDBOX_CHECKPOINT", status: "unsupported" });
  });

  it("reports a stable unavailable reason when RAILWAY_ENVIRONMENT_ID is missing", async () => {
    const lines: string[] = [];
    const code = await runRailwaySandboxSmoke({
      env: { RAILWAY_API_TOKEN: secretToken },
      stdout: (line) => lines.push(line),
    });

    const output = lines.join("\n");
    expect(code).toBe(RAILWAY_SMOKE_UNAVAILABLE_EXIT_CODE);
    expect(output).toContain("missing RAILWAY_ENVIRONMENT_ID");
    expect(output).not.toContain(secretToken);
  });

  it("reports a stable unavailable reason when RAILWAY_API_TOKEN is missing", async () => {
    const lines: string[] = [];
    const code = await runRailwaySandboxSmoke({
      env: { RAILWAY_ENVIRONMENT_ID: secretEnvironmentId },
      stdout: (line) => lines.push(line),
    });

    const output = lines.join("\n");
    expect(code).toBe(RAILWAY_SMOKE_UNAVAILABLE_EXIT_CODE);
    expect(output).toContain("missing RAILWAY_API_TOKEN");
    expect(output).not.toContain(secretEnvironmentId);
  });

  it("reports the proxy-smoke URL prerequisite with a proxy-specific next step", async () => {
    const lines: string[] = [];
    let brokerCalled = false;
    const code = await runRailwaySandboxSmoke({
      env: { RAILWAY_API_TOKEN: secretToken, RAILWAY_ENVIRONMENT_ID: secretEnvironmentId, CMAI_RAILWAY_SMOKE_PROXY: "1" },
      stdout: (line) => lines.push(line),
      brokerFactory: () => {
        brokerCalled = true;
        throw new Error("should not create broker");
      },
    });

    const output = lines.join("\n");
    const payload = parseOnlyJsonLine(lines);
    expect(code).toBe(RAILWAY_SMOKE_UNAVAILABLE_EXIT_CODE);
    expect(brokerCalled).toBe(false);
    expect(payload.reason).toBe("missing CMAI_MODEL_PROXY_URL for Railway proxy smoke");
    expect(String(payload.next_step)).toContain("CMAI_MODEL_PROXY_URL");
    expect(String(payload.next_step)).not.toContain("RAILWAY_API_TOKEN");
    expect(output).not.toContain(secretToken);
    expect(output).not.toContain(secretEnvironmentId);
  });

  it("reports unsupported canonical checkpoint overrides without leaking raw values", async () => {
    const lines: string[] = [];
    let brokerCalled = false;
    const code = await runRailwaySandboxSmoke({
      env: { RAILWAY_API_TOKEN: secretToken, RAILWAY_ENVIRONMENT_ID: secretEnvironmentId, RAILWAY_SANDBOX_CHECKPOINT: secretCheckpoint },
      stdout: (line) => lines.push(line),
      brokerFactory: () => {
        brokerCalled = true;
        throw new Error("should not create broker");
      },
    });

    const output = lines.join("\n");
    const payload = parseOnlyJsonLine(lines);
    expect(code).toBe(RAILWAY_SMOKE_UNAVAILABLE_EXIT_CODE);
    expect(brokerCalled).toBe(false);
    expect(payload).toMatchObject({
      reason: "unsupported RAILWAY_SANDBOX_CHECKPOINT",
      config_status: { checkpoint: "unsupported", checkpoint_source: "canonical_env", checkpoint_env_key: "RAILWAY_SANDBOX_CHECKPOINT" },
    });
    expect(String(payload.next_step)).toContain("RAILWAY_SANDBOX_CHECKPOINT");
    expect(output).not.toContain(secretToken);
    expect(output).not.toContain(secretEnvironmentId);
    expect(output).not.toContain(secretCheckpoint);
  });

  it("reports unsupported legacy checkpoint overrides with source-specific remediation", async () => {
    const lines: string[] = [];
    let brokerCalled = false;
    const code = await runRailwaySandboxSmoke({
      env: { RAILWAY_API_TOKEN: secretToken, RAILWAY_ENVIRONMENT_ID: secretEnvironmentId, CMAI_RAILWAY_SANDBOX_CHECKPOINT: secretCheckpoint },
      stdout: (line) => lines.push(line),
      brokerFactory: () => {
        brokerCalled = true;
        throw new Error("should not create broker");
      },
    });

    const output = lines.join("\n");
    const payload = parseOnlyJsonLine(lines);
    expect(code).toBe(RAILWAY_SMOKE_UNAVAILABLE_EXIT_CODE);
    expect(brokerCalled).toBe(false);
    expect(payload).toMatchObject({
      reason: "unsupported CMAI_RAILWAY_SANDBOX_CHECKPOINT",
      config_status: { checkpoint: "unsupported", checkpoint_source: "legacy_env", checkpoint_env_key: "CMAI_RAILWAY_SANDBOX_CHECKPOINT" },
    });
    expect(String(payload.next_step)).toContain("CMAI_RAILWAY_SANDBOX_CHECKPOINT");
    expect(output).not.toContain(secretToken);
    expect(output).not.toContain(secretEnvironmentId);
    expect(output).not.toContain(secretCheckpoint);
  });

  it("prints a redacted receipt summary for a mocked successful live smoke", async () => {
    const lines: string[] = [];
    let receivedToken = "";
    let receivedChildRunConfig: unknown;
    const code = await runRailwaySandboxSmoke({
      env: { RAILWAY_API_TOKEN: secretToken, RAILWAY_ENVIRONMENT_ID: secretEnvironmentId, RAILWAY_SANDBOX_CHECKPOINT: DEFAULT_RAILWAY_SANDBOX_CHECKPOINT },
      stdout: (line) => lines.push(line),
      brokerFactory: ({ token, environmentId, checkpoint }) => {
        receivedToken = token;
        expect(environmentId).toBe(secretEnvironmentId);
        expect(checkpoint).toBe(DEFAULT_RAILWAY_SANDBOX_CHECKPOINT);
        const fake = createFakeHermesRunBroker({ signingKey: { keyId: "smoke-test", secret: "smoke-secret" } });
        return {
          async run(request) {
            receivedChildRunConfig = request.childRunConfig;
            const outcome = await fake.run(request);
            outcome.receipt.sandbox.provider = "railway";
            outcome.receipt.sandbox.sandbox_id = "sbx_mock";
            if (outcome.card.model_provenance) outcome.card.model_provenance.sandbox_provider = "railway";
            return outcome;
          },
        };
      },
    });

    const output = lines.join("\n");
    const payload = parseOnlyJsonLine(lines);
    expect(code).toBe(0);
    expect(receivedToken).toBe(secretToken);
    expect(receivedChildRunConfig).toBeUndefined();
    expect(payload).toMatchObject({
      sandbox_id: "sbx_mock",
      runner_proxy: "unconfigured",
      config_status: { api_token: "present", environment_id: "present", checkpoint: "approved", checkpoint_source: "canonical_env", checkpoint_env_key: "RAILWAY_SANDBOX_CHECKPOINT", network_isolation: "ISOLATED" },
      destroyed: true,
    });
    expect(payload).toHaveProperty("prompt_sha256");
    expect(output).not.toContain(secretToken);
    expect(output).not.toContain(secretEnvironmentId);
    expect(output).not.toContain(DEFAULT_RAILWAY_SANDBOX_CHECKPOINT);
    expect(output).not.toContain("model-proxy.local.invalid");
  });

  it("requires explicit proxy smoke mode before injecting model-proxy config", async () => {
    const lines: string[] = [];
    const proxyUrl = "https://challenge.example.test/api/agent-home/model-proxy?grant=smoke-secret";
    let receivedChildRunConfig: unknown;
    const code = await runRailwaySandboxSmoke({
      env: { RAILWAY_API_TOKEN: secretToken, RAILWAY_ENVIRONMENT_ID: secretEnvironmentId, CMAI_RAILWAY_SMOKE_PROXY: "1", CMAI_MODEL_PROXY_URL: proxyUrl },
      stdout: (line) => lines.push(line),
      brokerFactory: () => {
        const fake = createFakeHermesRunBroker({ signingKey: { keyId: "smoke-test", secret: "smoke-secret" } });
        return {
          async run(request) {
            receivedChildRunConfig = request.childRunConfig;
            const outcome = await fake.run(request);
            outcome.transcript = `${JSON.stringify({
              event: "model_proxy_response",
              run_id: "railway-smoke-run",
              delegation_id: "del_railway_smoke_one_run",
              agent_connection_id: "conn_railway_smoke",
              provider: "user-provider-smoke",
              request_class: "contribution_card",
              requested_model: "user-model-smoke",
              remaining_requests: 0,
            })}\n`;
            outcome.receipt.sandbox.provider = "railway";
            outcome.receipt.sandbox.sandbox_id = "sbx_proxy_mock";
            return outcome;
          },
        };
      },
    });

    const output = lines.join("\n");
    const payload = parseOnlyJsonLine(lines);
    expect(code).toBe(0);
    expect(receivedChildRunConfig).toMatchObject({ model_proxy_url: proxyUrl, delegation_id: "del_railway_smoke_one_run" });
    expect(payload).toMatchObject({ sandbox_id: "sbx_proxy_mock", runner_proxy: "verified" });
    expect(output).not.toContain(secretToken);
    expect(output).not.toContain(secretEnvironmentId);
    expect(output).not.toContain(proxyUrl);
  });

  it("does not mark runner proxy verified from an unstructured transcript substring", async () => {
    const lines: string[] = [];
    const proxyUrl = "https://challenge.example.test/api/agent-home/model-proxy?grant=smoke-secret";
    const code = await runRailwaySandboxSmoke({
      env: { RAILWAY_API_TOKEN: secretToken, RAILWAY_ENVIRONMENT_ID: secretEnvironmentId, CMAI_RAILWAY_SMOKE_PROXY: "1", CMAI_MODEL_PROXY_URL: proxyUrl },
      stdout: (line) => lines.push(line),
      brokerFactory: () => {
        const fake = createFakeHermesRunBroker({ signingKey: { keyId: "smoke-test", secret: "smoke-secret" } });
        return {
          async run(request) {
            const outcome = await fake.run(request);
            expect(request.childRunConfig).toMatchObject({ model_proxy_url: proxyUrl });
            outcome.transcript = "plain text mentioning model_proxy_response but not a JSONL event\n";
            outcome.receipt.sandbox.provider = "railway";
            outcome.receipt.sandbox.sandbox_id = "sbx_proxy_mock";
            return outcome;
          },
        };
      },
    });

    const payload = parseOnlyJsonLine(lines);
    expect(code).toBe(0);
    expect(payload).toMatchObject({ sandbox_id: "sbx_proxy_mock", runner_proxy: "configured_unverified" });
    expect(lines.join("\n")).not.toContain(secretToken);
    expect(lines.join("\n")).not.toContain(secretEnvironmentId);
    expect(lines.join("\n")).not.toContain(proxyUrl);
  });

  it("does not mark runner proxy verified when structured proxy evidence does not match the smoke grant", async () => {
    const lines: string[] = [];
    const proxyUrl = "https://challenge.example.test/api/agent-home/model-proxy?grant=smoke-secret";
    const code = await runRailwaySandboxSmoke({
      env: { RAILWAY_API_TOKEN: secretToken, RAILWAY_ENVIRONMENT_ID: secretEnvironmentId, CMAI_RAILWAY_SMOKE_PROXY: "1", CMAI_MODEL_PROXY_URL: proxyUrl },
      stdout: (line) => lines.push(line),
      brokerFactory: () => {
        const fake = createFakeHermesRunBroker({ signingKey: { keyId: "smoke-test", secret: "smoke-secret" } });
        return {
          async run(request) {
            const outcome = await fake.run(request);
            expect(request.childRunConfig).toMatchObject({ model_proxy_url: proxyUrl });
            outcome.transcript = `${JSON.stringify({
              event: "model_proxy_response",
              run_id: "railway-smoke-run",
              delegation_id: "different-delegation",
              agent_connection_id: "conn_railway_smoke",
              provider: "user-provider-smoke",
              request_class: "contribution_card",
              requested_model: "user-model-smoke",
              remaining_requests: 0,
            })}\n`;
            outcome.receipt.sandbox.provider = "railway";
            outcome.receipt.sandbox.sandbox_id = "sbx_proxy_mock";
            return outcome;
          },
        };
      },
    });

    const payload = parseOnlyJsonLine(lines);
    expect(code).toBe(0);
    expect(payload).toMatchObject({ sandbox_id: "sbx_proxy_mock", runner_proxy: "configured_unverified" });
  });

  it("maps Priority Boarding sandbox access errors to an unavailable operator message", async () => {
    const lines: string[] = [];
    const code = await runRailwaySandboxSmoke({
      env: { RAILWAY_API_TOKEN: secretToken, RAILWAY_ENVIRONMENT_ID: secretEnvironmentId },
      stdout: (line) => lines.push(line),
      brokerFactory: () => ({
        async run() {
          throw new RailwaySandboxUnavailableError("Railway Sandboxes require Priority Boarding access.");
        },
      }),
    });

    const output = lines.join("\n");
    expect(code).toBe(RAILWAY_SMOKE_UNAVAILABLE_EXIT_CODE);
    expect(output).toContain("Priority Boarding");
    expect(output).toContain("Enable Railway Sandboxes");
    expect(output).not.toContain(secretToken);
    expect(output).not.toContain(secretEnvironmentId);
  });

  it("maps checkpoint/template create blockers to unavailable output without leaking SDK values", async () => {
    const lines: string[] = [];
    const errors: string[] = [];
    const code = await runRailwaySandboxSmoke({
      env: { RAILWAY_API_TOKEN: secretToken, RAILWAY_ENVIRONMENT_ID: secretEnvironmentId },
      stdout: (line) => lines.push(line),
      stderr: (line) => errors.push(line),
      brokerFactory: ({ token, environmentId, checkpoint }) => createRailwaySandboxBroker({
        token,
        environmentId,
        checkpoint,
        sdk: {
          async create() {
            throw new Error(`Checkpoint ${checkpoint} not found in ${environmentId} for ${token}`);
          },
        },
      }, { keyId: "smoke-test", secret: "smoke-secret" }),
    });

    const output = `${lines.join("\n")}\n${errors.join("\n")}`;
    const payload = parseOnlyJsonLine(lines);
    expect(code).toBe(RAILWAY_SMOKE_UNAVAILABLE_EXIT_CODE);
    expect(errors).toEqual([]);
    expect(payload).toMatchObject({ code: "RAILWAY_SANDBOX_UNAVAILABLE" });
    expect(String(payload.reason)).toContain("checkpoint/template");
    expect(output).not.toContain(secretToken);
    expect(output).not.toContain(secretEnvironmentId);
    expect(output).not.toContain(DEFAULT_RAILWAY_SANDBOX_CHECKPOINT);
  });
});
