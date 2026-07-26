import { randomUUID } from "node:crypto";
import type { AgentConnectionDelegation } from "@/lib/types";
import { assertAgentConnectionReady, assertNoChildRunSecrets, childRunDelegationConfig } from "@/lib/agent-home/connections";
import type { AgentConnection, AgentConnectionMetadataVerification, AgentConnectionRunRequest, AgentProviderAdapter, ChildRunDelegationConfig, ProviderDelegationGrant } from "@/lib/agent-home/providerAdapters";

export const oneRunDelegationStatuses = ["active", "consumed", "revoked", "expired"] as const;
export type OneRunDelegationStatus = (typeof oneRunDelegationStatuses)[number];

export class AgentDelegationError extends Error {
  constructor(readonly code: string, message: string, readonly issues: string[] = []) {
    super(message);
  }
}

export type OneRunDelegationRecord = {
  id: string;
  runId: string;
  challengeId: string;
  contributorId: string;
  connectionId: string;
  ownerId: string;
  provider: string;
  status: OneRunDelegationStatus;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  revokedAt?: string;
  revokedReason?: string;
  remainingRequests: number;
  delegation: AgentConnectionDelegation;
  childRunConfig: ChildRunDelegationConfig;
  metadataVerification: AgentConnectionMetadataVerification;
};

export type OneRunDelegationGrant = {
  record: OneRunDelegationRecord;
  delegation: AgentConnectionDelegation;
  childRunConfig: ChildRunDelegationConfig;
  metadataVerification: AgentConnectionMetadataVerification;
};

type StoredDelegationRecord = OneRunDelegationRecord & {
  connection: AgentConnection;
};

export type AgentDelegationService = {
  mintOneRunDelegation(connection: AgentConnection | undefined, request: AgentConnectionRunRequest): Promise<OneRunDelegationGrant>;
  consumeDelegation(delegationId: string, options?: { runId?: string }): Promise<OneRunDelegationRecord>;
  revokeDelegation(delegationId: string, reason?: string): Promise<OneRunDelegationRecord>;
  getDelegation(delegationId: string): OneRunDelegationRecord | undefined;
};

export type CreateAgentDelegationServiceOptions = {
  adapters: AgentProviderAdapter[];
  defaultTtlMs?: number;
  now?: () => Date;
  modelProxyUrl?: string;
};

const defaultTtlMs = 10 * 60 * 1000;

function delegationId(): string {
  return `del_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function publicRecord(record: StoredDelegationRecord): OneRunDelegationRecord {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { connection: _connection, ...safeRecord } = record;
  return {
    ...safeRecord,
    delegation: { ...safeRecord.delegation },
    childRunConfig: { ...safeRecord.childRunConfig },
    metadataVerification: { ...safeRecord.metadataVerification },
  };
}

export function createAgentDelegationService(options: CreateAgentDelegationServiceOptions): AgentDelegationService {
  const adapters = new Map(options.adapters.map((adapter) => [adapter.provider, adapter]));
  const records = new Map<string, StoredDelegationRecord>();
  const now = options.now || (() => new Date());
  const ttlMs = options.defaultTtlMs ?? defaultTtlMs;

  function adapterFor(connection: AgentConnection): AgentProviderAdapter {
    const adapter = adapters.get(connection.provider);
    if (!adapter) throw new AgentDelegationError("AGENT_PROVIDER_ADAPTER_MISSING", `No provider adapter is registered for ${connection.provider}.`);
    return adapter;
  }

  function assertActive(record: StoredDelegationRecord, requestedRunId?: string): void {
    if (record.status !== "active") throw new AgentDelegationError("ONE_RUN_DELEGATION_NOT_ACTIVE", `Delegation ${record.id} is ${record.status}.`);
    if (Date.parse(record.expiresAt) <= now().getTime()) {
      record.status = "expired";
      record.remainingRequests = 0;
      throw new AgentDelegationError("ONE_RUN_DELEGATION_EXPIRED", `Delegation ${record.id} has expired.`);
    }
    if (requestedRunId && requestedRunId !== record.runId) throw new AgentDelegationError("ONE_RUN_DELEGATION_RUN_MISMATCH", `Delegation ${record.id} is scoped to a different run.`);
    if (record.remainingRequests < 1) throw new AgentDelegationError("ONE_RUN_DELEGATION_USED", `Delegation ${record.id} has already been consumed.`);
  }

  return {
    async mintOneRunDelegation(connection, request) {
      let readyConnection: AgentConnection;
      try {
        readyConnection = assertAgentConnectionReady(connection, request, now());
      } catch (error) {
        const err = error as Error & { code?: string; issues?: string[] };
        throw new AgentDelegationError(err.code || "AGENT_CONNECTION_NOT_READY", err.message, err.issues || []);
      }

      const adapter = adapterFor(readyConnection);
      const expiresAt = new Date(now().getTime() + (request.expiresInMs ?? ttlMs)).toISOString();
      const requestedModel = request.requestedModel || readyConnection.defaultModel;
      const requestClass = request.requestClass || "contribution_card";
      const baseDelegation: AgentConnectionDelegation = {
        delegation_id: delegationId(),
        connection_id: readyConnection.id,
        agent_connection_id: readyConnection.id,
        provider: readyConnection.provider,
        allowed_model: requestedModel,
        allowed_request_class: requestClass,
        expires_at: expiresAt,
        max_spend_cents: request.maxSpendCents,
        max_requests: 1,
      };

      const adapterGrant = await adapter.mintDelegation({
        connection: readyConnection,
        request,
        delegation: baseDelegation,
        modelProxyUrl: options.modelProxyUrl,
      });

      const delegation: AgentConnectionDelegation = {
        ...adapterGrant.delegation,
        ...baseDelegation,
        max_requests: 1,
      };
      const adapterChildRunConfig = adapterGrant.childRunConfig as ChildRunDelegationConfig & Record<string, unknown>;
      const childRunConfig: ChildRunDelegationConfig & Record<string, unknown> = {
        ...adapterChildRunConfig,
        ...childRunDelegationConfig({ runId: request.runId, delegation, modelProxyUrl: adapterChildRunConfig.model_proxy_url || options.modelProxyUrl }),
      };
      assertNoChildRunSecrets({ delegation, childRunConfig }, "One-run delegation grant");

      const record: StoredDelegationRecord = {
        id: delegation.delegation_id || delegation.connection_id,
        runId: request.runId,
        challengeId: request.challengeId,
        contributorId: request.contributorId,
        connectionId: readyConnection.id,
        ownerId: readyConnection.ownerId,
        provider: readyConnection.provider,
        status: "active",
        createdAt: now().toISOString(),
        expiresAt,
        remainingRequests: 1,
        delegation,
        childRunConfig,
        metadataVerification: adapterGrant.metadataVerification,
        connection: readyConnection,
      };
      records.set(record.id, record);

      return {
        record: publicRecord(record),
        delegation: { ...delegation },
        childRunConfig: { ...childRunConfig },
        metadataVerification: { ...adapterGrant.metadataVerification },
      };
    },

    async consumeDelegation(delegationIdToConsume, options = {}) {
      const record = records.get(delegationIdToConsume);
      if (!record) throw new AgentDelegationError("ONE_RUN_DELEGATION_NOT_FOUND", `Delegation ${delegationIdToConsume} was not found.`);
      assertActive(record, options.runId);
      record.status = "consumed";
      record.remainingRequests = 0;
      record.consumedAt = now().toISOString();
      return publicRecord(record);
    },

    async revokeDelegation(delegationIdToRevoke, reason = "revoked") {
      const record = records.get(delegationIdToRevoke);
      if (!record) throw new AgentDelegationError("ONE_RUN_DELEGATION_NOT_FOUND", `Delegation ${delegationIdToRevoke} was not found.`);
      if (record.status === "active") {
        record.status = "revoked";
        record.remainingRequests = 0;
        record.revokedAt = now().toISOString();
        record.revokedReason = reason;
        await adapterFor(record.connection).revokeDelegation({ connection: record.connection, delegation: record.delegation, reason });
      }
      return publicRecord(record);
    },

    getDelegation(delegationIdToRead) {
      const record = records.get(delegationIdToRead);
      return record ? publicRecord(record) : undefined;
    },
  };
}

export function providerDelegationGrant(input: {
  delegation: AgentConnectionDelegation;
  request: AgentConnectionRunRequest;
  metadataVerification: AgentConnectionMetadataVerification;
  modelProxyUrl?: string;
}): ProviderDelegationGrant {
  const childRunConfig = childRunDelegationConfig({ runId: input.request.runId, delegation: input.delegation, modelProxyUrl: input.modelProxyUrl });
  return {
    delegation: input.delegation,
    childRunConfig,
    metadataVerification: input.metadataVerification,
  };
}
