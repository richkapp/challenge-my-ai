"use client";

import { useEffect, useRef, useState } from "react";
import type { AgentConnection, AgentHome, Contribution, ContributionMode } from "@/lib/types";
import { ContributionModePicker } from "@/components/contribution/ContributionModePicker";
import { CodexConnectPanel } from "@/components/agent/CodexConnectPanel";
import { ClaudeCodeConnectPanel } from "@/components/agent/ClaudeCodeConnectPanel";
import { csrfHeaders } from "@/lib/auth/csrfClient";
import { defaultContributionModeForRequestedModes } from "@/lib/contributionModes";

type ReadinessState = {
  status: "checking" | "setup_required" | "ready" | "failed";
  connectionId?: string;
  providerLabel?: string;
  modelLabel?: string;
  trustLabel?: string;
  message: string;
};

type AgentRunStatus = "queued" | "preparing_delegation" | "running" | "running_cell" | "validating" | "validating_artifacts" | "contributed" | "failed";

type RunState = {
  id?: string;
  status: AgentRunStatus;
  message: string;
  failureCode?: string;
  receiptSummary?: {
    receiptId?: string;
    receiptSha256?: string;
    sandboxProvider?: string;
    sandboxId?: string;
    networkIsolation?: string;
    teardownCompleted?: boolean;
    teardownError?: string;
    provider?: string;
    requestedModel?: string;
    model?: string;
    modelDisplayName?: string;
    providerResponseId?: string;
    providerModelVerified?: boolean;
    trustLabel?: string;
  };
};

type ApiObject = Record<string, unknown>;

type RunMyAgentPanelProps = {
  challengeId: string;
  requestedModes: ContributionMode[];
  onContributed: (contribution: Contribution) => void;
  isAuthenticated?: boolean;
  loginHref?: string;
  pollIntervalMs?: number;
};

const activeStatuses = new Set<AgentRunStatus>(["queued", "preparing_delegation", "running", "running_cell", "validating", "validating_artifacts"]);

export function RunMyAgentPanel({ challengeId, requestedModes, onContributed, isAuthenticated = true, loginHref = "/login", pollIntervalMs = 1500 }: RunMyAgentPanelProps) {
  const [mode, setMode] = useState<ContributionMode>(defaultContributionModeForRequestedModes(requestedModes));
  const [readiness, setReadiness] = useState<ReadinessState>({ status: "checking", message: "Checking your Agent Home readiness..." });
  const [approved, setApproved] = useState(false);
  const [run, setRun] = useState<RunState | null>(null);
  const [starting, setStarting] = useState(false);
  const postedContributionIds = useRef(new Set<string>());
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idempotencyKeyRef = useRef<string | null>(null);

  useEffect(() => {
    idempotencyKeyRef.current = null;
  }, [challengeId, mode, readiness.connectionId]);

  useEffect(() => {
    if (!approved) idempotencyKeyRef.current = null;
  }, [approved]);

  useEffect(() => {
    let cancelled = false;

    async function loadReadiness() {
      if (!isAuthenticated) {
        setReadiness({
          status: "setup_required",
          message: "Create an account to use Run my Agent here. Manual copy/paste still works before login.",
        });
        return;
      }
      try {
        const response = await fetch("/api/agent-home", { headers: { accept: "application/json" } });
        const data = await safeJson(response);
        if (cancelled) return;
        setReadiness(normalizeReadiness(response, data));
      } catch {
        if (!cancelled) {
          setReadiness({
            status: "setup_required",
            message: "Agent Home is not reachable yet. Copy/paste stays available while setup is unfinished.",
          });
        }
      }
    }

    loadReadiness();
    return () => {
      cancelled = true;
      clearPollTimer(pollTimer.current);
    };
  }, [isAuthenticated]);

  async function startRun() {
    if (readiness.status !== "ready" || !approved || starting) return;
    if (!readiness.connectionId) {
      setRun({ status: "failed", message: "Agent Home did not return a ready connection for this run. Refresh setup or use manual paste.", failureCode: "ready_connection_missing" });
      return;
    }
    const idempotencyKey = idempotencyKeyRef.current || createClientRunKey(challengeId, readiness.connectionId, mode);
    idempotencyKeyRef.current = idempotencyKey;
    setStarting(true);
    setRun({ status: "queued", message: "Run approved. Preparing a fresh child run cell..." });
    try {
      const response = await fetch(`/api/challenges/${challengeId}/agent-runs`, {
        method: "POST",
        headers: { "content-type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({
          approved: true,
          connectionId: readiness.connectionId,
          contributionMode: mode,
          idempotencyKey,
        }),
      });
      const data = await safeJson(response);
      if (!response.ok) {
        setRun({ status: "failed", message: apiErrorMessage(data, "Could not start the sandbox run."), failureCode: stringValue(data.code) });
        return;
      }
      applyRunPayload(data);
    } catch {
      setRun({ status: "failed", message: "Could not start the sandbox run. You can still use manual paste.", failureCode: "network_error" });
    } finally {
      setStarting(false);
    }
  }

  async function refreshAfterProviderConnect(_agentHome: AgentHome, connection: AgentConnection) {
    setReadiness({ status: "checking", message: `${connection.providerLabel} connected. Confirming this challenge can use the trusted run path...` });
    try {
      const response = await fetch("/api/agent-home", { headers: { accept: "application/json" } });
      const data = await safeJson(response);
      setReadiness(normalizeReadiness(response, data));
    } catch {
      setReadiness({ status: "setup_required", message: `${connection.providerLabel} connected, but trusted-run readiness could not be confirmed. Manual paste remains available.` });
    }
  }

  async function pollRun(runId: string) {
    try {
      const response = await fetch(`/api/agent-runs/${runId}`, { headers: { accept: "application/json" } });
      const data = await safeJson(response);
      if (!response.ok) {
        setRun({ id: runId, status: "failed", message: apiErrorMessage(data, "Could not poll the sandbox run."), failureCode: stringValue(data.code) });
        return;
      }
      applyRunPayload(data, runId);
    } catch {
      setRun({ id: runId, status: "failed", message: "Status polling failed. Check the room or use manual paste.", failureCode: "poll_network_error" });
    }
  }

  function applyRunPayload(data: ApiObject, fallbackRunId?: string) {
    const normalized = normalizeRunPayload(data, fallbackRunId);
    setRun(normalized);

    const contribution = contributionFromPayload(data);
    if (contribution && !postedContributionIds.current.has(contribution.id)) {
      postedContributionIds.current.add(contribution.id);
      onContributed(contribution);
    }

    if (normalized.status === "contributed") {
      idempotencyKeyRef.current = null;
      setApproved(false);
    }

    if (normalized.id && activeStatuses.has(normalized.status)) {
      clearPollTimer(pollTimer.current);
      pollTimer.current = setTimeout(() => pollRun(normalized.id as string), pollIntervalMs);
    }
  }

  const canStart = readiness.status === "ready" && approved && !starting && !(run && activeStatuses.has(run.status));

  return (
    <section id="run-my-agent" className="card p-5" aria-labelledby="run-my-agent-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Lane 2</p>
          <h2 id="run-my-agent-title" className="text-2xl font-black">Run my Agent here</h2>
        </div>
        <span className="badge bg-[#eef2ff] text-[#3730a3]">fully trusted when receipt-backed</span>
      </div>

      <p className="mt-3 text-sm leading-6 text-zinc-700">
        Approve one run from your Agent Home. Challenge My AI creates a fresh child run, validates the output card, and shows receipt-backed provenance when it posts.
      </p>
      <p className="mt-2 text-xs font-bold uppercase tracking-[0.16em] text-zinc-500">
        Receipt proof verifies the controlled run; exact model details only appear when the signed run attaches them.
      </p>

      <div className="mt-4 rounded-2xl border border-zinc-200 bg-[#f7f7f7] p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={statusBadgeClass(readiness.status)}>{readinessLabel(readiness.status)}</span>
          {readiness.providerLabel ? <span className="badge bg-white">{readiness.providerLabel}</span> : null}
          {readiness.modelLabel ? <span className="badge bg-white">{readiness.modelLabel}</span> : null}
          {readiness.trustLabel ? <span className="badge bg-white">{readiness.trustLabel}</span> : null}
        </div>
        <p className="mt-3 text-sm font-bold leading-6 text-zinc-700">{readiness.message}</p>
        {readiness.status !== "ready" && isAuthenticated ? (
          <div className="mt-3 space-y-3">
            <CodexConnectPanel compact onReady={refreshAfterProviderConnect} />
            <ClaudeCodeConnectPanel compact onReady={refreshAfterProviderConnect} />
            <a className="inline-flex text-sm font-black text-[#f04438] underline-offset-4 hover:underline" href="/agents">Open full Agent Home</a>
          </div>
        ) : readiness.status !== "ready" ? (
          <a className="mt-3 inline-flex text-sm font-black text-[#f04438] underline-offset-4 hover:underline" href={loginHref}>Create account for Run my Agent here</a>
        ) : null}
      </div>

      {readiness.status === "ready" ? (
        <div className="mt-4 space-y-4">
          <ContributionModePicker value={mode} onChange={setMode} requestedModes={requestedModes} />
          <label className="flex gap-3 rounded-2xl border border-zinc-200 bg-white p-4 text-sm font-bold leading-6 text-zinc-700">
            <input className="mt-1 h-4 w-4" type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} />
            <span>I approve one sandbox run for this challenge. Do not reuse my Agent Home or connected access for another challenge without asking again.</span>
          </label>
          <button className="btn" onClick={startRun} disabled={!canStart}>
            {starting || (run && activeStatuses.has(run.status)) ? "Running..." : "Start sandbox run"}
          </button>
        </div>
      ) : null}

      {run ? <RunStatusPanel run={run} /> : null}

      <p className="mt-4 rounded-2xl border border-dashed border-zinc-300 bg-white p-3 text-sm font-bold leading-6 text-zinc-700">
        Manual copy/paste remains available in Lane 1 even when Agent Home setup, sandbox execution, or polling fails.
      </p>
    </section>
  );
}

function RunStatusPanel({ run }: { run: RunState }) {
  return (
    <div className="mt-4 rounded-2xl border border-zinc-200 bg-white p-4" aria-live="polite">
      <div className="flex flex-wrap items-center gap-2">
        <span className={run.status === "failed" ? "badge bg-[#fff7ed] text-[#f04438]" : run.status === "contributed" ? "badge bg-[#ecfdf5] text-[#065f46]" : "badge bg-[#eef2ff] text-[#3730a3]"}>
          {statusLabel(run.status)}
        </span>
        {run.failureCode ? <span className="badge bg-white">{run.failureCode}</span> : null}
      </div>
      <p className="mt-3 text-sm font-bold leading-6 text-zinc-700">{run.message}</p>
      {run.receiptSummary ? (
        <div className="mt-3 space-y-3 rounded-2xl border border-zinc-200 bg-[#f7f7f7] p-3">
          <p className="text-xs font-black uppercase tracking-[0.18em] text-zinc-500">Receipt-backed provenance</p>
          <dl className="grid gap-2 text-xs font-bold uppercase tracking-[0.16em] text-zinc-500 sm:grid-cols-2">
            {run.receiptSummary.receiptId ? <div><dt>Receipt</dt><dd className="break-all text-zinc-700">{run.receiptSummary.receiptId}</dd></div> : null}
            {run.receiptSummary.receiptSha256 ? <div><dt>Receipt hash</dt><dd className="break-all text-zinc-700">{run.receiptSummary.receiptSha256}</dd></div> : null}
            {run.receiptSummary.sandboxProvider ? <div><dt>Sandbox</dt><dd className="text-zinc-700">{run.receiptSummary.sandboxProvider}</dd></div> : null}
            {run.receiptSummary.networkIsolation ? <div><dt>Network</dt><dd className="text-zinc-700">{run.receiptSummary.networkIsolation}</dd></div> : null}
            {run.receiptSummary.teardownCompleted !== undefined ? <div><dt>Teardown</dt><dd className="text-zinc-700">{run.receiptSummary.teardownCompleted ? "completed" : "not completed / operator follow-up required"}</dd></div> : null}
            {run.receiptSummary.provider ? <div><dt>Provider</dt><dd className="text-zinc-700">{run.receiptSummary.provider}</dd></div> : null}
            {run.receiptSummary.modelDisplayName || run.receiptSummary.model ? <div><dt>Model</dt><dd className="text-zinc-700">{run.receiptSummary.modelDisplayName || run.receiptSummary.model}</dd></div> : null}
            {run.receiptSummary.providerResponseId ? <div><dt>Provider response</dt><dd className="break-all text-zinc-700">{run.receiptSummary.providerResponseId}</dd></div> : null}
            {run.receiptSummary.trustLabel ? <div><dt>Trust label</dt><dd className="text-zinc-700">{run.receiptSummary.trustLabel}</dd></div> : null}
          </dl>
          <p className="text-xs font-bold leading-5 text-zinc-600">
            {run.receiptSummary.providerModelVerified
              ? "Provider-returned model metadata was attached to the signed sandbox receipt. This is not a provider-signed receipt."
              : "The signed receipt verifies the controlled sandbox run; exact provider/model metadata was not attached."}
            {" "}This panel does not expose raw transcripts, signatures, credential references, or broker secrets.
          </p>
        </div>
      ) : null}
    </div>
  );
}

async function safeJson(response: Response): Promise<ApiObject> {
  try {
    const data = await response.json();
    return isObject(data) ? data : {};
  } catch {
    return {};
  }
}

function normalizeReadiness(response: Response, data: ApiObject): ReadinessState {
  if (!response.ok) {
    return {
      status: "setup_required",
      message: apiErrorMessage(data, "Agent Home is not ready yet. Use copy/paste or finish setup first."),
    };
  }

  const readiness = objectValue(data.readiness) || data;
  const connection = objectValue(data.readyConnection) || objectValue(data.connection) || objectValue(readiness.connection) || {};
  const connectionId = stringValue(connection.id || connection.connectionId || readiness.connectionId || data.connectionId);
  const ready = Boolean(connectionId) && (data.ready === true || readiness.canRunHere === true);

  if (!ready) {
    return {
      status: readiness.status === "failed" ? "failed" : "setup_required",
      message: stringValue(readiness.message) || stringValue(readiness.failureReason) || "Agent Home needs a ready connection before sandbox runs are enabled.",
      providerLabel: stringValue(connection.providerLabel || connection.provider_label || connection.provider),
      modelLabel: stringValue(connection.modelLabel || connection.model_label || connection.model),
      trustLabel: stringValue(connection.trustLabel || connection.trust_label),
    };
  }

  return {
    status: "ready",
    connectionId,
    providerLabel: stringValue(connection.providerLabel || connection.provider_label || connection.provider) || "connected provider",
    modelLabel: stringValue(connection.modelLabel || connection.model_label || connection.model),
    trustLabel: stringValue(connection.trustLabel || connection.trust_label) || "sandbox-recorded",
    message: stringValue(readiness.message) || "Agent Home is ready for one approved sandbox run.",
  };
}

function normalizeRunPayload(data: ApiObject, fallbackRunId?: string): RunState {
  const run = objectValue(data.run) || data;
  const status = normalizeStatus(run.status) || normalizeStatus(data.status) || "queued";
  const receiptSummary = objectValue(run.receiptSummary) || objectValue(run.receipt_summary) || objectValue(data.receiptSummary) || objectValue(data.receipt_summary);
  const message = stringValue(run.message || data.message) || defaultRunMessage(status);
  return {
    id: stringValue(run.id || run.runId || run.run_id || data.runId || data.run_id) || fallbackRunId,
    status,
    message,
    failureCode: stringValue(run.failureCode || run.failure_code || data.failureCode || data.failure_code || data.code),
    receiptSummary: receiptSummary ? {
      receiptId: stringValue(receiptSummary.receiptId || receiptSummary.receipt_id),
      receiptSha256: stringValue(receiptSummary.receiptSha256 || receiptSummary.receipt_sha256),
      sandboxProvider: stringValue(receiptSummary.sandboxProvider || receiptSummary.sandbox_provider),
      sandboxId: stringValue(receiptSummary.sandboxId || receiptSummary.sandbox_id),
      networkIsolation: stringValue(receiptSummary.networkIsolation || receiptSummary.network_isolation),
      teardownCompleted: booleanValue(receiptSummary.teardownCompleted ?? receiptSummary.teardown_completed),
      teardownError: stringValue(receiptSummary.teardownError || receiptSummary.teardown_error),
      provider: stringValue(receiptSummary.provider),
      requestedModel: stringValue(receiptSummary.requestedModel || receiptSummary.requested_model),
      model: stringValue(receiptSummary.model),
      modelDisplayName: stringValue(receiptSummary.modelDisplayName || receiptSummary.model_display_name),
      providerResponseId: stringValue(receiptSummary.providerResponseId || receiptSummary.provider_response_id),
      providerModelVerified: booleanValue(receiptSummary.providerModelVerified ?? receiptSummary.provider_model_verified),
      trustLabel: stringValue(receiptSummary.trustLabel || receiptSummary.trust_label),
    } : undefined,
  };
}

function contributionFromPayload(data: ApiObject): Contribution | undefined {
  const contribution = objectValue(data.contribution) || objectValue(objectValue(data.run)?.contribution);
  if (!contribution || typeof contribution.id !== "string") return undefined;
  return contribution as Contribution;
}

function normalizeStatus(status: unknown): AgentRunStatus | undefined {
  if (status === "queued" || status === "preparing_delegation" || status === "running" || status === "running_cell" || status === "validating" || status === "validating_artifacts" || status === "contributed" || status === "failed") return status;
  return undefined;
}

function defaultRunMessage(status: AgentRunStatus): string {
  if (status === "queued") return "Run queued.";
  if (status === "preparing_delegation") return "Preparing one-run delegation.";
  if (status === "running" || status === "running_cell") return "Fresh child run cell is running.";
  if (status === "validating" || status === "validating_artifacts") return "Validating contribution card and receipt.";
  if (status === "contributed") return "Contribution posted with sandbox provenance.";
  return "Sandbox run failed. Manual paste is still available.";
}

function statusLabel(status: AgentRunStatus): string {
  return status.replaceAll("_", " ");
}

function readinessLabel(status: ReadinessState["status"]): string {
  if (status === "checking") return "checking";
  if (status === "ready") return "ready";
  if (status === "failed") return "setup failed";
  return "setup needed";
}

function statusBadgeClass(status: ReadinessState["status"]): string {
  if (status === "ready") return "badge bg-[#ecfdf5] text-[#065f46]";
  if (status === "failed") return "badge bg-[#fff7ed] text-[#f04438]";
  return "badge bg-white";
}

function apiErrorMessage(data: ApiObject, fallback: string): string {
  return stringValue(data.error || data.message) || fallback;
}

function objectValue(value: unknown): ApiObject | undefined {
  return isObject(value) ? value : undefined;
}

function isObject(value: unknown): value is ApiObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function createClientRunKey(challengeId: string, connectionId: string, mode: ContributionMode): string {
  const random = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${challengeId}:${connectionId}:${mode}:${random}`;
}

function clearPollTimer(timer: ReturnType<typeof setTimeout> | null) {
  if (timer) clearTimeout(timer);
}
