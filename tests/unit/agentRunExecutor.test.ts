import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeHermesRunBroker } from "@/lib/sandbox/fakeHermesRunBroker";
import { createRailwaySandboxBroker } from "@/lib/sandbox/railwayBroker";
import { verifyHermesRunReceipt } from "@/lib/provenance/receipts";
import { createChallenge, listContributions, resetStoreForTests } from "@/lib/store";
import { executeAgentRunContribution, type AgentRunDelegationService, type AgentRunExecutorInput } from "@/lib/agent-home/runExecutor";
import type { AgentConnectionDelegation, ChallengeBrief } from "@/lib/types";
import { createChallengeSemantics } from "@/lib/challenges/intent";

const signingKey = { keyId: "executor-test", secret: "executor-secret" };

const brief: ChallengeBrief = {
  schema_version: "1.0",
  ...createChallengeSemantics({ intent: "solve", successCriteria: ["Find risky assumptions"], status: "confirmed", changeReason: "Confirmed Agent run executor fixture criteria." }),
  title: "Executor challenge",
  category: "product",
  challenge_mode_requested: ["critique", "red_team"],
  problem_statement: "Pressure-test this answer.",
  original_ai_answer: "Ship it as-is.",
  context: "Local test context.",
  constraints: ["No code execution from the challenge."],
  success_criteria: ["Find risky assumptions"],
  assumptions_to_test: ["Users want this exact flow"],
  claims_to_check: ["The answer is safe to act on"],
  known_risks: ["False confidence"],
  what_a_useful_response_should_address: ["Risks", "Alternatives"],
  privacy_sensitivity: "public_ok",
  redactions_made: [],
  abuse_or_safety_flags: [],
  missing_information: [],
  raw_material_summary: "Agent-run executor test challenge",
};

function createDelegationService(overrides: Partial<AgentConnectionDelegation> = {}) {
  const delegation: AgentConnectionDelegation = {
    delegation_id: "delegation_1",
    connection_id: "conn_1",
    agent_connection_id: "agent_conn_1",
    provider: "fake-provider",
    allowed_model: "fake-model",
    allowed_request_class: "challenge_contribution",
    expires_at: "2026-06-28T01:00:00.000Z",
    max_requests: 1,
    ...overrides,
  };

  const service: AgentRunDelegationService = {
    mintDelegation: vi.fn(async () => ({ delegation })),
    consumeDelegation: vi.fn(async () => undefined),
    revokeDelegation: vi.fn(async () => undefined),
  };
  return { service, delegation };
}

async function baseInput(overrides: Partial<AgentRunExecutorInput> = {}): Promise<AgentRunExecutorInput> {
  const challenge = await createChallenge({ posterId: "poster", visibility: "public", reward: 10, brief });
  const { service } = createDelegationService();
  return {
    runId: "run_executor_1",
    challengeId: challenge.id,
    contributor: { id: "agent-runner", label: "Runner Agent", ownerId: "owner-test" },
    connection: { id: "conn_1", provider: "fake-provider", requestedModel: "fake-model", modelDisplayName: "Fake Model" },
    contributionMode: "critique",
    broker: createFakeHermesRunBroker({ signingKey, forgeTrustedMetadata: true }),
    receiptSigningKey: signingKey,
    delegationService: service,
    ...overrides,
  };
}

describe("agent run executor", () => {
  beforeEach(async () => {
    await resetStoreForTests();
  });

  it("executes a fake broker run, consumes one delegation, validates receipt proof, and posts exactly one sandbox contribution", async () => {
    const states: string[] = [];
    const input = await baseInput({ recordRunState: async (state) => { states.push(state.status); } });

    const first = await executeAgentRunContribution(input);

    expect(first.status).toBe("contributed");
    if (first.status !== "contributed") throw new Error("Expected first run to contribute.");
    expect(first.reusedContribution).toBe(false);
    expect(first.receipt && verifyHermesRunReceipt(first.receipt, signingKey)).toBe(true);
    expect(first.contribution?.card.model_provenance).toMatchObject({
      source: "hermes_sandbox_run",
      provider: "fake-provider",
      run_id: "run_executor_1",
      sandbox_provider: "local_fake",
      verified: false,
    });
    expect(first.contribution?.card.model_provenance?.receipt_id).not.toBe("forged-receipt");
    expect(input.delegationService.consumeDelegation).toHaveBeenCalledTimes(1);
    expect(input.delegationService.revokeDelegation).not.toHaveBeenCalled();
    expect(states).toEqual(["queued", "preparing_delegation", "running_cell", "validating_artifacts", "contributed"]);

    const second = await executeAgentRunContribution(input);
    expect(second.status).toBe("contributed");
    if (second.status !== "contributed") throw new Error("Expected second run to reuse contribution.");
    expect(second.reusedContribution).toBe(true);
    expect(await listContributions(input.challengeId)).toHaveLength(1);
    expect(input.delegationService.consumeDelegation).toHaveBeenCalledTimes(1);
  });

  it("passes adapter child-run delegation config into the broker request without exposing secrets", async () => {
    const { delegation } = createDelegationService();
    const childRunConfig = {
      run_id: "run_executor_1",
      delegation_id: delegation.delegation_id || "delegation_1",
      agent_connection_id: delegation.agent_connection_id || delegation.connection_id,
      provider: delegation.provider,
      allowed_model: delegation.allowed_model,
      allowed_request_class: "contribution_card",
      expires_at: delegation.expires_at,
      max_requests: 1,
      max_spend_cents: 25,
      model_proxy_url: "https://broker.example.test/model-proxy",
    };
    const delegationService: AgentRunDelegationService = {
      mintDelegation: vi.fn(async () => ({ delegation, childRunConfig })),
      consumeDelegation: vi.fn(async () => undefined),
      revokeDelegation: vi.fn(async () => undefined),
    };
    const baseBroker = createFakeHermesRunBroker({ signingKey, forgeTrustedMetadata: true });
    const broker = {
      run: vi.fn(async (request: Parameters<typeof baseBroker.run>[0]) => {
        expect(request.childRunConfig).toMatchObject(childRunConfig);
        expect(JSON.stringify(request.childRunConfig)).not.toContain("secret");
        return baseBroker.run(request);
      }),
    };
    const input = await baseInput({ broker, delegationService });

    const result = await executeAgentRunContribution(input);

    expect(result.status).toBe("contributed");
    expect(broker.run).toHaveBeenCalledTimes(1);
    expect(delegationService.consumeDelegation).toHaveBeenCalledTimes(1);
  });

  it("fails closed on sandbox policy rejection without posting or consuming the delegation", async () => {
    const input = await baseInput({ brokerPolicy: { network: "private" } });

    const result = await executeAgentRunContribution(input);

    expect(result).toMatchObject({ status: "failed", failureCode: "sandbox_policy_rejected" });
    expect(await listContributions(input.challengeId)).toHaveLength(0);
    expect(input.delegationService.consumeDelegation).not.toHaveBeenCalled();
    expect(input.delegationService.revokeDelegation).toHaveBeenCalledTimes(1);
  });

  it("fails closed on invalid contribution-card artifacts before consuming the one-run delegation", async () => {
    const input = await baseInput({ broker: createFakeHermesRunBroker({ signingKey, failMode: "invalid_card" }) });

    const result = await executeAgentRunContribution(input);

    expect(result).toMatchObject({ status: "failed", failureCode: "invalid_contribution_card" });
    expect(await listContributions(input.challengeId)).toHaveLength(0);
    expect(input.delegationService.consumeDelegation).not.toHaveBeenCalled();
    expect(input.delegationService.revokeDelegation).toHaveBeenCalledTimes(1);
  });

  it("fails closed when receipt verification fails", async () => {
    const goodBroker = createFakeHermesRunBroker({ signingKey });
    const tamperingBroker = {
      async run(request: Parameters<typeof goodBroker.run>[0]) {
        const outcome = await goodBroker.run(request);
        return { ...outcome, receipt: { ...outcome.receipt, challenge_id: "tampered-challenge" } };
      },
    };
    const input = await baseInput({ broker: tamperingBroker });

    const result = await executeAgentRunContribution(input);

    expect(result).toMatchObject({ status: "failed", failureCode: "receipt_verification_failed" });
    expect(await listContributions(input.challengeId)).toHaveLength(0);
    expect(input.delegationService.consumeDelegation).toHaveBeenCalledTimes(1);
  });

  it("fails closed when receipt artifact hashes do not match the raw card", async () => {
    const goodBroker = createFakeHermesRunBroker({ signingKey });
    const tamperingBroker = {
      async run(request: Parameters<typeof goodBroker.run>[0]) {
        const outcome = await goodBroker.run(request);
        return { ...outcome, rawCard: { ...outcome.rawCard, verdict: "Tampered after receipt signing." } };
      },
    };
    const input = await baseInput({ broker: tamperingBroker });

    const result = await executeAgentRunContribution(input);

    expect(result).toMatchObject({ status: "failed", failureCode: "receipt_artifact_mismatch" });
    expect(await listContributions(input.challengeId)).toHaveLength(0);
    expect(input.delegationService.consumeDelegation).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the posted card differs from the receipt-bound raw card", async () => {
    const goodBroker = createFakeHermesRunBroker({ signingKey });
    const tamperingBroker = {
      async run(request: Parameters<typeof goodBroker.run>[0]) {
        const outcome = await goodBroker.run(request);
        return { ...outcome, card: { ...outcome.card, verdict: "Tampered posted card after receipt signing." } };
      },
    };
    const input = await baseInput({ broker: tamperingBroker });

    const result = await executeAgentRunContribution(input);

    expect(result).toMatchObject({ status: "failed", failureCode: "receipt_verification_failed" });
    expect(await listContributions(input.challengeId)).toHaveLength(0);
    expect(input.delegationService.consumeDelegation).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the sandbox returns a contribution mode different from the approved run", async () => {
    const goodBroker = createFakeHermesRunBroker({ signingKey });
    const mismatchedModeBroker = {
      async run(request: Parameters<typeof goodBroker.run>[0]) {
        return await goodBroker.run({ ...request, contributionMode: "red_team" });
      },
    };
    const input = await baseInput({ broker: mismatchedModeBroker, contributionMode: "critique" });

    const result = await executeAgentRunContribution(input);

    expect(result).toMatchObject({ status: "failed", failureCode: "receipt_verification_failed" });
    expect(await listContributions(input.challengeId)).toHaveLength(0);
    expect(input.delegationService.consumeDelegation).toHaveBeenCalledTimes(1);
  });

  it("revokes the one-run delegation when the child runner model-proxy path fails before artifacts", async () => {
    const broker = {
      run: vi.fn(async () => {
        throw new Error("RUNNER_MODEL_PROXY_REJECTED");
      }),
    };
    const input = await baseInput({ broker });

    const result = await executeAgentRunContribution(input);

    expect(result).toMatchObject({ status: "failed", failureCode: "sandbox_run_failed" });
    expect(await listContributions(input.challengeId)).toHaveLength(0);
    expect(input.delegationService.consumeDelegation).not.toHaveBeenCalled();
    expect(input.delegationService.revokeDelegation).toHaveBeenCalledTimes(1);
    expect(input.delegationService.revokeDelegation).toHaveBeenCalledWith(expect.objectContaining({ delegation_id: "delegation_1" }), expect.objectContaining({ runId: "run_executor_1", reason: "sandbox_run_failed" }));
  });

  it("maps unavailable Railway sandbox prerequisites to a stable failure without changing lane semantics", async () => {
    const input = await baseInput({ broker: createRailwaySandboxBroker({}, signingKey) });

    const result = await executeAgentRunContribution(input);

    expect(result).toMatchObject({ status: "failed", failureCode: "railway_sandbox_unavailable" });
    expect(await listContributions(input.challengeId)).toHaveLength(0);
    expect(input.delegationService.consumeDelegation).not.toHaveBeenCalled();
    expect(input.delegationService.revokeDelegation).toHaveBeenCalledTimes(1);
  });
});
