import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentProtocolScopes } from "../../../lib/agent-protocol/constants";
import { validChallengeGetResponseFixture, validContributionCardV1, validPairingStateFixture } from "../../../lib/agent-protocol/fixtures";
import { pairedAdapterAuditMetadataSchema, pairingStateSchema } from "../../../lib/agent-protocol/schemas";
import { normalizePairedAdapterContribution } from "../../../lib/agent-protocol/provenance";
import { pairedLocalContributionCardV1Schema } from "../../../lib/validation/contributionCardProtocol";
import { createHermesPairingMaterial } from "./cryptoSigner";
import { createStoredPairingState } from "./stateStore";

const cleanup: string[] = [];
const workerPath = resolve(import.meta.dirname, "worker.ts");

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of request) raw += Buffer.from(chunk).toString("utf8");
  return JSON.parse(raw) as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function runWorker(command: string, stateDirectory: string, baseUrl: string): Promise<{ ok: boolean; code: string; text: string }> {
  const id = `cmd_${command.split(" ")[0]}`;
  const child = spawn("bun", [workerPath], {
    env: {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      NODE_ENV: "test",
      CMAI_HERMES_HOST_VERSION: "0.18.2",
      CMAI_HERMES_PROFILE_NAME: "integration-profile",
      CMAI_HERMES_STATE_DIR: stateDirectory,
      CMAI_AGENT_BASE_URL: baseUrl,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify({ id, command }));
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += Buffer.from(chunk).toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += Buffer.from(chunk).toString("utf8"); });
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  const response = JSON.parse(stdout) as { id: string; result: { ok: boolean; code: string; text: string } };
  expect(response.id).toBe(id);
  return response.result;
}

async function runInteractiveWorker(
  command: string,
  stateDirectory: string,
  baseUrl: string,
): Promise<{ result: { ok: boolean; code: string; text: string }; request?: Record<string, unknown> }> {
  const id = "cmd_confirmed_run";
  const child = spawn("bun", [workerPath], {
    env: {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      NODE_ENV: "test",
      CMAI_HERMES_HOST_VERSION: "0.18.2",
      CMAI_HERMES_PROFILE_NAME: "integration-profile",
      CMAI_HERMES_STATE_DIR: stateDirectory,
      CMAI_AGENT_BASE_URL: baseUrl,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += Buffer.from(chunk).toString("utf8"); });
  const exitPromise = new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  child.stdin.write(`${JSON.stringify({ id, command })}\n`);

  const first = await iterator.next();
  expect(first.done).toBe(false);
  const firstFrame = JSON.parse(String(first.value)) as {
    id: string;
    event?: string;
    request?: Record<string, unknown>;
    result?: { ok: boolean; code: string; text: string };
  };
  let final: { id: string; result: { ok: boolean; code: string; text: string } };
  let inferenceRequest: Record<string, unknown> | undefined;
  if (firstFrame.result) {
    child.stdin.end();
    final = { id: firstFrame.id, result: firstFrame.result };
  } else {
    expect(firstFrame).toMatchObject({ id, event: "inference_request" });
    inferenceRequest = firstFrame.request;
    child.stdin.end(`${JSON.stringify({
      id,
      event: "inference_result",
      result: {
        parsed: validContributionCardV1,
        provider: "fake-host-provider",
        model: "fake-host-model",
        modelDisplayName: "Fake host model",
      },
    })}\n`);
    const second = await iterator.next();
    expect(second.done).toBe(false);
    final = JSON.parse(String(second.value)) as { id: string; result: { ok: boolean; code: string; text: string } };
  }
  const exitCode = await exitPromise;
  lines.close();
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(final.id).toBe(id);
  return { result: final.result, ...(inferenceRequest ? { request: inferenceRequest } : {}) };
}

async function startPausedInteractiveWorker(
  command: string,
  stateDirectory: string,
  baseUrl: string,
): Promise<{
  request: Record<string, unknown>;
  finish: () => Promise<{ ok: boolean; code: string; text: string }>;
}> {
  const id = "cmd_paused_confirmed_run";
  const child = spawn("bun", [workerPath], {
    env: {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      NODE_ENV: "test",
      CMAI_HERMES_HOST_VERSION: "0.18.2",
      CMAI_HERMES_PROFILE_NAME: "integration-profile",
      CMAI_HERMES_STATE_DIR: stateDirectory,
      CMAI_AGENT_BASE_URL: baseUrl,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += Buffer.from(chunk).toString("utf8"); });
  const exitPromise = new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const iterator = lines[Symbol.asyncIterator]();
  child.stdin.write(`${JSON.stringify({ id, command })}\n`);
  const first = await iterator.next();
  expect(first.done).toBe(false);
  const frame = JSON.parse(String(first.value)) as { id: string; event?: string; request?: Record<string, unknown> };
  expect(frame).toMatchObject({ id, event: "inference_request" });
  if (!frame.request) throw new Error("Paused worker did not emit an inference request.");

  return {
    request: frame.request,
    finish: async () => {
      child.stdin.end(`${JSON.stringify({
        id,
        event: "inference_result",
        result: {
          parsed: validContributionCardV1,
          provider: "fake-host-provider",
          model: "fake-host-model",
          modelDisplayName: "Fake host model",
        },
      })}\n`);
      const second = await iterator.next();
      expect(second.done).toBe(false);
      const final = JSON.parse(String(second.value)) as { id: string; result: { ok: boolean; code: string; text: string } };
      expect(await exitPromise).toBe(0);
      lines.close();
      expect(stderr).toBe("");
      expect(final.id).toBe(id);
      return final.result;
    },
  };
}

describe("CMAI Hermes one-command worker lifecycle", () => {
  it("boots and restores a durable schema-v2 legacy preview after neutral-provenance migration", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-hermes-worker-preview-migration-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-hermes");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const material = createHermesPairingMaterial({ pairingCode: "PAIR-123456", displayName: "Legacy Worker", runtimeVersion: "0.18.2" });
    const current = createStoredPairingState({
      device: material.payload.device,
      publicKey: material.payload.public_key,
      requestedScopes: material.payload.requested_scopes,
      pairingState: pairingStateSchema.parse({
        ...validPairingStateFixture,
        pairing_id: "pairing_legacy_worker",
        device_id: material.payload.device.device_id,
        status: "active",
        granted_scopes: material.payload.requested_scopes,
        keys: [{ key_id: material.payload.public_key.key_id, generation: 1, status: "active", activated_at: validChallengeGetResponseFixture.server_time }],
        created_at: validChallengeGetResponseFixture.server_time,
        updated_at: validChallengeGetResponseFixture.server_time,
      }),
      signingKeyPkcs8: material.persistence.signingKeyPkcs8,
    });
    const challenge = validChallengeGetResponseFixture.result.challenge;
    const legacyAudit = pairedAdapterAuditMetadataSchema.parse({
      runtime: "hermes",
      runtime_version: "0.18.2",
      adapter_name: "cmai-hermes",
      adapter_version: "0.1.0",
      local_run_id: "run_legacy_worker_preview",
      provider_claim: "legacy-provider",
      model_claim: "legacy-provider/legacy-model",
      started_at: challenge.run_grant.issued_at,
      completed_at: challenge.run_grant.issued_at,
      structured_output_validated: true,
      user_approved_run: true,
      edited_after_run: false,
      user_approved_submit: true,
    });
    const statePath = join(stateDirectory, "state.json");
    await writeFile(statePath, `${JSON.stringify({
      ...current,
      schema_version: 2,
      pairing: {
        ...current.pairing!,
        requested_scopes: [...agentProtocolScopes],
        pairing_state: { ...current.pairing!.pairing_state, granted_scopes: [...agentProtocolScopes] },
      },
      preview: {
        challenge,
        result: {
          identity: { runtime: "hermes", runtimeVersion: "0.18.2", adapterName: "cmai-hermes", adapterVersion: "0.1.0" },
          localRunId: "run_legacy_worker_preview",
          card: normalizePairedAdapterContribution(pairedLocalContributionCardV1Schema.parse(validContributionCardV1), legacyAudit),
          providerClaim: "legacy-provider",
          modelClaim: "legacy-provider/legacy-model",
          startedAt: challenge.run_grant.issued_at,
          completedAt: challenge.run_grant.issued_at,
          structuredOutputValidated: true,
        },
        idempotency_key: "idem_legacy_worker_preview_0001",
        persisted_at: challenge.run_grant.issued_at,
      },
    })}\n`, { mode: 0o600 });

    const status = await runWorker("status", stateDirectory, "http://127.0.0.1:9");
    expect(status).toMatchObject({ ok: true, code: "status" });
    expect(status.text).toContain("signing key was removed from adapter state");
    const rewrittenRaw = await readFile(statePath, "utf8");
    expect(rewrittenRaw).not.toContain("signing_key_pkcs8");
    expect(rewrittenRaw).not.toContain("contribution:submit");
    const rewritten = JSON.parse(rewrittenRaw) as { schema_version: number; preview: { preview_id: string; result: { card: { model_provenance?: { verification_notes?: string } } } } };
    expect(rewritten.schema_version).toBe(6);
    expect(rewritten.preview.preview_id).toMatch(/^preview_/);
    expect(rewritten.preview).not.toHaveProperty("idempotency_key");
    expect(rewritten.preview.result.card.model_provenance?.verification_notes).toContain("adapter produced this schema-valid card");
    await expect(runWorker("preview", stateDirectory, "http://127.0.0.1:9")).resolves.toMatchObject({ ok: true, code: "preview" });
    await expect(runWorker("pair PAIR-NEW", stateDirectory, "http://127.0.0.1:9")).resolves.toMatchObject({ ok: false, code: "retired_preview_pending" });
    await expect(runWorker("discard", stateDirectory, "http://127.0.0.1:9")).resolves.toMatchObject({ ok: true, code: "discarded" });
    await expect(lstat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("pairs, restores without polling, revokes, and removes local state", async () => {
    const operations: string[] = [];
    const server = createServer(async (request, response) => {
      const envelope = await jsonBody(request);
      operations.push(String(envelope.operation));
      const payload = envelope.payload as Record<string, unknown>;
      const now = new Date().toISOString();
      if (request.url === "/api/agent/pair") {
        const device = payload.device as Record<string, unknown>;
        const publicKey = payload.public_key as Record<string, unknown>;
        sendJson(response, 201, {
          protocol: "CMAI_AGENT_PROTOCOL_V1",
          protocol_version: "1.2",
          request_id: envelope.request_id,
          server_time: now,
          result: {
            pairing: {
              pairing_id: "pairing_local_worker_test",
              device_id: device.device_id,
              status: "active",
              granted_scopes: payload.requested_scopes,
              keys: [{ key_id: publicKey.key_id, generation: 1, status: "active", activated_at: now }],
              created_at: now,
              updated_at: now,
            },
          },
        });
        return;
      }
      if (request.url === "/api/agent/revoke") {
        const auth = envelope.auth as Record<string, unknown>;
        sendJson(response, 200, {
          protocol: "CMAI_AGENT_PROTOCOL_V1",
          protocol_version: "1.2",
          request_id: envelope.request_id,
          server_time: now,
          result: {
            pairing: {
              pairing_id: auth.pairing_id,
              device_id: "device_revoked",
              status: "revoked",
              granted_scopes: ["challenge:read", "challenge:run", "contribution:submit", "pairing:manage"],
              keys: [{ key_id: auth.key_id, generation: 1, status: "revoked", activated_at: now, revoked_at: now }],
              created_at: now,
              updated_at: now,
              revoked_at: now,
            },
          },
        });
        return;
      }
      sendJson(response, 404, { error: "unexpected local test route" });
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local test server did not bind TCP.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const root = await mkdtemp(join(tmpdir(), "cmai-hermes-worker-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-hermes");

    try {
      const paired = await runWorker("pair PAIR-123456 Worker Test", stateDirectory, baseUrl);
      expect(paired).toMatchObject({ ok: true, code: "paired" });
      expect(operations).toEqual(["pair.create"]);

      const status = await runWorker("status", stateDirectory, baseUrl);
      expect(status.text).toContain("Paired locally");
      expect(operations).toEqual(["pair.create"]);

      const revoked = await runWorker("revoke confirm", stateDirectory, baseUrl);
      expect(revoked).toMatchObject({ ok: true, code: "revoked" });
      expect(operations).toEqual(["pair.create", "pairing.revoke"]);
      await expect(import("node:fs/promises").then(({ lstat }) => lstat(join(stateDirectory, "state.json")))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });

  it("persists preparation across workers and consumes it before one fake host inference", async () => {
    const operations: string[] = [];
    let challengeGets = 0;
    const runNow = new Date();
    const runNowIso = runNow.toISOString();
    const runExpiresIso = new Date(runNow.getTime() + 10 * 60_000).toISOString();
    const server = createServer(async (request, response) => {
      const envelope = await jsonBody(request);
      operations.push(String(envelope.operation));
      const payload = envelope.payload as Record<string, unknown>;
      if (request.url === "/api/agent/pair") {
        const device = payload.device as Record<string, unknown>;
        const publicKey = payload.public_key as Record<string, unknown>;
        sendJson(response, 201, {
          protocol: "CMAI_AGENT_PROTOCOL_V1",
          protocol_version: "1.2",
          request_id: envelope.request_id,
          server_time: runNowIso,
          result: {
            pairing: {
              pairing_id: "pairing_bounded_run_test",
              device_id: device.device_id,
              status: "active",
              granted_scopes: payload.requested_scopes,
              keys: [{ key_id: publicKey.key_id, generation: 1, status: "active", activated_at: runNowIso }],
              created_at: runNowIso,
              updated_at: runNowIso,
            },
          },
        });
        return;
      }
      if (request.url === "/api/agent/feed") {
        challengeGets += 1;
        const originalChallenge = structuredClone(validChallengeGetResponseFixture.result.challenge);
        const challenge = {
          ...originalChallenge,
          run_grant: {
            ...originalChallenge.run_grant,
            run_nonce: challengeGets === 1 ? originalChallenge.run_grant.run_nonce : "z".repeat(43),
            issued_at: runNowIso,
            expires_at: runExpiresIso,
          },
        };
        sendJson(response, 200, {
          ...structuredClone(validChallengeGetResponseFixture),
          request_id: envelope.request_id,
          server_time: runNowIso,
          result: { challenge },
        });
        return;
      }

      sendJson(response, 404, { error: "unexpected local test route" });
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local test server did not bind TCP.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const root = await mkdtemp(join(tmpdir(), "cmai-hermes-worker-run-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-hermes");

    try {
      expect(await runWorker("pair PAIR-123456 Worker Run", stateDirectory, baseUrl)).toMatchObject({ ok: true, code: "paired" });
      const prepared = await runWorker("run challenge_protocol_1", stateDirectory, baseUrl);
      expect(prepared.code).toBe("run_confirmation_required");
      expect(operations).toEqual(["pair.create", "challenge.get"]);
      const preparedState = await readFile(join(stateDirectory, "state.json"), "utf8");
      expect(preparedState).toContain('"pending_run"');
      expect(preparedState).not.toContain("What is the minimum stable protocol?");

      const confirmed = await runInteractiveWorker("run challenge_protocol_1 confirm 1", stateDirectory, baseUrl);
      expect(confirmed.result).toMatchObject({ ok: true, code: "run_preview_ready" });
      const inferenceRequest = confirmed.request;
      if (!inferenceRequest) throw new Error("Confirmed run did not emit one inference request.");
      expect(inferenceRequest).toMatchObject({
        purpose: "cmai_challenge_contribution",
        maxTokens: 4096,
        timeoutSeconds: 45,
      });
      expect(Object.keys(inferenceRequest)).not.toContain("provider");
      expect(Object.keys(inferenceRequest)).not.toContain("model");
      const boundedInput = JSON.parse(String(inferenceRequest.inputText)) as { challenge: { run_grant: { run_nonce: string } } };
      expect(boundedInput.challenge.run_grant.run_nonce).toBe(validChallengeGetResponseFixture.result.challenge.run_grant.run_nonce);
      expect(boundedInput.challenge.run_grant.run_nonce).not.toBe("z".repeat(43));
      expect(operations).toEqual(["pair.create", "challenge.get", "challenge.get"]);
      const consumedState = await readFile(join(stateDirectory, "state.json"), "utf8");
      expect(consumedState).not.toContain('"pending_run"');
      expect(consumedState).toContain('"preview"');
      expect((await runWorker("preview", stateDirectory, baseUrl)).code).toBe("preview");
      const reservedSubmit = await runWorker("submit confirm", stateDirectory, baseUrl);
      expect(reservedSubmit).toMatchObject({ ok: false, code: "submission_unavailable" });
      expect(operations).toEqual(["pair.create", "challenge.get", "challenge.get"]);
      const previewState = await readFile(join(stateDirectory, "state.json"), "utf8");
      expect(previewState).toContain('"preview_id"');
      expect(previewState).not.toContain('"idempotency_key"');
      expect((await runWorker("discard", stateDirectory, baseUrl)).code).toBe("discarded");
      expect(await readFile(join(stateDirectory, "state.json"), "utf8")).not.toContain('"preview"');

      const repeated = await runWorker("run challenge_protocol_1 confirm 1", stateDirectory, baseUrl);
      expect(repeated.code).toBe("run_approval_missing");
      expect(operations).toEqual(["pair.create", "challenge.get", "challenge.get"]);

      expect((await runWorker("run challenge_protocol_1", stateDirectory, baseUrl)).code).toBe("run_confirmation_required");
      const contenders = await Promise.all([
        runInteractiveWorker("run challenge_protocol_1 confirm 1", stateDirectory, baseUrl),
        runInteractiveWorker("run challenge_protocol_1 confirm 1", stateDirectory, baseUrl),
      ]);
      const contenderOutcomes = contenders.map((item) => ({ requested: Boolean(item.request), code: item.result.code }));
      expect(contenders.filter((item) => item.request).length).toBe(1);
      expect(
        contenders.filter((item) => item.result.code === "run_preview_ready").length,
        JSON.stringify(contenderOutcomes),
      ).toBe(1);
      expect(contenders.filter((item) => item.result.code !== "run_preview_ready").every((item) => !item.request)).toBe(true);
      expect((await readFile(join(stateDirectory, "state.json"), "utf8"))).not.toContain('"pending_run"');
    } finally {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });

  it("blocks revoke/re-pair while old inference is live and persists only under its original pairing", async () => {
    const operations: string[] = [];
    let pairCount = 0;
    let challengeGets = 0;
    const issued = new Map<string, { deviceId: string; keyId: string }>();
    const runNow = new Date();
    const runNowIso = runNow.toISOString();
    const runExpiresIso = new Date(runNow.getTime() + 10 * 60_000).toISOString();
    const server = createServer(async (request, response) => {
      const envelope = await jsonBody(request);
      operations.push(String(envelope.operation));
      const payload = envelope.payload as Record<string, unknown>;
      if (request.url === "/api/agent/pair") {
        pairCount += 1;
        const device = payload.device as Record<string, unknown>;
        const publicKey = payload.public_key as Record<string, unknown>;
        const pairingId = `pairing_race_${pairCount}`;
        issued.set(pairingId, { deviceId: String(device.device_id), keyId: String(publicKey.key_id) });
        sendJson(response, 201, {
          protocol: "CMAI_AGENT_PROTOCOL_V1",
          protocol_version: "1.2",
          request_id: envelope.request_id,
          server_time: runNowIso,
          result: {
            pairing: {
              pairing_id: pairingId,
              device_id: device.device_id,
              status: "active",
              granted_scopes: payload.requested_scopes,
              keys: [{ key_id: publicKey.key_id, generation: 1, status: "active", activated_at: runNowIso }],
              created_at: runNowIso,
              updated_at: runNowIso,
            },
          },
        });
        return;
      }
      if (request.url === "/api/agent/feed") {
        challengeGets += 1;
        const original = structuredClone(validChallengeGetResponseFixture.result.challenge);
        sendJson(response, 200, {
          ...structuredClone(validChallengeGetResponseFixture),
          request_id: envelope.request_id,
          server_time: runNowIso,
          result: {
            challenge: {
              ...original,
              run_grant: {
                ...original.run_grant,
                run_nonce: challengeGets === 1 ? original.run_grant.run_nonce : "z".repeat(43),
                issued_at: runNowIso,
                expires_at: runExpiresIso,
              },
            },
          },
        });
        return;
      }
      if (request.url === "/api/agent/revoke") {
        const auth = envelope.auth as { pairing_id: string; key_id: string };
        const identity = issued.get(auth.pairing_id);
        sendJson(response, 200, {
          protocol: "CMAI_AGENT_PROTOCOL_V1",
          protocol_version: "1.2",
          request_id: envelope.request_id,
          server_time: runNowIso,
          result: {
            pairing: {
              pairing_id: auth.pairing_id,
              device_id: identity?.deviceId ?? "device_unknown",
              status: "revoked",
              granted_scopes: ["challenge:read", "challenge:run", "pairing:manage"],
              keys: [{
                key_id: identity?.keyId ?? auth.key_id,
                generation: 1,
                status: "revoked",
                activated_at: runNowIso,
                revoked_at: runNowIso,
              }],
              created_at: runNowIso,
              updated_at: runNowIso,
              revoked_at: runNowIso,
            },
          },
        });
        return;
      }
      sendJson(response, 404, { error: "unexpected local race test route" });
    });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Local race test server did not bind TCP.");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const root = await mkdtemp(join(tmpdir(), "cmai-hermes-worker-race-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-hermes");

    try {
      expect(await runWorker("pair PAIR-OLD Old Pairing", stateDirectory, baseUrl)).toMatchObject({ ok: true, code: "paired" });
      expect(await runWorker("run challenge_protocol_1", stateDirectory, baseUrl)).toMatchObject({ code: "run_confirmation_required" });
      const paused = await startPausedInteractiveWorker("run challenge_protocol_1 confirm 1", stateDirectory, baseUrl);
      expect(paused.request).toMatchObject({ purpose: "cmai_challenge_contribution" });
      const consumedState = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8")) as {
        pairing: { pairing_state: { pairing_id: string } };
        pending_run?: { pairing_id: string; consumed_at?: string; consumer?: { token: string } };
      };
      expect(consumedState.pairing.pairing_state.pairing_id).toBe("pairing_race_1");
      expect(consumedState.pending_run).toMatchObject({ pairing_id: "pairing_race_1", consumed_at: expect.any(String), consumer: { token: expect.any(String) } });

      const revoked = await runWorker("revoke confirm", stateDirectory, baseUrl);
      expect(revoked).toMatchObject({ ok: true, code: "revoked_recovery_preserved" });
      const rePair = await runWorker("pair PAIR-NEW New Pairing", stateDirectory, baseUrl);
      expect(rePair).toMatchObject({ ok: false, code: "client_invalid_state" });
      const preservedState = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8")) as {
        pairing: { pairing_state: { pairing_id: string } };
        pending_run?: { pairing_id: string };
      };
      expect(preservedState.pairing.pairing_state.pairing_id).toBe("pairing_race_1");
      expect(preservedState.pending_run?.pairing_id).toBe("pairing_race_1");

      expect(await paused.finish()).toMatchObject({ ok: true, code: "run_preview_ready" });
      const completedState = JSON.parse(await readFile(join(stateDirectory, "state.json"), "utf8")) as {
        pairing: { pairing_state: { pairing_id: string } };
        pending_run?: unknown;
        preview?: { preview_id: string };
      };
      expect(completedState.pairing.pairing_state.pairing_id).toBe("pairing_race_1");
      expect(completedState.pending_run).toBeUndefined();
      expect(completedState.preview?.preview_id).toMatch(/^preview_/);
      expect(operations).toEqual([
        "pair.create",
        "challenge.get",
        "challenge.get",
        "pairing.revoke",
      ]);
    } finally {
      await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
    }
  });
});
