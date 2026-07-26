import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CMAI_AGENT_PROTOCOL, CMAI_AGENT_PROTOCOL_VERSION } from "../../../lib/agent-protocol/constants";
import {
  fixtureRunNonce,
  fixtureSignature,
  fixtureTimestamp,
  validChallengeGetResponseFixture,
  validContributionCardV1,
  validContributionSubmitResponseFixture,
  validFeedListResponseFixture,
  validPairCreateResponseFixture,
  validPairingMutationResponseFixture,
} from "../../../lib/agent-protocol/fixtures";
import { agentProtocolErrorCodes } from "../../../lib/agent-protocol/errors";
import { findCredentialShapedFields } from "../../../lib/agent-protocol/credentials";
import type { AgentPairCreateRequest } from "../../../lib/agent-protocol/schemas";
import { CmaiAgentClient } from "./client";
import {
  CmaiAgentClientError,
  cmaiAgentClientErrorCodes,
  protocolRecoveryByCode,
} from "./errors";
import { ScriptedCmaiAgentTransport, StaticCmaiAgentRuntimeAdapter } from "./fakes";
import { CMAI_AGENT_CLIENT_VERSION } from "./index";
import type {
  CmaiAgentRuntimeIdentity,
  CmaiAgentSigner,
  CmaiAgentTransportRequest,
  CmaiAgentTransportResponse,
} from "./types";

const identity: CmaiAgentRuntimeIdentity = {
  runtime: "hermes",
  runtimeVersion: "0.13.0",
  adapterName: "cmai-hermes",
  adapterVersion: "1.0.0",
};

const signer: CmaiAgentSigner = {
  keyId: "key_1",
  async sign() {
    return fixtureSignature;
  },
};

const pairPayload: AgentPairCreateRequest["payload"] = {
  pairing_code: "PAIR-123456",
  device: {
    device_id: "device_1",
    display_name: "Local Agent",
    runtime: "hermes",
    runtime_version: "0.13.0",
    adapter_name: "cmai-hermes",
    adapter_version: "1.0.0",
  },
  public_key: {
    algorithm: "ed25519",
    key_id: "key_1",
    generation: 1,
    value: "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo",
  },
  requested_scopes: ["challenge:read", "challenge:run", "contribution:submit", "pairing:manage"],
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function requestIds() {
  let count = 0;
  return (operation: string) => `req_${operation.replaceAll(".", "_")}_${++count}`;
}

function responseFor(request: CmaiAgentTransportRequest, fixture: Record<string, unknown>): CmaiAgentTransportResponse {
  return {
    status: 200,
    body: { ...cloneJson(fixture), request_id: request.envelope.request_id },
  };
}

function pairStep(request: CmaiAgentTransportRequest) {
  return responseFor(request, validPairCreateResponseFixture);
}

function challengeStep(request: CmaiAgentTransportRequest, nonce = fixtureRunNonce) {
  const fixture = cloneJson(validChallengeGetResponseFixture) as Record<string, any>;
  fixture.result.challenge.run_grant.run_nonce = nonce;
  return responseFor(request, fixture);
}

function submitStep(request: CmaiAgentTransportRequest, replayed = false) {
  const fixture = cloneJson(validContributionSubmitResponseFixture) as Record<string, any>;
  fixture.result.replayed = replayed;
  return responseFor(request, fixture);
}

function revokedPairingStep(request: CmaiAgentTransportRequest) {
  const pairing = cloneJson(validPairCreateResponseFixture.result.pairing) as Record<string, any>;
  pairing.status = "revoked";
  pairing.revoked_at = "2026-07-14T12:02:00.000Z";
  pairing.updated_at = "2026-07-14T12:02:00.000Z";
  pairing.keys = pairing.keys.map((key: Record<string, unknown>) => ({
    ...key,
    status: "revoked",
    revoked_at: "2026-07-14T12:02:00.000Z",
  }));
  return responseFor(request, {
    protocol: "CMAI_AGENT_PROTOCOL_V1",
    protocol_version: "1.2",
    server_time: "2026-07-14T12:02:00.000Z",
    result: { pairing },
  });
}

function runtimeResult(card: unknown = validContributionCardV1) {
  return {
    identity,
    localRunId: "local_run_1",
    card,
    providerClaim: "runtime-reported-provider",
    modelClaim: "runtime-reported-model",
    modelDisplayNameClaim: "Runtime model",
    startedAt: fixtureTimestamp,
    completedAt: "2026-07-14T12:00:05.000Z",
    structuredOutputValidated: true as const,
  };
}

function createClient(transport: ScriptedCmaiAgentTransport, now?: () => Date, timeoutMs = 100) {
  return new CmaiAgentClient({
    transport,
    timeoutMs,
    now: now ?? (() => new Date("2026-07-14T12:01:00.000Z")),
    requestId: requestIds(),
  });
}

async function pairClient(client: CmaiAgentClient, transport: ScriptedCmaiAgentTransport) {
  transport.enqueue("pair.create", pairStep);
  await client.pair(pairPayload, signer);
}

async function preparePreview(client: CmaiAgentClient, transport: ScriptedCmaiAgentTransport, card: unknown = validContributionCardV1) {
  transport.enqueue("challenge.get", (request) => challengeStep(request));
  await client.fetchChallenge("challenge_protocol_1");
  const fakeRuntime = new StaticCmaiAgentRuntimeAdapter(identity, runtimeResult(card));
  const result = await fakeRuntime.execute(client.prepareRun(), {});
  client.preview(result, { userApprovedRun: true });
  return fakeRuntime;
}

function expectClientError(error: unknown, code: string): CmaiAgentClientError {
  expect(error).toBeInstanceOf(CmaiAgentClientError);
  expect(error).toMatchObject({ code });
  return error as CmaiAgentClientError;
}

describe("runtime-neutral CMAI Agent client", () => {
  it("exports a versioned source package and complete stable error map", () => {
    expect(CMAI_AGENT_CLIENT_VERSION).toBe("0.1.0");
    expect(new Set(cmaiAgentClientErrorCodes).size).toBe(cmaiAgentClientErrorCodes.length);
    expect(Object.keys(protocolRecoveryByCode).sort()).toEqual([...agentProtocolErrorCodes].sort());
  });

  it("pins the shared-client README to the executable Agent Protocol version", () => {
    const readme = readFileSync(resolve(process.cwd(), "packages/cmai-agent-client/README.md"), "utf8");
    expect(readme).toContain(`Protocol: \`${CMAI_AGENT_PROTOCOL}\` / \`${CMAI_AGENT_PROTOCOL_VERSION}\``);
  });

  it("runs pair, feed, challenge fetch, local status, and revoke through one typed transport", async () => {
    const transport = new ScriptedCmaiAgentTransport();
    const client = createClient(transport);
    await pairClient(client, transport);

    transport.enqueue("feed.list", (request) => responseFor(request, validFeedListResponseFixture));
    const feed = await client.feed({ limit: 20, requested_modes: ["critique"] });
    expect(feed.challenges).toHaveLength(1);

    transport.enqueue("challenge.get", (request) => challengeStep(request));
    const challenge = await client.fetchChallenge("challenge_protocol_1");
    expect(challenge.run_grant.run_nonce).toBe(fixtureRunNonce);
    expect(challenge.challenge_semantics).toEqual({
      challenge_semantics_version: "1.0",
      challenge_intent: "pressure_test",
      criteria_status: "confirmed",
      criteria_version: 1,
      successful_outcomes: ["review_complete"],
      privacy_sensitivity: "public_ok",
      reward_posture: {
        basis: "poster_confirmed_impact",
        funding_state: "declarative_only",
        eligible_impact_tiers: ["signal", "useful", "material", "decisive"],
        completion_bonus: "not_applicable",
      },
    });
    expect(client.status()).toMatchObject({
      phase: "challenge_ready",
      pairing: { pairing_id: "pairing_1", status: "active" },
      challenge: { challengeId: "challenge_protocol_1", revision: 1 },
    });

    transport.enqueue("pairing.revoke", revokedPairingStep);
    await client.revoke({ revoke: "pairing", reason: "user_requested" });
    expect(client.status()).toMatchObject({ phase: "revoked", pairing: { status: "revoked" } });
    expect(transport.requests.map((request) => request.operation)).toEqual([
      "pair.create",
      "feed.list",
      "challenge.get",
      "pairing.revoke",
    ]);
    for (const request of transport.requests) {
      expect(findCredentialShapedFields(request.envelope)).toEqual([]);
    }
  });

  it("keeps the runtime adapter seam neutral across the launch runtime enum", async () => {
    const transport = new ScriptedCmaiAgentTransport();
    const client = createClient(transport);
    const openClawPayload = cloneJson(pairPayload);
    openClawPayload.device.runtime = "openclaw";
    openClawPayload.device.adapter_name = "cmai-openclaw";
    transport.enqueue("pair.create", pairStep);
    await client.pair(openClawPayload, signer);

    transport.enqueue("challenge.get", (request) => challengeStep(request));
    await client.fetchChallenge("challenge_protocol_1");
    const openClawIdentity: CmaiAgentRuntimeIdentity = {
      runtime: "openclaw",
      runtimeVersion: "2026.7.0",
      adapterName: "cmai-openclaw",
      adapterVersion: "1.0.0",
    };
    const fakeRuntime = new StaticCmaiAgentRuntimeAdapter(openClawIdentity, runtimeResult());
    const result = await fakeRuntime.execute(client.prepareRun(), {});
    expect(client.preview(result, { userApprovedRun: true }).model_provenance).toMatchObject({
      source: "client_attested",
      adapter: "openclaw:cmai-openclaw@1.0.0",
    });
  });

  it("rotates to the server-confirmed active signer before later requests", async () => {
    const transport = new ScriptedCmaiAgentTransport();
    const client = createClient(transport);
    await pairClient(client, transport);
    const replacementSigner: CmaiAgentSigner = {
      keyId: "key_2",
      async sign() {
        return fixtureSignature;
      },
    };
    transport.enqueue("pairing.rotate_key", (request) => responseFor(request, validPairingMutationResponseFixture));
    await client.rotateKey({
      replaces_key_id: "key_1",
      new_public_key: {
        algorithm: "ed25519",
        key_id: "key_2",
        generation: 2,
        value: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
      },
    }, replacementSigner);

    transport.enqueue("feed.list", (request) => responseFor(request, validFeedListResponseFixture));
    await client.feed({ limit: 10 });
    expect(transport.requestsFor("feed.list")[0].auth.key_id).toBe("key_2");
  });

  it("normalizes privileged provenance, records edits, and submits only after explicit preview approval", async () => {
    const transport = new ScriptedCmaiAgentTransport();
    const client = createClient(transport);
    await pairClient(client, transport);

    const privileged = cloneJson(validContributionCardV1) as Record<string, any>;
    privileged.model_provenance = {
      ...privileged.model_provenance,
      source: "provider_signed",
      verified: true,
      provider_model_verified: true,
      receipt_id: "fake_receipt",
      provider_response_id: "fake_response",
      execution_authority: "provider",
    };
    const fakeRuntime = await preparePreview(client, transport, privileged);
    expect(fakeRuntime.calls).toHaveLength(1);
    expect(client.status().preview?.card.model_provenance).toMatchObject({
      source: "client_attested",
      verified: false,
      provider_model_verified: false,
      evidence_type: "client_manifest",
      verification_status: "attested",
      execution_authority: "user_connector",
    });
    expect(client.status().preview?.card.model_provenance).not.toHaveProperty("receipt_id");
    expect(client.status().preview?.card.model_provenance).not.toHaveProperty("provider_response_id");
    expect(client.status().preview?.card.model_provenance?.verification_notes).toContain("adapter produced this schema-valid card");
    expect(client.status().preview?.card.model_provenance?.verification_notes).not.toContain("submitted");

    const edited = cloneJson(client.status().preview?.card) as Record<string, any>;
    edited.verdict = "The edited verdict remains unverified local attribution.";
    client.editPreview(edited);
    expect(client.status()).toMatchObject({ phase: "preview", preview: { editedAfterRun: true } });

    transport.enqueue("contribution.submit", (request) => submitStep(request));
    const result = await client.submit({
      idempotencyKey: "idem_client_submit_0001",
      consent: { userApprovedSubmit: true },
    });
    expect(result).toMatchObject({ status: "accepted", replayed: false });
    expect(client.status()).toMatchObject({ phase: "submitted", submission: { contribution_id: "contribution_1" } });

    const request = transport.requestsFor("contribution.submit")[0];
    expect(request.payload.audit).toMatchObject({
      user_approved_run: true,
      user_approved_submit: true,
      edited_after_run: true,
    });
    expect(request.payload.card.model_provenance?.verification_notes).toContain("adapter produced this schema-valid card");
    expect(request.payload.provenance_claim).toEqual({
      tier: "paired_local_agent",
      model_identity: "runtime_reported_unverified",
      provider_verified: false,
      remote_attestation: false,
    });
  });

  it("restores a validated preview into a fresh paired client for separate submission", async () => {
    const firstTransport = new ScriptedCmaiAgentTransport();
    const firstClient = createClient(firstTransport);
    await pairClient(firstClient, firstTransport);
    firstTransport.enqueue("challenge.get", (request) => challengeStep(request));
    const challenge = await firstClient.fetchChallenge("challenge_protocol_1");
    const result = runtimeResult();
    const card = firstClient.preview(result, { userApprovedRun: true });

    const restoredTransport = new ScriptedCmaiAgentTransport();
    const restoredClient = createClient(restoredTransport);
    await pairClient(restoredClient, restoredTransport);
    const restored = restoredClient.restorePreview({ challenge, result: { ...result, card } });

    expect(restored).toEqual(card);
    expect(restoredClient.status()).toMatchObject({ phase: "preview", preview: { editedAfterRun: false, card } });
    restoredTransport.enqueue("contribution.submit", (request) => submitStep(request));
    await expect(restoredClient.submit({
      idempotencyKey: "idem_restored_preview_0001",
      consent: { userApprovedSubmit: true },
    })).resolves.toMatchObject({ status: "accepted" });
  });

  it("rejects secret-shaped and unknown trust fields before transport", async () => {
    const transport = new ScriptedCmaiAgentTransport();
    const client = createClient(transport);
    await pairClient(client, transport);

    transport.enqueue("challenge.get", (request) => challengeStep(request));
    await client.fetchChallenge("challenge_protocol_1");
    const secretCard = cloneJson(validContributionCardV1) as Record<string, any>;
    secretCard.model_provenance.provider_api_key = "must-never-cross";
    expectClientError(
      (() => {
        try {
          client.preview(runtimeResult(secretCard), { userApprovedRun: true });
        } catch (error) {
          return error;
        }
      })(),
      "credential_field_forbidden",
    );

    const unknownTrustCard = cloneJson(validContributionCardV1) as Record<string, any>;
    unknownTrustCard.fully_trusted = true;
    expectClientError(
      (() => {
        try {
          client.preview(runtimeResult(unknownTrustCard), { userApprovedRun: true });
        } catch (error) {
          return error;
        }
      })(),
      "contribution_card_malformed",
    );
    expect(transport.requestsFor("contribution.submit")).toHaveLength(0);
  });

  it("discards preview data and requires a fresh nonce before rerun", async () => {
    const transport = new ScriptedCmaiAgentTransport();
    const client = createClient(transport);
    await pairClient(client, transport);
    await preparePreview(client, transport);

    client.discardPreview();
    expect(client.status()).toMatchObject({ phase: "discarded" });
    expect(client.status().preview).toBeUndefined();

    const freshNonce = "r".repeat(43);
    transport.enqueue("challenge.get", (request) => challengeStep(request, freshNonce));
    const challenge = await client.refreshForRerun();
    expect(challenge.run_grant.run_nonce).toBe(freshNonce);
    expect(client.prepareRun().challenge.run_grant.run_nonce).toBe(freshNonce);
  });

  it("keeps the exact payload and idempotency key across a timeout retry", async () => {
    const transport = new ScriptedCmaiAgentTransport();
    const client = createClient(transport, undefined, 10);
    await pairClient(client, transport);
    await preparePreview(client, transport);

    transport.enqueue("contribution.submit", (_request, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    transport.enqueue("contribution.submit", (request) => submitStep(request, true));

    let firstError: unknown;
    try {
      await client.submit({
        idempotencyKey: "idem_client_retry_0001",
        consent: { userApprovedSubmit: true },
      });
    } catch (error) {
      firstError = error;
    }
    expectClientError(firstError, "transport_timeout");
    expect(client.status()).toMatchObject({
      phase: "submit_failed",
      lastError: { retryable: true, recovery: "retry_same_request" },
    });

    const retry = await client.retrySubmit();
    expect(retry.replayed).toBe(true);
    const submissions = transport.requestsFor("contribution.submit");
    expect(submissions).toHaveLength(2);
    expect(submissions[1].payload).toEqual(submissions[0].payload);
    expect(submissions[1].payload.idempotency_key).toBe("idem_client_retry_0001");
    expect(submissions[1].request_id).not.toBe(submissions[0].request_id);
  });

  it("fails closed when a timed-out key is reused for a conflicting rerun body", async () => {
    const transport = new ScriptedCmaiAgentTransport();
    const client = createClient(transport, undefined, 10);
    await pairClient(client, transport);
    await preparePreview(client, transport);

    transport.enqueue("contribution.submit", (_request, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    await expect(client.submit({
      idempotencyKey: "idem_client_conflict_0001",
      consent: { userApprovedSubmit: true },
    })).rejects.toMatchObject({ code: "transport_timeout" });

    transport.enqueue("challenge.get", (request) => challengeStep(request, "s".repeat(43)));
    await client.refreshForRerun();
    const changed = cloneJson(validContributionCardV1) as Record<string, any>;
    changed.verdict = "A different canonical body after the ambiguous timeout.";
    client.preview(runtimeResult(changed), { userApprovedRun: true });

    await expect(client.submit({
      idempotencyKey: "idem_client_conflict_0001",
      consent: { userApprovedSubmit: true },
    })).rejects.toMatchObject({ code: "idempotency_conflict", retryable: false, recovery: "none" });
    expect(transport.requestsFor("contribution.submit")).toHaveLength(1);
  });

  it("scopes local idempotency bindings to the server pairing id", async () => {
    const transport = new ScriptedCmaiAgentTransport();
    const client = createClient(transport);
    await pairClient(client, transport);
    await preparePreview(client, transport);

    transport.enqueue("contribution.submit", (request) => submitStep(request));
    await client.submit({
      idempotencyKey: "idem_pairing_scoped_0001",
      consent: { userApprovedSubmit: true },
    });
    transport.enqueue("pairing.revoke", revokedPairingStep);
    await client.revoke({ revoke: "pairing", reason: "user_requested" });

    const replacementPairing = cloneJson(validPairCreateResponseFixture) as Record<string, any>;
    replacementPairing.result.pairing.pairing_id = "pairing_2";
    transport.enqueue("pair.create", (request) => responseFor(request, replacementPairing));
    await client.pair(pairPayload, signer);

    const changed = cloneJson(validContributionCardV1) as Record<string, any>;
    changed.verdict = "The same local idempotency key is valid in a new pairing scope.";
    await preparePreview(client, transport, changed);
    transport.enqueue("contribution.submit", (request) => submitStep(request));
    await expect(client.submit({
      idempotencyKey: "idem_pairing_scoped_0001",
      consent: { userApprovedSubmit: true },
    })).resolves.toMatchObject({ status: "accepted" });
    expect(transport.requestsFor("contribution.submit")).toHaveLength(2);
  });

  it("maps strict protocol errors and discards malformed response content", async () => {
    const transport = new ScriptedCmaiAgentTransport();
    const client = createClient(transport);
    await pairClient(client, transport);

    transport.enqueue("feed.list", (request) => ({
      status: 401,
      body: {
        protocol: "CMAI_AGENT_PROTOCOL_V1",
        protocol_version: "1.2",
        request_id: request.envelope.request_id,
        server_time: fixtureTimestamp,
        error: { code: "pairing_revoked", message: "Pairing has been revoked.", retryable: false },
      },
    }));
    await expect(client.feed({ limit: 10 })).rejects.toMatchObject({
      code: "pairing_revoked",
      source: "protocol",
      recovery: "re_pair",
    });

    transport.enqueue("feed.list", {
      status: 500,
      body: { raw_provider_secret: "never echo this" },
    });
    let malformed: unknown;
    try {
      await client.feed({ limit: 10 });
    } catch (error) {
      malformed = error;
    }
    const mapped = expectClientError(malformed, "transport_response_malformed");
    expect(mapped.message).not.toContain("never echo this");
    expect(mapped).toMatchObject({ retryable: true, recovery: "retry_same_request" });
  });

  it("classifies an expired local grant as fresh-fetch recovery without silent rerun", async () => {
    const transport = new ScriptedCmaiAgentTransport();
    let now = new Date("2026-07-14T12:01:00.000Z");
    const client = createClient(transport, () => now);
    await pairClient(client, transport);
    transport.enqueue("challenge.get", (request) => challengeStep(request));
    await client.fetchChallenge("challenge_protocol_1");

    now = new Date("2026-07-14T12:10:00.000Z");
    let expired: unknown;
    try {
      client.prepareRun();
    } catch (error) {
      expired = error;
    }
    expectClientError(expired, "run_nonce_expired");
    expect(client.status().lastError).toMatchObject({
      retryable: true,
      recovery: "fetch_fresh_challenge",
    });
    expect(transport.requestsFor("challenge.get")).toHaveLength(1);
  });
});
