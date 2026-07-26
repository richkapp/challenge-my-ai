# Beta cohort operations and support runbook

Date: 2026-07-06
Status: Card 26 pre-launch constrained-cohort contract; not public launch approval

## Purpose

Challenge My AI's first beta should validate the actual community token-maxing loop: people post hard builder/operator problems, contributors aim spare Agent capacity at them, posters rate usefulness, synthesis improves the answer, and completed debates become reusable artifacts.

This is not a broad public launch runbook. It keeps any pre-launch proof cohort narrow, supportable, and honest while Cards 27-31 finish observability, production data, QA, CI/smoke, trusted-run proof, and final launch signoff. Z/rkt clarified on 2026-07-06 that **Run my Agent here** is core launch functionality, so availability-gated trusted runs are acceptable only for explicitly authorized pre-launch proof, not public launch/beta copy.

## Beta cohort criteria

Invite people who match all of these:

- agent-native builders, operators, founders, creators, or power users;
- already use AI/Agents for product, business, strategy, implementation, research, or content decisions;
- can bring public-safe builder/operator challenges rather than high-liability medical, legal, financial, therapy, or relationship cases;
- are willing to rate received perspectives and say whether synthesis changed their decision;
- understand that useful public debates and contributor profiles may be shared as proof;
- are comfortable with a **pre-launch proof cohort** where manual contribution is the reliable lane, trusted runs are availability-gated, and paid/private/deep paths are waitlisted unless explicitly announced otherwise.

Do not invite users whose primary need is private/confidential work, regulated advice, urgent support, or guaranteed provider/model proof. Put those users on the private/deep or paid-interest list until the relevant launch gates are green.

## Invite path

Use this invite path for the first cohort:

1. Send the product promise in plain language: **post an Agent answer you do not fully trust; let other people's Agents challenge it; rate what helped; reuse the better answer.**
2. Link to `/` for orientation, `/challenges/new?ref=beta-cohort` for posters, `/lobby?ref=beta-cohort` for contributors, and `/answers?ref=beta-cohort` for people browsing precedent.
3. Tell contributors that **Copy prompt → paste local output** is the default reliable lane.
4. Tell trusted-lane testers that this is pre-launch proof: **Run my Agent here** only works when Agent Home/run-cell setup shows ready; otherwise manual paste remains the fallback and the product is not yet launch-approved.
5. Tell paid/private prospects that Plus, private rooms, deep challenges, and one-off review are waitlisted until billing, entitlements, privacy routing, moderation visibility, and production proof are ready.
6. Ask every beta poster for one public-safe challenge they genuinely need improved and one clear success criterion for whether the debate helped.

## Feedback taxonomy

Capture feedback into these buckets so operators can respond without mixing product quality, safety, and revenue signals:

| Bucket | Use when | Minimum evidence to capture | Primary response |
|---|---|---|---|
| `bug` | Route, auth, form, API, report, rating, synthesis, checkout, or share behavior breaks. | URL/path, account state, browser/device, exact step, screenshot/log if safe, whether retry changes it. | Reproduce locally; add regression test or blocker; do not mutate production unless approved. |
| `bad_synthesis` | The final answer is wrong, flattened, repetitive, misses key disagreement, or ignores useful rated perspectives. | Challenge URL, contribution IDs if known, poster usefulness ratings, expected vs actual synthesis issue. | Inspect synthesis inputs; adjust tests/ranking/copy if systemic; escalate safety if harmful. |
| `confusing_ux` | User cannot tell what to do next, what a lane means, why something is gated, or where to report/pay/contribute. | Page/viewport, what the user expected, exact confusing copy/control. | Fix copy/layout if low-risk; otherwise record for design/QA card. |
| `safety_report` | Secret/private info, harassment, unsafe advice, spam, copyright/proprietary content, or smoke/test artifacts appear publicly. | Target type/path/id, report reason, redacted note. | Use in-product report or moderator queue; suppress first when exposure risk is real. |
| `contribution_quality` | Low-effort, duplicate, helpful, or standout contribution behavior affects the loop. | Challenge URL, contribution id/label, poster rating, community signal, why it helped or hurt. | Tune reward/synthesis/lobby signals; use as cohort learning. |
| `paid_intent` | User asks for privacy, deep review, priority, saved history, exports, teams, subscription, or one-off review. | Requested paid kind, use case, urgency, privacy/depth need, willingness to wait. | Add to paid/private waitlist; do not promise live checkout or entitlement. |
| `trusted_lane_readiness` | Agent Home/provider/run-cell setup blocks or succeeds. | Provider/setup status, ready/blocked copy, smoke/run id if available, redacted failure reason. | Keep manual paste fallback visible; escalate only when trusted-lane launch gate is in scope. |

Never paste raw secrets, private transcripts, provider tokens, full user chats, or raw `.env` values into support notes.

## Operator response levels

| Level | Examples | Response |
|---|---|---|
| P0 exposure/safety | Public secret/private data, illegal/harmful content, harassment, production auth/storage fallback, billing/credential leak. | Suppress or block the public target immediately through moderation when available; preserve redacted evidence; notify Z/rkt before further production mutation. |
| P1 loop-blocking | Cannot post, sign up, contribute, rate, synthesize, view artifacts, or report safety issues for beta users. | Reproduce, patch locally, run focused tests/smoke, and report blocker. Stop before deploy unless explicitly approved. |
| P2 quality/confusion | Bad synthesis, confusing lane/status copy, unclear paid/trusted availability, weak contribution quality. | Record taxonomy bucket, fix docs/copy/tests where safe, or defer to the relevant roadmap card. |
| P3 insight/nice-to-have | Template requests, feature asks, paid interest, cohort suggestions. | Log as learning or paid/private intent; do not widen launch promise. |

## Escalation paths

- **Safety/reporting:** authenticated users report challenges, contributions, or artifacts; moderators use `/moderation` to suppress or restore targets. Suppressed content must disappear from public pages, answer APIs/search, Agent feed, synthesis/highlights, and interaction routes.
- **Smoke/test artifacts:** use `smoke_or_test_artifact` as the moderation reason. Prefer moderator suppression cleanup over deleting rows so audit history remains.
- **Production deploy or rollback:** no deploy, rollback, live smoke, or production data mutation happens from this runbook alone. Require explicit current-turn approval, preflight, rollback target, and redacted evidence.
- **Trusted lane:** if Agent Home or run-cell readiness is blocked, keep **Run my Agent here** unavailable/setup-required and direct users to manual paste for proof only. Do not call the product launched or claim provider/model proof beyond current evidence.
- **Paid/private/deep:** checkout remains waitlisted. Route paid interest to the waitlist; do not create Stripe checkout sessions, entitlements, private rooms, or deep-run guarantees without the paid/private launch gates.
- **High-liability categories:** keep medical/legal/financial/therapy/relationship style requests blocked, constrained, or deferred until safety and moderation policies explicitly allow them.

## Rollback and cleanup

- **Content rollback:** suppress unsafe or test targets via moderator actions; restore only after the issue is resolved and the target is safe to show.
- **Smoke cleanup:** for non-local smokes, prefer `CMAI_SMOKE_CLEANUP_MODE=moderator_suppress` with a moderator-capable session, then verify challenge page, artifact API/page, and answer search no longer expose the smoke target.
- **Manual seeding:** local/preview `ensureSeedData()` is allowed for development. Production should not seed fake public activity on page reads. Any beta seed/example in production must be a deliberate public challenge with operator approval and clear ownership.
- **Deployment rollback:** if a future approved deploy regresses beta operations, roll back to the last known-good Vercel/Git commit or redeploy the previous stable commit, then smoke `/`, `/lobby`, `/answers`, `/api/system/health`, and the auth redirect before reopening beta traffic.
- **Billing rollback:** because paid checkout is waitlisted, any live Stripe/entitlement mutation is out of scope for this card. If a future paid test mutates state, follow the billing-specific rollback plan before publicizing it.

## Pre-cohort dry-run checklist

Before inviting a beta batch, verify:

- homepage/support copy states the pre-launch proof truth if a constrained cohort is approved: manual lane reliable for proof, trusted lane availability-gated, paid/private/deep waitlisted, and public launch not approved;
- `/challenges/new`, `/lobby`, `/answers`, `/agents`, `/moderation`, and `/api/system/health` render or fail closed for the intended environment;
- support categories above have an owner/action path;
- moderation reports can be filed and moderator suppression hides targets;
- production read-only preflight is clean before any approved live mutation;
- no raw secrets or private transcripts appear in logs, docs, screenshots, or support notes.

Suggested local dry-run coverage for this card:

```bash
env -u DATABASE_URL NODE_ENV=test CMAI_RUNTIME_ENV=test bun test tests/unit/marketingPage.test.tsx tests/unit/moderationPage.test.tsx tests/unit/apiRoutes.test.ts tests/unit/productionChallengeLoopSmoke.test.ts
```

Full completion still requires the standard local chain before closeout: lint, typecheck, full tests, build, and `git diff --check`.
