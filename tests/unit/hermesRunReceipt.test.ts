import { describe, expect, it } from "vitest";
import { approvedUntrustedRunnerProfile } from "@/lib/sandbox/policy";
import type { ContributionCard } from "@/lib/types";
import { attachReceiptProvenanceToCard, buildHermesRunReceipt, canonicalJson, hashOutputCard, hashPromptBundle, hashTranscript, hermesRunReceiptSchema, modelProvenanceFromReceipt, verifyHermesRunReceipt, verifyHermesRunReceiptArtifacts } from "@/lib/provenance/receipts";

const signingKey = { keyId: "test-key", secret: "test-secret" };

const outputCard: ContributionCard = {
  schema_version: "1.0",
  challenge_id: "challenge-1",
  contribution_mode: "critique",
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
};

function buildReceipt(overrides = {}) {
  return buildHermesRunReceipt({
    receipt_id: "hr_test",
    run_id: "run_1",
    challenge_id: "challenge-1",
    contributor_id: "user-1",
    funding_source: "user_provider_access",
    execution_authority: "cmai_sandbox",
    delegation: {
      connection_id: "conn_1",
      provider: "fake-provider",
      allowed_model: "fake-model",
      expires_at: "2026-06-28T01:00:00.000Z",
      max_requests: 1,
    },
    provider: {
      provider: "fake-provider",
      requested_model: "fake-model",
      model_display_name: "Fake Model",
      provider_model_verified: false,
    },
    runner: { profile: approvedUntrustedRunnerProfile.profile, checkpoint: approvedUntrustedRunnerProfile.checkpoint },
    sandbox: { provider: "local_fake", sandbox_id: "fake_run_1", network_isolation: "ISOLATED", teardown_completed: true },
    tool_policy: "cmai-blank-slate-no-tools",
    network_policy: "ISOLATED/no-private-network/no-broker-secrets",
    promptBundle: { title: "Test", nested: { b: 2, a: 1 } },
    outputCard,
    transcript: [{ event: "a" }, { event: "b" }],
    timing: { started_at: "2026-06-28T00:00:00.000Z", completed_at: "2026-06-28T00:00:02.000Z", duration_ms: 2000 },
    signingKey,
    ...overrides,
  });
}

describe("Hermes run receipts", () => {
  it("canonicalizes object keys for deterministic hashes", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(hashPromptBundle({ b: 2, a: 1 })).toBe(hashPromptBundle({ a: 1, b: 2 }));
  });

  it("hashes transcript record order and normalized trailing newline deterministically", () => {
    expect(hashTranscript("one\ntwo")).toBe(hashTranscript("one\ntwo\n"));
    expect(hashTranscript([{ event: "one" }, { event: "two" }])).not.toBe(hashTranscript([{ event: "two" }, { event: "one" }]));
  });

  it("builds and verifies a broker-signed receipt", () => {
    const receipt = buildReceipt();

    expect(receipt.artifacts.prompt_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(receipt.artifacts.output_sha256).toBe(hashOutputCard(outputCard));
    expect(verifyHermesRunReceipt(receipt, signingKey)).toBe(true);
    expect(verifyHermesRunReceiptArtifacts({
      receipt,
      signingKey,
      promptBundle: { title: "Test", nested: { b: 2, a: 1 } },
      outputCard,
      transcript: [{ event: "a" }, { event: "b" }],
    })).toBe(true);
    expect(hermesRunReceiptSchema.safeParse(receipt).success).toBe(true);
  });

  it("fails artifact verification when the posted artifacts differ from signed hashes", () => {
    const receipt = buildReceipt();

    expect(verifyHermesRunReceiptArtifacts({
      receipt,
      signingKey,
      promptBundle: { title: "Tampered" },
      outputCard,
      transcript: [{ event: "a" }, { event: "b" }],
    })).toBe(false);
    expect(verifyHermesRunReceiptArtifacts({
      receipt,
      signingKey,
      promptBundle: { title: "Test", nested: { b: 2, a: 1 } },
      outputCard: { ...outputCard, verdict: "Tampered" },
      transcript: [{ event: "a" }, { event: "b" }],
    })).toBe(false);
    expect(verifyHermesRunReceiptArtifacts({
      receipt,
      signingKey,
      promptBundle: { title: "Test", nested: { b: 2, a: 1 } },
      outputCard,
      transcript: [{ event: "a" }, { event: "tampered" }],
    })).toBe(false);
  });

  it("invalidates the signature when signed fields are tampered", () => {
    const receipt = buildReceipt();
    expect(verifyHermesRunReceipt({ ...receipt, sandbox: { ...receipt.sandbox, provider: "railway" } }, signingKey)).toBe(false);
    expect(verifyHermesRunReceipt({ ...receipt, sandbox: { ...receipt.sandbox, network_isolation: "PRIVATE" } }, signingKey)).toBe(false);
    expect(verifyHermesRunReceipt({ ...receipt, sandbox: { ...receipt.sandbox, teardown_completed: false } }, signingKey)).toBe(false);
    expect(verifyHermesRunReceipt({ ...receipt, timing: { ...receipt.timing, duration_ms: 9999 } }, signingKey)).toBe(false);
  });

  it("rejects unknown top-level receipt fields", () => {
    const receipt = buildReceipt();
    const result = hermesRunReceiptSchema.safeParse({ ...receipt, surprise: true });
    expect(result.success).toBe(false);
  });

  it("creates card provenance that does not claim exact model verification", () => {
    const provenance = modelProvenanceFromReceipt(buildReceipt());
    expect(provenance.source).toBe("hermes_sandbox_run");
    expect(provenance.verified).toBe(false);
    expect(provenance.provider_model_verified).toBe(false);
    expect(provenance.sandbox_provider).toBe("local_fake");
    expect(provenance.prompt_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("upgrades provenance when receipt-bound provider metadata is present", () => {
    const provenance = modelProvenanceFromReceipt(buildReceipt({
      provider: {
        provider: "openrouter",
        requested_model: "openai/gpt-4.1-mini",
        returned_model: "openai/gpt-4.1-mini",
        model_display_name: "OpenAI GPT-4.1 Mini via OpenRouter",
        provider_response_id: "or_resp_123",
        provider_model_verified: true,
      },
    }));

    expect(provenance.verified).toBe(true);
    expect(provenance.provider_model_verified).toBe(true);
    expect(provenance.evidence_type).toBe("provider_metadata");
    expect(provenance.verification_status).toBe("metadata_verified");
    expect(provenance.model).toBe("openai/gpt-4.1-mini");
    expect(provenance.provider_response_id).toBe("or_resp_123");
  });

  it("preserves Codex ChatGPT plan funding as external_user_subscription without claiming exact model verification", () => {
    const receipt = buildReceipt({
      funding_source: "external_user_subscription",
      delegation: {
        connection_id: "conn_codex_1",
        agent_connection_id: "conn_codex_1",
        delegation_id: "del_codex_1",
        provider: "codex",
        allowed_model: "gpt-5.6-sol",
        allowed_request_class: "contribution_card",
        expires_at: "2026-06-28T01:00:00.000Z",
        max_requests: 1,
      },
      provider: {
        provider: "codex",
        requested_model: "gpt-5.6-sol",
        returned_model: "gpt-5.6-sol",
        model_display_name: "GPT-5.6 Sol via ChatGPT plan",
        provider_model_verified: false,
      },
      transcript: [{ event: "codex_session_response", run_id: "run_1", delegation_id: "del_codex_1", agent_connection_id: "conn_codex_1", provider: "codex", request_class: "contribution_card", requested_model: "gpt-5.6-sol", returned_model: "gpt-5.6-sol", provider_model_verified: false, remaining_requests: 0 }],
    });
    const provenance = modelProvenanceFromReceipt(receipt);

    expect(receipt.funding_source).toBe("external_user_subscription");
    expect(receipt.provider.provider).toBe("codex");
    expect(receipt.provider.provider_model_verified).toBe(false);
    expect(provenance.funding_source).toBe("external_user_subscription");
    expect(provenance.provider_model_verified).toBe(false);
    expect(provenance.verification_status).toBe("sandbox_recorded");
    expect(verifyHermesRunReceipt(receipt, signingKey)).toBe(true);
  });

  it("does not silently rewrite a contribution card onto a different receipt challenge", () => {
    const receipt = buildReceipt();
    expect(() => attachReceiptProvenanceToCard({ ...outputCard, challenge_id: "wrong-challenge" }, receipt)).toThrow(/does not match/);
  });
});
