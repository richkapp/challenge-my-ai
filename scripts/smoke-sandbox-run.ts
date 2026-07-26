import { createFakeHermesRunBroker } from "../lib/sandbox/fakeHermesRunBroker";
import { verifyHermesRunReceipt } from "../lib/provenance/receipts";

const signingKey = { keyId: "local-smoke", secret: "local-smoke-secret" };
const broker = createFakeHermesRunBroker({ signingKey });

const outcome = await broker.run({
  challengeId: "smoke-challenge",
  contributorId: "smoke-contributor",
  contributionMode: "critique",
  challengeBundle: {
    title: "Smoke test sandboxed Hermes run broker",
    original_ai_answer: "Ship it without tests.",
    constraints: ["No live Railway dependency", "No broker secrets in sandbox config"],
  },
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

if (!verifyHermesRunReceipt(outcome.receipt, signingKey)) {
  throw new Error("Smoke receipt signature verification failed.");
}

console.log(JSON.stringify({
  ok: true,
  source: outcome.card.model_provenance?.source,
  sandbox_provider: outcome.receipt.sandbox.provider,
  network: outcome.receipt.sandbox.network_isolation,
  receipt_id: outcome.receipt.receipt_id,
  prompt_sha256: outcome.receipt.artifacts.prompt_sha256,
  output_sha256: outcome.receipt.artifacts.output_sha256,
  transcript_sha256: outcome.receipt.artifacts.transcript_sha256,
  destroyed: outcome.destroyed,
}, null, 2));
