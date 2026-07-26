#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { CMAI_RUNNER_PATHS } from "@/lib/runner/paths";
import { ModelProxyContributionRunnerError, redactRunnerText, runModelProxyContribution, type ModelProxyRunnerFetcher } from "@/lib/runner/modelProxyContributionRunner";

export type BlankSlateRunnerEnv = Record<string, string | undefined>;
export type BlankSlateRunnerLogger = (line: string) => void;

export type BlankSlateRunnerPaths = {
  challengeInputPath: string;
  runConfigInputPath: string;
  outputCardPath: string;
  transcriptOutputPath: string;
};

export type BlankSlateRunnerOptions = {
  env?: BlankSlateRunnerEnv;
  stdout?: BlankSlateRunnerLogger;
  stderr?: BlankSlateRunnerLogger;
  fetcher?: ModelProxyRunnerFetcher;
  now?: () => Date;
};

export function blankSlateRunnerPaths(env: BlankSlateRunnerEnv = process.env): BlankSlateRunnerPaths {
  return {
    challengeInputPath: env.CMAI_CHALLENGE_INPUT_PATH || CMAI_RUNNER_PATHS.challengeInput,
    runConfigInputPath: env.CMAI_RUN_CONFIG_INPUT_PATH || CMAI_RUNNER_PATHS.runConfigInput,
    outputCardPath: env.CMAI_OUTPUT_CARD_PATH || CMAI_RUNNER_PATHS.outputCard,
    transcriptOutputPath: env.CMAI_TRANSCRIPT_OUTPUT_PATH || CMAI_RUNNER_PATHS.transcript,
  };
}

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ModelProxyContributionRunnerError("RUNNER_INPUT_READ_FAILED", `Unable to read or parse runner input file: ${reason}`);
  }
}

function safeFailurePayload(error: unknown): Record<string, unknown> {
  if (error instanceof ModelProxyContributionRunnerError) {
    return {
      ok: false,
      code: error.code,
      reason: redactRunnerText(error.message),
      issues: error.issues.map(redactRunnerText),
    };
  }
  return {
    ok: false,
    code: "RUNNER_FAILED",
    reason: redactRunnerText(error instanceof Error ? error.message : String(error)),
  };
}

export async function runBlankSlateRunnerCli(options: BlankSlateRunnerOptions = {}): Promise<number> {
  const env = options.env || process.env;
  const stdout = options.stdout || console.log;
  const stderr = options.stderr || console.error;
  const paths = blankSlateRunnerPaths(env);

  try {
    const [challengeBundle, runConfig] = await Promise.all([
      readJsonFile(paths.challengeInputPath),
      readJsonFile(paths.runConfigInputPath),
    ]);
    const result = await runModelProxyContribution({
      challengeBundle,
      runConfig,
      fetcher: options.fetcher,
      now: options.now,
    });

    const outputDirs = [...new Set([dirname(paths.outputCardPath), dirname(paths.transcriptOutputPath)])];
    await Promise.all(outputDirs.map((dir) => mkdir(dir, { recursive: true })));
    await Promise.all([
      writeFile(paths.outputCardPath, result.cardJson, "utf8"),
      writeFile(paths.transcriptOutputPath, result.transcript, "utf8"),
    ]);
    stdout(JSON.stringify({
      ok: true,
      runner_mode: result.runnerMode,
      output_card: "written",
      transcript: "written",
      provider: result.modelProxy?.provider,
      requested_model: result.modelProxy?.requestedModel,
      returned_model: result.modelProxy?.returnedModel,
      provider_response_id: result.modelProxy?.providerResponseId,
      provider_model_verified: result.modelProxy?.providerModelVerified ?? false,
      remaining_requests: result.modelProxy?.remainingRequests,
    }));
    return 0;
  } catch (error) {
    stderr(JSON.stringify(safeFailurePayload(error)));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const exitCode = await runBlankSlateRunnerCli();
  process.exitCode = exitCode;
}
