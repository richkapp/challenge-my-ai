import {
  LocalTelemetryCollector,
  telemetryConfigFromEnvironment,
  type TelemetryCollectResult,
} from "@/lib/telemetry/collector";
import { pseudonymizeTelemetryId } from "@/lib/telemetry/privacy";
import type { AgentRuntimeKind } from "@/lib/agent-protocol/constants";

export type AgentFeedFailureBucket =
  | "validation"
  | "authorization"
  | "conflict"
  | "expired"
  | "unavailable"
  | "policy"
  | "internal"
  | "unknown";

export type AgentFeedTelemetryEvent =
  | {
      name: "feed.fetched";
      eventId: string;
      ownerId: string;
      runtime: AgentRuntimeKind;
      resultCount: number;
    }
  | {
      name: "feed.failed";
      eventId: string;
      ownerId: string;
      runtime: AgentRuntimeKind;
      failureBucket: AgentFeedFailureBucket;
    }
  | {
      name: "challenge.grant_issued";
      eventId: string;
      ownerId: string;
      pairingId: string;
      challengeId: string;
      runtime: AgentRuntimeKind;
    }
  | {
      name: "challenge.grant_failed";
      eventId: string;
      ownerId: string;
      pairingId: string;
      runtime: AgentRuntimeKind;
      failureBucket: AgentFeedFailureBucket;
    };

export interface AgentFeedTelemetrySink {
  emit(event: AgentFeedTelemetryEvent): TelemetryCollectResult | void;
}

function countBucket(count: number): "0" | "1" | "2_3" | "4_10" | "11_plus" {
  if (count <= 0) return "0";
  if (count === 1) return "1";
  if (count <= 3) return "2_3";
  if (count <= 10) return "4_10";
  return "11_plus";
}

export class CmaiAgentFeedTelemetrySink implements AgentFeedTelemetrySink {
  constructor(
    private readonly collector: LocalTelemetryCollector,
    private readonly pseudonymSecret: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (pseudonymSecret.length < 32) throw new Error("Agent feed telemetry pseudonym secret must be at least 32 characters.");
  }

  emit(event: AgentFeedTelemetryEvent): TelemetryCollectResult {
    const common = {
      eventId: pseudonymizeTelemetryId("event", event.eventId, this.pseudonymSecret),
      occurredAt: this.clock().toISOString(),
      subjectId: pseudonymizeTelemetryId("actor", event.ownerId, this.pseudonymSecret),
    };
    if (event.name === "feed.fetched") {
      return this.collector.collect(event.name, {
        ...common,
        properties: {
          runtime: event.runtime,
          feed_result: event.resultCount === 0 ? "empty" : "non_empty",
          result_count_bucket: countBucket(event.resultCount),
        },
      });
    }
    if (event.name === "feed.failed") {
      return this.collector.collect(event.name, {
        ...common,
        properties: { runtime: event.runtime, failure_bucket: event.failureBucket },
      });
    }
    if (event.name === "challenge.grant_issued") {
      return this.collector.collect(event.name, {
        ...common,
        properties: {
          runtime: event.runtime,
          pairing_id: pseudonymizeTelemetryId("pairing", event.pairingId, this.pseudonymSecret),
          challenge_id: pseudonymizeTelemetryId("challenge", event.challengeId, this.pseudonymSecret),
        },
      });
    }
    return this.collector.collect(event.name, {
      ...common,
      properties: {
        runtime: event.runtime,
        pairing_id: pseudonymizeTelemetryId("pairing", event.pairingId, this.pseudonymSecret),
        failure_bucket: event.failureBucket,
      },
    });
  }
}

export function agentFeedTelemetrySinkFromEnvironment(
  runtime: Record<string, string | undefined> = process.env,
): AgentFeedTelemetrySink | undefined {
  const config = telemetryConfigFromEnvironment(runtime);
  if (config.mode === "disabled") return undefined;
  const secret = runtime.CMAI_TELEMETRY_PSEUDONYM_SECRET;
  if (!secret) throw new Error("CMAI_TELEMETRY_PSEUDONYM_SECRET is required when local telemetry is enabled.");
  return new CmaiAgentFeedTelemetrySink(new LocalTelemetryCollector(config), secret);
}
