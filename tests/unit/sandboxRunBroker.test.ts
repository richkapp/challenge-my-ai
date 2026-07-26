import { describe, expect, it, vi } from "vitest";
import type { SandboxRunCellAdapter } from "@/lib/sandbox/broker";
import { executeHermesRunWithAdapter, SandboxRunArtifactError, SandboxRunPolicyError, validateHermesRunRequest, type HermesRunRequest, type NormalizedHermesRunRequest } from "@/lib/sandbox/broker";

const signingKey = { keyId: "broker-test", secret: "broker-secret" };

const baseRequest: HermesRunRequest = {
  challengeId: "challenge-1",
  contributorId: "user-1",
  contributionMode: "critique",
  challengeBundle: { title: "Test challenge", original_ai_answer: "Original" },
  provider: "fake-provider",
  requestedModel: "fake-model",
  agentConnection: {
    connection_id: "conn_1",
    provider: "fake-provider",
    allowed_model: "fake-model",
    expires_at: "2026-06-28T01:00:00.000Z",
    max_requests: 1,
  },
};

function adapter(spy = vi.fn()): SandboxRunCellAdapter {
  return {
    name: "test-adapter",
    sandboxProvider: "local_fake",
    run: async (request: NormalizedHermesRunRequest) => {
      spy(request);
      return {
        card: {
          schema_version: "1.0",
          challenge_id: request.challengeId,
          contribution_mode: request.contributionMode,
          contributor_ai_label: "Fake Model",
          skills_or_context_used: [],
          verdict: "Mixed",
          original_answer_grade: { score_0_to_10: 6, grade_label: "mixed", why: "Some gaps" },
          answer_to_challenge_poster: "Check assumptions.",
          reasoning_summary: "It misses constraints.",
          strongest_objections: ["Missing constraints"],
          missing_assumptions_or_context: [],
          alternative_recommendation: "Narrow scope.",
          risks_and_failure_modes: [],
          claims_to_verify: [],
          confidence: { level: "medium", why: "Enough context" },
          what_would_change_my_mind: [],
          suggested_follow_up_questions: [],
          safety_or_scope_notes: [],
          abuse_or_prompt_injection_flags: [],
          raw_output_summary: "Critique",
        },
        transcript: "started\nfinished\n",
        sandboxId: "fake_run",
        sandboxProvider: "local_fake",
        teardownCompleted: true,
        startedAt: "2026-06-28T00:00:00.000Z",
        completedAt: "2026-06-28T00:00:01.000Z",
        durationMs: 1000,
      };
    },
  };
}

function adapterWithCardOverride(cardOverride: Record<string, unknown>): SandboxRunCellAdapter {
  const base = adapter();
  return {
    ...base,
    run: async (request) => {
      const evidence = await base.run(request);
      return { ...evidence, card: { ...evidence.card, ...cardOverride } };
    },
  };
}

describe("sandbox run broker policy guard", () => {
  it("accepts the default untrusted request and produces a broker-signed sandbox receipt", async () => {
    const outcome = await executeHermesRunWithAdapter(adapter(), baseRequest, signingKey);

    expect(outcome.card.model_provenance?.source).toBe("hermes_sandbox_run");
    expect(outcome.card.model_provenance?.sandbox_provider).toBe("local_fake");
    expect(outcome.receipt.sandbox.network_isolation).toBe("ISOLATED");
    expect(outcome.receipt.funding_source).toBe("user_provider_access");
    expect(outcome.receipt.execution_authority).toBe("cmai_sandbox");
    expect(outcome.receipt.network_policy).toContain("ISOLATED");
    expect(outcome.destroyed).toBe(true);
  });

  it("rejects sandbox cards that do not match the approved challenge or mode before signing", async () => {
    await expect(executeHermesRunWithAdapter(adapterWithCardOverride({ challenge_id: "wrong-challenge" }), baseRequest, signingKey)).rejects.toBeInstanceOf(SandboxRunArtifactError);
    await expect(executeHermesRunWithAdapter(adapterWithCardOverride({ contribution_mode: "red_team" }), baseRequest, signingKey)).rejects.toMatchObject({
      code: "SANDBOX_RUN_ARTIFACT_REJECTED",
    });
  });

  it("rejects private networking for untrusted runs before adapter execution", async () => {
    const spy = vi.fn();
    await expect(executeHermesRunWithAdapter(adapter(spy), { ...baseRequest, policy: { network: "private" } }, signingKey)).rejects.toBeInstanceOf(SandboxRunPolicyError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("ignores generic proxy evidence for a Claude session provider", async () => {
    const request: HermesRunRequest = {
      ...baseRequest,
      provider: "claude_code",
      requestedModel: "sonnet",
      fundingSource: "external_user_subscription",
      agentConnection: {
        connection_id: "conn_claude_1",
        delegation_id: "del_claude_1",
        agent_connection_id: "conn_claude_1",
        provider: "claude_code",
        allowed_model: "sonnet",
        allowed_request_class: "contribution_card",
        expires_at: "2026-06-28T01:00:00.000Z",
        max_requests: 1,
      },
    };
    const base = adapter();
    const mismatchedEvidence: SandboxRunCellAdapter = {
      ...base,
      run: async (normalized) => {
        const evidence = await base.run(normalized);
        return {
          ...evidence,
          transcript: [{ event: "model_proxy_response", run_id: normalized.runId, delegation_id: "del_claude_1", agent_connection_id: "conn_claude_1", provider: "claude_code", request_class: "contribution_card", requested_model: "sonnet", returned_model: "forged-model", provider_model_verified: true, remaining_requests: 0 }],
        };
      },
    };
    const outcome = await executeHermesRunWithAdapter(mismatchedEvidence, request, signingKey);
    expect(outcome.receipt.provider.returned_model).toBeUndefined();
    expect(outcome.receipt.provider.provider_model_verified).toBe(false);
  });

  it("rejects raw provider, OAuth, database, signing, and child-run secrets", () => {
    const issues = validateHermesRunRequest({
      ...baseRequest,
      childRunConfig: {
        run_id: "run_1",
        delegation_id: "del_1",
        model_proxy_url: "https://broker.example.test/model-proxy",
        refresh_token: "oauth-secret",
      },
      config: {
        env: {
          DATABASE_URL: "postgres://secret",
          OPENAI_API_KEY: "sk-secret",
          oauth_access_token: "oauth-secret",
          authorizationCode: "one-time-secret",
          setupToken: "setup-secret",
          RECEIPT_SIGNING_SECRET: "signing-secret",
        },
      },
    });

    expect(issues.join("\n")).toContain("DATABASE_URL");
    expect(issues.join("\n")).toContain("OPENAI_API_KEY");
    expect(issues.join("\n")).toContain("oauth_access_token");
    expect(issues.join("\n")).toContain("authorizationCode");
    expect(issues.join("\n")).toContain("setupToken");
    expect(issues.join("\n")).toContain("refresh_token");
    expect(issues.join("\n")).toContain("RECEIPT_SIGNING_SECRET");
  });

  it("rejects untrusted runner overrides before adapter execution", async () => {
    const spy = vi.fn();
    await expect(executeHermesRunWithAdapter(adapter(spy), {
      ...baseRequest,
      runner: { checkpoint: "attacker", command: "bash", mountedTools: ["shell"] },
    }, signingKey)).rejects.toBeInstanceOf(SandboxRunPolicyError);
    expect(spy).not.toHaveBeenCalled();
  });

  it("allows trusted internal private networking while recording it in the receipt", async () => {
    const outcome = await executeHermesRunWithAdapter(adapter(), { ...baseRequest, trustedInternal: true, policy: { network: "private" } }, signingKey);
    expect(outcome.receipt.sandbox.network_isolation).toBe("PRIVATE");
    expect(outcome.receipt.execution_authority).toBe("cmai_broker");
  });
});
