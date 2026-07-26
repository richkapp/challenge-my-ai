import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as legacyAgentFeedGet, POST as agentFeedPost } from "@/app/api/agent/feed/route";
import { POST as agentContributionPost } from "@/app/api/agent/contribution/route";
import {
  agentChallengeGetRequestSchema,
  agentContributionSubmitRequestSchema,
  agentFeedListRequestSchema,
  type AgentChallengeGetResponse,
  type AgentFeedListResponse,
} from "@/lib/agent-protocol/schemas";
import { validContributionSubmitRequestFixture } from "@/lib/agent-protocol/fixtures";
import { AgentFeedProtocolService } from "@/lib/agent-feed/service";
import { setPlatformAgentFeedProtocolServiceForTests } from "@/lib/agent-feed/runtime";
import { CmaiAgentFeedTelemetrySink } from "@/lib/agent-feed/telemetry";
import { PairingService } from "@/lib/agent-pairing/service";
import { setPlatformPairingServiceForTests } from "@/lib/agent-pairing/runtime";
import { MemoryPairingStateBackend, type PairingStateBackend } from "@/lib/agent-pairing/storage";
import { generatePairingTestKey, pairCreateRequest, signedPairingRequest } from "@/lib/agent-pairing/testUtils";
import { LocalTelemetryCollector } from "@/lib/telemetry/collector";
import {
  createChallenge,
  getContribution,
  resetStoreForTests,
  submitAgentFeedContribution,
  suppressChallenge,
  transactAgentFeedRequest,
} from "@/lib/store";
import { createLocalAgentProtocolTransactionCoordinator, withAgentFeedTransaction } from "@/lib/store/local";
import type { ChallengeBrief } from "@/lib/types";

const now = "2026-07-15T12:00:00.000Z";
const cursorSecret = "agent-feed-route-test-cursor-secret-32-bytes-minimum";

function brief(title: string, category = "security"): ChallengeBrief {
  return {
    schema_version: "1.0",
    title,
    category,
    challenge_mode_requested: ["critique"],
    problem_statement: `Problem ${title}`,
    original_ai_answer: `Answer ${title}`,
    context: `Context ${title}`,
    constraints: [],
    success_criteria: ["Find the flaw", "Verify the evidence"],
    assumptions_to_test: [],
    claims_to_check: [],
    known_risks: [],
    what_a_useful_response_should_address: ["Evidence"],
    privacy_sensitivity: "public_ok",
    redactions_made: [],
    abuse_or_safety_flags: [],
    missing_information: [],
    raw_material_summary: `Summary ${title}`,
    challenge_semantics_version: "1.0",
    challenge_intent: "pressure_test",
    criteria_status: "confirmed",
    criteria_version: 1,
    successful_outcomes: ["review_complete"],
    criteria_history: [{
      version: 1,
      intent: "pressure_test",
      status: "confirmed",
      success_criteria: ["Find the flaw", "Verify the evidence"],
      successful_outcomes: ["review_complete"],
      change_reason: "Poster confirmed the canonical pressure-test criteria.",
    }],
    reward_posture: {
      basis: "poster_confirmed_impact",
      funding_state: "declarative_only",
      eligible_impact_tiers: ["signal", "useful", "material", "decisive"],
      completion_bonus: "not_applicable",
    },
  };
}

function protocolRequest(body: unknown, path = "/api/agent/feed"): Request {
  return new Request(`http://test.local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function pairAgent(service: PairingService) {
  const key = generatePairingTestKey("agent_feed_route_key");
  const code = await service.issuePairingCode({
    ownerId: "owner-agent-feed-route",
    runtime: "hermes",
    displayName: "Route Feed Agent",
  });
  const pairing = await service.redeemPairing(pairCreateRequest({
    pairingCode: code.pairing_code,
    key,
    sentAt: now,
    ownerLabel: "Route Feed Agent",
    requestId: "req_pair_agent_feed_route",
  }), { rateLimitKey: "198.51.100.45" });
  return { key, pairing };
}

function feedRequest(input: {
  pairingId: string;
  key: ReturnType<typeof generatePairingTestKey>;
  requestId: string;
  limit?: number;
  cursor?: string;
  category?: string;
  query?: string;
  requestedModes?: ChallengeBrief["challenge_mode_requested"];
  minRewardCredits?: number;
}) {
  return agentFeedListRequestSchema.parse(signedPairingRequest({
    operation: "feed.list",
    requestId: input.requestId,
    sentAt: now,
    pairingId: input.pairingId,
    key: input.key,
    payload: {
      limit: input.limit ?? 10,
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(input.query ? { query: input.query } : {}),
      ...(input.requestedModes ? { requested_modes: input.requestedModes } : {}),
      ...(input.minRewardCredits !== undefined ? { min_reward_credits: input.minRewardCredits } : {}),
    },
  }));
}

function challengeRequest(input: {
  pairingId: string;
  key: ReturnType<typeof generatePairingTestKey>;
  requestId: string;
  challengeId: string;
}) {
  return agentChallengeGetRequestSchema.parse(signedPairingRequest({
    operation: "challenge.get",
    requestId: input.requestId,
    sentAt: now,
    pairingId: input.pairingId,
    key: input.key,
    payload: { challenge_id: input.challengeId },
  }));
}

describe("signed Agent feed route", () => {
  let pairingBackend: MemoryPairingStateBackend;
  let pairingService: PairingService;
  let telemetry: LocalTelemetryCollector;

  beforeEach(async () => {
    await resetStoreForTests();
    pairingBackend = new MemoryPairingStateBackend({}, createLocalAgentProtocolTransactionCoordinator());
    pairingService = new PairingService(pairingBackend, { clock: () => new Date(now) });
    telemetry = new LocalTelemetryCollector({ mode: "local", environment: "test", provider: "disabled" });
    setPlatformPairingServiceForTests(pairingService);
    setPlatformAgentFeedProtocolServiceForTests(new AgentFeedProtocolService({
      pairingService,
      store: { transactAgentFeedRequest, submitAgentFeedContribution },
      cursorSecret,
      telemetry: new CmaiAgentFeedTelemetrySink(telemetry, "agent-feed-route-telemetry-secret-32-byte-minimum"),
      clock: () => new Date(now),
    }));
  });

  afterEach(() => {
    setPlatformAgentFeedProtocolServiceForTests(undefined);
    setPlatformPairingServiceForTests(undefined);
  });

  it("charges the durable network bucket before reading or parsing an invalid request", async () => {
    const response = await agentFeedPost(new Request("http://test.local/api/agent/feed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "malformed_request" } });

    const state = await pairingBackend.read();
    expect(state.rateLimitBuckets).toHaveLength(1);
    expect(state.rateLimitBuckets[0]).toMatchObject({ capacityClass: "network:agent_feed", count: 1 });
  });

  it("returns a strict retryable Protocol envelope when pairing persistence is unavailable", async () => {
    const failingBackend: PairingStateBackend = {
      read: async () => { throw new Error("private database detail"); },
      transact: async () => { throw new Error("private database detail"); },
    };
    const failingPairingService = new PairingService(failingBackend, { clock: () => new Date(now) });
    setPlatformAgentFeedProtocolServiceForTests(new AgentFeedProtocolService({
      pairingService: failingPairingService,
      store: { transactAgentFeedRequest, submitAgentFeedContribution },
      cursorSecret,
      clock: () => new Date(now),
    }));

    const response = await agentFeedPost(protocolRequest({}));
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    const body = await response.json();
    expect(body).toMatchObject({
      protocol: "CMAI_AGENT_PROTOCOL_V1",
      protocol_version: "1.2",
      error: { code: "service_unavailable", retryable: true, retry_after_seconds: 1 },
    });
    expect(JSON.stringify(body)).not.toContain("private database detail");
  });

  it("keeps the legacy GET contract and adds a strict signed POST feed without private or suppressed data", async () => {
    const visible = await createChallenge({ id: "challenge_route_visible", posterId: "poster-route", visibility: "public", reward: 9, brief: brief("Visible") });
    await createChallenge({ id: "challenge_route_private", posterId: "poster-route", visibility: "private", reward: 99, brief: brief("Private") });
    const suppressed = await createChallenge({ id: "challenge_route_suppressed", posterId: "poster-route", visibility: "public", reward: 50, brief: brief("Suppressed") });
    await suppressChallenge(suppressed.id, "test suppression");
    const paired = await pairAgent(pairingService);

    const response = await agentFeedPost(protocolRequest(feedRequest({
      pairingId: paired.pairing.pairing_id,
      key: paired.key,
      requestId: "req_feed_route_visible",
    })));
    expect(response.status).toBe(200);
    const payload = await response.json() as AgentFeedListResponse;
    expect(payload).toMatchObject({ protocol: "CMAI_AGENT_PROTOCOL_V1", protocol_version: "1.2", request_id: "req_feed_route_visible" });
    expect(payload.result.challenges.map((challenge) => challenge.challenge_id)).toContain(visible.id);
    expect(JSON.stringify(payload)).not.toContain("challenge_route_private");
    expect(JSON.stringify(payload)).not.toContain("challenge_route_suppressed");
    expect(JSON.stringify(payload)).not.toContain("owner-agent-feed-route");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const legacy = await legacyAgentFeedGet(new Request("http://test.local/api/agent/feed", {
      headers: { "x-cmai-agent-id": "legacy-route-agent", "x-cmai-agent-label": "Legacy Route Agent" },
    }));
    expect(legacy.status).toBe(200);
    await expect(legacy.json()).resolves.toMatchObject({ agent: { id: "legacy-route-agent" }, challenges: expect.any(Array), answers: expect.any(Array) });
  });

  it("applies every bounded feed filter and returns an explicit empty page without echoing the query", async () => {
    await createChallenge({
      id: "challenge_route_filter_match",
      visibility: "public",
      reward: 8,
      brief: brief("Protocol reliability review"),
    });
    await createChallenge({
      id: "challenge_route_filter_other",
      visibility: "public",
      reward: 2,
      brief: {
        ...brief("Product strategy review", "product"),
        challenge_mode_requested: ["steelman"],
      },
    });
    const paired = await pairAgent(pairingService);
    const filteredResponse = await agentFeedPost(protocolRequest(feedRequest({
      pairingId: paired.pairing.pairing_id,
      key: paired.key,
      requestId: "req_feed_filters_0001",
      query: "protocol reliability",
      category: "security",
      requestedModes: ["critique"],
      minRewardCredits: 5,
    })));
    const filtered = await filteredResponse.json() as AgentFeedListResponse;
    expect(filteredResponse.status).toBe(200);
    expect(filtered.result.challenges.map((challenge) => challenge.challenge_id))
      .toEqual(["challenge_route_filter_match"]);

    const emptyResponse = await agentFeedPost(protocolRequest(feedRequest({
      pairingId: paired.pairing.pairing_id,
      key: paired.key,
      requestId: "req_feed_filters_0002",
      query: "no matching challenge phrase",
    })));
    const empty = await emptyResponse.json() as AgentFeedListResponse;
    expect(emptyResponse.status).toBe(200);
    expect(empty.result).toEqual({ challenges: [] });
    expect(JSON.stringify(empty)).not.toContain("no matching challenge phrase");
  });

  it("binds cursors to filters and a stable snapshot while rejecting tampering", async () => {
    await createChallenge({ id: "challenge_route_low", visibility: "public", reward: 1, brief: brief("Low") });
    await createChallenge({ id: "challenge_route_high", visibility: "public", reward: 10, brief: brief("High") });
    const paired = await pairAgent(pairingService);
    const firstResponse = await agentFeedPost(protocolRequest(feedRequest({
      pairingId: paired.pairing.pairing_id,
      key: paired.key,
      requestId: "req_feed_cursor_page_1",
      limit: 1,
      category: "security",
    })));
    const first = await firstResponse.json() as AgentFeedListResponse;
    expect(first.result.challenges.map((challenge) => challenge.challenge_id)).toEqual(["challenge_route_high"]);
    expect(first.result.next_cursor).toBeTruthy();

    await createChallenge({ id: "challenge_route_new", visibility: "public", reward: 100, brief: brief("New") });
    const secondResponse = await agentFeedPost(protocolRequest(feedRequest({
      pairingId: paired.pairing.pairing_id,
      key: paired.key,
      requestId: "req_feed_cursor_page_2",
      limit: 1,
      category: "security",
      cursor: first.result.next_cursor,
    })));
    const second = await secondResponse.json() as AgentFeedListResponse;
    expect(second.result.challenges.map((challenge) => challenge.challenge_id)).toEqual(["challenge_route_low"]);
    expect(JSON.stringify(second)).not.toContain("challenge_route_new");

    const rebound = await agentFeedPost(protocolRequest(feedRequest({
      pairingId: paired.pairing.pairing_id,
      key: paired.key,
      requestId: "req_feed_cursor_rebound",
      limit: 1,
      category: "different-category",
      cursor: first.result.next_cursor,
    })));
    expect(rebound.status).toBe(400);
    await expect(rebound.json()).resolves.toMatchObject({ error: { code: "cursor_invalid", retryable: false } });

    const cursor = first.result.next_cursor!;
    const tamperedCursor = `${cursor.slice(0, -1)}${cursor.endsWith("A") ? "B" : "A"}`;
    const tampered = await agentFeedPost(protocolRequest(feedRequest({
      pairingId: paired.pairing.pairing_id,
      key: paired.key,
      requestId: "req_feed_cursor_tampered",
      limit: 1,
      category: "security",
      cursor: tamperedCursor,
    })));
    expect(tampered.status).toBe(400);
    await expect(tampered.json()).resolves.toMatchObject({ error: { code: "cursor_invalid" } });
  });

  it("stores one terminal projection failure for exact replay without leaving a run grant", async () => {
    const challenge = await createChallenge({ id: "challenge:projection", visibility: "public", reward: 7, brief: brief("Projection") });
    const paired = await pairAgent(pairingService);
    setPlatformAgentFeedProtocolServiceForTests(new AgentFeedProtocolService({
      pairingService,
      store: { transactAgentFeedRequest, submitAgentFeedContribution },
      cursorSecret,
      telemetry: new CmaiAgentFeedTelemetrySink(telemetry, "agent-feed-route-telemetry-secret-32-byte-minimum"),
      clock: () => new Date(now),
      randomBytes: (size) => Buffer.alloc(size, 7),
    }));
    const envelope = challengeRequest({
      pairingId: paired.pairing.pairing_id,
      key: paired.key,
      requestId: "req_projection_rollback",
      challengeId: challenge.id,
    });

    const response = await agentFeedPost(protocolRequest(envelope));
    const responseBody = await response.json();
    expect(response.status).toBe(404);
    expect(responseBody).toMatchObject({ error: { code: "challenge_unavailable" } });

    const replay = await agentFeedPost(protocolRequest(envelope));
    expect(replay.status).toBe(404);
    await expect(replay.json()).resolves.toEqual(responseBody);
    expect(telemetry.list().filter((record) => record.event === "challenge.grant_failed")).toHaveLength(1);
    const pairingState = await pairingBackend.read();
    expect(pairingState.authorizedRequestReceipts).toHaveLength(1);
    expect(pairingState.rateLimitBuckets.find((bucket) => bucket.capacityClass === "principal:challenge.get")?.count).toBe(1);

    const runNonce = Buffer.alloc(32, 7).toString("base64url");
    const nonceHash = createHash("sha256").update(`CMAI_AGENT_RUN_NONCE_V1\0${runNonce}`, "utf8").digest("hex");
    const retried = await withAgentFeedTransaction((transaction) => transaction.issueRunGrant({
      grantId: "grant_projection_retry",
      pairingId: paired.pairing.pairing_id,
      requestId: "req_projection_retry",
      challengeId: challenge.id,
      challengeRevision: 1,
      nonceHash,
      promptVersion: "cmai-contribution-card-v1",
      maxOutputBytes: 64 * 1024,
      expiresAt: new Date(Date.parse(now) + 10 * 60_000).toISOString(),
    }), new Date(now));
    expect(retried.kind).toBe("issued");
  });

  it("mints one bounded grant for concurrent exact replays and emits telemetry once", async () => {
    const challenge = await createChallenge({ id: "challenge_route_grant", visibility: "public", reward: 7, brief: brief("Grant") });
    const paired = await pairAgent(pairingService);
    const envelope = challengeRequest({
      pairingId: paired.pairing.pairing_id,
      key: paired.key,
      requestId: "req_challenge_route_grant",
      challengeId: challenge.id,
    });
    const [leftResponse, rightResponse] = await Promise.all([
      agentFeedPost(protocolRequest(envelope)),
      agentFeedPost(protocolRequest(envelope)),
    ]);
    expect(leftResponse.status).toBe(200);
    expect(rightResponse.status).toBe(200);
    const left = await leftResponse.json() as AgentChallengeGetResponse;
    const right = await rightResponse.json() as AgentChallengeGetResponse;
    expect(right).toEqual(left);
    expect(left.result.challenge.run_grant.challenge_revision).toBe(1);
    expect(Date.parse(left.result.challenge.run_grant.expires_at) - Date.parse(left.result.challenge.run_grant.issued_at)).toBe(10 * 60_000);
    expect(left.result.challenge.run_grant.run_nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const freshResponse = await agentFeedPost(protocolRequest(challengeRequest({
      pairingId: paired.pairing.pairing_id,
      key: paired.key,
      requestId: "req_challenge_route_grant_fresh",
      challengeId: challenge.id,
    })));
    expect(freshResponse.status).toBe(200);
    const fresh = await freshResponse.json() as AgentChallengeGetResponse;
    expect(fresh.result.challenge.revision).toBe(left.result.challenge.revision);
    expect(fresh.result.challenge.run_grant.prompt_version).toBe(left.result.challenge.run_grant.prompt_version);
    expect(fresh.result.challenge.run_grant.max_output_bytes).toBe(left.result.challenge.run_grant.max_output_bytes);
    expect(fresh.result.challenge.run_grant.run_nonce).not.toBe(left.result.challenge.run_grant.run_nonce);

    const records = telemetry.list();
    expect(records.filter((record) => record.event === "challenge.grant_issued")).toHaveLength(2);
    expect(JSON.stringify(records)).not.toContain("owner-agent-feed-route");
    expect(JSON.stringify(records)).not.toContain(challenge.title);
  });

  it("accepts one signed contribution and exact-replays the durable submission receipt", async () => {
    const challenge = await createChallenge({ id: "challenge_route_submit", visibility: "public", reward: 7, brief: brief("Submit") });
    const paired = await pairAgent(pairingService);
    const grantResponse = await agentFeedPost(protocolRequest(challengeRequest({
      pairingId: paired.pairing.pairing_id,
      key: paired.key,
      requestId: "req_route_submit_grant",
      challengeId: challenge.id,
    })));
    expect(grantResponse.status).toBe(200);
    const grantEnvelope = await grantResponse.json() as AgentChallengeGetResponse;
    const grant = grantEnvelope.result.challenge.run_grant;
    const fixturePayload = structuredClone(validContributionSubmitRequestFixture.payload);
    const submission = agentContributionSubmitRequestSchema.parse(signedPairingRequest({
      operation: "contribution.submit",
      requestId: "req_route_submit_1",
      sentAt: now,
      pairingId: paired.pairing.pairing_id,
      key: paired.key,
      payload: {
        ...fixturePayload,
        challenge_id: challenge.id,
        challenge_revision: grant.challenge_revision,
        run_nonce: grant.run_nonce,
        idempotency_key: "idem_route_submit_0001",
        card: {
          ...fixturePayload.card,
          challenge_id: challenge.id,
          model_provenance: {
            ...fixturePayload.card.model_provenance,
            provider: "untrusted-card-provider",
            model: "untrusted-card-model",
          },
        },
      },
    }));

    const first = await agentContributionPost(protocolRequest(submission, "/api/agent/contribution"));
    const firstBody = await first.json();
    expect(first.status, JSON.stringify(firstBody)).toBe(201);
    expect(firstBody).toMatchObject({
      request_id: submission.request_id,
      result: {
        status: "accepted",
        replayed: false,
        trust: { tier: "paired_local_agent", provider_verified: false, remote_attestation: false },
      },
    });
    const storedContribution = await getContribution(firstBody.result.contribution_id);
    expect(storedContribution).toMatchObject({
      contributorId: "owner-agent-feed-route",
      card: {
        model_provenance: {
          source: "client_attested",
          provider: fixturePayload.audit.provider_claim,
          model: fixturePayload.audit.model_claim,
          adapter: `${fixturePayload.audit.runtime}:${fixturePayload.audit.adapter_name}@${fixturePayload.audit.adapter_version}`,
          verified: false,
          execution_authority: "user_connector",
        },
      },
    });

    const replay = await agentContributionPost(protocolRequest(submission, "/api/agent/contribution"));
    expect(replay.status).toBe(201);
    await expect(replay.json()).resolves.toMatchObject({
      result: {
        submission_id: firstBody.result.submission_id,
        contribution_id: firstBody.result.contribution_id,
        replayed: true,
      },
    });
  });

  it("commits terminal submission receipts so an exact retry replays the same denial", async () => {
    const challenge = await createChallenge({ id: "challenge_route_terminal", visibility: "public", reward: 7, brief: brief("Terminal") });
    const paired = await pairAgent(pairingService);
    const fixturePayload = structuredClone(validContributionSubmitRequestFixture.payload);
    const submission = agentContributionSubmitRequestSchema.parse(signedPairingRequest({
      operation: "contribution.submit",
      requestId: "req_route_terminal_1",
      sentAt: now,
      pairingId: paired.pairing.pairing_id,
      key: paired.key,
      payload: {
        ...fixturePayload,
        challenge_id: challenge.id,
        challenge_revision: 1,
        run_nonce: "u".repeat(43),
        idempotency_key: "idem_route_terminal_0001",
        card: { ...fixturePayload.card, challenge_id: challenge.id },
      },
    }));

    const first = await agentContributionPost(protocolRequest(submission, "/api/agent/contribution"));
    const firstBody = await first.json();
    expect(first.status).toBe(409);
    expect(firstBody).toMatchObject({ request_id: submission.request_id, error: { code: "run_nonce_unknown", retryable: false } });
    const afterFirst = await pairingBackend.read();
    expect(afterFirst.authorizedRequestReceipts.filter((receipt) => receipt.requestId === submission.request_id)).toHaveLength(1);

    const replay = await agentContributionPost(protocolRequest(submission, "/api/agent/contribution"));
    const replayBody = await replay.json();
    expect(replay.status).toBe(first.status);
    expect(replayBody).toMatchObject({ request_id: submission.request_id, error: firstBody.error });
    const afterReplay = await pairingBackend.read();
    expect(afterReplay.authorizedRequestReceipts.filter((receipt) => receipt.requestId === submission.request_id)).toHaveLength(1);
  });

  it("fails closed on tampered signatures, revoked pairings, missing scope, and oversized bodies", async () => {
    await createChallenge({ id: "challenge_route_denied", visibility: "public", reward: 7, brief: brief("Denied") });
    const paired = await pairAgent(pairingService);
    const original = feedRequest({ pairingId: paired.pairing.pairing_id, key: paired.key, requestId: "req_feed_bad_signature" });
    const tampered = { ...original, payload: { ...original.payload, limit: 1 } };
    const signatureResponse = await agentFeedPost(protocolRequest(tampered));
    expect(signatureResponse.status).toBe(401);
    await expect(signatureResponse.json()).resolves.toMatchObject({ error: { code: "signature_invalid" } });

    await pairingBackend.transact((state) => {
      const pairing = state.pairings.find((candidate) => candidate.pairingId === paired.pairing.pairing_id);
      if (pairing) pairing.grantedScopes = ["challenge:read"];
    });
    const noScope = await agentFeedPost(protocolRequest(challengeRequest({
      pairingId: paired.pairing.pairing_id,
      key: paired.key,
      requestId: "req_challenge_missing_scope",
      challengeId: "challenge_route_denied",
    })));
    expect(noScope.status).toBe(403);
    await expect(noScope.json()).resolves.toMatchObject({ error: { code: "scope_unauthorized" } });

    await pairingService.revokeByOwner({
      ownerId: "owner-agent-feed-route",
      pairingId: paired.pairing.pairing_id,
      reason: "user_requested",
    });
    const revoked = await agentFeedPost(protocolRequest(feedRequest({
      pairingId: paired.pairing.pairing_id,
      key: paired.key,
      requestId: "req_feed_revoked_pairing",
    })));
    expect(revoked.status).toBe(401);
    await expect(revoked.json()).resolves.toMatchObject({ error: { code: "pairing_revoked" } });

    const futureField = await agentFeedPost(protocolRequest({
      ...original,
      request_id: "req_feed_future_field_0001",
      future_field: true,
    }));
    expect(futureField.status).toBe(400);
    await expect(futureField.json()).resolves.toMatchObject({
      protocol: "CMAI_AGENT_PROTOCOL_V1",
      protocol_version: "1.2",
      request_id: "req_feed_future_field_0001",
      error: { code: "malformed_request" },
    });

    const unsupportedUnknownOperation = await agentFeedPost(protocolRequest({
      ...original,
      protocol_version: "9.0",
      operation: "future.operation",
      request_id: "req_feed_future_operation_0001",
    }));
    expect(unsupportedUnknownOperation.status).toBe(400);
    await expect(unsupportedUnknownOperation.json()).resolves.toMatchObject({
      protocol: "CMAI_AGENT_PROTOCOL_V1",
      protocol_version: "1.2",
      request_id: "req_feed_future_operation_0001",
      error: { code: "unsupported_protocol_version", supported_versions: ["1.2"] },
    });

    const credentialField = await agentFeedPost(protocolRequest({
      ...original,
      request_id: "req_feed_credential_field_0001",
      payload: { ...original.payload, nested: { api_key: "not-a-real-test-secret" } },
    }));
    expect(credentialField.status).toBe(422);
    await expect(credentialField.json()).resolves.toMatchObject({
      protocol: "CMAI_AGENT_PROTOCOL_V1",
      protocol_version: "1.2",
      request_id: "req_feed_credential_field_0001",
      error: { code: "credential_field_forbidden" },
    });

    const oversized = await agentFeedPost(new Request("http://test.local/api/agent/feed", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "9000" },
      body: "{}",
    }));
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ error: { code: "body_too_large" } });
  });
});
