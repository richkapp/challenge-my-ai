# `@challenge-my-ai/agent-client`

Private source package for the runtime-neutral CMAI Agent Protocol V1 client.

Version: `0.1.0`
Protocol: `CMAI_AGENT_PROTOCOL_V1` / `1.2`

## Boundary

The package owns:

- strict typed protocol envelopes over an injected transport;
- host-owned signing through `CmaiAgentSigner` (the private key never enters the client);
- pair, key rotation, feed, challenge fetch, local status, revoke, and submit calls;
- the local `challenge_ready → preview → submitting → submitted|submit_failed` state machine;
- explicit edit, discard, fresh-grant rerun, and same-payload retry transitions;
- strict contribution-card validation, credential-shaped key rejection, and paired-local provenance normalization;
- stable protocol/transport/client error classification and recovery instructions;
- local idempotency-key binding before a request can become transport-ambiguous;
- deterministic fake transport and runtime adapter test doubles.

It does not own HTTP paths, headers, platform persistence, authentication policy, rewards, challenge lifecycle, Hermes/OpenClaw registration, provider discovery, provider credentials, or model calls.

## Integration sequence

1. Implement `CmaiAgentTransport`; map each operation to the platform route chosen by the platform card. Return `{ status, body }` after JSON decoding. Never log raw envelopes.
2. Implement `CmaiAgentSigner` around host-owned Ed25519 key storage. Return only the canonical base64url signature.
3. Call `pair`, `feed`, `fetchChallenge`, and `prepareRun`.
4. Show cost/task scope and obtain explicit run approval outside the core.
5. Invoke the runtime package's `CmaiAgentRuntimeAdapter.execute` implementation.
6. Pass the result to `preview(..., { userApprovedRun: true })`; let the user inspect/edit/discard.
7. Call `submit` only after explicit submit approval. Call `retrySubmit` only when the surfaced recovery is `retry_same_request`; the client preserves the exact payload and idempotency key.
8. For a new model call, use `refreshForRerun` to fetch a fresh nonce, then obtain fresh run approval. The core never reruns inference automatically.

`status()` is a local, redacted state snapshot. Protocol V1 intentionally has no remote `status` operation. Do not invent one in runtime adapters.

## Compatibility and exports

The source exports are `.` (client/types/errors/state) and `./fakes`. The package is private and source-only in this foundation card; it is consumed by the repository TypeScript/Bun build. Release cards must bundle or compile the frozen protocol dependencies and prove the packed artifact before publication. Real Hermes/OpenClaw adoption belongs to later adapter/conformance cards.

The API is exact for Protocol V1. Unknown wire fields fail closed. New signing, enum, credential, nonce/idempotency, or trust behavior requires a protocol-version decision and mixed-version fixtures rather than a silent client change.

## Runtime assumptions

- Supported now: Bun and Node.js 20+ TypeScript/bundler hosts.
- Required globals: `AbortController`, `TextEncoder`, timers, and cryptographically strong `globalThis.crypto.randomUUID()` unless an injected `requestId` factory is supplied.
- Browser bundles are not supported in V1. The frozen protocol implementation currently uses `node:crypto` and `node:buffer`; more importantly, pairing signers belong in the local Agent host, not public page JavaScript. Browser UI should call platform APIs and must not embed pairing key material.
- The transport is outbound-only. No daemon, inbound port, background polling, link fetching, tool execution, local-file access, or package installation is implied.

## Security notes

Challenge and card strings remain inert data. Credential rejection examines JSON key shapes, not text content. Successful and failed response bodies are schema-validated; malformed bodies are discarded and never included in client errors. A paired local submission is normalized to `paired_local_agent` / runtime-reported unverified provenance and cannot claim provider verification, remote attestation, sandbox receipts, or `fully_trusted` status.
