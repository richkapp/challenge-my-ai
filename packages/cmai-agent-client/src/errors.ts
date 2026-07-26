import {
  agentProtocolErrorCodes,
  agentProtocolErrorRetryability,
  type AgentProtocolErrorCode,
  AgentProtocolError,
} from "../../../lib/agent-protocol/errors";

export const cmaiAgentClientErrorCodes = [
  "client_invalid_state",
  "client_configuration_invalid",
  "client_response_request_mismatch",
  "transport_timeout",
  "transport_unavailable",
  "transport_rate_limited",
  "transport_response_malformed",
  ...agentProtocolErrorCodes,
] as const;

export type CmaiAgentClientErrorCode =
  | (typeof cmaiAgentClientErrorCodes)[number]
  | AgentProtocolErrorCode;

export type CmaiAgentErrorSource = "client" | "transport" | "protocol";

export type CmaiAgentRecovery =
  | "none"
  | "repair_input"
  | "retry_same_request"
  | "fetch_fresh_challenge"
  | "re_pair"
  | "manual_copy_fallback";

export type CmaiAgentClientErrorSnapshot = {
  code: CmaiAgentClientErrorCode;
  source: CmaiAgentErrorSource;
  message: string;
  retryable: boolean;
  recovery: CmaiAgentRecovery;
  field?: string;
  retryAfterSeconds?: number;
  originalSubmissionId?: string;
};

export const protocolRecoveryByCode = {
  malformed_request: "repair_input",
  body_too_large: "repair_input",
  unsupported_protocol_version: "manual_copy_fallback",
  credential_field_forbidden: "repair_input",
  pairing_not_found: "re_pair",
  pairing_revoked: "re_pair",
  pairing_key_inactive: "re_pair",
  pairing_key_revoked: "re_pair",
  signature_invalid: "re_pair",
  request_time_skew: "retry_same_request",
  scope_unauthorized: "re_pair",
  challenge_unavailable: "none",
  cursor_invalid: "repair_input",
  rate_limited: "retry_same_request",
  capacity_exceeded: "retry_same_request",
  service_unavailable: "retry_same_request",
  run_nonce_unknown: "fetch_fresh_challenge",
  run_nonce_expired: "fetch_fresh_challenge",
  run_nonce_replayed: "fetch_fresh_challenge",
  run_nonce_mismatch: "fetch_fresh_challenge",
  idempotency_key_required: "repair_input",
  idempotency_conflict: "none",
  duplicate_submit: "none",
  contribution_card_malformed: "repair_input",
} as const satisfies Record<AgentProtocolErrorCode, CmaiAgentRecovery>;

export class CmaiAgentClientError extends Error {
  readonly code: CmaiAgentClientErrorCode;
  readonly source: CmaiAgentErrorSource;
  readonly retryable: boolean;
  readonly recovery: CmaiAgentRecovery;
  readonly field?: string;
  readonly retryAfterSeconds?: number;
  readonly originalSubmissionId?: string;

  constructor(snapshot: CmaiAgentClientErrorSnapshot) {
    super(snapshot.message);
    this.name = "CmaiAgentClientError";
    this.code = snapshot.code;
    this.source = snapshot.source;
    this.retryable = snapshot.retryable;
    this.recovery = snapshot.recovery;
    this.field = snapshot.field;
    this.retryAfterSeconds = snapshot.retryAfterSeconds;
    this.originalSubmissionId = snapshot.originalSubmissionId;
  }

  snapshot(): CmaiAgentClientErrorSnapshot {
    return {
      code: this.code,
      source: this.source,
      message: this.message,
      retryable: this.retryable,
      recovery: this.recovery,
      ...(this.field ? { field: this.field } : {}),
      ...(this.retryAfterSeconds ? { retryAfterSeconds: this.retryAfterSeconds } : {}),
      ...(this.originalSubmissionId ? { originalSubmissionId: this.originalSubmissionId } : {}),
    };
  }
}

export function clientStateError(message: string): CmaiAgentClientError {
  return new CmaiAgentClientError({
    code: "client_invalid_state",
    source: "client",
    message,
    retryable: false,
    recovery: "none",
  });
}

export function clientConfigurationError(message: string, field?: string): CmaiAgentClientError {
  return new CmaiAgentClientError({
    code: "client_configuration_invalid",
    source: "client",
    message,
    retryable: false,
    recovery: "repair_input",
    ...(field ? { field } : {}),
  });
}

export function fromAgentProtocolError(error: AgentProtocolError): CmaiAgentClientError {
  return new CmaiAgentClientError({
    code: error.code,
    source: "protocol",
    message: error.message,
    retryable: agentProtocolErrorRetryability[error.code],
    recovery: protocolRecoveryByCode[error.code],
    ...(error.field ? { field: error.field } : {}),
  });
}

export function protocolResponseError(input: {
  code: AgentProtocolErrorCode;
  message: string;
  retryable: boolean;
  field?: string;
  retry_after_seconds?: number;
  original_submission_id?: string;
}): CmaiAgentClientError {
  return new CmaiAgentClientError({
    code: input.code,
    source: "protocol",
    message: input.message,
    retryable: input.retryable,
    recovery: protocolRecoveryByCode[input.code],
    ...(input.field ? { field: input.field } : {}),
    ...(input.retry_after_seconds ? { retryAfterSeconds: input.retry_after_seconds } : {}),
    ...(input.original_submission_id ? { originalSubmissionId: input.original_submission_id } : {}),
  });
}
