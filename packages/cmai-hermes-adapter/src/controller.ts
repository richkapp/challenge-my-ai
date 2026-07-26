import { randomUUID } from "node:crypto";
import { hashAgentProtocolPayload } from "../../../lib/agent-protocol/canonical";
import type { AgentPublicChallenge } from "../../../lib/agent-protocol/schemas";
import { pairedLocalContributionCardV1Schema } from "../../../lib/validation/contributionCardProtocol";
import type { CmaiAgentClient } from "../../cmai-agent-client/src/client";
import { CmaiAgentClientError } from "../../cmai-agent-client/src/errors";
import type { CmaiAgentRuntimeAdapter } from "../../cmai-agent-client/src/types";
import type { HermesPairingMaterial } from "./cryptoSigner";
import { CMAI_HERMES_INFERENCE_MAX_TOKENS, CMAI_HERMES_INFERENCE_TIMEOUT_SECONDS, CmaiHermesInferenceError } from "./inference";
import type { HermesPairingClearResult, HermesPendingRun, HermesPersistedPreview } from "./stateStore";
import {
  CMAI_HERMES_ADAPTER_VERSION,
  CMAI_HERMES_SUPPORTED_RANGE,
  type HermesCompatibility,
} from "./constants";

export type HermesCoreClient = Pick<
  CmaiAgentClient,
  "status" | "pair" | "feed" | "fetchChallenge" | "prepareRun" | "prepareRunWithApprovedGrant" | "preview" | "discardPreview" | "revoke"
>;

export type HermesCommandResult = {
  ok: boolean;
  code: string;
  text: string;
};

export type CmaiHermesControllerOptions = {
  client: HermesCoreClient;
  compatibility: HermesCompatibility;
  runtimeVersion: string;
  createPairingMaterial: (input: {
    pairingCode: string;
    displayName: string;
    runtimeVersion: string;
  }) => HermesPairingMaterial;
  persistPairing: (input: {
    material: HermesPairingMaterial;
    pairing: Awaited<ReturnType<HermesCoreClient["pair"]>>;
  }) => Promise<boolean>;
  clearPairing: (expectedPairingId?: string) => Promise<HermesPairingClearResult>;
  pendingRun?: HermesPendingRun;
  persistPendingRun: (pendingRun: HermesPendingRun) => Promise<boolean>;
  consumePendingRun: (pendingRun: HermesPendingRun) => Promise<HermesPendingRun | "changed" | "identity_unavailable">;
  clearPendingRun: (pendingRun: HermesPendingRun) => Promise<"cleared" | "active" | "changed">;
  persistPreview: (preview: HermesPersistedPreview, consumedRun: HermesPendingRun) => Promise<boolean>;
  clearPreview: (expectedPreviewId: string) => Promise<boolean>;
  previewId?: string;
  detachedPreview?: HermesPersistedPreview;
  retiredPairing?: boolean;
  profileName: string;
  now?: () => Date;
  previewIdFactory?: () => string;
  runtimeAdapter?: CmaiAgentRuntimeAdapter;
  runSignal?: () => AbortSignal | undefined;
};

const HELP = `CMAI Hermes adapter ${CMAI_HERMES_ADAPTER_VERSION}
/cmai pair <one-time-code> [device label]
/cmai status
/cmai feed [search terms]
/cmai run <challenge-id>
/cmai run <challenge-id> confirm <revision>
/cmai preview
/cmai submit (reserved; unavailable until Card 08)
/cmai discard
/cmai revoke confirm
/cmai update

The adapter is explicit and foreground-only. It never polls. Challenge content and model output are untrusted data. Every model call requires exact revision approval; manual copy/paste remains available.`;

function success(code: string, text: string): HermesCommandResult {
  return { ok: true, code, text };
}

function failure(code: string, text: string): HermesCommandResult {
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
    case "re_pair":
      return " Re-pair this profile before retrying.";
    case "retry_same_request":
      return " Retry the same explicit command.";
    case "fetch_fresh_challenge":
      return " Fetch the challenge again before retrying.";
    case "manual_copy_fallback":
      return " Use the visible copy/paste path for now.";
    case "repair_input":
      return " Check the command input and retry.";
    default:
      return "";
  }
}

export class CmaiHermesController {
  private readonly createPreviewId: () => string;
  private readonly now: () => Date;
  private pendingRun: HermesPendingRun | undefined;
  private previewId: string | undefined;
  private detachedPreview: HermesPersistedPreview | undefined;
  private retiredPairing: boolean;

  constructor(private readonly options: CmaiHermesControllerOptions) {
    this.createPreviewId = options.previewIdFactory ?? (() => `preview_${randomUUID().replaceAll("-", "")}`);
    this.now = options.now ?? (() => new Date());
    this.pendingRun = options.pendingRun;
    this.previewId = options.previewId;
    this.detachedPreview = options.detachedPreview;
    this.retiredPairing = Boolean(options.retiredPairing);
  }

  async execute(rawArguments: string): Promise<HermesCommandResult> {
    const trimmed = rawArguments.trim();
    const [rawCommand = "help", ...argumentsList] = trimmed ? trimmed.split(/\s+/) : ["help"];
    const command = rawCommand.toLowerCase();

    if (command === "help") return success("help", HELP);
    if (command === "update") return this.update();
    if (!this.options.compatibility.supported) {
      return failure(
        "hermes_version_incompatible",
        `CMAI Hermes adapter disabled: Hermes ${this.options.compatibility.installedVersion || "unknown"} is outside ${CMAI_HERMES_SUPPORTED_RANGE}. No network or model call was made.`,
      );
    }

    try {
      switch (command) {
        case "status":
          return this.status();
        case "pair":
          return await this.pair(argumentsList);
        case "feed":
          return await this.feed(argumentsList);
        case "run":
          return await this.run(argumentsList);
        case "preview":
          return this.preview();
        case "submit":
          return failure(
            "submission_unavailable",
            "Submission is not implemented in Card 07A. Inspect or discard the durable preview; Card 08 owns submission, retry, cleanup, and idempotency behavior.",
          );
        case "discard":
          return await this.discard();
        case "revoke":
          return await this.revoke(argumentsList);
        default:
          return failure("command_unknown", `Unknown /cmai command: ${rawCommand}.\n\n${HELP}`);
      }
    } catch (error) {
      if (error instanceof CmaiAgentClientError) {
        return failure(error.code, `${error.message}${recoveryText(error)}`);
      }
      return failure("adapter_internal_error", "The CMAI adapter failed safely. No response content or credential material was retained.");
    }
  }

  private status(): HermesCommandResult {
    if (this.detachedPreview) {
      return success("status", `CMAI Hermes adapter ${CMAI_HERMES_ADAPTER_VERSION}: A public preview was preserved after its legacy submit-authorized signing key was removed from adapter state. Inspect it with /cmai preview, then /cmai discard before pairing again.`);
    }
    if (this.retiredPairing) {
      return success("status", `CMAI Hermes adapter ${CMAI_HERMES_ADAPTER_VERSION}: The legacy submit-authorized signing key was removed from adapter state while a consumed run marker remains protected. Pairing stays blocked until that exact process finishes or is conclusively dead and the marker is discarded.`);
    }
    const snapshot = this.options.client.status();
    const detail = snapshot.phase === "unpaired"
      ? "Unpaired. Create a one-time code in Challenge My AI, then run /cmai pair <code>."
      : snapshot.phase === "paired"
        ? "Paired locally. Server state remains authoritative; use /cmai feed when the platform route is available."
        : snapshot.phase === "preview"
          ? "A validated contribution preview is waiting for explicit inspection. Submission remains unavailable until Card 08."
          : `Shared client phase: ${snapshot.phase}.`;
    return success("status", `CMAI Hermes adapter ${CMAI_HERMES_ADAPTER_VERSION}: ${detail}`);
  }

  private async pair(argumentsList: string[]): Promise<HermesCommandResult> {
    if (this.retiredPairing) {
      return failure("retired_preview_pending", this.detachedPreview
        ? "A public preview from a retired legacy pairing is still preserved. Inspect it with /cmai preview, then /cmai discard before pairing again."
        : "A consumed run from a retired legacy pairing is still protected. Wait for its preview or discard the marker only after its exact process owner is conclusively dead.");
    }
    const [pairingCode, ...labelParts] = argumentsList;
    if (!pairingCode) return failure("pairing_code_required", "Usage: /cmai pair <one-time-code> [device label]");
    const material = this.options.createPairingMaterial({
      pairingCode,
      displayName: labelParts.join(" ").trim() || "Hermes Agent",
      runtimeVersion: this.options.runtimeVersion,
    });
    const pairing = await this.options.client.pair(material.payload, material.signer);
    try {
      const persisted = await this.options.persistPairing({ material, pairing });
      if (!persisted) throw new Error("Another pairing already owns this profile state.");
    } catch {
      let rollbackConfirmed = false;
      try {
        await this.options.client.revoke({ revoke: "pairing", reason: "rotation_cleanup" });
        await this.options.clearPairing(pairing.pairing_id);
        rollbackConfirmed = true;
      } catch {
        // The user receives a specific recovery path below; raw failures stay private.
      }
      return failure(
        "local_pairing_state_failed",
        rollbackConfirmed
          ? "Local pairing state could not be stored, so the new server pairing was revoked. Repair the profile state path before pairing again."
          : "Local pairing state could not be stored and rollback could not be confirmed. Revoke this device in Challenge My AI before pairing again.",
      );
    }
    return success(
      "paired",
      `Paired this Hermes profile with Challenge My AI. Granted scopes: ${pairing.granted_scopes.join(", ")}. Provider credentials were not sent.`,
    );
  }

  private async feed(argumentsList: string[]): Promise<HermesCommandResult> {
    const query = argumentsList.join(" ").trim();
    const response = await this.options.client.feed({ limit: 10, ...(query ? { query } : {}) });
    if (response.challenges.length === 0) return success("feed_empty", "No matching public challenges were returned.");
    const rows = response.challenges.map((challenge) => (
      `${challenge.challenge_id} — ${terminalSafeInline(challenge.title)} — ${challenge.reward_credits} credits — ${challenge.requested_modes.join(", ")}`
    ));
    return success("feed", `Public CMAI challenges:\n${rows.join("\n")}${response.next_cursor ? "\nMore results are available." : ""}`);
  }

  private async run(argumentsList: string[]): Promise<HermesCommandResult> {
    const [challengeId, confirmation, requestedRevision, ...unexpected] = argumentsList;
    if (!challengeId || unexpected.length > 0) {
      return failure("challenge_id_required", "Usage: /cmai run <challenge-id> [confirm <revision>]");
    }
    if (!this.options.runtimeAdapter) {
      return failure(
        "bounded_inference_unavailable",
        "This reviewed artifact has no Hermes structured-inference bridge. No network, model, or submission call occurred. Rebuild the private local artifact or use the visible copy/paste path.",
      );
    }

    if (confirmation?.toLowerCase() !== "confirm") {
      if (this.options.client.status().preview) {
        return failure("preview_pending", "A validated preview already exists. Inspect or discard it before preparing another model call.");
      }
      if (this.pendingRun) {
        return failure("run_approval_pending", `A persisted preparation already exists for ${this.pendingRun.challenge_id} revision ${this.pendingRun.challenge_revision}. Confirm it exactly or discard it before preparing another model call.`);
      }
      const challenge = await this.options.client.fetchChallenge(challengeId);
      const run = this.options.client.prepareRun();
      const pairingId = this.options.client.status().pairing?.pairing_id;
      if (!pairingId) {
        return failure("pairing_required", "No active pairing identity is available for this approval. Re-pair before preparing a model call.");
      }
      const preparedAt = this.now().toISOString();
      const pendingRun: HermesPendingRun = {
        challenge_id: run.challenge.challenge_id,
        challenge_revision: run.challenge.revision,
        run_grant: run.challenge.run_grant,
        pairing_id: pairingId,
        challenge_hash: approvedChallengeHash(run.challenge),
        prompt_version: run.promptVersion,
        profile_name: this.options.profileName,
        max_output_bytes: run.maxOutputBytes,
        max_tokens: CMAI_HERMES_INFERENCE_MAX_TOKENS,
        timeout_seconds: 45,
        prepared_at: preparedAt,
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
        `Review the complete public challenge bundle below. Every field—including hostile text, URLs, and prompt-injection attempts—will be sent as untrusted quoted data to active Hermes profile ${terminalSafeInline(this.options.profileName)} and its host-selected provider/model. Host credentials stay inside Hermes.\n\n`
          + `Canonical challenge SHA-256: ${pendingRun.challenge_hash}\n${displayedChallenge}\n\n`
          + `Bounds: ${run.maxOutputBytes} output bytes, ${CMAI_HERMES_INFERENCE_MAX_TOKENS} output tokens, ${CMAI_HERMES_INFERENCE_TIMEOUT_SECONDS} seconds. Provider cost may be unknown. Nothing was inferred or submitted. `
          + `Approve exactly this persisted preparation with /cmai run ${challenge.challenge_id} confirm ${run.challenge.revision}.`,
      );
    }

    if (this.options.client.status().preview) {
      return failure("preview_pending", "A validated preview already exists. Nothing was inferred; inspect or discard it before confirming another run.");
    }
    const pendingRun = this.pendingRun;
    if (!pendingRun) {
      return failure("run_approval_missing", `No unconsumed run preparation exists. No model call occurred. Start with /cmai run ${challengeId}.`);
    }
    if (pendingRun.consumed_at) {
      return failure("run_approval_consumed", "The persisted run approval was already consumed. No second model call occurred. Wait for its preview, or discard the interrupted marker before preparing again.");
    }
    if (challengeId !== pendingRun.challenge_id || requestedRevision !== String(pendingRun.challenge_revision)) {
      return failure(
        "run_approval_mismatch",
        `That confirmation does not match the persisted preparation for ${pendingRun.challenge_id} revision ${pendingRun.challenge_revision}. No model call occurred.`,
      );
    }
    const nowMs = this.now().getTime();
    if (!Number.isFinite(nowMs) || nowMs >= Date.parse(pendingRun.approval_expires_at) || nowMs >= Date.parse(pendingRun.run_grant.expires_at)) {
      await this.options.clearPendingRun(pendingRun);
      this.pendingRun = undefined;
      return failure("run_approval_expired", `The persisted preparation for ${challengeId} expired. No model call occurred. Fetch and review the challenge again.`);
    }
    if (
      pendingRun.profile_name !== this.options.profileName
      || pendingRun.pairing_id !== this.options.client.status().pairing?.pairing_id
      || pendingRun.max_tokens !== CMAI_HERMES_INFERENCE_MAX_TOKENS
      || pendingRun.timeout_seconds !== CMAI_HERMES_INFERENCE_TIMEOUT_SECONDS
    ) {
      await this.options.clearPendingRun(pendingRun);
      this.pendingRun = undefined;
      return failure("run_approval_context_changed", "The active Hermes profile or bounded-call budget changed after preparation. No model call occurred. Fetch and review the challenge again.");
    }

    const refreshedChallenge = await this.options.client.fetchChallenge(challengeId);
    const refreshedGrant = refreshedChallenge.run_grant;
    const approvedGrant = pendingRun.run_grant;
    if (
      refreshedChallenge.challenge_id !== pendingRun.challenge_id
      || refreshedChallenge.revision !== pendingRun.challenge_revision
      || approvedChallengeHash(refreshedChallenge, approvedGrant) !== pendingRun.challenge_hash
      || refreshedGrant.challenge_revision !== pendingRun.challenge_revision
      || refreshedGrant.request_class !== approvedGrant.request_class
      || refreshedGrant.prompt_version !== pendingRun.prompt_version
      || refreshedGrant.max_output_bytes !== pendingRun.max_output_bytes
    ) {
      await this.options.clearPendingRun(pendingRun);
      this.pendingRun = undefined;
      return failure("run_approval_stale", "The challenge revision, prompt version, or output budget changed after preparation. No model call occurred. Fetch and review the challenge again.");
    }

    const dispatchNowMs = this.now().getTime();
    if (
      !Number.isFinite(dispatchNowMs)
      || dispatchNowMs >= Date.parse(pendingRun.approval_expires_at)
      || dispatchNowMs >= Date.parse(approvedGrant.expires_at)
    ) {
      await this.options.clearPendingRun(pendingRun);
      this.pendingRun = undefined;
      return failure("run_approval_expired", `The persisted preparation for ${challengeId} expired before dispatch. No model call occurred. Fetch and review the challenge again.`);
    }

    let run;
    try {
      run = this.options.client.prepareRunWithApprovedGrant(approvedGrant);
    } catch {
      await this.options.clearPendingRun(pendingRun);
      this.pendingRun = undefined;
      return failure("run_approval_stale", "The approved run grant no longer matches the freshly validated challenge contract. No model call occurred. Fetch and review the challenge again.");
    }

    // Atomically mark the exact approval as process-owned before dispatch. The
    // marker survives failure/crash and is replaced only by its own preview.
    const consumeResult = await this.options.consumePendingRun(pendingRun);
    if (consumeResult === "identity_unavailable") {
      return failure("run_consumer_identity_unavailable", "Hermes could not establish durable process-incarnation identity. No model call occurred; retry only after local process identity is available.");
    }
    if (consumeResult === "changed") {
      return failure("run_approval_consumed", "The persisted run approval was already consumed or replaced. No model call occurred. Fetch and review the challenge again.");
    }
    const consumedRun = consumeResult;
    this.pendingRun = consumedRun;
    try {
      const result = await this.options.runtimeAdapter.execute(run, { signal: this.options.runSignal?.() });
      const preview = this.options.client.preview(result, { userApprovedRun: true });
      const previewId = this.createPreviewId();
      const persistedPreview: HermesPersistedPreview = {
        challenge: run.challenge,
        result: {
          identity: {
            runtime: "hermes",
            ...(result.identity.runtimeVersion ? { runtimeVersion: result.identity.runtimeVersion } : {}),
            adapterName: "cmai-hermes",
            adapterVersion: CMAI_HERMES_ADAPTER_VERSION,
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
        const persisted = await this.options.persistPreview(persistedPreview, consumedRun);
        if (!persisted) {
          this.options.client.discardPreview();
          return failure("preview_state_conflict", "The model call completed, but another run preparation or preview won the durable-state race. This output was discarded and nothing was submitted.");
        }
        this.pendingRun = undefined;
        this.previewId = previewId;
      } catch {
        this.options.client.discardPreview();
        return failure("preview_persistence_failed", "The model call completed, but its validated preview could not be stored durably and was discarded. Nothing was submitted.");
      }
      return success(
        "run_preview_ready",
        `One bounded Hermes call completed. Inspect this complete validated contribution card:\n${JSON.stringify(preview, null, 2)}\n\nNothing was submitted. Card 07A stops at durable preview; Card 08 owns submission. Discard only with /cmai discard.`,
      );
    } catch (error) {
      if (error instanceof CmaiHermesInferenceError) return failure(error.code, `${error.message} Nothing was submitted.`);
      throw error;
    }
  }

  private preview(): HermesCommandResult {
    const card = this.detachedPreview?.result.card ?? this.options.client.status().preview?.card;
    if (!card) return failure("preview_missing", "No validated preview exists. Nothing can be submitted.");
    return success(
      "preview",
      `Inspect this complete validated contribution card:\n${JSON.stringify(card, null, 2)}\n\nCard 07A stops at durable preview. Submission remains fail-closed until Card 08; discard only with /cmai discard.`,
    );
  }

  private async discard(): Promise<HermesCommandResult> {
    const hasClientPreview = Boolean(this.options.client.status().preview);
    const hasPreview = hasClientPreview || Boolean(this.detachedPreview);
    const hadPendingRun = Boolean(this.pendingRun);
    if (hasPreview) {
      const expectedPreviewId = this.previewId;
      if (!expectedPreviewId) {
        return failure("preview_persistence_missing", "The validated preview is missing its durable identity. Nothing was discarded; inspect local state before recovery.");
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
        return failure("run_in_flight", "The consumed run is still owned by a live Hermes worker. Nothing was discarded; wait for its preview or retry after that worker exits.");
      }
      if (cleared === "changed") {
        return failure("run_state_changed", "The selected run state changed before cleanup. Newer durable state was preserved; inspect it before taking another action.");
      }
      this.pendingRun = undefined;
    }
    if (hasPreview || hadPendingRun) this.retiredPairing = false;
    if (!hasPreview && !hadPendingRun) {
      return failure("discard_missing", "No local contribution preview or pending run approval exists. Nothing was submitted.");
    }
    return success("discarded", "The local contribution preview or pending run approval was discarded. Nothing was submitted.");
  }

  private async revoke(argumentsList: string[]): Promise<HermesCommandResult> {
    if (argumentsList[0]?.toLowerCase() !== "confirm") {
      return failure("revocation_confirmation_required", "Run /cmai revoke confirm to revoke the server pairing and delete this adapter's local pairing state.");
    }
    if (this.retiredPairing) {
      return failure("legacy_pairing_retired", "The legacy signing key was removed from adapter state and cannot authorize revocation. Revoke the old device in Challenge My AI, then inspect or recover the preserved local state before pairing again.");
    }
    const pairingId = this.options.client.status().pairing?.pairing_id;
    if (!pairingId) return failure("pairing_required", "No paired device is available to revoke.");
    await this.options.client.revoke({ revoke: "pairing", reason: "user_requested" });
    try {
      const cleared = await this.options.clearPairing(pairingId);
      if (cleared === "active") {
        return success("revoked_recovery_preserved", "The server pairing was revoked. A possibly live local inference marker was preserved; wait for its preview or worker exit before cleanup or re-pairing.");
      }
      if (cleared === "changed") {
        return failure("local_pairing_state_changed", "The server pairing was revoked, but local pairing state changed before cleanup. Newer local state was preserved; inspect it before taking another action.");
      }
      return success("revoked", "The pairing was revoked and this adapter's local pairing state was removed.");
    } catch {
      return failure(
        "local_pairing_cleanup_failed",
        "The server pairing was revoked, but the adapter could not remove its local pairing state. Remove only $HERMES_HOME/state/cmai-hermes after verifying the server shows the device as revoked.",
      );
    }
  }

  private update(): HermesCommandResult {
    const compatibility = this.options.compatibility.supported
      ? `Hermes ${this.options.compatibility.installedVersion} is supported (${CMAI_HERMES_SUPPORTED_RANGE}).`
      : `Hermes ${this.options.compatibility.installedVersion || "unknown"} is unsupported (${CMAI_HERMES_SUPPORTED_RANGE}).`;
    return success(
      "update",
      `CMAI Hermes adapter ${CMAI_HERMES_ADAPTER_VERSION}. ${compatibility} This private scaffold does not self-update or contact a registry. Build and reinstall an explicitly reviewed local artifact.`,
    );
  }
}
