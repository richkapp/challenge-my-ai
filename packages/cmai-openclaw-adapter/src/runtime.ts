import { join } from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { hashAgentProtocolPayload } from "../../../lib/agent-protocol/canonical";
import { CmaiAgentClient } from "../../cmai-agent-client/src/client";
import { evaluateOpenClawCompatibility } from "./constants";
import { CmaiOpenClawController, type OpenClawCommandResult, type OpenClawPendingRunClearResult, type OpenClawPendingRunConsumeResult } from "./controller";
import { createOpenClawPairingMaterial, restoreOpenClawSigner } from "./cryptoSigner";
import {
  bindOpenClawLlmComplete,
  CmaiOpenClawRuntimeAdapter,
  type OpenClawLlmCompleteBridge,
} from "./inference";
import {
  createOpenClawRunConsumer,
  createStoredPairingState,
  openClawRunConsumerIsActive,
  OpenClawAdapterStateStore,
  type OpenClawPendingRun,
} from "./stateStore";
import { FetchCmaiAgentTransport, PairingHydrationTransport, UnconfiguredTransport } from "./transport";

export type CmaiOpenClawPluginConfig = {
  baseUrl?: string;
  displayName: string;
};

export type ResolvedCmaiOpenClawConfig = {
  configured: boolean;
  config: CmaiOpenClawPluginConfig;
};

export type OpenClawCommandRuntimeContext = {
  agentId?: string;
  config?: unknown;
  llm?: OpenClawLlmCompleteBridge;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function configuredModelRef(value: unknown): string | undefined {
  const candidate = typeof value === "string"
    ? value.trim()
    : isRecord(value) && typeof value.primary === "string"
      ? value.primary.trim()
      : "";
  if (!candidate || candidate.length > 200 || !/^[^\s/]+\/[^\s]+$/.test(candidate)) return undefined;
  return candidate;
}

export function resolveOpenClawAgentModel(config: unknown, agentId: string): string | undefined {
  if (!isRecord(config) || !isRecord(config.agents)) return undefined;
  const agents = config.agents;
  const entries = Array.isArray(agents.list) ? agents.list : [];
  const entry = entries.find((candidate) => isRecord(candidate) && candidate.id === agentId);
  const agentModel = isRecord(entry) ? configuredModelRef(entry.model) : undefined;
  if (agentModel) return agentModel;
  return isRecord(agents.defaults) ? configuredModelRef(agents.defaults.model) : undefined;
}

export function resolveDefaultOpenClawAgentId(config: unknown): string {
  if (!isRecord(config) || !isRecord(config.agents)) return "main";
  const entries = Array.isArray(config.agents.list)
    ? config.agents.list.filter(isRecord)
    : [];
  const selected = entries.find((entry) => entry.default === true) ?? entries[0];
  const selectedId = typeof selected?.id === "string" ? selected.id.trim() : "";
  return selectedId || "main";
}

export function allowsExactOpenClawLlmTarget(config: unknown, model: string): boolean {
  if (!isRecord(config) || !isRecord(config.plugins) || !isRecord(config.plugins.entries)) return false;
  const entry = config.plugins.entries["cmai-openclaw"];
  if (!isRecord(entry) || !isRecord(entry.llm)) return false;
  const policy = entry.llm;
  if (policy.allowModelOverride !== true || policy.allowAgentIdOverride !== true) return false;
  if (!Array.isArray(policy.allowedModels)) return false;
  const allowedModels = policy.allowedModels
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => candidate.trim())
    .filter(Boolean);
  return !allowedModels.includes("*") && allowedModels.includes(model);
}

export function resolveCmaiOpenClawConfig(input: Record<string, unknown> | undefined): ResolvedCmaiOpenClawConfig {
  const candidate = input ?? {};
  const knownKeys = new Set(["baseUrl", "displayName"]);
  if (Object.keys(candidate).some((key) => !knownKeys.has(key))) {
    return { configured: false, config: { displayName: "OpenClaw Agent" } };
  }
  const displayName = typeof candidate.displayName === "string" && candidate.displayName.trim()
    ? candidate.displayName.trim().slice(0, 80)
    : "OpenClaw Agent";
  if (typeof candidate.baseUrl !== "string" || !candidate.baseUrl.trim()) {
    return { configured: false, config: { displayName } };
  }
  try {
    const transport = new FetchCmaiAgentTransport(candidate.baseUrl.trim());
    void transport;
  } catch {
    return { configured: false, config: { displayName } };
  }
  return { configured: true, config: { baseUrl: candidate.baseUrl.trim(), displayName } };
}

function samePendingRun(left: OpenClawPendingRun | undefined, right: OpenClawPendingRun): boolean {
  return Boolean(left) && hashAgentProtocolPayload(left) === hashAgentProtocolPayload(right);
}

function samePendingRunIdentity(left: OpenClawPendingRun | undefined, right: OpenClawPendingRun): boolean {
  if (!left) return false;
  const { consumed_at: _leftConsumed, consumer: _leftConsumer, ...leftIdentity } = left;
  const { consumed_at: _rightConsumed, consumer: _rightConsumer, ...rightIdentity } = right;
  return hashAgentProtocolPayload(leftIdentity) === hashAgentProtocolPayload(rightIdentity);
}

async function buildController(
  api: OpenClawPluginApi,
  commandContext?: OpenClawCommandRuntimeContext,
): Promise<CmaiOpenClawController> {
  const resolved = resolveCmaiOpenClawConfig(api.pluginConfig);
  const stateDirectory = join(api.runtime.state.resolveStateDir(), "cmai-openclaw");
  const stateStore = new OpenClawAdapterStateStore(stateDirectory);
  let stored = await stateStore.load();
  const platformTransport = resolved.config.baseUrl
    ? new FetchCmaiAgentTransport(resolved.config.baseUrl)
    : new UnconfiguredTransport();
  let client: CmaiAgentClient;

  if (stored?.pairing) {
    const signer = restoreOpenClawSigner(stored.pairing.public_key.key_id, stored.pairing.signing_key_pkcs8);
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

  const effectiveConfig = commandContext?.config ?? api.config;
  const agentId = commandContext
    ? commandContext.agentId?.trim() || undefined
    : resolveDefaultOpenClawAgentId(effectiveConfig);
  const activeModel = agentId ? resolveOpenClawAgentModel(effectiveConfig, agentId) : undefined;
  const restoredPairingId = stored?.pairing?.pairing_state.pairing_id ?? stored?.retired_pairing?.pairing_id;
  const llmCapability = commandContext ? commandContext.llm : api.runtime.llm;
  const llm = llmCapability && typeof llmCapability.complete === "function"
    ? bindOpenClawLlmComplete({ llm: llmCapability })
    : undefined;
  const inferencePolicyReady = Boolean(activeModel && allowsExactOpenClawLlmTarget(effectiveConfig, activeModel));

  return new CmaiOpenClawController({
    client,
    compatibility: evaluateOpenClawCompatibility(api.runtime.version),
    runtimeVersion: api.runtime.version,
    configured: resolved.configured,
    displayName: resolved.config.displayName,
    pendingRun: stored?.pending_run,
    previewId: stored?.preview?.preview_id,
    detachedPreview: stored?.retired_pairing ? stored.preview : undefined,
    retiredPairing: Boolean(stored?.retired_pairing),
    pairingId: restoredPairingId,
    agentId,
    activeModel,
    inferencePolicyReady,
    ...(llm && agentId && activeModel && inferencePolicyReady ? {
      createRuntimeAdapter: (approval) => new CmaiOpenClawRuntimeAdapter({
        llm,
        runtimeVersion: api.runtime.version,
        approval,
      }),
    } : {}),
    createPairingMaterial: createOpenClawPairingMaterial,
    persistPairing: async ({ material, pairing }) => {
      const candidate = createStoredPairingState({
        device: material.payload.device,
        publicKey: material.payload.public_key,
        requestedScopes: material.payload.requested_scopes,
        pairingState: pairing,
        signingKeyPkcs8: material.persistence.signingKeyPkcs8,
      });
      const persisted = await stateStore.saveIfAbsent(candidate);
      stored = persisted ? candidate : await stateStore.load();
      return persisted;
    },
    clearPairing: async (expectedPairingId) => {
      const cleared = await stateStore.clearIfPairing(expectedPairingId);
      stored = cleared === "cleared" ? undefined : await stateStore.load();
      return cleared;
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
    consumePendingRun: async (pendingRun): Promise<OpenClawPendingRunConsumeResult> => {
      let consumer;
      try {
        consumer = await createOpenClawRunConsumer();
      } catch {
        return "identity_unavailable";
      }
      let consumed = false;
      stored = await stateStore.update((current) => {
        if (!current.pairing || !samePendingRun(current.pending_run, pendingRun) || current.pending_run?.consumed_at) return current;
        const consumedAt = Date.now();
        if (
          !Number.isFinite(consumedAt)
          || consumedAt >= Date.parse(pendingRun.approval_expires_at)
          || consumedAt >= Date.parse(pendingRun.run_grant.expires_at)
        ) {
          const { pending_run: _discarded, ...pairingOnly } = current;
          return pairingOnly;
        }
        consumed = true;
        return { ...current, pending_run: { ...pendingRun, consumed_at: new Date(consumedAt).toISOString(), consumer } };
      });
      return consumed ? "consumed" : "changed";
    },
    clearPendingRun: async (pendingRun) => {
      if (pendingRun.consumed_at && pendingRun.consumer && await openClawRunConsumerIsActive(pendingRun.consumer)) {
        return "active" satisfies OpenClawPendingRunClearResult;
      }
      let cleared = false;
      stored = await stateStore.update((current) => {
        if (!samePendingRun(current.pending_run, pendingRun)) return current;
        cleared = true;
        if (current.retired_pairing) return undefined;
        const { pending_run: _discarded, ...pairingOnly } = current;
        return pairingOnly;
      });
      return (cleared ? "cleared" : "changed") satisfies OpenClawPendingRunClearResult;
    },
    persistPreview: async (preview, consumedRun) => {
      let persisted = false;
      stored = await stateStore.update((current) => {
        if (current.preview || !current.pending_run?.consumed_at || !samePendingRunIdentity(current.pending_run, consumedRun)) return current;
        const activePairingMatches = Boolean(restoredPairingId) && current.pairing?.pairing_state.pairing_id === restoredPairingId;
        const retiredPairingMatches = Boolean(restoredPairingId) && current.retired_pairing?.pairing_id === restoredPairingId;
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

export async function executeOpenClawCommand(
  api: OpenClawPluginApi,
  argumentsText: string,
  commandContext?: OpenClawCommandRuntimeContext,
): Promise<OpenClawCommandResult> {
  if (argumentsText.length > 8_000) {
    return { ok: false, code: "command_too_large", text: "The cmai command exceeded the local 8 KB limit. Nothing ran." };
  }
  try {
    return await (await buildController(api, commandContext)).execute(argumentsText);
  } catch {
    return {
      ok: false,
      code: "adapter_runtime_failed",
      text: "The CMAI OpenClaw adapter failed safely. No raw error, response content, or credential material was exposed.",
    };
  }
}
