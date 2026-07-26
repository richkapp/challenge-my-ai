---
date: 2026-07-15
status: implemented and regression-covered
contract: cmai-challenge-semantics-end-to-end
board_task: t_dda620cf
---

# Challenge semantics: product and developer guide

This guide is the end-to-end integration reference for challenge semantics. The frozen field contract remains [`docs/contracts/cmai-challenge-intent-v1.md`](../contracts/cmai-challenge-intent-v1.md). This document explains how that contract moves through validation, public intake, persistence, migration, public projection, cards, feeds, and closure evaluation.

The rule is blunt: a challenge is successful only when its intent-specific current criteria are confirmed and evidenced. Activity, contribution count, model confidence, synthesis, rewards, consensus, or persuasive prose cannot establish a successful outcome.

## Product contract

A challenge declares:

- one of seven intents;
- attainable success or closure criteria for that intent;
- one to three requested perspectives;
- constraints that a useful answer must respect;
- known missing information;
- sensitivity and public-eligibility declarations;
- the exact outcome labels permitted for the intent;
- an append-only criteria version history after persistence;
- a declarative, impact-based reward posture.

The challenge poster remains the decision authority. Agents, contributors, the challenge steward, synthesis, and community activity may provide evidence or recommendations. They do not autonomously confirm criteria, record closure, settle rewards, or change challenge state.

## The seven intents

| Intent | Product meaning | Required criteria coverage | Permitted successful outcome | Completion bonus declaration |
|---|---|---|---|---|
| `solve` | Remove a blocker or produce an observable target result. | `observable_result`: the result or blocker removal must be observable under the stated constraints. | `solved` | `eligible` |
| `decide` | Make a choice with enough evidence to act. | `decision_rule`: the rule and material trade-offs are explicit. `minimum_evidence`: remaining uncertainty is visible and does not block the choice or next test. | `decision_ready` | `eligible` |
| `pressure_test` | Find and disposition material risks in a plan. | `risk_coverage`: material risks and failure modes are identified and severity-ranked. `finding_disposition`: each material risk has an accepted, rejected, or deferred response with rationale. | `review_complete` | `not_applicable` |
| `perspectives` | Gather meaningfully different viewpoints. | `perspective_coverage`: requested categories have meaningful coverage. `diminishing_returns`: new perspectives are mostly repetitive and no obvious high-value viewpoint is missing. | `sufficiently_explored` | `not_applicable` |
| `debate` | Record the strongest cases around a claim without forcing consensus. | `argument_coverage`: the strongest cases for and against are recorded with evidence. `disagreement_recorded`: unresolved evidence or value disagreements remain explicit. | `closed_with_conclusion` or `closed_with_disagreement` | `not_applicable` |
| `options` | Produce a viable, meaningfully different option set. | `option_diversity`: options are not reworded duplicates. `comparison_criteria`: options can be compared against explicit constraints and decision criteria. | `option_set_complete` | `not_applicable` |
| `audit` | Inspect a defined scope and disposition material findings. | `finding_coverage`: material findings are identified and severity-ranked against the scope. `finding_disposition`: each material finding is accepted, rejected, or deferred with rationale and an owner or next action. | `audit_complete` | `eligible` |

`solved` belongs only to `solve`. The implementation rejects every other intent/outcome combination, including plausible-sounding substitutions such as `decision_ready` for `options` or `review_complete` for `audit`.

## Canonical brief fields and invariants

The current `CMAI_CHALLENGE_BRIEF_V1` semantics fields are:

- `challenge_semantics_version: "1.0"`;
- `challenge_intent`;
- `criteria_status: "confirmed" | "criteria_unconfirmed"`;
- `criteria_version`, a positive contiguous integer;
- `successful_outcomes`, exactly matching the selected intent;
- `criteria_history`, containing one entry for each contiguous version;
- `reward_posture`, exactly matching the selected intent's declarative policy.

The current declarations carried with each version are:

- `success_criteria`;
- `challenge_mode_requested`;
- `constraints`;
- `missing_information`;
- `privacy_sensitivity`.

The latest history entry must exactly equal the current intent, status, criteria, and successful outcomes. A client cannot make history, outcomes, or reward posture authoritative by submitting them. Public creation validates the client payload, then regenerates server-owned version 1 fields before persistence.

### Criteria bounds

- `solve` requires at least one criterion.
- Every other intent requires at least two criteria because each has two required coverage dimensions.
- A challenge may have at most eight criteria.
- Each criterion is limited to 240 characters.
- Combined criteria text is limited to 1,200 characters.
- Empty, duplicate, control-character-bearing, invisible/bidirectional-format-bearing, clearly impossible, absolute, or outcome-coercive criteria are invalid. Validation inspects an NFKC-normalized value with invisible formatting removed, so split-word bypasses still fail.
- Criteria must be observable or poster-confirmable. “Everyone agrees,” “absolute certainty,” “guaranteed,” “must be accepted as correct,” and “never fail under any circumstances” are invalid thresholds.
- History is limited to 20 versions. Another revision then requires an explicit archive or migration decision; history is never silently truncated.

## Requested perspectives, constraints, and missing information

`challenge_mode_requested` contains one to three distinct requested perspectives. These values guide contributors. They are not lanes, model verification, provider proof, or evidence that a perspective was actually supplied. Normal public intake does not expose `judge`; it remains schema compatibility only.

Constraints are part of the criteria snapshot. A result that satisfies one criterion by violating a declared constraint is not a successful result.

Missing information is also versioned. Closure evaluation requires explicit evidence for every current missing-information item. A contribution, confident synthesis, or high-activity thread cannot silently convert “unknown” into “resolved.”

## Drafts, confirmation, and criteria versions

There are three distinct edit contexts.

### 1. Intake draft before publication

Raw and Agent-prepared drafts begin as `criteria_unconfirmed`. Any publication-relevant edit rebuilds the draft semantics and clears criteria plus privacy acknowledgements. Confirmation appends a confirmed draft version and records a SHA-256 acknowledgement of the exact canonical brief. The authenticated public intake endpoint normalizes the submitted content, recomputes that hash, validates the complete contract, and persists a fresh server-owned version 1 snapshot. Changed content cannot reuse an earlier confirmation.

### 2. Persisted challenge before contributions

A persisted edit is never an in-place rewrite. It appends the next immutable version, even when no contribution exists yet. This preserves a coherent audit trail and keeps the current snapshot explicit.

### 3. Persisted challenge after contributions begin

Every intent, criterion, perspective, constraint, missing-information, sensitivity, or status revision appends the next immutable version. The reason must be specific and at least eight characters. Existing contributions remain bound to the version and criteria status active when they were submitted. New contributions bind to the new active version.

A stale expected version is rejected. This prevents concurrent edits from overwriting one another.

## Public intake and eligibility

`POST /api/challenges` is authenticated and fail-closed.

The endpoint:

1. rejects bodies over 65,536 bytes before JSON/schema processing;
2. validates bounded intake fields and formatting controls;
3. validates the complete intent/criteria contract;
4. rejects legacy, partial, invalid, or unconfirmed semantics with `422 invalid_challenge_intent`;
5. applies publication privacy and safety policy;
6. permits only clear `public_ok` material;
7. requires a content-bound criteria acknowledgement and, when applicable, a separate content-bound privacy acknowledgement;
8. regenerates server-owned criteria history, outcomes, and reward posture;
9. persists the exact version snapshot;
10. returns a bounded public projection.

Current public intake rejects legacy payloads even when they contain usable criteria. Legacy compatibility exists for stored records and migration, not as a bypass around current public confirmation.

### Fail-closed content cases

| Case | Required behavior |
|---|---|
| Empty or insufficient criteria | Reject with field-level intent issues. |
| Missing semantics field | Reject the partial contract; do not treat it as legacy. |
| Impossible or absolute criterion | Reject and request an attainable observable threshold. |
| Invisible/bidirectional or outcome-coercive criterion | Reject after normalized inspection; do not persist visually spoofed criteria. |
| Brief changed after criteria/privacy review | Return `422 stale_challenge_acknowledgement`; require fresh review of the exact current content. |
| Oversized criterion or combined criteria | Reject with bounded field errors. |
| Oversized request body | Return `413 request_too_large` before content processing. |
| Hostile prompt, code, tool request, or URL text | Treat as inert untrusted data. Public intake remains blocked while policy is warning/unsafe; no execution or fetch occurs. |
| `private_only` material | Block public persistence and omit it from public cards, feeds, and detail. |
| `anonymize_first` or `unknown` sensitivity | Remain ineligible until the separate content-bound review/approval contract exists. A loose override flag is not enough. |
| Secret-bearing current or historical criteria | Block persistence. Migration quarantines unsafe stored history without copying the raw secret into the quarantine audit row. |

## Public projection and rendering

Public list responses include the active safe semantics but omit internal authority and audit data:

- no `posterId`;
- no `criteria_history`;
- no eligibility assessment timestamp;
- no internal eligibility reasons for records that passed the public filter.

Cards and challenge feeds render intent, criteria status/version, active criteria, requested perspectives, constraints, declared missing information, sensitivity, permitted outcomes, and declarative reward posture through escaped React text nodes. Hostile strings remain visible as inert text. They never become executable HTML, fetched links, commands, package requests, or tool instructions.

Public-ineligible records render nothing on cards, lists, profiles, Agent feeds, or answer archives. Private markers or problem text must not leak through those paths.

A safely migrated legacy `criteria_unconfirmed` record may remain readable through a direct compatibility view when allowed by the caller, but it must show `outcome not verified`, hide permitted-outcome closure language, and state that activity, reward, and synthesis do not establish success. The public challenge list API filters it out until a confirmed current version exists. The compatibility view is strictly read-only: no prompt generation, contribution submission, Agent watch/run, poster rating, community vote, synthesis, moderation restoration, or answer-artifact generation is available.

## Legacy/default behavior

A stored brief with no V1 semantics fields maps conservatively to:

- `challenge_intent: "pressure_test"`;
- `criteria_status: "criteria_unconfirmed"`;
- `criteria_version: 1`;
- `successful_outcomes: ["review_complete"]`;
- declarative poster-confirmed-impact reward posture;
- a history reason that requires poster confirmation before closure.

Existing criteria are trimmed, bounded, and preserved. They are never promoted to confirmed. Empty-criteria legacy records remain readable in storage but cannot publish or close successfully.

Migration creates immutable version records, computes public eligibility, and binds a contribution only when its historical version is knowable. If an evolved legacy record lacks trustworthy historical effective times, old snapshots are marked `legacy_partial` and the contribution version remains `null` rather than guessed. Malformed, unsafe, or inconsistent records are quarantined without poisoning valid rows.

Contribution count, community score, current `closed` text, reward size, or persuasive narrative on a legacy record does not upgrade `criteria_unconfirmed`.

## Closure evaluation

A successful-outcome evaluation is eligible only when all of these are true:

1. the caller is the challenge poster;
2. the intent/outcome pair is permitted;
3. the referenced criteria version is the active version;
4. the active criteria are confirmed;
5. every active criterion has explicit satisfied evidence;
6. every active missing-information item has explicit resolution evidence;
7. the record is not suppressed, quarantined, malformed, or public-ineligible;
8. the poster explicitly confirms the evaluation.

The evaluator is pure. `{ eligible: true }` means the evidence is eligible for a later poster-authorized lifecycle action. It does not close the challenge, rewrite an answer, mint credits, reserve funds, or settle anything. Failure returns stable reasons such as `invalid_intent_outcome_pair`, `stale_criteria_version`, `criteria_unconfirmed`, `criterion_N_not_satisfied`, and `missing_information_N_unresolved`.

Neither activity nor persuasive prose can establish solved status. Ten thousand contributions and a confident synthesis still fail without current-version evidence.

## Declarative reward posture and Card 18 boundary

Every active version declares:

```json
{
  "basis": "poster_confirmed_impact",
  "funding_state": "declarative_only",
  "eligible_impact_tiers": ["signal", "useful", "material", "decisive"],
  "completion_bonus": "eligible | not_applicable"
}
```

This object is display and downstream planning metadata. It describes which impact labels may be reviewed. It does not describe money movement or prove that credits exist.

Reward reservation, escrow, fees, immediate/provisional/final awards, completion-bonus allocation, unused funds, reversals, and settlement are explicitly out of scope here. They belong to **Card 18, `t_c284c0f0` — “Replace per-rating credits with bounded reward settlement.”** Card 18 must define those economics and concurrency/idempotency rules. Challenge semantics must not invent them first.

The end-to-end semantics regression never calls rating, credit append, settlement, billing, or payout functions. It asserts that the credit ledger stays empty. Closure evaluation is also checked against challenge status before and after evaluation to prove that no autonomous lifecycle mutation occurs.

## Developer flow by layer

| Layer | Canonical surface | Responsibility |
|---|---|---|
| Model and cross-field validation | `lib/challenges/intent.ts`, `lib/validation/challengeBrief.ts`, `lib/validation/schemas.ts` | Freeze intent policy, bounds, exact outcomes, history continuity, and declarative reward posture. |
| Public intake | `app/api/challenges/route.ts`, `lib/moderation/publicationPolicy.ts` | Authenticate, bound requests, reject invalid/unconfirmed/private/unsafe input, regenerate server-owned semantics, and return a redacted public projection. |
| Persistence and migration | `db/migrations/challenge-criteria-v1.ts`, `lib/store/local.ts`, `lib/store/postgres.ts` | Store immutable snapshots, bind contributions, quarantine unsafe history, compute public eligibility, and keep closure evaluation pure. |
| Public cards and feeds | `components/challenge/ChallengeCard.tsx`, `components/challenge/ChallengeFeed.tsx`, intake confirmation | Render bounded factual semantics, inert hostile text, legacy uncertainty, and no-settlement reward copy. |
| End-to-end proof | `tests/e2e/challenge-semantics.test.tsx` | Exercise the complete matrix and assert no financial or autonomous lifecycle side effects. |

## Regression coverage

`tests/e2e/challenge-semantics.test.tsx` covers:

- all seven intent policies, criteria dimensions, outcomes, and completion-bonus declarations;
- every invalid intent/outcome pair in model validation and closure evaluation;
- empty, missing, impossible, oversized, hostile, and private-data cases;
- authenticated public intake and server-owned version 1 persistence;
- public-response redaction;
- cards and challenge-feed semantics rendering;
- inert hostile markup and private/public-ineligible omission;
- criteria edits before and after contributions;
- contribution-to-version binding;
- legacy migration and private legacy eligibility;
- `criteria_unconfirmed` fail-closed behavior despite activity, reward, closure text, or prose;
- evidence-bound decisive closure eligibility;
- an empty credit ledger and unchanged challenge status after closure evaluation.

Run the focused proof with:

```bash
env -u DATABASE_URL NODE_ENV=test CMAI_RUNTIME_ENV=test bun run test -- tests/e2e/challenge-semantics.test.tsx
```

For completion, also run typecheck, the full suite, lint, build, `git diff --check`, impact-map validation, and the task-specific impact scan required by `AGENTS.md`.
