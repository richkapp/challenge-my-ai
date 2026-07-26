import { describe, expect, it } from "vitest";
import { AGENT_HOME_RUN_SMOKE_UNAVAILABLE_EXIT_CODE, runAgentHomeRunSmoke } from "../../scripts/smoke-agent-home-run";

describe("Agent Home run smoke script", () => {
  it("prints a redacted local fake Agent Home run summary", async () => {
    const lines: string[] = [];
    const code = await runAgentHomeRunSmoke({
      env: {
        CMAI_RECEIPT_SIGNING_KEY_ID: "agent-home-test",
        CMAI_RECEIPT_SIGNING_SECRET: "super-secret-signing-material",
      },
      stdout: (line) => lines.push(line),
    });

    const output = lines.join("\n");
    const summary = JSON.parse(output) as Record<string, unknown>;

    expect(code).toBe(0);
    expect(summary).toMatchObject({
      ok: true,
      mode: "local_fake_agent_home",
      agent_home_id: "ah_smoke_ready",
      connection_id: "conn_agent_home_smoke",
      readiness: "ready",
      run_id: "run_agent_home_smoke",
      challenge_id: "agent-home-smoke-challenge",
      source: "hermes_sandbox_run",
      sandbox_provider: "local_fake",
      network: "ISOLATED",
      teardown_completed: true,
      destroyed: true,
      provider_model_verified: false,
      exact_model_verified: false,
      manual_paste_fallback_available: true,
    });
    expect(summary.contribution_id).toEqual(expect.any(String));
    expect(summary.receipt_id).toEqual(expect.stringMatching(/^hr_/));
    expect(summary.receipt_sha256).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(output).not.toContain("super-secret-signing-material");
    expect(output).not.toContain("DATABASE_URL");
    expect(output).not.toContain("OPENAI_API_KEY");
  });

  it("returns a stable unavailable result when Railway mode lacks operator context", async () => {
    const lines: string[] = [];
    const code = await runAgentHomeRunSmoke({
      env: { CMAI_AGENT_HOME_RUN_SMOKE_ADAPTER: "railway", RAILWAY_API_TOKEN: "railway-secret-token" },
      stdout: (line) => lines.push(line),
    });

    const output = lines.join("\n");
    expect(code).toBe(AGENT_HOME_RUN_SMOKE_UNAVAILABLE_EXIT_CODE);
    expect(output).toContain("RAILWAY_SANDBOX_UNAVAILABLE");
    expect(output).toContain("missing RAILWAY_ENVIRONMENT_ID");
    expect(output).not.toContain("railway-secret-token");
  });
});
