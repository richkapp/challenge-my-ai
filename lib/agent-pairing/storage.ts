import postgres from "postgres";
import { z } from "zod";
import { agentProtocolScopes, agentRuntimeKinds } from "@/lib/agent-protocol/constants";
import { agentProtocolErrorCodes } from "@/lib/agent-protocol/errors";
import { pairingStateSchema } from "@/lib/agent-protocol/schemas";
import { createAgentFeedTransactionalStore } from "@/lib/store/postgres";
import {
  AGENT_FEED_REQUEST_RETENTION_MS,
  AGENT_FEED_SUBMISSION_RETENTION_MS,
  assertAgentProtocolStateCoherence,
  type AgentFeedTransactionalStore,
} from "@/lib/store/agentFeed";
import {
  MAX_AUTHORIZED_READ_REQUEST_RECEIPTS,
  MAX_AUTHORIZED_REQUEST_RECEIPTS_TOTAL,
  MAX_AUTHORIZED_SUBMISSION_REQUEST_RECEIPTS,
  MAX_AUTHORIZED_SUBMISSION_REQUEST_RECEIPTS_PER_PAIRING,
  MAX_PAIRING_RATE_LIMIT_BUCKETS_TOTAL,
  PAIRING_STATE_SCHEMA_VERSION,
  type PairingPlatformState,
} from "@/lib/agent-pairing/types";

export const POSTGRES_PAIRING_STATE_TABLE = "cmai_agent_pairing_state" as const;
export const POSTGRES_PAIRING_STATE_ROW_ID = "default" as const;

export type PairingStateTransactionContext = {
  agentFeedStore?: AgentFeedTransactionalStore;
};

export type MemoryPairingTransactionSession = {
  agentFeedStore: AgentFeedTransactionalStore;
  assertCoherence(pairingState: PairingPlatformState): void;
  commit(): void;
};

export type MemoryPairingTransactionCoordinator = {
  begin(): MemoryPairingTransactionSession;
};

export interface PairingStateBackend {
  read(): Promise<PairingPlatformState>;
  transact<T>(operation: (state: PairingPlatformState, context: PairingStateTransactionContext) => T | Promise<T>): Promise<T>;
  resetForTests?(): Promise<void>;
  close?(): Promise<void>;
}

export function emptyPairingPlatformState(): PairingPlatformState {
  return {
    schemaVersion: PAIRING_STATE_SCHEMA_VERSION,
    codes: [],
    pairings: [],
    auditEvents: [],
    mutationReceipts: [],
    authorizedRequestReceipts: [],
    rateLimitBuckets: [],
  };
}

function clone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

const persistedIdentifierSchema = z.string().min(1).max(256);
const persistedHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const persistedDateSchema = z.string().datetime({ offset: true });
const scopeSchema = z.enum(agentProtocolScopes);
const runtimeSchema = z.enum(agentRuntimeKinds);

const pairingCodeRecordSchema = z.object({
  id: persistedIdentifierSchema,
  ownerId: persistedIdentifierSchema,
  codeHash: persistedHashSchema,
  expectedRuntime: runtimeSchema,
  expectedDisplayName: z.string().min(1).max(80),
  allowedScopes: z.array(scopeSchema).max(agentProtocolScopes.length),
  createdAt: persistedDateSchema,
  expiresAt: persistedDateSchema,
  consumedAt: persistedDateSchema.optional(),
  cancelledAt: persistedDateSchema.optional(),
  pairingId: persistedIdentifierSchema.optional(),
}).strict().superRefine((record, context) => {
  if (new Set(record.allowedScopes).size !== record.allowedScopes.length) {
    context.addIssue({ code: "custom", message: "Pairing-code scopes must be unique.", path: ["allowedScopes"] });
  }
  if (record.consumedAt && record.cancelledAt) {
    context.addIssue({ code: "custom", message: "Pairing code cannot be consumed and cancelled." });
  }
  if (record.pairingId && !record.consumedAt) {
    context.addIssue({ code: "custom", message: "Paired code must be consumed." });
  }
  const createdAt = Date.parse(record.createdAt);
  const expiresAt = Date.parse(record.expiresAt);
  if (expiresAt <= createdAt) {
    context.addIssue({ code: "custom", message: "Pairing-code expiry must follow creation.", path: ["expiresAt"] });
  }
  if (record.consumedAt && (Date.parse(record.consumedAt) < createdAt || Date.parse(record.consumedAt) > expiresAt)) {
    context.addIssue({ code: "custom", message: "Pairing-code consumption must fall within its lifetime.", path: ["consumedAt"] });
  }
  if (record.cancelledAt && Date.parse(record.cancelledAt) < createdAt) {
    context.addIssue({ code: "custom", message: "Pairing-code cancellation predates creation.", path: ["cancelledAt"] });
  }
});

const pairingKeyRecordSchema = z.object({
  keyId: persistedIdentifierSchema,
  algorithm: z.literal("ed25519"),
  generation: z.number().int().positive(),
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  status: z.enum(["active", "retired", "revoked"]),
  activatedAt: persistedDateSchema,
  retiredAt: persistedDateSchema.optional(),
  revokedAt: persistedDateSchema.optional(),
}).strict().superRefine((key, context) => {
  if (key.status === "active" && (key.retiredAt || key.revokedAt)) {
    context.addIssue({ code: "custom", message: "Active pairing key has terminal timestamps." });
  }
  if (key.status === "retired" && !key.retiredAt) {
    context.addIssue({ code: "custom", message: "Retired pairing key lacks retirement time." });
  }
  if (key.status === "revoked" && !key.revokedAt) {
    context.addIssue({ code: "custom", message: "Revoked pairing key lacks revocation time." });
  }
  const activatedAt = Date.parse(key.activatedAt);
  if (key.retiredAt && Date.parse(key.retiredAt) < activatedAt) {
    context.addIssue({ code: "custom", message: "Pairing key retirement predates activation.", path: ["retiredAt"] });
  }
  if (key.revokedAt && Date.parse(key.revokedAt) < activatedAt) {
    context.addIssue({ code: "custom", message: "Pairing key revocation predates activation.", path: ["revokedAt"] });
  }
});

const storedPairingSchema = z.object({
  pairingId: persistedIdentifierSchema,
  ownerId: persistedIdentifierSchema,
  device: z.object({
    deviceId: persistedIdentifierSchema,
    displayName: z.string().min(1).max(80),
    runtime: runtimeSchema,
    runtimeVersion: z.string().min(1).max(64).optional(),
    adapterName: z.string().min(1).max(64),
    adapterVersion: z.string().min(1).max(64),
  }).strict(),
  status: z.enum(["active", "revoked"]),
  grantedScopes: z.array(scopeSchema).max(agentProtocolScopes.length),
  keys: z.array(pairingKeyRecordSchema).min(1).max(20),
  createdAt: persistedDateSchema,
  updatedAt: persistedDateSchema,
  revokedAt: persistedDateSchema.optional(),
}).strict().superRefine((pairing, context) => {
  const activeKeys = pairing.keys.filter((key) => key.status === "active").length;
  if ((pairing.status === "active" && activeKeys !== 1) || (pairing.status === "revoked" && activeKeys !== 0)) {
    context.addIssue({ code: "custom", message: "Pairing/key status invariant is invalid.", path: ["keys"] });
  }
  if ((pairing.status === "revoked") !== (pairing.revokedAt !== undefined)) {
    context.addIssue({ code: "custom", message: "Pairing revocation timestamp invariant is invalid.", path: ["revokedAt"] });
  }
  if (new Set(pairing.grantedScopes).size !== pairing.grantedScopes.length) {
    context.addIssue({ code: "custom", message: "Granted scopes must be unique.", path: ["grantedScopes"] });
  }
  if (new Set(pairing.keys.map((key) => key.keyId)).size !== pairing.keys.length
    || new Set(pairing.keys.map((key) => key.generation)).size !== pairing.keys.length) {
    context.addIssue({ code: "custom", message: "Pairing key IDs and generations must be unique.", path: ["keys"] });
  }
  const createdAt = Date.parse(pairing.createdAt);
  const updatedAt = Date.parse(pairing.updatedAt);
  if (updatedAt < createdAt) {
    context.addIssue({ code: "custom", message: "Pairing update predates creation.", path: ["updatedAt"] });
  }
  if (pairing.revokedAt && (Date.parse(pairing.revokedAt) < createdAt || Date.parse(pairing.revokedAt) > updatedAt)) {
    context.addIssue({ code: "custom", message: "Pairing revocation falls outside the pairing lifetime.", path: ["revokedAt"] });
  }
});

const auditEventSchema = z.object({
  eventId: persistedIdentifierSchema,
  ownerId: persistedIdentifierSchema,
  pairingId: persistedIdentifierSchema.optional(),
  action: z.enum(["pairing_code_issued", "pairing_created", "device_renamed", "key_rotated", "key_revoked", "pairing_revoked"]),
  actor: z.enum(["owner_session", "paired_client", "system_policy"]),
  runtime: runtimeSchema,
  reason: z.enum(["user_requested", "security_rotation", "account_deleted", "moderation"]).optional(),
  createdAt: persistedDateSchema,
}).strict();

const mutationErrorSchema = z.discriminatedUnion("source", [
  z.object({
    kind: z.literal("error"),
    source: z.literal("protocol"),
    code: z.enum(agentProtocolErrorCodes),
    message: z.string().min(1).max(256),
    status: z.number().int().min(400).max(599),
    retryable: z.boolean(),
    field: z.string().min(1).max(128).optional(),
    retryAfterSeconds: z.number().int().positive().max(86_400).optional(),
  }).strict(),
  z.object({
    kind: z.literal("error"),
    source: z.literal("platform"),
    code: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/u),
    message: z.string().min(1).max(256),
    status: z.number().int().min(400).max(599),
    retryable: z.boolean(),
    retryAfterSeconds: z.number().int().positive().max(86_400).optional(),
  }).strict(),
]);

const mutationReceiptSchema = z.object({
  pairingId: persistedIdentifierSchema,
  requestId: persistedIdentifierSchema,
  operation: z.enum(["pairing.rotate_key", "pairing.revoke"]),
  requestHash: persistedHashSchema,
  outcome: z.union([
    z.object({ kind: z.literal("success"), pairingState: pairingStateSchema }).strict(),
    mutationErrorSchema,
  ]),
  createdAt: persistedDateSchema,
}).strict();

const authorizedReceiptSchema = z.object({
  pairingId: persistedIdentifierSchema,
  requestId: persistedIdentifierSchema,
  operation: z.enum(["feed.list", "challenge.get", "contribution.submit"]),
  requestHash: persistedHashSchema,
  createdAt: persistedDateSchema,
  expiresAt: persistedDateSchema,
}).strict().superRefine((record, context) => {
  const expectedRetention = record.operation === "contribution.submit"
    ? AGENT_FEED_SUBMISSION_RETENTION_MS
    : AGENT_FEED_REQUEST_RETENTION_MS;
  if (Date.parse(record.expiresAt) - Date.parse(record.createdAt) !== expectedRetention) {
    context.addIssue({ code: "custom", message: "Authorized receipt uses a non-canonical retention window.", path: ["expiresAt"] });
  }
});

const rateLimitBucketSchema = z.object({
  bucketHash: persistedHashSchema,
  capacityClass: z.string().min(1).max(96).optional(),
  count: z.number().int().positive(),
  resetAt: persistedDateSchema,
}).strict();

const pairingPlatformStateSchema = z.object({
  schemaVersion: z.literal(PAIRING_STATE_SCHEMA_VERSION),
  codes: z.array(pairingCodeRecordSchema).max(10_000),
  pairings: z.array(storedPairingSchema).max(10_000),
  auditEvents: z.array(auditEventSchema).max(50_000),
  mutationReceipts: z.array(mutationReceiptSchema).max(50_000),
  authorizedRequestReceipts: z.array(authorizedReceiptSchema).max(MAX_AUTHORIZED_REQUEST_RECEIPTS_TOTAL),
  rateLimitBuckets: z.array(rateLimitBucketSchema).max(MAX_PAIRING_RATE_LIMIT_BUCKETS_TOTAL),
}).strict().superRefine((state, context) => {
  const unique = (values: string[], path: string) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", message: `Persisted ${path} values must be unique.`, path: [path] });
    }
  };
  unique(state.codes.map((record) => record.id), "codes");
  unique(state.codes.map((record) => record.codeHash), "codes");
  unique(state.pairings.map((record) => record.pairingId), "pairings");
  unique(state.auditEvents.map((record) => record.eventId), "auditEvents");
  unique(state.mutationReceipts.map((record) => `${record.pairingId}\0${record.requestId}`), "mutationReceipts");
  unique(state.authorizedRequestReceipts.map((record) => `${record.pairingId}\0${record.requestId}`), "authorizedRequestReceipts");
  unique(state.rateLimitBuckets.map((record) => record.bucketHash), "rateLimitBuckets");

  const submissionReceipts = state.authorizedRequestReceipts.filter((receipt) => receipt.operation === "contribution.submit");
  const readReceiptCount = state.authorizedRequestReceipts.length - submissionReceipts.length;
  if (readReceiptCount > MAX_AUTHORIZED_READ_REQUEST_RECEIPTS) {
    context.addIssue({ code: "custom", message: "Persisted read authorization receipts exceed their reserved capacity.", path: ["authorizedRequestReceipts"] });
  }
  if (submissionReceipts.length > MAX_AUTHORIZED_SUBMISSION_REQUEST_RECEIPTS) {
    context.addIssue({ code: "custom", message: "Persisted submission authorization receipts exceed their reserved capacity.", path: ["authorizedRequestReceipts"] });
  }
  const submissionsPerPairing = new Map<string, number>();
  for (const receipt of submissionReceipts) {
    submissionsPerPairing.set(receipt.pairingId, (submissionsPerPairing.get(receipt.pairingId) ?? 0) + 1);
  }
  if ([...submissionsPerPairing.values()].some((count) => count > MAX_AUTHORIZED_SUBMISSION_REQUEST_RECEIPTS_PER_PAIRING)) {
    context.addIssue({ code: "custom", message: "Persisted submission authorization receipts exceed one pairing's reserved capacity.", path: ["authorizedRequestReceipts"] });
  }

  const pairings = new Map(state.pairings.map((pairing) => [pairing.pairingId, pairing]));
  for (const code of state.codes) {
    if (!code.pairingId) continue;
    const pairing = pairings.get(code.pairingId);
    if (!pairing || pairing.ownerId !== code.ownerId) {
      context.addIssue({ code: "custom", message: "Consumed pairing code must reference its matching pairing.", path: ["codes"] });
    }
  }
  for (const event of state.auditEvents) {
    if (!event.pairingId) continue;
    const pairing = pairings.get(event.pairingId);
    if (!pairing || pairing.ownerId !== event.ownerId || pairing.device.runtime !== event.runtime) {
      context.addIssue({ code: "custom", message: "Pairing audit event must reference its matching pairing audience.", path: ["auditEvents"] });
    }
  }
  for (const receipt of state.mutationReceipts) {
    if (!pairings.has(receipt.pairingId)) {
      context.addIssue({ code: "custom", message: "Pairing mutation receipt references a missing pairing.", path: ["mutationReceipts"] });
    }
    if (receipt.outcome.kind === "success" && receipt.outcome.pairingState.pairing_id !== receipt.pairingId) {
      context.addIssue({ code: "custom", message: "Pairing mutation success snapshot belongs to another pairing.", path: ["mutationReceipts"] });
    }
  }
  for (const receipt of state.authorizedRequestReceipts) {
    if (!pairings.has(receipt.pairingId)) {
      context.addIssue({ code: "custom", message: "Authorized request receipt references a missing pairing.", path: ["authorizedRequestReceipts"] });
    }
  }
});

export function assertPairingPlatformStateV1(raw: unknown): PairingPlatformState {
  const parsed = pairingPlatformStateSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const detail = first ? ` (${first.path.join(".") || "$"}: ${first.message})` : "";
    throw new Error(`Pairing state is missing or incompatible; apply the reviewed migration before serving Protocol traffic.${detail}`);
  }
  return clone(parsed.data) as PairingPlatformState;
}

export function normalizePairingPlatformState(raw: Partial<PairingPlatformState> | null | undefined): PairingPlatformState {
  if (raw?.schemaVersion !== undefined && raw.schemaVersion !== PAIRING_STATE_SCHEMA_VERSION) {
    throw new Error(`Unsupported pairing state schema version: ${String(raw.schemaVersion)}.`);
  }
  if (raw?.schemaVersion === PAIRING_STATE_SCHEMA_VERSION) return assertPairingPlatformStateV1(raw);
  return assertPairingPlatformStateV1({
    ...emptyPairingPlatformState(),
    ...(raw || {}),
    schemaVersion: PAIRING_STATE_SCHEMA_VERSION,
    codes: Array.isArray(raw?.codes) ? clone(raw.codes) : [],
    pairings: Array.isArray(raw?.pairings) ? clone(raw.pairings) : [],
    auditEvents: Array.isArray(raw?.auditEvents) ? clone(raw.auditEvents) : [],
    mutationReceipts: Array.isArray(raw?.mutationReceipts) ? clone(raw.mutationReceipts) : [],
    authorizedRequestReceipts: Array.isArray(raw?.authorizedRequestReceipts) ? clone(raw.authorizedRequestReceipts) : [],
    rateLimitBuckets: Array.isArray(raw?.rateLimitBuckets) ? clone(raw.rateLimitBuckets) : [],
  });
}

export class MemoryPairingStateBackend implements PairingStateBackend {
  private state: PairingPlatformState;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    initialState: Partial<PairingPlatformState> = {},
    private readonly transactionCoordinator?: MemoryPairingTransactionCoordinator,
  ) {
    this.state = normalizePairingPlatformState(initialState);
  }

  async read(): Promise<PairingPlatformState> {
    await this.queue;
    return clone(this.state);
  }

  async transact<T>(operation: (state: PairingPlatformState, context: PairingStateTransactionContext) => T | Promise<T>): Promise<T> {
    let release: (() => void) | undefined;
    const previous = this.queue;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const working = clone(this.state);
      const transactionSession = this.transactionCoordinator?.begin();
      transactionSession?.assertCoherence(working);
      const result = await operation(working, transactionSession ? { agentFeedStore: transactionSession.agentFeedStore } : {});
      const validatedState = normalizePairingPlatformState(working);
      transactionSession?.assertCoherence(validatedState);
      transactionSession?.commit();
      this.state = validatedState;
      return result;
    } finally {
      release?.();
    }
  }

  async resetForTests(): Promise<void> {
    await this.transact((state) => {
      Object.assign(state, emptyPairingPlatformState());
    });
  }
}

export class PostgresPairingStateBackend implements PairingStateBackend {
  private readonly client: ReturnType<typeof postgres>;

  constructor(databaseUrl: string) {
    if (!databaseUrl.trim()) throw new Error("DATABASE_URL is required for Postgres pairing persistence.");
    this.client = postgres(databaseUrl, { max: 2, prepare: false });
  }

  async read(): Promise<PairingPlatformState> {
    const rows = await this.client`
      SELECT state FROM cmai_agent_pairing_state
      WHERE id = ${POSTGRES_PAIRING_STATE_ROW_ID}
      LIMIT 1
    `;
    if (rows.length !== 1) throw new Error("Agent pairing state migration is required.");
    return assertPairingPlatformStateV1(rows[0]?.state);
  }

  async transact<T>(operation: (state: PairingPlatformState, context: PairingStateTransactionContext) => T | Promise<T>): Promise<T> {
    const result = await this.client.begin(async (transaction) => {
      const rows = await transaction`
        SELECT state FROM cmai_agent_pairing_state
        WHERE id = ${POSTGRES_PAIRING_STATE_ROW_ID}
        FOR UPDATE
      `;
      if (rows.length !== 1) throw new Error("Agent pairing state migration is required.");
      const state = assertPairingPlatformStateV1(rows[0]?.state);
      const initialFeedRows = await transaction`SELECT state FROM cmai_state WHERE id = 'default' FOR UPDATE`;
      if (initialFeedRows.length !== 1) throw new Error("Agent feed state migration is required.");
      assertAgentProtocolStateCoherence(state, initialFeedRows[0]?.state);
      const value = await operation(state, {
        agentFeedStore: createAgentFeedTransactionalStore(transaction),
      });
      const validatedState = assertPairingPlatformStateV1(state);
      const feedRows = await transaction`SELECT state FROM cmai_state WHERE id = 'default' FOR UPDATE`;
      if (feedRows.length !== 1) throw new Error("Agent feed state migration is required.");
      assertAgentProtocolStateCoherence(validatedState, feedRows[0]?.state);
      await transaction`
        UPDATE cmai_agent_pairing_state
        SET state = ${transaction.json(validatedState)}, updated_at = now()
        WHERE id = ${POSTGRES_PAIRING_STATE_ROW_ID}
      `;
      return value;
    });
    return result as T;
  }

  async resetForTests(): Promise<void> {
    await this.client`
      UPDATE cmai_agent_pairing_state
      SET state = ${this.client.json(emptyPairingPlatformState())}, updated_at = now()
      WHERE id = ${POSTGRES_PAIRING_STATE_ROW_ID}
    `;
  }

  async close(): Promise<void> {
    await this.client.end({ timeout: 1 });
  }
}
