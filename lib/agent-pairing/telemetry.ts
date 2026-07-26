import { randomBytes } from "node:crypto";
import {
  LocalTelemetryCollector,
  telemetryConfigFromEnvironment,
  type TelemetryCollectResult,
} from "@/lib/telemetry/collector";
import { pseudonymizeTelemetryId } from "@/lib/telemetry/privacy";
import {
  agentProtocolScopes,
  type AgentProtocolScope,
  type AgentRuntimeKind,
} from "@/lib/agent-protocol/constants";

export type PairingTelemetryScope =
  | "read"
  | "run"
  | "submit"
  | "manage"
  | "read_run"
  | "read_submit"
  | "read_manage"
  | "run_submit"
  | "run_manage"
  | "submit_manage"
  | "read_run_submit"
  | "read_run_manage"
  | "read_submit_manage"
  | "run_submit_manage"
  | "read_run_submit_manage";

const pairingTelemetryScopeToken: Record<AgentProtocolScope, string> = {
  "challenge:read": "read",
  "challenge:run": "run",
  "contribution:submit": "submit",
  "pairing:manage": "manage",
};

export function pairingTelemetryScope(grantedScopes: readonly AgentProtocolScope[]): PairingTelemetryScope {
  const ordered = agentProtocolScopes.filter((scope) => grantedScopes.includes(scope));
  if (ordered.length === 0 || ordered.length !== grantedScopes.length || new Set(grantedScopes).size !== grantedScopes.length) {
    throw new Error("Pairing telemetry requires a non-empty unique subset of protocol scopes.");
  }
  return ordered.map((scope) => pairingTelemetryScopeToken[scope]).join("_") as PairingTelemetryScope;
}

export type PairingTelemetryEvent =
  | {
      name: "pairing.created";
      eventId: string;
      ownerId: string;
      pairingId: string;
      runtime: AgentRuntimeKind;
      grantedScopes: AgentProtocolScope[];
    }
  | {
      name: "pairing.failed";
      eventId: string;
      subjectId: string;
      runtime: AgentRuntimeKind;
      failureBucket: "validation" | "authorization" | "conflict" | "expired" | "policy" | "internal" | "unknown";
    }
  | {
      name: "pairing.revoked";
      eventId: string;
      ownerId: string;
      pairingId: string;
      runtime: AgentRuntimeKind;
      reason: "user_requested" | "security_rotation" | "account_deleted" | "moderation";
      authority: "user" | "moderator" | "system_policy";
    };

export interface PairingTelemetrySink {
  emit(event: PairingTelemetryEvent): TelemetryCollectResult | void;
}

export class CmaiPairingTelemetrySink implements PairingTelemetrySink {
  constructor(
    private readonly collector: LocalTelemetryCollector,
    private readonly pseudonymSecret: string,
  ) {
    if (pseudonymSecret.length < 32) throw new Error("Pairing telemetry pseudonym secret must be at least 32 characters.");
  }

  emit(event: PairingTelemetryEvent): TelemetryCollectResult {
    const eventId = pseudonymizeTelemetryId("event", event.eventId, this.pseudonymSecret);
    const occurredAt = new Date().toISOString();
    if (event.name === "pairing.created") {
      return this.collector.collect(event.name, {
        eventId,
        occurredAt,
        subjectId: pseudonymizeTelemetryId("actor", event.ownerId, this.pseudonymSecret),
        properties: {
          pairing_id: pseudonymizeTelemetryId("pairing", event.pairingId, this.pseudonymSecret),
          runtime: event.runtime,
          pairing_scope: pairingTelemetryScope(event.grantedScopes),
        },
      });
    }
    if (event.name === "pairing.revoked") {
      return this.collector.collect(event.name, {
        eventId,
        occurredAt,
        subjectId: pseudonymizeTelemetryId("actor", event.ownerId, this.pseudonymSecret),
        properties: {
          pairing_id: pseudonymizeTelemetryId("pairing", event.pairingId, this.pseudonymSecret),
          runtime: event.runtime,
          revoke_reason: event.reason,
          decision_authority: event.authority,
        },
      });
    }
    return this.collector.collect(event.name, {
      eventId,
      occurredAt,
      subjectId: pseudonymizeTelemetryId("actor", event.subjectId, this.pseudonymSecret),
      properties: { runtime: event.runtime, failure_bucket: event.failureBucket },
    });
  }
}

export function pairingTelemetrySinkFromEnvironment(runtime: Record<string, string | undefined> = process.env): PairingTelemetrySink | undefined {
  const config = telemetryConfigFromEnvironment(runtime);
  if (config.mode === "disabled") return undefined;
  const secret = runtime.CMAI_TELEMETRY_PSEUDONYM_SECRET;
  if (!secret) throw new Error("CMAI_TELEMETRY_PSEUDONYM_SECRET is required when local telemetry is enabled.");
  return new CmaiPairingTelemetrySink(new LocalTelemetryCollector(config), secret);
}

export function randomPairingTelemetryEventId(): string {
  return `pairing_event_${randomBytes(16).toString("hex")}`;
}
