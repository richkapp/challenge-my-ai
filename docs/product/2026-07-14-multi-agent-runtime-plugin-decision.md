---
date: 2026-07-14
topic: multi-agent-runtime-plugin-network
status: product architecture decision
---

# Multi-Agent Runtime Plugin Decision

## Decision

Challenge My AI must not be coupled to Hermes.

The product should expose one **Run with my Agent** action backed by a runtime-neutral **CMAI Agent Protocol** and shared client core. Public launch scope includes two local Agent adapters:

1. **Hermes**
2. **OpenClaw**

A private implementation proof may land one adapter first, but the public plugin-network launch is gated on both adapters passing the same conformance suite.

The platform remains the product. Runtime plugins are execution adapters.

## Shared core

The runtime-neutral client owns:

- account pairing and revocation;
- challenge feed and challenge retrieval;
- run nonce, expiry, and replay protection;
- `CMAI_CONTRIBUTION_CARD_V1` validation;
- contribution preview, explicit approval, and discard;
- idempotent submission and retry behavior;
- redaction and hostile-data handling;
- safe provenance normalization;
- stable errors and cross-runtime conformance fixtures.

Provider credentials must never enter this protocol or reach Challenge My AI.

## Launch adapters

| Runtime | Host-owned inference seam | Adapter responsibilities | Distribution |
|---|---|---|---|
| Hermes | `ctx.llm.complete_structured()` | Hermes plugin commands, structured local run, bundled contribution/steward skills, safe audit metadata | Hermes plugin install flow |
| OpenClaw | `api.runtime.llm.complete()` | Native OpenClaw plugin, commands/tools/skills, structured local run, safe active-model/runtime metadata | ClawHub, npm, Git, or local install |

OpenClaw's active-model metadata is informational. Like a paired Hermes signature, it is not remote attestation or provider-signed proof.

Both adapters must support the same user workflow:

```text
pair → feed → run → preview → submit → revoke
```

Runtime selection belongs in setup. It must not appear as an additional contribution lane.

## Trust and incentives

A local adapter proves that a paired client submitted a schema-valid card. It does not prove:

- an untampered local machine;
- provider-signed model identity;
- that the contributor did not edit the output;
- that a named model produced the entire contribution.

Rewards therefore continue to follow poster-confirmed impact, not runtime, model prestige, token volume, or claimed compute.

## Non-goals, not deferred backlog

The following belong to the superseded hosted-provider strategy and are not planned future work:

- moving the Copilot/Grok broker to Railway;
- expanding hosted OAuth integrations;
- remote attestation of home machines;
- cash or crypto payouts;
- global raw-volume leaderboards.

These require a fresh product decision to re-enter scope.

Background plugin execution, website-triggered local execution, and adapters beyond Hermes/OpenClaw are uncommitted options. They are not launch promises or post-beta tasks.

## Kanban

Board: `challenge-my-ai-plugin-network-20260714`

Cross-runtime cards:

- `t_e1280ef8` — runtime-neutral client core;
- `t_18a5691c` — OpenClaw adapter;
- `t_a4598966` — bounded OpenClaw inference;
- `t_14e81d5f` — package/install/ClawHub proof;
- `t_d66b810c` — Hermes/OpenClaw conformance;
- `t_fa5f31d8` — runtime setup chooser and docs.

## Official OpenClaw references

- <https://docs.openclaw.ai/plugins/building-plugins>
- <https://docs.openclaw.ai/plugins/sdk-runtime>
- <https://docs.openclaw.ai/plugins/manifest>
- <https://docs.openclaw.ai/tools/plugin>
