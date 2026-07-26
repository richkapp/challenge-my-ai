import { describe, expect, it } from "vitest";
import { runLiveChallengeLoopSmoke } from "../../scripts/smoke-live-challenge-loop";

describe("live challenge-room loop smoke script", () => {
  it("proves the local two-lane community loop without live provider credentials", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runLiveChallengeLoopSmoke({
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    const output = stdout.join("\n");
    const summary = JSON.parse(output) as Record<string, unknown>;
    const trustedRun = summary.trusted_run as Record<string, unknown>;
    const credits = summary.credits as Record<string, unknown>;
    const idempotency = summary.idempotency as Record<string, unknown>;
    const artifact = summary.answer_artifact as Record<string, unknown>;

    expect(code, stderr.join("\n")).toBe(0);
    expect(summary).toMatchObject({
      ok: true,
      mode: "local_test_live_challenge_loop",
      lanes: ["copy_prompt_paste_local_output", "run_my_agent_here"],
      visible_prompt_preview: true,
      manual_paste_fallback_available: true,
    });
    expect(summary.challenge_id).toEqual(expect.any(String));
    expect(summary.manual_contribution).toMatchObject({ kind: "human", trust_label: "client_attested" });
    expect(summary.trusted_contribution).toMatchObject({ kind: "agent", trust_label: "hermes_sandbox_run" });
    expect(trustedRun).toMatchObject({
      status: "contributed",
      sandbox_provider: "local_fake",
      trust_label: "sandboxed Hermes run",
    });
    expect(trustedRun.receipt_id).toEqual(expect.stringMatching(/^hr_/));
    expect(trustedRun.receipt_sha256).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(idempotency).toMatchObject({ reused: true, contribution_count_after_replay: 2 });
    expect(credits.trusted_before_poster_rating).toBe(0);
    expect(Number(credits.manual_delta)).toBeGreaterThan(0);
    expect(Number(credits.trusted_delta)).toBeGreaterThan(0);
    expect(credits.trusted_repeat_delta).toBe(0);
    expect(summary.synthesis).toMatchObject({ confidence: "medium", artifact_url: expect.stringMatching(/^\/answers\//) });
    expect((summary.synthesis as Record<string, unknown>).what_changed).toEqual(expect.arrayContaining([expect.stringContaining("narrow beta")]));
    expect(artifact).toMatchObject({ contribution_count: 2, useful_contribution_count: 2, searchable: true });
    expect(String(artifact.url)).toMatch(/^\/answers\//);
    expect(output).not.toMatch(/api[_-]?key|secret|token|DATABASE_URL|RAILWAY_API_TOKEN|OPENROUTER_API_KEY|ANTHROPIC_API_KEY/i);
  });
});
