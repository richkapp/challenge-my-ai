import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { readClaudeCodeLoginEvents, safeClaudeAuthorizationUrl } from "../lib/agent-home/claudeCodeLoginEvents";
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

const execFileAsync = promisify(execFile);
type JsonObject = Record<string, unknown>;
type Logger = (line: string) => void;
type AuthorizationCodeProvider = (input: { authorizationUrl: string }) => Promise<string>;

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
    throw new Error("Refusing Claude Code production proof outside the canonical host without CMAI_SMOKE_ALLOW_NONCANONICAL=1.");
  }
}

function safeError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/(access|refresh|id|authorization)[_-]?(?:token|code)\s*[:=]\s*[^\s,}]+/gi, "$1=[redacted]")
    .replace(/sk-ant-[A-Za-z0-9._-]+/g, "sk-ant-[redacted]")
    .slice(0, 800);
}

export async function readAuthorizationCodeFromStdin(): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  try {
    process.stderr.write("Paste the short-lived Anthropic authorization code, then press Enter. It will not be printed.\n");
    const code = (await terminal.question("")).trim();
    if (!code || code.length > 4_096 || /[\r\n\0]/.test(code)) throw new Error("Anthropic authorization code was empty or invalid.");
    return code;
  } finally {
    terminal.close();
  }
}

async function readManagedLogin(
  response: Response,
  client: SmokeClient,
  contributor: SmokeUser,
  stdout: Logger,
  signal: AbortSignal,
  authorizationCodeProvider: AuthorizationCodeProvider,
) {
  let authorizationEvents = 0;
  let connection: JsonObject | undefined;
  await readClaudeCodeLoginEvents(response, async (event) => {
    if (event.type === "authorization_url") {
      authorizationEvents += 1;
      const authorizationUrl = safeClaudeAuthorizationUrl(event.authorizationUrl);
      if (!authorizationUrl || !event.attemptId) throw new Error("Claude Code login did not return a safe authorization URL and attempt id.");
      stdout(JSON.stringify({ event: "CLAUDE_CODE_AUTHORIZATION_REQUIRED", authorization_url: authorizationUrl }));
      const authorizationCode = await authorizationCodeProvider({ authorizationUrl });
      await client.json("/api/agent-home/claude-code/login/code", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attemptId: event.attemptId, authorizationCode }),
      }, contributor.jar, "submit Claude Code authorization code");
      return;
    }
    if (event.type === "ready") connection = objectValue(event.connection);
    if (event.type === "error") throw new Error(`${stringValue(event.code) || "claude_code_login_failed"}: ${stringValue(event.message) || "Claude Code login failed."}`);
  }, signal);
  if (authorizationEvents !== 1) throw new Error(`Expected one Claude Code authorization ceremony, received ${authorizationEvents}.`);
  const connectionId = stringValue(connection?.id);
  if (!connectionId) throw new Error("Claude Code login completed without a connection id.");
  return { connectionId, authorizationEvents };
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
    title: `Claude reuse proof ${smokeId} ${suffix.toUpperCase()}`.slice(0, 80),
    problem_statement: `Prove saved Claude Code authentication can run challenge ${suffix.toUpperCase()} with a fresh one-run approval and an isolated sandbox.`,
  };
  const response = await client.json("/api/challenges", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ brief, reward: 10, visibility: "public" }),
  }, poster.jar, `create Claude Code reuse challenge ${suffix.toUpperCase()}`);
  const id = stringValue(objectValue(response.challenge).id);
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
  if (denied.status !== 400 || stringValue(deniedBody.code) !== "approval_required") throw new Error(`Challenge ${challengeId} did not require fresh one-run approval.`);

  const result = await client.json(`/api/challenges/${encodeURIComponent(challengeId)}/agent-runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approved: true, connectionId, contributionMode: "critique", idempotencyKey: key }),
  }, contributor.jar, `run Claude Code challenge ${challengeId}`, { timeoutMs: 300_000 });
  const run = objectValue(result.run);
  if (stringValue(run.status) !== "contributed" || !stringValue(run.contributionId)) throw new Error(`Claude Code challenge ${challengeId} did not contribute successfully.`);
  const receipt = objectValue(run.receiptSummary);
  for (const field of ["receiptId", "receiptSha256", "sandboxId"] as const) {
    if (!stringValue(receipt[field])) throw new Error(`Claude Code challenge ${challengeId} omitted receiptSummary.${field}.`);
  }
  return { run, receipt };
}

async function assertSameReadyConnection(client: SmokeClient, contributor: SmokeUser, connectionId: string) {
  const home = await client.json("/api/agent-home", { method: "GET" }, contributor.jar, "verify saved Claude Code connection readiness");
  const agentHome = objectValue(home.agentHome);
  const connections = Array.isArray(agentHome.connections) ? agentHome.connections.map(objectValue) : [];
  const connection = connections.find((item) => stringValue(item.id) === connectionId);
  if (!connection || stringValue(connection.status) !== "ready" || objectValue(connection.readiness).canRunHere !== true) {
    throw new Error("The saved Claude Code connection did not remain ready between challenge runs.");
  }
}

export async function runClaudeCodeReuseProductionProof(options: {
  env?: ProductionChallengeLoopSmokeEnv;
  fetch?: ProductionChallengeLoopSmokeFetch;
  stdout?: Logger;
  stderr?: Logger;
  baseUrl?: string;
  smokeId?: string;
  authorizationCodeProvider?: AuthorizationCodeProvider;
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
    const health = await client.json("/api/system/health", { method: "GET" }, undefined, "Claude Code reuse health preflight");
    if (health.ok !== true || health.productionReady !== true) throw new Error("Production health preflight is not ready.");

    const poster = await signupSmokeUser(client, "poster", smokeId, env);
    contributor = await signupSmokeUser(client, "contributor", smokeId, env);

    const loginController = new AbortController();
    const loginTimeout = setTimeout(() => loginController.abort(), 280_000);
    loginTimeout.unref();
    try {
      const loginResponse = await client.request("/api/agent-home/claude-code/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayLabel: `Claude reuse proof ${smokeId}` }),
      }, contributor.jar, { step: "start Claude Code login", timeoutMs: 30_000 });
      const login = await readManagedLogin(
        loginResponse,
        client,
        contributor,
        stdout,
        loginController.signal,
        options.authorizationCodeProvider || readAuthorizationCodeFromStdin,
      );
      connectionId = login.connectionId;
      await assertSameReadyConnection(client, contributor, connectionId);

      challengeIds.push(await createProofChallenge(client, poster, smokeId, "a"));
      challengeIds.push(await createProofChallenge(client, poster, smokeId, "b"));

      const runA = await proveFreshApproval(client, contributor, challengeIds[0]!, connectionId, `claude-reuse-${smokeId}-a`);
      await assertSameReadyConnection(client, contributor, connectionId);
      const runB = await proveFreshApproval(client, contributor, challengeIds[1]!, connectionId, `claude-reuse-${smokeId}-b`);
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
      if (Object.values(distinct).some((value) => !value)) throw new Error(`Claude Code reuse proof did not isolate both runs: ${JSON.stringify(distinct)}`);

      successSummary = {
        ok: true,
        mode: "production_claude_code_reuse_proof",
        base: base.origin,
        smoke_id: smokeId,
        authentication_events: login.authorizationEvents,
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
    stderr(JSON.stringify({ ok: false, code: "CLAUDE_CODE_REUSE_PRODUCTION_PROOF_FAILED", reason: safeError(error), challenge_ids: challengeIds, connection_id: connectionId || undefined }, null, 2));
  } finally {
    if (contributor && connectionId) {
      try { await revokeSmokeConnection(client, contributor, connectionId); } catch (error) { stderr(JSON.stringify({ ok: false, code: "CLAUDE_CODE_REUSE_CONNECTION_CLEANUP_FAILED", reason: safeError(error), connection_id: connectionId })); success = false; }
    }
    for (const challengeId of challengeIds) {
      try { await cleanupSmokeChallenge(client, cleanupMode, challengeId, `/answers/${challengeId}`, smokeId, env); } catch (error) { stderr(JSON.stringify({ ok: false, code: "CLAUDE_CODE_REUSE_CHALLENGE_CLEANUP_FAILED", reason: safeError(error), challenge_id: challengeId })); success = false; }
    }
  }

  if (success && successSummary) {
    try {
      successSummary.sandbox_cleanup = await assertNoActiveRailwaySandboxes(env, receiptSandboxIds, options.listActiveSandboxIds);
    } catch (error) {
      stderr(JSON.stringify({ ok: false, code: "CLAUDE_CODE_REUSE_SANDBOX_CLEANUP_FAILED", reason: safeError(error) }, null, 2));
      success = false;
    }
  }
  if (success && successSummary) stdout(JSON.stringify(successSummary, null, 2));
  return success ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  process.exitCode = await runClaudeCodeReuseProductionProof();
}
