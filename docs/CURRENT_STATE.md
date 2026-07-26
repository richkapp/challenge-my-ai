# Current State

This document separates working code from direction and aspiration.

## Roadmap position

The plugin-network roadmap contains **43 real cards**:

| State | Count |
|---|---:|
| Done | 10 |
| Blocked | 2 |
| Backlog | 31 |

Six additional challenge-semantics support tasks are complete.

The private execution board also accumulated 18 revalidation controls and 17 archived historical rows. They are preserved in the maintainer Notion database and `task-board-export.json`, but they are not extra roadmap deliverables.

## Working application surface

The repository contains a functioning Next.js/Bun application with:

- public challenge creation and discovery;
- structured challenge briefs and contribution cards;
- manual copy/paste contribution flow;
- challenge-poster ratings and synthesis;
- current-answer and decision-artifact surfaces;
- public contributor profiles;
- moderation, safety, and rate-limit seams;
- local preview auth and storage;
- explicit Supabase/Postgres production adapters;
- tests for core product, auth, safety, provenance, economy, moderation, migration, and failure behavior.

Local preview mode is intentionally non-durable and can run without production credentials.

## Agent/plugin-network surface

The current source includes:

- a runtime-neutral CMAI Agent Protocol;
- a shared TypeScript Agent client;
- Hermes worker/controller foundations;
- OpenClaw adapter foundations;
- pair/feed/revoke boundaries;
- explicit cost and submission consent;
- bounded tool-free structured inference;
- durable validated preview and recovery state;
- discard/revocation foundations;
- staged-artifact and compatibility tests.

Card 07A—the bounded OpenClaw inference slice—has local implementation and validation evidence with no validated Critical or High review finding. Its original Hermes card remains blocked because the private execution pipeline was stopped rather than advanced.

## Not finished

The public repository does **not** claim completion of:

- Card 08 submission, retry, cleanup, and idempotency;
- public adapter packaging and installation proof;
- end-to-end pair → contribute twice → revoke proof;
- stewarded review and living-answer workflow;
- Hermes/OpenClaw public-launch conformance;
- bounded reward settlement and reputation economics;
- disputes, appeals, and moderator correction tooling;
- migration/rollback rehearsal for beta;
- public package publication;
- controlled-beta approval or launch.

## Next frontier

The immediate implementation frontier is:

> **Card 08 P0 — Build preview, submit, retry, and discard**

This must preserve explicit human submission approval, idempotent retries, crash-safe durable state, redaction, and honest provenance.

See [ROADMAP.md](ROADMAP.md) for the complete ordered backlog.
