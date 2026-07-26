# CMAI OpenClaw adapter

Private, bounded native OpenClaw plugin for Challenge My AI. It uses the shared `cmai-agent-client` and calls one host-owned model only after durable, exact human confirmation; it does not define a second CMAI protocol/client.

## Source and package decision

- Canonical TypeScript/build package: `packages/cmai-openclaw-adapter/`
- Canonical cold manifest and skill assets: `plugins/cmai-openclaw/`
- Local install artifact: `/tmp/cmai-openclaw-adapter` by default, generated with `bun run build:local`
- Package-owned lockfile: `packages/cmai-openclaw-adapter/package-lock.json`
- Supported OpenClaw and plugin API range: `>=2026.7.1 <2026.8.0`
- Verified SDK/runtime fixture: exact `openclaw@2026.7.1`

Compiled output is staged outside the repository. Card 09B owns package/release proof; this repository does not publish to npm/ClawHub or commit generated `dist/` files here.

## Build and inspect

```bash
cd packages/cmai-openclaw-adapter
npm ci --ignore-scripts
npm run typecheck
npm test
bun run build:local
```

The stage script compiles `dist/index.js`, copies `openclaw.plugin.json` and `skills/cmai-contribution`, imports the staged entry against the pinned local peer dependency, verifies exactly one command/tool/CLI registration, and removes the temporary dependency link so it is not shipped.

For a disposable profile, install the generated directory with the pinned OpenClaw CLI, explicitly enable it, configure only the plugin-owned CMAI origin, inspect runtime registrations, then remove it. Do not use a shared profile for proof.

## Explicit host policy

The plugin must be explicitly installed and enabled. OpenClaw policy remains authoritative:

```json
{
  "plugins": {
    "allow": ["cmai-openclaw"],
    "entries": {
      "cmai-openclaw": {
        "enabled": true,
        "llm": {
          "allowModelOverride": true,
          "allowAgentIdOverride": true,
          "allowedModels": ["YOUR_PROVIDER/YOUR_CONFIGURED_MODEL"]
        },
        "config": {
          "baseUrl": "https://challenge-my-ai.vercel.app",
          "displayName": "OpenClaw Agent"
        }
      }
    }
  },
  "tools": {
    "allow": ["cmai"]
  }
}
```

Replace `YOUR_PROVIDER/YOUR_CONFIGURED_MODEL` with the exact canonical primary model configured for the Agent that will run CMAI. The adapter rejects wildcard model access, missing override flags, or an allowlist that does not contain the exact displayed model. It never accepts Agent/model names from CMAI or challenge content; slash commands use the host-bound Agent, and CLI commands use OpenClaw's configured default Agent.

Fail-closed states:

- Plugin not enabled: OpenClaw does not register CMAI surfaces.
- `plugins.allow` excludes `cmai-openclaw`: OpenClaw denies plugin activation.
- Missing/invalid `baseUrl`: `/cmai status` reports `adapter_unconfigured`; commands perform no network/model action.
- Host outside `>=2026.7.1 <2026.8.0`: commands report `openclaw_version_incompatible` before shared-client work.
- Missing/mismatched `plugins.entries.cmai-openclaw.llm` policy: `run` reports `bounded_inference_policy_required` before any CMAI fetch or approval persistence.
- Slash invocation missing OpenClaw's host-bound `runtimeContext.llm`: `run` fails closed and never falls back to the generic plugin LLM facade.
- `tools.allow` excludes `cmai`: the optional Agent tool is unavailable; direct owner slash/CLI commands remain separately controlled.
- Non-owner slash/tool context: no CMAI surface runs.

Registration is inert: no lifecycle fetch, polling, model call, provider discovery, or telemetry emission occurs until a direct owner invokes a command. Local state is created only by explicit pairing.

## Surfaces and approval boundary

Both `/cmai ...` and `openclaw cmai ...` expose `pair`, `status`, `feed`, `run`, `preview`, `submit`, `discard`, `revoke`, `update`, and `help`. Slash-command inference requires OpenClaw's invocation-scoped `runtimeContext.llm`, preserving the host-bound Agent, active session, and preferred authentication profile while using that Agent's configured primary model. It never falls back to the generic plugin facade. CLI inference uses the generic facade with OpenClaw's configured default Agent and configured primary model. Both targets are displayed before approval and sent explicitly through the exact per-plugin allowlist above; an unobservable session-only model override is never claimed or silently approved.

The optional allowlisted `cmai` Agent tool supports read-only status, feed, preview, update, and help actions. It refuses `pair`, `run`, `submit`, `discard`, and `revoke` because model-selected tool use is not human approval. Pairing, run, discard, and revoke require a direct owner slash or CLI command; `revoke` additionally requires the literal `confirm` argument. The reserved direct `submit` command returns `submission_unavailable`: Card 07A contains no client submission, retry, cleanup-after-submit, or submission-idempotency execution path. Card 08 owns that work.

A direct-owner `run <challenge-id>` fetches one public challenge and displays the entire inference-visible public challenge bundle, its canonical SHA-256, the exact configured Agent/model, and a warning that hostile public text will be sent as quoted data to that provider/model. It persists the complete approved grant, exact revision/hash/Agent/model, 4,096-token output ceiling, 64 KiB output ceiling, 45-second timeout, and provider-cost acknowledgement without calling a model. Only the exact returned `run <challenge-id> confirm <revision>` command can atomically consume that approval and call OpenClaw's pinned `runtime.llm.complete` capability. Slash uses the invocation-scoped capability; CLI uses the generic plugin capability. Before consumption, the refreshed challenge must reproduce the approved bundle hash after the persisted grant is substituted. Both calls explicitly send the approved Agent/model through the narrow host policy. The request uses no tools, provider credentials, model fallback, or autonomous retry. The result must return the approved Agent/model, fit the byte ceiling, parse as the strict contribution-card schema, and survive durable preview persistence. Card 07A ends there; contribution submission remains fail-closed until Card 08.

If a call fails or the process dies after approval consumption, the durable consumed marker blocks a duplicate model call and any new preparation. New markers record the consuming PID, unique token, process time origin, and OS process incarnation. New inference fails before approval consumption and provider dispatch unless OpenClaw can capture that durable OS identity. `discard` refuses to clear a marker while its exact process incarnation is alive—even after a local timeout, because the provider promise may ignore cancellation. A live PID whose incarnation cannot currently be read is treated as possibly active. Legacy ownerless consumed markers become non-clearable `legacy_unknown` tombstones; they are never assigned to whichever process happened to migrate the file. Process-owned markers become recoverable only when their exact owner is conclusively dead. Pairing revocation may still revoke the server pairing, but it preserves any possibly live local recovery marker. A live or unprovably stale marker is never cleared; a lost discard CAS reports `pending_run_state_changed` rather than falsely claiming cleanup.

## State and privacy

Adapter state is stored below OpenClaw's resolved state directory in `cmai-openclaw/state.json`, with a `0700` directory and `0600` file. Schema v5 retains an active pairing only when requested and granted scopes equal exactly `challenge:read`, `challenge:run`, and `pairing:manage`, plus pending approvals, process-owned or legacy-unknown consumption markers, and durable previews. On first load it atomically upgrades schema-v1 pairing state plus historical schema-v2/v3 pending and preview forms and the superseded ownerless-consumer v4 form. Old submission-style preview identity is discarded and replaced with neutral immutable `preview_id`; old false “submitted” preview provenance is rewritten to neutral “produced” wording; and ownerless consumed approvals become fail-closed tombstones that no automatic cleanup or pairing revocation may delete. Any schema-v1 through schema-v4 pairing that contains legacy `contribution:submit` authority is retired: the signing key and all scope grants are removed from adapter state, any public preview is retained without an active pairing until exact discard, and state without a public preview is removed unless a consumed process marker must remain fail-closed until its exact owner finishes or is conclusively dead. A prepared run stores the complete public run grant, canonical SHA-256 binding for the exact inference-visible challenge bundle, approved Agent/model and fixed budgets, and an in-flight consumption owner when applicable. A completed preview stores the validated public challenge snapshot, contribution card, runtime-reported provenance, and `preview_id` used only for discard compare-and-swap. It stores no active submission approval or idempotency state. It never stores pairing codes, provider credentials, cookies, authorization headers, raw provider responses, private challenge data, or unvalidated model output. Pairing and preview cleanup use immutable identities so stale commands cannot delete newer state.

The transport sends only strict CMAI protocol envelopes to explicit CMAI routes. It omits cookies, Authorization headers, credentials, and referrers. HTTPS is required except for loopback tests.

## Update and uninstall

This private scaffold does not self-update or query a registry. Build and inspect a reviewed local artifact, then replace the installed copy using OpenClaw's documented plugin lifecycle. Published-package update behavior belongs to the later package/release card.

Before uninstalling a paired plugin:

1. Run `/cmai revoke confirm` or `openclaw cmai revoke confirm`.
2. Verify the CMAI device is revoked.
3. Run `openclaw plugins disable cmai-openclaw`.
4. Run `openclaw plugins uninstall cmai-openclaw`.
5. Verify the plugin entry/install record and `cmai-openclaw` state directory are gone.

If local revocation cannot reach CMAI, revoke the device from the CMAI web UI before removal. A retired legacy submit-authorized pairing has already had its local signing key erased to eliminate that authority; it therefore must be revoked from the CMAI web UI.

OpenClaw may hot-reload supported plugin changes. Do not start, stop, reload, or restart a shared Gateway without separate operator approval.
