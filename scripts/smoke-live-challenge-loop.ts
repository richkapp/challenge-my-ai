import { pathToFileURL } from "node:url";
import type { ChallengeBrief, ContributionCard } from "../lib/types";
import { createChallengeSemantics, defaultSuccessCriteria } from "../lib/challenges/intent";
import { challengePublicationAcknowledgementHash } from "../lib/challenges/intentAcknowledgement";

export type LiveChallengeLoopSmokeEnv = Record<string, string | undefined>;
export type LiveChallengeLoopSmokeLogger = (line: string) => void;

type EnvSnapshot = Partial<Record<"NODE_ENV" | "CMAI_RUNTIME_ENV" | "CMAI_AUTH_MODE" | "CMAI_STORE_DRIVER", string>>;

type JsonObject = Record<string, unknown>;

type SmokeContributionSummary = {
  id: string;
  contributor_id: string;
  kind: string;
  trust_label?: string;
};

function forceLocalTestRuntime(): EnvSnapshot {
  const mutableEnv = process.env as Record<string, string | undefined>;
  const previous: EnvSnapshot = {
    NODE_ENV: process.env.NODE_ENV,
    CMAI_RUNTIME_ENV: process.env.CMAI_RUNTIME_ENV,
    CMAI_AUTH_MODE: process.env.CMAI_AUTH_MODE,
    CMAI_STORE_DRIVER: process.env.CMAI_STORE_DRIVER,
  };
  mutableEnv.NODE_ENV = "test";
  mutableEnv.CMAI_RUNTIME_ENV = "test";
  mutableEnv.CMAI_AUTH_MODE = "test";
  mutableEnv.CMAI_STORE_DRIVER = "local";
  return previous;
}

function restoreRuntime(previous: EnvSnapshot) {
  const mutableEnv = process.env as Record<string, string | undefined>;
  for (const key of Object.keys(previous) as Array<keyof EnvSnapshot>) {
    const value = previous[key];
    if (value === undefined) delete mutableEnv[key];
    else mutableEnv[key] = value;
  }
}

function buildSmokeBrief(): ChallengeBrief {
  const successCriteria = defaultSuccessCriteria("pressure_test");
  return {
    schema_version: "1.0",
    ...createChallengeSemantics({
      intent: "pressure_test",
      successCriteria,
      status: "confirmed",
      changeReason: "Local smoke criteria confirmed for the public challenge loop.",
    }),
    title: "Loop smoke narrow rollout",
    category: "product",
    challenge_mode_requested: ["critique", "risk_audit"],
    problem_statement: "A team wants to launch a public AI feature, but the current answer skips the community pressure-test loop.",
    original_ai_answer: "Launch broadly now and let generic analytics reveal whether users care.",
    context: "This smoke treats all challenge text as inert data and proves manual paste plus Run my Agent here feed the same rating, synthesis, and answers archive loop.",
    constraints: ["No live provider credentials", "No Railway/Vercel/Supabase mutation", "No challenge-provided code or link execution"],
    success_criteria: successCriteria,
    assumptions_to_test: ["A broad launch is safer than a narrow beta", "Agent self-grades should influence rewards"],
    claims_to_check: ["A narrow beta creates better reusable precedent"],
    known_risks: ["False confidence", "Rewarding unreviewed model self-grades"],
    what_a_useful_response_should_address: ["community loop", "rating reward", "synthesis artifact"],
    privacy_sensitivity: "public_ok",
    redactions_made: [],
    abuse_or_safety_flags: [],
    missing_information: [],
    raw_material_summary: "Local smoke brief for the live challenge-room community loop.",
  };
}

function buildManualCard(challengeId: string): ContributionCard {
  return {
    schema_version: "1.0",
    challenge_id: challengeId,
    contribution_mode: "risk_audit",
    contributor_ai_label: "Manual Smoke Agent",
    model_provenance: {
      source: "client_attested",
      provider: "local-manual-smoke",
      model: "manual-smoke-model",
      model_display_name: "Manual smoke model",
      adapter: "manual_copy_paste",
      verified: false,
      verification_notes: "Submitted through visible copy prompt → paste local output; no server-side provider or sandbox proof claimed.",
    },
    skills_or_context_used: ["visible prompt preview", "manual paste lane"],
    verdict: "The broad launch path hides the reward and synthesis loop.",
    original_answer_grade: { score_0_to_10: 4, grade_label: "weak", why: "It skips the riskiest assumption and ignores reusable precedent." },
    answer_to_challenge_poster: "Start with a narrow beta and require challenge-poster ratings before credits move.",
    reasoning_summary: "Manual lane proves a contributor can inspect the prompt, run a local Agent, paste a strict card, and still join the same debate loop.",
    strongest_objections: ["Generic analytics will not explain why the answer failed.", "Self-grades should never mint rewards without poster review."],
    missing_assumptions_or_context: ["Who rates usefulness?", "What artifact should future users find?"],
    alternative_recommendation: "Run a narrow beta, rate useful critiques, then synthesize the strongest objections into a reusable decision artifact.",
    risks_and_failure_modes: ["Manual submissions can overclaim provenance", "Unrated contributions can look more useful than they are"],
    claims_to_verify: ["Poster rating is enough to settle the first credit delta"],
    confidence: { level: "medium", why: "The recommendation is based on the submitted brief and product constraints only." },
    what_would_change_my_mind: ["Evidence that broad launch feedback produces clearer objections than rated challenge threads"],
    suggested_follow_up_questions: ["What would make the beta too narrow?", "Which risks should the synthesis preserve?"],
    safety_or_scope_notes: ["Challenge text remained untrusted data.", "No URLs, code, package installs, or shell commands from the challenge were executed."],
    abuse_or_prompt_injection_flags: [],
    raw_output_summary: "Manual smoke contribution card for loop proof.",
  };
}

function fencedContributionCard(card: ContributionCard) {
  return `\`\`\`CMAI_CONTRIBUTION_CARD_V1\n${JSON.stringify(card, null, 2)}\n\`\`\``;
}

function request(path: string, options: { method?: string; body?: unknown; userId?: string; userName?: string } = {}) {
  const method = options.method || (options.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.userId) {
    headers["x-cmai-user-id"] = options.userId;
    headers["x-cmai-user-name"] = options.userName || options.userId;
  }
  return new Request(`http://test.local${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

function params(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function readJson(response: Response, step: string): Promise<JsonObject> {
  const data = await response.json() as unknown;
  const object = isObject(data) ? data : {};
  if (!response.ok) {
    throw new Error(`${step} failed with HTTP ${response.status}: ${JSON.stringify(object).slice(0, 600)}`);
  }
  return object;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function objectValue(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sumCreditEvents(events: unknown[], contributionId: string) {
  return events
    .map(objectValue)
    .filter((event) => event.contributionId === contributionId)
    .reduce((sum, event) => sum + numberValue(event.amount), 0);
}

function contributionSummary(value: unknown): SmokeContributionSummary {
  const contribution = objectValue(value);
  const card = objectValue(contribution.card);
  const provenance = objectValue(card.model_provenance);
  return {
    id: stringValue(contribution.id),
    contributor_id: stringValue(contribution.contributorId),
    kind: stringValue(contribution.contributorKind),
    trust_label: stringValue(provenance.source),
  };
}

function assertNoSecretShapedValues(summary: JsonObject) {
  const serialized = JSON.stringify(summary);
  const forbidden = [/api[_-]?key/i, /secret/i, /token/i, /DATABASE_URL/i, /RAILWAY_API_TOKEN/i, /OPENROUTER_API_KEY/i, /ANTHROPIC_API_KEY/i];
  for (const pattern of forbidden) {
    if (pattern.test(serialized)) throw new Error(`Smoke summary contained forbidden secret-shaped text matching ${pattern}`);
  }
}

export async function runLiveChallengeLoopSmoke(options: {
  env?: LiveChallengeLoopSmokeEnv;
  stdout?: LiveChallengeLoopSmokeLogger;
  stderr?: LiveChallengeLoopSmokeLogger;
} = {}): Promise<number> {
  const stdout = options.stdout || console.log;
  const stderr = options.stderr || console.error;
  const previousRuntime = forceLocalTestRuntime();

  try {
    const [
      store,
      challengesRoute,
      promptRoute,
      parseRoute,
      contributionsRoute,
      agentHomeRoute,
      connectionsRoute,
      connectionSmokeRoute,
      agentRunsRoute,
      ratingsRoute,
      synthesisRoute,
      artifactRoute,
      answersRoute,
    ] = await Promise.all([
      import("../lib/store"),
      import("../app/api/challenges/route"),
      import("../app/api/challenges/[id]/prompt/route"),
      import("../app/api/challenges/[id]/contributions/parse/route"),
      import("../app/api/challenges/[id]/contributions/route"),
      import("../app/api/agent-home/route"),
      import("../app/api/agent-home/connections/route"),
      import("../app/api/agent-home/connections/[id]/smoke/route"),
      import("../app/api/challenges/[id]/agent-runs/route"),
      import("../app/api/contributions/[id]/ratings/route"),
      import("../app/api/challenges/[id]/synthesis/route"),
      import("../app/api/answers/[id]/artifact/route"),
      import("../app/api/answers/route"),
    ]);

    await store.resetStoreForTests();

    const posterId = "loop-poster";
    const contributorId = "loop-contributor";
    const brief = buildSmokeBrief();
    const briefHash = await challengePublicationAcknowledgementHash(brief);

    const challengeJson = await readJson(await challengesRoute.POST(request("/api/challenges", {
      userId: posterId,
      userName: "Loop Poster",
      body: { brief, reward: 30, visibility: "public", criteriaAcknowledgement: { briefHash } },
    })), "create challenge");
    const challenge = objectValue(challengeJson.challenge);
    const challengeId = stringValue(challenge.id);
    if (!challengeId) throw new Error("Challenge creation did not return an id.");

    const promptJson = await readJson(await promptRoute.GET(request(`/api/challenges/${challengeId}/prompt?mode=critique`), params(challengeId)), "load visible prompt");
    const prompt = stringValue(promptJson.prompt);
    if (!prompt.includes("CMAI_CONTRIBUTION_CARD_V1")) throw new Error("Visible prompt did not include the contribution-card contract.");

    const manualCard = buildManualCard(challengeId);
    const parseJson = await readJson(await parseRoute.POST(request(`/api/challenges/${challengeId}/contributions/parse`, {
      body: { raw: fencedContributionCard(manualCard) },
    }), params(challengeId)), "parse manual contribution");
    if (parseJson.mismatch === true) throw new Error("Manual contribution card unexpectedly mismatched the challenge id.");

    const manualContributionJson = await readJson(await contributionsRoute.POST(request(`/api/challenges/${challengeId}/contributions`, {
      userId: contributorId,
      userName: "Loop Contributor",
      body: { card: parseJson.card },
    }), params(challengeId)), "submit manual contribution");
    const manualContribution = objectValue(manualContributionJson.contribution);
    const manualContributionId = stringValue(manualContribution.id);
    if (!manualContributionId) throw new Error("Manual contribution did not return an id.");

    const connectionJson = await readJson(await connectionsRoute.POST(request("/api/agent-home/connections", {
      userId: contributorId,
      userName: "Loop Contributor",
      body: { provider: "local_fake", displayLabel: "Loop smoke Agent" },
    })), "create Agent Home connection");
    const createdConnection = objectValue(connectionJson.connection);
    const connectionId = stringValue(createdConnection.id);
    if (!connectionId) throw new Error("Agent Home connection did not return an id.");

    await readJson(await connectionSmokeRoute.POST(request(`/api/agent-home/connections/${connectionId}/smoke`, {
      userId: contributorId,
      userName: "Loop Contributor",
      body: {},
    }), params(connectionId)), "smoke Agent Home connection");

    const agentHomeJson = await readJson(await agentHomeRoute.GET(request("/api/agent-home", {
      userId: contributorId,
      userName: "Loop Contributor",
    })), "load Agent Home readiness");
    const readiness = objectValue(agentHomeJson.readiness);
    if (readiness.canRunHere !== true) throw new Error("Agent Home did not become ready for Run my Agent here.");

    const trustedRunJson = await readJson(await agentRunsRoute.POST(request(`/api/challenges/${challengeId}/agent-runs`, {
      userId: contributorId,
      userName: "Loop Contributor",
      body: {
        approved: true,
        connectionId,
        contributionMode: "critique",
        idempotencyKey: "live-loop-smoke-one-run",
      },
    }), params(challengeId)), "start trusted Agent run");
    const trustedRun = objectValue(trustedRunJson.run);
    const trustedContribution = objectValue(trustedRunJson.contribution);
    const trustedContributionId = stringValue(trustedContribution.id);
    if (trustedRun.status !== "contributed" || !trustedContributionId) throw new Error("Trusted run did not post a contribution.");

    const trustedReplayJson = await readJson(await agentRunsRoute.POST(request(`/api/challenges/${challengeId}/agent-runs`, {
      userId: contributorId,
      userName: "Loop Contributor",
      body: {
        approved: true,
        connectionId,
        contributionMode: "critique",
        idempotencyKey: "live-loop-smoke-one-run",
      },
    }), params(challengeId)), "replay trusted Agent run idempotency key");

    const contributionsAfterReplay = await store.listContributions(challengeId);
    if (contributionsAfterReplay.length !== 2) throw new Error(`Expected exactly 2 contributions after idempotent replay, found ${contributionsAfterReplay.length}.`);

    const trustedCreditsBeforeRating = sumCreditEvents(await store.listCreditEvents(contributorId), trustedContributionId);
    if (trustedCreditsBeforeRating !== 0) throw new Error("Trusted Agent self-grade minted credits before challenge-poster rating.");

    const manualRatingJson = await readJson(await ratingsRoute.POST(request(`/api/contributions/${manualContributionId}/ratings`, {
      userId: posterId,
      userName: "Loop Poster",
      body: { usefulness: 8, safety: 8, comment: "Manual critique is useful." },
    }), params(manualContributionId)), "rate manual contribution");

    const trustedRatingJson = await readJson(await ratingsRoute.POST(request(`/api/contributions/${trustedContributionId}/ratings`, {
      userId: posterId,
      userName: "Loop Poster",
      body: { usefulness: 9, safety: 8, comment: "Receipt-backed critique is useful." },
    }), params(trustedContributionId)), "rate trusted contribution");

    const trustedRepeatRatingJson = await readJson(await ratingsRoute.POST(request(`/api/contributions/${trustedContributionId}/ratings`, {
      userId: posterId,
      userName: "Loop Poster",
      body: { usefulness: 9, safety: 8, comment: "Same rating should not mint again." },
    }), params(trustedContributionId)), "repeat trusted contribution rating");

    const creditEvents = await store.listCreditEvents(contributorId);
    const manualCreditTotal = sumCreditEvents(creditEvents, manualContributionId);
    const trustedCreditTotal = sumCreditEvents(creditEvents, trustedContributionId);
    if (manualCreditTotal <= 0 || trustedCreditTotal <= 0) throw new Error("Poster ratings did not mint expected contribution credits.");
    if (numberValue(trustedRepeatRatingJson.creditDelta) !== 0) throw new Error("Repeating the same trusted rating minted duplicate credits.");

    const synthesisJson = await readJson(await synthesisRoute.POST(request(`/api/challenges/${challengeId}/synthesis`, {
      userId: posterId,
      userName: "Loop Poster",
    }), params(challengeId)), "synthesize challenge");
    const synthesis = objectValue(synthesisJson.synthesis);
    const artifactUrl = stringValue(synthesisJson.artifactUrl);
    if (artifactUrl !== `/answers/${challengeId}`) throw new Error("Synthesis did not return the expected answer artifact URL.");

    const artifactJson = await readJson(await artifactRoute.GET(request(`/api/answers/${challengeId}/artifact`), params(challengeId)), "load answer artifact");
    const artifact = objectValue(artifactJson.artifact);
    if (stringValue(artifact.id) !== challengeId) throw new Error("Loaded answer artifact did not match challenge id.");
    const contributorHighlights = arrayValue(artifact.contributorHighlights).map(objectValue);
    const highlightTrustLabels = contributorHighlights.map((item) => stringValue(item.trustLabel));
    if (contributorHighlights.length < 2 || !highlightTrustLabels.some((label) => label.includes("sandbox"))) {
      throw new Error("Answer artifact did not preserve source debate/provenance highlights from the smoke challenge.");
    }

    const answerSearchJson = await readJson(await answersRoute.GET(request("/api/answers?q=community%20loop&limit=5")), "search answer artifacts");
    const foundInSearch = arrayValue(answerSearchJson.artifacts).some((item) => objectValue(item).id === challengeId);
    if (!foundInSearch) throw new Error("Synthesized decision artifact was not searchable from /answers.");

    const summary: JsonObject = {
      ok: true,
      mode: "local_test_live_challenge_loop",
      challenge_id: challengeId,
      lanes: ["copy_prompt_paste_local_output", "run_my_agent_here"],
      visible_prompt_preview: true,
      manual_paste_fallback_available: true,
      manual_contribution: contributionSummary(manualContribution),
      trusted_run: {
        id: stringValue(trustedRun.id),
        status: stringValue(trustedRun.status),
        contribution_id: trustedContributionId,
        sandbox_provider: stringValue(trustedRun.sandboxProvider),
        trust_label: stringValue(trustedRun.trustLabel),
        receipt_id: stringValue(objectValue(trustedRun.receiptSummary).receiptId),
        receipt_sha256: stringValue(objectValue(trustedRun.receiptSummary).receiptSha256),
      },
      trusted_contribution: contributionSummary(trustedContribution),
      idempotency: {
        reused: trustedReplayJson.reused === true,
        contribution_count_after_replay: contributionsAfterReplay.length,
      },
      credits: {
        trusted_before_poster_rating: trustedCreditsBeforeRating,
        manual_delta: numberValue(manualRatingJson.creditDelta),
        trusted_delta: numberValue(trustedRatingJson.creditDelta),
        trusted_repeat_delta: numberValue(trustedRepeatRatingJson.creditDelta),
        manual_total: manualCreditTotal,
        trusted_total: trustedCreditTotal,
      },
      synthesis: {
        id: stringValue(synthesis.id),
        artifact_url: artifactUrl,
        confidence: stringValue(synthesis.confidence),
        what_changed: arrayValue(synthesis.whatChanged).map(String),
      },
      answer_artifact: {
        url: stringValue(artifact.artifactUrl),
        debate_url: stringValue(artifact.debateUrl),
        contribution_count: numberValue(artifact.contributionCount),
        useful_contribution_count: numberValue(artifact.usefulContributionCount),
        searchable: foundInSearch,
      },
    };

    assertNoSecretShapedValues(summary);
    stdout(JSON.stringify(summary, null, 2));
    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    stderr(JSON.stringify({ ok: false, code: "LIVE_CHALLENGE_LOOP_SMOKE_FAILED", reason }, null, 2));
    return 1;
  } finally {
    restoreRuntime(previousRuntime);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const exitCode = await runLiveChallengeLoopSmoke();
  process.exitCode = exitCode;
}
