# CMAI Hermes plugin

Private local Hermes adapter for Challenge My AI's `Run with my Agent` action.

It registers:

- `/cmai` — explicit pairing, feed, run-preparation, preview, discard, revoke, status, and update-help commands; reserved submit commands fail closed in this release;
- `cmai-hermes:cmai-contribution` — the safe contribution workflow skill.

It registers no tools or hooks. Discovery and enablement do not launch a process, call a model, contact the network, inspect Hermes memory, or change provider/auth configuration. Every command starts one bounded Bun worker and waits for it to exit.

## Bounded run approval

`/cmai run <challenge-id>` fetches and validates one public Protocol 1.2 challenge, then persists only a short-lived approval record bound to the complete canonical run grant (including nonce, issue/expiry times, request class, revision, prompt version, and output ceiling), active Hermes profile, 4,096-token request cap, and 45-second host timeout. It does **not** call a model. The worker requires the exact follow-up `/cmai run <challenge-id> confirm <revision>`, re-fetches and compares the complete grant, rechecks expiry immediately before locked consumption, and atomically consumes and fsyncs approval before dispatch.

A confirmed run invokes `ctx.llm.complete_structured(...)` once through the host-owned route selected by the active Hermes profile. The plugin passes no provider, model, profile, tool, memory, or credential override. Hermes may apply its own documented internal retries or fallback, so the plugin claims one bounded host-API invocation—not one literal upstream provider attempt. The validated card, its public challenge/grant, normalized run audit, and neutral `preview_id` are then stored locally so `/cmai preview` and `/cmai discard` work as separate later commands. This release has no contribution-submission transport route or submission identity; `/cmai submit` and `/cmai submit confirm` return `submission_unavailable` without network activity.

Supported scaffold runtime: Hermes `>=0.18.2 <0.20.0`, Bun `>=1.3.0 <2`.

The raw source directory is for repository development. Build the local artifact through `packages/cmai-hermes-adapter/scripts/stage-local.ts`; that artifact bundles the TypeScript worker under `runtime/worker.js`.

For Hermes `0.18.2` through `0.19.x`, verify Hermes satisfies `>=0.18.2 <0.20.0` and Bun satisfies `>=1.3.0 <2`, copy that reviewed artifact to `$HERMES_HOME/plugins/cmai-hermes`, then enable it with `hermes plugins enable --no-allow-tool-override cmai-hermes`. The adapter registers no tools and must not receive tool-override permission. The Hermes install command in this version accepts Git identifiers rather than a local directory.

## State and removal

The plugin stores its generated CMAI pairing key and strict paired-state projection under `$HERMES_HOME/state/cmai-hermes/state.json`. Between preparation and confirmation it also stores bounded approval metadata containing the complete Protocol 1.2 run grant but excluding challenge content. Approval is atomically marked with process ownership and durably synced before inference. After a successful call it stores the validated public challenge/grant, normalized contribution preview, bounded run audit, and neutral `preview_id` until explicit discard. It stores no submission idempotency key. Legacy submit-authorized keys and grants are removed from adapter state during migration; a public preview may remain in a retired state until it is discarded, and a consumed process marker remains fail-closed until its exact owner finishes or is conclusively dead. Pairing stays blocked until the retired preview or marker is safely cleared. Permissions are `0700` on the directory and `0600` on the file. It never stores the pairing code, raw model response, provider credential, cookie, or Hermes auth/config.

Before removing a paired plugin:

1. Run `/cmai revoke confirm`.
2. Confirm `/cmai status` says unpaired.
3. Disable/remove the plugin through Hermes.

Revocation removes the local state file and empty state directory. Removing without revocation is unsafe because the server-side pairing would remain active.
