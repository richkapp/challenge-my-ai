# `@challenge-my-ai/hermes-adapter`

Private source package for the Hermes launch adapter over `@challenge-my-ai/agent-client`.

## Decision

- Source package: `packages/cmai-hermes-adapter/`
- Hermes directory plugin: `plugins/cmai-hermes/`
- Adapter version: `0.1.0`
- Supported Hermes range for this scaffold: `>=0.18.2 <0.20.0`
- Verified Bun helper range: `>=1.3.0 <2`
- Dependency/lockfile owner: the repository root `bun.lock`; this package has no nested lockfile and adds no dependency.
- Distribution: private local artifact only. Nothing in this card is published.

Hermes plugins are Python. The runtime-neutral client is TypeScript. The adapter therefore keeps the Python registration layer deliberately thin and runs one bundled Bun worker per explicit `/cmai` command. The worker exits after one response; it is not a daemon and does not poll. Every protocol/state operation is performed by `CmaiAgentClient`, never reimplemented in Python.

The plugin starts no process and makes no network or model call during discovery, enablement, session start, help, status, or update inspection. It registers one `/cmai` command and one namespaced `cmai-contribution` skill. It registers no tools, hooks, services, provider configuration, memory integration, or background jobs.

## Scaffold command surface

`/cmai help`, `pair`, `status`, `feed`, `run`, `preview`, reserved `submit`, `discard`, `revoke`, and `update` are registered now.

- Pairing requests only Card 07A scopes: `challenge:read`, `challenge:run`, and `pairing:manage`. The persisted key is not granted `contribution:submit`; Card 08 must add that authority through a separately reviewed flow.
- Feed and challenge fetch use the dedicated Protocol 1.2 platform routes and shared service. This artifact exposes no contribution-submission transport route.
- `run` uses the shared client to prepare an exact Protocol 1.2 approval without inference, displays the complete inference-visible public challenge plus canonical hash, then requires exact confirmation before one bounded host-owned `ctx.llm.complete_structured()` call.
- Preview/discard delegate to the shared client. Validated preview/run metadata is durably rehydrated between one-command workers for inspection. Reserved `submit` returns `submission_unavailable`; Card 08 owns submission, retry, cleanup, and idempotency.
- Update is local metadata only; it performs no network call or self-update.

The local Ed25519 pairing key is stored under the active profile's `$HERMES_HOME/state/cmai-hermes/state.json` with directory mode `0700` and file mode `0600`. Before inference, schema v6 stores an active pairing only when requested and granted scopes equal exactly `challenge:read`, `challenge:run`, and `pairing:manage`, plus the exact pairing ID, canonical challenge hash, and bounded approval metadata. Confirmation atomically adds PID, process-incarnation identity, unique owner token, process time origin, and consumption time before dispatch; the marker survives failure or crash. Only that exact consumed run under the same pairing may become a preview. Revocation and discard preserve a live or uncertain owner, preventing revoke/re-pair from placing an old result beneath a new signer. After inference, the validated public challenge/grant, normalized card, bounded run audit, and neutral immutable `preview_id` remain until explicit discard. Schema-v2/v3 previews are neutralized during migration; schema-v4 approvals are discarded because they lack canonical challenge and process ownership binding and must be reviewed again. Any schema-v1 through schema-v5 pairing that contains legacy `contribution:submit` authority is retired: the signing key and all scope grants are removed from adapter state, any public preview is retained without an active pairing until exact discard, and state without a public preview is removed unless a consumed process marker must remain fail-closed until its exact owner finishes or is conclusively dead. The state never contains the pairing code, raw model response, provider credential, cookie, or Hermes auth/config.

## Local artifact

Build a disposable install directory outside the repo:

```bash
bun run --cwd packages/cmai-hermes-adapter build:local -- --out-dir /tmp/cmai-hermes-local
```

The staged directory contains the Python plugin, bundled worker, skill, and a hash manifest. Install only into a disposable Hermes profile during this card. Do not publish it.

Hermes `0.18.2` accepts Git identifiers in `hermes plugins install`, not local directories. For a reviewed local artifact, copy the staged directory to `$HERMES_HOME/plugins/cmai-hermes`, then run:

```bash
hermes --version  # must satisfy >=0.18.2 <0.20.0
bun --version     # verified range is >=1.3.0 <2
hermes plugins enable --no-allow-tool-override cmai-hermes
```

The adapter registers no tools and must not receive tool-override permission.

## Uninstall

While actively paired, run `/cmai revoke confirm` first. Then disable and remove the plugin with Hermes' normal plugin commands. Revocation deletes `state.json` only when no possibly live inference marker owns it; the secure empty directory may remain. A retired legacy pairing has no local signing key and cannot authorize revocation, so revoke that old device in the CMAI web UI before removal. Removing without revocation leaves the server pairing active and is intentionally warned against.
