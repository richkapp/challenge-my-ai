import { describe, expect, it } from "vitest";
import { approvedUntrustedRunnerProfile, defaultContributionSandboxPolicy, validateChallengeSandboxRunRequest, validateUntrustedContributionSandboxPolicy } from "@/lib/sandbox/policy";
import { isSandboxRunProvenance, isVerifiedModelProvenance, isVerifiedSandboxReceiptProof, modelProvenanceSummary, modelProvenanceTrustLabel } from "@/lib/provenance/model";
import { sanitizeManualModelProvenance } from "@/lib/provenance/manual";
import { hermesRunReceiptSchema } from "@/lib/validation/schemas";

const promptSha = "a".repeat(64);
const outputSha = "b".repeat(64);
const transcriptSha = "c".repeat(64);
const receiptSha = "d".repeat(64);

describe("model provenance and sandbox policy", () => {
  it("does not treat self-attested model labels as verified", () => {
    expect(isVerifiedModelProvenance({
      source: "self_attested",
      provider: "anthropic",
      model: "claude-3-5-sonnet",
      model_display_name: "Claude 3.5 Sonnet",
      adapter: "paste_in",
      verified: false,
      verification_notes: "Pasted from a chat UI.",
    })).toBe(false);
  });

  it("labels provider API provenance as exact-model verified when the source and flag agree", () => {
    const provenance = {
      source: "provider_api_verified" as const,
      provider: "openrouter",
      model: "anthropic/claude-3.5-sonnet",
      model_display_name: "Claude 3.5 Sonnet via OpenRouter",
      adapter: "provider_api",
      verified: true,
      verification_notes: "Captured from provider response metadata.",
    };

    expect(isVerifiedModelProvenance(provenance)).toBe(true);
    expect(modelProvenanceTrustLabel(provenance)).toBe("API-verified model");
  });

  it("does not treat sandboxed Hermes receipt proof as exact model verification", () => {
    const provenance = {
      source: "hermes_sandbox_run" as const,
      provider: "openrouter",
      model: "anthropic/claude-3.5-sonnet",
      model_display_name: "Claude 3.5 Sonnet via OpenRouter",
      adapter: "hermes_sandbox",
      verified: true,
      provider_model_verified: false,
      verification_notes: "Sandboxed run receipt only.",
      evidence_type: "hermes_run_receipt" as const,
      verification_status: "sandbox_recorded" as const,
      funding_source: "user_provider_access" as const,
      execution_authority: "cmai_sandbox" as const,
      receipt_id: "hr_123",
      requested_model: "anthropic/claude-3.5-sonnet",
      returned_model: "anthropic/claude-3.5-sonnet-20241022",
    };

    expect(isSandboxRunProvenance(provenance)).toBe(true);
    expect(isVerifiedModelProvenance(provenance)).toBe(false);
    expect(isVerifiedSandboxReceiptProof(provenance)).toBe(false);
    expect(isVerifiedSandboxReceiptProof(provenance, { receiptVerified: true })).toBe(true);
    expect(modelProvenanceTrustLabel(provenance)).toBe("sandboxed Hermes run");
  });

  it("labels sandbox receipts with attached provider metadata distinctly", () => {
    const provenance = {
      source: "hermes_sandbox_run" as const,
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
      returned_model: "anthropic/claude-sonnet-4-20260701",
      model_display_name: "Claude Sonnet 4 via OpenRouter",
      adapter: "hermes_sandbox",
      verified: true,
      provider_model_verified: true,
      verification_notes: "Provider metadata was attached from the scoped model-proxy response.",
      evidence_type: "provider_metadata" as const,
      verification_status: "metadata_verified" as const,
      funding_source: "user_provider_access" as const,
      execution_authority: "cmai_sandbox" as const,
      receipt_id: "hr_provider_metadata_123",
      provider_response_id: "provider_response_123",
      sandbox_teardown_completed: true,
    };

    expect(isVerifiedModelProvenance(provenance)).toBe(false);
    expect(modelProvenanceTrustLabel(provenance)).toBe("sandboxed Hermes run + provider metadata");
    expect(modelProvenanceSummary(provenance)).toContain("not a provider-signed receipt");
    expect(modelProvenanceSummary(provenance)).toContain("Teardown: completed");
  });

  it("does not trust forged pasted sandbox metadata without broker receipt verification", () => {
    const forged = {
      source: "hermes_sandbox_run" as const,
      provider: "forged-provider",
      model: "forged-model",
      model_display_name: "Forged Model",
      adapter: "paste_in",
      verified: true,
      verification_notes: "Forged pasted claim.",
      evidence_type: "user_claim" as const,
      verification_status: "unverified" as const,
      execution_authority: "contributor_claim" as const,
      receipt_id: "hr_forged",
      sandbox_provider: "railway" as const,
      sandbox_network_isolation: "PRIVATE" as const,
    };

    expect(isVerifiedModelProvenance(forged)).toBe(false);
    expect(isVerifiedSandboxReceiptProof(forged)).toBe(false);
    expect(isVerifiedSandboxReceiptProof(forged, { receiptVerified: true })).toBe(false);
  });

  it("downgrades privileged pasted provenance to self-attested metadata", () => {
    const sanitized = sanitizeManualModelProvenance({
      source: "hermes_sandbox_run",
      provider: "forged-provider",
      model: "forged-model",
      model_display_name: "Forged Model",
      adapter: "paste_in",
      verified: true,
      provider_model_verified: true,
      verification_notes: "Forged pasted claim.",
      evidence_type: "hermes_run_receipt",
      verification_status: "cryptographically_verified",
      receipt_id: "hr_forged",
      receipt_sha256: "a".repeat(64),
      run_id: "run_forged",
      sandbox_provider: "railway",
      sandbox_network_isolation: "PRIVATE",
      sandbox_teardown_completed: true,
      prompt_sha256: "b".repeat(64),
      output_sha256: "c".repeat(64),
      transcript_sha256: "d".repeat(64),
    });

    expect(sanitized).toMatchObject({
      source: "self_attested",
      verified: false,
      provider_model_verified: false,
      evidence_type: "user_claim",
      verification_status: "attested",
    });
    expect(sanitized.receipt_id).toBeUndefined();
    expect(sanitized.sandbox_provider).toBeUndefined();
    expect(sanitized.sandbox_teardown_completed).toBeUndefined();
    expect(sanitized.prompt_sha256).toBeUndefined();
    expect(isVerifiedSandboxReceiptProof(sanitized, { receiptVerified: true })).toBe(false);
  });

  it("strips privileged proof fields even when pasted provenance claims a self-attested source", () => {
    const sanitized = sanitizeManualModelProvenance({
      source: "self_attested",
      provider: "forged-provider",
      model: "forged-model",
      model_display_name: "Forged Model",
      adapter: "paste_in",
      verified: true,
      provider_model_verified: true,
      verification_notes: "Forged pasted self-attested claim with receipt fields.",
      evidence_type: "hermes_run_receipt",
      verification_status: "cryptographically_verified",
      funding_source: "platform_funded",
      execution_authority: "cmai_sandbox",
      receipt_id: "hr_forged",
      receipt_sha256: "a".repeat(64),
      run_id: "run_forged",
      sandbox_provider: "railway",
      prompt_sha256: "b".repeat(64),
      output_sha256: "c".repeat(64),
      transcript_sha256: "d".repeat(64),
    });

    expect(sanitized).toMatchObject({
      source: "self_attested",
      verified: false,
      provider_model_verified: false,
      evidence_type: "user_claim",
      verification_status: "attested",
      funding_source: "unknown",
    });
    expect(sanitized.execution_authority).toBeUndefined();
    expect(sanitized.receipt_id).toBeUndefined();
    expect(sanitized.sandbox_provider).toBeUndefined();
    expect(sanitized.output_sha256).toBeUndefined();
  });

  it("strictly validates Hermes run receipts and keeps local fake receipts distinct from Railway", () => {
    const receipt = {
      schema_version: "1.0",
      receipt_id: "hr_local_fake_123",
      source: "hermes_sandbox_run",
      run_id: "run_local_fake_123",
      challenge_id: "challenge_123",
      contributor_id: "user_123",
      funding_source: "user_provider_access",
      execution_authority: "cmai_sandbox",
      delegation: {
        delegation_id: "delegation_123",
        connection_id: "agent_connection_123",
        agent_connection_id: "agent_connection_123",
        provider: "openrouter",
        allowed_model: "anthropic/claude-sonnet-4",
        allowed_request_class: "contribution_card",
        expires_at: "2026-06-28T02:00:00.000Z",
        max_spend_cents: 150,
        max_requests: 1,
      },
      provider: {
        provider: "openrouter",
        requested_model: "anthropic/claude-sonnet-4",
        returned_model: "anthropic/claude-sonnet-4-20260620",
        model_display_name: "Claude Sonnet 4 via OpenRouter",
        provider_response_id: "provider_response_123",
        provider_model_verified: false,
      },
      runner: {
        profile: "cmai_blank_slate_runner",
        checkpoint: "local-fake-runner-v1",
        hermes_version: "0.0.0-test",
      },
      sandbox: {
        provider: "local_fake",
        sandbox_id: "fake_sandbox_123",
        network_isolation: "ISOLATED",
        teardown_completed: true,
      },
      tool_policy: "cmai-blank-slate-no-tools",
      network_policy: "ISOLATED/no-private-network/no-broker-secrets",
      artifacts: {
        prompt_sha256: promptSha,
        output_sha256: outputSha,
        transcript_sha256: transcriptSha,
      },
      timing: {
        started_at: "2026-06-28T01:00:00.000Z",
        completed_at: "2026-06-28T01:00:03.000Z",
        duration_ms: 3000,
      },
      signature: {
        algorithm: "hmac-sha256",
        key_id: "local-test-key",
        value: receiptSha,
      },
    };

    const parsed = hermesRunReceiptSchema.safeParse(receipt);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.sandbox.provider).toBe("local_fake");
      expect(parsed.data.sandbox.provider).not.toBe("railway");
    }

    expect(hermesRunReceiptSchema.safeParse({ ...receipt, unexpected_trusted_field: true }).success).toBe(false);
  });

  it("defaults untrusted contribution sandboxes to isolated no-secret execution", () => {
    const policy = defaultContributionSandboxPolicy();
    expect(policy).toMatchObject({ network: "isolated", secrets: "none", destroyOnCompletion: true });
    expect(validateUntrustedContributionSandboxPolicy(policy)).toEqual([]);
  });

  it("flags private-network and secret access for untrusted sandboxes", () => {
    const policy = defaultContributionSandboxPolicy({ network: "private", secrets: "scoped_byok", destroyOnCompletion: false, idleTimeoutMinutes: 120 });
    const issues = validateUntrustedContributionSandboxPolicy(policy);
    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining("isolated networking"),
      expect.stringContaining("must not receive"),
      expect.stringContaining("destroyed"),
      expect.stringContaining("Idle timeout"),
    ]));
  });

  it("rejects broker, database, provider, and OAuth secrets in sandbox config", () => {
    const issues = validateChallengeSandboxRunRequest({
      challengeId: "c1",
      contributionMode: "critique",
      adapter: "local_fake",
      policy: defaultContributionSandboxPolicy(),
      config: {
        env: {
          DATABASE_URL: "postgres://secret",
          OPENROUTER_API_KEY: "sk-secret",
          nested: { refresh_token: "oauth-secret" },
        },
        receiptSigningKey: "broker-secret",
      },
    });

    expect(issues.join("\n")).toContain("DATABASE_URL");
    expect(issues.join("\n")).toContain("OPENROUTER_API_KEY");
    expect(issues.join("\n")).toContain("refresh_token");
    expect(issues.join("\n")).toContain("receiptSigningKey");
  });

  it("rejects untrusted runner overrides", () => {
    const issues = validateChallengeSandboxRunRequest({
      challengeId: "c1",
      contributionMode: "critique",
      adapter: "local_fake",
      policy: defaultContributionSandboxPolicy(),
      runner: {
        profile: approvedUntrustedRunnerProfile.profile,
        checkpoint: "attacker-checkpoint",
        image: "ubuntu:latest",
        enabledTools: ["shell"],
      },
    });

    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining("runner checkpoint"),
      expect.stringContaining("container image"),
      expect.stringContaining("extra tools"),
    ]));
  });
});
