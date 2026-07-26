import { pathToFileURL } from "node:url";
import { createFakeHermesRunBroker } from "../lib/sandbox/fakeHermesRunBroker";
import { approvedUntrustedRunnerProfile } from "../lib/sandbox/policy";
import { hashHermesRunReceipt, verifyHermesRunReceipt, type HermesReceiptSigningKey } from "../lib/provenance/receipts";
import type { ChallengeBrief } from "../lib/types";
import { RAILWAY_SMOKE_UNAVAILABLE_EXIT_CODE, runRailwaySandboxSmoke } from "./smoke-railway-sandbox";

export const AGENT_HOME_RUN_SMOKE_UNAVAILABLE_EXIT_CODE = RAILWAY_SMOKE_UNAVAILABLE_EXIT_CODE;

type AgentHomeRunSmokeEnv = Record<string, string | undefined>;
type AgentHomeRunSmokeLogger = (line: string) => void;
type AgentHomeRunSmokeMode = "fake" | "railway";

type FakeReadyAgentHome = {
  home_id: string;
  owner_id: string;
  display_label: string;
  connection: {
    id: string;
    provider: string;
    display_label: string;
    default_model: string;
    allowed_request_class: "challenge_contribution";
    readiness: "ready";
    last_smoke: {
      status: "passed";
      checked_at: string;
      runner_checkpoint: string;
    };
  };
};

function smokeMode(env: AgentHomeRunSmokeEnv): AgentHomeRunSmokeMode {
  return env.CMAI_AGENT_HOME_RUN_SMOKE_ADAPTER === "railway" ? "railway" : "fake";
}

function signingKeyFromEnv(env: AgentHomeRunSmokeEnv): HermesReceiptSigningKey {
  return {
    keyId: env.CMAI_RECEIPT_SIGNING_KEY_ID || "agent-home-smoke-local",
    secret: env.CMAI_RECEIPT_SIGNING_SECRET || "agent-home-smoke-local-secret",
  };
}

function buildFakeReadyAgentHome(): FakeReadyAgentHome {
  return {
    home_id: "ah_smoke_ready",
    owner_id: "smoke-contributor",
    display_label: "Smoke Test Agent Home",
    connection: {
      id: "conn_agent_home_smoke",
      provider: "fake-provider",
      display_label: "Smoke Test Agent",
      default_model: "fake-model-v1",
      allowed_request_class: "challenge_contribution",
      readiness: "ready",
      last_smoke: {
        status: "passed",
        checked_at: "2026-06-28T00:00:00.000Z",
        runner_checkpoint: approvedUntrustedRunnerProfile.checkpoint,
      },
    },
  };
}

function buildSmokeBrief(): ChallengeBrief {
  return {
    schema_version: "1.0",
    title: "Smoke test Agent Home run cell",
    category: "engineering",
    challenge_mode_requested: ["critique"],
    problem_statement: "Prove a ready Agent Home can dispatch one trusted fake run without exposing durable secrets.",
    original_ai_answer: "Reuse the same long-lived agent container for every challenge.",
    context: "This local smoke treats the challenge as inert data and exercises the fake broker path only.",
    constraints: ["Use a fresh child run cell", "Do not pass raw provider credentials", "Sign receipts broker-side"],
    success_criteria: ["Contribution posts once", "Receipt hashes are present", "Teardown is recorded"],
    assumptions_to_test: ["One-run delegation is enough for a contribution run"],
    claims_to_check: ["Sandbox proof does not imply exact model verification"],
    known_risks: ["Confusing the fake local broker with live Railway execution"],
    what_a_useful_response_should_address: ["Run state", "Receipt binding", "Manual paste fallback"],
    privacy_sensitivity: "public_ok",
    redactions_made: [],
    abuse_or_safety_flags: [],
    missing_information: ["Production provider adapter choice is still open"],
    raw_material_summary: "Operator smoke for the Agent Home / child run-cell proof path.",
  };
}

function buildChallengeBundle(agentHome: FakeReadyAgentHome, brief: ChallengeBrief) {
  return {
    schema_version: "CMAI_AGENT_HOME_RUN_SMOKE_V1",
    agent_home: {
      home_id: agentHome.home_id,
      connection_id: agentHome.connection.id,
      readiness: agentHome.connection.readiness,
      allowed_request_class: agentHome.connection.allowed_request_class,
    },
    challenge_brief: brief,
  };
}

export function summarizeAgentHomeRunSmoke(input: {
  agentHome: FakeReadyAgentHome;
  runId: string;
  challengeId: string;
  contributionId: string;
  receiptId: string;
  receiptSha256: string;
  source?: string;
  sandboxProvider: string;
  network: string;
  teardownCompleted: boolean;
  destroyed: boolean;
  providerModelVerified: boolean;
}) {
  return {
    ok: true,
    mode: "local_fake_agent_home",
    agent_home_id: input.agentHome.home_id,
    connection_id: input.agentHome.connection.id,
    readiness: input.agentHome.connection.readiness,
    run_id: input.runId,
    challenge_id: input.challengeId,
    contribution_id: input.contributionId,
    receipt_id: input.receiptId,
    receipt_sha256: input.receiptSha256,
    source: input.source,
    sandbox_provider: input.sandboxProvider,
    network: input.network,
    teardown_completed: input.teardownCompleted,
    destroyed: input.destroyed,
    provider_model_verified: input.providerModelVerified,
    exact_model_verified: input.providerModelVerified,
    manual_paste_fallback_available: true,
  };
}

export async function runAgentHomeRunSmoke(options: {
  env?: AgentHomeRunSmokeEnv;
  stdout?: AgentHomeRunSmokeLogger;
  stderr?: AgentHomeRunSmokeLogger;
} = {}): Promise<number> {
  const env = options.env || process.env;
  const stdout = options.stdout || console.log;
  const stderr = options.stderr || console.error;

  if (smokeMode(env) === "railway") {
    return runRailwaySandboxSmoke({ env, stdout, stderr });
  }

  try {
    const agentHome = buildFakeReadyAgentHome();
    const brief = buildSmokeBrief();
    const challengeId = "agent-home-smoke-challenge";
    const contributionId = "contrib_agent_home_smoke";

    const signingKey = signingKeyFromEnv(env);
    const broker = createFakeHermesRunBroker({ signingKey, sandboxId: "fake_agent_home_smoke_cell" });
    const outcome = await broker.run({
      runId: "run_agent_home_smoke",
      challengeId,
      contributorId: agentHome.owner_id,
      contributionMode: "critique",
      challengeBundle: buildChallengeBundle(agentHome, brief),
      provider: agentHome.connection.provider,
      requestedModel: agentHome.connection.default_model,
      modelDisplayName: agentHome.connection.display_label,
      agentConnection: {
        delegation_id: "deleg_agent_home_smoke_once",
        connection_id: agentHome.connection.id,
        agent_connection_id: agentHome.connection.id,
        provider: agentHome.connection.provider,
        allowed_model: agentHome.connection.default_model,
        allowed_request_class: agentHome.connection.allowed_request_class,
        expires_at: "2026-06-28T00:05:00.000Z",
        max_requests: 1,
        max_spend_cents: 0,
      },
    });

    if (!verifyHermesRunReceipt(outcome.receipt, signingKey)) {
      throw new Error("Agent Home smoke receipt signature verification failed.");
    }

    stdout(JSON.stringify(summarizeAgentHomeRunSmoke({
      agentHome,
      runId: outcome.runId,
      challengeId,
      contributionId,
      receiptId: outcome.receipt.receipt_id,
      receiptSha256: hashHermesRunReceipt(outcome.receipt),
      source: outcome.card.model_provenance?.source,
      sandboxProvider: outcome.receipt.sandbox.provider,
      network: outcome.receipt.sandbox.network_isolation,
      teardownCompleted: outcome.receipt.sandbox.teardown_completed,
      destroyed: outcome.destroyed,
      providerModelVerified: outcome.receipt.provider.provider_model_verified,
    }), null, 2));
    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    stderr(JSON.stringify({ ok: false, code: "AGENT_HOME_RUN_SMOKE_FAILED", reason }, null, 2));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const exitCode = await runAgentHomeRunSmoke();
  process.exitCode = exitCode;
}
