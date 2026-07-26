---
date: 2026-07-14
contract: CMAI_TELEMETRY_V1
version: "1.0"
status: frozen local instrumentation contract
owner_card: t_6f18ee01
---

# CMAI telemetry and privacy contract V1

## Boundary

This contract freezes privacy-safe event semantics before pairing, adapters, review, settlement, notifications, and beta operations emit data.

It includes:

- stable event names and event version `1`;
- one accountable component owner and exact downstream emitter cards per event;
- explicit state transitions and triggers;
- per-event property allowlists;
- HMAC-pseudonymous identifiers;
- recursive forbidden-data rejection;
- idempotent local collection, retention, suppression, and deletion behavior;
- deterministic manual, paired-local, and CMAI-sandbox provenance fixtures.

It does **not** include a dashboard, PostHog or another live analytics client, production delivery, consent-policy activation, production retention jobs, or external provider mutation. `CMAI_TELEMETRY_PROVIDER` is frozen to `disabled` in V1.

## Envelope

Every accepted local record has this server-owned envelope:

| Field | Rule |
|---|---|
| `contract` | Literal `CMAI_TELEMETRY_V1`. |
| `contractVersion` | Literal `1.0`. Contract changes follow the compatibility rules below. |
| `eventVersion` | Literal integer `1` for every event in this registry. |
| `event` | Exact allowlisted event name. Unknown events fail closed. |
| `eventId` | `psn_event_<24 hex>` created with the V1 HMAC helper. This is the idempotency key. |
| `occurredAt` | Canonical UTC ISO timestamp. |
| `environment` | `test`, `local`, `preview`, or `production`; supplied by collector config, never by event properties. |
| `subjectId` | Optional/required per event and always a V1 pseudonym. Raw account IDs are rejected. |
| `privacyClass` | Server-owned from the registry. |
| `retainedUntil` | Server-computed from privacy class. |
| `properties` | Only the event's validated low-cardinality allowlist. |
| `suppressedAt` | Local collector-only visibility marker; omitted for visible records. |

Callers never choose event version, privacy class, retention, or environment through event properties.

## Event registry

Dynamic transitions require distinct allowlisted `from_state` and `to_state` values. Fixed transitions are semantic constants and therefore are not repeated in event properties.

| Event | Owner | Downstream emitter cards | Trigger | Transition | Privacy | Allowlisted properties |
|---|---|---|---|---|---|---|
| `adapter.install.completed` | runtime adapters | `t_29c553ee`, `t_18a5691c` | Adapter installed and explicitly enabled. | `installing → installed` | operational | `runtime`, `install_channel`, `install_scope` |
| `adapter.install.failed` | runtime adapters | `t_29c553ee`, `t_18a5691c` | Install fails before enablement. | `installing → failed` | operational | `runtime`, `install_channel`, `failure_bucket` |
| `pairing.created` | platform pairing | `t_c8908940` | Active account-bound pairing is atomically created. | `unpaired → paired` | product | `pairing_id`, `runtime`, `pairing_scope` |
| `pairing.failed` | platform pairing | `t_c8908940` | Pairing attempt fails without active state. | `pairing → failed` | operational | `runtime`, `failure_bucket` |
| `pairing.revoked` | platform pairing | `t_c8908940` | User/authorized policy revokes active pairing. | `paired → revoked` | product | `pairing_id`, `runtime`, `revoke_reason`, `decision_authority` |
| `feed.fetched` | Agent feed | `t_1c434d70` | Scoped feed returns an empty/non-empty page. | `requested → completed` | operational | `runtime`, `feed_result`, `result_count_bucket` |
| `feed.failed` | Agent feed | `t_1c434d70` | Scoped feed fails closed. | `requested → failed` | operational | `runtime`, `failure_bucket` |
| `run.approved` | runtime adapters | `t_552cc1e6`, `t_a4598966` | Contributor approves exactly one bounded call. | `awaiting_approval → approved` | product | `challenge_id`, `pairing_id?`, `runtime`, `approval_scope`, `execution_control`, `budget_bucket` |
| `run.completed` | runtime adapters | `t_552cc1e6`, `t_a4598966` | Approved run yields a validated preview candidate. | `approved → preview_ready` | product | `challenge_id`, `pairing_id?`, `run_id`, `runtime`, `execution_control`, provenance triplet |
| `run.failed` | runtime adapters | `t_552cc1e6`, `t_a4598966` | Approved run fails/cancels without preview. | `approved → failed` | operational | `challenge_id`, `pairing_id?`, `run_id?`, `runtime`, `execution_control`, `failure_bucket`, `retryable` |
| `contribution.previewed` | shared submission | `t_b7e8bef6` | Strict card is shown before submit/revise/discard. | `preview_ready → previewed` | product | `challenge_id`, `pairing_id?`, `run_id?`, provenance triplet, `edited_after_run` |
| `contribution.discarded` | shared submission | `t_b7e8bef6` | Contributor discards a preview. | `previewed → discarded` | operational | `challenge_id`, `pairing_id?`, `run_id?`, `submission_mode`, `discard_reason` |
| `contribution.submitted` | shared submission | `t_b7e8bef6` | Platform accepts one idempotent contribution. | `submitting → submitted` | product | `challenge_id`, `contribution_id`, `pairing_id?`, `run_id?`, `runtime?`, provenance triplet, `edited_after_run`, `idempotency_outcome` |
| `contribution.submit_failed` | shared submission | `t_b7e8bef6` | Submit fails without a new contribution. | `submitting → failed` | operational | `challenge_id`, `pairing_id?`, `run_id?`, `submission_mode`, `failure_bucket`, `retryable` |
| `review.recorded` | poster review | `t_288fec21` | Poster-confirmed initial/outcome review is appended. | dynamic review states | product | `challenge_id`, `contribution_id`, `review_stage`, `impact_tier`, `review_outcome`, `from_state`, `to_state`, `poster_confirmed=true` |
| `answer.version_created` | answer versions | `t_fb4b96de` | Confirmed append-only answer version is stored. | `previous_version → next_version` | product | `challenge_id`, `answer_id`, `change_kind`, `version_bucket`, `attribution_count_bucket`, `poster_confirmed=true` |
| `challenge.lifecycle_changed` | challenge lifecycle | `t_cf615f55` | Authorized human-confirmed lifecycle transition persists. | dynamic challenge states | product | `challenge_id`, `from_state`, `to_state`, `lifecycle_reason`, `decision_authority` |
| `reward.recommended` | poster review | `t_288fec21` | Steward emits non-binding recommendation. | `unreviewed → recommended` | economy | `challenge_id`, `contribution_id`, `impact_tier`, `reward_bucket`, `review_stage`, `decision_authority=steward_recommendation` |
| `reward.settled` | settlement | `t_c284c0f0` | Poster-confirmed bounded settlement is recorded. | dynamic reward states | economy | `challenge_id`, `contribution_id`, `reward_id`, `impact_tier`, `reward_bucket`, `from_state`, `to_state`, `decision_authority=poster` |
| `reward.reversed` | settlement | `t_c284c0f0`, `t_da8dc3f1` | Authorized auditable reversal adjusts settlement. | `settled → reversed` | economy | `challenge_id`, `contribution_id`, `reward_id`, `reversal_reason`, `decision_authority` |
| `dispute.opened` | disputes | `t_319db1a9` | Authenticated user opens bounded dispute. | `none → open` | safety | `dispute_id`, `challenge_id`, `contribution_id?`, `reward_id?`, `dispute_reason` |
| `dispute.resolved` | disputes | `t_319db1a9`, `t_da8dc3f1` | Moderator records disposition. | dynamic dispute states | safety | `dispute_id`, `challenge_id`, `contribution_id?`, `from_state`, `to_state`, `decision_authority=moderator` |
| `moderation.reported` | moderation | `t_da8dc3f1` | Structured report accepted without report text. | `none → reported` | safety | `moderation_id`, `challenge_id?`, `contribution_id?`, `moderation_reason`, `target_type` |
| `moderation.action_applied` | moderation | `t_da8dc3f1` | Moderator applies/reverses structured action. | dynamic moderation states | safety | `moderation_id`, `challenge_id?`, `contribution_id?`, `moderation_action`, `from_state`, `to_state`, `decision_authority=moderator` |
| `notification.queued` | notifications | `t_35d870c0`, `t_7c631777` | In-app item enters outbox; no external send implied. | `none → queued` | product | `notification_id`, `challenge_id?`, `contribution_id?`, `notification_kind`, `channel=in_app` |
| `notification.delivered` | notifications | `t_35d870c0`, `t_7c631777` | In-app item becomes visible. | `queued → delivered` | operational | `notification_id`, `notification_kind`, `channel=in_app` |
| `notification.read` | notifications | `t_35d870c0`, `t_7c631777` | Account marks in-app item read. | `delivered → read` | operational | `notification_id`, `notification_kind`, `channel=in_app` |
| `cohort.readiness_evaluated` | cohort operations | `t_67640478`, `t_342bea58` | Fixture or authorized human review evaluates gate. | dynamic readiness states | product | `cohort_id`, `from_state`, `to_state`, `readiness_scope`, `blocker_count_bucket`, `evaluation_source` |

The TypeScript registry in `lib/telemetry/contract.ts` is authoritative when this prose and code disagree.

## Field-level privacy rules

### Pseudonymous identifiers

`pseudonymizeTelemetryId(kind, rawId, secret)` uses HMAC-SHA256 with context `CMAI_TELEMETRY_PSEUDONYM_V1`, a required kind, and a secret of at least 32 characters. It emits `psn_<kind>_<24 hex>`.

Allowed kinds are actor, challenge, contribution, pairing, run, answer, reward, dispute, moderation, notification, cohort, and event. Reusing the same raw ID across kinds produces different pseudonyms. The secret never enters records, logs, properties, fixtures outside test-only code, or provider payloads.

### Recursive rejection

Before allowlist projection, the scanner walks every object/array recursively and rejects the entire event when it sees:

- prompt, answer, model-output, transcript, body, message, or raw-content keys;
- URL/URI/query/search-query/social-link keys or URL-looking values;
- email/name keys or email-looking values;
- credential, secret, token, API-key, authorization, password keys or credential-looking values;
- pairing-code keys or pairing-code-looking values;
- private-challenge, challenge-text, problem-statement, or original-Agent-answer keys;
- cyclic values.

Findings contain only a path and reason. They never echo the rejected value.

After recursive rejection, unknown keys are dropped. Known values that do not match their boolean, fixed enum, or pseudonymous-ID rule are dropped as `high_cardinality_or_invalid_value`. Missing required properties fail closed. No arbitrary free-text property exists in V1.

## Provenance invariants

The three accepted triplets are exact:

| Submission | `submission_mode` | `provenance_tier` | `trust_label` | Optional execution control |
|---|---|---|---|---|
| Manual copy/paste | `manual_copy_paste` | `self_submitted` | `self_attested` | `manual` |
| Paired local adapter | `run_with_my_agent` | `paired_local_agent` | `paired_self_controlled` | `paired_local` |
| CMAI-controlled sandbox | `run_with_my_agent` | `cmai_sandbox` | `receipt_backed` | `cmai_controlled_sandbox` |

A paired-local event requires pseudonymous pairing and run IDs. It may name only Hermes or OpenClaw as its runtime category. A sandbox event requires a pseudonymous run ID, uses `platform_sandbox` when runtime is present, and cannot claim a paired-local identifier. Manual events cannot claim pairing, run, or runtime execution evidence. Run approval/failure events enforce the same pairing/runtime relationship from `execution_control` even before a complete provenance triplet exists. Install, pairing, and feed events accept only the launch adapter runtimes Hermes and OpenClaw.

`fully_trusted`, provider-verified claims, and mixed triplets fail with `telemetry_provenance_invalid`; they are never silently promoted or stored.

## Idempotency and duplicate delivery

The idempotency scope is `(event name, event version, pseudonymous event ID)`.

- First canonical payload: store once.
- Same scope + identical canonical payload: return `duplicate`; do not store twice.
- Same scope + different canonical payload: fail `telemetry_idempotency_conflict`; never overwrite.
- Event IDs and dedupe payload fingerprints are retained as unlinkable tombstones for up to 365 days so deletion or purge does not allow accidental replay.

The local collector is bounded to 10,000 records/tombstones by default and fails closed on capacity. Production storage/backpressure is owned by later implementation work; this in-memory collector is not production persistence.

## Retention, suppression, and deletion

| Privacy class | Maximum local payload retention | Deletion behavior |
|---|---:|---|
| `operational` | 14 days | Erase payload; keep unlinkable event fingerprint tombstone only. |
| `pseudonymous_product` | 90 days | Same. |
| `pseudonymous_economy` | 365 days | Same. |
| `restricted_safety` | 365 days | Same. |

These are technical maximums for V1 local fixtures, not activated legal/consent policy.

- `suppressSubject` marks existing and future subject records suppressed. Default reads and derived analytics exclude them. Suppression is reversible with `restoreSubject`.
- `deleteSubject` erases every local payload linked to the pseudonymous subject, removes suppression state, and records a 365-day deleted-subject tombstone. New events for that subject are rejected as `deleted_subject` during the tombstone window.
- Dedupe tombstones retain only an event ID reference, payload hash, and expiry; no properties or subject link.
- `purgeExpired` removes expired payloads and later expires dedupe/deleted-subject tombstones.
- The later contribution-rights card `t_28f0778f` owns final user/legal policy and durable implementation. It may shorten retention, but widening these fields, adding raw content, or weakening deletion requires a new telemetry contract version and privacy review.

## Environment flags and provider-disabled mode

| Flag | V1 values | Default |
|---|---|---|
| `CMAI_TELEMETRY_MODE` | `disabled`, `local` | `disabled` |
| `CMAI_TELEMETRY_PROVIDER` | `disabled` only | `disabled` |
| `CMAI_RUNTIME_ENV` | `test`, `local`, `preview`, `production` | `test` when `NODE_ENV=test`, otherwise `local` |

`local + production` is rejected. Disabled mode returns `disabled` before validation and stores nothing. There is no provider import, network request, dashboard, external collector, or production mutation in this card.

## Downstream obligations

Every emitter card listed in the registry must:

1. emit only after the named committed state transition, never on an intent that later fails;
2. generate HMAC pseudonyms server-side or in the trusted local adapter boundary; raw IDs never enter properties;
3. include a deterministic pseudonymous event ID so retries dedupe;
4. pass only the event allowlist; never attach request bodies or spread unknown objects;
5. preserve manual/paired/sandbox provenance triplets exactly;
6. test its success transition, fail-closed transition where defined, duplicate delivery, recursive forbidden-data rejection, and disabled mode;
7. keep external providers disabled until a separately approved production analytics card adds a provider adapter;
8. update this contract and run impact propagation before adding or changing an event/property/state.

Task-specific obligations are inspectable in code with `telemetryObligationsForTask(taskId)`.

## Compatibility rules

Compatible within event version `1`:

- implementation fixes that do not change accepted fields, meaning, privacy, state transition, ownership, retention, or dedupe behavior;
- shortening retention;
- adding stricter rejection for newly recognized credential/content leakage where existing valid fixtures still pass.

Requires a new event version or contract version plus mixed-version tests:

- event rename/removal;
- property addition/removal/rename or enum widening;
- trigger/transition/owner change;
- identifier, dedupe, retention, suppression, deletion, or trust semantics change;
- enabling any external provider;
- adding arbitrary text, URL, query, email, social, credential, prompt, answer, or transcript content.

## Deterministic proof

`lib/telemetry/telemetry.test.ts` and `lib/telemetry/test-fixtures.ts` cover:

- registry completeness and downstream owners;
- recursive rejection without echoing values;
- unknown/high-cardinality dropping;
- pseudonym determinism and kind separation;
- duplicate delivery and idempotency conflicts;
- suppression, restoration, deletion, replay blocking, and retention purge;
- provider-disabled mode;
- manual, paired-local, and sandbox provenance without trust inflation;
- dynamic transition and human-confirmation enforcement.
