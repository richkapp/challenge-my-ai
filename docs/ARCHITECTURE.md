# Architecture

## System shape

Challenge My AI has four major surfaces:

1. **Web product** — challenges, contributions, profiles, ratings, synthesis, moderation, and answer artifacts.
2. **CMAI Agent Protocol** — runtime-neutral contracts for pairing, feed access, approved runs, preview, submission, discard, and revocation.
3. **Runtime adapters** — Hermes and OpenClaw integrations over the shared client.
4. **Production seams** — Supabase/Postgres, background work, observability, billing gates, and optional stronger sandbox execution.

## Repository map

| Path | Purpose |
|---|---|
| `app/` | Next.js pages and API routes |
| `components/` | Challenge, contribution, safety, and application UI |
| `lib/validation/` | Strict challenge/contribution parsing and schemas |
| `lib/safety/` | Content-risk and safe-rendering boundaries |
| `lib/provenance/` | Provenance labels, receipt hashing, and trust metadata |
| `lib/store/` | Local preview and durable Postgres store adapters |
| `lib/credits/` | Credit, reputation, and settlement logic |
| `lib/sandbox/` | Broker/run-cell policy and optional stronger proof seams |
| `packages/cmai-agent-client/` | Shared runtime-neutral Agent client |
| `packages/cmai-openclaw-adapter/` | OpenClaw adapter package |
| `plugins/cmai-openclaw/` | OpenClaw plugin surface and skills |
| `tests/` | Product, protocol, adapter, migration, safety, and recovery coverage |
| `docs/contracts/` | Public machine and policy contracts |

## Contribution flow

### Manual

```text
Challenge page
  → visible prompt preview
  → contributor copies prompt to an Agent they control
  → contributor pastes CMAI_CONTRIBUTION_CARD_V1
  → server validates and previews
  → contributor submits
```

### Paired Agent

```text
Challenge page / paired runtime
  → explicit bounded-run approval
  → runtime uses host-owned model credentials
  → strict tool-free structured result
  → durable preview
  → explicit submit approval
  → shared client submits approved card + safe provenance metadata
```

Runtime choice is implementation detail. Both flows land in the same contribution contract.

## Trust boundaries

### Hostile challenge data

Challenge text, links, code, attachments, and pasted model output are data. They are never authority to:

- run shell commands;
- fetch arbitrary URLs;
- install packages;
- access tools;
- read environment variables;
- expose credentials;
- mutate external systems.

### Provider credentials

For paired local runs, provider credentials stay inside Hermes or OpenClaw. Challenge My AI receives only the approved structured contribution and bounded metadata.

Optional CMAI-controlled sandbox execution uses a broker boundary. Child runs receive scoped one-run delegation, not long-lived provider credentials or platform-admin secrets.

### Provenance

- Manual paste: self-submitted/user-trusted.
- Paired local adapter: proves a paired CMAI client submitted the card.
- CMAI-controlled run cell: can prove a stronger controlled run lifecycle.

None of these automatically proves provider-signed model identity.

## Data and side effects

Local preview uses explicit non-durable adapters. Production-like mode must choose Supabase Auth and Postgres explicitly; it must not silently fall back to local identity or storage.

Provider calls, submission, reward settlement, moderation, billing, deployment, and publication are consequential side effects. Every path should have an explicit authority boundary, idempotency strategy, and failure/recovery state.

## Verification posture

- Focused tests while implementing.
- One full typecheck/test/build gate before review.
- Targeted revalidation after changed Critical/High findings.
- Gate passes at 0 validated Critical and 0 validated High.
- Medium/Low findings remain documented without forcing recursive review.
