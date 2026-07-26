import {
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { Buffer } from "node:buffer";
import {
  CMAI_AGENT_PROTOCOL,
  CMAI_AGENT_PROTOCOL_VERSION,
  agentProtocolScopes,
  type AgentProtocolOperation,
  type AgentProtocolScope,
  type AgentRuntimeKind,
} from "@/lib/agent-protocol/constants";
import { canonicalAgentSigningBytes } from "@/lib/agent-protocol/canonical";
import type { AgentPairCreateRequest } from "@/lib/agent-protocol/schemas";

export type PairingTestKey = {
  keyId: string;
  generation: number;
  publicKey: string;
  privateKey: KeyObject;
};

export function generatePairingTestKey(keyId = "key_test_1", generation = 1): PairingTestKey {
  const pair = generateKeyPairSync("ed25519");
  const jwk = pair.publicKey.export({ format: "jwk" });
  if (!jwk.x) throw new Error("Generated Ed25519 key did not expose x.");
  return { keyId, generation, publicKey: jwk.x, privateKey: pair.privateKey };
}

export function pairCreateRequest(input: {
  pairingCode: string;
  key: PairingTestKey;
  sentAt: string;
  requestId?: string;
  ownerLabel?: string;
  deviceId?: string;
  runtime?: AgentRuntimeKind;
  requestedScopes?: AgentProtocolScope[];
}): AgentPairCreateRequest {
  return {
    protocol: CMAI_AGENT_PROTOCOL,
    protocol_version: CMAI_AGENT_PROTOCOL_VERSION,
    operation: "pair.create",
    request_id: input.requestId || "req_pair_test_1",
    sent_at: input.sentAt,
    payload: {
      pairing_code: input.pairingCode,
      device: {
        device_id: input.deviceId || "device_test_1",
        display_name: input.ownerLabel || "Test Agent",
        runtime: input.runtime || "hermes",
        runtime_version: "1.0.0",
        adapter_name: input.runtime === "openclaw" ? "cmai-openclaw" : "cmai-hermes",
        adapter_version: "1.0.0",
      },
      public_key: {
        algorithm: "ed25519",
        key_id: input.key.keyId,
        generation: 1,
        value: input.key.publicKey,
      },
      requested_scopes: [...(input.requestedScopes ?? agentProtocolScopes)],
    },
  };
}

export function signAgentRequest<T extends {
  protocol: typeof CMAI_AGENT_PROTOCOL;
  protocol_version: typeof CMAI_AGENT_PROTOCOL_VERSION;
  operation: Exclude<AgentProtocolOperation, "pair.create">;
  request_id: string;
  sent_at: string;
  auth: {
    pairing_id: string;
    key_id: string;
    signature: { algorithm: "ed25519"; value: string };
  };
  payload: unknown;
}>(request: T, privateKey: KeyObject): T {
  const signingBytes = canonicalAgentSigningBytes({
    protocol: request.protocol,
    protocol_version: request.protocol_version,
    operation: request.operation,
    request_id: request.request_id,
    sent_at: request.sent_at,
    pairing_id: request.auth.pairing_id,
    key_id: request.auth.key_id,
    payload: request.payload,
  });
  return {
    ...request,
    auth: {
      ...request.auth,
      signature: {
        algorithm: "ed25519",
        value: sign(null, Buffer.from(signingBytes, "utf8"), privateKey).toString("base64url"),
      },
    },
  };
}

export function signedPairingRequest<TPayload>(input: {
  operation: Exclude<AgentProtocolOperation, "pair.create">;
  requestId: string;
  sentAt: string;
  pairingId: string;
  key: PairingTestKey;
  payload: TPayload;
}) {
  return signAgentRequest({
    protocol: CMAI_AGENT_PROTOCOL,
    protocol_version: CMAI_AGENT_PROTOCOL_VERSION,
    operation: input.operation,
    request_id: input.requestId,
    sent_at: input.sentAt,
    auth: {
      pairing_id: input.pairingId,
      key_id: input.key.keyId,
      signature: { algorithm: "ed25519" as const, value: "A".repeat(86) },
    },
    payload: input.payload,
  }, input.key.privateKey);
}
