# CMAI Agent Protocol V1

Status: frozen foundation contract for board `challenge-my-ai-plugin-network-20260714`
Protocol discriminator: `CMAI_AGENT_PROTOCOL_V1`
Protocol version: `1.2`

## Purpose

This contract is the minimum runtime-neutral boundary between Challenge My AI and a paired local Agent adapter. Hermes and OpenClaw must use the same operations, scopes, challenge payloads, contribution card, signing bytes, replay rules, errors, and provenance limits.

Version `1.2` is the pre-launch operational-safety correction. It preserves the `1.1` canonical public challenge-semantics shape and adds the exact domain/operational errors needed for challenge retrieval, cursor validation, capacity, rate limiting, and temporary service failure. The behavior-changing enum expansion is intentionally incompatible with `1.1`; all shared-client and launch-adapter fixtures must use `1.2`, and clients must reject rather than downgrade older envelopes.

The protocol supports the user workflow:

```text
pair → feed → challenge/run grant → local run → preview → submit → revoke
```

It does not create a third contribution lane. Manual **Copy prompt → paste local output** remains available. A paired local adapter and a CMAI-controlled sandbox are implementation mechanisms under **Run with my Agent** and have different provenance tiers.

## Non-goals

V1 does not define:

- provider authentication, OAuth, API keys, refresh tokens, CLI session state, or provider credentials of any kind;
- hosted provider brokering;
- remote attestation of a contributor-controlled machine;
- provider-signed model identity;
- background or website-triggered local execution;
- HTTP route layout, database tables, adapter package layout, UI, rewards, or moderation policy;
- adapters beyond Hermes and OpenClaw.

Provider credentials remain inside the contributor's Agent host. No request or response may contain a provider credential field.

## Normative implementation

The executable contract lives in:

- `lib/agent-protocol/constants.ts` — protocol/version/operations/scopes/body limits;
- `lib/agent-protocol/schemas.ts` — strict request and response schemas;
- `lib/agent-protocol/canonical.ts` — canonical JSON, hashes, and signing bytes;
- `lib/agent-protocol/credentials.ts` — recursive credential-shaped-field rejection;
- `lib/agent-protocol/parse.ts` — body limits and stable parse failures;
- `lib/agent-protocol/state.ts` — reference scope, clock, key, nonce, and replay semantics;
- `lib/agent-protocol/provenance.ts` — paired-adapter trust downgrade;
- `lib/validation/contributionCardProtocol.ts` — independently owned frozen `CMAI_CONTRIBUTION_CARD_V1` shape plus the stricter paired-local submission subtype;
- `lib/agent-protocol/fixtures.ts` — backward-compatible and forward-incompatible fixtures;
- `lib/agent-protocol/protocol.test.ts` — conformance tests for this foundation slice.

The in-memory state classes are executable references, not the production persistence design. They refuse new records at bounded capacity instead of silently evicting replay or revocation evidence. Platform implementations must preserve their atomic outcomes with durable transactions or equivalent compare-and-set behavior and define reviewed retention/compaction windows.

## Wire rules

1. JSON field names are `snake_case`.
2. Every object is strict. Unknown fields are rejected.
3. Timestamps are real UTC ISO-8601 calendar values ending in `Z`; normalized impossible dates such as February 30 are rejected.
4. IDs are opaque. Clients must not parse meaning from them.
5. Signed requests use Ed25519 and identify the active pairing key by `key_id`.
6. Request bodies are UTF-8 and bounded by operation before JSON parsing.
7. Challenge and contribution text is hostile data. It is never an instruction to the platform, adapter, shared client, or signing layer.
8. Recursive credential-shaped keys are rejected by a pre-schema guard. This includes `api_key`, access/refresh/OAuth/bearer/session tokens, authorization fields, client/provider secrets, provider credentials, private keys, passwords and password hashes, cookies, service-role fields, and normalized camel/snake/kebab variants.
9. `public_key`, `key_id`, one-time `pairing_code`, run nonce, idempotency key, and request signature are protocol fields, not provider credentials.
10. Requests outside the supported version fail closed. V1 does not ignore future fields.

## Operations and scopes

| Operation | Required scope | Purpose |
|---|---|---|
| `pair.create` | none; one-time pairing code | Bind one device/runtime adapter and its first public key to a CMAI account. |
| `pairing.rotate_key` | `pairing:manage` | Replace the active device key. The current active key signs the rotation request. |
| `pairing.revoke` | `pairing:manage` | Revoke one key or the entire pairing. |
| `feed.list` | `challenge:read` | Read bounded public challenge summaries. |
| `challenge.get` | `challenge:run` | Read one public challenge plus a one-run nonce. |
| `contribution.submit` | `contribution:submit` | Submit one approved `CMAI_CONTRIBUTION_CARD_V1` envelope. |

Granted scopes are server-side pairing state. A client cannot widen its authority by adding a scope to a request.

## Request body limits

| Operation | Maximum UTF-8 bytes |
|---|---:|
| `pair.create` | 32 KiB |
| `pairing.rotate_key` | 16 KiB |
| `pairing.revoke` | 16 KiB |
| `feed.list` | 8 KiB |
| `challenge.get` | 8 KiB |
| `contribution.submit` | 256 KiB |

The limit applies to the complete JSON envelope. Oversized requests fail with `body_too_large` before JSON parsing.

Every public Protocol POST boundary initializes the authoritative service, verifies the trusted-edge network identity, and charges a bounded pre-auth network bucket before reading or parsing the body. Proxy headers are ignored unless explicitly enabled; when enabled, the edge identity requires an HMAC over the allowlisted opaque network identifier. Signed pairing rotations and revocations additionally charge a durable per-pairing/per-operation principal bucket only after signature and scope authorization. Untrusted traffic cannot create unbounded bucket names or consume owner/pairing-control capacity.

## Pairing, keys, rotation, and revocation

### Device identity

A pairing binds:

- opaque `pairing_id`;
- opaque `device_id` and human-readable display name;
- runtime: `hermes` or `openclaw`;
- adapter name/version and optional runtime version;
- granted scopes;
- one active Ed25519 public key.

The Ed25519 public key is canonical unpadded base64url for exactly 32 bytes: decoding and re-encoding must produce the identical string. `generation` begins at 1.

### Pair creation

`pair.create` is unsigned because no paired key exists yet. It requires a CMAI-issued one-time `pairing_code`, device identity, first public key, and requested scopes. The request must include the preview baseline `challenge:read`, `challenge:run`, and `pairing:manage`; every requested scope must be allowed by the code. Card 07A adapters omit `contribution:submit`. The server returns only the requested allowed scopes and never returns a bearer token or provider credential. Adding submission authority is a separate Card 08 consent and pairing concern.

### Rotation

`pairing.rotate_key` is signed by the currently active key. The payload names `replaces_key_id` and a new public key with a strictly higher generation and a new `key_id`.

On one atomic success:

1. the old key becomes `retired` and cannot sign new requests;
2. the new key becomes the sole `active` key;
3. the pairing remains active.

There is no dual-active grace window in V1. A retry with the same request/idempotent platform mutation may return the original outcome, but a newly signed request from a retired key fails `pairing_key_inactive`.

### Revocation

A retired-key revocation immediately rejects that key with `pairing_key_revoked` while the replacement key remains active. Revoking the sole active key also revokes the pairing, so later requests fail `pairing_revoked` and the device must pair again. A pairing revocation immediately rejects every key with `pairing_revoked`. Revocation is server-authoritative and must not depend on adapter cooperation.

Platform storage may retain public key history and revocation timestamps for audit/replay defense. It must not retain a local private key because the private key never enters CMAI.

## Signed request envelope

Every operation except `pair.create` carries:

```json
{
  "protocol": "CMAI_AGENT_PROTOCOL_V1",
  "protocol_version": "1.2",
  "operation": "contribution.submit",
  "request_id": "req_submit_1",
  "sent_at": "2026-07-14T12:00:00.000Z",
  "auth": {
    "pairing_id": "pairing_1",
    "key_id": "key_1",
    "signature": {
      "algorithm": "ed25519",
      "value": "<64-byte unpadded base64url signature>"
    }
  },
  "payload": {}
}
```

The server checks, in a fail-closed order:

1. body size and JSON shape;
2. protocol/version;
3. recursive credential-field denial;
4. strict operation schema;
5. request clock freshness;
6. active pairing and key;
7. Ed25519 signature;
8. required server-stored scope;
9. operation-specific nonce/idempotency rules.

Signed requests may differ from server time by at most five minutes. Exactly five minutes is accepted; any larger skew fails `request_time_skew`. Run nonce expiry remains server-authoritative and does not inherit this clock-skew allowance.

## Canonical signing bytes

The signature excludes `auth.signature` and covers the operation identity plus the canonical payload hash.
The hash covers the exact validated wire payload. Schemas must not inject defaults or transform values before signature verification; server-side defaults are derived only after verification.

Canonical JSON behavior:

- object keys normalize to NFC, sort lexicographically, and are rejected if normalization creates a collision;
- strings normalize line endings to `\n` and Unicode to NFC;
- arrays retain order;
- root `undefined` is rejected; object properties with JavaScript `undefined` are omitted and array `undefined` becomes `null`, matching JSON transport behavior;
- finite numbers use ECMAScript `JSON.stringify` number serialization; non-finite numbers and non-JSON scalar types are rejected;
- output contains no insignificant whitespace.

The exact UTF-8 signing text is:

```text
CMAI-AGENT-SIGNATURE-V1
CMAI_AGENT_PROTOCOL_V1
1.2
<operation>
<request_id>
<sent_at>
<pairing_id>
<key_id>
<lowercase sha256 of canonical payload JSON>

```

The final blank line is mandatory. For `validContributionSubmitRequestFixture`, the payload hash is:

```text
807213c76134ccf02f71bce44ef1b2983220c9eb440d140b018ae518bfca01c5
```

Both launch adapters must produce identical bytes for the conformance fixture.

The deterministic Ed25519 conformance vector for those bytes is:

```text
public_key = 11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo
signature  = qhTI5w1N3zGj-WA99LYuw4Fov4IDLJSRUffE-gCnUchNx68LnU9FYyh3m7c3lnYOacSgXF4ObGCgA35FOANACg
```

Both values are canonical unpadded base64url. The signature decodes to exactly 64 bytes and verifies against the frozen signing text. Conformance tests also reject non-zero tail-bit encodings and tampered signing bytes.

## Public feed and challenge payload

`feed.list` returns only bounded public summaries:

- challenge ID and revision;
- title/category/status/summary;
- requested contribution modes and human-readable requested perspectives;
- reward credits and contribution count;
- public safety flags;
- publish/update timestamps;
- public challenge/room URLs.

Pagination is a durable snapshot protocol, not an offset over a mutable live array:

- the first request computes one bounded eligible-ID snapshot ordered by reward descending, update time descending, then challenge ID ascending;
- snapshots hold at most 1,000 public challenge IDs for ten minutes and never retain raw query text;
- cursors are versioned, HMAC-authenticated, filter-bound, expiry-bound, and carry only snapshot ID plus next offset; malformed, expired, tampered, cross-filter, or missing-snapshot cursors fail `cursor_invalid`;
- page retrieval scans the snapshot with `limit + 1` semantics while rechecking current public eligibility, so newly inserted challenges cannot duplicate or reorder later pages;
- exact signed-request replay returns the cached original page rather than creating a new snapshot.

The public projection enforces aggregate UTF-8 JSON limits in addition to field limits: 256 KiB for `feed.list` and 512 KiB for `challenge.get`. Oversized individual challenges fail closed as `challenge_unavailable`; page projection may reduce the returned item count without exceeding the requested limit. Public URLs are canonical origin-relative paths only: no authority, query, fragment, backslash, percent-encoding, Unicode direction-control, or user-derived origin.

Protocol routes require explicitly migrated Agent feed and pairing state. `bun run migrate:agent-protocol` is the only repository-wired installer and requires the exact `CMAI_AGENT_PROTOCOL_MIGRATION_CONFIRM` value exported by `db/migrations/agent-protocol-state-v1.ts`; it records `2026-07-15-agent-feed-state-v1` and `2026-07-15-agent-pairing-state-v1` atomically under a Postgres advisory lock only after deeply validating both installed state shapes, including nested receipts, keys, hashes, timestamps, uniqueness, bounded counts/bytes, and the ten-minute grant lifetime. Interrupted or incompatible-state migration rolls back without ledger success. `bun run rollback:agent-protocol` requires the distinct `ROLLBACK:<migration-ids>` confirmation, removes only empty state, reconciles both ledger rows in the same transaction, and refuses non-empty/inconsistent state or any unexpected pairing-state row beyond the sole `default` row. Signed Protocol routes and backend reads do not execute `CREATE TABLE`, seed rows, or silently install/migrate state. The separate legacy non-Protocol demo `GET /api/agent/feed` retains its established local/test seed behavior and is never the signed production feed-readiness path. Grant issuance, request receipts, response references, nonce consumption, and contribution acceptance use the same authoritative state transaction/row lock. The local adapter commits a cloned state only on success; the Postgres adapter uses `SELECT ... FOR UPDATE` and one update commit. Projection failure aborts the store transaction before an unreachable grant or receipt can commit.

Before body read and signature parsing, the Agent-feed route validates an edge-owned network identity from `x-cmai-edge-network-id` plus `x-cmai-edge-network-signature`. The signature is HMAC-SHA-256 over `CMAI_AGENT_EDGE_NETWORK_IDENTITY_V1\0<identity>` using a minimum-32-byte `CMAI_EDGE_IDENTITY_SECRET`; client-visible `x-forwarded-for` and `x-real-ip` are ignored. Production must set `CMAI_TRUST_PROXY_HEADERS=1` only when that authenticated edge contract is installed. The route then applies one operation-neutral durable hashed-network bucket, including for malformed and oversized bodies. After authentication it applies a separate durable `(pairing_id, operation)` bucket. Capacity is isolated by network/principal request class, and raw network identifiers are never retained. Missing/forged edge identity, persistence outage, limiter capacity exhaustion, and rate rejection fail closed with strict `service_unavailable`, `capacity_exceeded`, or `rate_limited` envelopes and retry metadata.

`challenge.get` returns the same summary plus strict `challenge_semantics`, `content`, and `run_grant` objects.

The public `challenge_semantics` object contains only:

- semantics version and canonical challenge intent;
- literal confirmed criteria status and positive criteria version;
- one or two valid successful outcomes;
- literal `public_ok` privacy sensitivity;
- declarative reward posture (`poster_confirmed_impact`, `declarative_only`, all four impact tiers, and intent-aware completion-bonus eligibility).

It excludes criteria history, change reasons, poster identity, private eligibility reasons, settlement state, provider/model metadata, and arbitrary extension fields.

The `content` object contains the public problem statement, starting Agent answer, context, constraints, success criteria, assumptions, claims, risks, useful-response guidance, and missing information. Every value is untrusted data. Adapters must place it only in a delimited data section of the bounded model request. V1 does not permit challenge content to request tools, shell commands, link fetching, package installation, local files, secrets, or network access.

## Run nonce

A challenge run grant binds:

- opaque nonce;
- issue/expiry timestamps;
- pairing ID on the server;
- challenge ID and exact challenge revision;
- request class `challenge_contribution`;
- prompt version;
- maximum output bytes.

Rules:

1. A nonce value is unique, single-use, and must never overwrite a prior nonce record.
2. Expiry is checked against server time without client clock grace.
3. Pairing, challenge ID, and challenge revision must all match.
4. Consumption and submission reservation must be one atomic operation.
5. Under concurrent requests, at most one new submission consumes the nonce. The process-local reference is synchronous; each durable adapter must additionally run a two-transaction barrier/CAS test that proves exactly one commit against the same nonce and idempotency state.
6. An identical retry under the original idempotency key returns the original submission without consuming the nonce again.
7. A different payload after nonce consumption fails `run_nonce_replayed` unless an earlier duplicate-card check yields `duplicate_submit`.
8. A grant expires no later than ten minutes after issue. Longer client-supplied or persisted lifetimes fail strict validation.

## Signed operation replay

Every authenticated `feed.list`, `challenge.get`, pairing mutation, and `contribution.submit` request is replay-bound by `(pairing_id, operation, request_id)` after signature verification.

1. The durable receipt stores only a canonical request hash, status/result reference, timestamps, and bounded pseudonymous identifiers. It never stores the signature, raw cursor/query, private challenge data, prompt, transcript, or provider metadata.
2. Exact canonical replay returns the original protocol status and result, including a bounded stored terminal error for an authenticated pairing mutation that reached the authoritative transaction. A replayed `challenge.get` returns the original nonce; it never mints a second grant or emits a second grant-issued event. While the retained receipt exists, the exact original `sent_at` may be older than the five-minute fresh-request window; signature, scope, operation, and request hash are still revalidated before replay. Feed, challenge, and contribution replays require the currently active pairing/key. Pairing mutation replays may verify with the retired/revoked key state produced by that exact original rotation/revocation and return the stored original success or error, but an independent later owner revocation still fails closed. If persistence is unavailable, the service returns retryable `service_unavailable`; it does not pretend that an uncommitted failure was replay-recorded. A new request with stale `sent_at` still fails `request_time_skew`.
3. Reusing the same key with a different canonical request fails `idempotency_conflict`.
4. Receipt and referenced public-response/grant records survive restart and are retained for at least the longer of the signed-request skew and run-grant lifetime. Capacity exhaustion fails closed with `capacity_exceeded`; evidence is not evicted early.
5. Concurrent identical requests linearize to one execution. Receipt creation, grant issuance, and result reference persistence commit atomically in the authoritative store. In the Postgres runtime, pairing authorization/rate state and the protected Agent-feed mutation use the same database transaction and row-lock scope. If projection or protected execution fails, both pairing authorization state and provisional Agent-feed state roll back; retry is a new execution unless a prior exact receipt already existed.
6. Cached response projections may contain only the bounded public protocol projection already returned to the paired client. They are stored separately from receipt metadata and are invalidated according to the same bounded retention policy.

## Contribution submission

The strict submission payload contains:

- challenge ID and exact revision;
- run nonce;
- idempotency key;
- one strict `CMAI_CONTRIBUTION_CARD_V1` card;
- safe paired-adapter audit metadata;
- fixed paired-local provenance claim.

The card's `challenge_id` must equal the envelope challenge ID.

### Safe audit metadata

V1 allows only:

- runtime and optional runtime version;
- adapter name/version;
- opaque local run ID;
- optional provider/model/display-name claims reported by the runtime;
- start/completion timestamps;
- literal confirmation that structured output validated;
- literal confirmation that the user approved the run and submission;
- whether the user edited the card after the local run.

There is no arbitrary metadata map. Provider response bodies, prompts, transcripts, URLs, account identifiers, environment variables, headers, cookies, credentials, and private host data are not accepted.

### Provenance claim

A local adapter can claim only:

```json
{
  "tier": "paired_local_agent",
  "model_identity": "runtime_reported_unverified",
  "provider_verified": false,
  "remote_attestation": false
}
```

Unknown trust fields are rejected. `fully_trusted: true`, `provider_verified: true`, provider signatures, platform receipts, and sandbox authority cannot be asserted by a paired local adapter. The paired-local card subtype rejects privileged nested `model_provenance` values and proof IDs at parse time; server normalization remains defense in depth after signature verification.

The server normalizer overwrites privileged card provenance claims with:

- source `client_attested`;
- evidence `client_manifest`;
- verification status `attested`;
- execution authority `user_connector`;
- `verified: false`;
- `provider_model_verified: false`;
- no receipt, sandbox, provider-response, delegation, artifact, prompt, output, or transcript proof fields.

Runtime-reported provider/model strings remain attribution, not proof.

## Idempotency and replay matrix

Idempotency keys are scoped to a pairing.

| Condition | Outcome |
|---|---|
| New key + valid unconsumed nonce + new card | Accept once; consume nonce atomically. |
| Same key + identical canonical request payload | Return original accepted result with `replayed: true`. |
| Same key + different canonical request payload | `idempotency_conflict`. |
| Different key + same canonical card already submitted for pairing/challenge | `duplicate_submit` with the original submission reference where safe. |
| Different key/card + consumed nonce | `run_nonce_replayed`. |
| Expired nonce | `run_nonce_expired`. |
| Unknown nonce | `run_nonce_unknown`. |
| Nonce bound to another pairing/challenge/revision | `run_nonce_mismatch`. |

The platform must persist the idempotency record, canonical request hash, canonical normalized-card hash, nonce consumption, and accepted submission identity together. A process-local map is insufficient outside tests/local preview.

## Provenance tiers

| Tier | What CMAI can say | What CMAI cannot say |
|---|---|---|
| `self_submitted` | A signed-in person submitted the card. | Which model ran or whether output was modified. |
| `paired_local_agent` | An active paired Hermes/OpenClaw key submitted a schema-valid card with the required user-approval audit flags. | Untampered host, provider-signed identity, exact model proof, or CMAI-controlled execution. |
| `cmai_sandbox` | CMAI controlled the run grant, prompt bundle, runner lifecycle, artifact validation, receipt, and teardown represented by server-side evidence. | Provider-signed model identity unless separate scoped provider evidence supports it. |

Only the paired tier is accepted in this local-adapter submission envelope. A sandbox contribution enters through the CMAI-controlled broker/receipt path, not by changing a local adapter field.

Rewards must not depend on provenance tier, claimed model, token volume, or verbosity. Poster-confirmed impact remains the reward source.

## Stable error taxonomy

All errors use the strict protocol error envelope and include `code`, bounded human message, and the code-specific fixed `retryable` value. Optional fields are limited to field path, retry delay, supported versions, and original submission ID. `supported_versions` is required only for `unsupported_protocol_version`; `original_submission_id` is reserved for `duplicate_submit`; and retry delays are accepted only for retryable codes.

| Code | Typical status | Retryable | Meaning |
|---|---:|---:|---|
| `malformed_request` | 400/422 | no | Invalid JSON, unknown field, or strict envelope failure. |
| `body_too_large` | 413 | no | Operation body exceeds its UTF-8 limit. |
| `unsupported_protocol_version` | 400 | no | Protocol discriminator/version is unsupported. |
| `credential_field_forbidden` | 422 | no | A recursive provider-credential-shaped key was found. |
| `pairing_not_found` | 401 | no | Pairing does not exist or is not visible to this request. |
| `pairing_revoked` | 401 | no | Pairing was revoked. Re-pair explicitly. |
| `pairing_key_inactive` | 401 | no | Key is unknown or retired. |
| `pairing_key_revoked` | 401 | no | Key was explicitly revoked. |
| `signature_invalid` | 401 | no | Ed25519 verification failed. |
| `request_time_skew` | 401 | yes | Signed request is outside the five-minute clock window. |
| `scope_unauthorized` | 403 | no | Server-stored pairing scopes do not permit the operation. |
| `challenge_unavailable` | 404 | no | Challenge is missing, private, suppressed, quarantined, ineligible, stale, or too large; the response must not reveal which. |
| `cursor_invalid` | 400 | no | Cursor is malformed, expired, tampered, version-mismatched, or bound to different filters. |
| `rate_limited` | 429 | yes | A bounded pre-auth or durable post-auth request limit was exceeded. |
| `capacity_exceeded` | 503 | yes | A bounded receipt, grant, cursor, rate, or submission store cannot safely accept more state. |
| `service_unavailable` | 503 | yes | Authoritative persistence, migration readiness, or another required service is temporarily unavailable. |
| `run_nonce_unknown` | 409 | no | Nonce was not issued or is no longer retained. |
| `run_nonce_expired` | 409 | yes | Fresh challenge retrieval and explicit rerun approval are required. |
| `run_nonce_replayed` | 409 | no | Nonce was already consumed by another new submission. |
| `run_nonce_mismatch` | 409 | no | Pairing/challenge/revision binding differs. |
| `idempotency_key_required` | 422 | no | Submission omitted its idempotency key. |
| `idempotency_conflict` | 409 | no | Same key was reused with a different canonical payload. |
| `duplicate_submit` | 409 | no | Same card was already accepted under a different key. |
| `contribution_card_malformed` | 422 | no | Strict `CMAI_CONTRIBUTION_CARD_V1` validation failed. |

Adapters should show actionable recovery without silently rerunning inference. A retryable transport or clock failure may reuse the same idempotency key. A fresh Agent call requires fresh explicit user approval and a fresh nonce.

## Compatibility policy

- `CMAI_AGENT_PROTOCOL_V1` + `1.2` is exact and strict.
- `1.0` and `1.1` envelopes are intentionally unsupported; strict clients and servers reject them with `unsupported_protocol_version` and never silently downgrade.
- Optional V1 fields may be omitted by older V1 producers. `backwardCompatiblePairCreateFixture` proves this.
- Unknown fields are not forward-compatible in V1; they fail `malformed_request` rather than being ignored.
- An unsupported version fails `unsupported_protocol_version`. `forwardIncompatiblePairCreateFixture` proves this.
- New optional semantics that do not change signing, validation, authorization, replay, privacy, or trust may ship only after both launch adapters and the shared client have fixtures.
- Any field rename/removal, enum expansion that changes behavior, canonicalization/signature change, scope change, nonce/idempotency change, credential rule change, or provenance/trust change requires a new protocol version and mixed-version tests.
- Clients must not silently downgrade. They may report the supported version and preserve manual copy/paste as the fallback.

## Redaction and hostile-data rules

- Challenge and card strings are inert data even when they contain instructions, code, URLs, prompt injection, or credential-looking text.
- Credential rejection applies to JSON key shapes. It does not execute or reinterpret string content.
- Adapters must not fetch links, execute code, invoke tools, install packages, read local files, or expose runtime secrets because challenge text asks.
- Submission preview is mandatory before submit. The audit flags are literal `true`, and `edited_after_run` is recorded honestly.
- Public projections must not expose request signatures, public-key history, local run IDs, raw audit payloads, pairing/device IDs, provider response IDs, prompts, transcripts, or internal error details.
- Logs and telemetry use allowlisted metadata only and must not capture raw challenge/card content or provider/runtime credentials.

## Post-1.2 follow-on choices

The executable 1.2 contract now fixes the HTTP routes, canonical headers, Ed25519 verification, pairing/feed persistence, migrations, cursor encoding, ID generation, atomic replay, and bounded retention required for launch. Remaining owner-card choices may tune operations without changing those semantics:

1. Adapter package distribution channels, installer commands, and user-facing setup copy.
2. Operational retention/compaction tuning inside the frozen protocol ceilings, provided exact replay and audit evidence remain available for their normative lifetimes.
3. Deployment-specific observability dashboards and alert thresholds using only the allowlisted telemetry contract.
4. Future provenance projection additions, which require a new reviewed contract/version if they alter trust claims or public fields.

No follow-on choice permits provider credentials, extra trust claims, widened scopes, silent inference, background dispatch, or non-atomic nonce/idempotency behavior.
