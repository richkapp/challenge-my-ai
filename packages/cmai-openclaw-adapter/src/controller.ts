import { randomUUID } from "node:crypto";
import { hashAgentProtocolPayload } from "../../../lib/agent-protocol/canonical";
import type { AgentPublicChallenge } from "../../../lib/agent-protocol/schemas";
import { pairedLocalContributionCardV1Schema } from "../../../lib/validation/contributionCardProtocol";
import type { CmaiAgentClient } from "../../cmai-agent-client/src/client";
import { CmaiAgentClientError } from "../../cmai-agent-client/src/errors";
import type { CmaiAgentRuntimeAdapter } from "../../cmai-agent-client/src/types";
import {
  CMAI_OPENCLAW_ADAPTER_VERSION,
  CMAI_OPENCLAW_PLUGIN_API_RANGE,
  CMAI_OPENCLAW_SUPPORTED_RANGE,
  type OpenClawCompatibility,
} from "./constants";
import type { OpenClawPairingMaterial } from "./cryptoSigner";
import {
  CMAI_OPENCLAW_INFERENCE_COST_ACKNOWLEDGEMENT,
  CMAI_OPENCLAW_INFERENCE_MAX_TOKENS,
  CMAI_OPENCLAW_INFERENCE_TIMEOUT_MS,
  CmaiOpenClawInferenceError,
  type OpenClawInferenceApproval,
} from "./inference";
import type { OpenClawPairingClearResult, OpenClawPendingRun, OpenClawPersistedPreview } from "./stateStore";

export type OpenClawCoreClient = Pick<
  CmaiAgentClient,
  "status" | "pair" | "feed" | "fetchChallenge" | "prepareRun" | "prepareRunWithApprovedGrant" | "preview" | "discardPreview" | "revoke"
>;

export type OpenClawCommandResult = { ok: boolean; code: string; text: string };
export type OpenClawPendingRunClearResult = "cleared" | "active" | "changed";
export type OpenClawPendingRunConsumeResult = "consumed" | "changed" | "identity_unavailable";

export type CmaiOpenClawControllerOptions = {
  client: OpenClawCoreClient;
  compatibility: OpenClawCompatibility;
  runtimeVersion: string;
  configured: boolean;
  displayName: string;
  createPairingMaterial: (input: {
    pairingCode: string;
    displayName: string;
    runtimeVersion: string;
  }) => OpenClawPairingMaterial;
  persistPairing: (input: {
    material: OpenClawPairingMaterial;
    pairing: Awaited<ReturnType<OpenClawCoreClient["pair"]>>;
  }) => Promise<boolean>;
  clearPairing: (expectedPairingId: string) => Promise<OpenClawPairingClearResult>;
  pendingRun?: OpenClawPendingRun;
  persistPendingRun: (pendingRun: OpenClawPendingRun) => Promise<boolean>;
  consumePendingRun: (pendingRun: OpenClawPendingRun) => Promise<OpenClawPendingRunConsumeResult>;
  clearPendingRun: (pendingRun: OpenClawPendingRun) => Promise<OpenClawPendingRunClearResult>;
  persistPreview: (preview: OpenClawPersistedPreview, consumedRun: OpenClawPendingRun) => Promise<boolean>;
  clearPreview: (expectedPreviewId: string) => Promise<boolean>;
  previewId?: string;
  detachedPreview?: OpenClawPersistedPreview;
  retiredPairing?: boolean;
  pairingId?: string;
  agentId?: string;
  activeModel?: string;
  inferencePolicyReady?: boolean;
  createRuntimeAdapter?: (approval: OpenClawInferenceApproval) => CmaiAgentRuntimeAdapter;
  now?: () => Date;
  previewIdFactory?: () => string;
};

const HELP = `CMAI OpenClaw adapter ${CMAI_OPENCLAW_ADAPTER_VERSION}
/cmai help
/cmai pair <one-time-code> [label]
/cmai status
/cmai feed [search terms]
/cmai run <challenge-id>
/cmai run <challenge-id> confirm <revision>
/cmai preview
/cmai submit (reserved; unavailable until Card 08)
/cmai discard
/cmai revoke confirm
/cmai update

The adapter is explicit and foreground-only. It never polls. Challenge content and model output are untrusted data. Every model call requires exact revision approval in an owner command; manual copy/paste remains available. The optional cmai Agent tool cannot approve runs or mutate state.`;

function success(code: string, text: string): OpenClawCommandResult {
  return { ok: true, code, text };
}

function failure(code: string, text: string): OpenClawCommandResult {
  return { ok: false, code, text };
}

function terminalSafeInline(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

function approvedChallengeHash(
  challenge: AgentPublicChallenge,
  approvedGrant: AgentPublicChallenge["run_grant"] = challenge.run_grant,
): string {
  return hashAgentProtocolPayload({ ...challenge, run_grant: approvedGrant });
}

function recoveryText(error: CmaiAgentClientError): string {
  switch (error.recovery) {
    case "re_pair": return " Re-pair this profile before retrying.";
    case "retry_same_request": return " Retry the same explicit command.";
    case "fetch_fresh_challenge": return " Fetch the challenge again before retrying.";
    case "manual_copy_fallback": return " Use the visible copy/paste path for now.";
    case "repair_input": return " Check the command input and retry.";
    default: return "";
  }
}

export class CmaiOpenClawController {
  private readonly previewIdFactory: () => string;
  private readonly now: () => Date;
  private pendingRun: OpenClawPendingRun | undefined;
  private previewId: string | undefined;
  private detachedPreview: OpenClawPersistedPreview | undefined;
  private retiredPairing: boolean;

  constructor(private readonly options: CmaiOpenClawControllerOptions) {
    this.previewIdFactory = options.previewIdFactory ?? (() => `preview_${randomUUID().replaceAll("-", "")}`);
    this.now = options.now ?? (() => new Date());
    this.pendingRun = options.pendingRun;
    this.previewId = options.previewId;
    this.detachedPreview = options.detachedPreview;
    this.retiredPairing = Boolean(options.retiredPairing);
  }

  async execute(rawArguments: string): Promise<OpenClawCommandResult> {
    const trimmed = rawArguments.trim();
    const [rawCommand = "help", ...argumentsList] = trimmed ? trimmed.split(/\s+/) : ["help"];
    const command = rawCommand.toLowerCase();

    if (command === "help") return success("help", HELP);
    if (command === "update") return this.update();
    if (!this.options.compatibility.supported) {
      return failure(
        "openclaw_version_incompatible",
        `CMAI OpenClaw adapter disabled: OpenClaw ${this.options.compatibility.installedVersion || "unknown"} is outside ${CMAI_OPENCLAW_SUPPORTED_RANGE} (plugin API ${CMAI_OPENCLAW_PLUGIN_API_RANGE}). No network or model call was made.`,
      );
    }
    if (command === "status") return this.status();
    if (!this.options.configured) {
      return failure(
        "adapter_unconfigured",
        "CMAI OpenClaw adapter is enabled but unconfigured. Set only plugins.entries.cmai-openclaw.config.baseUrl to an HTTPS CMAI origin (loopback HTTP is allowed for development). No network or model call was made.",
      );
    }

    try {
      switch (command) {
        case "pair": return await this.pair(argumentsList);
        case "feed": return await this.feed(argumentsList);
        case "run": return await this.run(argumentsList);
        case "preview": return this.preview();
        case "submit": return failure(
          "submission_unavailable",
          "Submission is not implemented in Card 07A. Inspect or discard the durable preview; Card 08 owns submission, retry, cleanup, and idempotency behavior.",
        );
        case "discard": return await this.discard();
        case "revoke": return await this.revoke(argumentsList);
        default: return failure("command_unknown", `Unknown cmai command: ${rawCommand}.\n\n${HELP}`);
      }
    } catch (error) {
      if (error instanceof CmaiAgentClientError) {
        return failure(error.code, `${error.message}${recoveryText(error)}`);
      }
      if (error instanceof CmaiOpenClawInferenceError) {
        return failure(error.code, `${error.message} Nothing was submitted.`);
      }
      return failure("adapter_internal_error", "The CMAI adapter failed safely. No response content or credential material was retained.");
    }
  }

  private status(): OpenClawCommandResult {
    if (!this.options.configured) {
      return failure(
        "adapter_unconfigured",
        `CMAI OpenClaw adapter ${CMAI_OPENCLAW_ADAPTER_VERSION}: enabled but unconfigured. No network or model call was made.`,
      );
    }
    if (this.detachedPreview) {
      return success("status", `CMAI OpenClaw adapter ${CMAI_OPENCLAW_ADAPTER_VERSION}: A public preview was preserved after its legacy submit-authorized signing key was removed from adapter state. Inspect it with /cmai preview, then /cmai discard before pairing again.`);
    }
    if (this.retiredPairing) {
      return success("status", `CMAI OpenClaw adapter ${CMAI_OPENCLAW_ADAPTER_VERSION}: The legacy submit-authorized signing key was removed from adapter state while a consumed run marker remains protected. Pairing stays blocked until that exact process finishes or is conclusively dead and the marker is discarded.`);
    }
    const snapshot = this.options.client.status();
    const detail = snapshot.phase === "unpaired"
      ? "Unpaired. Create a one-time code in Challenge My AI, then run /cmai pair <code>."
      : snapshot.phase === "preview"
        ? "A validated contribution preview is waiting for inspection or discard. Submission remains disabled until Card 08."
        : this.pendingRun
          ? this.pendingRun.consumed_at
            ? `The approved run for ${this.pendingRun.challenge_id} revision ${this.pendingRun.challenge_revision} is in flight or was interrupted; no duplicate will run.`
            : `A run approval is waiting for ${this.pendingRun.challenge_id} revision ${this.pendingRun.challenge_revision}.`
          : snapshot.phase === "paired"
            ? "Paired locally. Server state remains authoritative; use /cmai feed to find a public challenge."
            : `Shared client phase: ${snapshot.phase}.`;
    return success("status", `CMAI OpenClaw adapter ${CMAI_OPENCLAW_ADAPTER_VERSION}: ${detail}`);
  }

  private async pair(argumentsList: string[]): Promise<OpenClawCommandResult> {
    if (this.retiredPairing) {
      return failure("retired_preview_pending", this.detachedPreview
        ? "A public preview from a retired legacy pairing is still preserved. Inspect it with /cmai preview, then /cmai discard before pairing again."
        : "A consumed run from a retired legacy pairing is still protected. Wait for its preview or discard the marker only after its exact process owner is conclusively dead.");
    }
    const [pairingCode, ...labelParts] = argumentsList;
    if (!pairingCode) return failure("pairing_code_required", "Usage: /cmai pair <one-time-code> [device label]");
    const material = this.options.createPairingMaterial({
      pairingCode,
      displayName: labelParts.join(" ").trim() || this.options.displayName,
      runtimeVersion: this.options.runtimeVersion,
    });
    const pairing = await this.options.client.pair(material.payload, material.signer);
    try {
      const persisted = await this.options.persistPairing({ material, pairing });
      if (!persisted) throw new Error("Another pairing already owns this OpenClaw state.");
    } catch {
      let rollbackConfirmed = false;
      try {
        await this.options.client.revoke({ revoke: "pairing", reason: "rotation_cleanup" });
        await this.options.clearPairing(pairing.pairing_id);
        rollbackConfirmed = true;
      } catch {
        // The user receives a bounded recovery path below; raw failures stay private.
      }
      return failure(
        "local_pairing_state_failed",
        rollbackConfirmed
          ? "Local pairing state could not be stored, so the new server pairing was revoked. Repair the OpenClaw state path before pairing again."
          : "Local pairing state could not be stored and rollback could not be confirmed. Revoke this device in Challenge My AI before pairing again.",
      );
    }
    return success(
      "paired",
      `Paired this OpenClaw profile with Challenge My AI. Granted scopes: ${pairing.granted_scopes.join(", ")}. Provider credentials were not sent.`,
    );
  }

  private async feed(argumentsList: string[]): Promise<OpenClawCommandResult> {
    const query = argumentsList.join(" ").trim();
    const response = await this.options.client.feed({ limit: 10, ...(query ? { query } : {}) });
    if (response.challenges.length === 0) return success("feed_empty", "No matching public challenges were returned.");
    const rows = response.challenges.map((challenge) => (
      `${challenge.challenge_id} — ${terminalSafeInline(challenge.title)} — ${challenge.reward_credits} credits — ${challenge.requested_modes.join(", ")}`
    ));
    return success("feed", `Public CMAI challenges:\n${rows.join("\n")}${response.next_cursor ? "\nMore results are available." : ""}`);
  }

  private async run(argumentsList: string[]): Promise<OpenClawCommandResult> {
    const [challengeId, confirmation, requestedRevision, ...unexpected] = argumentsList;
    if (!challengeId || unexpected.length > 0) {
      return failure("challenge_id_required", "Usage: /cmai run <challenge-id> [confirm <revision>]");
    }
    const agentId = this.options.agentId;
    const activeModel = this.options.activeModel;
    if (!agentId || !activeModel) {
      return failure(
        "bounded_inference_unavailable",
        "OpenClaw did not expose a host-bound/default Agent with a canonical configured primary model. No network, model, or submission call occurred. Use the visible copy/paste path.",
      );
    }
    if (!this.options.inferencePolicyReady || !this.options.createRuntimeAdapter) {
      return failure(
        "bounded_inference_policy_required",
        `Bounded inference is disabled before network access. Set plugins.entries.cmai-openclaw.llm.allowModelOverride=true, allowAgentIdOverride=true, and allowedModels=["${terminalSafeInline(activeModel)}"] exactly; wildcard model access is rejected. Then rerun the command.`,
      );
    }

    if (confirmation?.toLowerCase() !== "confirm") {
      if (this.options.client.status().preview) {
        return failure("preview_pending", "A validated preview already exists. Inspect or discard it before preparing another model call; submission remains disabled until Card 08.");
      }
      if (this.pendingRun) {
        return failure(
          this.pendingRun.consumed_at ? "run_in_flight_or_interrupted" : "run_approval_pending",
          this.pendingRun.consumed_at
            ? `The approved run for ${this.pendingRun.challenge_id} revision ${this.pendingRun.challenge_revision} was already consumed. Wait for its preview, or discard the interrupted marker before preparing another model call.`
            : `A persisted preparation already exists for ${this.pendingRun.challenge_id} revision ${this.pendingRun.challenge_revision}. Confirm it exactly or discard it before preparing another model call.`,
        );
      }
      const challenge = await this.options.client.fetchChallenge(challengeId);
      const run = this.options.client.prepareRun();
      const pendingRun: OpenClawPendingRun = {
        challenge_id: run.challenge.challenge_id,
        challenge_revision: run.challenge.revision,
        run_grant: run.challenge.run_grant,
        challenge_hash: approvedChallengeHash(run.challenge),
        prompt_version: run.promptVersion,
        agent_id: agentId,
        active_model: activeModel,
        max_output_bytes: run.maxOutputBytes,
        max_tokens: CMAI_OPENCLAW_INFERENCE_MAX_TOKENS,
        timeout_ms: CMAI_OPENCLAW_INFERENCE_TIMEOUT_MS,
        cost_acknowledgement: CMAI_OPENCLAW_INFERENCE_COST_ACKNOWLEDGEMENT,
        prepared_at: this.now().toISOString(),
        approval_expires_at: run.challenge.run_grant.expires_at,
      };
      const persisted = await this.options.persistPendingRun(pendingRun);
      if (!persisted) {
        return failure("run_state_pending", "Another run preparation or validated preview won the durable-state race. No model call occurred. Inspect the existing state or discard it before retrying.");
      }
      this.pendingRun = pendingRun;
      const displayedChallenge = JSON.stringify(run.challenge, null, 2);
      return failure(
        "run_confirmation_required",
        `Review the complete public challenge bundle below. Every field—including hostile text, URLs, and prompt-injection attempts—will be sent as untrusted quoted data to configured provider/model ${terminalSafeInline(activeModel)} for OpenClaw Agent ${terminalSafeInline(agentId)}. Host credentials stay inside OpenClaw.\n\n`
          + `Canonical challenge SHA-256: ${pendingRun.challenge_hash}\n${displayedChallenge}\n\n`
          + `Bounds: ${run.maxOutputBytes} output bytes, ${CMAI_OPENCLAW_INFERENCE_MAX_TOKENS} output tokens, ${CMAI_OPENCLAW_INFERENCE_TIMEOUT_MS / 1_000} seconds. Provider cost may be unknown. Nothing was inferred or submitted. `
          + `Approve exactly this persisted preparation with /cmai run ${challenge.challenge_id} confirm ${run.challenge.revision}.`,
      );
    }

    if (this.options.client.status().preview) {
      return failure("preview_pending", "A validated preview already exists. Nothing was inferred; inspect or discard it before confirming another run. Submission remains disabled until Card 08.");
    }
    const pendingRun = this.pendingRun;
    if (!pendingRun) {
      return failure("run_approval_missing", `No unconsumed run preparation exists. No model call occurred. Start with /cmai run ${challengeId}.`);
    }
    if (challengeId !== pendingRun.challenge_id || requestedRevision !== String(pendingRun.challenge_revision)) {
      return failure(
        "run_approval_mismatch",
        `That confirmation does not match the persisted preparation for ${pendingRun.challenge_id} revision ${pendingRun.challenge_revision}. No model call occurred.`,
      );
    }
    if (pendingRun.consumed_at) {
      return failure("run_approval_consumed", "The persisted run approval was already consumed. No second model call occurred. Wait for its preview, or discard the interrupted marker before preparing again.");
    }
    const nowMs = this.now().getTime();
    if (!Number.isFinite(nowMs) || nowMs >= Date.parse(pendingRun.approval_expires_at) || nowMs >= Date.parse(pendingRun.run_grant.expires_at)) {
      const changed = await this.clearInvalidPreparation(pendingRun);
      if (changed) return changed;
      return failure("run_approval_expired", `The persisted preparation for ${challengeId} expired. No model call occurred. Fetch and review the challenge again.`);
    }
    if (
      pendingRun.agent_id !== agentId
      || pendingRun.active_model !== activeModel
      || pendingRun.max_tokens !== CMAI_OPENCLAW_INFERENCE_MAX_TOKENS
      || pendingRun.timeout_ms !== CMAI_OPENCLAW_INFERENCE_TIMEOUT_MS
      || pendingRun.cost_acknowledgement !== CMAI_OPENCLAW_INFERENCE_COST_ACKNOWLEDGEMENT
    ) {
      const changed = await this.clearInvalidPreparation(pendingRun);
      if (changed) return changed;
      return failure("run_approval_context_changed", "The active OpenClaw Agent, configured model, or bounded-call budget changed after preparation. No model call occurred. Fetch and review the challenge again.");
    }

    const refreshedChallenge = await this.options.client.fetchChallenge(challengeId);
    const refreshedGrant = refreshedChallenge.run_grant;
    const approvedGrant = pendingRun.run_grant;
    if (
      refreshedChallenge.challenge_id !== pendingRun.challenge_id
      || refreshedChallenge.revision !== pendingRun.challenge_revision
      || refreshedGrant.challenge_revision !== pendingRun.challenge_revision
      || refreshedGrant.request_class !== approvedGrant.request_class
      || refreshedGrant.prompt_version !== pendingRun.prompt_version
      || refreshedGrant.max_output_bytes !== pendingRun.max_output_bytes
      || approvedChallengeHash(refreshedChallenge, approvedGrant) !== pendingRun.challenge_hash
    ) {
      const changed = await this.clearInvalidPreparation(pendingRun);
      if (changed) return changed;
      return failure("run_approval_stale", "The approved challenge content, revision, prompt version, request class, or output budget changed after preparation. No model call occurred. Fetch and review the challenge again.");
    }

    const dispatchNowMs = this.now().getTime();
    if (
      !Number.isFinite(dispatchNowMs)
      || dispatchNowMs >= Date.parse(pendingRun.approval_expires_at)
      || dispatchNowMs >= Date.parse(approvedGrant.expires_at)
    ) {
      const changed = await this.clearInvalidPreparation(pendingRun);
      if (changed) return changed;
      return failure("run_approval_expired", `The persisted preparation for ${challengeId} expired before dispatch. No model call occurred. Fetch and review the challenge again.`);
    }

    let run;
    try {
      run = this.options.client.prepareRunWithApprovedGrant(approvedGrant);
    } catch {
      const changed = await this.clearInvalidPreparation(pendingRun);
      if (changed) return changed;
      return failure("run_approval_stale", "The approved run grant no longer matches the freshly validated challenge contract. No model call occurred. Fetch and review the challenge again.");
    }

    const consumed = await this.options.consumePendingRun(pendingRun);
    this.pendingRun = undefined;
    if (consumed === "identity_unavailable") {
      return failure("run_recovery_identity_unavailable", "OpenClaw could not prove a durable process incarnation, so this command did not consume approval or dispatch a model call. Restore process-identity access before retrying.");
    }
    if (consumed === "changed") {
      return failure("run_approval_consumed", "The persisted run approval was already consumed or replaced. This command did not dispatch another model call. Inspect status before taking another action.");
    }

    const approval: OpenClawInferenceApproval = {
      challengeId: pendingRun.challenge_id,
      challengeRevision: pendingRun.challenge_revision,
      runNonce: pendingRun.run_grant.run_nonce,
      promptVersion: pendingRun.prompt_version,
      requestClass: pendingRun.run_grant.request_class,
      agentId: pendingRun.agent_id,
      activeModel: pendingRun.active_model,
      maxOutputBytes: pendingRun.max_output_bytes,
      maxTokens: pendingRun.max_tokens,
      timeoutMs: pendingRun.timeout_ms,
      approvalExpiresAt: pendingRun.approval_expires_at,
      costAcknowledgement: pendingRun.cost_acknowledgement,
    };
    const result = await this.options.createRuntimeAdapter(approval).execute(run, {});
    const preview = this.options.client.preview(result, { userApprovedRun: true });
    const previewId = this.previewIdFactory();
    const persistedPreview: OpenClawPersistedPreview = {
      challenge: run.challenge,
      result: {
        identity: {
          runtime: "openclaw",
          ...(result.identity.runtimeVersion ? { runtimeVersion: result.identity.runtimeVersion } : {}),
          adapterName: "cmai-openclaw",
          adapterVersion: CMAI_OPENCLAW_ADAPTER_VERSION,
        },
        localRunId: result.localRunId,
        card: pairedLocalContributionCardV1Schema.parse(preview),
        ...(result.providerClaim ? { providerClaim: result.providerClaim } : {}),
        ...(result.modelClaim ? { modelClaim: result.modelClaim } : {}),
        ...(result.modelDisplayNameClaim ? { modelDisplayNameClaim: result.modelDisplayNameClaim } : {}),
        startedAt: result.startedAt,
        completedAt: result.completedAt,
        structuredOutputValidated: true,
      },
      preview_id: previewId,
      persisted_at: this.now().toISOString(),
    };
    try {
      const persisted = await this.options.persistPreview(persistedPreview, pendingRun);
      if (!persisted) {
        this.options.client.discardPreview();
        return failure("preview_state_conflict", "The model call completed, but another run preparation or preview won the durable-state race. This output was discarded and nothing was submitted.");
      }
      this.previewId = previewId;
    } catch {
      this.options.client.discardPreview();
      return failure("preview_persistence_failed", "The model call completed, but its validated preview could not be stored durably and was discarded. Nothing was submitted.");
    }
    return success(
      "run_preview_ready",
      `One bounded OpenClaw call completed. Inspect this complete validated contribution card:\n${JSON.stringify(preview, null, 2)}\n\nNothing was submitted. Card 07A stops at durable preview; discard with /cmai discard. Submission remains fail-closed until Card 08.`,
    );
  }

  private async clearInvalidPreparation(pendingRun: OpenClawPendingRun): Promise<OpenClawCommandResult | undefined> {
    const cleared = await this.options.clearPendingRun(pendingRun);
    if (cleared === "cleared") {
      this.pendingRun = undefined;
      return undefined;
    }
    return failure(
      "run_approval_state_changed",
      "The durable run approval changed while this command was validating it. No cleanup was claimed. Inspect status before retrying.",
    );
  }

  private preview(): OpenClawCommandResult {
    const card = this.detachedPreview?.result.card ?? this.options.client.status().preview?.card;
    if (!card) return failure("preview_missing", "No validated preview exists. Nothing can be submitted.");
    return success(
      "preview",
      `Inspect this complete validated contribution card:\n${JSON.stringify(card, null, 2)}\n\nCard 07A stops at durable preview. Submission remains fail-closed until Card 08; discard only with /cmai discard.`,
    );
  }


  private async discard(): Promise<OpenClawCommandResult> {
    const hasClientPreview = Boolean(this.options.client.status().preview);
    const hasPreview = hasClientPreview || Boolean(this.detachedPreview);
    const hadPendingRun = Boolean(this.pendingRun);
    if (hasPreview) {
      const expectedPreviewId = this.previewId;
      if (!expectedPreviewId) {
        return failure("preview_persistence_missing", "The validated preview is missing its durable identity. Nothing was discarded; repair or remove only this adapter's local state after inspection.");
      }
      const cleared = await this.options.clearPreview(expectedPreviewId);
      if (!cleared) {
        return failure("preview_state_changed", "The selected preview changed before cleanup. A newer validated preview was preserved; inspect it before taking another action.");
      }
      if (hasClientPreview) this.options.client.discardPreview();
      this.detachedPreview = undefined;
      this.previewId = undefined;
    }
    if (this.pendingRun) {
      const cleared = await this.options.clearPendingRun(this.pendingRun);
      if (cleared === "active") {
        return failure("run_inference_active", "The consumed approval is still owned by a live OpenClaw process incarnation. Nothing was discarded. Wait for the command to finish; after a crash, restart that process before explicit recovery.");
      }
      if (cleared === "changed") {
        return failure("pending_run_state_changed", "The selected run approval changed or was consumed before cleanup. Nothing was discarded; inspect status before taking another action.");
      }
      this.pendingRun = undefined;
    }
    if (hasPreview || hadPendingRun) this.retiredPairing = false;
    if (!hasPreview && !hadPendingRun) {
      return failure("discard_missing", "No local contribution preview or pending run approval exists. Nothing was submitted.");
    }
    return success("discarded", "The local contribution preview or pending run approval was discarded. Nothing was submitted.");
  }

  private async revoke(argumentsList: string[]): Promise<OpenClawCommandResult> {
    if (argumentsList[0]?.toLowerCase() !== "confirm") {
      return failure("revocation_confirmation_required", "Run /cmai revoke confirm to revoke the server pairing and delete this adapter's local pairing state.");
    }
    if (this.retiredPairing) {
      return failure("legacy_pairing_retired", "The legacy signing key was removed from adapter state and cannot authorize revocation. Revoke the old device in Challenge My AI, then inspect or recover the preserved local state before pairing again.");
    }
    const expectedPairingId = this.options.pairingId;
    if (!expectedPairingId) {
      return failure("pairing_state_missing", "The active pairing is missing its durable identity. Nothing was revoked.");
    }
    await this.options.client.revoke({ revoke: "pairing", reason: "user_requested" });
    try {
      const cleared = await this.options.clearPairing(expectedPairingId);
      if (cleared === "active") {
        return success("revoked_recovery_preserved", "The server pairing was revoked. A possibly live inference recovery marker remains local and was not deleted. Stop all pre-upgrade OpenClaw processes before any manual state recovery.");
      }
      if (cleared === "changed") {
        return success("revoked", "The selected server pairing was revoked. A newer local pairing exists and was preserved.");
      }
      return success("revoked", "The pairing was revoked and this adapter's local pairing state was removed.");
    } catch {
      return failure(
        "local_pairing_cleanup_failed",
        "The server pairing was revoked, but the adapter could not remove its local pairing state. Remove only the cmai-openclaw state directory after verifying the server shows the device as revoked.",
      );
    }
  }

  private update(): OpenClawCommandResult {
    const compatibility = this.options.compatibility.supported
      ? `OpenClaw ${this.options.compatibility.installedVersion} is supported (${CMAI_OPENCLAW_SUPPORTED_RANGE}).`
      : `OpenClaw ${this.options.compatibility.installedVersion || "unknown"} is unsupported (${CMAI_OPENCLAW_SUPPORTED_RANGE}).`;
    const configuration = this.options.configured ? "The CMAI origin is configured." : "The CMAI origin is not configured.";
    return success(
      "update",
      `CMAI OpenClaw adapter ${CMAI_OPENCLAW_ADAPTER_VERSION}. ${compatibility} Plugin API ${CMAI_OPENCLAW_PLUGIN_API_RANGE}. ${configuration} This private adapter does not self-update or contact a registry. Build and reinstall an explicitly reviewed local artifact.`,
    );
  }
}
