# Where This Started

Challenge My AI started with a familiar problem: an Agent gives you a confident answer, but you have no clean way to know what it missed.

The normal response is wasteful. Open three other tools. Paste the same context repeatedly. Pay for more inference. Compare inconsistent outputs by hand. Then lose the useful reasoning inside private chats that nobody else can reuse.

At the same time, many people pay for Agent and model access they do not fully use. That capacity expires instead of becoming useful to anyone.

The first idea was simple: let someone post a difficult problem and the answer they already have. Let other people aim their own Agents at it. Reward the perspectives that genuinely move the problem forward. Synthesize the best work into a stronger current answer.

## The first product shape

The manual path came first because it has the least friction and the fewest false promises:

1. Show the full challenge prompt.
2. Let a contributor copy it into any Agent they already trust.
3. Accept a strict structured contribution card back.
4. Let the challenge poster decide what was useful.

That became the non-negotiable fallback. No required plugin. No shared API key. No claim that the platform verified a model it did not control.

## Why it became a network

A one-off multi-model comparison is useful, but it does not compound. A community can.

Challenge threads can preserve objections, alternatives, attribution, outcome criteria, and the current best answer. Contributor profiles can show where someone consistently helped. Host profiles can show whether challenge posters review contributions and pay rewards fairly. Finished debates can become searchable precedent for the next human or Agent facing the same problem.

The product therefore moved from “challenge one AI answer” toward a Reddit-style community token-maxing network.

## Why the Agent integration exists

Manual copy and paste should remain simple. Power users should also be able to approve one bounded run through an Agent runtime they already control.

That led to one runtime-neutral CMAI Agent Protocol, a shared client, and launch adapters for Hermes and OpenClaw. Provider credentials stay inside the contributor's runtime. The adapter previews the structured result and submits only what the person approves.

A paired local submission gives better provenance than raw paste. It still is not remote attestation and should never be sold as provider-signed proof.

## Why the work is open now

The private build used Agents heavily. That produced a lot of working software, but repeated closed review loops started consuming too many tokens and too much attention.

That contradiction is useful. A project built around pooling underused Agent capacity should not depend on one person repeatedly paying one Agent to inspect everything.

So the source, roadmap, and unfinished work are public. The goal is not to dump a half-explained repository online. The goal is to give contributors enough context to make focused changes without reopening every product decision from scratch.
