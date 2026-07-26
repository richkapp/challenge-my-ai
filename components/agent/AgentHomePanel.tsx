"use client";

import { useMemo, useState } from "react";
import { CodexConnectPanel } from "@/components/agent/CodexConnectPanel";
import { ClaudeCodeConnectPanel } from "@/components/agent/ClaudeCodeConnectPanel";
import { csrfHeaders } from "@/lib/auth/csrfClient";
import { isProductionBlockedAgentConnection } from "@/lib/agent-home/connectionPolicy";
import { providerCatalog, type ProviderCatalogEntry, type SupportedAgentProvider } from "@/lib/agent-home/providerCatalog";
import { isNormalContributionMode, shortLabelForContributionMode } from "@/lib/contributionModes";
import type { AgentConnection, AgentHome } from "@/lib/types";

function statusClass(connection: AgentConnection, blockedInProduction = false) {
  if (blockedInProduction || connection.status === "paused" || connection.status === "revoked") return "border-amber-200 bg-amber-50 text-amber-900";
  if (connection.status === "ready" && !connection.readiness.canRunHere) return "border-amber-200 bg-amber-50 text-amber-900";
  if (connection.status === "ready") return "border-emerald-200 bg-emerald-50 text-emerald-900";
  if (connection.status === "smoke_failed") return "border-amber-200 bg-amber-50 text-amber-900";
  return "border-zinc-200 bg-zinc-50 text-zinc-700";
}

function formatList(items: AgentConnection["allowedRequestClasses"]) {
  const normalItems = items.filter(isNormalContributionMode);
  return normalItems.length ? normalItems.map(shortLabelForContributionMode).join(", ") : "Advanced-only";
}

function isBlockedInProductionUi(connection: AgentConnection, devConnectionEnabled: boolean) {
  return !devConnectionEnabled && isProductionBlockedAgentConnection(connection);
}

function canRunConnection(connection: AgentConnection, devConnectionEnabled: boolean, trustedRunConfigIssues: string[]) {
  return connection.readiness.canRunHere && !isBlockedInProductionUi(connection, devConnectionEnabled) && trustedRunConfigIssues.length === 0;
}

function providerCanConnectNow(entry: ProviderCatalogEntry) {
  return entry.liveModelProxyCaller && entry.brokerCaller.status === "live";
}

function providerReadinessLabel(entry: ProviderCatalogEntry) {
  if (providerCanConnectNow(entry) && entry.authClass === "api_only") return "API-only broker caller live";
  if (providerCanConnectNow(entry)) return "Broker caller live";
  if (entry.providerReadiness === "compliance_review") return "Compliance review";
  if (entry.providerReadiness === "adapter_pending") return "Adapter pending";
  if (entry.providerReadiness === "deferred") return "Deferred";
  return "Setup pending";
}

function providerReadinessCopy(entry: ProviderCatalogEntry) {
  if (providerCanConnectNow(entry) && entry.authClass === "api_only") return `This provider can be connected for broker/model-proxy scaffolding, then smoke-tested, but it does not make the normal-user trusted lane available. ${entry.authReadinessCopy}`;
  if (providerCanConnectNow(entry)) return `This provider can be connected to Agent Home, then smoke-tested before any challenge run is allowed. ${entry.authReadinessCopy}`;
  return `${entry.label} is visible as a future Agent Home setup target, but it cannot run trusted challenge cells until its broker caller, smoke behavior, metadata mapping, and compliance checks are live. Manual paste remains available. ${entry.authReadinessCopy}`;
}

function providerSecretPlaceholder(entry?: ProviderCatalogEntry) {
  if (!entry) return "Choose a provider first";
  if (!providerCanConnectNow(entry)) return entry.authClass === "device_auth" ? "Codex session/device auth setup is not implemented yet" : "Not accepted until this provider is broker-ready";
  if (entry.authClass === "api_only") return "Paste API/bearer access for API-only scaffold; not normal-user plan auth";
  return "Paste provider access for setup/rotate; never sent to child run cells";
}

type ConnectionAction = "pause" | "resume" | "rotate" | "reconnect" | "revoke";

export function AgentHomePanel({ agentHome, devConnectionEnabled = true, trustedRunConfigIssues = [] }: { agentHome: AgentHome; devConnectionEnabled?: boolean; trustedRunConfigIssues?: string[] }) {
  const [home, setHome] = useState(agentHome);
  const [busyConnectionId, setBusyConnectionId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [provider, setProvider] = useState<SupportedAgentProvider>("codex");
  const [providerSecret, setProviderSecret] = useState("");
  const [connectionSecrets, setConnectionSecrets] = useState<Record<string, string>>({});

  const readyConnections = useMemo(() => home.connections.filter((connection) => canRunConnection(connection, devConnectionEnabled, trustedRunConfigIssues)), [devConnectionEnabled, home.connections, trustedRunConfigIssues]);
  const productionBlockedConnections = useMemo(() => home.connections.filter((connection) => isBlockedInProductionUi(connection, devConnectionEnabled)), [devConnectionEnabled, home.connections]);
  const providerOptions = useMemo(() => providerCatalog().filter((entry) => entry.id !== "local_fake"), []);
  const selectedProvider = useMemo(() => providerOptions.find((entry) => entry.id === provider), [provider, providerOptions]);
  const summaryReady = readyConnections.length > 0;
  const summaryLabel = summaryReady ? "Ready" : "Setup needed";
  const derivedMessage = summaryReady
    ? "Agent Home is ready for approved sandbox runs."
    : trustedRunConfigIssues.length > 0
      ? "Agent Home has connection state, but production broker, receipt signing, model proxy, or sandbox run cells are not configured yet. Manual paste remains available."
      : productionBlockedConnections.length > 0
        ? "Persisted local/dev Agent connections are ignored in production. Manual paste remains available until a real provider-backed setup is connected."
        : "Manual paste still works while Agent Home setup is incomplete.";
  const visibleMessage = message ?? derivedMessage;
  const selectedProviderCanConnect = selectedProvider ? providerCanConnectNow(selectedProvider) : false;

  async function connectDevAgent() {
    setBusyConnectionId("new");
    setMessage("Creating a dev Agent connection...");
    try {
      const response = await fetch("/api/agent-home/connections", {
        method: "POST",
        headers: { "content-type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ provider: "local_fake", displayLabel: "Local fake Hermes Agent" }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not connect Agent.");
      setHome(data.agentHome);
      setMessage("Dev Agent connection created. Run a smoke test before using Run my Agent here.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not connect Agent.");
    } finally {
      setBusyConnectionId(null);
    }
  }

  async function connectProviderAgent() {
    setBusyConnectionId("new-provider");
    setMessage("Connecting provider access...");
    try {
      const selected = providerOptions.find((entry) => entry.id === provider);
      if (!selected) throw new Error("Choose a provider first.");
      if (!providerCanConnectNow(selected)) throw new Error(`${selected.label} is not runnable in Agent Home yet. Use manual paste or choose a broker-live provider.`);
      const response = await fetch("/api/agent-home/connections", {
        method: "POST",
        headers: { "content-type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ provider, displayLabel: `${selected.label} Agent connection`, providerSecret: providerSecret || undefined }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not connect provider access.");
      setHome(data.agentHome);
      setProviderSecret("");
      setMessage(selected.countsForMvpUserPlan ? "Provider access saved broker-side. Run a smoke test before using Run my Agent here." : "Provider access saved broker-side as API-only scaffolding. Smoke can prove the broker path, but user-plan auth is still missing.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not connect provider access.");
    } finally {
      setBusyConnectionId(null);
    }
  }

  async function runSmoke(connectionId: string) {
    setBusyConnectionId(connectionId);
    setMessage("Running Agent Home smoke test...");
    try {
      const response = await fetch(`/api/agent-home/connections/${connectionId}/smoke`, {
        method: "POST",
        headers: { "content-type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({}),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Smoke test failed.");
      setHome(data.agentHome);
      setMessage(data.connection?.readiness?.detail || "Smoke test finished.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Smoke test failed.");
    } finally {
      setBusyConnectionId(null);
    }
  }

  async function updateConnection(connectionId: string, action: ConnectionAction) {
    setBusyConnectionId(`${connectionId}:${action}`);
    setMessage(`${action === "rotate" || action === "reconnect" ? "Updating" : action[0].toUpperCase() + action.slice(1)} provider connection...`);
    try {
      const response = await fetch(`/api/agent-home/connections/${connectionId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ action, providerSecret: connectionSecrets[connectionId] || undefined }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not update Agent connection.");
      setHome(data.agentHome);
      setConnectionSecrets((current) => ({ ...current, [connectionId]: "" }));
      setMessage(data.connection?.readiness?.detail || "Agent connection updated.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not update Agent connection.");
    } finally {
      setBusyConnectionId(null);
    }
  }

  return (
    <section>
      <header className="border-b border-zinc-300 pb-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-sm font-bold text-[#f04438]">Agent Home</p>
            <h1 className="mt-3 max-w-3xl text-4xl font-black tracking-[-0.035em] sm:text-6xl">Connect once. Approve each run.</h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-zinc-600">Every challenge still gets a fresh sandbox and a one-run approval.</p>
          </div>
          <span className="badge">{summaryLabel} · {readyConnections.length} ready</span>
        </div>
      </header>

      <form className="border-b border-zinc-300 py-8" onSubmit={(event) => { event.preventDefault(); if (provider !== "codex" && provider !== "claude_code" && selectedProviderCanConnect && busyConnectionId !== "new-provider") void connectProviderAgent(); }}>
        <h2 className="text-2xl font-black tracking-[-0.025em]">Connect an Agent</h2>
        <div className="mt-5 grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)] lg:items-start">
          <label className="text-sm font-bold text-zinc-700">Provider
            <select className="select mt-2" value={provider} onChange={(event) => setProvider(event.target.value as SupportedAgentProvider)}>
              {providerOptions.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}{providerCanConnectNow(entry) ? "" : " — not ready"}</option>)}
            </select>
          </label>

          {provider === "codex" ? (
            <CodexConnectPanel compact displayLabel="My Codex Agent" onReady={(nextHome) => { setHome(nextHome); setMessage("Codex is connected and ready for fresh per-challenge approvals."); }} />
          ) : provider === "claude_code" ? (
            <ClaudeCodeConnectPanel compact displayLabel="My Claude Code Agent" onReady={(nextHome) => { setHome(nextHome); setMessage("Claude Code is connected and ready for fresh per-challenge approvals."); }} />
          ) : (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="flex-1 text-sm font-bold text-zinc-700">Provider access
                <input autoComplete="new-password" className="input mt-2" disabled={!selectedProviderCanConnect} placeholder={providerSecretPlaceholder(selectedProvider)} type="password" value={providerSecret} onChange={(event) => setProviderSecret(event.target.value)} />
              </label>
              <button className="btn" disabled={busyConnectionId === "new-provider" || !selectedProviderCanConnect} type="submit">{busyConnectionId === "new-provider" ? "Connecting..." : selectedProviderCanConnect ? "Connect" : "Not ready"}</button>
            </div>
          )}
        </div>

        {selectedProvider ? (
          <details className="disclosure mt-5">
            <summary>{providerReadinessLabel(selectedProvider)}</summary>
            <div className="max-w-3xl space-y-2 text-sm leading-6 text-zinc-600">
              <p>{providerReadinessCopy(selectedProvider)}</p>
              <p>Auth: {selectedProvider.authSetupLabel}. {selectedProvider.complianceCopy}</p>
            </div>
          </details>
        ) : null}

        <div className="mt-5 flex flex-wrap items-center gap-3">
          {home.connections.length === 0 && devConnectionEnabled ? <button className="btn secondary" disabled={busyConnectionId === "new"} onClick={connectDevAgent} type="button">{busyConnectionId === "new" ? "Connecting..." : "Connect dev sandbox"}</button> : null}
          <p className="text-sm font-bold text-zinc-600">{visibleMessage}</p>
        </div>
      </form>

      <section className="py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-2xl font-black tracking-[-0.025em]">Connections</h2>
          <span className="text-sm font-bold text-zinc-500">{home.connections.length}</span>
        </div>

        <div className="mt-5 border-t border-zinc-300">
          {home.connections.length === 0 ? (
            <div className="py-8">
              <h3 className="text-xl font-black">No connection yet.</h3>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-600">Manual paste remains available until a supported Agent passes its smoke test.</p>
            </div>
          ) : home.connections.map((connection) => {
            const blockedInProduction = isBlockedInProductionUi(connection, devConnectionEnabled);
            const runtimeConfigBlocked = !blockedInProduction && !devConnectionEnabled && trustedRunConfigIssues.length > 0;
            const connectionCanRun = canRunConnection(connection, devConnectionEnabled, trustedRunConfigIssues);
            const readinessLabel = blockedInProduction ? "Production-disabled dev connection" : runtimeConfigBlocked ? "Production run setup incomplete" : connection.readiness.label;
            const readinessDetail = blockedInProduction
              ? "This dev connection is ignored in production."
              : runtimeConfigBlocked
                ? "Production broker, receipt signing, model proxy, or sandbox run cells are incomplete."
                : connection.readiness.detail;
            const actionBusy = busyConnectionId?.startsWith(`${connection.id}:`);

            return (
              <article key={connection.id} className="border-b border-zinc-300 py-6">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full border px-3 py-1 text-xs font-black ${statusClass(connection, blockedInProduction || runtimeConfigBlocked)}`}>{readinessLabel}</span>
                  <span className="badge">{connection.providerLabel}</span>
                  {connectionCanRun ? <span className="badge">Run-ready</span> : null}
                </div>
                <h3 className="mt-4 text-xl font-black">{connection.displayLabel}</h3>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-600">{readinessDetail}</p>

                <div className="mt-4 flex flex-wrap gap-2">
                  {connection.status !== "revoked" ? <button className="btn secondary" disabled={busyConnectionId === connection.id} onClick={() => runSmoke(connection.id)}>{busyConnectionId === connection.id ? "Testing..." : "Run smoke test"}</button> : null}
                  {connection.status === "ready" ? <button className="btn secondary" disabled={busyConnectionId === `${connection.id}:pause`} onClick={() => updateConnection(connection.id, "pause")}>Pause</button> : null}
                  {connection.status === "paused" ? <button className="btn secondary" disabled={busyConnectionId === `${connection.id}:resume`} onClick={() => updateConnection(connection.id, "resume")}>Resume</button> : null}
                  {connection.status !== "revoked" ? <button className="btn secondary" disabled={busyConnectionId === `${connection.id}:revoke`} onClick={() => updateConnection(connection.id, "revoke")}>Revoke</button> : null}
                </div>

                <details className="disclosure mt-4">
                  <summary>Connection details</summary>
                  <dl className="grid gap-3 text-sm text-zinc-600 sm:grid-cols-2">
                    <div><dt className="font-black text-zinc-800">Allowed models</dt><dd>{connection.allowedModels.join(", ")}</dd></div>
                    <div><dt className="font-black text-zinc-800">Request classes</dt><dd>{formatList(connection.allowedRequestClasses)}</dd></div>
                    <div><dt className="font-black text-zinc-800">Trust label</dt><dd>{connection.sandboxTrustLabel}</dd></div>
                    <div><dt className="font-black text-zinc-800">Last smoke</dt><dd>{connection.lastSmoke.status === "not_run" ? "Not run yet" : `${connection.lastSmoke.status}: ${connection.lastSmoke.message}`}</dd></div>
                    <div><dt className="font-black text-zinc-800">Broker credential</dt><dd>{connection.brokerCredentialAvailable ? "Stored" : "Not stored"}</dd></div>
                    {connection.auditTrail?.length ? <div><dt className="font-black text-zinc-800">Audit</dt><dd>{connection.auditTrail.slice(0, 3).map((event) => event.summary).join(" · ")}</dd></div> : null}
                  </dl>

                  {connection.provider === "codex" ? (
                    <div className="mt-4"><CodexConnectPanel compact connectionId={connection.id} onReady={(nextHome) => { setHome(nextHome); setMessage("Codex reconnected."); }} /></div>
                  ) : connection.provider === "claude_code" ? (
                    <div className="mt-4"><ClaudeCodeConnectPanel compact connectionId={connection.id} onReady={(nextHome) => { setHome(nextHome); setMessage("Claude Code reconnected."); }} /></div>
                  ) : (
                    <form className="mt-4 flex flex-col gap-2 sm:flex-row" onSubmit={(event) => { event.preventDefault(); if (connectionSecrets[connection.id] && !actionBusy) void updateConnection(connection.id, connection.status === "revoked" ? "reconnect" : "rotate"); }}>
                      <input aria-label={connection.status === "revoked" ? "Provider access for reconnect" : "Provider access for rotate"} autoComplete="new-password" className="input" placeholder={connection.status === "revoked" ? "Fresh provider access" : "Fresh provider access"} type="password" value={connectionSecrets[connection.id] || ""} onChange={(event) => setConnectionSecrets((current) => ({ ...current, [connection.id]: event.target.value }))} />
                      <button className="btn secondary" disabled={!connectionSecrets[connection.id] || actionBusy} type="submit">{connection.status === "revoked" ? "Reconnect" : "Rotate"}</button>
                    </form>
                  )}
                </details>
              </article>
            );
          })}
        </div>
      </section>
    </section>
  );
}
