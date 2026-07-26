import type { ZodType } from "zod";
import {
  CMAI_AGENT_PROTOCOL,
  CMAI_AGENT_PROTOCOL_VERSION,
  type AgentProtocolOperation,
} from "../../../lib/agent-protocol/constants";
import { canonicalAgentSigningBytes, hashAgentProtocolPayload } from "../../../lib/agent-protocol/canonical";
import { findCredentialShapedFields } from "../../../lib/agent-protocol/credentials";
import { AgentProtocolError } from "../../../lib/agent-protocol/errors";
import { parseAgentProtocolJson } from "../../../lib/agent-protocol/parse";
import { normalizePairedAdapterContribution } from "../../../lib/agent-protocol/provenance";
import {
  agentChallengeGetResponseSchema,
  agentPublicChallengeSchema,
  agentContributionSubmitResponseSchema,
  agentFeedListResponseSchema,
  agentPairCreateResponseSchema,
  agentPairingMutationResponseSchema,
  agentProtocolErrorResponseSchema,
  agentProtocolRequestSchemas,
  pairedAdapterAuditMetadataSchema,
  pairedAdapterRunAuditMetadataSchema,
  type AgentContributionSubmitRequest,
  type AgentFeedListRequest,
  type AgentPairCreateRequest,
  type AgentPairingRevokeRequest,
  type AgentPairingRotateKeyRequest,
  type PairedAdapterAuditMetadata,
  type PairedAdapterRunAuditMetadata,
} from "../../../lib/agent-protocol/schemas";
import {
  contributionCardV1Schema,
  pairedLocalContributionCardV1Schema,
  type ContributionCardV1,
  type PairedLocalContributionCardV1,
} from "../../../lib/validation/contributionCardProtocol";
import {
  CmaiAgentClientError,
  clientConfigurationError,
  clientStateError,
  fromAgentProtocolError,
  protocolResponseError,
} from "./errors";
import { assertCmaiAgentClientTransition } from "./state";
import type {
  AgentPairingState,
  AgentProtocolRequestMap,
  AgentProtocolResponseMap,
  AgentPublicChallenge,
  CmaiAgentClientPhase,
  CmaiAgentClientSnapshot,
  CmaiAgentRunInput,
  CmaiAgentRunResult,
  CmaiAgentSigner,
  CmaiAgentTransport,
  CmaiAgentTransportResponse,
} from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type RunSession = {
  challenge: AgentPublicChallenge;
  result?: CmaiAgentRunResult;
  card?: PairedLocalContributionCardV1;
  editedAfterRun: boolean;
  pendingPayload?: AgentContributionSubmitRequest["payload"];
  submission?: AgentProtocolResponseMap["contribution.submit"]["result"];
};

type ClientOptions = {
  transport: CmaiAgentTransport;
  timeoutMs?: number;
  now?: () => Date;
  requestId?: (operation: AgentProtocolOperation) => string;
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultRequestId(operation: AgentProtocolOperation): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (!randomUuid) {
    throw clientConfigurationError("A cryptographically strong requestId factory is required in this runtime.", "requestId");
  }
  return `req_${operation.replaceAll(".", "_")}_${randomUuid}`;
}

function asClientError(error: unknown): CmaiAgentClientError {
  if (error instanceof CmaiAgentClientError) return error;
  if (error instanceof AgentProtocolError) return fromAgentProtocolError(error);
  return new CmaiAgentClientError({
    code: "transport_unavailable",
    source: "transport",
    message: "The CMAI Agent transport was unavailable. No response data was retained.",
    retryable: true,
    recovery: "retry_same_request",
  });
}

function responseSchema(operation: AgentProtocolOperation): ZodType {
  switch (operation) {
    case "pair.create": return agentPairCreateResponseSchema;
    case "pairing.rotate_key":
    case "pairing.revoke": return agentPairingMutationResponseSchema;
    case "feed.list": return agentFeedListResponseSchema;
    case "challenge.get": return agentChallengeGetResponseSchema;
    case "contribution.submit": return agentContributionSubmitResponseSchema;
  }
}

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function assertTransportStatus(response: CmaiAgentTransportResponse): void {
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    throw new CmaiAgentClientError({
      code: "transport_response_malformed",
      source: "transport",
      message: "The CMAI Agent transport returned an invalid status.",
      retryable: false,
      recovery: "none",
    });
  }
}

export class CmaiAgentClient {
  private phase: CmaiAgentClientPhase = "unpaired";
  private pairing?: AgentPairingState;
  private signer?: CmaiAgentSigner;
  private pairedDevice?: AgentPairCreateRequest["payload"]["device"];
  private session?: RunSession;
  private lastError?: CmaiAgentClientError;
  private readonly idempotencyHashesByPairing = new Map<string, Map<string, string>>();
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly requestId: (operation: AgentProtocolOperation) => string;

  constructor(private readonly options: ClientOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    this.requestId = options.requestId ?? defaultRequestId;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw clientConfigurationError("timeoutMs must be a positive integer.", "timeoutMs");
    }
  }

  status(): CmaiAgentClientSnapshot {
    return cloneJson({
      phase: this.phase,
      ...(this.pairing ? { pairing: this.pairing } : {}),
      ...(this.session ? {
        challenge: {
          challengeId: this.session.challenge.challenge_id,
          revision: this.session.challenge.revision,
          runNonceExpiresAt: this.session.challenge.run_grant.expires_at,
        },
      } : {}),
      ...(this.phase === "preview" && this.session?.card && this.session.result ? {
        preview: {
          card: this.session.card,
          editedAfterRun: this.session.editedAfterRun,
          localRunId: this.session.result.localRunId,
        },
      } : {}),
      ...(this.session?.submission ? { submission: this.session.submission } : {}),
      ...(this.lastError ? { lastError: this.lastError.snapshot() } : {}),
    });
  }

  async pair(payload: AgentPairCreateRequest["payload"], signer: CmaiAgentSigner): Promise<AgentPairingState> {
    if (this.phase !== "unpaired" && this.phase !== "revoked") {
      throw clientStateError("Pairing is allowed only while unpaired or after revocation.");
    }
    if (payload.public_key.key_id !== signer.keyId) {
      throw clientConfigurationError("The signer keyId must match the pairing public key.", "payload.public_key.key_id");
    }

    const request = this.validateRequest("pair.create", {
      protocol: CMAI_AGENT_PROTOCOL,
      protocol_version: CMAI_AGENT_PROTOCOL_VERSION,
      operation: "pair.create",
      request_id: this.requestId("pair.create"),
      sent_at: this.now().toISOString(),
      payload,
    });
    const response = await this.send("pair.create", request);
    const pairing = response.result.pairing;
    const activeKey = pairing.keys.find((key) => key.status === "active");
    if (pairing.device_id !== payload.device.device_id || activeKey?.key_id !== signer.keyId) {
      throw new CmaiAgentClientError({
        code: "client_response_request_mismatch",
        source: "client",
        message: "The pairing response did not match the requested device and active key.",
        retryable: false,
        recovery: "re_pair",
      });
    }

    assertCmaiAgentClientTransition(this.phase, "paired");
    this.phase = "paired";
    this.pairing = cloneJson(pairing);
    this.signer = signer;
    this.pairedDevice = cloneJson(payload.device);
    this.session = undefined;
    this.lastError = undefined;
    return cloneJson(pairing);
  }

  async feed(payload: AgentFeedListRequest["payload"]): Promise<AgentProtocolResponseMap["feed.list"]["result"]> {
    this.requireActivePairing();
    const response = await this.sendSigned("feed.list", payload);
    this.lastError = undefined;
    return cloneJson(response.result);
  }

  async fetchChallenge(challengeId: string): Promise<AgentPublicChallenge> {
    this.requireActivePairing();
    const response = await this.sendSigned("challenge.get", { challenge_id: challengeId });
    const nextPhase: CmaiAgentClientPhase = "challenge_ready";
    assertCmaiAgentClientTransition(this.phase, nextPhase);
    this.phase = nextPhase;
    this.session = { challenge: cloneJson(response.result.challenge), editedAfterRun: false };
    this.lastError = undefined;
    return cloneJson(response.result.challenge);
  }

  async refreshForRerun(): Promise<AgentPublicChallenge> {
    if (!this.session) throw clientStateError("A challenge must be fetched before requesting a fresh run grant.");
    if (!["challenge_ready", "preview", "submit_failed", "submitted", "discarded"].includes(this.phase)) {
      throw clientStateError(`A rerun cannot start from ${this.phase}.`);
    }
    return this.fetchChallenge(this.session.challenge.challenge_id);
  }

  prepareRun(): CmaiAgentRunInput {
    if (this.phase !== "challenge_ready" || !this.session) {
      throw clientStateError("A fresh challenge grant is required before a local Agent run.");
    }
    this.assertFreshRunGrant(this.session.challenge);
    return cloneJson({
      challenge: this.session.challenge,
      promptVersion: this.session.challenge.run_grant.prompt_version,
      maxOutputBytes: this.session.challenge.run_grant.max_output_bytes,
    });
  }

  prepareRunWithApprovedGrant(approvedGrant: AgentPublicChallenge["run_grant"]): CmaiAgentRunInput {
    if (this.phase !== "challenge_ready" || !this.session) {
      throw clientStateError("A freshly validated challenge is required before using an approved run grant.");
    }
    const current = this.session.challenge;
    const approvedChallenge = agentPublicChallengeSchema.parse({
      ...cloneJson(current),
      run_grant: cloneJson(approvedGrant),
    });
    if (
      approvedChallenge.revision !== approvedChallenge.run_grant.challenge_revision
      || current.run_grant.challenge_revision !== approvedChallenge.run_grant.challenge_revision
      || current.run_grant.request_class !== approvedChallenge.run_grant.request_class
      || current.run_grant.prompt_version !== approvedChallenge.run_grant.prompt_version
      || current.run_grant.max_output_bytes !== approvedChallenge.run_grant.max_output_bytes
    ) {
      throw clientStateError("The approved run grant no longer matches the freshly validated challenge contract.");
    }
    this.assertFreshRunGrant(approvedChallenge);
    this.session.challenge = approvedChallenge;
    return this.prepareRun();
  }

  preview(result: CmaiAgentRunResult, consent: { userApprovedRun: true }): ContributionCardV1 {
    if (this.phase !== "challenge_ready" || !this.session) {
      throw clientStateError("A preview can be created only for the currently fetched challenge.");
    }
    if (consent.userApprovedRun !== true) {
      throw clientStateError("Explicit local run approval is required before preview.");
    }
    this.assertRuntimeIdentity(result);
    const audit = this.auditFor(result, false);
    const card = this.normalizePreviewCard(result.card, audit, this.session.challenge.challenge_id);
    assertCmaiAgentClientTransition(this.phase, "preview");
    this.phase = "preview";
    this.session = {
      challenge: this.session.challenge,
      result: cloneJson(result),
      card,
      editedAfterRun: false,
    };
    this.lastError = undefined;
    return cloneJson(card);
  }

  restorePreview(input: { challenge: AgentPublicChallenge; result: CmaiAgentRunResult }): ContributionCardV1 {
    this.requireActivePairing();
    if (this.phase !== "paired") throw clientStateError("A persisted preview can be restored only after pairing hydration.");
    const challenge = agentPublicChallengeSchema.parse(cloneJson(input.challenge));
    this.assertRuntimeIdentity(input.result);
    const audit = this.auditFor(input.result, false);
    const normalized = this.normalizePreviewCard(input.result.card, audit, challenge.challenge_id);
    const expected = pairedLocalContributionCardV1Schema.parse(cloneJson(input.result.card));
    if (hashAgentProtocolPayload(normalized) !== hashAgentProtocolPayload(expected)) {
      throw clientStateError("Persisted preview content does not match its validated runtime metadata.");
    }
    assertCmaiAgentClientTransition(this.phase, "challenge_ready");
    this.phase = "challenge_ready";
    assertCmaiAgentClientTransition(this.phase, "preview");
    this.phase = "preview";
    this.session = {
      challenge,
      result: { ...cloneJson(input.result), card: expected },
      card: expected,
      editedAfterRun: false,
    };
    this.lastError = undefined;
    return cloneJson(expected);
  }

  editPreview(card: unknown): ContributionCardV1 {
    if (this.phase !== "preview" || !this.session?.result) {
      throw clientStateError("Only an active preview can be edited.");
    }
    const audit = this.auditFor(this.session.result, true);
    const normalized = this.normalizePreviewCard(card, audit, this.session.challenge.challenge_id);
    assertCmaiAgentClientTransition(this.phase, "preview");
    this.session.card = normalized;
    this.session.editedAfterRun = true;
    this.lastError = undefined;
    return cloneJson(normalized);
  }

  discardPreview(): void {
    if (!["preview", "submit_failed"].includes(this.phase) || !this.session) {
      throw clientStateError("Only a preview or failed submission can be discarded.");
    }
    assertCmaiAgentClientTransition(this.phase, "discarded");
    this.phase = "discarded";
    this.session = { challenge: this.session.challenge, editedAfterRun: false };
    this.lastError = undefined;
  }

  async submit(input: {
    idempotencyKey: string;
    consent: { userApprovedSubmit: true };
  }): Promise<AgentProtocolResponseMap["contribution.submit"]["result"]> {
    if (this.phase !== "preview" || !this.session?.card || !this.session.result) {
      throw clientStateError("A validated preview is required before submit.");
    }
    if (input.consent.userApprovedSubmit !== true) {
      throw clientStateError("Explicit submit approval is required.");
    }
    this.assertFreshRunGrant(this.session.challenge);

    const payload: AgentContributionSubmitRequest["payload"] = {
      challenge_id: this.session.challenge.challenge_id,
      challenge_revision: this.session.challenge.revision,
      run_nonce: this.session.challenge.run_grant.run_nonce,
      idempotency_key: input.idempotencyKey,
      card: cloneJson(this.session.card),
      audit: this.submissionAuditFor(this.session.result, this.session.editedAfterRun),
      provenance_claim: {
        tier: "paired_local_agent",
        model_identity: "runtime_reported_unverified",
        provider_verified: false,
        remote_attestation: false,
      },
    };
    this.reserveIdempotency(payload);
    this.session.pendingPayload = cloneJson(payload);
    return this.submitPayload(payload);
  }

  async retrySubmit(): Promise<AgentProtocolResponseMap["contribution.submit"]["result"]> {
    if (this.phase !== "submit_failed" || !this.session?.pendingPayload || !this.lastError) {
      throw clientStateError("There is no failed submission to retry.");
    }
    if (this.lastError.recovery !== "retry_same_request") {
      throw clientStateError(`The last failure requires ${this.lastError.recovery}, not a same-request retry.`);
    }
    this.reserveIdempotency(this.session.pendingPayload);
    return this.submitPayload(cloneJson(this.session.pendingPayload));
  }

  async rotateKey(
    payload: AgentPairingRotateKeyRequest["payload"],
    newSigner: CmaiAgentSigner,
  ): Promise<AgentPairingState> {
    this.requireActivePairing();
    if (payload.new_public_key.key_id !== newSigner.keyId) {
      throw clientConfigurationError("The replacement signer keyId must match new_public_key.", "payload.new_public_key.key_id");
    }
    const response = await this.sendSigned("pairing.rotate_key", payload);
    const pairing = response.result.pairing;
    const activeKey = pairing.keys.find((key) => key.status === "active");
    if (activeKey?.key_id !== newSigner.keyId) {
      throw new CmaiAgentClientError({
        code: "client_response_request_mismatch",
        source: "client",
        message: "The rotation response did not activate the requested replacement key.",
        retryable: false,
        recovery: "re_pair",
      });
    }
    this.signer = newSigner;
    this.pairing = cloneJson(pairing);
    this.lastError = undefined;
    return cloneJson(pairing);
  }

  async revoke(payload: AgentPairingRevokeRequest["payload"]): Promise<AgentPairingState> {
    this.requireActivePairing();
    const response = await this.sendSigned("pairing.revoke", payload);
    const pairing = response.result.pairing;
    this.pairing = cloneJson(pairing);
    if (pairing.status === "revoked") {
      assertCmaiAgentClientTransition(this.phase, "revoked");
      this.phase = "revoked";
      this.signer = undefined;
      this.session = undefined;
    }
    this.lastError = undefined;
    return cloneJson(pairing);
  }

  private transition(next: CmaiAgentClientPhase): void {
    assertCmaiAgentClientTransition(this.phase, next);
    this.phase = next;
  }

  private requireActivePairing(): { pairing: AgentPairingState; signer: CmaiAgentSigner } {
    const pairing = this.pairing;
    const signer = this.signer;
    if (!pairing || pairing.status !== "active" || !signer || this.phase === "unpaired" || this.phase === "revoked") {
      throw clientStateError("An active pairing and host-owned signer are required.");
    }
    return { pairing, signer };
  }

  private assertFreshRunGrant(challenge: AgentPublicChallenge): void {
    if (this.now().getTime() >= Date.parse(challenge.run_grant.expires_at)) {
      const error = new CmaiAgentClientError({
        code: "run_nonce_expired",
        source: "protocol",
        message: "The local run grant expired. Fetch the challenge again and obtain fresh run approval.",
        retryable: true,
        recovery: "fetch_fresh_challenge",
        field: "$.payload.run_nonce",
      });
      this.lastError = error;
      throw error;
    }
  }

  private assertRuntimeIdentity(result: CmaiAgentRunResult): void {
    if (!this.pairedDevice) throw clientStateError("Pairing device identity is unavailable.");
    if (result.identity.runtime !== this.pairedDevice.runtime || result.identity.adapterName !== this.pairedDevice.adapter_name) {
      throw clientConfigurationError("The runtime result identity does not match the paired device adapter.", "result.identity");
    }
    if (result.structuredOutputValidated !== true) {
      throw clientConfigurationError("Runtime results must confirm structured output validation.", "result.structuredOutputValidated");
    }
  }

  private auditFor(result: CmaiAgentRunResult, editedAfterRun: boolean): PairedAdapterRunAuditMetadata {
    const candidate = {
      runtime: result.identity.runtime,
      ...(result.identity.runtimeVersion ? { runtime_version: result.identity.runtimeVersion } : {}),
      adapter_name: result.identity.adapterName,
      adapter_version: result.identity.adapterVersion,
      local_run_id: result.localRunId,
      ...(result.providerClaim ? { provider_claim: result.providerClaim } : {}),
      ...(result.modelClaim ? { model_claim: result.modelClaim } : {}),
      ...(result.modelDisplayNameClaim ? { model_display_name_claim: result.modelDisplayNameClaim } : {}),
      started_at: result.startedAt,
      completed_at: result.completedAt,
      structured_output_validated: true,
      user_approved_run: true,
      edited_after_run: editedAfterRun,
    } as const;
    const parsed = pairedAdapterRunAuditMetadataSchema.safeParse(candidate);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw clientConfigurationError("The runtime result contained invalid or non-allowlisted audit metadata.", issue ? `result.${issue.path.join(".")}` : "result");
    }
    return parsed.data;
  }

  private submissionAuditFor(result: CmaiAgentRunResult, editedAfterRun: boolean): PairedAdapterAuditMetadata {
    return pairedAdapterAuditMetadataSchema.parse({
      ...this.auditFor(result, editedAfterRun),
      user_approved_submit: true,
    });
  }

  private normalizePreviewCard(card: unknown, audit: PairedAdapterRunAuditMetadata, challengeId: string): PairedLocalContributionCardV1 {
    const credentialFields = findCredentialShapedFields(card);
    if (credentialFields.length > 0) {
      throw new CmaiAgentClientError({
        code: "credential_field_forbidden",
        source: "protocol",
        message: "Provider credential-shaped fields are forbidden in a CMAI contribution card.",
        retryable: false,
        recovery: "repair_input",
        field: credentialFields[0],
      });
    }
    const parsed = contributionCardV1Schema.safeParse(card);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new CmaiAgentClientError({
        code: "contribution_card_malformed",
        source: "protocol",
        message: "CMAI_CONTRIBUTION_CARD_V1 failed strict local validation.",
        retryable: false,
        recovery: "repair_input",
        field: issue ? `$.${issue.path.join(".")}` : "$",
      });
    }
    if (parsed.data.challenge_id !== challengeId) {
      throw new CmaiAgentClientError({
        code: "contribution_card_malformed",
        source: "protocol",
        message: "The contribution card challenge_id does not match the fetched challenge.",
        retryable: false,
        recovery: "repair_input",
        field: "$.challenge_id",
      });
    }
    const normalized = normalizePairedAdapterContribution(parsed.data, audit);
    const paired = pairedLocalContributionCardV1Schema.safeParse(normalized);
    if (!paired.success) {
      throw new CmaiAgentClientError({
        code: "contribution_card_malformed",
        source: "protocol",
        message: "The normalized paired-local card failed strict validation.",
        retryable: false,
        recovery: "repair_input",
      });
    }
    return cloneJson(paired.data);
  }

  private reserveIdempotency(payload: AgentContributionSubmitRequest["payload"]): void {
    const { pairing } = this.requireActivePairing();
    const requestHash = hashAgentProtocolPayload(payload);
    const pairingHashes = this.idempotencyHashesByPairing.get(pairing.pairing_id) ?? new Map<string, string>();
    const existing = pairingHashes.get(payload.idempotency_key);
    if (existing && existing !== requestHash) {
      const error = new CmaiAgentClientError({
        code: "idempotency_conflict",
        source: "protocol",
        message: "The idempotency key is already bound to a different canonical submission payload.",
        retryable: false,
        recovery: "none",
        field: "$.payload.idempotency_key",
      });
      this.lastError = error;
      throw error;
    }
    pairingHashes.set(payload.idempotency_key, requestHash);
    this.idempotencyHashesByPairing.set(pairing.pairing_id, pairingHashes);
  }

  private async submitPayload(payload: AgentContributionSubmitRequest["payload"]): Promise<AgentProtocolResponseMap["contribution.submit"]["result"]> {
    this.transition("submitting");
    try {
      const response = await this.sendSigned("contribution.submit", payload);
      if (!this.session) throw clientStateError("Submission session was lost.");
      this.transition("submitted");
      this.session.submission = cloneJson(response.result);
      this.lastError = undefined;
      return cloneJson(response.result);
    } catch (error) {
      const mapped = asClientError(error);
      if (this.phase === "submitting") this.transition("submit_failed");
      this.lastError = mapped;
      throw mapped;
    }
  }

  private async sendSigned<TOperation extends Exclude<AgentProtocolOperation, "pair.create">>(
    operation: TOperation,
    payload: AgentProtocolRequestMap[TOperation]["payload"],
  ): Promise<AgentProtocolResponseMap[TOperation]> {
    const { pairing, signer } = this.requireActivePairing();
    const requestId = this.requestId(operation);
    const sentAt = this.now().toISOString();
    const signingBytes = canonicalAgentSigningBytes({
      protocol: CMAI_AGENT_PROTOCOL,
      protocol_version: CMAI_AGENT_PROTOCOL_VERSION,
      operation,
      request_id: requestId,
      sent_at: sentAt,
      pairing_id: pairing.pairing_id,
      key_id: signer.keyId,
      payload,
    });
    let signature: string;
    try {
      signature = await signer.sign(signingBytes);
    } catch {
      throw clientConfigurationError("The host-owned signer failed without exposing key material.", "signer");
    }
    const envelope = this.validateRequest(operation, {
      protocol: CMAI_AGENT_PROTOCOL,
      protocol_version: CMAI_AGENT_PROTOCOL_VERSION,
      operation,
      request_id: requestId,
      sent_at: sentAt,
      auth: {
        pairing_id: pairing.pairing_id,
        key_id: signer.keyId,
        signature: { algorithm: "ed25519", value: signature },
      },
      payload,
    });
    return this.send(operation, envelope);
  }

  private validateRequest<TOperation extends AgentProtocolOperation>(
    operation: TOperation,
    candidate: unknown,
  ): AgentProtocolRequestMap[TOperation] {
    try {
      const raw = JSON.stringify(candidate as JsonValue);
      return parseAgentProtocolJson(operation, raw, agentProtocolRequestSchemas[operation]) as AgentProtocolRequestMap[TOperation];
    } catch (error) {
      throw asClientError(error);
    }
  }

  private async send<TOperation extends AgentProtocolOperation>(
    operation: TOperation,
    envelope: AgentProtocolRequestMap[TOperation],
  ): Promise<AgentProtocolResponseMap[TOperation]> {
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        controller.abort();
        reject(new CmaiAgentClientError({
          code: "transport_timeout",
          source: "transport",
          message: `The CMAI Agent transport timed out after ${this.timeoutMs}ms.`,
          retryable: true,
          recovery: "retry_same_request",
        }));
      }, this.timeoutMs);
    });

    let response: CmaiAgentTransportResponse;
    try {
      response = await Promise.race([
        this.options.transport.send(
          { operation, envelope },
          { signal: controller.signal, timeoutMs: this.timeoutMs, requestId: envelope.request_id },
        ),
        timeout,
      ]);
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof CmaiAgentClientError)) {
        throw new CmaiAgentClientError({
          code: "transport_timeout",
          source: "transport",
          message: `The CMAI Agent transport timed out after ${this.timeoutMs}ms.`,
          retryable: true,
          recovery: "retry_same_request",
        });
      }
      throw asClientError(error);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }

    assertTransportStatus(response);
    if (!isSuccessStatus(response.status)) {
      const parsedError = agentProtocolErrorResponseSchema.safeParse(response.body);
      if (parsedError.success) {
        if (parsedError.data.request_id && parsedError.data.request_id !== envelope.request_id) {
          throw new CmaiAgentClientError({
            code: "client_response_request_mismatch",
            source: "client",
            message: "The protocol error response request_id did not match the request.",
            retryable: false,
            recovery: "none",
          });
        }
        throw protocolResponseError(parsedError.data.error);
      }
      if (response.status === 429) {
        throw new CmaiAgentClientError({
          code: "transport_rate_limited",
          source: "transport",
          message: "The CMAI Agent transport was rate limited without a valid protocol error envelope.",
          retryable: true,
          recovery: "retry_same_request",
        });
      }
      throw new CmaiAgentClientError({
        code: "transport_response_malformed",
        source: "transport",
        message: "The CMAI Agent transport returned a non-protocol error response. Response content was discarded.",
        retryable: response.status >= 500,
        recovery: response.status >= 500 ? "retry_same_request" : "none",
      });
    }

    const parsed = responseSchema(operation).safeParse(response.body);
    if (!parsed.success) {
      throw new CmaiAgentClientError({
        code: "transport_response_malformed",
        source: "transport",
        message: "The CMAI Agent transport returned a malformed success response. Response content was discarded.",
        retryable: false,
        recovery: "none",
      });
    }
    const protocolResponse = parsed.data as AgentProtocolResponseMap[TOperation];
    if (protocolResponse.request_id !== envelope.request_id) {
      throw new CmaiAgentClientError({
        code: "client_response_request_mismatch",
        source: "client",
        message: "The protocol success response request_id did not match the request.",
        retryable: false,
        recovery: "none",
      });
    }
    return cloneJson(protocolResponse);
  }
}
