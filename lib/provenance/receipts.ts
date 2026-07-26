import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ContributionCard, HermesRunReceipt, HermesRunReceiptSignature, ModelProvenance } from "@/lib/types";
import { modelExecutionAuthorities, modelFundingSources, sandboxNetworkIsolations, sandboxProviders } from "@/lib/types";

export type HermesReceiptSigningKey = {
  keyId: string;
  secret: string;
};

export type BuildHermesRunReceiptInput = Omit<HermesRunReceipt, "schema_version" | "source" | "receipt_id" | "artifacts" | "signature"> & {
  receipt_id?: string;
  promptBundle: unknown;
  outputCard: unknown;
  transcript: string | readonly unknown[];
  signingKey: HermesReceiptSigningKey;
};

const hexSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const delegationSchema = z.object({
  delegation_id: z.string().min(1).optional(),
  connection_id: z.string().min(1),
  agent_connection_id: z.string().min(1).optional(),
  provider: z.string().min(1),
  allowed_model: z.string().min(1).optional(),
  allowed_request_class: z.string().min(1).optional(),
  expires_at: z.string().min(1),
  max_spend_cents: z.number().int().nonnegative().optional(),
  max_requests: z.number().int().positive().optional(),
}).strict();

const receiptPayloadSchema = z.object({
  schema_version: z.literal("1.0"),
  receipt_id: z.string().min(1),
  source: z.literal("hermes_sandbox_run"),
  run_id: z.string().min(1),
  challenge_id: z.string().min(1),
  contributor_id: z.string().min(1),
  funding_source: z.enum(modelFundingSources),
  execution_authority: z.enum(modelExecutionAuthorities),
  delegation: delegationSchema.optional(),
  provider: z.object({
    provider: z.string().min(1),
    requested_model: z.string().min(1),
    returned_model: z.string().min(1).optional(),
    model_display_name: z.string().min(1),
    provider_response_id: z.string().min(1).optional(),
    provider_model_verified: z.boolean(),
  }).strict(),
  runner: z.object({
    profile: z.string().min(1),
    checkpoint: z.string().min(1),
    hermes_version: z.string().min(1).optional(),
    container_image_digest: z.string().min(1).optional(),
  }).strict(),
  sandbox: z.object({
    provider: z.enum(sandboxProviders),
    sandbox_id: z.string().min(1),
    network_isolation: z.enum(sandboxNetworkIsolations),
    teardown_completed: z.boolean(),
    teardown_error: z.string().min(1).optional(),
  }).strict(),
  tool_policy: z.string().min(1),
  network_policy: z.string().min(1),
  artifacts: z.object({
    prompt_sha256: hexSha256Schema,
    output_sha256: hexSha256Schema,
    transcript_sha256: hexSha256Schema,
    artifact_sha256: hexSha256Schema.optional(),
  }).strict(),
  timing: z.object({
    queued_at: z.string().min(1).optional(),
    started_at: z.string().min(1),
    completed_at: z.string().min(1),
    duration_ms: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export const hermesRunReceiptSchema = receiptPayloadSchema.extend({
  signature: z.object({
    algorithm: z.literal("hmac-sha256"),
    key_id: z.string().min(1),
    value: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
}).strict();

export type HermesRunReceiptPayload = z.infer<typeof receiptPayloadSchema>;

export function normalizeTextForReceipt(input: string): string {
  return input.replace(/\r\n/g, "\n").replace(/\r/g, "\n").normalize("NFC");
}

function normalizeJsonValue(value: unknown): unknown {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value === "string") return normalizeTextForReceipt(value);
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => normalizeJsonValue(item) ?? null);

  const object = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(object).sort()) {
    const normalized = normalizeJsonValue(object[key]);
    if (normalized !== undefined) result[key] = normalized;
  }
  return result;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJsonValue(value));
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function hashCanonicalJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function hashPromptBundle(promptBundle: unknown): string {
  return hashCanonicalJson(promptBundle);
}

export function hashOutputCard(outputCard: unknown): string {
  return hashCanonicalJson(outputCard);
}

export function canonicalTranscript(transcript: string | readonly unknown[]): string {
  if (typeof transcript === "string") {
    const normalized = normalizeTextForReceipt(transcript).replace(/\n*$/u, "");
    return normalized.length > 0 ? `${normalized}\n` : "";
  }
  return transcript.map((record) => canonicalJson(record)).join("\n") + (transcript.length > 0 ? "\n" : "");
}

export function hashTranscript(transcript: string | readonly unknown[]): string {
  return sha256Hex(canonicalTranscript(transcript));
}

export function createReceiptId(runId: string, challengeId: string, contributorId: string): string {
  return `hr_${sha256Hex(`hermes-run-receipt:${runId}:${challengeId}:${contributorId}`).slice(0, 24)}`;
}

export function receiptPayload(receipt: HermesRunReceipt): HermesRunReceiptPayload {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { signature: _signature, ...payload } = receipt;
  return receiptPayloadSchema.parse(payload);
}

export function signReceiptPayload(payload: HermesRunReceiptPayload, signingKey: HermesReceiptSigningKey): HermesRunReceiptSignature {
  if (!signingKey.keyId || !signingKey.secret) throw new Error("Receipt signing requires a key id and secret.");
  return {
    algorithm: "hmac-sha256",
    key_id: signingKey.keyId,
    value: createHmac("sha256", signingKey.secret).update(canonicalJson(payload), "utf8").digest("hex"),
  };
}

export function buildHermesRunReceipt(input: BuildHermesRunReceiptInput): HermesRunReceipt {
  const payload: HermesRunReceiptPayload = receiptPayloadSchema.parse({
    schema_version: "1.0",
    receipt_id: input.receipt_id || createReceiptId(input.run_id, input.challenge_id, input.contributor_id),
    source: "hermes_sandbox_run",
    run_id: input.run_id,
    challenge_id: input.challenge_id,
    contributor_id: input.contributor_id,
    funding_source: input.funding_source,
    execution_authority: input.execution_authority,
    delegation: input.delegation,
    provider: input.provider,
    runner: input.runner,
    sandbox: input.sandbox,
    tool_policy: input.tool_policy,
    network_policy: input.network_policy,
    artifacts: {
      prompt_sha256: hashPromptBundle(input.promptBundle),
      output_sha256: hashOutputCard(input.outputCard),
      transcript_sha256: hashTranscript(input.transcript),
      artifact_sha256: hashCanonicalJson({ prompt: input.promptBundle, output: input.outputCard, transcript: canonicalTranscript(input.transcript) }),
    },
    timing: input.timing,
  });

  return hermesRunReceiptSchema.parse({
    ...payload,
    signature: signReceiptPayload(payload, input.signingKey),
  });
}

export function verifyHermesRunReceipt(receipt: HermesRunReceipt, signingKey: HermesReceiptSigningKey): boolean {
  const parsed = hermesRunReceiptSchema.safeParse(receipt);
  if (!parsed.success || parsed.data.signature.key_id !== signingKey.keyId) return false;
  const expected = signReceiptPayload(receiptPayload(parsed.data), signingKey).value;
  const actualBuffer = Buffer.from(parsed.data.signature.value, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function verifyHermesRunReceiptArtifacts(input: {
  receipt: HermesRunReceipt;
  signingKey: HermesReceiptSigningKey;
  promptBundle: unknown;
  outputCard: unknown;
  transcript: string | readonly unknown[];
}): boolean {
  if (!verifyHermesRunReceipt(input.receipt, input.signingKey)) return false;
  return input.receipt.artifacts.prompt_sha256 === hashPromptBundle(input.promptBundle)
    && input.receipt.artifacts.output_sha256 === hashOutputCard(input.outputCard)
    && input.receipt.artifacts.transcript_sha256 === hashTranscript(input.transcript)
    && input.receipt.artifacts.artifact_sha256 === hashCanonicalJson({
      prompt: input.promptBundle,
      output: input.outputCard,
      transcript: canonicalTranscript(input.transcript),
    });
}

export function hashHermesRunReceipt(receipt: HermesRunReceipt): string {
  return hashCanonicalJson(receipt);
}

export function modelProvenanceFromReceipt(receipt: HermesRunReceipt): ModelProvenance {
  const receiptHash = hashHermesRunReceipt(receipt);
  return {
    source: "hermes_sandbox_run",
    provider: receipt.provider.provider,
    model: receipt.provider.returned_model || receipt.provider.requested_model,
    requested_model: receipt.provider.requested_model,
    returned_model: receipt.provider.returned_model,
    model_display_name: receipt.provider.model_display_name,
    adapter: "hermes_sandbox",
    verified: receipt.provider.provider_model_verified,
    provider_model_verified: receipt.provider.provider_model_verified,
    evidence_type: receipt.provider.provider_model_verified ? "provider_metadata" : "hermes_run_receipt",
    verification_status: receipt.provider.provider_model_verified ? "metadata_verified" : "sandbox_recorded",
    verification_notes: receipt.provider.provider_model_verified
      ? "Generated in a Challenge My AI-controlled Hermes run cell with receipt-bound provider metadata attached."
      : "Generated in a Challenge My AI-controlled Hermes run cell; exact provider model identity is not independently API-verified.",
    run_id: receipt.run_id,
    receipt_id: receipt.receipt_id,
    receipt_sha256: receiptHash,
    sandbox_id: receipt.sandbox.sandbox_id,
    sandbox_provider: receipt.sandbox.provider,
    sandbox_network_isolation: receipt.sandbox.network_isolation,
    sandbox_teardown_completed: receipt.sandbox.teardown_completed,
    funding_source: receipt.funding_source,
    execution_authority: receipt.execution_authority,
    delegation_id: receipt.delegation?.delegation_id,
    agent_connection_id: receipt.delegation?.agent_connection_id || receipt.delegation?.connection_id,
    runner_profile: receipt.runner.profile,
    runner_checkpoint: receipt.runner.checkpoint,
    provider_response_id: receipt.provider.provider_response_id,
    artifact_sha256: receipt.artifacts.artifact_sha256,
    prompt_sha256: receipt.artifacts.prompt_sha256,
    output_sha256: receipt.artifacts.output_sha256,
    transcript_sha256: receipt.artifacts.transcript_sha256,
  };
}

export function attachReceiptProvenanceToCard(card: ContributionCard, receipt: HermesRunReceipt): ContributionCard {
  if (card.challenge_id !== receipt.challenge_id) {
    throw new Error(`Receipt challenge_id ${receipt.challenge_id} does not match contribution card challenge_id ${card.challenge_id}.`);
  }
  return { ...card, model_provenance: modelProvenanceFromReceipt(receipt) };
}
