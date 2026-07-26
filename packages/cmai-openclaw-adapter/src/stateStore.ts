import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rmdir, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { agentProtocolPreviewScopes, agentProtocolScopes } from "../../../lib/agent-protocol/constants";
import {
  agentChallengeRunGrantSchema,
  agentDeviceIdentitySchema,
  agentProtocolInitialPublicKeySchema,
  agentPublicChallengeSchema,
  pairedAdapterRunAuditMetadataSchema,
  pairingStateSchema,
} from "../../../lib/agent-protocol/schemas";
import { normalizePairedAdapterContribution } from "../../../lib/agent-protocol/provenance";
import { pairedLocalContributionCardV1Schema } from "../../../lib/validation/contributionCardProtocol";
import { CMAI_OPENCLAW_ADAPTER_VERSION } from "./constants";
import {
  CMAI_OPENCLAW_INFERENCE_COST_ACKNOWLEDGEMENT,
  CMAI_OPENCLAW_INFERENCE_MAX_TOKENS,
  CMAI_OPENCLAW_INFERENCE_TIMEOUT_MS,
} from "./inference";

const MAX_STATE_BYTES = 512 * 1024;
const LOCK_LEASE_MS = 2 * 60_000;
const LOCK_ACQUIRE_ATTEMPTS = 50;
const LOCK_RETRY_DELAY_MS = 10;
const processIdentitySchema = z.object({
  boot_id: z.string().min(1).max(128),
  start_ticks: z.string().regex(/^\d+$/),
}).strict();
const lockOwnerSchema = z.object({
  pid: z.number().int().positive(),
  token: z.string().uuid(),
  created_at: z.iso.datetime({ offset: true }),
  process_identity: processIdentitySchema.optional(),
}).strict();
const legacyRunConsumerWithTimeOriginSchema = lockOwnerSchema.extend({
  process_time_origin: z.number().finite().nonnegative(),
}).strict();
const legacyRunConsumerSchema = z.union([legacyRunConsumerWithTimeOriginSchema, lockOwnerSchema]);
const processRunConsumerSchema = lockOwnerSchema.extend({
  owner_kind: z.literal("process"),
  process_time_origin: z.number().finite().nonnegative(),
}).strict();
const unknownLegacyRunConsumerSchema = z.object({
  owner_kind: z.literal("legacy_unknown"),
  token: z.string().uuid(),
  created_at: z.iso.datetime({ offset: true }),
}).strict();
const runConsumerSchema = z.discriminatedUnion("owner_kind", [
  processRunConsumerSchema,
  unknownLegacyRunConsumerSchema,
]);

const pendingRunFields = {
  challenge_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  challenge_revision: z.number().int().min(1),
  run_grant: agentChallengeRunGrantSchema,
  challenge_hash: z.string().regex(/^[a-f0-9]{64}$/),
  prompt_version: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  agent_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/),
  active_model: z.string().min(3).max(200).regex(/^[^\s/]+\/[^\s]+$/),
  max_output_bytes: z.number().int().min(1).max(64 * 1024),
  max_tokens: z.literal(CMAI_OPENCLAW_INFERENCE_MAX_TOKENS),
  timeout_ms: z.literal(CMAI_OPENCLAW_INFERENCE_TIMEOUT_MS),
  cost_acknowledgement: z.literal(CMAI_OPENCLAW_INFERENCE_COST_ACKNOWLEDGEMENT),
  prepared_at: z.iso.datetime({ offset: true }),
  approval_expires_at: z.iso.datetime({ offset: true }),
};

function validatePendingRun(pending: {
  challenge_revision: number;
  run_grant: z.infer<typeof agentChallengeRunGrantSchema>;
  prompt_version: string;
  max_output_bytes: number;
  prepared_at: string;
  approval_expires_at: string;
  consumed_at?: string;
  consumer?: unknown;
}, context: z.RefinementCtx, requireOwnedConsumption: boolean): void {
  if (pending.run_grant.challenge_revision !== pending.challenge_revision) {
    context.addIssue({ code: "custom", path: ["run_grant", "challenge_revision"], message: "Pending grant revision must match the approved challenge revision." });
  }
  if (pending.run_grant.prompt_version !== pending.prompt_version) {
    context.addIssue({ code: "custom", path: ["run_grant", "prompt_version"], message: "Pending grant prompt version must match the approved prompt version." });
  }
  if (pending.run_grant.max_output_bytes !== pending.max_output_bytes) {
    context.addIssue({ code: "custom", path: ["run_grant", "max_output_bytes"], message: "Pending grant output limit must match the approved output limit." });
  }
  if (pending.approval_expires_at !== pending.run_grant.expires_at) {
    context.addIssue({ code: "custom", path: ["approval_expires_at"], message: "Pending approval expiry must match the complete run grant." });
  }
  if (pending.consumed_at && Date.parse(pending.consumed_at) < Date.parse(pending.prepared_at)) {
    context.addIssue({ code: "custom", path: ["consumed_at"], message: "Consumed run approval cannot precede preparation." });
  }
  if (pending.consumer && !pending.consumed_at) {
    context.addIssue({ code: "custom", path: ["consumer"], message: "A run consumer requires an atomic consumption timestamp." });
  }
  if (requireOwnedConsumption && pending.consumed_at && !pending.consumer) {
    context.addIssue({ code: "custom", path: ["consumer"], message: "A consumed run approval requires durable process ownership." });
  }
}

const legacyPendingRunSchema = z.object({
  ...pendingRunFields,
  consumed_at: z.iso.datetime({ offset: true }).optional(),
  consumer: legacyRunConsumerSchema.optional(),
}).strict().superRefine((pending, context) => {
  validatePendingRun(pending, context, false);
});

const pendingRunSchema = z.object({
  ...pendingRunFields,
  consumed_at: z.iso.datetime({ offset: true }).optional(),
  consumer: runConsumerSchema.optional(),
}).strict().superRefine((pending, context) => {
  validatePendingRun(pending, context, true);
});

const persistedRunResultSchema = z.object({
  identity: z.object({
    runtime: z.literal("openclaw"),
    runtimeVersion: z.string().min(1).max(80).optional(),
    adapterName: z.literal("cmai-openclaw"),
    adapterVersion: z.literal(CMAI_OPENCLAW_ADAPTER_VERSION),
  }).strict(),
  localRunId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  card: pairedLocalContributionCardV1Schema,
  providerClaim: z.string().min(1).max(160).optional(),
  modelClaim: z.string().min(1).max(200).optional(),
  modelDisplayNameClaim: z.string().min(1).max(160).optional(),
  startedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }),
  structuredOutputValidated: z.literal(true),
}).strict().superRefine((result, context) => {
  if (Date.parse(result.completedAt) < Date.parse(result.startedAt)) {
    context.addIssue({ code: "custom", path: ["completedAt"], message: "Persisted run completion cannot precede its start." });
  }
});

const persistedPreviewSchema = z.object({
  challenge: agentPublicChallengeSchema,
  result: persistedRunResultSchema,
  preview_id: z.string().min(16).max(160).regex(/^preview_[A-Za-z0-9_-]+$/),
  persisted_at: z.iso.datetime({ offset: true }),
}).strict().superRefine((preview, context) => {
  if (preview.result.card.challenge_id !== preview.challenge.challenge_id) {
    context.addIssue({ code: "custom", path: ["result", "card", "challenge_id"], message: "Persisted preview challenge must match its card." });
  }
});

const legacyPersistedPreviewSchemaV2 = z.object({
  challenge: agentPublicChallengeSchema,
  result: persistedRunResultSchema,
  idempotency_key: z.string().min(16).max(160).regex(/^[A-Za-z0-9_-]+$/),
  persisted_at: z.iso.datetime({ offset: true }),
}).strict().superRefine((preview, context) => {
  if (preview.result.card.challenge_id !== preview.challenge.challenge_id) {
    context.addIssue({ code: "custom", path: ["result", "card", "challenge_id"], message: "Persisted preview challenge must match its card." });
  }
});

const pairingFields = {
  device: agentDeviceIdentitySchema,
  public_key: agentProtocolInitialPublicKeySchema,
  requested_scopes: z.array(z.enum(agentProtocolScopes)).min(1).max(agentProtocolScopes.length),
  pairing_state: pairingStateSchema,
  signing_key_pkcs8: z.string().min(32).max(512).regex(/^[A-Za-z0-9_-]+$/),
};

const legacyPairingSchema = z.object(pairingFields).strict();

const pairingSchema = z.object(pairingFields).strict().superRefine((pairing, context) => {
  const requested = new Set(pairing.requested_scopes);
  const granted = new Set(pairing.pairing_state.granted_scopes);
  if (
    requested.size !== agentProtocolPreviewScopes.length
    || granted.size !== agentProtocolPreviewScopes.length
    || pairing.requested_scopes.length !== agentProtocolPreviewScopes.length
    || pairing.pairing_state.granted_scopes.length !== agentProtocolPreviewScopes.length
    || agentProtocolPreviewScopes.some((scope) => !requested.has(scope) || !granted.has(scope))
  ) {
    context.addIssue({ code: "custom", path: ["pairing_state", "granted_scopes"], message: "Persisted active pairing scopes must equal the exact preview-only authority set." });
  }
});

const retiredPairingSchema = z.object({
  kind: z.literal("retired_legacy_submit_authority"),
  pairing_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  device_id: z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  retired_at: z.iso.datetime({ offset: true }),
  reason: z.literal("legacy_contribution_submit_scope"),
}).strict();

const stateSchemaV1 = z.object({
  schema_version: z.literal(1),
  adapter_version: z.literal(CMAI_OPENCLAW_ADAPTER_VERSION),
  pairing: legacyPairingSchema,
}).strict();

const stateSchemaV2WithSubmissionIdentity = z.object({
  schema_version: z.literal(2),
  adapter_version: z.literal(CMAI_OPENCLAW_ADAPTER_VERSION),
  pairing: legacyPairingSchema,
  pending_run: legacyPendingRunSchema.optional(),
  preview: legacyPersistedPreviewSchemaV2.optional(),
}).strict().superRefine((state, context) => {
  if (state.pending_run && state.preview) {
    context.addIssue({ code: "custom", path: ["preview"], message: "A pending run approval and a validated preview cannot coexist." });
  }
});

const stateSchemaV2WithPreviewIdentity = z.object({
  schema_version: z.literal(2),
  adapter_version: z.literal(CMAI_OPENCLAW_ADAPTER_VERSION),
  pairing: legacyPairingSchema,
  pending_run: legacyPendingRunSchema.optional(),
  preview: persistedPreviewSchema.optional(),
}).strict().superRefine((state, context) => {
  if (state.pending_run && state.preview) {
    context.addIssue({ code: "custom", path: ["preview"], message: "A pending run approval and a validated preview cannot coexist." });
  }
});

const stateSchemaV3 = z.object({
  schema_version: z.literal(3),
  adapter_version: z.literal(CMAI_OPENCLAW_ADAPTER_VERSION),
  pairing: legacyPairingSchema,
  pending_run: legacyPendingRunSchema.optional(),
  preview: persistedPreviewSchema.optional(),
}).strict().superRefine((state, context) => {
  if (state.pending_run && state.preview) {
    context.addIssue({ code: "custom", path: ["preview"], message: "A pending run approval and a validated preview cannot coexist." });
  }
});

const stateSchemaV4WithLegacyConsumer = z.object({
  schema_version: z.literal(4),
  adapter_version: z.literal(CMAI_OPENCLAW_ADAPTER_VERSION),
  pairing: legacyPairingSchema,
  pending_run: legacyPendingRunSchema.optional(),
  preview: persistedPreviewSchema.optional(),
}).strict().superRefine((state, context) => {
  if (state.pending_run && state.preview) {
    context.addIssue({ code: "custom", path: ["preview"], message: "A pending run approval and a validated preview cannot coexist." });
  }
});

const stateSchemaV4 = z.object({
  schema_version: z.literal(4),
  adapter_version: z.literal(CMAI_OPENCLAW_ADAPTER_VERSION),
  pairing: legacyPairingSchema,
  pending_run: pendingRunSchema.optional(),
  preview: persistedPreviewSchema.optional(),
}).strict().superRefine((state, context) => {
  if (state.pending_run && state.preview) {
    context.addIssue({
      code: "custom",
      path: ["preview"],
      message: "A pending run approval and a validated preview cannot coexist.",
    });
  }
});

const stateSchema = z.object({
  schema_version: z.literal(5),
  adapter_version: z.literal(CMAI_OPENCLAW_ADAPTER_VERSION),
  pairing: pairingSchema.optional(),
  retired_pairing: retiredPairingSchema.optional(),
  pending_run: pendingRunSchema.optional(),
  preview: persistedPreviewSchema.optional(),
}).strict().superRefine((state, context) => {
  if (Boolean(state.pairing) === Boolean(state.retired_pairing)) {
    context.addIssue({ code: "custom", path: ["pairing"], message: "State must contain exactly one active or retired pairing projection." });
  }
  if (state.retired_pairing && Boolean(state.preview) === Boolean(state.pending_run)) {
    context.addIssue({ code: "custom", path: ["retired_pairing"], message: "A retired pairing must retain exactly one public preview or consumed pending run." });
  }
  if (state.retired_pairing && state.pending_run && (!state.pending_run.consumed_at || !state.pending_run.consumer)) {
    context.addIssue({ code: "custom", path: ["pending_run"], message: "A retired pairing may retain only a consumed pending run." });
  }
  if (state.pending_run && state.preview) {
    context.addIssue({
      code: "custom",
      path: ["preview"],
      message: "A pending run approval and a validated preview cannot coexist.",
    });
  }
});

export type OpenClawPendingRun = z.infer<typeof pendingRunSchema>;
export type OpenClawPersistedPreview = z.infer<typeof persistedPreviewSchema>;
export type OpenClawActivePairing = z.infer<typeof pairingSchema>;
export type OpenClawAdapterStoredState = z.infer<typeof stateSchema>;
export type OpenClawRunConsumer = z.infer<typeof runConsumerSchema>;
export type OpenClawPairingClearResult = "cleared" | "active" | "changed";

type LockOwner = z.infer<typeof lockOwnerSchema>;
type RecoverableLock = { owner?: LockOwner };

function neutralizePersistedRunResult(
  result: z.infer<typeof persistedRunResultSchema>,
): z.infer<typeof persistedRunResultSchema> {
  const audit = pairedAdapterRunAuditMetadataSchema.parse({
    runtime: result.identity.runtime,
    ...(result.identity.runtimeVersion ? { runtime_version: result.identity.runtimeVersion } : {}),
    adapter_name: result.identity.adapterName,
    adapter_version: result.identity.adapterVersion,
    local_run_id: result.localRunId,
    ...(result.providerClaim ? { provider_claim: result.providerClaim } : {}),
    ...(result.modelClaim ? { model_claim: result.modelClaim } : {}),
    ...(result.modelDisplayNameClaim ? { model_display_name_claim: result.modelDisplayNameClaim } : {}),
    started_at: result.startedAt,
    completed_at: result.completedAt,
    structured_output_validated: true,
    user_approved_run: true,
    edited_after_run: false,
  });
  return persistedRunResultSchema.parse({
    ...result,
    card: normalizePairedAdapterContribution(result.card, audit),
  });
}

function neutralizePersistedPreview<T extends { result: z.infer<typeof persistedRunResultSchema> }>(preview: T): T {
  return { ...preview, result: neutralizePersistedRunResult(preview.result) };
}

async function migrateLegacyPendingRun(
  pending: z.infer<typeof legacyPendingRunSchema> | undefined,
): Promise<OpenClawPendingRun | undefined> {
  if (!pending) return undefined;
  if (!pending.consumed_at) return pendingRunSchema.parse(pending);
  const legacyConsumer = pending.consumer;
  if (!legacyConsumer) {
    return pendingRunSchema.parse({
      ...pending,
      consumer: {
        owner_kind: "legacy_unknown",
        token: randomUUID(),
        created_at: new Date().toISOString(),
      },
    });
  }
  const pid = legacyConsumer.pid;
  const processIdentity = legacyConsumer.process_identity;
  return pendingRunSchema.parse({
    ...pending,
    consumer: {
      ...legacyConsumer,
      owner_kind: "process",
      process_time_origin: "process_time_origin" in legacyConsumer
        ? legacyConsumer.process_time_origin
        : (pid === process.pid ? performance.timeOrigin : 0),
      ...(processIdentity ? { process_identity: processIdentity } : {}),
    },
  });
}

async function migrateStoredState(candidate: unknown): Promise<OpenClawAdapterStoredState | null | undefined> {
  const project = async (
    pairing: z.infer<typeof legacyPairingSchema>,
    preview?: OpenClawPersistedPreview,
    pendingRun?: OpenClawPendingRun,
  ): Promise<OpenClawAdapterStoredState | null> => {
    const activePairing = pairingSchema.safeParse(pairing);
    if (activePairing.success) {
      return stateSchema.parse({
        schema_version: 5,
        adapter_version: CMAI_OPENCLAW_ADAPTER_VERSION,
        pairing: activePairing.data,
        ...(pendingRun ? { pending_run: pendingRun } : {}),
        ...(preview ? { preview } : {}),
      });
    }
    if (
      pairing.requested_scopes.includes("contribution:submit")
      || pairing.pairing_state.granted_scopes.includes("contribution:submit")
    ) {
      const retainedPending = pendingRun?.consumed_at && pendingRun.consumer ? pendingRun : undefined;
      if (!preview && !retainedPending) return null;
      return stateSchema.parse({
        schema_version: 5,
        adapter_version: CMAI_OPENCLAW_ADAPTER_VERSION,
        retired_pairing: {
          kind: "retired_legacy_submit_authority",
          pairing_id: pairing.pairing_state.pairing_id,
          device_id: pairing.device.device_id,
          retired_at: new Date().toISOString(),
          reason: "legacy_contribution_submit_scope",
        },
        ...(retainedPending ? { pending_run: retainedPending } : {}),
        ...(preview ? { preview } : {}),
      });
    }
    throw new Error("CMAI OpenClaw legacy pairing does not match preview-only authority.");
  };

  const priorV4 = stateSchemaV4.safeParse(candidate);
  if (priorV4.success) {
    return project(priorV4.data.pairing, priorV4.data.preview, priorV4.data.pending_run);
  }
  const legacyV4 = stateSchemaV4WithLegacyConsumer.safeParse(candidate);
  if (legacyV4.success) {
    return project(
      legacyV4.data.pairing,
      legacyV4.data.preview ? neutralizePersistedPreview(legacyV4.data.preview) : undefined,
      legacyV4.data.pending_run ? await migrateLegacyPendingRun(legacyV4.data.pending_run) : undefined,
    );
  }
  const stateV3 = stateSchemaV3.safeParse(candidate);
  if (stateV3.success) {
    return project(
      stateV3.data.pairing,
      stateV3.data.preview ? neutralizePersistedPreview(stateV3.data.preview) : undefined,
      stateV3.data.pending_run ? await migrateLegacyPendingRun(stateV3.data.pending_run) : undefined,
    );
  }
  const previewIdentityV2 = stateSchemaV2WithPreviewIdentity.safeParse(candidate);
  if (previewIdentityV2.success) {
    return project(
      previewIdentityV2.data.pairing,
      previewIdentityV2.data.preview ? neutralizePersistedPreview(previewIdentityV2.data.preview) : undefined,
      previewIdentityV2.data.pending_run ? await migrateLegacyPendingRun(previewIdentityV2.data.pending_run) : undefined,
    );
  }
  const submissionIdentityV2 = stateSchemaV2WithSubmissionIdentity.safeParse(candidate);
  if (submissionIdentityV2.success) {
    const preview = submissionIdentityV2.data.preview;
    const migratedPreview = preview
      ? (() => {
          const { idempotency_key: _discardedSubmissionIdentity, ...previewData } = preview;
          return neutralizePersistedPreview({ ...previewData, preview_id: `preview_${randomUUID().replaceAll("-", "")}` });
        })()
      : undefined;
    return project(
      submissionIdentityV2.data.pairing,
      migratedPreview,
      submissionIdentityV2.data.pending_run ? await migrateLegacyPendingRun(submissionIdentityV2.data.pending_run) : undefined,
    );
  }
  const pairingOnlyV1 = stateSchemaV1.safeParse(candidate);
  if (pairingOnlyV1.success) return project(pairingOnlyV1.data.pairing);
  return undefined;
}

function stateFile(stateDirectory: string): string {
  return join(resolve(stateDirectory), "state.json");
}

function permissions(mode: number): number {
  return mode & 0o777;
}

async function assertSafeDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("CMAI OpenClaw state path must be a real directory.");
  await chmod(path, 0o700);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readLockOwner(lockDirectory: string): Promise<LockOwner | undefined> {
  const ownerPath = join(lockDirectory, "owner.json");
  try {
    const info = await lstat(ownerPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4_096) return undefined;
    return lockOwnerSchema.parse(JSON.parse(await readFile(ownerPath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError || error instanceof z.ZodError) return undefined;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readProcessIdentity(pid: number): Promise<z.infer<typeof processIdentitySchema> | undefined> {
  try {
    const [bootIdRaw, statRaw] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    const closingParenthesis = statRaw.lastIndexOf(")");
    if (closingParenthesis < 0) return undefined;
    const fieldsAfterCommand = statRaw.slice(closingParenthesis + 2).trim().split(/\s+/);
    const startTicks = fieldsAfterCommand[19];
    if (!startTicks) return undefined;
    return processIdentitySchema.parse({ boot_id: bootIdRaw.trim(), start_ticks: startTicks });
  } catch {
    return undefined;
  }
}

export async function lockOwnerIsActive(
  owner: LockOwner,
  probes: {
    processIsAlive: (pid: number) => boolean;
    readProcessIdentity: typeof readProcessIdentity;
  } = { processIsAlive, readProcessIdentity },
): Promise<boolean> {
  if (!probes.processIsAlive(owner.pid)) return false;
  if (!owner.process_identity) return true;
  const current = await probes.readProcessIdentity(owner.pid);
  if (!current) return true;
  return current.boot_id === owner.process_identity.boot_id
    && current.start_ticks === owner.process_identity.start_ticks;
}

export async function createOpenClawRunConsumer(
  readIdentity: typeof readProcessIdentity = readProcessIdentity,
): Promise<OpenClawRunConsumer> {
  const processIdentity = await readIdentity(process.pid);
  if (!processIdentity) {
    throw new Error("CMAI OpenClaw cannot dispatch inference without durable process-incarnation identity.");
  }
  return runConsumerSchema.parse({
    owner_kind: "process",
    pid: process.pid,
    token: randomUUID(),
    created_at: new Date().toISOString(),
    process_identity: processIdentity,
    process_time_origin: performance.timeOrigin,
  });
}

export async function openClawRunConsumerIsActive(
  consumer: OpenClawRunConsumer,
  probes: {
    processIsAlive: (pid: number) => boolean;
    readProcessIdentity: typeof readProcessIdentity;
    currentPid?: number;
    currentProcessTimeOrigin?: number;
  } = { processIsAlive, readProcessIdentity },
): Promise<boolean> {
  if (consumer.owner_kind === "legacy_unknown") return true;
  if (!probes.processIsAlive(consumer.pid)) return false;
  if (consumer.process_identity) {
    const current = await probes.readProcessIdentity(consumer.pid);
    if (!current) return true;
    return current.boot_id === consumer.process_identity.boot_id
      && current.start_ticks === consumer.process_identity.start_ticks;
  }
  const currentPid = probes.currentPid ?? process.pid;
  const currentProcessTimeOrigin = probes.currentProcessTimeOrigin ?? performance.timeOrigin;
  if (consumer.pid === currentPid) {
    return consumer.process_time_origin === currentProcessTimeOrigin;
  }
  return true;
}

async function waitForLockRetry(): Promise<void> {
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, LOCK_RETRY_DELAY_MS));
}

function sameLockOwner(left: LockOwner | undefined, right: LockOwner | undefined): boolean {
  if (!left || !right) return left === right;
  return left.pid === right.pid
    && left.token === right.token
    && left.created_at === right.created_at
    && left.process_identity?.boot_id === right.process_identity?.boot_id
    && left.process_identity?.start_ticks === right.process_identity?.start_ticks;
}

async function inspectRecoverableLock(lockDirectory: string, nowMs: number): Promise<RecoverableLock | undefined> {
  const info = await lstat(lockDirectory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("CMAI OpenClaw local state lock is unsafe.");
  const owner = await readLockOwner(lockDirectory);
  if (owner) return await lockOwnerIsActive(owner) ? undefined : { owner };
  return nowMs - info.mtimeMs >= LOCK_LEASE_MS ? {} : undefined;
}

async function removeLockDirectory(lockDirectory: string): Promise<void> {
  try {
    await unlink(join(lockDirectory, "owner.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rmdir(lockDirectory);
}

async function removeOwnedLockDirectory(lockDirectory: string, token: string): Promise<boolean> {
  const owner = await readLockOwner(lockDirectory);
  if (owner?.token !== token) return false;
  await removeLockDirectory(lockDirectory);
  return true;
}

async function recoverLockDirectory(lockDirectory: string, nowMs: number): Promise<boolean> {
  let recoverable: RecoverableLock | undefined;
  try {
    recoverable = await inspectRecoverableLock(lockDirectory, nowMs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  if (!recoverable) return false;
  const quarantine = `${lockDirectory}.recovery-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockDirectory, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }

  const movedOwner = await readLockOwner(quarantine);
  const stable = sameLockOwner(recoverable.owner, movedOwner);
  if (!stable || (movedOwner && await lockOwnerIsActive(movedOwner))) {
    try {
      await rename(quarantine, lockDirectory);
    } catch (error) {
      throw new Error("CMAI OpenClaw local state lock changed during stale-lock recovery.", { cause: error });
    }
    return false;
  }

  await removeLockDirectory(quarantine);
  return true;
}

export class OpenClawAdapterStateStore {
  constructor(private readonly stateDirectory: string) {
    if (!stateDirectory.trim()) throw new Error("CMAI OpenClaw state directory is required.");
  }

  async load(): Promise<OpenClawAdapterStoredState | undefined> {
    const candidate = await this.readCandidateUnlocked();
    if (candidate === undefined) return undefined;
    const current = stateSchema.safeParse(candidate);
    if (current.success) return current.data;
    const candidateMigration = await migrateStoredState(candidate);
    if (candidateMigration === undefined) {
      throw new Error("CMAI OpenClaw local pairing state failed strict validation.");
    }
    return this.withLock(async () => {
      const latestCandidate = await this.readCandidateUnlocked();
      if (latestCandidate === undefined) return undefined;
      const latest = stateSchema.safeParse(latestCandidate);
      if (latest.success) return latest.data;
      const migrated = await migrateStoredState(latestCandidate);
      if (migrated === undefined) throw new Error("CMAI OpenClaw local pairing state failed strict validation.");
      if (migrated === null) {
        await unlink(stateFile(this.stateDirectory));
        await syncDirectory(resolve(this.stateDirectory));
        return undefined;
      }
      await this.saveUnlocked(migrated);
      return migrated;
    });
  }

  private async readCandidateUnlocked(): Promise<unknown | undefined> {
    const path = stateFile(this.stateDirectory);
    let info;
    try {
      info = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const directoryInfo = await lstat(dirname(path));
    if (
      !directoryInfo.isDirectory()
      || directoryInfo.isSymbolicLink()
      || permissions(directoryInfo.mode) !== 0o700
      || !info.isFile()
      || info.isSymbolicLink()
      || permissions(info.mode) !== 0o600
      || info.size > MAX_STATE_BYTES
    ) {
      throw new Error("CMAI OpenClaw local pairing state is unsafe or malformed.");
    }
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  }

  private async readCurrentUnlocked(): Promise<OpenClawAdapterStoredState | undefined> {
    const candidate = await this.readCandidateUnlocked();
    if (candidate === undefined) return undefined;
    const current = stateSchema.safeParse(candidate);
    if (current.success) return current.data;
    const migrated = await migrateStoredState(candidate);
    if (migrated === null) {
      await unlink(stateFile(this.stateDirectory));
      await syncDirectory(resolve(this.stateDirectory));
      return undefined;
    }
    if (migrated) return migrated;
    throw new Error("CMAI OpenClaw local pairing state failed strict validation.");
  }

  async save(state: OpenClawAdapterStoredState): Promise<void> {
    await this.withLock(async () => this.saveUnlocked(state));
  }

  async saveIfAbsent(state: OpenClawAdapterStoredState): Promise<boolean> {
    return this.withLock(async () => {
      if (await this.readCandidateUnlocked() !== undefined) return false;
      await this.saveUnlocked(state);
      return true;
    });
  }

  async update(
    transform: (current: OpenClawAdapterStoredState) => OpenClawAdapterStoredState | undefined,
  ): Promise<OpenClawAdapterStoredState | undefined> {
    const directory = resolve(this.stateDirectory);
    return this.withLock(async () => {
      const current = await this.readCurrentUnlocked();
      if (!current) throw new Error("CMAI OpenClaw pairing state is unavailable.");
      const transformed = transform(current);
      if (!transformed) {
        await unlink(stateFile(directory));
        await syncDirectory(directory);
        return undefined;
      }
      const next = stateSchema.parse(transformed);
      await this.saveUnlocked(next);
      return next;
    });
  }

  async clearIfPairing(pairingId: string): Promise<OpenClawPairingClearResult> {
    const directory = resolve(this.stateDirectory);
    return this.withLock(async () => {
      const current = await this.readCurrentUnlocked();
      if (!current?.pairing || current.pairing.pairing_state.pairing_id !== pairingId) return "changed";
      if (
        current.pending_run?.consumed_at
        && current.pending_run.consumer
        && await openClawRunConsumerIsActive(current.pending_run.consumer)
      ) {
        return "active";
      }
      await unlink(stateFile(directory));
      await syncDirectory(directory);
      return "cleared";
    });
  }

  async clearPreviewIfId(previewId: string): Promise<boolean> {
    const directory = resolve(this.stateDirectory);
    return this.withLock(async () => {
      const current = await this.readCurrentUnlocked();
      if (current?.preview?.preview_id !== previewId) return false;
      if (current.retired_pairing) {
        await unlink(stateFile(directory));
        await syncDirectory(directory);
        return true;
      }
      const { preview: _discarded, ...pairingOnly } = current;
      await this.saveUnlocked(stateSchema.parse(pairingOnly));
      return true;
    });
  }

  async clear(): Promise<void> {
    const directory = resolve(this.stateDirectory);
    await this.withLock(async () => {
      try {
        await unlink(stateFile(directory));
        await syncDirectory(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    });
    try {
      await rmdir(dirname(stateFile(directory)));
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }

  private async saveUnlocked(state: OpenClawAdapterStoredState): Promise<void> {
    const parsed = stateSchema.parse(state);
    const directory = resolve(this.stateDirectory);
    const destination = stateFile(directory);
    const temporary = join(directory, `.state-${process.pid}-${Date.now()}-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(parsed)}\n`, { encoding: "utf8" });
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, destination);
      await syncDirectory(directory);
    } finally {
      await handle?.close();
      try {
        await unlink(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  private async withLock<T>(action: () => Promise<T>): Promise<T> {
    const directory = resolve(this.stateDirectory);
    await assertSafeDirectory(directory);
    const lockDirectory = join(directory, ".state-update.lock");
    const processIdentity = await readProcessIdentity(process.pid);
    const owner: LockOwner = {
      pid: process.pid,
      token: randomUUID(),
      created_at: new Date().toISOString(),
      ...(processIdentity ? { process_identity: processIdentity } : {}),
    };
    let acquired = false;
    for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS && !acquired; attempt += 1) {
      let createdDirectory = false;
      try {
        await mkdir(lockDirectory, { mode: 0o700 });
        createdDirectory = true;
        const handle = await open(join(lockDirectory, "owner.json"), "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(owner)}\n`, { encoding: "utf8" });
          await handle.sync();
        } finally {
          await handle.close();
        }
        await syncDirectory(lockDirectory);
        acquired = true;
      } catch (error) {
        if (createdDirectory) {
          try {
            await removeLockDirectory(lockDirectory);
          } catch {
            // Preserve the original acquisition error.
          }
          throw error;
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const recovered = await recoverLockDirectory(lockDirectory, Date.now());
        if (!recovered) {
          if (attempt === LOCK_ACQUIRE_ATTEMPTS - 1) {
            throw new Error("CMAI OpenClaw local state is busy; no approval was consumed.");
          }
          await waitForLockRetry();
          continue;
        }
        await syncDirectory(directory);
      }
    }
    if (!acquired) throw new Error("CMAI OpenClaw local state lock could not be acquired.");

    try {
      return await action();
    } finally {
      if (await removeOwnedLockDirectory(lockDirectory, owner.token)) {
        await syncDirectory(directory);
      }
    }
  }
}

export function createStoredPairingState(input: {
  device: OpenClawActivePairing["device"];
  publicKey: OpenClawActivePairing["public_key"];
  requestedScopes: OpenClawActivePairing["requested_scopes"];
  pairingState: OpenClawActivePairing["pairing_state"];
  signingKeyPkcs8: string;
}): OpenClawAdapterStoredState {
  return stateSchema.parse({
    schema_version: 5,
    adapter_version: CMAI_OPENCLAW_ADAPTER_VERSION,
    pairing: {
      device: input.device,
      public_key: input.publicKey,
      requested_scopes: input.requestedScopes,
      pairing_state: input.pairingState,
      signing_key_pkcs8: input.signingKeyPkcs8,
    },
  });
}
