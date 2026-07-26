import { createInterface } from "node:readline";
import { CmaiAgentClient } from "../../cmai-agent-client/src/client";
import { evaluateHermesCompatibility } from "./constants";
import { CmaiHermesController, type HermesCommandResult } from "./controller";
import { createHermesPairingMaterial, restoreHermesSigner } from "./cryptoSigner";
import {
  CmaiHermesInferenceError,
  CmaiHermesRuntimeAdapter,
  type HermesStructuredCompletionBridge,
  type HermesStructuredCompletionRequest,
  type HermesStructuredCompletionResponse,
} from "./inference";
import {
  createHermesRunConsumer,
  createStoredPairingState,
  hermesRunConsumerIsActive,
  HermesAdapterStateStore,
  type HermesPendingRun,
} from "./stateStore";
import { FetchCmaiAgentTransport, PairingHydrationTransport } from "./transport";

const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_INFERENCE_FRAME_BYTES = 256 * 1024;
const DEFAULT_BASE_URL = "https://challenge-my-ai.vercel.app";

type WorkerRequest = { id: string; command: string };
type WorkerResponse = { id: string; result: HermesCommandResult };
type LineReader = AsyncIterator<string>;

function writeFrame(frame: unknown): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

async function nextLine(reader: LineReader, maxBytes: number): Promise<string> {
  const next = await reader.next();
  if (next.done || typeof next.value !== "string") throw new Error("Worker input ended before a complete frame.");
  if (Buffer.byteLength(next.value, "utf8") > maxBytes) throw new Error("Worker input frame exceeded the local limit.");
  return next.value;
}

function parseRequest(raw: string): WorkerRequest {
  const candidate = JSON.parse(raw) as unknown;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Worker command must be an object.");
  const record = candidate as Record<string, unknown>;
  if (Object.keys(record).some((key) => !["id", "command"].includes(key))) throw new Error("Worker command included unknown fields.");
  if (typeof record.id !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(record.id)) throw new Error("Worker request id is invalid.");
  if (typeof record.command !== "string" || record.command.length > 8_000) throw new Error("Worker command is invalid.");
  return { id: record.id, command: record.command };
}

function parseInferenceResponse(raw: string, requestId: string): HermesStructuredCompletionResponse {
  const candidate = JSON.parse(raw) as unknown;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("Inference response must be an object.");
  const record = candidate as Record<string, unknown>;
  if (record.id !== requestId || record.event !== "inference_result" || Object.keys(record).some((key) => !["id", "event", "result"].includes(key))) {
    throw new Error("Inference response identity or shape is invalid.");
  }
  if (!record.result || typeof record.result !== "object" || Array.isArray(record.result)) throw new Error("Inference result is invalid.");
  const result = record.result as Record<string, unknown>;
  if (Object.keys(result).some((key) => !["parsed", "provider", "model", "modelDisplayName"].includes(key))) {
    throw new Error("Inference result included unknown fields.");
  }
  for (const key of ["provider", "model", "modelDisplayName"] as const) {
    if (result[key] !== undefined && (typeof result[key] !== "string" || result[key].length > 500)) {
      throw new Error("Inference metadata is invalid.");
    }
  }
  return {
    parsed: result.parsed,
    ...(typeof result.provider === "string" ? { provider: result.provider } : {}),
    ...(typeof result.model === "string" ? { model: result.model } : {}),
    ...(typeof result.modelDisplayName === "string" ? { modelDisplayName: result.modelDisplayName } : {}),
  };
}

function samePendingRun(left: HermesPendingRun | undefined, right: HermesPendingRun): boolean {
  return Boolean(left) && JSON.stringify(left) === JSON.stringify(right);
}

function samePendingRunIdentity(left: HermesPendingRun | undefined, right: HermesPendingRun): boolean {
  return Boolean(left)
    && left?.pairing_id === right.pairing_id
    && left.challenge_id === right.challenge_id
    && left.challenge_revision === right.challenge_revision
    && left.challenge_hash === right.challenge_hash
    && left.run_grant.run_nonce === right.run_grant.run_nonce
    && left.prepared_at === right.prepared_at
    && left.consumer?.token === right.consumer?.token;
}

class WorkerInferenceBridge implements HermesStructuredCompletionBridge {
  constructor(private readonly requestId: string, private readonly reader: LineReader) {}

  async completeStructured(
    request: HermesStructuredCompletionRequest,
    options: { signal?: AbortSignal },
  ): Promise<HermesStructuredCompletionResponse> {
    if (options.signal?.aborted) throw new CmaiHermesInferenceError("inference_cancelled", "The approved Hermes inference call was cancelled.");
    writeFrame({ id: this.requestId, event: "inference_request", request });
    const raw = await nextLine(this.reader, MAX_INFERENCE_FRAME_BYTES);
    if (options.signal?.aborted) throw new CmaiHermesInferenceError("inference_cancelled", "The approved Hermes inference call was cancelled.");
    return parseInferenceResponse(raw, this.requestId);
  }
}

async function buildController(hostVersion: string, inferenceBridge: HermesStructuredCompletionBridge): Promise<CmaiHermesController> {
  const stateDirectory = process.env.CMAI_HERMES_STATE_DIR;
  if (!stateDirectory) throw new Error("CMAI_HERMES_STATE_DIR is required.");
  const stateStore = new HermesAdapterStateStore(stateDirectory);
  let stored = await stateStore.load();
  const profileName = process.env.CMAI_HERMES_PROFILE_NAME || "default";
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(profileName)) throw new Error("CMAI Hermes profile name is invalid.");
  const platformTransport = new FetchCmaiAgentTransport(process.env.CMAI_AGENT_BASE_URL || DEFAULT_BASE_URL);
  let client: CmaiAgentClient;

  if (stored?.pairing) {
    const signer = restoreHermesSigner(stored.pairing.public_key.key_id, stored.pairing.signing_key_pkcs8);
    const hydration = new PairingHydrationTransport(stored.pairing.pairing_state, platformTransport);
    client = new CmaiAgentClient({ transport: hydration });
    await client.pair({
      pairing_code: "RESTORE-ONLY",
      device: stored.pairing.device,
      public_key: stored.pairing.public_key,
      requested_scopes: stored.pairing.requested_scopes,
    }, signer);
    if (stored.preview) client.restorePreview(stored.preview);
  } else {
    client = new CmaiAgentClient({ transport: platformTransport });
  }

  return new CmaiHermesController({
    client,
    compatibility: evaluateHermesCompatibility(hostVersion),
    runtimeVersion: hostVersion,
    profileName,
    pendingRun: stored?.pending_run,
    previewId: stored?.preview?.preview_id,
    detachedPreview: stored?.retired_pairing ? stored.preview : undefined,
    retiredPairing: Boolean(stored?.retired_pairing),
    runtimeAdapter: new CmaiHermesRuntimeAdapter({ bridge: inferenceBridge, runtimeVersion: hostVersion }),
    createPairingMaterial: createHermesPairingMaterial,
    persistPairing: async ({ material, pairing }) => {
      const candidate = createStoredPairingState({
        device: material.payload.device,
        publicKey: material.payload.public_key,
        requestedScopes: material.payload.requested_scopes,
        pairingState: pairing,
        signingKeyPkcs8: material.persistence.signingKeyPkcs8,
      });
      const persisted = await stateStore.saveIfAbsent(candidate);
      if (persisted) stored = candidate;
      return persisted;
    },
    clearPairing: async (expectedPairingId) => {
      if (expectedPairingId) {
        const result = await stateStore.clearIfPairing(expectedPairingId);
        stored = result === "cleared" ? undefined : await stateStore.load();
        return result;
      }
      await stateStore.clear();
      stored = undefined;
      return "cleared";
    },
    persistPendingRun: async (pendingRun) => {
      let persisted = false;
      stored = await stateStore.update((current) => {
        if (!current.pairing || current.pending_run || current.preview) return current;
        persisted = true;
        return { ...current, pending_run: pendingRun };
      });
      return persisted;
    },
    consumePendingRun: async (pendingRun) => {
      let consumer;
      try {
        consumer = await createHermesRunConsumer();
      } catch {
        return "identity_unavailable";
      }
      let consumedRun: HermesPendingRun | undefined;
      stored = await stateStore.update((current) => {
        if (
          !samePendingRun(current.pending_run, pendingRun)
          || current.pending_run?.consumed_at
          || !current.pairing
          || current.pairing.pairing_state.pairing_id !== pendingRun.pairing_id
        ) return current;
        const consumedAt = Date.now();
        if (
          !Number.isFinite(consumedAt)
          || consumedAt >= Date.parse(pendingRun.approval_expires_at)
          || consumedAt >= Date.parse(pendingRun.run_grant.expires_at)
        ) {
          const { pending_run: _discarded, ...pairingOnly } = current;
          return pairingOnly;
        }
        consumedRun = {
          ...pendingRun,
          consumed_at: new Date(consumedAt).toISOString(),
          consumer,
        };
        return { ...current, pending_run: consumedRun };
      });
      return consumedRun ?? "changed";
    },
    clearPendingRun: async (pendingRun) => {
      if (pendingRun.consumed_at && pendingRun.consumer && await hermesRunConsumerIsActive(pendingRun.consumer)) {
        return "active";
      }
      let cleared = false;
      stored = await stateStore.update((current) => {
        if (!samePendingRunIdentity(current.pending_run, pendingRun)) return current;
        cleared = true;
        if (current.retired_pairing) return undefined;
        const { pending_run: _discarded, ...pairingOnly } = current;
        return pairingOnly;
      });
      return cleared ? "cleared" : "changed";
    },
    persistPreview: async (preview, consumedRun) => {
      let persisted = false;
      stored = await stateStore.update((current) => {
        if (
          current.preview
          || !current.pending_run?.consumed_at
          || !samePendingRunIdentity(current.pending_run, consumedRun)
        ) return current;
        const activePairingMatches = current.pairing?.pairing_state.pairing_id === consumedRun.pairing_id;
        const retiredPairingMatches = current.retired_pairing?.pairing_id === consumedRun.pairing_id;
        if (!activePairingMatches && !retiredPairingMatches) return current;
        persisted = true;
        const { pending_run: _discarded, ...pairingOnly } = current;
        return { ...pairingOnly, preview };
      });
      return persisted;
    },
    clearPreview: async (expectedPreviewId) => {
      const cleared = await stateStore.clearPreviewIfId(expectedPreviewId);
      stored = await stateStore.load();
      return cleared;
    },
  });
}

async function main(): Promise<void> {
  let request: WorkerRequest | undefined;
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const reader = lines[Symbol.asyncIterator]();
  try {
    request = parseRequest(await nextLine(reader, MAX_COMMAND_BYTES));
    const hostVersion = process.env.CMAI_HERMES_HOST_VERSION || "unknown";
    const controller = await buildController(hostVersion, new WorkerInferenceBridge(request.id, reader));
    const response: WorkerResponse = { id: request.id, result: await controller.execute(request.command) };
    writeFrame(response);
  } catch {
    const response: WorkerResponse = {
      id: request?.id || "invalid",
      result: {
        ok: false,
        code: "adapter_worker_failed",
        text: "The CMAI adapter worker failed safely. No raw error, response content, or credential material was exposed.",
      },
    };
    writeFrame(response);
    process.exitCode = 1;
  } finally {
    lines.close();
  }
}

await main();
