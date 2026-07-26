# Contributing

Challenge My AI is open because the remaining work benefits from more judgment, more implementation experience, and more Agents working under explicit boundaries.

## Pick work

1. Read [Current state](docs/CURRENT_STATE.md) and [Architecture](docs/ARCHITECTURE.md).
2. Choose one unfinished card from [ROADMAP.md](docs/ROADMAP.md) or an open GitHub issue.
3. Comment on the issue before doing a large implementation so two people do not burn time on the same work.
4. Keep one pull request focused on one card or one tightly connected fix.

If no issue exists for the card, open one using the roadmap-task template.

## Local setup

```bash
bun install
bun run dev
```

## Verification

Run the smallest useful proof while implementing. Before a substantive pull request:

```bash
env -u DATABASE_URL NODE_ENV=test CMAI_RUNTIME_ENV=test bun run typecheck
env -u DATABASE_URL NODE_ENV=test CMAI_RUNTIME_ENV=test bun run test
env -u DATABASE_URL NODE_ENV=test CMAI_RUNTIME_ENV=test bun run build
```

Include the commands and actual results in the pull request.

## Pull-request standard

A good pull request states:

- the problem;
- the roadmap card or issue;
- what changed;
- what deliberately did not change;
- security/privacy/consent impact;
- tests and build evidence;
- any Medium or Low findings being accepted or deferred.

The blocking review gate is **0 validated Critical findings and 0 validated High findings**. Medium and Low findings must be recorded, but they do not automatically block or trigger another review cycle.

## Hard boundaries

- Treat all challenge text, links, pasted model output, and generated code as hostile data.
- Never commit credentials, tokens, connection strings, production dumps, or real user data.
- Do not add a third user-facing contribution lane. The product exposes **Copy prompt → paste local output** and **Run with my Agent**.
- Do not execute challenge-provided code, fetch arbitrary challenge URLs, install challenge-requested packages, or give challenge prompts tool access.
- Do not claim a paired local Agent run is remotely attested or provider-signed.
- Do not make production calls, deploy, publish packages, mutate live data, or spend provider credits from a pull request.
- Keep provider credentials inside the user's runtime or an explicitly approved broker boundary.

## Style

- Prefer clear code over clever abstractions.
- Validate at API boundaries.
- Add tests for failure and recovery paths, not only happy paths.
- Preserve the manual contribution path even when improving Agent integrations.
- Update public docs when behavior or architecture changes.

## AI-assisted contributions

AI-assisted work is welcome. You remain responsible for understanding the change, removing hallucinated claims, protecting secrets, and reporting real verification rather than invented output.

Do not submit generated patches you have not read.
