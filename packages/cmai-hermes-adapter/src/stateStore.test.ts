import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashAgentProtocolPayload } from "../../../lib/agent-protocol/canonical";
import { agentProtocolScopes } from "../../../lib/agent-protocol/constants";
import {
  validChallengeGetResponseFixture,
  validContributionCardV1,
  validPairingStateFixture,
} from "../../../lib/agent-protocol/fixtures";
import { agentPublicChallengeSchema, pairedAdapterAuditMetadataSchema, pairingStateSchema } from "../../../lib/agent-protocol/schemas";
import { normalizePairedAdapterContribution } from "../../../lib/agent-protocol/provenance";
import { pairedLocalContributionCardV1Schema } from "../../../lib/validation/contributionCardProtocol";
import { createHermesPairingMaterial, restoreHermesSigner } from "./cryptoSigner";
import { createHermesRunConsumer, createStoredPairingState, hermesRunConsumerIsActive, HermesAdapterStateStore } from "./stateStore";

const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Hermes adapter local pairing state", () => {
  it("persists a strict 0600 pairing-only file and removes all adapter residue", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-hermes-state-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-hermes");
    const store = new HermesAdapterStateStore(stateDirectory);
    const material = createHermesPairingMaterial({ pairingCode: "PAIR-123456", displayName: "Test Hermes", runtimeVersion: "0.18.2" });
    await store.save(createStoredPairingState({
      device: material.payload.device,
      publicKey: material.payload.public_key,
      requestedScopes: material.payload.requested_scopes,
      pairingState: pairingStateSchema.parse({ ...validPairingStateFixture, granted_scopes: material.payload.requested_scopes }),
      signingKeyPkcs8: material.persistence.signingKeyPkcs8,
    }));

    const path = join(stateDirectory, "state.json");
    const directoryInfo = await lstat(stateDirectory);
    const fileInfo = await lstat(path);
    expect(directoryInfo.mode & 0o777).toBe(0o700);
    expect(fileInfo.mode & 0o777).toBe(0o600);
    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw).schema_version).toBe(6);
    expect(raw).not.toContain("PAIR-123456");
    expect(raw).not.toContain("prompt");
    expect(raw).not.toContain("response");
    expect(raw).not.toContain("provider");
    const loaded = await store.load();
    expect(loaded?.pairing!.pairing_state.pairing_id).toBe("pairing_1");
    const signature = await restoreHermesSigner(loaded!.pairing!.public_key.key_id, loaded!.pairing!.signing_key_pkcs8).sign("bounded-test");
    expect(signature).toMatch(/^[A-Za-z0-9_-]{86}$/);

    const competing = createStoredPairingState({
      device: material.payload.device,
      publicKey: material.payload.public_key,
      requestedScopes: material.payload.requested_scopes,
      pairingState: pairingStateSchema.parse({ ...validPairingStateFixture, pairing_id: "pairing_competing", granted_scopes: material.payload.requested_scopes }),
      signingKeyPkcs8: material.persistence.signingKeyPkcs8,
    });
    expect(await store.saveIfAbsent(competing)).toBe(false);
    expect(() => createStoredPairingState({
      device: material.payload.device,
      publicKey: material.payload.public_key,
      requestedScopes: material.payload.requested_scopes,
      pairingState: pairingStateSchema.parse(validPairingStateFixture),
      signingKeyPkcs8: material.persistence.signingKeyPkcs8,
    })).toThrow(/exact preview-only authority set/);
    expect(() => createStoredPairingState({
      device: material.payload.device,
      publicKey: material.payload.public_key,
      requestedScopes: [...agentProtocolScopes],
      pairingState: pairingStateSchema.parse({ ...validPairingStateFixture, granted_scopes: [...agentProtocolScopes] }),
      signingKeyPkcs8: material.persistence.signingKeyPkcs8,
    })).toThrow(/exact preview-only authority set/);
    expect((await store.load())?.pairing!.pairing_state.pairing_id).toBe("pairing_1");
    expect(await store.clearIfPairing("pairing_competing")).toBe("changed");
    expect(await store.clearIfPairing("pairing_1")).toBe("cleared");
    expect(await store.load()).toBeUndefined();

    await store.save(createStoredPairingState({
      device: material.payload.device,
      publicKey: material.payload.public_key,
      requestedScopes: material.payload.requested_scopes,
      pairingState: pairingStateSchema.parse({ ...validPairingStateFixture, granted_scopes: material.payload.requested_scopes }),
      signingKeyPkcs8: material.persistence.signingKeyPkcs8,
    }));
    await store.clear();
    await expect(lstat(stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects permissive state directories and files before a private signer can hydrate", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-hermes-state-permissions-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-hermes");
    const path = join(stateDirectory, "state.json");
    const store = new HermesAdapterStateStore(stateDirectory);
    const material = createHermesPairingMaterial({ pairingCode: "PAIR-123456", displayName: "Test Hermes", runtimeVersion: "0.18.2" });
    await store.save(createStoredPairingState({
      device: material.payload.device,
      publicKey: material.payload.public_key,
      requestedScopes: material.payload.requested_scopes,
      pairingState: pairingStateSchema.parse({ ...validPairingStateFixture, granted_scopes: material.payload.requested_scopes }),
      signingKeyPkcs8: material.persistence.signingKeyPkcs8,
    }));

    await chmod(path, 0o644);
    await expect(store.load()).rejects.toThrow("unsafe or malformed");
    expect((await lstat(path)).mode & 0o777).toBe(0o644);

    await chmod(path, 0o600);
    await chmod(stateDirectory, 0o755);
    await expect(store.load()).rejects.toThrow("real 0700 directory");
    expect((await lstat(stateDirectory)).mode & 0o777).toBe(0o755);
  });

  it("preserves a live consumed run during pairing cleanup and clears only after process identity changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-hermes-consumed-pairing-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-hermes");
    const store = new HermesAdapterStateStore(stateDirectory);
    const material = createHermesPairingMaterial({ pairingCode: "PAIR-123456", displayName: "Consumed Hermes", runtimeVersion: "0.18.2" });
    const base = createStoredPairingState({
      device: material.payload.device,
      publicKey: material.payload.public_key,
      requestedScopes: material.payload.requested_scopes,
      pairingState: pairingStateSchema.parse({ ...validPairingStateFixture, granted_scopes: material.payload.requested_scopes }),
      signingKeyPkcs8: material.persistence.signingKeyPkcs8,
    });
    const challenge = agentPublicChallengeSchema.parse(validChallengeGetResponseFixture.result.challenge);
    const consumer = await createHermesRunConsumer();
    const consumed = {
      ...base,
      pending_run: {
        pairing_id: base.pairing!.pairing_state.pairing_id,
        challenge_hash: hashAgentProtocolPayload(challenge),
        challenge_id: challenge.challenge_id,
        challenge_revision: challenge.revision,
        run_grant: challenge.run_grant,
        prompt_version: challenge.run_grant.prompt_version,
        profile_name: "test-profile",
        max_output_bytes: challenge.run_grant.max_output_bytes,
        max_tokens: 4096 as const,
        timeout_seconds: 45 as const,
        prepared_at: challenge.run_grant.issued_at,
        approval_expires_at: challenge.run_grant.expires_at,
        consumed_at: new Date().toISOString(),
        consumer,
      },
    };
    await store.save(consumed);
    expect(await store.clearIfPairing(base.pairing!.pairing_state.pairing_id)).toBe("active");
    expect((await store.load())?.pending_run?.consumer?.token).toBe(consumer.token);

    await store.save({
      ...consumed,
      pending_run: {
        ...consumed.pending_run,
        consumer: {
          ...consumer,
          process_identity: { ...consumer.process_identity, start_ticks: `${consumer.process_identity.start_ticks}0` },
        },
      },
    });
    expect(await store.clearIfPairing(base.pairing!.pairing_state.pairing_id)).toBe("cleared");
    expect(await store.load()).toBeUndefined();
  });

  it("loads legacy v1 state and strictly persists only bounded pending-run consent metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-hermes-state-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-hermes");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const store = new HermesAdapterStateStore(stateDirectory);
    const material = createHermesPairingMaterial({ pairingCode: "PAIR-123456", displayName: "Test Hermes", runtimeVersion: "0.18.2" });
    const current = createStoredPairingState({
      device: material.payload.device,
      publicKey: material.payload.public_key,
      requestedScopes: material.payload.requested_scopes,
      pairingState: pairingStateSchema.parse({ ...validPairingStateFixture, granted_scopes: material.payload.requested_scopes }),
      signingKeyPkcs8: material.persistence.signingKeyPkcs8,
    });
    const { schema_version: _version, ...legacyBody } = current;
    await writeFile(join(stateDirectory, "state.json"), `${JSON.stringify({ schema_version: 1, ...legacyBody })}\n`, { mode: 0o600 });

    const migrated = await store.load();
    expect(migrated?.schema_version).toBe(6);
    expect(migrated?.pending_run).toBeUndefined();
    await writeFile(join(stateDirectory, "state.json"), `${JSON.stringify({
      schema_version: 2,
      ...legacyBody,
      pending_run: {
        challenge_id: "challenge_protocol_1",
        challenge_revision: 1,
        run_nonce: "n".repeat(43),
        run_nonce_expires_at: "2099-01-01T00:05:00.000Z",
        prompt_version: "cmai_contribution_v1",
        profile_name: "test-profile",
        max_output_bytes: 65_536,
        max_tokens: 4096,
        timeout_seconds: 45,
        prepared_at: "2099-01-01T00:00:00.000Z",
        approval_expires_at: "2099-01-01T00:05:00.000Z",
      },
    })}\n`, { mode: 0o600 });
    expect((await store.load())?.pending_run).toBeUndefined();
    const legacyBoundedPending = {
      challenge_id: "challenge_protocol_1",
      challenge_revision: 1,
      run_grant: validChallengeGetResponseFixture.result.challenge.run_grant,
      prompt_version: validChallengeGetResponseFixture.result.challenge.run_grant.prompt_version,
      profile_name: "test-profile",
      max_output_bytes: validChallengeGetResponseFixture.result.challenge.run_grant.max_output_bytes,
      max_tokens: 4096,
      timeout_seconds: 45,
      prepared_at: validChallengeGetResponseFixture.result.challenge.run_grant.issued_at,
      approval_expires_at: validChallengeGetResponseFixture.result.challenge.run_grant.expires_at,
    };
    await writeFile(join(stateDirectory, "state.json"), `${JSON.stringify({
      schema_version: 4,
      ...legacyBody,
      pending_run: legacyBoundedPending,
    })}\n`, { mode: 0o600 });
    const migratedV4 = await store.load();
    expect(migratedV4?.schema_version).toBe(6);
    expect(migratedV4?.pending_run).toBeUndefined();

    const pending_run = {
      pairing_id: validPairingStateFixture.pairing_id,
      challenge_hash: hashAgentProtocolPayload(validChallengeGetResponseFixture.result.challenge),
      challenge_id: "challenge_protocol_1",
      challenge_revision: 1,
      run_grant: {
        run_nonce: "n".repeat(43),
        issued_at: "2099-01-01T00:00:00.000Z",
        expires_at: "2099-01-01T00:05:00.000Z",
        request_class: "challenge_contribution" as const,
        challenge_revision: 1,
        prompt_version: "cmai_contribution_v1",
        max_output_bytes: 65536,
      },
      prompt_version: "cmai_contribution_v1",
      profile_name: "test-profile",
      max_output_bytes: 65_536,
      max_tokens: 4096 as const,
      timeout_seconds: 45 as const,
      prepared_at: "2099-01-01T00:00:00.000Z",
      approval_expires_at: "2099-01-01T00:05:00.000Z",
    };
    await store.save({ ...migrated!, pending_run });
    const raw = await readFile(join(stateDirectory, "state.json"), "utf8");
    expect(raw).toContain('"pending_run"');
    expect(raw).not.toContain("What is the minimum stable protocol?");
    expect((await store.load())?.pending_run).toEqual(pending_run);
  });

  it("atomically migrates durable schema-v2 and schema-v3 submitted previews to neutral provenance and identity", async () => {
    for (const schemaVersion of [2, 3] as const) {
    const root = await mkdtemp(join(tmpdir(), `cmai-hermes-preview-migration-v${schemaVersion}-`));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-hermes");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const material = createHermesPairingMaterial({ pairingCode: "PAIR-123456", displayName: "Legacy Hermes", runtimeVersion: "0.18.2" });
    const current = createStoredPairingState({
      device: material.payload.device,
      publicKey: material.payload.public_key,
      requestedScopes: material.payload.requested_scopes,
      pairingState: pairingStateSchema.parse({ ...validPairingStateFixture, granted_scopes: material.payload.requested_scopes }),
      signingKeyPkcs8: material.persistence.signingKeyPkcs8,
    });
    const challenge = agentPublicChallengeSchema.parse(validChallengeGetResponseFixture.result.challenge);
    const legacyAudit = pairedAdapterAuditMetadataSchema.parse({
      runtime: "hermes",
      runtime_version: "0.18.2",
      adapter_name: "cmai-hermes",
      adapter_version: "0.1.0",
      local_run_id: "run_legacy_hermes_preview",
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
      schema_version: schemaVersion,
      pairing: {
        ...current.pairing!,
        requested_scopes: [...agentProtocolScopes],
        pairing_state: { ...current.pairing!.pairing_state, granted_scopes: [...agentProtocolScopes] },
      },
      preview: {
        challenge,
        result: {
          identity: { runtime: "hermes", runtimeVersion: "0.18.2", adapterName: "cmai-hermes", adapterVersion: "0.1.0" },
          localRunId: "run_legacy_hermes_preview",
          card: normalizePairedAdapterContribution(pairedLocalContributionCardV1Schema.parse(validContributionCardV1), legacyAudit),
          providerClaim: "legacy-provider",
          modelClaim: "legacy-provider/legacy-model",
          startedAt: challenge.run_grant.issued_at,
          completedAt: challenge.run_grant.issued_at,
          structuredOutputValidated: true,
        },
        idempotency_key: "idem_legacy_hermes_preview_0001",
        persisted_at: challenge.run_grant.issued_at,
      },
    })}\n`, { mode: 0o600 });

    const loaded = await new HermesAdapterStateStore(stateDirectory).load();
    expect(loaded?.schema_version).toBe(6);
    expect(loaded?.pairing).toBeUndefined();
    expect(loaded?.retired_pairing).toMatchObject({
      kind: "retired_legacy_submit_authority",
      pairing_id: current.pairing!.pairing_state.pairing_id,
      reason: "legacy_contribution_submit_scope",
    });
    expect(loaded?.preview?.preview_id).toMatch(/^preview_/);
    expect(loaded?.preview).not.toHaveProperty("idempotency_key");
    expect(loaded?.preview?.result.card.model_provenance?.verification_notes).toContain("adapter produced this schema-valid card");
    expect(loaded?.preview?.result.card.model_provenance?.verification_notes).not.toContain("submitted");
    const rewrittenRaw = await readFile(statePath, "utf8");
    expect(rewrittenRaw).not.toContain("signing_key_pkcs8");
    expect(rewrittenRaw).not.toContain(current.pairing!.signing_key_pkcs8);
    expect(rewrittenRaw).not.toContain("contribution:submit");
    const rewritten = JSON.parse(rewrittenRaw) as { schema_version: number };
    expect(rewritten.schema_version).toBe(6);
    expect(await new HermesAdapterStateStore(stateDirectory).clearPreviewIfId(loaded!.preview!.preview_id)).toBe(true);
    await expect(lstat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("removes a schema-v5 submit-authorized key without losing its live consumed-run owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-hermes-submit-live-retirement-v5-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-hermes");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const material = createHermesPairingMaterial({ pairingCode: "PAIR-123456", displayName: "Legacy Hermes", runtimeVersion: "0.18.2" });
    const current = createStoredPairingState({
      device: material.payload.device,
      publicKey: material.payload.public_key,
      requestedScopes: material.payload.requested_scopes,
      pairingState: pairingStateSchema.parse({ ...validPairingStateFixture, granted_scopes: material.payload.requested_scopes }),
      signingKeyPkcs8: material.persistence.signingKeyPkcs8,
    });
    const grant = validChallengeGetResponseFixture.result.challenge.run_grant;
    const consumer = await createHermesRunConsumer();
    const pendingRun = {
      pairing_id: current.pairing!.pairing_state.pairing_id,
      challenge_hash: hashAgentProtocolPayload(validChallengeGetResponseFixture.result.challenge),
      challenge_id: validChallengeGetResponseFixture.result.challenge.challenge_id,
      challenge_revision: validChallengeGetResponseFixture.result.challenge.revision,
      run_grant: grant,
      prompt_version: grant.prompt_version,
      profile_name: "test-profile",
      max_output_bytes: grant.max_output_bytes,
      max_tokens: 4096,
      timeout_seconds: 45,
      prepared_at: grant.issued_at,
      approval_expires_at: grant.expires_at,
      consumed_at: new Date().toISOString(),
      consumer,
    };
    const statePath = join(stateDirectory, "state.json");
    await writeFile(statePath, `${JSON.stringify({
      ...current,
      schema_version: 5,
      pairing: {
        ...current.pairing!,
        requested_scopes: [...agentProtocolScopes],
        pairing_state: { ...current.pairing!.pairing_state, granted_scopes: [...agentProtocolScopes] },
      },
      pending_run: pendingRun,
    })}\n`, { mode: 0o600 });

    const loaded = await new HermesAdapterStateStore(stateDirectory).load();
    expect(loaded?.pairing).toBeUndefined();
    expect(loaded?.retired_pairing?.pairing_id).toBe(current.pairing!.pairing_state.pairing_id);
    expect(loaded?.pending_run?.consumer).toEqual(consumer);
    await expect(hermesRunConsumerIsActive(loaded!.pending_run!.consumer!)).resolves.toBe(true);
    const rewritten = await readFile(statePath, "utf8");
    expect(rewritten).not.toContain("signing_key_pkcs8");
    expect(rewritten).not.toContain("contribution:submit");
  });

  it("erases legacy schema-v4 and schema-v5 submit-authorized pairing state when no public preview exists", async () => {
    for (const schemaVersion of [4, 5] as const) {
      const root = await mkdtemp(join(tmpdir(), `cmai-hermes-submit-key-retirement-v${schemaVersion}-`));
      cleanup.push(root);
      const stateDirectory = join(root, "state", "cmai-hermes");
      await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
      const material = createHermesPairingMaterial({ pairingCode: "PAIR-123456", displayName: "Legacy Hermes", runtimeVersion: "0.18.2" });
      const current = createStoredPairingState({
        device: material.payload.device,
        publicKey: material.payload.public_key,
        requestedScopes: material.payload.requested_scopes,
        pairingState: pairingStateSchema.parse({ ...validPairingStateFixture, granted_scopes: material.payload.requested_scopes }),
        signingKeyPkcs8: material.persistence.signingKeyPkcs8,
      });
      const statePath = join(stateDirectory, "state.json");
      await writeFile(statePath, `${JSON.stringify({
        ...current,
        schema_version: schemaVersion,
        pairing: {
          ...current.pairing!,
          requested_scopes: [...agentProtocolScopes],
          pairing_state: { ...current.pairing!.pairing_state, granted_scopes: [...agentProtocolScopes] },
        },
      })}\n`, { mode: 0o600 });

      await expect(new HermesAdapterStateStore(stateDirectory).load()).resolves.toBeUndefined();
      await expect(lstat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects state that contains both an unconsumed approval and a validated preview", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-hermes-state-exclusive-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-hermes");
    const store = new HermesAdapterStateStore(stateDirectory);
    const material = createHermesPairingMaterial({ pairingCode: "PAIR-123456", displayName: "Test", runtimeVersion: "0.18.2" });
    const state = createStoredPairingState({
      device: material.payload.device,
      publicKey: material.payload.public_key,
      requestedScopes: material.payload.requested_scopes,
      pairingState: pairingStateSchema.parse({ ...validPairingStateFixture, granted_scopes: material.payload.requested_scopes }),
      signingKeyPkcs8: material.persistence.signingKeyPkcs8,
    });
    const challenge = agentPublicChallengeSchema.parse(validChallengeGetResponseFixture.result.challenge);

    await expect(store.save({
      ...state,
      pending_run: {
        pairing_id: validPairingStateFixture.pairing_id,
        challenge_hash: hashAgentProtocolPayload(challenge),
        challenge_id: challenge.challenge_id,
        challenge_revision: challenge.revision,
        run_grant: challenge.run_grant,
        prompt_version: challenge.run_grant.prompt_version,
        profile_name: "test-profile",
        max_output_bytes: challenge.run_grant.max_output_bytes,
        max_tokens: 4096,
        timeout_seconds: 45,
        prepared_at: challenge.run_grant.issued_at,
        approval_expires_at: challenge.run_grant.expires_at,
      },
      preview: {
        challenge,
        result: {
          identity: {
            runtime: "hermes",
            runtimeVersion: "0.18.2",
            adapterName: "cmai-hermes",
            adapterVersion: "0.1.0",
          },
          localRunId: "run_exclusive_state",
          card: pairedLocalContributionCardV1Schema.parse(validContributionCardV1),
          startedAt: challenge.run_grant.issued_at,
          completedAt: challenge.run_grant.issued_at,
          structuredOutputValidated: true,
        },
        preview_id: "preview_exclusive_state_0001",
        persisted_at: challenge.run_grant.issued_at,
      },
    })).rejects.toThrow("cannot coexist");
  });

  it("refuses a symlinked or oversized state file", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-hermes-state-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-hermes");
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const target = join(root, "target.json");
    await writeFile(target, "{}\n", "utf8");
    await symlink(target, join(stateDirectory, "state.json"));
    const store = new HermesAdapterStateStore(stateDirectory);
    await expect(store.load()).rejects.toThrow("unsafe or malformed");
  });

  it("rejects instead of silently tightening an existing permissive state directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-hermes-state-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-hermes");
    await mkdir(stateDirectory, { recursive: true, mode: 0o777 });
    await chmod(stateDirectory, 0o777);
    const material = createHermesPairingMaterial({ pairingCode: "PAIR-123456", displayName: "Test", runtimeVersion: "0.18.2" });
    const store = new HermesAdapterStateStore(stateDirectory);
    await expect(store.save(createStoredPairingState({
      device: material.payload.device,
      publicKey: material.payload.public_key,
      requestedScopes: material.payload.requested_scopes,
      pairingState: pairingStateSchema.parse({ ...validPairingStateFixture, granted_scopes: material.payload.requested_scopes }),
      signingKeyPkcs8: material.persistence.signingKeyPkcs8,
    }))).rejects.toThrow("real 0700 directory");
    expect((await lstat(stateDirectory)).mode & 0o777).toBe(0o777);
  });

  it("rejects live state locks regardless of age and atomically recovers a dead owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-hermes-state-lock-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-hermes");
    const store = new HermesAdapterStateStore(stateDirectory);
    const material = createHermesPairingMaterial({ pairingCode: "PAIR-123456", displayName: "Test", runtimeVersion: "0.18.2" });
    const state = createStoredPairingState({
      device: material.payload.device,
      publicKey: material.payload.public_key,
      requestedScopes: material.payload.requested_scopes,
      pairingState: pairingStateSchema.parse({ ...validPairingStateFixture, granted_scopes: material.payload.requested_scopes }),
      signingKeyPkcs8: material.persistence.signingKeyPkcs8,
    });
    await store.save(state);
    const lockDirectory = join(stateDirectory, ".state-update.lock");
    await mkdir(lockDirectory, { mode: 0o700 });
    await writeFile(join(lockDirectory, "owner.json"), `${JSON.stringify({ pid: process.pid, token: randomUUID(), created_at: new Date().toISOString() })}\n`, { mode: 0o600 });

    await expect(store.save(state)).rejects.toThrow("state is busy");
    await expect(store.update((current) => current)).rejects.toThrow("state is busy");
    await expect(store.clear()).rejects.toThrow("state is busy");

    const { rm } = await import("node:fs/promises");
    await rm(lockDirectory, { recursive: true });
    await mkdir(lockDirectory, { mode: 0o700 });
    await writeFile(join(lockDirectory, "owner.json"), `${JSON.stringify({ pid: process.pid, token: randomUUID(), created_at: "2000-01-01T00:00:00.000Z" })}\n`, { mode: 0o600 });
    await expect(store.update((current) => current)).rejects.toThrow("state is busy");

    await rm(lockDirectory, { recursive: true });
    await mkdir(lockDirectory, { mode: 0o700 });
    await writeFile(join(lockDirectory, "owner.json"), `${JSON.stringify({ pid: 99_999_999, token: randomUUID(), created_at: new Date().toISOString() })}\n`, { mode: 0o600 });
    await expect(store.update((current) => current)).resolves.toEqual(state);
    expect(await store.load()).toEqual(state);
    expect((await readdir(stateDirectory)).filter((name) => name.startsWith(".state-update.lock"))).toEqual([]);
  });

  it("recovers a crash-left lock when the recorded PID was reused by a different process incarnation", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-hermes-state-pid-reuse-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-hermes");
    const store = new HermesAdapterStateStore(stateDirectory);
    const material = createHermesPairingMaterial({ pairingCode: "PAIR-123456", displayName: "Test", runtimeVersion: "0.18.2" });
    const state = createStoredPairingState({
      device: material.payload.device,
      publicKey: material.payload.public_key,
      requestedScopes: material.payload.requested_scopes,
      pairingState: pairingStateSchema.parse({ ...validPairingStateFixture, granted_scopes: material.payload.requested_scopes }),
      signingKeyPkcs8: material.persistence.signingKeyPkcs8,
    });
    await store.save(state);
    const lockDirectory = join(stateDirectory, ".state-update.lock");
    await mkdir(lockDirectory, { mode: 0o700 });
    await writeFile(join(lockDirectory, "owner.json"), `${JSON.stringify({
      pid: process.pid,
      token: randomUUID(),
      created_at: new Date().toISOString(),
      process_identity: { boot_id: "not-the-current-boot", start_ticks: "1" },
    })}\n`, { mode: 0o600 });

    await expect(store.update((current) => current)).resolves.toEqual(state);
    expect((await readdir(stateDirectory)).filter((name) => name.startsWith(".state-update.lock"))).toEqual([]);
  });

  it("removes the private-key temporary file when atomic replacement fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "cmai-hermes-state-"));
    cleanup.push(root);
    const stateDirectory = join(root, "state", "cmai-hermes");
    await mkdir(join(stateDirectory, "state.json"), { recursive: true });
    const material = createHermesPairingMaterial({ pairingCode: "PAIR-123456", displayName: "Test", runtimeVersion: "0.18.2" });
    const store = new HermesAdapterStateStore(stateDirectory);

    await expect(store.save(createStoredPairingState({
      device: material.payload.device,
      publicKey: material.payload.public_key,
      requestedScopes: material.payload.requested_scopes,
      pairingState: pairingStateSchema.parse({ ...validPairingStateFixture, granted_scopes: material.payload.requested_scopes }),
      signingKeyPkcs8: material.persistence.signingKeyPkcs8,
    }))).rejects.toThrow();

    expect((await readdir(stateDirectory)).filter((name) => name.startsWith(".state-") && name.endsWith(".tmp"))).toEqual([]);
  });
});
