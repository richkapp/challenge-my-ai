---
date: 2026-07-14
topic: local-agent-plugin-inference-network
status: product requirements / architecture decision
---

# Local Agent Plugin Inference Network Requirements

## Executive decision

Challenge My AI should remain a **platform**. The platform is where challenges, public debate, profiles, social links, attribution, reputation, credits, synthesis, moderation, and searchable precedent compound.

The preferred connected-Agent execution mechanism should become an optional local plugin backed by one runtime-neutral **CMAI Agent Protocol** and shared client core. Public launch scope includes both **Hermes** and **OpenClaw** adapters so contributors can use the model already configured in their own Agent runtime without Challenge My AI receiving provider credentials.

The split is:

- **Challenge My AI platform:** owns the network, challenge state, identity, incentives, review history, synthesis, reputation, and public artifacts.
- **Shared CMAI Agent client:** owns pairing, feed, contribution validation, preview, submission, revocation, redaction, and stable protocol behavior.
- **Hermes and OpenClaw adapters:** run one structured contribution locally through the contributor's active Agent model, show the result for approval, and submit it to the platform.
- **Provider authentication:** remains inside the contributor's Agent host. Challenge My AI receives no provider OAuth token, refresh token, API key, or CLI credential state.

The plugin does not replace the platform. It removes the worst provider-authentication and remote-execution problem from the platform.

## Product thesis

People will not share inference merely because they have unused tokens. They will share it when the exchange gives them something worth accumulating:

1. credits they can spend on their own challenges;
2. public reputation for producing useful outcomes;
3. attribution and social discovery;
4. topic-specific status and access to better challenges;
5. evidence that their Agent contributions changed decisions, resolved problems, or improved public answers.

Challenge My AI should reward **impact**, not claimed model prestige, token volume, verbosity, or compute spent.

Because exact model identity may remain unprovable for locally controlled runs, the platform's economic truth should be:

> The challenge poster judges whether the contribution changed the challenge. Reputation compounds from repeated impact, not from a model badge.

## Product roles

### Challenge poster

The person who owns the question, decision, problem, debate, audit, or request for perspective. The poster defines the desired outcome, reviews inbound contributions, approves updates to the current answer, allocates reward, and closes or reopens the challenge.

### Contributor

The person who points their Agent at someone else's challenge. The contributor controls whether a run happens, reviews the generated contribution before submission, and receives credits, reputation, and attribution based on impact.

### Challenge steward

The poster's AI-assisted reviewer. It compares inbound contributions against the challenge's current state, recommends an impact tier and point award, proposes an exact update, and recommends whether the challenge should remain open, become decision-ready, become sufficiently explored, or close as solved.

The steward advises. The poster confirms consequential decisions.

### Challenge My AI platform

The neutral network and ledger. It holds challenge history, contribution history, poster decisions, reward settlement, public profiles, social links, moderation state, synthesis artifacts, and reputation calculations.

### Contributor Agent

The model used by the contributor. It is called locally through the supported host-owned inference surface of the selected Agent runtime.

## Launch adapters

The public plugin-network launch supports Hermes and OpenClaw through the same protocol and user workflow. Runtime selection is setup, not a separate contribution lane.

### Hermes

Hermes officially allows plugins to register tools, slash commands, CLI commands, hooks, and bundled skills. A plugin can make a bounded structured model call through `ctx.llm.complete_structured()`.

That API provides:

- the user's active Hermes provider and model;
- host-owned credentials that the plugin never receives;
- structured JSON output with schema validation;
- provider/model attribution and usage metadata when available;
- audit attribution for the plugin call;
- fail-closed provider/model/profile override controls.

Official references:

- <https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins>
- <https://hermes-agent.nousresearch.com/docs/developer-guide/plugin-llm-access>

### OpenClaw

OpenClaw native plugins can register commands, tools, bundled skills, hooks, HTTP routes, and services. The adapter can make a host-owned completion through `api.runtime.llm.complete()` and distribute through ClawHub, npm, Git, or local installation.

OpenClaw active-model metadata is informational runtime evidence, not remote attestation.

Official references:

- <https://docs.openclaw.ai/plugins/building-plugins>
- <https://docs.openclaw.ai/plugins/sdk-runtime>
- <https://docs.openclaw.ai/plugins/manifest>
- <https://docs.openclaw.ai/tools/plugin>

Provider terms still apply to the authentication method configured inside the contributor's Agent runtime. A local adapter does not make a prohibited provider route compliant. For example, Gemini inside Hermes should use Google AI Studio or Vertex credentials rather than piggybacking Gemini CLI OAuth.

## Platform and plugin boundary

| Concern | Platform owns | Shared client + runtime adapter owns |
|---|---|---|
| Challenge discovery | Feed, search, matching, reward visibility | Fetch selected challenge or inbox |
| Identity | CMAI account, profile, social links, public reputation | Device pairing to one CMAI account |
| Provider credentials | Never receives them | Never receives them; Agent host owns them |
| Model execution | Optional remote sandbox path only where appropriate | One local structured LLM call through Hermes or OpenClaw |
| User consent | Records pairing and submission confirmation | Requires explicit run and submit approval |
| Contribution format | Validates `CMAI_CONTRIBUTION_CARD_V1` | Requests and locally validates that schema |
| Challenge review | Stores poster decision, reward, revision, closure | Bundles the challenge-steward skill for recommendations |
| Provenance | Labels what the platform can honestly prove | Sends paired-client, plugin version, Hermes audit metadata, provider/model claims |
| Reputation | Computes public impact and host fairness | None |
| Moderation | Reports, suppression, appeals, abuse controls | Refuses unsafe or malformed submissions locally where possible |

## Contributor flow

### Installation and pairing

1. Contributor installs and explicitly enables the plugin.
2. `/cmai pair` creates or accepts a one-time CMAI pairing code.
3. CMAI associates a plugin public key or scoped client credential with the user's account.
4. Provider credentials remain in Hermes and are never included in CMAI pairing.

Conceptual installation:

```bash
hermes plugins install richkapp/cmai-hermes --enable
```

### Contribution

1. Contributor runs `/cmai feed` or opens a challenge and copies its short run code.
2. Contributor runs `/cmai run <challenge-id>`.
3. The plugin displays the challenge, requested perspective, reward, expected token budget, and public-data warning.
4. Contributor explicitly approves one model call.
5. The plugin calls `ctx.llm.complete_structured()` against the contributor's active Hermes provider/model.
6. The plugin validates `CMAI_CONTRIBUTION_CARD_V1`.
7. Contributor previews the card and chooses submit, revise, or discard.
8. The plugin submits the card, challenge nonce, paired-client signature, plugin version, and safe Hermes audit metadata.
9. The platform posts the contribution and notifies the challenge poster.

V1 should be command-driven and outbound-only. It should not require a daemon, inbound port, browser extension, or background polling service.

### Later web-to-local dispatch

A later connector may let a user click **Run with my Agent** on the website and receive a pending job in their paired Hermes installation. That connector must remain outbound-only, bounded, and explicitly approved per run. It is deferred until the command-driven loop proves demand.

## Two user-facing contribution actions

The plugin must not create a third product lane.

Challenge rooms continue to present:

1. **Copy prompt** — run anywhere and paste the result.
2. **Run with my Agent** — use a connected execution mechanism, including a Hermes/OpenClaw local adapter or an approved platform sandbox.

The resulting contribution displays its provenance separately from the action that created it.

## Honest provenance

Recommended provenance tiers:

| Tier | What it proves | What it does not prove |
|---|---|---|
| Self-submitted | A signed-in contributor posted the card | Which model ran or whether the output was modified |
| Paired local Agent adapter | A paired Hermes or OpenClaw adapter submitted a schema-valid card after a local host-owned call | Untampered local execution or provider-signed model identity |
| CMAI sandbox run | CMAI controlled the prompt bundle, runner, artifact validation, receipt, and teardown | Provider-signed model identity unless provider evidence supports it |

A paired local key proves that the paired client submitted the card. It is not remote attestation. A contributor controls their computer and could modify local code.

Therefore:

- do not label plugin contributions `fully_trusted`;
- do not award more points merely because a contributor claims a frontier model;
- show provider/model metadata as attribution with the correct confidence label;
- let usefulness and downstream impact drive rewards.

## Incentive system

The network needs three distinct rewards.

### 1. Spendable credits

Credits let contributors post their own higher-reward challenges or access later priority/depth/private features. Public participation should provide enough initial allowance to start the loop, while useful contributions replenish it.

### 2. Non-transferable reputation

Reputation should reflect repeated impact, not current credit balance. Spending earned credits must not reduce reputation. Moderation reversals and proven abuse may reduce it.

Useful reputation dimensions include:

- material contributions;
- decisive contributions;
- challenges helped toward closure;
- topic-specific impact;
- poster endorsements;
- response reliability;
- dispute and reversal history.

### 3. Public attribution

Profiles should make useful work legible outside the platform:

- display name, bio, avatar, and verified social links;
- topic/expertise tags earned from actual contribution history;
- public challenges posted and helped;
- accepted/material/decisive contribution counts;
- public answer artifacts that credit the contributor;
- profile and social click-through;
- badges based on impact, not raw volume.

A contributor should be able to point at a profile and say: “My Agent helped solve these real problems.”

## Host incentives and accountability

Contributor incentives collapse if posters can consume useful work and refuse to reward it. The platform must build reputation for **hosts as well as contributors**.

A host profile should expose:

- percentage of submitted contributions reviewed;
- median review time;
- percentage receiving positive impact ratings;
- challenge closure rate;
- reward payout rate;
- rating reversals and disputes;
- whether current answers visibly incorporate credited contributions.

Contributors should see this before spending inference on a challenge.

A challenge reward should be escrowed or otherwise bounded when posted. The poster may allocate it, but cannot promise a bounty and silently keep the entire benefit without an auditable outcome.

## Challenge intent and closure language

Not every challenge is a problem that can be “solved.” At creation, the poster or steward classifies the intent.

| Intent | Successful closure language | Typical evidence |
|---|---|---|
| Solve a problem | Solved / unblocked | Success criteria satisfied or blocker removed |
| Make a decision | Decision-ready | Key trade-offs resolved enough to choose |
| Pressure-test a plan | Review complete | Material risks and fixes incorporated |
| Gather perspectives | Sufficiently explored | Perspective coverage reached and novelty flattened |
| Debate a claim | Closed with conclusion or disagreement | Strongest arguments recorded; remaining disagreement explicit |
| Generate options | Option set complete | Useful option diversity and decision criteria reached |
| Audit or red-team | Audit complete | High-severity findings assessed and dispositioned |

The challenge must define success criteria or an evidence threshold appropriate to its intent. The steward should never call an open-ended debate “solved” merely because activity slowed down.

## Impact review rubric

Every inbound contribution should be reviewed against the current challenge state, not in isolation.

Recommended impact tiers:

| Tier | Meaning | Reward posture |
|---|---|---|
| 0 — No value | Off-topic, wrong, unsafe, duplicate without useful improvement, or unsupported noise | No credit; moderation if needed |
| 1 — Signal | Slightly clarifies, confirms, or surfaces a minor consideration without changing the current answer | Small recognition |
| 2 — Useful | Adds a valid missing point, improves reasoning, or removes meaningful ambiguity | Meaningful partial award |
| 3 — Material | Changes part of the recommendation, plan, risk posture, or current answer | Large award and explicit attribution |
| 4 — Decisive | Satisfies key success criteria, removes the blocker, or directly enables closure | Highest award and resolution bonus where applicable |

The steward should consider:

- relevance to the requested intent;
- novelty relative to prior contributions;
- factual and logical soundness;
- evidence quality;
- actionability;
- magnitude of the change caused;
- whether the contribution survives follow-up scrutiny;
- safety and policy risk;
- whether another contributor supplied the same core insight first.

Length, confidence, token count, model brand, and rhetorical polish are not impact.

## Point allocation

The existing implementation awards rating-driven credits per contribution with caps. That is a useful launch scaffold, but the mature incentive system should settle against a bounded challenge reward.

Recommended product rules:

1. The poster selects a challenge reward budget from available credits.
2. The platform escrows or reserves that budget.
3. The steward recommends an impact tier and point amount after each review.
4. The poster confirms or edits the recommendation with a short rationale.
5. Total final contribution awards cannot exceed the challenge budget.
6. Solve/decision/audit challenges may reserve a completion bonus for decisive contributions.
7. Perspective/debate challenges distribute the budget by coverage and impact without requiring a “winner.”
8. Duplicate insights reward the earliest substantive contribution unless a later contribution materially improves evidence or execution.
9. Ratings and awards remain reversible with an audit trail when moderation or later evidence invalidates them.
10. Unused reward handling must be explicit. A small posting fee may remain non-refundable; the remainder may return to the poster when the challenge closes without useful contributions.

Initial recommendation bands:

- Tier 1: roughly 5–10% of the available reward;
- Tier 2: roughly 10–25%;
- Tier 3: roughly 25–50%;
- Tier 4: roughly 50–100%, normalized when several contributions share impact.

These are calibration bands, not permanent economics. The platform should measure payout fairness, contribution supply, host behavior, and inflation before fixing exact formulas.

Credits should not be cash-convertible at launch. Cash payouts would introduce fraud, tax, labor-marketplace, identity, and regulatory burdens before the core exchange is proven.

## Challenge steward skill

Both launch adapters should bundle a `cmai-challenge-steward` skill. The full product specification is in:

- `docs/product/2026-07-14-challenge-steward-skill-spec.md`

The skill helps the poster's AI:

- define intent, success criteria, closure policy, and reward posture;
- review inbound contributions against the current answer;
- identify novelty, duplication, errors, evidence gaps, and safety issues;
- recommend an impact tier and points;
- propose a precise update rather than overwriting the answer wholesale;
- preserve dissent and contributor attribution;
- recommend remaining open, decision-ready, sufficiently explored, review complete, solved, or closed with disagreement;
- prepare the final synthesis and reward distribution;
- reopen a challenge when later evidence invalidates the current version.

The steward cannot mint credits, close the challenge, suppress a contribution, or publish a rewritten current answer without the poster's confirmation in the initial release.

## Missing pieces required for a working market

### Challenge quality

Contributors will not spend inference on vague prompts. Challenge creation must require a clear intent, current answer, missing information, constraints, requested perspectives, and success/closure criteria.

### Cost consent

Even “unused” inference has allowance, latency, and opportunity cost. The plugin must show the requested task and an estimated run budget before calling the model. No silent or recurring inference sharing.

### Liquidity and cold start

A reward system is irrelevant if nobody receives contributions. Early operation likely needs:

- curated high-quality public challenges;
- platform-seeded rewards;
- topic matching and notifications;
- a contributor onboarding queue with immediately answerable challenges;
- recognition for early high-impact contributors;
- manual curation before broad algorithmic ranking.

### Host reliability

Fast, fair review is part of the product. Delayed ratings kill the incentive loop. Hosts should receive reminders, and stale unreviewed challenges should lose feed prominence or trigger a defined settlement/review policy.

### Disputes and abuse

The poster remains the primary judge because they own the context and outcome. Community votes are useful signals but should not automatically mint credits or overrule the poster.

The platform still needs:

- dispute/report paths for obvious bad-faith ratings;
- host fairness history;
- contributor plagiarism/duplicate detection;
- anti-sybil and self-reward controls;
- rate limits and daily earning caps;
- moderation reversals;
- transparent revision and reward histories.

### Rights, privacy, and attribution

Public challenge and contribution terms must explain:

- what becomes public and searchable;
- how public answer artifacts may quote or summarize contributions;
- how attribution and social links are displayed;
- what can be deleted, suppressed, or anonymized;
- that contributors must not submit private provider transcripts or credentials;
- that public challenges must not include proprietary or sensitive information without authorization.

### Revision history

The current answer should be versioned. Every material update should show:

- what changed;
- which contribution caused the change;
- who approved it;
- what disagreement remains;
- whether rewards were affected.

Without this, reputation becomes an opaque popularity score instead of evidence of impact.

## Public profile requirements

Profiles should support:

- display name and handle;
- short bio;
- avatar;
- verified social links and personal/project website;
- topic specialties inferred from accepted work, with user-editable claims clearly distinguished;
- public contribution history;
- material and decisive impact counts;
- answer artifacts and challenge revisions carrying attribution;
- contributor badges;
- host fairness/review history;
- privacy controls for hiding selected public-profile details without rewriting the public challenge record.

Avoid a single global leaderboard dominated by volume. Prefer topic, time-window, and impact-weighted discovery.

## Metrics

The plugin and incentive loop should be judged by:

- plugin installation-to-pairing completion;
- paired user to first submitted contribution;
- challenge view to approved plugin run;
- contribution-to-review time;
- percentage of contributions rated Tier 2+;
- percentage rated material or decisive;
- challenge closure/decision-readiness rate;
- percentage of contributors who later post a challenge;
- repeat contribution rate;
- reward payout and reversal rates;
- host review completion and median review time;
- profile/social click-through;
- dispute, plagiarism, spam, and moderation rates;
- percentage of synthesized answers with visible attributed changes.

Do not optimize for total tokens donated. Optimize for useful challenge movement per contribution.

## MVP scope

### In scope

- Optional Hermes or OpenClaw adapter installation and pairing.
- Shared `pair`, `feed`, `run`, `preview`, `submit`, and `revoke` behavior.
- Runtime-neutral client core and cross-runtime conformance suite.
- One local structured model call through the selected Agent runtime's host-owned inference seam.
- Explicit cost/run approval and contribution preview.
- Paired-adapter provenance without provider-verification overclaiming.
- Challenge intent and closure criteria.
- Challenge steward review recommendations.
- Poster-confirmed impact tier, answer update, lifecycle change, and points.
- Spendable credits, non-transferable impact reputation, and public attribution.
- Public profiles with social links and host/contributor history.
- Versioned current-answer updates and final synthesis.
- Existing manual copy/paste path.

### Deferred

- Background plugin daemon or push-triggered local jobs.
- Automatic website-to-local execution.
- Cash or crypto payouts.
- Remote attestation of home machines.
- Provider-signed receipts as a launch requirement.
- Fully autonomous AI point allocation or challenge closure.
- Plugins/connectors for every other Agent harness.
- Global volume leaderboards.

### Outside the product

- Provider credential sharing.
- Raw inference resale.
- Rewarding claimed model prestige or token spend.
- Silent background use of contributors' model allowances.
- Treating open debate as a forced winner-take-all competition.

## Acceptance examples

1. A contributor pairs the plugin, approves one local Agent call, previews the strict card, submits it, and CMAI stores no provider credential.
2. A paired plugin contribution displays accurate paired-client provenance without claiming provider-verified model identity.
3. A minor clarifying contribution receives a small award but does not outrank a material change solely because it used a more expensive model.
4. A contribution that changes the current recommendation receives explicit attribution, a material impact rating, and a larger award.
5. A decisive contribution can trigger a poster-confirmed solved recommendation when objective success criteria are met.
6. A debate challenge closes as sufficiently explored or closed with disagreement rather than falsely “solved.”
7. The steward proposes a diff and point recommendation, but no credits or lifecycle change occur until the poster confirms.
8. A contributor can inspect a host's review/payout history before spending inference.
9. A public answer artifact identifies which contributions changed the answer while preserving unresolved disagreement.
10. A later invalidating fact can reopen the challenge, revise the answer, and preserve the earlier decision trail.

## Product decisions

- The platform remains essential; runtime plugins are execution adapters, not the product.
- Hermes and OpenClaw are launch adapters over one CMAI Agent Protocol and sit under **Run with my Agent**, not separate lanes.
- Provider credentials remain inside the contributor's Agent runtime.
- Plugin runs are paired and recorded but not `fully_trusted`.
- Impact, not model identity, drives points and reputation.
- Poster judgment remains primary, assisted by a steward skill and bounded by escrow, audit history, host reputation, moderation, and disputes.
- Challenge closure language follows challenge intent.
- The current answer is versioned and contributor impact is attributable.
- Credits remain non-cash at launch.

## Open calibration questions

- How much of every challenge reward should be non-refundable to prevent exploitative hosts without discouraging posting?
- Should reward settlement happen continuously, at closure, or through a small immediate award plus closure bonus?
- Which social-link verification methods are worth the friction at launch?
- How should host fairness affect feed ranking without punishing genuinely difficult challenges?
- What daily inference and earning controls best discourage spam without choking early liquidity?
- Which first topic cohort has enough challenge supply and contributor expertise to make reputation meaningful quickly?
