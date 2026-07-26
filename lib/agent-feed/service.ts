import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  AGENT_PROTOCOL_DEFAULT_NONCE_TTL_MS,
  CMAI_AGENT_PROTOCOL,
  CMAI_AGENT_PROTOCOL_VERSION,
} from "@/lib/agent-protocol/constants";
import { hashAgentProtocolPayload } from "@/lib/agent-protocol/canonical";
import { AgentProtocolError, agentProtocolErrorHttpStatus } from "@/lib/agent-protocol/errors";
import { normalizePairedAdapterContribution } from "@/lib/agent-protocol/provenance";
import type {
  AgentChallengeGetRequest,
  AgentChallengeGetResponse,
  AgentContributionSubmitRequest,
  AgentContributionSubmitResponse,
  AgentFeedListRequest,
  AgentFeedListResponse,
  AgentProtocolErrorResponse,
  AgentPublicChallengeSummary,
} from "@/lib/agent-protocol/schemas";
import type { PairingAuthorizationContext, PairingService } from "@/lib/agent-pairing/service";
import {
  AgentFeedCursorError,
  decodeAgentFeedCursor,
  encodeAgentFeedCursor,
  hashAgentFeedCursorAudience,
  hashAgentFeedFilters,
  normalizeAgentFeedFilters,
} from "@/lib/agent-feed/cursor";
import {
  AgentFeedProjectionError,
  agentProtocolResponseByteLimits,
  utf8JsonBytes,
} from "@/lib/agent-feed/egress";
import { projectAgentChallenge, projectAgentChallengeSummary } from "@/lib/agent-feed/projection";
import type { AgentFeedFailureBucket, AgentFeedTelemetrySink } from "@/lib/agent-feed/telemetry";
import {
  AgentFeedStoreError,
  type AgentFeedReadResponse,
  type AgentFeedRequestExecutor,
  type AgentFeedRequestTransactionInput,
  type AgentFeedRequestTransactionResult,
  type AgentFeedSubmissionInput,
  type AgentRunGrantRecord,
  type AgentSubmissionAcceptResult,
} from "@/lib/store/agentFeed";
import { pairedLocalContributionCardV1Schema } from "@/lib/validation/contributionCardProtocol";

export const AGENT_FEED_PROMPT_VERSION = "cmai-contribution-card-v1" as const;
export const AGENT_FEED_MAX_OUTPUT_BYTES = 64 * 1024;

export type AgentFeedProtocolRequest = AgentFeedListRequest | AgentChallengeGetRequest;

export type AgentFeedProtocolStore = {
  transactAgentFeedRequest(
    input: AgentFeedRequestTransactionInput,
    execute: AgentFeedRequestExecutor,
    transactionTime?: Date,
  ): Promise<AgentFeedRequestTransactionResult>;
  submitAgentFeedContribution?(
    input: AgentFeedSubmissionInput,
    transactionTime?: Date,
  ): Promise<AgentSubmissionAcceptResult> | AgentSubmissionAcceptResult;
};

export type AgentFeedProtocolServiceOptions = {
  pairingService: PairingService;
  store: AgentFeedProtocolStore;
  cursorSecret: string;
  telemetry?: AgentFeedTelemetrySink;
  clock?: () => Date;
  randomBytes?: (size: number) => Buffer;
  onTelemetryError?: (error: unknown) => void;
};

function successEnvelope(
  requestId: string,
  serverTime: string,
  result: AgentFeedListResponse["result"] | AgentChallengeGetResponse["result"],
): AgentFeedListResponse | AgentChallengeGetResponse {
  return {
    protocol: CMAI_AGENT_PROTOCOL,
    protocol_version: CMAI_AGENT_PROTOCOL_VERSION,
    request_id: requestId,
    server_time: serverTime,
    result,
  } as AgentFeedListResponse | AgentChallengeGetResponse;
}

function errorEnvelope(requestId: string, serverTime: string, error: AgentProtocolError): AgentProtocolErrorResponse {
  return {
    protocol: CMAI_AGENT_PROTOCOL,
    protocol_version: CMAI_AGENT_PROTOCOL_VERSION,
    request_id: requestId,
    server_time: serverTime,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      ...(error.field ? { field: error.field } : {}),
      ...(error.retryAfterSeconds !== undefined ? { retry_after_seconds: error.retryAfterSeconds } : {}),
    },
  };
}

function mapFeedError(error: unknown): AgentProtocolError {
  if (error instanceof AgentProtocolError) return error;
  if (error instanceof AgentFeedCursorError) {
    return new AgentProtocolError("cursor_invalid", "Agent feed cursor is invalid or expired.", 400, false, "$.payload.cursor");
  }
  if (error instanceof AgentFeedStoreError) {
    if (error.code === "snapshot_invalid") {
      return new AgentProtocolError("cursor_invalid", "Agent feed cursor is invalid or expired.", 400, false, "$.payload.cursor");
    }
    if (error.code === "request_conflict") {
      return new AgentProtocolError("idempotency_conflict", "Request ID was already used with different signed content.", 409, false, "$.request_id");
    }
    if (error.code === "capacity_exceeded") {
      return new AgentProtocolError("capacity_exceeded", "Agent feed capacity is temporarily exhausted.", 503, true, undefined, 1);
    }
    return new AgentProtocolError("service_unavailable", "Agent feed persistence is temporarily unavailable.", 503, true, undefined, 1);
  }
  if (error instanceof AgentFeedProjectionError) {
    return new AgentProtocolError("challenge_unavailable", "Challenge is unavailable.", 404, false);
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return new AgentProtocolError("malformed_request", "Agent feed request failed bounded validation.", 400, false, "$.payload");
  }
  return new AgentProtocolError("service_unavailable", "Agent feed service is temporarily unavailable.", 503, true, undefined, 1);
}

function mapSubmissionTerminal(result: Exclude<AgentSubmissionAcceptResult, { kind: "accepted" | "replayed" }>): AgentProtocolError {
  switch (result.kind) {
    case "idempotency_conflict":
      return new AgentProtocolError("idempotency_conflict", "The idempotency key is already bound to different canonical submission content.", 409, false, "$.payload.idempotency_key");
    case "duplicate_submit":
      return new AgentProtocolError("duplicate_submit", "This run grant already accepted a different submission.", 409, false, "$.payload.run_nonce");
    case "run_nonce_unknown":
      return new AgentProtocolError("run_nonce_unknown", "The run nonce is unknown.", 409, false, "$.payload.run_nonce");
    case "run_nonce_expired":
      return new AgentProtocolError("run_nonce_expired", "The run nonce has expired.", 409, true, "$.payload.run_nonce", 1);
    case "run_nonce_replayed":
      return new AgentProtocolError("run_nonce_replayed", "The run nonce has already been consumed.", 409, false, "$.payload.run_nonce");
    case "run_nonce_mismatch":
      return new AgentProtocolError("run_nonce_mismatch", "The run nonce does not match this challenge grant.", 409, false, "$.payload.run_nonce");
    case "challenge_unavailable":
      return new AgentProtocolError("challenge_unavailable", "Challenge is unavailable.", 404, false, "$.payload.challenge_id");
  }
}

function failureBucket(error: AgentProtocolError): AgentFeedFailureBucket {
  if (["malformed_request", "body_too_large", "credential_field_forbidden", "cursor_invalid"].includes(error.code)) return "validation";
  if (["pairing_not_found", "pairing_revoked", "pairing_key_inactive", "pairing_key_revoked", "signature_invalid", "scope_unauthorized"].includes(error.code)) return "authorization";
  if (["idempotency_conflict", "run_nonce_replayed", "run_nonce_mismatch", "duplicate_submit"].includes(error.code)) return "conflict";
  if (["request_time_skew", "run_nonce_expired"].includes(error.code)) return "expired";
  if (error.code === "rate_limited") return "policy";
  if (["challenge_unavailable", "capacity_exceeded", "service_unavailable"].includes(error.code)) return "unavailable";
  return "internal";
}

export function agentFeedProtocolResponseStatus(response: AgentFeedReadResponse): number {
  return "error" in response ? agentProtocolErrorHttpStatus[response.error.code] : 200;
}

export function agentContributionSubmitResponseStatus(_response: AgentContributionSubmitResponse): number {
  return 201;
}

export function buildBoundedAgentFeedListResponse(input: {
  requestId: string;
  serverTime: string;
  entries: Array<{ summary: AgentPublicChallengeSummary; resumeOffset: number }>;
  terminalNextOffset?: number;
  cursorForOffset: (offset: number) => string;
  byteLimit?: number;
}): AgentFeedListResponse {
  const byteLimit = input.byteLimit ?? agentProtocolResponseByteLimits["feed.list"];
  if (!Number.isInteger(byteLimit) || byteLimit < 1 || byteLimit > agentProtocolResponseByteLimits["feed.list"]) {
    throw new AgentFeedProjectionError("response_too_large", "Agent feed byte budget is invalid.");
  }
  for (let count = input.entries.length; count >= 0; count -= 1) {
    if (count === 0 && input.entries.length > 0) break;
    const nextOffset = count < input.entries.length
      ? input.entries[count - 1]?.resumeOffset
      : input.terminalNextOffset;
    const nextCursor = nextOffset === undefined ? undefined : input.cursorForOffset(nextOffset);
    const response = successEnvelope(input.requestId, input.serverTime, {
      challenges: input.entries.slice(0, count).map((entry) => entry.summary),
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    }) as AgentFeedListResponse;
    if (utf8JsonBytes(response) <= byteLimit) return response;
  }
  throw new AgentFeedProjectionError("response_too_large", "One Agent feed summary exceeds the aggregate response budget.");
}

export class AgentFeedProtocolService {
  private readonly pairingService: PairingService;
  private readonly store: AgentFeedProtocolStore;
  private readonly cursorSecret: string;
  private readonly telemetry?: AgentFeedTelemetrySink;
  private readonly clock: () => Date;
  private readonly random: (size: number) => Buffer;
  private readonly onTelemetryError?: (error: unknown) => void;

  constructor(options: AgentFeedProtocolServiceOptions) {
    if (Buffer.byteLength(options.cursorSecret, "utf8") < 32) {
      throw new Error("Agent feed cursor secret must be at least 32 UTF-8 bytes.");
    }
    this.pairingService = options.pairingService;
    this.store = options.store;
    this.cursorSecret = options.cursorSecret;
    this.telemetry = options.telemetry;
    this.clock = options.clock ?? (() => new Date());
    this.random = options.randomBytes ?? nodeRandomBytes;
    this.onTelemetryError = options.onTelemetryError;
  }

  private opaqueId(prefix: string, bytes = 18): string {
    return `${prefix}_${this.random(bytes).toString("base64url")}`;
  }

  private emit(event: Parameters<AgentFeedTelemetrySink["emit"]>[0]): void {
    if (!this.telemetry) return;
    try {
      this.telemetry.emit(event);
    } catch (error) {
      this.onTelemetryError?.(error);
    }
  }

  private emitResult(
    request: AgentFeedProtocolRequest,
    authorization: PairingAuthorizationContext,
    response: AgentFeedReadResponse,
    replayed: boolean,
  ): void {
    const eventId = `${authorization.pairingId}:${request.operation}:${request.request_id}`;
    if (replayed || authorization.requestReplay === "exact") return;
    if (request.operation === "feed.list") {
      if ("result" in response) {
        this.emit({
          name: "feed.fetched",
          eventId,
          ownerId: authorization.ownerId,
          runtime: authorization.runtime,
          resultCount: (response as AgentFeedListResponse).result.challenges.length,
        });
      } else {
        this.emit({
          name: "feed.failed",
          eventId,
          ownerId: authorization.ownerId,
          runtime: authorization.runtime,
          failureBucket: failureBucket(mapFeedError(new AgentProtocolError(
            response.error.code,
            response.error.message,
            agentProtocolErrorHttpStatus[response.error.code],
            response.error.retryable,
            response.error.field,
            response.error.retry_after_seconds,
          ))),
        });
      }
      return;
    }

    if ("result" in response) {
      this.emit({
        name: "challenge.grant_issued",
        eventId,
        ownerId: authorization.ownerId,
        pairingId: authorization.pairingId,
        challengeId: request.payload.challenge_id,
        runtime: authorization.runtime,
      });
    } else {
      this.emit({
        name: "challenge.grant_failed",
        eventId,
        ownerId: authorization.ownerId,
        pairingId: authorization.pairingId,
        runtime: authorization.runtime,
        failureBucket: failureBucket(new AgentProtocolError(
          response.error.code,
          response.error.message,
          agentProtocolErrorHttpStatus[response.error.code],
          response.error.retryable,
          response.error.field,
          response.error.retry_after_seconds,
        )),
      });
    }
  }

  private buildFeedListResponse(
    request: AgentFeedListRequest,
    authorization: PairingAuthorizationContext,
    transaction: Parameters<AgentFeedRequestExecutor>[0],
    now: Date,
  ): AgentFeedReadResponse {
    try {
      const filters = normalizeAgentFeedFilters({
        ...(request.payload.query !== undefined ? { query: request.payload.query } : {}),
        ...(request.payload.category !== undefined ? { category: request.payload.category } : {}),
        ...(request.payload.requested_modes !== undefined ? { requested_modes: request.payload.requested_modes } : {}),
        ...(request.payload.min_reward_credits !== undefined ? { min_reward_credits: request.payload.min_reward_credits } : {}),
      });
      const filtersHash = hashAgentFeedFilters(filters);
      const audienceHash = hashAgentFeedCursorAudience(authorization.pairingId, this.cursorSecret);
      const decoded = request.payload.cursor
        ? decodeAgentFeedCursor({
            cursor: request.payload.cursor,
            expectedFiltersHash: filtersHash,
            expectedAudienceHash: audienceHash,
            now,
            secret: this.cursorSecret,
          })
        : undefined;
      const page = transaction.listPage({
        filters,
        filtersHash,
        audienceHash,
        limit: request.payload.limit,
        snapshotId: decoded?.snapshot_id ?? this.opaqueId("snapshot"),
        ...(decoded ? { offset: decoded.offset } : {}),
      });
      const entries = page.challenges.flatMap((challenge, index) => {
        const criteria = page.criteria[index];
        const resumeOffset = page.resumeOffsets[index];
        if (!criteria || resumeOffset === undefined) return [];
        try {
          return [{ summary: projectAgentChallengeSummary(challenge, criteria), resumeOffset }];
        } catch {
          return [];
        }
      });
      const cursorForOffset = (offset: number) => encodeAgentFeedCursor({
        snapshotId: page.snapshotId,
        offset,
        filtersHash,
        audienceHash,
        expiresAt: page.expiresAt,
        secret: this.cursorSecret,
      });
      return buildBoundedAgentFeedListResponse({
        requestId: request.request_id,
        serverTime: now.toISOString(),
        entries,
        ...(page.nextOffset !== undefined ? { terminalNextOffset: page.nextOffset } : {}),
        cursorForOffset,
      });
    } catch (error) {
      return errorEnvelope(request.request_id, now.toISOString(), mapFeedError(error));
    }
  }

  private buildChallengeGetResponse(
    request: AgentChallengeGetRequest,
    authorization: PairingAuthorizationContext,
    transaction: Parameters<AgentFeedRequestExecutor>[0],
    now: Date,
  ): AgentFeedReadResponse {
    let issuedGrant: AgentRunGrantRecord | undefined;
    try {
      const runNonce = this.random(32).toString("base64url");
      const issued = transaction.issueRunGrant({
        grantId: this.opaqueId("grant"),
        pairingId: authorization.pairingId,
        requestId: request.request_id,
        challengeId: request.payload.challenge_id,
        nonceHash: createHash("sha256").update(`CMAI_AGENT_RUN_NONCE_V1\0${runNonce}`, "utf8").digest("hex"),
        promptVersion: AGENT_FEED_PROMPT_VERSION,
        maxOutputBytes: AGENT_FEED_MAX_OUTPUT_BYTES,
        expiresAt: new Date(now.getTime() + AGENT_PROTOCOL_DEFAULT_NONCE_TTL_MS).toISOString(),
      });
      if (issued.kind === "challenge_unavailable") {
        throw new AgentProtocolError("challenge_unavailable", "Challenge is unavailable.", 404, false);
      }
      if (issued.kind === "capacity_exceeded" || issued.kind === "nonce_conflict") {
        throw new AgentProtocolError("capacity_exceeded", "Run grant capacity is temporarily exhausted.", 503, true, undefined, 1);
      }
      issuedGrant = issued.grant;
      const challenge = projectAgentChallenge(issued.challenge, issued.criteria, {
        run_nonce: runNonce,
        issued_at: issued.grant.issuedAt,
        expires_at: issued.grant.expiresAt,
        request_class: issued.grant.requestClass,
        challenge_revision: issued.grant.challengeRevision,
        prompt_version: issued.grant.promptVersion,
        max_output_bytes: issued.grant.maxOutputBytes,
      });
      return successEnvelope(request.request_id, now.toISOString(), { challenge });
    } catch (error) {
      if (issuedGrant) {
        transaction.discardRunGrant({
          grantId: issuedGrant.grantId,
          pairingId: issuedGrant.pairingId,
          requestId: issuedGrant.requestId,
          nonceHash: issuedGrant.nonceHash,
        });
      }
      return errorEnvelope(request.request_id, now.toISOString(), mapFeedError(error));
    }
  }

  async assertPreAuthNetworkRateLimit(networkIdentity: string): Promise<void> {
    await this.pairingService.assertAgentFeedNetworkRateLimit({ identity: networkIdentity });
  }

  async executeSubmission(
    request: AgentContributionSubmitRequest,
    networkIdentity: string,
    options: { networkRateLimitPrecharged?: boolean } = {},
  ): Promise<AgentContributionSubmitResponse> {
    if (!options.networkRateLimitPrecharged) await this.assertPreAuthNetworkRateLimit(networkIdentity);
    const executed = await this.pairingService.authorizeAndExecute(request, async (authorization) => {
      const now = this.clock();
      try {
        if (request.payload.audit.runtime !== authorization.runtime) {
          throw new AgentProtocolError("contribution_card_malformed", "Submission audit runtime does not match the paired runtime.", 422, false, "$.payload.audit.runtime");
        }
        const transactionStore = authorization.agentFeedStore ?? this.store;
        if (!transactionStore.submitAgentFeedContribution) {
          throw new AgentFeedStoreError("store_not_ready", "Agent contribution persistence is unavailable.");
        }
        const requestHash = hashAgentProtocolPayload({
          sent_at: request.sent_at,
          key_id: request.auth.key_id,
          payload: request.payload,
        });
        const normalizedCard = pairedLocalContributionCardV1Schema.parse(
          normalizePairedAdapterContribution(request.payload.card, request.payload.audit),
        );
        const input: AgentFeedSubmissionInput = {
          pairingId: authorization.pairingId,
          requestId: request.request_id,
          challengeId: request.payload.challenge_id,
          challengeRevision: request.payload.challenge_revision,
          nonceHash: createHash("sha256").update(`CMAI_AGENT_RUN_NONCE_V1\0${request.payload.run_nonce}`, "utf8").digest("hex"),
          idempotencyKeyHash: createHash("sha256").update(request.payload.idempotency_key, "utf8").digest("hex"),
          requestHash,
          payloadHash: hashAgentProtocolPayload(request.payload),
          cardHash: hashAgentProtocolPayload(normalizedCard),
          submissionId: this.opaqueId("submission"),
          contributionId: this.opaqueId("contribution"),
          contributorId: authorization.ownerId,
          contributorKind: "agent",
          contributorLabel: `Paired ${authorization.runtime} agent`,
          card: normalizedCard,
          externallyGenerated: true,
          acceptedAt: now.toISOString(),
          requestAuthorizedAt: authorization.requestAuthorizedAt,
          requestReceiptExpiresAt: authorization.requestReceiptExpiresAt,
        };
        const result = await transactionStore.submitAgentFeedContribution(input, now);
        if ((authorization.requestReplay === "exact") !== result.requestReplayed) {
          throw new AgentFeedStoreError("store_not_ready", "Pairing and submission replay evidence disagree.");
        }
        if (result.kind !== "accepted" && result.kind !== "replayed") {
          return { requestReplayed: result.requestReplayed, terminal: result };
        }
        const response: AgentContributionSubmitResponse = {
          protocol: CMAI_AGENT_PROTOCOL,
          protocol_version: CMAI_AGENT_PROTOCOL_VERSION,
          request_id: request.request_id,
          server_time: now.toISOString(),
          result: {
            submission_id: result.submissionId,
            contribution_id: result.contribution.id,
            status: "accepted",
            replayed: result.replayed,
            accepted_at: result.contribution.createdAt,
            trust: {
              tier: "paired_local_agent",
              provider_verified: false,
              remote_attestation: false,
            },
          },
        };
        return { requestReplayed: result.requestReplayed, response };
      } catch (error) {
        throw mapFeedError(error);
      }
    });
    if ("terminal" in executed && executed.terminal) throw mapSubmissionTerminal(executed.terminal);
    if (!executed.response) throw new AgentProtocolError("service_unavailable", "Submission outcome was unavailable.", 503, true, undefined, 1);
    return executed.response;
  }

  async execute(
    request: AgentFeedProtocolRequest,
    networkIdentity: string,
    options: { networkRateLimitPrecharged?: boolean } = {},
  ): Promise<AgentFeedReadResponse> {
    if (!options.networkRateLimitPrecharged) await this.assertPreAuthNetworkRateLimit(networkIdentity);
    return await this.pairingService.authorizeAndExecute(request, async (authorization) => {
      const now = this.clock();
      const eventId = `${authorization.pairingId}:${request.operation}:${request.request_id}`;
      const input: AgentFeedRequestTransactionInput = {
        pairingId: authorization.pairingId,
        operation: request.operation,
        requestId: request.request_id,
        requestHash: hashAgentProtocolPayload({
          sent_at: request.sent_at,
          key_id: request.auth.key_id,
          payload: request.payload,
        }),
        responseCacheId: this.opaqueId("feed_response"),
        requestAuthorizedAt: authorization.requestAuthorizedAt,
        requestReceiptExpiresAt: authorization.requestReceiptExpiresAt,
      };
      try {
        const transactionStore = authorization.agentFeedStore ?? this.store;
        const result = await transactionStore.transactAgentFeedRequest(
          input,
          (transaction) => request.operation === "feed.list"
            ? this.buildFeedListResponse(request, authorization, transaction, now)
            : this.buildChallengeGetResponse(request, authorization, transaction, now),
          now,
        );
        if ((authorization.requestReplay === "exact") !== result.replayed) {
          throw new AgentFeedStoreError("store_not_ready", "Pairing and feed replay evidence disagree.");
        }
        this.emitResult(request, authorization, result.response, result.replayed);
        return result.response;
      } catch (error) {
        const mapped = mapFeedError(error);
        if (authorization.requestReplay === "new") {
          if (request.operation === "feed.list") {
            this.emit({
              name: "feed.failed",
              eventId,
              ownerId: authorization.ownerId,
              runtime: authorization.runtime,
              failureBucket: failureBucket(mapped),
            });
          } else {
            this.emit({
              name: "challenge.grant_failed",
              eventId,
              ownerId: authorization.ownerId,
              pairingId: authorization.pairingId,
              runtime: authorization.runtime,
              failureBucket: failureBucket(mapped),
            });
          }
        }
        throw mapped;
      }
    });
  }
}
