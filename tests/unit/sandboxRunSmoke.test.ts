import { describe, expect, it } from "vitest";
import { createFakeHermesRunBroker } from "@/lib/sandbox/fakeHermesRunBroker";
import { verifyHermesRunReceipt } from "@/lib/provenance/receipts";

describe("sandbox run smoke seam", () => {
  it("produces a redacted receipt summary from the fake broker", async () => {
    const signingKey = { keyId: "smoke-test", secret: "smoke-secret" };
    const broker = createFakeHermesRunBroker({ signingKey });
    const outcome = await broker.run({
      challengeId: "smoke-challenge",
      contributorId: "smoke-contributor",
      contributionMode: "critique",
      challengeBundle: { title: "Smoke", original_ai_answer: "Original" },
      provider: "fake-provider",
      requestedModel: "fake-model-v1",
      modelDisplayName: "Fake Model v1",
      agentConnection: {
        connection_id: "conn_smoke",
        provider: "fake-provider",
        allowed_model: "fake-model-v1",
        expires_at: "2026-06-28T01:00:00.000Z",
        max_requests: 1,
      },
    });

    const summary = {
      source: outcome.card.model_provenance?.source,
      sandbox_provider: outcome.receipt.sandbox.provider,
      prompt_sha256: outcome.receipt.artifacts.prompt_sha256,
      transcript_sha256: outcome.receipt.artifacts.transcript_sha256,
    };

    expect(summary.source).toBe("hermes_sandbox_run");
    expect(summary.sandbox_provider).toBe("local_fake");
    expect(summary.prompt_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyHermesRunReceipt(outcome.receipt, signingKey)).toBe(true);
    expect(JSON.stringify(summary)).not.toContain(signingKey.secret);
  });
});
