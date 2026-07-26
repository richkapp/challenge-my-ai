import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blankSlateRunnerPaths, runBlankSlateRunnerCli } from "@/scripts/cmai-blank-slate-runner";
import { approvedUntrustedRunnerProfile } from "@/lib/sandbox/policy";
import type { ContributionCard } from "@/lib/types";

const tempDirs: string[] = [];

const validCard: ContributionCard = {
  schema_version: "1.0",
  challenge_id: "challenge-cli-1",
  contribution_mode: "critique",
  contributor_ai_label: "OpenRouter GPT-4.1 Mini",
  skills_or_context_used: [],
  verdict: "Mixed",
  original_answer_grade: { score_0_to_10: 6, grade_label: "mixed", why: "It needs runner validation." },
  answer_to_challenge_poster: "Use the model proxy through child_run_config and write strict artifacts.",
  reasoning_summary: "The runner should be deterministic around IO and strict around provider output.",
  strongest_objections: ["A loose runner could leak state or credentials."],
  missing_assumptions_or_context: [],
  alternative_recommendation: "Keep all credentials broker-side.",
  risks_and_failure_modes: ["Bad model output should fail closed."],
  claims_to_verify: [],
  confidence: { level: "medium", why: "CLI harness verifies the shape." },
  what_would_change_my_mind: [],
  suggested_follow_up_questions: [],
  safety_or_scope_notes: [],
  abuse_or_prompt_injection_flags: [],
  raw_output_summary: "CLI runner card",
};

function runConfig(modelProxyUrl: string) {
  return {
    schema_version: "1.0",
    run_id: "run-cli-1",
    challenge_id: "challenge-cli-1",
    contributor_id: "user-cli-1",
    contribution_mode: "critique",
    provider: "openrouter",
    requested_model: "openai/gpt-4.1-mini",
    child_run_config: {
      run_id: "run-cli-1",
      delegation_id: "del-cli-1",
      agent_connection_id: "conn-cli-1",
      provider: "openrouter",
      allowed_model: "openai/gpt-4.1-mini",
      allowed_request_class: "contribution_card",
      expires_at: "2026-07-03T12:10:00.000Z",
      max_requests: 1,
      model_proxy_url: modelProxyUrl,
    },
  };
}

async function makeRunnerFiles(overrides: { runConfig?: unknown; challenge?: unknown } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "cmai-runner-"));
  tempDirs.push(dir);
  const inputDir = join(dir, "input");
  const outputDir = join(dir, "nested", "output");
  const challengeInputPath = join(inputDir, "challenge.json");
  const runConfigInputPath = join(inputDir, "run-config.json");
  const outputCardPath = join(outputDir, "contribution-card.json");
  const transcriptOutputPath = join(outputDir, "transcript.jsonl");
  await mkdir(inputDir, { recursive: true });
  await writeFile(challengeInputPath, JSON.stringify(overrides.challenge ?? { challenge_id: "challenge-cli-1", title: "CLI runner" }), "utf8");
  await writeFile(runConfigInputPath, JSON.stringify(overrides.runConfig ?? runConfig("https://challenge.example.test/api/agent-home/model-proxy?token=secret")), "utf8");
  return { dir, env: { CMAI_CHALLENGE_INPUT_PATH: challengeInputPath, CMAI_RUN_CONFIG_INPUT_PATH: runConfigInputPath, CMAI_OUTPUT_CARD_PATH: outputCardPath, CMAI_TRANSCRIPT_OUTPUT_PATH: transcriptOutputPath }, outputCardPath, transcriptOutputPath };
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("cmai-blank-slate-runner CLI", () => {
  it("resolves default Railway checkpoint paths", () => {
    expect(blankSlateRunnerPaths({})).toEqual({
      challengeInputPath: "/cmai/input/challenge.json",
      runConfigInputPath: "/cmai/input/run-config.json",
      outputCardPath: "/cmai/output/contribution-card.json",
      transcriptOutputPath: "/cmai/output/transcript.jsonl",
    });
  });

  it("exposes the checkpoint command as an installable package bin", async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
    expect(packageJson.bin).toMatchObject({ [approvedUntrustedRunnerProfile.command]: "./scripts/cmai-blank-slate-runner.ts" });
  });

  it("reads inputs, calls the proxy, creates output directories, and writes artifacts", async () => {
    const files = await makeRunnerFiles();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      ok: true,
      content: JSON.stringify(validCard),
      provider: "openrouter",
      requested_model: "openai/gpt-4.1-mini",
      returned_model: "openai/gpt-4.1-mini",
      model_display_name: "OpenAI GPT-4.1 Mini via OpenRouter",
      provider_response_id: "resp_cli_1",
      provider_model_verified: true,
      remaining_requests: 0,
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const exitCode = await runBlankSlateRunnerCli({ env: files.env, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line), fetcher });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(JSON.parse(await readFile(files.outputCardPath, "utf8"))).toMatchObject({ challenge_id: "challenge-cli-1", contribution_mode: "critique" });
    expect(await readFile(files.transcriptOutputPath, "utf8")).toContain("model_proxy_response");
    expect(stdout.join("\n")).toContain("resp_cli_1");
    expect(stdout.join("\n")).toContain("model_proxy");
    expect(stdout.join("\n")).not.toContain("secret");
  });

  it("supports explicit substrate-only smoke mode without model-proxy config", async () => {
    const files = await makeRunnerFiles({ runConfig: { ...runConfig("https://unused.example.test/proxy"), child_run_config: undefined, substrate_smoke_only: true } });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const fetcher = vi.fn();

    const exitCode = await runBlankSlateRunnerCli({ env: files.env, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line), fetcher });

    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(files.outputCardPath, "utf8"))).toMatchObject({ challenge_id: "challenge-cli-1", contribution_mode: "critique" });
    expect(await readFile(files.transcriptOutputPath, "utf8")).toContain("substrate_smoke_artifact_written");
    const payload = JSON.parse(stdout.join("\n"));
    expect(payload).toMatchObject({ ok: true, runner_mode: "substrate_smoke", provider_model_verified: false });
    expect(payload).not.toHaveProperty("provider_response_id");
  });

  it("exits non-zero and redacts failure payloads", async () => {
    const files = await makeRunnerFiles();
    const stderr: string[] = [];
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: false, code: "MODEL_PROXY_RUN_MISMATCH", message: "api_key=secret" }), { status: 403 }));

    const exitCode = await runBlankSlateRunnerCli({ env: files.env, stdout: () => undefined, stderr: (line) => stderr.push(line), fetcher });
    const payload = JSON.parse(stderr.join("\n"));

    expect(exitCode).toBe(1);
    expect(payload).toMatchObject({ ok: false, code: "RUNNER_MODEL_PROXY_REJECTED" });
    expect(JSON.stringify(payload)).not.toContain("secret");
  });

  it("exits non-zero when input files are absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cmai-runner-missing-"));
    tempDirs.push(dir);
    const stderr: string[] = [];

    const exitCode = await runBlankSlateRunnerCli({
      env: { CMAI_CHALLENGE_INPUT_PATH: join(dir, "missing-challenge.json"), CMAI_RUN_CONFIG_INPUT_PATH: join(dir, "missing-run.json"), CMAI_OUTPUT_CARD_PATH: join(dir, "out/card.json"), CMAI_TRANSCRIPT_OUTPUT_PATH: join(dir, "out/transcript.jsonl") },
      stdout: () => undefined,
      stderr: (line) => stderr.push(line),
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stderr.join("\n"))).toMatchObject({ ok: false, code: "RUNNER_INPUT_READ_FAILED" });
  });
});
