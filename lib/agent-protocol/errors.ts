export const agentProtocolErrorCodes = [
  "malformed_request",
  "body_too_large",
  "unsupported_protocol_version",
  "credential_field_forbidden",
  "pairing_not_found",
  "pairing_revoked",
  "pairing_key_inactive",
  "pairing_key_revoked",
  "signature_invalid",
  "request_time_skew",
  "scope_unauthorized",
  "challenge_unavailable",
  "cursor_invalid",
  "rate_limited",
  "capacity_exceeded",
  "service_unavailable",
  "run_nonce_unknown",
  "run_nonce_expired",
  "run_nonce_replayed",
  "run_nonce_mismatch",
  "idempotency_key_required",
  "idempotency_conflict",
  "duplicate_submit",
  "contribution_card_malformed",
] as const;

export type AgentProtocolErrorCode = (typeof agentProtocolErrorCodes)[number];

export const agentProtocolErrorRetryability = {
  malformed_request: false,
  body_too_large: false,
  unsupported_protocol_version: false,
  credential_field_forbidden: false,
  pairing_not_found: false,
  pairing_revoked: false,
  pairing_key_inactive: false,
  pairing_key_revoked: false,
  signature_invalid: false,
  request_time_skew: true,
  scope_unauthorized: false,
  challenge_unavailable: false,
  cursor_invalid: false,
  rate_limited: true,
  capacity_exceeded: true,
  service_unavailable: true,
  run_nonce_unknown: false,
  run_nonce_expired: true,
  run_nonce_replayed: false,
  run_nonce_mismatch: false,
  idempotency_key_required: false,
  idempotency_conflict: false,
  duplicate_submit: false,
  contribution_card_malformed: false,
} as const satisfies Record<AgentProtocolErrorCode, boolean>;

export const agentProtocolErrorHttpStatus = {
  malformed_request: 400,
  body_too_large: 413,
  unsupported_protocol_version: 400,
  credential_field_forbidden: 422,
  pairing_not_found: 401,
  pairing_revoked: 401,
  pairing_key_inactive: 401,
  pairing_key_revoked: 401,
  signature_invalid: 401,
  request_time_skew: 401,
  scope_unauthorized: 403,
  challenge_unavailable: 404,
  cursor_invalid: 400,
  rate_limited: 429,
  capacity_exceeded: 503,
  service_unavailable: 503,
  run_nonce_unknown: 409,
  run_nonce_expired: 409,
  run_nonce_replayed: 409,
  run_nonce_mismatch: 409,
  idempotency_key_required: 422,
  idempotency_conflict: 409,
  duplicate_submit: 409,
  contribution_card_malformed: 422,
} as const satisfies Record<AgentProtocolErrorCode, number>;

export class AgentProtocolError extends Error {
  constructor(
    public readonly code: AgentProtocolErrorCode,
    message: string,
    public readonly status: number,
    public readonly retryable = false,
    public readonly field?: string,
    public readonly retryAfterSeconds?: number,
  ) {
    if (status !== agentProtocolErrorHttpStatus[code]) {
      throw new TypeError(`${code} must use HTTP ${agentProtocolErrorHttpStatus[code]}.`);
    }
    if (retryable !== agentProtocolErrorRetryability[code]) {
      throw new TypeError(`${code} has fixed retryable=${String(agentProtocolErrorRetryability[code])} semantics.`);
    }
    if (retryable && retryAfterSeconds === undefined) {
      throw new TypeError("A retryable Agent protocol error requires retryAfterSeconds.");
    }
    if (retryAfterSeconds !== undefined && (!retryable || !Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 1 || retryAfterSeconds > 86_400)) {
      throw new TypeError("retryAfterSeconds requires a retryable error and an integer from 1 to 86400.");
    }
    super(message);
    this.name = "AgentProtocolError";
  }
}
