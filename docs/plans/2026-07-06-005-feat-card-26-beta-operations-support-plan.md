---
title: Card 26 beta cohort operations support runbook
type: feat
date: 2026-07-06
---

# Card 26 beta cohort operations and support runbook

## Summary

Prepare the controlled beta operations layer for Challenge My AI: who gets invited, how feedback is captured, how support/moderation/escalation works, and how launch messaging keeps manual, trusted, paid, private, and deep availability honest.

---

## Problem Frame

Cards 01-25 made the product promise, public loop, safety gates, paid waitlist, and sharing/reputation surfaces concrete. Card 26 needs the first-cohort operating contract so beta learning validates the social token-maxing behavior instead of merely confirming that pages render.

---

## Requirements

**Beta cohort**

- R1. Cohort criteria must match the Card 01 wedge: agent-native builders/operators/founders/creators with public-safe builder/operator challenges.
- R2. The invite path must route posters, contributors, and browsers into existing product paths without adding provider setup, paid checkout, or private/deep gates as prerequisites.

**Feedback capture**

- R3. Feedback buckets must distinguish bugs, bad syntheses, confusing UX, safety reports, contribution-quality signals, paid-intent signals, and trusted-lane readiness.
- R4. Feedback notes must avoid raw secrets, raw private transcripts, provider tokens, or full chat dumps.

**Operator response**

- R5. The runbook must name escalation paths for moderation, smoke cleanup, production rollback, trusted-lane readiness, paid/private/deep requests, and high-liability categories.
- R6. The runbook must keep production deploys, live smokes, billing actions, credential rotations, and irreversible external mutations out of scope unless explicitly approved.

**Launch messaging**

- R7. Homepage/public docs must set honest beta expectations: manual lane is the reliable path; trusted runs are readiness-gated; Plus/private/deep are waitlisted.
- R8. Docs/changelog/roadmap must record Card 26 without implying broad public launch readiness.

---

## Implementation Units

### U1. Operations runbook

- **Goal:** Create a durable beta cohort operations/support runbook.
- **Files:** `docs/product/2026-07-06-beta-cohort-operations-support-runbook.md`
- **Approach:** Define cohort criteria, invite paths, feedback taxonomy, priority levels, escalation paths, rollback/cleanup, manual seeding, and pre-cohort dry-run checks.
- **Verification:** Runbook explicitly covers all acceptance categories and keeps no-production-mutation boundaries clear.

### U2. Launch messaging and public beta copy

- **Goal:** Add homepage and durable docs copy that sets beta expectations without overclaiming readiness.
- **Files:** `app/(marketing)/page.tsx`, `tests/unit/marketingPage.test.tsx`, `README.md`, `PROJECT_SPEC.md`, `WORKING_DOC.md`, `docs/product/2026-07-04-launch-kanban-roadmap.md`, `CHANGELOG.md`
- **Approach:** Add a compact beta-operations section to the marketing page and update canonical docs to point at the runbook. Keep the page within the existing design system and route CTAs to browse/post/contribute/support paths.
- **Verification:** Marketing tests assert cohort copy, feedback categories, and honest manual/trusted/paid availability.

### U3. Support dry-run verification

- **Goal:** Prove the documented support/moderation/reporting paths remain exercised locally.
- **Files:** `tests/unit/betaOperationsDocs.test.ts`, existing moderation/API/smoke tests
- **Approach:** Add a doc contract test for the runbook and run focused tests covering marketing copy, moderation page, API report/moderation behavior, and production smoke cleanup contracts.
- **Verification:** Focused support dry-run tests pass, followed by the standard full local chain.

---

## Scope Boundaries

- No production deploy, live smoke, external email/CRM/support-tool setup, social posting, credential/secret change, billing/Stripe mutation, or production seed data.
- No private rooms, deep challenge fulfillment, or active paid checkout.
- No new third contribution lane. Provider setup remains under **Run my Agent here** only.
- No collection of raw private transcripts, secrets, `.env` values, or provider tokens in support notes.

---

## Implementation Checkpoint

2026-07-06 local completion checkpoint:

- U1 implemented: `docs/product/2026-07-06-beta-cohort-operations-support-runbook.md` defines cohort criteria, invite paths, feedback taxonomy, priority levels, escalation paths, rollback/cleanup, smoke cleanup, manual seeding, and dry-run checks.
- U2 implemented: homepage beta-operations copy now states the honest cohort/support contract: manual copy/paste is the reliable default, **Run my Agent here** is readiness-gated, and Plus/private/deep/one-off paths remain waitlisted. Canonical docs now point at the runbook.
- U3 implemented: `tests/unit/betaOperationsDocs.test.ts` pins the runbook contract, and `tests/unit/marketingPage.test.tsx` covers the public beta copy.
- Card 26 was explicitly approved by Z/rkt after Card 25 closeout; no production deploy, live smoke, credential, billing, social-posting, or external-service mutation was performed.

## Verification Evidence

Focused support/moderation/marketing dry-run:

```bash
env -u DATABASE_URL NODE_ENV=test CMAI_RUNTIME_ENV=test bun test \
  tests/unit/betaOperationsDocs.test.ts \
  tests/unit/marketingPage.test.tsx \
  tests/unit/moderationPage.test.tsx \
  tests/unit/apiRoutes.test.ts \
  tests/unit/productionChallengeLoopSmoke.test.ts && \
env -u DATABASE_URL NODE_ENV=test CMAI_RUNTIME_ENV=test bun run typecheck
```

Result: `62 pass`, typecheck passed.

Local visual QA:

- Dev server: `env -u DATABASE_URL NODE_ENV=development CMAI_RUNTIME_ENV=local CMAI_AUTH_MODE=local CMAI_STORE_DRIVER=local bun run dev --hostname 127.0.0.1 --port 3127`
- Page checks: `/` returned `200` (103,849 bytes), `/moderation` returned auth redirect `307`, `/api/system/health` returned `200` (1,991 bytes).
- Screenshots captured under `[local screenshot workspace]/2026-07-06-card26-beta-ops/`, including:
  - `home-beta-desktop.png`
  - `home-full-tall-desktop.png`
  - `desk-crop-y3000.png`
  - `home-full-extra-tall-mobile.png`
  - `mob-crop-y6600.png`
  - `mob-crop-y7400.png`
  - `mob-extra-crop-y9200.png`
- Visual QA result: beta/support section readable on desktop and mobile, stacks correctly on mobile, no blocker-level overlap/cutoff. The small `N` bubble in mobile screenshots is the dev overlay, not app UI.

Full local verification:

```bash
env -u DATABASE_URL NODE_ENV=test CMAI_RUNTIME_ENV=test bun run lint && \
env -u DATABASE_URL NODE_ENV=test CMAI_RUNTIME_ENV=test bun run typecheck && \
env -u DATABASE_URL NODE_ENV=test CMAI_RUNTIME_ENV=test bun test && \
env -u DATABASE_URL NODE_ENV=test CMAI_RUNTIME_ENV=test bun run build && \
git diff --check
```

Result: lint passed, typecheck passed, `435 pass`, build passed, `git diff --check` passed.

---

## Sources / Research

- Card 26 Kanban body: `t_e0691ca0` on `challenge-my-ai-launch-20260704`.
- Roadmap: `docs/product/2026-07-04-launch-kanban-roadmap.md`.
- Current implementation/docs: `README.md`, `PROJECT_SPEC.md`, `WORKING_DOC.md`, `CHANGELOG.md`, `app/(marketing)/page.tsx`, moderation/reporting tests.
