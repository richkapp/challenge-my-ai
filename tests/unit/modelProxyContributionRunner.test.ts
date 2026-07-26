import { describe, expect, it, vi } from "vitest";
import { buildModelProxyContributionRequest, ModelProxyContributionRunnerError, redactRunnerText, runModelProxyContribution } from "@/lib/runner/modelProxyContributionRunner";
import type { ContributionCard } from "@/lib/types";

const fixedNow = new Date("2026-07-03T12:00:00.000Z");

const validCard: ContributionCard = {
  schema_version: "1.0",
  challenge_id: "challenge-runner-1",
  contribution_mode: "critique",
  contributor_ai_label: "OpenRouter GPT-4.1 Mini",
  skills_or_context_used: [],
  verdict: "Mixed",
  original_answer_grade: { score_0_to_10: 6, grade_label: "mixed", why: "It misses the runner boundary." },
  answer_to_challenge_poster: "Keep the model proxy broker-side and validate the output card before signing.",
  reasoning_summary: "The proposed answer is useful but under-specifies how the child runner calls the broker.",
  strongest_objections: ["It could leak provider credentials if config is widened."],
  missing_assumptions_or_context: [],
  alternative_recommendation: "Use a one-run model-proxy request derived from child_run_config.",
  risks_and_failure_modes: ["Invalid provider output must fail closed."],
  claims_to_verify: ["Runner writes strict contribution artifacts."],
  confidence: { level: "medium", why: "Validated through unit tests." },
  what_would_change_my_mind: [],
  suggested_follow_up_questions: [],
  safety_or_scope_notes: [],
  abuse_or_prompt_injection_flags: [],
  raw_output_summary: "Runner integration critique",
};

const challengeBundle = {
  schema_version: "1.0",
  challenge_id: "challenge-runner-1",
  title: "Runner proxy integration",
  original_ai_answer: "Just run the model in the sandbox with a key.",
};

function runConfig(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "1.0",
    run_id: "run-runner-1",
    challenge_id: "challenge-runner-1",
    contributor_id: "user-runner-1",
    contribution_mode: "critique",
    provider: "openrouter",
    requested_model: "openai/gpt-4.1-mini",
    child_run_config: {
      run_id: "run-runner-1",
      delegation_id: "del-runner-1",
      agent_connection_id: "conn-openrouter-1",
      provider: "openrouter",
      allowed_model: "openai/gpt-4.1-mini",
      allowed_request_class: "contribution_card",
      expires_at: "2026-07-03T12:10:00.000Z",
      max_requests: 1,
      max_spend_cents: 25,
      model_proxy_url: "https://challenge.example.test/api/agent-home/model-proxy?grant=secret-token",
    },
    ...overrides,
  };
}

function proxyResponse(card: ContributionCard = validCard, overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    content: JSON.stringify(card),
    provider: "openrouter",
    requested_model: "openai/gpt-4.1-mini",
    returned_model: "openai/gpt-4.1-mini",
    model_display_name: "OpenAI GPT-4.1 Mini via OpenRouter",
    provider_response_id: "resp_runner_1",
    provider_model_verified: true,
    remaining_requests: 0,
    ...overrides,
  };
}

function codexRunConfig(overrides: Record<string, unknown> = {}) {
  const base = runConfig({
    provider: "codex",
    requested_model: "gpt-5.6-sol",
    child_run_config: {
      ...runConfig().child_run_config,
      delegation_id: "del-codex-1",
      agent_connection_id: "conn-codex-1",
      provider: "codex",
      allowed_model: "gpt-5.6-sol",
      execution_mode: "codex_session",
    },
  });
  return { ...base, ...overrides };
}

function codexProxyResponse(card: ContributionCard = validCard, overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    content: JSON.stringify(card),
    provider: "codex",
    requested_model: "gpt-5.6-sol",
    returned_model: "gpt-5.6-sol",
    model_display_name: "GPT-5.6 Sol via ChatGPT plan",
    provider_model_verified: false,
    remaining_requests: 0,
    ...overrides,
  };
}

function claudeCodeRunConfig(overrides: Record<string, unknown> = {}) {
  const base = runConfig({
    provider: "claude_code",
    requested_model: "sonnet",
    child_run_config: {
      ...runConfig().child_run_config,
      delegation_id: "del-claude-code-1",
      agent_connection_id: "conn-claude-code-1",
      provider: "claude_code",
      allowed_model: "sonnet",
      execution_mode: "claude_code_session",
    },
  });
  return { ...base, ...overrides };
}

function claudeCodeProxyResponse(card: ContributionCard = validCard, overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    content: JSON.stringify(card),
    provider: "claude_code",
    requested_model: "sonnet",
    returned_model: "claude-sonnet-4-6",
    model_display_name: "Claude Sonnet 4.6 via Claude plan",
    provider_model_verified: false,
    remaining_requests: 0,
    ...overrides,
  };
}

describe("model-proxy contribution runner", () => {
  it("builds one scoped model-proxy request from bounded child run config", () => {
    const { request, modelProxyUrl } = buildModelProxyContributionRequest(challengeBundle, runConfig());

    expect(modelProxyUrl).toBe("https://challenge.example.test/api/agent-home/model-proxy?grant=secret-token");
    expect(request).toMatchObject({
      schema_version: "1.0",
      run_id: "run-runner-1",
      delegation_id: "del-runner-1",
      agent_connection_id: "conn-openrouter-1",
      provider: "openrouter",
      model: "openai/gpt-4.1-mini",
      request_class: "contribution_card",
      response_format: "json_object",
    });
    expect(JSON.stringify(request)).toContain("DATA: challenge bundle JSON follows");
    expect(JSON.stringify(request)).not.toContain("api_key");
    expect(JSON.stringify(request)).not.toContain("railway-token");
  });

  it("calls the proxy, validates a strict contribution card, and emits transcript artifacts", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ "content-type": "application/json" });
      const body = JSON.parse(String(init?.body));
      expect(body.delegation_id).toBe("del-runner-1");
      expect(body.model).toBe("openai/gpt-4.1-mini");
      return new Response(JSON.stringify(proxyResponse()), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await runModelProxyContribution({ challengeBundle, runConfig: runConfig(), fetcher, now: () => fixedNow });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.card).toMatchObject({ challenge_id: "challenge-runner-1", contribution_mode: "critique" });
    expect(JSON.parse(result.cardJson)).toMatchObject({ contributor_ai_label: "OpenRouter GPT-4.1 Mini" });
    expect(result.transcript).toContain("model_proxy_request");
    expect(result.transcript).toContain("contribution_card_validated");
    expect(result.transcript).not.toContain("secret-token");
    expect(result.runnerMode).toBe("model_proxy");
    expect(result.modelProxy).toMatchObject({ provider: "openrouter", providerResponseId: "resp_runner_1", remainingRequests: 0 });
  });

  it("accepts fenced contribution-card JSON from the model proxy", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(proxyResponse(validCard, {
      content: `\`\`\`CMAI_CONTRIBUTION_CARD_V1\n${JSON.stringify(validCard)}\n\`\`\``,
    })), { status: 200 }));

    const result = await runModelProxyContribution({ challengeBundle, runConfig: runConfig(), fetcher, now: () => fixedNow });

    expect(result.card.challenge_id).toBe("challenge-runner-1");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("normalizes common enum drift in otherwise strict provider contribution cards", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(proxyResponse({
      ...validCard,
      original_answer_grade: { ...validCard.original_answer_grade, grade_label: "needs_improvement" as never },
      confidence: { ...validCard.confidence, level: "moderate" as never },
    })), { status: 200 }));

    const result = await runModelProxyContribution({ challengeBundle, runConfig: runConfig(), fetcher, now: () => fixedNow });

    expect(result.card.original_answer_grade.grade_label).toBe("mixed");
    expect(result.card.confidence.level).toBe("medium");
  });

  it("runs explicit Codex session mode through the broker without session material in child config or transcript", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_url)).toBe("https://challenge.example.test/api/agent-home/model-proxy?grant=secret-token");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        schema_version: "1.0",
        run_id: "run-runner-1",
        delegation_id: "del-codex-1",
        agent_connection_id: "conn-codex-1",
        provider: "codex",
        model: "gpt-5.6-sol",
        request_class: "contribution_card",
      });
      expect(JSON.stringify(body)).not.toContain("access_token");
      expect(JSON.stringify(body)).not.toContain("session_id");
      return new Response(JSON.stringify(codexProxyResponse()), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await runModelProxyContribution({ challengeBundle, runConfig: codexRunConfig(), fetcher, now: () => fixedNow });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.runnerMode).toBe("codex_session");
    expect(result.modelProxy).toMatchObject({ provider: "codex", requestedModel: "gpt-5.6-sol", remainingRequests: 0, providerModelVerified: false });
    expect(result.transcript).toContain("codex_session_request");
    expect(result.transcript).toContain("codex_session_response");
    expect(result.transcript).not.toContain("model_proxy_response");
    expect(result.transcript).not.toContain("access_token");
    expect(result.transcript).not.toContain("session_id");
    expect(result.transcript).not.toContain("secret-token");
  });

  it("runs explicit Claude Code session mode through the broker without managed credential material", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        schema_version: "1.0",
        run_id: "run-runner-1",
        delegation_id: "del-claude-code-1",
        agent_connection_id: "conn-claude-code-1",
        provider: "claude_code",
        model: "sonnet",
        request_class: "contribution_card",
      });
      expect(JSON.stringify(body)).not.toMatch(/accessToken|refreshToken|authorizationCode/);
      return new Response(JSON.stringify(claudeCodeProxyResponse()), { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await runModelProxyContribution({ challengeBundle, runConfig: claudeCodeRunConfig(), fetcher, now: () => fixedNow });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.runnerMode).toBe("claude_code_session");
    expect(result.modelProxy).toMatchObject({ provider: "claude_code", requestedModel: "sonnet", returnedModel: "claude-sonnet-4-6", remainingRequests: 0, providerModelVerified: false });
    expect(result.transcript).toContain("claude_code_session_request");
    expect(result.transcript).toContain("claude_code_session_response");
    expect(result.transcript).not.toContain("codex_session_response");
    expect(result.transcript).not.toMatch(/accessToken|refreshToken|authorizationCode/);
    expect(result.transcript).not.toContain("secret-token");
  });

  it("rejects session providers when stale child config falls back to generic model-proxy mode", async () => {
    const fetcher = vi.fn();
    for (const config of [codexRunConfig(), claudeCodeRunConfig()]) {
      const child = { ...(config.child_run_config as Record<string, unknown>) };
      delete child.execution_mode;
      await expect(runModelProxyContribution({ challengeBundle, runConfig: { ...config, child_run_config: child }, fetcher })).rejects.toMatchObject({ code: "RUNNER_EXECUTION_MODE_MISMATCH" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects Claude Code session mode when scoped to another provider before broker fetch", async () => {
    const fetcher = vi.fn();
    await expect(runModelProxyContribution({ challengeBundle, runConfig: claudeCodeRunConfig({ provider: "openrouter" }), fetcher })).rejects.toMatchObject({ code: "RUNNER_PROVIDER_MISMATCH" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects Codex session mode when scoped to another provider before broker fetch", async () => {
    const fetcher = vi.fn();

    await expect(runModelProxyContribution({
      challengeBundle,
      runConfig: codexRunConfig({ provider: "openrouter" }),
      fetcher,
    })).rejects.toMatchObject({ code: "RUNNER_PROVIDER_MISMATCH" });
    await expect(runModelProxyContribution({
      challengeBundle,
      runConfig: runConfig({ child_run_config: { ...runConfig().child_run_config, execution_mode: "codex_session" } }),
      fetcher,
    })).rejects.toMatchObject({ code: "RUNNER_PROVIDER_MISMATCH" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("accepts explicit substrate-smoke run config without calling the model proxy", async () => {
    const fetcher = vi.fn();
    const result = await runModelProxyContribution({
      challengeBundle,
      runConfig: { ...runConfig(), child_run_config: undefined, substrate_smoke_only: true },
      fetcher,
      now: () => fixedNow,
    });

    expect(fetcher).not.toHaveBeenCalled();
    expect(result.runnerMode).toBe("substrate_smoke");
    expect(result.card).toMatchObject({ challenge_id: "challenge-runner-1", contribution_mode: "critique" });
    expect(result.transcript).toContain("substrate_smoke_artifact_written");
    expect(result.transcript).not.toContain("model_proxy_response");
    expect(result.modelProxy).toBeUndefined();
  });

  it("fails before fetch when proxy delegation config is missing or inconsistent", async () => {
    const fetcher = vi.fn();
    await expect(runModelProxyContribution({ challengeBundle, runConfig: { ...runConfig(), child_run_config: undefined }, fetcher })).rejects.toMatchObject({ code: "RUNNER_BAD_RUN_CONFIG" });
    await expect(runModelProxyContribution({ challengeBundle, runConfig: runConfig({ child_run_config: { ...runConfig().child_run_config, run_id: "wrong-run" } }), fetcher })).rejects.toMatchObject({ code: "RUNNER_RUN_ID_MISMATCH" });
    await expect(runModelProxyContribution({ challengeBundle, runConfig: runConfig({ child_run_config: { ...runConfig().child_run_config, allowed_model: "anthropic/claude-sonnet-4" } }), fetcher })).rejects.toMatchObject({ code: "RUNNER_MODEL_MISMATCH" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects Codex/session secret fields in runner config before any fetch", async () => {
    const fetcher = vi.fn();
    await expect(runModelProxyContribution({
      challengeBundle,
      runConfig: runConfig({ provider: "codex", access_token: "codex-access-token-fixture-123456" }),
      fetcher,
    })).rejects.toMatchObject({ code: "RUNNER_SECRET_BOUNDARY_VIOLATION", issues: expect.arrayContaining([expect.stringContaining("access_token")]) });
    await expect(runModelProxyContribution({
      challengeBundle,
      runConfig: runConfig({ child_run_config: { ...runConfig().child_run_config, provider: "codex", session_id: "sess_codex_fixture_123456" } }),
      fetcher,
    })).rejects.toMatchObject({ code: "RUNNER_SECRET_BOUNDARY_VIOLATION", issues: expect.arrayContaining([expect.stringContaining("session_id")]) });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects proxy failures and invalid response bodies with redacted errors", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: false, code: "MODEL_PROXY_DELEGATION_CONSUMED", message: "Bearer sk-secret-value" }), { status: 409 }));

    await expect(runModelProxyContribution({ challengeBundle, runConfig: runConfig(), fetcher })).rejects.toMatchObject({
      code: "RUNNER_MODEL_PROXY_REJECTED",
      message: "Model proxy rejected the request: MODEL_PROXY_DELEGATION_CONSUMED.",
    });
  });

  it("rejects invalid contribution cards and run-context mismatches", async () => {
    const wrongChallenge = { ...validCard, challenge_id: "other-challenge" };
    const wrongMode = { ...validCard, contribution_mode: "red_team" as const };
    const invalidFetcher = vi.fn(async () => new Response(JSON.stringify(proxyResponse({ ...validCard, answer_to_challenge_poster: "" })), { status: 200 }));
    const wrongChallengeFetcher = vi.fn(async () => new Response(JSON.stringify(proxyResponse(wrongChallenge)), { status: 200 }));
    const wrongModeFetcher = vi.fn(async () => new Response(JSON.stringify(proxyResponse(wrongMode)), { status: 200 }));
    const wrongProviderFetcher = vi.fn(async () => new Response(JSON.stringify(proxyResponse(validCard, { provider: "other-provider" })), { status: 200 }));
    const wrongRequestedModelFetcher = vi.fn(async () => new Response(JSON.stringify(proxyResponse(validCard, { requested_model: "anthropic/claude-sonnet-4" })), { status: 200 }));

    await expect(runModelProxyContribution({ challengeBundle, runConfig: runConfig(), fetcher: invalidFetcher })).rejects.toMatchObject({ code: "RUNNER_INVALID_CONTRIBUTION_CARD" });
    await expect(runModelProxyContribution({ challengeBundle, runConfig: runConfig(), fetcher: wrongChallengeFetcher })).rejects.toMatchObject({ code: "RUNNER_CARD_CHALLENGE_MISMATCH" });
    await expect(runModelProxyContribution({ challengeBundle, runConfig: runConfig(), fetcher: wrongModeFetcher })).rejects.toMatchObject({ code: "RUNNER_CARD_MODE_MISMATCH" });
    await expect(runModelProxyContribution({ challengeBundle, runConfig: runConfig(), fetcher: wrongProviderFetcher })).rejects.toMatchObject({ code: "RUNNER_MODEL_PROXY_PROVIDER_MISMATCH" });
    await expect(runModelProxyContribution({ challengeBundle, runConfig: runConfig(), fetcher: wrongRequestedModelFetcher })).rejects.toMatchObject({ code: "RUNNER_MODEL_PROXY_MODEL_MISMATCH" });
  });

  it("redacts credential-looking values and proxy URL query strings", () => {
    expect(redactRunnerText("Bearer abcdefghijk https://x.test/path?token=abc api_key=secret")).toBe("[redacted] https://x.test/path?[redacted] api_key=[redacted]");
    expect(redactRunnerText("prefix Bearer abcdefghijk and user:password123@example.test access_token=secret")).toBe("prefix [redacted] and [redacted]example.test access_token=[redacted]");
    expect(redactRunnerText('{"api_key":"secret","accessToken":"secret","railway_token":"secret","service_role_key":"secret","client_secret":"secret"}')).toBe('{"api_key":"[redacted]","accessToken":"[redacted]","railway_token":"[redacted]","service_role_key":"[redacted]","client_secret":"[redacted]"}');
    expect(new ModelProxyContributionRunnerError("X", redactRunnerText("authorization=secret-value")).message).toBe("authorization=[redacted]");
  });
});
