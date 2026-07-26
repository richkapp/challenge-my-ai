import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentProtocolScopes } from "../../../lib/agent-protocol/constants";
import {
  fixtureTimestamp,
  validChallengeGetResponseFixture,
  validContributionCardV1,
  validPairingStateFixture,
} from "../../../lib/agent-protocol/fixtures";
import { pairingStateSchema } from "../../../lib/agent-protocol/schemas";
import { createOpenClawPairingMaterial, restoreOpenClawSigner } from "./cryptoSigner";
import {
  createOpenClawRunConsumer,
  createStoredPairingState,
  lockOwnerIsActive,
  openClawRunConsumerIsActive,
  OpenClawAdapterStateStore,
  type OpenClawPersistedPreview,
} from "./stateStore";
import {
  CMAI_OPENCLAW_INFERENCE_COST_ACKNOWLEDGEMENT,
  CMAI_OPENCLAW_INFERENCE_MAX_TOKENS,
  CMAI_OPENCLAW_INFERENCE_TIMEOUT_MS,
} from "./inference";

const cleanup: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function storedState(label: string) {
  const material = createOpenClawPairingMaterial({ pairingCode: "PAIR-123456", displayName: label, runtimeVersion: "2026.7.1" });
  return createStoredPairingState({
    device: material.payload.device,
    publicKey: material.payload.public_key,
    requestedScopes: material.payload.requested_scopes,
    pairingState: pairingStateSchema.parse({ ...validPairingStateFixture, granted_scopes: material.payload.requested_scopes }),
    signingKeyPkcs8: material.persistence.signingKeyPkcs8,
  });
}

function persistedPreview(previewId: string): OpenClawPersistedPreview {
  return {
    challenge: validChallengeGetResponseFixture.result.challenge,
    result: {
      identity: {
        runtime: "openclaw",
        runtimeVersion: "2026.7.1",
        adapterName: "cmai-openclaw",
        adapterVersion: "0.1.0",
      },
      localRunId: "local_run_openclaw_state_1",
      card: validContributionCardV1,
      providerClaim: "test-provider",
      modelClaim: "test-provider/test-model",
      startedAt: fixtureTimestamp,
      completedAt: fixtureTimestamp,
      structuredOutputValidated: true,
    },
    preview_id: previewId,
    persisted_at: fixtureTimestamp,
  } as unknown as OpenClawPersistedPreview;
}

function pendingRun() {
  const challenge = validChallengeGetResponseFixture.result.challenge;
  return {
    challenge_id: challenge.challenge_id,
    challenge_revision: challenge.revision,
    run_grant: challenge.run_grant,
    challenge_hash: "a".repeat(64),
    prompt_version: challenge.run_grant.prompt_version,
    agent_id: "agent-test",
    active_model: "test-provider/test-model",
    max_output_bytes: challenge.run_grant.max_output_bytes,
    max_tokens: CMAI_OPENCLAW_INFERENCE_MAX_TOKENS,
    timeout_ms: CMAI_OPENCLAW_INFERENCE_TIMEOUT_MS,
    cost_acknowledgement: CMAI_OPENCLAW_INFERENCE_COST_ACKNOWLEDGEMENT,
    prepared_at: challenge.run_grant.issued_at,
    approval_expires_at: challenge.run_grant.expires_at,
  } as const;
}

describe("OpenClaw adapter local pairing state", () => {
  it("persists strict 0600 pairing-only state and removes all adapter residue", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-openclaw-state-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-openclaw");
    await mkdir(stateDirectory, { recursive: true, mode: 0o777 });
    await chmod(stateDirectory, 0o777);
    const store = new OpenClawAdapterStateStore(stateDirectory);
    const material = createOpenClawPairingMaterial({ pairingCode: "PAIR-123456", displayName: "Test OpenClaw", runtimeVersion: "2026.7.1" });
    await store.save(createStoredPairingState({
      device: material.payload.device,
      publicKey: material.payload.public_key,
      requestedScopes: material.payload.requested_scopes,
      pairingState: pairingStateSchema.parse({ ...validPairingStateFixture, granted_scopes: material.payload.requested_scopes }),
      signingKeyPkcs8: material.persistence.signingKeyPkcs8,
    }));

    const path = join(stateDirectory, "state.json");
    expect((await lstat(stateDirectory)).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    const raw = await readFile(path, "utf8");
    expect(raw).not.toContain("PAIR-123456");
    expect(raw).not.toMatch(/prompt|response|provider|credential/i);
    const loaded = await store.load();
    expect(loaded?.pairing!.device.runtime).toBe("openclaw");
    expect(await restoreOpenClawSigner(loaded!.pairing!.public_key.key_id, loaded!.pairing!.signing_key_pkcs8).sign("bounded-test"))
      .toMatch(/^[A-Za-z0-9_-]{86}$/);
    expect(() => createStoredPairingState({
      device: material.payload.device,
      publicKey: material.payload.public_key,
      requestedScopes: [...agentProtocolScopes],
      pairingState: pairingStateSchema.parse({ ...validPairingStateFixture, granted_scopes: [...agentProtocolScopes] }),
      signingKeyPkcs8: material.persistence.signingKeyPkcs8,
    })).toThrow(/exact preview-only authority set/);
    await store.clear();
    await expect(lstat(stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically upgrades an exact schema-v2 submission-identity preview without losing pairing or preview state", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-openclaw-state-v2-upgrade-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-openclaw");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(stateDirectory, 0o700);
    const pairingOnly = storedState("Legacy v2");
    const { preview_id: _neutralIdentity, ...previewData } = persistedPreview("preview_interim_1234");
    const legacyState = {
      ...pairingOnly,
      schema_version: 2,
      preview: { ...previewData, idempotency_key: "idem_openclaw_legacy_1234" },
    };
    const statePath = join(stateDirectory, "state.json");
    await writeFile(statePath, `${JSON.stringify(legacyState)}\n`, { encoding: "utf8", mode: 0o600 });
    await chmod(statePath, 0o600);

    const loaded = await new OpenClawAdapterStateStore(stateDirectory).load();
    expect(loaded?.schema_version).toBe(5);
    expect(loaded?.pairing!.public_key.key_id).toBe(pairingOnly.pairing!.public_key.key_id);
    expect(loaded?.preview?.result.card.model_provenance?.verification_notes).toContain("adapter produced this schema-valid card");
    expect(loaded?.preview?.result.card.model_provenance?.verification_notes).not.toContain("submitted");
    expect(loaded?.preview?.preview_id).toMatch(/^preview_[A-Za-z0-9_-]+$/);
    const rewritten = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    expect(rewritten.schema_version).toBe(5);
    expect(JSON.stringify(rewritten)).not.toContain("idempotency_key");
    expect((rewritten.preview as Record<string, unknown>).preview_id).toBe(loaded?.preview?.preview_id);
  });

  it("atomically upgrades schema-v1 pairing state without changing the signing identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-openclaw-state-v1-upgrade-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-openclaw");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const current = storedState("Legacy v1");
    const legacy = { ...current, schema_version: 1 };
    const statePath = join(stateDirectory, "state.json");
    await writeFile(statePath, `${JSON.stringify(legacy)}\n`, { encoding: "utf8", mode: 0o600 });

    const loaded = await new OpenClawAdapterStateStore(stateDirectory).load();
    expect(loaded?.schema_version).toBe(5);
    expect(loaded?.pairing!.public_key.key_id).toBe(current.pairing!.public_key.key_id);
    expect(loaded?.pairing!.signing_key_pkcs8).toBe(current.pairing!.signing_key_pkcs8);
  });

  it("atomically upgrades neutral schema-v2 preview state while preserving preview identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-openclaw-state-v2-neutral-upgrade-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-openclaw");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const current = storedState("Legacy neutral v2");
    const legacy = { ...current, schema_version: 2, preview: persistedPreview("preview_neutral_legacy_1234") };
    await writeFile(join(stateDirectory, "state.json"), `${JSON.stringify(legacy)}\n`, { encoding: "utf8", mode: 0o600 });

    const loaded = await new OpenClawAdapterStateStore(stateDirectory).load();
    expect(loaded?.schema_version).toBe(5);
    expect(loaded?.preview?.preview_id).toBe("preview_neutral_legacy_1234");
    expect(loaded?.preview?.result.card.model_provenance?.verification_notes).toContain("adapter produced this schema-valid card");
  });

  it("atomically upgrades schema-v2 pending approval state without changing its grant", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-openclaw-state-v2-pending-upgrade-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-openclaw");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const current = storedState("Legacy pending v2");
    const legacyPending = pendingRun();
    const legacy = { ...current, schema_version: 2, pending_run: legacyPending };
    await writeFile(join(stateDirectory, "state.json"), `${JSON.stringify(legacy)}\n`, { encoding: "utf8", mode: 0o600 });

    const loaded = await new OpenClawAdapterStateStore(stateDirectory).load();
    expect(loaded?.schema_version).toBe(5);
    expect(loaded?.pending_run).toEqual(legacyPending);
    expect(loaded?.pairing!.public_key.key_id).toBe(current.pairing!.public_key.key_id);
  });

  it("upgrades an ownerless consumed schema-v3 marker into a non-clearable legacy tombstone", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-openclaw-state-v3-consumed-upgrade-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-openclaw");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const current = storedState("Legacy consumed v3");
    const legacyPending = pendingRun();
    const consumedAt = new Date(Date.parse(legacyPending.prepared_at) + 1).toISOString();
    const legacy = { ...current, schema_version: 3, pending_run: { ...legacyPending, consumed_at: consumedAt } };
    const statePath = join(stateDirectory, "state.json");
    await writeFile(statePath, `${JSON.stringify(legacy)}\n`, { encoding: "utf8", mode: 0o600 });

    const loaded = await new OpenClawAdapterStateStore(stateDirectory).load();
    expect(loaded?.schema_version).toBe(5);
    expect(loaded?.pending_run?.consumed_at).toBe(consumedAt);
    expect(loaded?.pending_run?.consumer).toMatchObject({ owner_kind: "legacy_unknown" });
    await expect(openClawRunConsumerIsActive(loaded!.pending_run!.consumer!)).resolves.toBe(true);
    const rewritten = JSON.parse(await readFile(statePath, "utf8")) as { pending_run: { consumer?: unknown } };
    expect(rewritten.pending_run.consumer).toBeDefined();
    expect(await new OpenClawAdapterStateStore(stateDirectory).clearIfPairing(current.pairing!.pairing_state.pairing_id)).toBe("active");
    expect((await new OpenClawAdapterStateStore(stateDirectory).load())?.pending_run?.consumer)
      .toMatchObject({ owner_kind: "legacy_unknown" });
  });

  it("directly upgrades a superseded schema-v4 ownerless consumed marker to a legacy tombstone", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-openclaw-state-v4-ownerless-upgrade-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-openclaw");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const current = storedState("Legacy consumed v4");
    const legacyPending = pendingRun();
    const consumedAt = new Date(Date.parse(legacyPending.prepared_at) + 1).toISOString();
    const statePath = join(stateDirectory, "state.json");
    await writeFile(statePath, `${JSON.stringify({
      ...current,
      schema_version: 4,
      pairing: {
        ...current.pairing!,
        requested_scopes: [...agentProtocolScopes],
        pairing_state: { ...current.pairing!.pairing_state, granted_scopes: [...agentProtocolScopes] },
      },
      pending_run: { ...legacyPending, consumed_at: consumedAt },
    })}\n`, { encoding: "utf8", mode: 0o600 });

    const loaded = await new OpenClawAdapterStateStore(stateDirectory).load();
    expect(loaded?.pairing).toBeUndefined();
    expect(loaded?.retired_pairing?.pairing_id).toBe(current.pairing!.pairing_state.pairing_id);
    expect(loaded?.pending_run?.consumer).toMatchObject({ owner_kind: "legacy_unknown" });
    const rewrittenRaw = await readFile(statePath, "utf8");
    expect(rewrittenRaw).not.toContain("signing_key_pkcs8");
    expect(rewrittenRaw).not.toContain("contribution:submit");
    const rewritten = JSON.parse(rewrittenRaw) as { pending_run: { consumer: { owner_kind: string } } };
    expect(rewritten.pending_run.consumer.owner_kind).toBe("legacy_unknown");
  });

  it("atomically upgrades schema-v3 preview provenance without changing preview identity", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-openclaw-state-v3-upgrade-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-openclaw");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const current = storedState("Legacy v3");
    const legacy = { ...current, schema_version: 3, preview: persistedPreview("preview_v3_legacy_1234") };
    await writeFile(join(stateDirectory, "state.json"), `${JSON.stringify(legacy)}\n`, { encoding: "utf8", mode: 0o600 });

    const loaded = await new OpenClawAdapterStateStore(stateDirectory).load();
    expect(loaded?.schema_version).toBe(5);
    expect(loaded?.preview?.preview_id).toBe("preview_v3_legacy_1234");
    expect(loaded?.preview?.result.card.model_provenance?.verification_notes).toContain("adapter produced this schema-valid card");
    expect(loaded?.preview?.result.card.model_provenance?.verification_notes).not.toContain("submitted");
  });

  it("retires submit-authorized schema-v2 through schema-v4 keys while preserving only the public preview", async () => {
    for (const schemaVersion of [2, 3, 4] as const) {
      const root = await mkdtemp(join(tmpdir(), `cmai-openclaw-submit-preview-retirement-v${schemaVersion}-`));
      cleanup.push(root);
      const stateDirectory = join(root, "state", "cmai-openclaw");
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      const current = storedState(`Legacy submit v${schemaVersion}`);
      const preview = persistedPreview(`preview_legacy_submit_v${schemaVersion}_1234`);
      const statePath = join(stateDirectory, "state.json");
      await writeFile(statePath, `${JSON.stringify({
        ...current,
        schema_version: schemaVersion,
        pairing: {
          ...current.pairing!,
          requested_scopes: [...agentProtocolScopes],
          pairing_state: { ...current.pairing!.pairing_state, granted_scopes: [...agentProtocolScopes] },
        },
        preview,
      })}\n`, { encoding: "utf8", mode: 0o600 });

      const loaded = await new OpenClawAdapterStateStore(stateDirectory).load();
      expect(loaded?.schema_version).toBe(5);
      expect(loaded?.pairing).toBeUndefined();
      expect(loaded?.retired_pairing).toMatchObject({
        kind: "retired_legacy_submit_authority",
        pairing_id: current.pairing!.pairing_state.pairing_id,
        reason: "legacy_contribution_submit_scope",
      });
      expect(loaded?.preview?.preview_id).toBe(preview.preview_id);
      const rewritten = await readFile(statePath, "utf8");
      expect(rewritten).not.toContain("signing_key_pkcs8");
      expect(rewritten).not.toContain(current.pairing!.signing_key_pkcs8);
      expect(rewritten).not.toContain("contribution:submit");
      expect(await new OpenClawAdapterStateStore(stateDirectory).clearPreviewIfId(preview.preview_id)).toBe(true);
      await expect(lstat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("erases submit-authorized schema-v1 through schema-v4 state when no public preview exists", async () => {
    for (const schemaVersion of [1, 2, 3, 4] as const) {
      const root = await mkdtemp(join(tmpdir(), `cmai-openclaw-submit-key-retirement-v${schemaVersion}-`));
      cleanup.push(root);
      const stateDirectory = join(root, "state", "cmai-openclaw");
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      const current = storedState(`Legacy submit v${schemaVersion}`);
      const statePath = join(stateDirectory, "state.json");
      await writeFile(statePath, `${JSON.stringify({
        ...current,
        schema_version: schemaVersion,
        pairing: {
          ...current.pairing!,
          requested_scopes: [...agentProtocolScopes],
          pairing_state: { ...current.pairing!.pairing_state, granted_scopes: [...agentProtocolScopes] },
        },
      })}\n`, { encoding: "utf8", mode: 0o600 });

      await expect(new OpenClawAdapterStateStore(stateDirectory).load()).resolves.toBeUndefined();
      await expect(lstat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("refuses symlinked state", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-openclaw-state-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-openclaw");
    await mkdir(stateDirectory, { recursive: true, mode: 0o777 });
    await chmod(stateDirectory, 0o777);
    const target = join(root, "target.json");
    await writeFile(target, "{}\n", "utf8");
    await symlink(target, join(stateDirectory, "state.json"));
    await expect(new OpenClawAdapterStateStore(stateDirectory).load()).rejects.toThrow("unsafe or malformed");
  });

  it("refuses to load private keys from permissive files or directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-openclaw-state-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-openclaw");
    const path = join(stateDirectory, "state.json");
    const store = new OpenClawAdapterStateStore(stateDirectory);
    const material = createOpenClawPairingMaterial({ pairingCode: "PAIR-123456", displayName: "Test OpenClaw", runtimeVersion: "2026.7.1" });
    const state = createStoredPairingState({
      device: material.payload.device,
      publicKey: material.payload.public_key,
      requestedScopes: material.payload.requested_scopes,
      pairingState: pairingStateSchema.parse({ ...validPairingStateFixture, granted_scopes: material.payload.requested_scopes }),
      signingKeyPkcs8: material.persistence.signingKeyPkcs8,
    });
    await store.save(state);

    await chmod(path, 0o644);
    await expect(store.load()).rejects.toThrow("unsafe or malformed");
    await chmod(path, 0o600);
    await chmod(stateDirectory, 0o755);
    await expect(store.load()).rejects.toThrow("unsafe or malformed");
  });

  it("allows exactly one first-time pairing writer across concurrent store instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-openclaw-state-race-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-openclaw");
    const first = storedState("First");
    const second = storedState("Second");
    const outcomes = await Promise.all([
      new OpenClawAdapterStateStore(stateDirectory).saveIfAbsent(first),
      new OpenClawAdapterStateStore(stateDirectory).saveIfAbsent(second),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const loaded = await new OpenClawAdapterStateStore(stateDirectory).load();
    const winnerKey = outcomes[0] ? first.pairing!.public_key.key_id : second.pairing!.public_key.key_id;
    expect(loaded?.pairing!.public_key.key_id).toBe(winnerKey);
  });

  it("preserves replacement pairing and preview state against stale cleanup", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-openclaw-state-cas-"));
    cleanup.push(root);
    const store = new OpenClawAdapterStateStore(join(root, "state", "cmai-openclaw"));
    await store.save(storedState("CAS"));
    await store.update((current) => ({
      ...current,
      pairing: {
        ...current.pairing!,
        pairing_state: { ...current.pairing!.pairing_state, pairing_id: "pairing_new" },
      },
      preview: persistedPreview("preview_new_1234"),
    }));

    expect(await store.clearIfPairing(validPairingStateFixture.pairing_id)).toBe("changed");
    expect(await store.clearPreviewIfId("preview_old_1234")).toBe(false);
    expect((await store.load())?.pairing!.pairing_state.pairing_id).toBe("pairing_new");
    expect((await store.load())?.preview?.preview_id).toBe("preview_new_1234");
    expect(await store.clearPreviewIfId("preview_new_1234")).toBe(true);
    expect((await store.load())?.preview).toBeUndefined();
  });

  it("keeps a lock when the PID is alive but process identity is temporarily unreadable", async () => {
    const owner = {
      pid: process.pid,
      token: randomUUID(),
      created_at: new Date().toISOString(),
      process_identity: { boot_id: "expected-boot", start_ticks: "123" },
    };
    await expect(lockOwnerIsActive(owner, {
      processIsAlive: () => true,
      readProcessIdentity: async () => undefined,
    })).resolves.toBe(true);
    await expect(lockOwnerIsActive(owner, {
      processIsAlive: () => true,
      readProcessIdentity: async () => ({ boot_id: "other-boot", start_ticks: "456" }),
    })).resolves.toBe(false);
  });

  it("refuses to create a new inference consumer without durable OS process identity", async () => {
    await expect(createOpenClawRunConsumer(async () => undefined))
      .rejects.toThrow("durable process-incarnation identity");
  });

  it("keeps an unknown legacy owner non-clearable across processes and restarts", async () => {
    const consumer = {
      owner_kind: "legacy_unknown" as const,
      token: randomUUID(),
      created_at: new Date().toISOString(),
    };
    await expect(openClawRunConsumerIsActive(consumer, {
      processIsAlive: () => false,
      readProcessIdentity: async () => undefined,
      currentPid: process.pid,
      currentProcessTimeOrigin: 456,
    })).resolves.toBe(true);
  });

  it("distinguishes a live inference consumer from PID reuse and fails closed when identity is unreadable", async () => {
    const consumer = {
      owner_kind: "process" as const,
      pid: process.pid,
      token: randomUUID(),
      created_at: new Date().toISOString(),
      process_time_origin: 123,
      process_identity: { boot_id: "expected-boot", start_ticks: "123" },
    };
    await expect(openClawRunConsumerIsActive(consumer, {
      processIsAlive: () => true,
      readProcessIdentity: async () => ({ boot_id: "expected-boot", start_ticks: "123" }),
    })).resolves.toBe(true);
    await expect(openClawRunConsumerIsActive(consumer, {
      processIsAlive: () => true,
      readProcessIdentity: async () => ({ boot_id: "expected-boot", start_ticks: "456" }),
    })).resolves.toBe(false);
    await expect(openClawRunConsumerIsActive(consumer, {
      processIsAlive: () => true,
      readProcessIdentity: async () => undefined,
    })).resolves.toBe(true);
    await expect(openClawRunConsumerIsActive(consumer, {
      processIsAlive: () => false,
      readProcessIdentity: async () => undefined,
    })).resolves.toBe(false);
  });

  it("recovers a stale lock when the PID exists but its process incarnation changed", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-openclaw-state-recovery-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-openclaw");
    const lockDirectory = join(stateDirectory, ".state-update.lock");
    await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
    await writeFile(join(lockDirectory, "owner.json"), `${JSON.stringify({
      pid: process.pid,
      token: randomUUID(),
      created_at: new Date().toISOString(),
      process_identity: { boot_id: "different-boot", start_ticks: "1" },
    })}\n`, { mode: 0o600 });

    const store = new OpenClawAdapterStateStore(stateDirectory);
    await expect(store.saveIfAbsent(storedState("Recovered"))).resolves.toBe(true);
    expect((await store.load())?.pairing!.device.display_name).toBe("Recovered");
    await expect(lstat(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
