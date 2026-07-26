import { describe, expect, it } from "vitest";
import { createFakeHermesRunBroker } from "@/lib/sandbox/fakeHermesRunBroker";
import { approvedUntrustedRunnerProfile } from "@/lib/sandbox/policy";
import { verifyHermesRunReceipt } from "@/lib/provenance/receipts";

const signingKey = { keyId: "fake-test", secret: "fake-secret" };

const request = {
  challengeId: "challenge-1",
  contributorId: "user-1",
  contributionMode: "critique" as const,
  challengeBundle: { title: "Test challenge", original_ai_answer: "Original" },
  provider: "fake-provider",
  requestedModel: "fake-model",
  modelDisplayName: "Fake Model",
  agentConnection: {
    connection_id: "conn_1",
    provider: "fake-provider",
    allowed_model: "fake-model",
    expires_at: "2026-06-28T01:00:00.000Z",
    max_requests: 1,
  },
};

describe("fake Hermes run broker", () => {
  it("simulates a sandboxed Hermes contribution run and broker-signed receipt", async () => {
    const broker = createFakeHermesRunBroker({ signingKey });
    const outcome = await broker.run(request);

    expect(outcome.card.model_provenance?.source).toBe("hermes_sandbox_run");
    expect(outcome.card.model_provenance?.sandbox_provider).toBe("local_fake");
    expect(outcome.card.model_provenance?.runner_checkpoint).toBe(approvedUntrustedRunnerProfile.checkpoint);
    expect(outcome.receipt.sandbox.provider).toBe("local_fake");
    expect(outcome.receipt.sandbox.network_isolation).toBe("ISOLATED");
    expect(outcome.receipt.artifacts.prompt_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(outcome.receipt.artifacts.output_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(outcome.receipt.artifacts.transcript_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(outcome.destroyed).toBe(true);
    expect(verifyHermesRunReceipt(outcome.receipt, signingKey)).toBe(true);
  });

  it("overwrites forged trusted metadata returned by the runner", async () => {
    const broker = createFakeHermesRunBroker({ signingKey, forgeTrustedMetadata: true });
    const outcome = await broker.run(request);

    expect(outcome.card.model_provenance?.receipt_id).not.toBe("forged-receipt");
    expect(outcome.card.model_provenance?.provider).toBe("fake-provider");
    expect(outcome.card.model_provenance?.sandbox_provider).toBe("local_fake");
    expect(outcome.card.model_provenance?.sandbox_network_isolation).toBe("ISOLATED");
    expect(outcome.card.model_provenance?.verified).toBe(false);
  });

  it("does not expose raw secrets in public card, receipt, or smoke-sized stdout", async () => {
    const broker = createFakeHermesRunBroker({ signingKey });
    const outcome = await broker.run({
      ...request,
      agentConnection: { ...request.agentConnection, connection_id: "conn_safe" },
    });

    const serialized = JSON.stringify({ card: outcome.card, receipt: outcome.receipt, stdout: outcome.stdout });
    expect(serialized).not.toContain(signingKey.secret);
    expect(serialized).not.toContain("DATABASE_URL");
    expect(serialized).not.toContain("OPENAI_API_KEY");
  });
});
