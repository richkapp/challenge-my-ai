import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readCodexDeviceEvents } from "../lib/agent-home/codexDeviceEvents";
import { pathToFileURL } from "node:url";
import {
  buildSmokeBrief,
  cleanupModeFromEnv,
  cleanupSmokeChallenge,
  createClient,
  normalizeSmokeId,
  objectValue,
  resolveBaseUrl,
  revokeSmokeConnection,
  signupSmokeUser,
  stringValue,
  type ProductionChallengeLoopSmokeEnv,
  type ProductionChallengeLoopSmokeFetch,
  type SmokeClient,
  type SmokeUser,
} from "./smoke-production-challenge-loop";

type JsonObject = Record<string, unknown>;
type Logger = (line: string) => void;
const execFileAsync = promisify(execFile);

export function railwayCliPath(env: ProductionChallengeLoopSmokeEnv) {
  const configured = env.CMAI_RAILWAY_CLI_PATH?.trim();
  if (!configured) return "railway";
  if (!configured.startsWith("/")) throw new Error("CMAI_RAILWAY_CLI_PATH must be an absolute path.");
  return configured;
}

function requireMutationGuards(env: ProductionChallengeLoopSmokeEnv, base: URL) {
  if (env.CMAI_SMOKE_ALLOW_MUTATION !== "1") throw new Error("CMAI_SMOKE_ALLOW_MUTATION=1 is required.");
  if (cleanupModeFromEnv(env) !== "moderator_suppress") throw new Error("CMAI_SMOKE_CLEANUP_MODE=moderator_suppress is required.");
  if (base.hostname !== "challenge-my-ai.vercel.app" && env.CMAI_SMOKE_ALLOW_NONCANONICAL !== "1") {
    throw new Error("Refusing Codex production proof outside the canonical host without CMAI_SMOKE_ALLOW_NONCANONICAL=1.");
  }
}

function safeError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\b[A-Z0-9]{4}(?:-[A-Z0-9]{4})+\b/g, "[redacted-device-code]")
    .replace(/(access|refresh|id)[_-]?token\s*[:=]\s*[^\s,}]+/gi, "$1_token=[redacted]")
    .slice(0, 800);
}

async function readDeviceLogin(response: Response, stdout: Logger, signal: AbortSignal) {
  let deviceEvents = 0;
  let connection: JsonObject | undefined;
  await readCodexDeviceEvents(response, async (event) => {
    if (event.type === "device_code") {
      deviceEvents += 1;
      const verificationUrl = stringValue(event.verificationUrl);
      const userCode = stringValue(event.userCode);
      if (!verificationUrl || !userCode) throw new Error("Codex device login did not return a verification URL and code.");
      stdout(JSON.stringify({ event: "CODEX_DEVICE_CODE", verification_url: verificationUrl, user_code: userCode }));
    }
    if (event.type === "ready") connection = objectValue(event.connection);
    if (event.type === "error") throw new Error(`${stringValue(event.code) || "codex_device_login_failed"}: ${stringValue(event.message) || "Codex device login failed."}`);
  }, signal);
  if (deviceEvents !== 1) throw new Error(`Expected one Codex device-login ceremony, received ${deviceEvents}.`);
  const connectionId = stringValue(connection?.id);
  if (!connectionId) throw new Error("Codex device login completed without a connection id.");
  return { connectionId, deviceEvents };
}

async function assertNoActiveRailwaySandboxes(env: ProductionChallengeLoopSmokeEnv, receiptSandboxIds: string[], listActiveSandboxIds?: () => Promise<string[]>) {
  let activeIds: string[];
  if (listActiveSandboxIds) {
    activeIds = await listActiveSandboxIds();
  } else {
    const args = ["sandbox", "list", "--json"];
    if (env.RAILWAY_ENVIRONMENT_ID) args.push("--environment", env.RAILWAY_ENVIRONMENT_ID);
    const nodeEnv: "development" | "test" | "production" = env.NODE_ENV === "development" || env.NODE_ENV === "test" ? env.NODE_ENV : "production";
    const { stdout } = await execFileAsync(railwayCliPath(env), args, { timeout: 30_000, maxBuffer: 1_000_000, env: { ...env, NODE_ENV: nodeEnv } });
    const rows = JSON.parse(stdout) as unknown;
    if (!Array.isArray(rows)) throw new Error("Railway sandbox inventory returned an invalid response.");
    activeIds = rows.map((row) => stringValue(objectValue(row).id)).filter(Boolean);
  }
  const residualReceiptIds = receiptSandboxIds.filter((id) => activeIds.includes(id));
  if (activeIds.length || residualReceiptIds.length) {
    throw new Error(`Railway sandbox cleanup left active sandboxes: ${JSON.stringify({ active_count: activeIds.length, residual_receipt_count: residualReceiptIds.length })}`);
  }
  return { active_count: 0, receipt_sandboxes_absent: true };
}

async function createProofChallenge(client: SmokeClient, poster: SmokeUser, smokeId: string, suffix: "a" | "b") {
  const brief = {
    ...buildSmokeBrief(`${smokeId}-${suffix}`),
    title: `Codex reuse proof ${smokeId} ${suffix.toUpperCase()}`.slice(0, 80),
    problem_statement: `Prove saved Codex authentication can run challenge ${suffix.toUpperCase()} with a fresh one-run approval and an isolated sandbox.`,
  };
  const response = await client.json("/api/challenges", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ brief, reward: 10, visibility: "public" }),
  }, poster.jar, `create Codex reuse challenge ${suffix.toUpperCase()}`);
  const challenge = objectValue(response.challenge);
  const id = stringValue(challenge.id);
  if (!id) throw new Error(`Challenge ${suffix.toUpperCase()} creation did not return an id.`);
  return id;
}

async function proveFreshApproval(client: SmokeClient, contributor: SmokeUser, challengeId: string, connectionId: string, key: string) {
  const denied = await client.request(`/api/challenges/${encodeURIComponent(challengeId)}/agent-runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approved: false, connectionId, contributionMode: "critique", idempotencyKey: `${key}-unapproved` }),
  }, contributor.jar, { step: `verify fresh approval for ${challengeId}` });
  const deniedBody = objectValue(await denied.json());
  if (denied.status !== 400 || stringValue(deniedBody.code) !== "approval_required") {
    throw new Error(`Challenge ${challengeId} did not require fresh one-run approval.`);
  }

  const result = await client.json(`/api/challenges/${encodeURIComponent(challengeId)}/agent-runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approved: true, connectionId, contributionMode: "critique", idempotencyKey: key }),
  }, contributor.jar, `run Codex challenge ${challengeId}`, { timeoutMs: 300_000 });
  const run = objectValue(result.run);
  if (stringValue(run.status) !== "contributed" || !stringValue(run.contributionId)) {
    throw new Error(`Codex challenge ${challengeId} did not contribute successfully.`);
  }
  const receipt = objectValue(run.receiptSummary);
  for (const field of ["receiptId", "receiptSha256", "sandboxId"] as const) {
    if (!stringValue(receipt[field])) throw new Error(`Codex challenge ${challengeId} omitted receiptSummary.${field}.`);
  }
  return { run, receipt };
}

async function assertSameReadyConnection(client: SmokeClient, contributor: SmokeUser, connectionId: string) {
  const home = await client.json("/api/agent-home", { method: "GET" }, contributor.jar, "verify saved Codex connection readiness");
  const agentHome = objectValue(home.agentHome);
  const connections = Array.isArray(agentHome.connections) ? agentHome.connections.map(objectValue) : [];
  const connection = connections.find((item) => stringValue(item.id) === connectionId);
  if (!connection || stringValue(connection.status) !== "ready" || objectValue(connection.readiness).canRunHere !== true) {
    throw new Error("The saved Codex connection did not remain ready between challenge runs.");
  }
}

export async function runCodexReuseProductionProof(options: {
  env?: ProductionChallengeLoopSmokeEnv;
  fetch?: ProductionChallengeLoopSmokeFetch;
  stdout?: Logger;
  stderr?: Logger;
  baseUrl?: string;
  smokeId?: string;
  listActiveSandboxIds?: () => Promise<string[]>;
} = {}) {
  const env = options.env || process.env;
  const stdout = options.stdout || console.log;
  const stderr = options.stderr || console.error;
  const base = resolveBaseUrl(options.baseUrl || process.argv[2] || env.CMAI_SMOKE_BASE_URL || "https://challenge-my-ai.vercel.app");
  const smokeId = normalizeSmokeId(options.smokeId || env.CMAI_SMOKE_RUN_ID);
  const client = createClient(base, options.fetch || globalThis.fetch.bind(globalThis), env);
  const cleanupMode = cleanupModeFromEnv(env);
  const challengeIds: string[] = [];
  const receiptSandboxIds: string[] = [];
  let contributor: SmokeUser | undefined;
  let connectionId = "";
  let success = false;
  let successSummary: JsonObject | undefined;

  try {
    requireMutationGuards(env, base);
    const health = await client.json("/api/system/health", { method: "GET" }, undefined, "Codex reuse health preflight");
    if (health.ok !== true || health.productionReady !== true) throw new Error("Production health preflight is not ready.");

    const poster = await signupSmokeUser(client, "poster", smokeId, env);
    contributor = await signupSmokeUser(client, "contributor", smokeId, env);

    const loginController = new AbortController();
    const loginTimeout = setTimeout(() => loginController.abort(), 280_000);
    loginTimeout.unref();
    try {
      const loginResponse = await client.request("/api/agent-home/codex/device-login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayLabel: `Codex reuse proof ${smokeId}` }),
        signal: loginController.signal,
      }, contributor.jar, { step: "start Codex device login", timeoutMs: 30_000 });
      const login = await readDeviceLogin(loginResponse, stdout, loginController.signal);
      connectionId = login.connectionId;
      await assertSameReadyConnection(client, contributor, connectionId);

      challengeIds.push(await createProofChallenge(client, poster, smokeId, "a"));
      challengeIds.push(await createProofChallenge(client, poster, smokeId, "b"));

      const runA = await proveFreshApproval(client, contributor, challengeIds[0]!, connectionId, `codex-reuse-${smokeId}-a`);
      await assertSameReadyConnection(client, contributor, connectionId);
      const runB = await proveFreshApproval(client, contributor, challengeIds[1]!, connectionId, `codex-reuse-${smokeId}-b`);
      await assertSameReadyConnection(client, contributor, connectionId);

      const sandboxA = stringValue(runA.receipt.sandboxId);
      const sandboxB = stringValue(runB.receipt.sandboxId);
      receiptSandboxIds.push(sandboxA, sandboxB);
      const distinct = {
        run: stringValue(runA.run.id) !== stringValue(runB.run.id),
        contribution: stringValue(runA.run.contributionId) !== stringValue(runB.run.contributionId),
        receipt: stringValue(runA.receipt.receiptId) !== stringValue(runB.receipt.receiptId),
        receipt_sha: stringValue(runA.receipt.receiptSha256) !== stringValue(runB.receipt.receiptSha256),
        sandbox: sandboxA !== sandboxB,
      };
      if (Object.values(distinct).some((value) => !value)) throw new Error(`Codex reuse proof did not isolate both runs: ${JSON.stringify(distinct)}`);

      successSummary = {
        ok: true,
        mode: "production_codex_reuse_proof",
        base: base.origin,
        smoke_id: smokeId,
        authentication_events: login.deviceEvents,
        connection_id: connectionId,
        challenge_a: {
          challenge_id: challengeIds[0],
          run_id: stringValue(runA.run.id),
          contribution_id: stringValue(runA.run.contributionId),
          receipt_id: stringValue(runA.receipt.receiptId),
          receipt_sha256: stringValue(runA.receipt.receiptSha256),
          sandbox_id: sandboxA,
        },
        challenge_b: {
          challenge_id: challengeIds[1],
          run_id: stringValue(runB.run.id),
          contribution_id: stringValue(runB.run.contributionId),
          receipt_id: stringValue(runB.receipt.receiptId),
          receipt_sha256: stringValue(runB.receipt.receiptSha256),
          sandbox_id: sandboxB,
        },
        same_connection_ready_between_runs: true,
        fresh_approval_per_challenge: true,
        no_second_oauth: true,
        isolated_artifacts: distinct,
      };
      success = true;
    } finally {
      clearTimeout(loginTimeout);
      loginController.abort();
    }
  } catch (error) {
    stderr(JSON.stringify({ ok: false, code: "CODEX_REUSE_PRODUCTION_PROOF_FAILED", reason: safeError(error), challenge_ids: challengeIds, connection_id: connectionId || undefined }, null, 2));
  } finally {
    if (contributor && connectionId) {
      try { await revokeSmokeConnection(client, contributor, connectionId); } catch (error) { stderr(JSON.stringify({ ok: false, code: "CODEX_REUSE_CONNECTION_CLEANUP_FAILED", reason: safeError(error), connection_id: connectionId })); success = false; }
    }
    for (const challengeId of challengeIds) {
      try { await cleanupSmokeChallenge(client, cleanupMode, challengeId, `/answers/${challengeId}`, smokeId, env); } catch (error) { stderr(JSON.stringify({ ok: false, code: "CODEX_REUSE_CHALLENGE_CLEANUP_FAILED", reason: safeError(error), challenge_id: challengeId })); success = false; }
    }
  }

  if (success && successSummary) {
    try {
      successSummary.sandbox_cleanup = await assertNoActiveRailwaySandboxes(env, receiptSandboxIds, options.listActiveSandboxIds);
    } catch (error) {
      stderr(JSON.stringify({ ok: false, code: "CODEX_REUSE_SANDBOX_CLEANUP_FAILED", reason: safeError(error) }, null, 2));
      success = false;
    }
  }
  if (success && successSummary) stdout(JSON.stringify(successSummary, null, 2));
  return success ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exitCode = await runCodexReuseProductionProof();
}
