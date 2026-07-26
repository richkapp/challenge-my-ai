import { createHash } from "node:crypto";
import {
  CMAI_TELEMETRY_CONTRACT,
  CMAI_TELEMETRY_CONTRACT_VERSION,
  telemetryEventDefinitions,
  telemetryEventNames,
  telemetryRetentionForEvent,
  type TelemetryEventName,
  type TelemetryPrivacyClass,
  type TelemetryPropertyRule,
} from "@/lib/telemetry/contract";
import {
  assertNoForbiddenTelemetryData,
  isTelemetryPseudonym,
  type TelemetryPseudonymKind,
} from "@/lib/telemetry/privacy";

export const telemetryModes = ["disabled", "local"] as const;
export type TelemetryMode = (typeof telemetryModes)[number];
export const telemetryEnvironments = ["test", "local", "preview", "production"] as const;
export type TelemetryEnvironment = (typeof telemetryEnvironments)[number];
export const telemetryProviders = ["disabled"] as const;
export type TelemetryProvider = (typeof telemetryProviders)[number];

export type TelemetryCollectorConfig = {
  mode: TelemetryMode;
  environment: TelemetryEnvironment;
  provider: TelemetryProvider;
  maxRecords?: number;
};

export type TelemetryDroppedProperty = {
  property: string;
  reason: "unknown_property" | "high_cardinality_or_invalid_value";
};

export type TelemetryPropertiesResult = {
  properties: Record<string, string | boolean>;
  droppedProperties: TelemetryDroppedProperty[];
};

export type TelemetryCollectInput = {
  eventId: string;
  occurredAt: string;
  subjectId?: string;
  properties?: Record<string, unknown>;
};

export type LocalTelemetryRecord = {
  contract: typeof CMAI_TELEMETRY_CONTRACT;
  contractVersion: typeof CMAI_TELEMETRY_CONTRACT_VERSION;
  eventVersion: 1;
  event: TelemetryEventName;
  eventId: string;
  occurredAt: string;
  environment: TelemetryEnvironment;
  subjectId?: string;
  privacyClass: TelemetryPrivacyClass;
  retainedUntil: string;
  properties: Record<string, string | boolean>;
  suppressedAt?: string;
};

export type TelemetryCollectResult =
  | { status: "disabled"; stored: false }
  | { status: "deleted_subject"; stored: false }
  | { status: "duplicate"; stored: false; duplicateOf: string }
  | { status: "accepted" | "suppressed"; stored: true; record: LocalTelemetryRecord; droppedProperties: TelemetryDroppedProperty[] };

export class TelemetryContractError extends Error {
  constructor(
    readonly code:
      | "telemetry_config_invalid"
      | "telemetry_event_unknown"
      | "telemetry_event_id_invalid"
      | "telemetry_subject_id_invalid"
      | "telemetry_occurred_at_invalid"
      | "telemetry_required_property_missing"
      | "telemetry_transition_invalid"
      | "telemetry_provenance_invalid"
      | "telemetry_human_confirmation_required"
      | "telemetry_idempotency_conflict"
      | "telemetry_capacity_exceeded",
    message: string,
    readonly field?: string,
  ) {
    super(message);
    this.name = "TelemetryContractError";
  }
}

const provenanceTriplets = {
  self_submitted: {
    submissionMode: "manual_copy_paste",
    trustLabel: "self_attested",
    executionControl: "manual",
  },
  paired_local_agent: {
    submissionMode: "run_with_my_agent",
    trustLabel: "paired_self_controlled",
    executionControl: "paired_local",
  },
  cmai_sandbox: {
    submissionMode: "run_with_my_agent",
    trustLabel: "receipt_backed",
    executionControl: "cmai_controlled_sandbox",
  },
} as const;

const DEFAULT_LOCAL_TELEMETRY_RECORD_LIMIT = 10_000;
const DEDUPE_TOMBSTONE_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1_000;

export function telemetryConfigFromEnvironment(
  runtime: Record<string, string | undefined>,
): TelemetryCollectorConfig {
  const rawMode = runtime.CMAI_TELEMETRY_MODE || "disabled";
  const rawProvider = runtime.CMAI_TELEMETRY_PROVIDER || "disabled";
  const rawEnvironment = runtime.CMAI_RUNTIME_ENV || (runtime.NODE_ENV === "test" ? "test" : "local");

  if (!telemetryModes.includes(rawMode as TelemetryMode)) {
    throw new TelemetryContractError("telemetry_config_invalid", "CMAI_TELEMETRY_MODE must be disabled or local.", "CMAI_TELEMETRY_MODE");
  }
  if (!telemetryProviders.includes(rawProvider as TelemetryProvider)) {
    throw new TelemetryContractError("telemetry_config_invalid", "CMAI_TELEMETRY_PROVIDER must remain disabled in telemetry contract V1.", "CMAI_TELEMETRY_PROVIDER");
  }
  if (!telemetryEnvironments.includes(rawEnvironment as TelemetryEnvironment)) {
    throw new TelemetryContractError("telemetry_config_invalid", "CMAI_RUNTIME_ENV is not a supported telemetry environment.", "CMAI_RUNTIME_ENV");
  }
  if (rawMode === "local" && rawEnvironment === "production") {
    throw new TelemetryContractError("telemetry_config_invalid", "The in-memory local telemetry collector cannot run in production.", "CMAI_TELEMETRY_MODE");
  }

  return {
    mode: rawMode as TelemetryMode,
    provider: rawProvider as TelemetryProvider,
    environment: rawEnvironment as TelemetryEnvironment,
  };
}

export function sanitizeTelemetryProperties(
  event: TelemetryEventName,
  rawProperties: Record<string, unknown> = {},
): TelemetryPropertiesResult {
  const definition = telemetryEventDefinitions[event];
  if (!definition) {
    throw new TelemetryContractError("telemetry_event_unknown", `Unknown telemetry event: ${event}.`);
  }
  assertNoForbiddenTelemetryData(rawProperties);
  if (definition.properties.provenance_tier) assertProvenanceSemantics(rawProperties);

  const properties: Record<string, string | boolean> = {};
  const droppedProperties: TelemetryDroppedProperty[] = [];
  for (const [property, value] of Object.entries(rawProperties)) {
    const rule = definition.properties[property] as TelemetryPropertyRule | undefined;
    if (!rule) {
      droppedProperties.push({ property, reason: "unknown_property" });
      continue;
    }
    const sanitized = sanitizePropertyValue(rule, value);
    if (sanitized === undefined) {
      droppedProperties.push({ property, reason: "high_cardinality_or_invalid_value" });
      continue;
    }
    properties[property] = sanitized;
  }

  for (const [property, rule] of Object.entries(definition.properties) as [string, TelemetryPropertyRule][]) {
    if (rule.required && properties[property] === undefined) {
      throw new TelemetryContractError(
        "telemetry_required_property_missing",
        `${event} requires ${property}.`,
        `$.properties.${property}`,
      );
    }
  }

  assertTransitionSemantics(event, properties);
  assertSanitizedProvenanceSemantics(event, properties);
  assertHumanConfirmationSemantics(event, properties);
  return { properties, droppedProperties };
}

export class LocalTelemetryCollector {
  private readonly records = new Map<string, LocalTelemetryRecord>();
  private readonly dedupe = new Map<string, { fingerprint: string; expiresAt: string; eventId: string }>();
  private readonly suppressedSubjects = new Map<string, string>();
  private readonly deletedSubjects = new Map<string, string>();
  private readonly maxRecords: number;

  constructor(readonly config: TelemetryCollectorConfig) {
    if (!telemetryModes.includes(config.mode) || !telemetryProviders.includes(config.provider) || !telemetryEnvironments.includes(config.environment)) {
      throw new TelemetryContractError("telemetry_config_invalid", "Invalid local telemetry collector configuration.");
    }
    if (config.provider !== "disabled") {
      throw new TelemetryContractError("telemetry_config_invalid", "Telemetry contract V1 has no live provider integration.", "provider");
    }
    if (config.mode === "local" && config.environment === "production") {
      throw new TelemetryContractError("telemetry_config_invalid", "The in-memory local telemetry collector cannot run in production.", "mode");
    }
    this.maxRecords = config.maxRecords ?? DEFAULT_LOCAL_TELEMETRY_RECORD_LIMIT;
    if (!Number.isSafeInteger(this.maxRecords) || this.maxRecords < 1) {
      throw new TelemetryContractError("telemetry_config_invalid", "maxRecords must be a positive safe integer.", "maxRecords");
    }
  }

  collect(event: TelemetryEventName, input: TelemetryCollectInput): TelemetryCollectResult {
    if (this.config.mode === "disabled") return { status: "disabled", stored: false };
    if (!telemetryEventNames.includes(event)) {
      throw new TelemetryContractError("telemetry_event_unknown", `Unknown telemetry event: ${event}.`);
    }
    assertEventId(input.eventId);
    assertOccurredAt(input.occurredAt);
    const definition = telemetryEventDefinitions[event];
    if (definition.subjectRequired && !input.subjectId) {
      throw new TelemetryContractError("telemetry_subject_id_invalid", `${event} requires a pseudonymous subject ID.`, "$.subjectId");
    }
    if (input.subjectId && !isTelemetryPseudonym(input.subjectId)) {
      throw new TelemetryContractError("telemetry_subject_id_invalid", "Telemetry subjects must be pseudonymous IDs.", "$.subjectId");
    }
    if (input.subjectId && this.deletedSubjects.has(input.subjectId)) {
      return { status: "deleted_subject", stored: false };
    }

    const sanitized = sanitizeTelemetryProperties(event, input.properties);
    const retention = telemetryRetentionForEvent(event);
    const occurredAtMs = Date.parse(input.occurredAt);
    const retainedUntil = new Date(occurredAtMs + retention.retentionDays * DAY_MS).toISOString();
    const dedupeKey = `${event}:1:${input.eventId}`;
    const recordBase = {
      contract: CMAI_TELEMETRY_CONTRACT,
      contractVersion: CMAI_TELEMETRY_CONTRACT_VERSION,
      eventVersion: definition.eventVersion,
      event,
      eventId: input.eventId,
      occurredAt: input.occurredAt,
      environment: this.config.environment,
      ...(input.subjectId ? { subjectId: input.subjectId } : {}),
      privacyClass: definition.privacyClass,
      retainedUntil,
      properties: sanitized.properties,
    } satisfies LocalTelemetryRecord;
    const fingerprint = fingerprintRecord(recordBase);
    const existing = this.dedupe.get(dedupeKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new TelemetryContractError(
          "telemetry_idempotency_conflict",
          "The telemetry event ID was delivered with a different canonical payload.",
          "$.eventId",
        );
      }
      return { status: "duplicate", stored: false, duplicateOf: existing.eventId };
    }
    if (this.dedupe.size >= this.maxRecords || this.records.size >= this.maxRecords) {
      throw new TelemetryContractError("telemetry_capacity_exceeded", "Local telemetry collector capacity exceeded.");
    }

    const suppressedAt = input.subjectId ? this.suppressedSubjects.get(input.subjectId) : undefined;
    const record: LocalTelemetryRecord = suppressedAt ? { ...recordBase, suppressedAt } : recordBase;
    this.dedupe.set(dedupeKey, {
      fingerprint,
      eventId: input.eventId,
      expiresAt: new Date(occurredAtMs + Math.max(retention.retentionDays, DEDUPE_TOMBSTONE_DAYS) * DAY_MS).toISOString(),
    });
    this.records.set(dedupeKey, record);
    return {
      status: suppressedAt ? "suppressed" : "accepted",
      stored: true,
      record: cloneRecord(record),
      droppedProperties: sanitized.droppedProperties,
    };
  }

  list(options: { includeSuppressed?: boolean } = {}): LocalTelemetryRecord[] {
    return [...this.records.values()]
      .filter((record) => options.includeSuppressed || !record.suppressedAt)
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.eventId.localeCompare(right.eventId))
      .map(cloneRecord);
  }

  suppressSubject(subjectId: string, suppressedAt: string): number {
    assertSubjectId(subjectId);
    assertOccurredAt(suppressedAt);
    if (this.deletedSubjects.has(subjectId)) return 0;
    this.suppressedSubjects.set(subjectId, suppressedAt);
    let changed = 0;
    for (const [key, record] of this.records) {
      if (record.subjectId === subjectId && !record.suppressedAt) {
        this.records.set(key, { ...record, suppressedAt });
        changed += 1;
      }
    }
    return changed;
  }

  restoreSubject(subjectId: string): number {
    assertSubjectId(subjectId);
    if (this.deletedSubjects.has(subjectId)) return 0;
    this.suppressedSubjects.delete(subjectId);
    let changed = 0;
    for (const [key, record] of this.records) {
      if (record.subjectId === subjectId && record.suppressedAt) {
        const { suppressedAt: _suppressedAt, ...restored } = record;
        this.records.set(key, restored);
        changed += 1;
      }
    }
    return changed;
  }

  deleteSubject(subjectId: string, deletedAt: string): number {
    assertSubjectId(subjectId);
    assertOccurredAt(deletedAt);
    this.suppressedSubjects.delete(subjectId);
    this.deletedSubjects.set(subjectId, new Date(Date.parse(deletedAt) + DEDUPE_TOMBSTONE_DAYS * DAY_MS).toISOString());
    let deleted = 0;
    for (const [key, record] of this.records) {
      if (record.subjectId === subjectId) {
        this.records.delete(key);
        deleted += 1;
      }
    }
    return deleted;
  }

  purgeExpired(now: string): { records: number; dedupeTombstones: number; deletedSubjects: number } {
    assertOccurredAt(now);
    const nowMs = Date.parse(now);
    let records = 0;
    let dedupeTombstones = 0;
    let deletedSubjects = 0;
    for (const [key, record] of this.records) {
      if (Date.parse(record.retainedUntil) <= nowMs) {
        this.records.delete(key);
        records += 1;
      }
    }
    for (const [key, tombstone] of this.dedupe) {
      if (Date.parse(tombstone.expiresAt) <= nowMs) {
        this.dedupe.delete(key);
        dedupeTombstones += 1;
      }
    }
    for (const [subjectId, expiresAt] of this.deletedSubjects) {
      if (Date.parse(expiresAt) <= nowMs) {
        this.deletedSubjects.delete(subjectId);
        deletedSubjects += 1;
      }
    }
    return { records, dedupeTombstones, deletedSubjects };
  }
}

function sanitizePropertyValue(rule: TelemetryPropertyRule, value: unknown): string | boolean | undefined {
  if (rule.type === "boolean") return typeof value === "boolean" ? value : undefined;
  if (rule.type === "enum") return typeof value === "string" && rule.values.includes(value) ? value : undefined;
  return isTelemetryPseudonym(value, rule.kinds) ? value : undefined;
}

function assertProvenanceSemantics(properties: Record<string, unknown>): void {
  const provenance = properties.provenance_tier;
  const mode = properties.submission_mode;
  const trust = properties.trust_label;
  const executionControl = properties.execution_control;
  const hasAny = provenance !== undefined || mode !== undefined || trust !== undefined;
  if (!hasAny) return;
  if (typeof provenance !== "string" || typeof mode !== "string" || typeof trust !== "string") {
    throw new TelemetryContractError("telemetry_provenance_invalid", "Telemetry provenance requires tier, submission mode, and trust label together.", "$.properties.provenance_tier");
  }
  const expected = provenanceTriplets[provenance as keyof typeof provenanceTriplets];
  if (!expected || expected.submissionMode !== mode || expected.trustLabel !== trust || (executionControl !== undefined && executionControl !== expected.executionControl)) {
    throw new TelemetryContractError("telemetry_provenance_invalid", "Telemetry provenance cannot inflate manual, paired-local, or sandbox trust.", "$.properties.trust_label");
  }
}

function assertSanitizedProvenanceSemantics(event: TelemetryEventName, properties: Record<string, string | boolean>): void {
  const provenance = properties.provenance_tier;
  assertRunExecutionSemantics(event, properties);
  if (typeof provenance !== "string") return;
  if (provenance === "paired_local_agent") {
    if (!properties.pairing_id || !properties.run_id) {
      throw new TelemetryContractError("telemetry_provenance_invalid", `${event} requires pseudonymous pairing and run IDs for paired-local provenance.`);
    }
    if (properties.runtime && !["hermes", "openclaw"].includes(properties.runtime as string)) {
      throw new TelemetryContractError("telemetry_provenance_invalid", "Paired-local provenance must use a local Hermes or OpenClaw runtime.");
    }
  }
  if (provenance === "cmai_sandbox") {
    if (!properties.run_id) {
      throw new TelemetryContractError("telemetry_provenance_invalid", `${event} requires a pseudonymous run ID for sandbox provenance.`);
    }
    if (properties.runtime && properties.runtime !== "platform_sandbox") {
      throw new TelemetryContractError("telemetry_provenance_invalid", "Sandbox provenance must use the platform_sandbox runtime category.");
    }
    if (properties.pairing_id) {
      throw new TelemetryContractError("telemetry_provenance_invalid", "Sandbox provenance cannot claim a paired-local identifier.");
    }
  }
  if (provenance === "self_submitted" && (properties.pairing_id || properties.run_id || properties.runtime)) {
    throw new TelemetryContractError("telemetry_provenance_invalid", "Self-submitted telemetry cannot claim paired, run, or sandbox execution evidence.");
  }
}

function assertRunExecutionSemantics(event: TelemetryEventName, properties: Record<string, string | boolean>): void {
  if (!event.startsWith("run.")) return;
  const executionControl = properties.execution_control;
  const runtime = properties.runtime;
  const pairingId = properties.pairing_id;
  if (executionControl === "manual") {
    throw new TelemetryContractError("telemetry_provenance_invalid", "Approved Agent-run telemetry cannot claim manual execution control.");
  }
  if (executionControl === "paired_local" && (!pairingId || !["hermes", "openclaw"].includes(runtime as string))) {
    throw new TelemetryContractError("telemetry_provenance_invalid", "Paired-local run telemetry requires a pairing ID and a Hermes or OpenClaw runtime.");
  }
  if (executionControl === "cmai_controlled_sandbox" && (runtime !== "platform_sandbox" || pairingId)) {
    throw new TelemetryContractError("telemetry_provenance_invalid", "Sandbox run telemetry requires platform_sandbox and cannot claim a paired-local identifier.");
  }
}

function assertTransitionSemantics(event: TelemetryEventName, properties: Record<string, string | boolean>): void {
  const transition = telemetryEventDefinitions[event].transition;
  if (transition.kind !== "dynamic") return;
  const from = properties[transition.fromProperty];
  const to = properties[transition.toProperty];
  if (typeof from !== "string" || typeof to !== "string" || from === to) {
    throw new TelemetryContractError(
      "telemetry_transition_invalid",
      `${event} requires distinct allowlisted from/to states.`,
      `$.properties.${transition.fromProperty}`,
    );
  }
}

function assertHumanConfirmationSemantics(event: TelemetryEventName, properties: Record<string, string | boolean>): void {
  if ((event === "review.recorded" || event === "answer.version_created") && properties.poster_confirmed !== true) {
    throw new TelemetryContractError(
      "telemetry_human_confirmation_required",
      `${event} cannot represent an unconfirmed steward recommendation as a consequential action.`,
      "$.properties.poster_confirmed",
    );
  }
}

function assertEventId(eventId: string): void {
  if (!isTelemetryPseudonym(eventId, ["event"])) {
    throw new TelemetryContractError("telemetry_event_id_invalid", "Telemetry event IDs must be event pseudonyms.", "$.eventId");
  }
}

function assertSubjectId(subjectId: string): void {
  if (!isTelemetryPseudonym(subjectId)) {
    throw new TelemetryContractError("telemetry_subject_id_invalid", "Telemetry subjects must be pseudonymous IDs.", "$.subjectId");
  }
}

function assertOccurredAt(value: string): void {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new TelemetryContractError("telemetry_occurred_at_invalid", "Telemetry timestamps must be canonical UTC ISO timestamps.", "$.occurredAt");
  }
}

function fingerprintRecord(record: LocalTelemetryRecord): string {
  return createHash("sha256").update(stableJson(record), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
    .join(",")}}`;
}

function cloneRecord(record: LocalTelemetryRecord): LocalTelemetryRecord {
  return { ...record, properties: { ...record.properties } };
}
