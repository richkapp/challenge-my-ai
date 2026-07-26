import {
  createPrivateKey,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import type { AgentPairCreateRequest } from "../../../lib/agent-protocol/schemas";
import type { CmaiAgentSigner } from "../../cmai-agent-client/src/types";
import { agentProtocolPreviewScopes } from "../../../lib/agent-protocol/constants";
import { CMAI_HERMES_ADAPTER_NAME, CMAI_HERMES_ADAPTER_VERSION } from "./constants";

export type PersistableHermesPairingMaterial = {
  signingKeyPkcs8: string;
};

export type HermesPairingMaterial = {
  signer: CmaiAgentSigner;
  payload: AgentPairCreateRequest["payload"];
  persistence: PersistableHermesPairingMaterial;
};

class Ed25519Signer implements CmaiAgentSigner {
  constructor(readonly keyId: string, private readonly signingKey: KeyObject) {}

  async sign(signingBytes: string): Promise<string> {
    return sign(null, Buffer.from(signingBytes, "utf8"), this.signingKey).toString("base64url");
  }
}

function rawPublicKey(publicKey: KeyObject): string {
  const der = publicKey.export({ type: "spki", format: "der" });
  if (!Buffer.isBuffer(der) || der.byteLength < 32) throw new Error("Ed25519 public key export failed.");
  return der.subarray(der.byteLength - 32).toString("base64url");
}

function opaqueId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function createHermesPairingMaterial(input: {
  pairingCode: string;
  displayName: string;
  runtimeVersion: string;
}): HermesPairingMaterial {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const keyId = opaqueId("key");
  const deviceId = opaqueId("device");
  const signingKeyPkcs8 = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url");
  return {
    signer: new Ed25519Signer(keyId, privateKey),
    payload: {
      pairing_code: input.pairingCode,
      device: {
        device_id: deviceId,
        display_name: input.displayName,
        runtime: "hermes",
        runtime_version: input.runtimeVersion,
        adapter_name: CMAI_HERMES_ADAPTER_NAME,
        adapter_version: CMAI_HERMES_ADAPTER_VERSION,
      },
      public_key: {
        key_id: keyId,
        algorithm: "ed25519",
        value: rawPublicKey(publicKey),
        generation: 1,
      },
      requested_scopes: [...agentProtocolPreviewScopes],
    },
    persistence: { signingKeyPkcs8 },
  };
}

export function restoreHermesSigner(keyId: string, signingKeyPkcs8: string): CmaiAgentSigner {
  const privateKey = createPrivateKey({
    key: Buffer.from(signingKeyPkcs8, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Stored pairing key is not Ed25519.");
  return new Ed25519Signer(keyId, privateKey);
}
