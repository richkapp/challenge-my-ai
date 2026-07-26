"use client";

import { useEffect, useRef, useState } from "react";
import { csrfHeaders } from "@/lib/auth/csrfClient";
import type { AgentConnection, AgentHome } from "@/lib/types";
import { readClaudeCodeLoginEvents, safeClaudeAuthorizationUrl } from "@/lib/agent-home/claudeCodeLoginEvents";
export { readClaudeCodeLoginEvents } from "@/lib/agent-home/claudeCodeLoginEvents";

type Props = {
  connectionId?: string;
  displayLabel?: string;
  compact?: boolean;
  onReady: (agentHome: AgentHome, connection: AgentConnection) => void;
};

type LoginStatus = "idle" | "starting" | "waiting_code" | "submitting" | "finishing" | "ready" | "error";

export function ClaudeCodeConnectPanel({ connectionId, displayLabel, compact = false, onReady }: Props) {
  const [status, setStatus] = useState<LoginStatus>("idle");
  const [authorizationUrl, setAuthorizationUrl] = useState<string>();
  const [attemptId, setAttemptId] = useState<string>();
  const [authorizationCode, setAuthorizationCode] = useState("");
  const [message, setMessage] = useState("Authenticate once with your Claude plan through the official Claude Code flow. Every challenge still needs your approval.");
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const authWindowRef = useRef<Window | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
    controllerRef.current?.abort();
    authWindowRef.current?.close();
  }, []);

  function clearPrivateInput() {
    setAuthorizationCode("");
    setAttemptId(undefined);
  }

  function cancelLogin() {
    controllerRef.current?.abort();
    authWindowRef.current?.close();
    controllerRef.current = undefined;
    authWindowRef.current = null;
    clearPrivateInput();
    setAuthorizationUrl(undefined);
    setStatus("idle");
    setMessage("Claude Code sign-in cancelled. You can retry or use manual copy/paste.");
  }

  async function startLogin() {
    if (["starting", "waiting_code", "submitting", "finishing"].includes(status)) return;
    setStatus("starting");
    clearPrivateInput();
    setAuthorizationUrl(undefined);
    setMessage("Starting Anthropic's official Claude Code sign-in flow...");
    const authWindow = typeof window !== "undefined" ? window.open("about:blank", "cmai-claude-code-login") : null;
    if (authWindow) authWindow.opener = null;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    authWindowRef.current = authWindow;
    try {
      const response = await fetch("/api/agent-home/claude-code/login", {
        method: "POST",
        headers: { "content-type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ connectionId, displayLabel }),
        signal: controller.signal,
      });
      await readClaudeCodeLoginEvents(response, async (event) => {
        if (!mountedRef.current || controller.signal.aborted) return;
        if (event.type === "authorization_url") {
          const safeUrl = safeClaudeAuthorizationUrl(event.authorizationUrl);
          if (!safeUrl) throw new Error("Claude Code returned an unsafe authorization URL.");
          setAuthorizationUrl(safeUrl);
          setAttemptId(event.attemptId);
          setStatus("waiting_code");
          setMessage("Sign in on Anthropic's page. If it shows a one-time authorization code, copy that code back here. It is not your access token.");
          if (authWindow) authWindow.location.href = safeUrl;
          return;
        }
        if (event.type === "ready") {
          clearPrivateInput();
          const runnable = event.connection.readiness.canRunHere;
          setStatus(runnable ? "ready" : "error");
          setMessage(runnable
            ? "Claude Code is connected. Future challenges reuse this managed connection unless Anthropic revokes or expires it."
            : event.connection.readiness.detail || "Claude Code authentication was saved, but broker setup still needs attention before runs are enabled.");
          onReady(event.agentHome, event.connection);
          return;
        }
        if (event.type === "error") throw new Error(event.message || "Claude Code login failed.");
      }, controller.signal);
    } catch (error) {
      authWindow?.close();
      clearPrivateInput();
      if (!mountedRef.current || controller.signal.aborted) return;
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Claude Code login failed. Try again or use manual paste.");
    } finally {
      if (controllerRef.current === controller) controllerRef.current = undefined;
      if (authWindowRef.current === authWindow) authWindowRef.current = null;
    }
  }

  async function submitCode() {
    const code = authorizationCode.trim();
    const controller = controllerRef.current;
    if (!attemptId || !code || status !== "waiting_code" || !controller || controller.signal.aborted) return;
    setStatus("submitting");
    setMessage("Sending the one-time code to the waiting official Claude Code process...");
    try {
      const response = await fetch("/api/agent-home/claude-code/login/code", {
        method: "POST",
        headers: { "content-type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ attemptId, authorizationCode: code }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!mountedRef.current || controller.signal.aborted || controllerRef.current !== controller) return;
      setAuthorizationCode("");
      if (!response.ok) throw new Error(body.error || "Claude Code did not accept the one-time authorization code.");
      setStatus("finishing");
      setMessage("Anthropic approved the code. Claude Code is saving the managed connection securely...");
    } catch (error) {
      if (!mountedRef.current || controller.signal.aborted || controllerRef.current !== controller) return;
      setAuthorizationCode("");
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Claude Code authorization failed. Start a new sign-in or use manual paste.");
    }
  }

  const buttonLabel = status === "starting"
    ? "Starting..."
    : status === "waiting_code"
      ? "Waiting for code..."
      : status === "submitting" || status === "finishing"
        ? "Finishing..."
        : status === "ready"
          ? "Claude Code connected"
          : connectionId
            ? "Reconnect Claude Code"
            : "Connect Claude Code";

  const loginActive = ["starting", "waiting_code", "submitting", "finishing"].includes(status);

  return (
    <div className={`rounded-2xl border border-orange-200 bg-orange-50 ${compact ? "p-3" : "p-4"}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-black text-orange-950">Claude Code with your Claude plan</p>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-orange-900">{message}</p>
        </div>
        <button className="btn" type="button" disabled={loginActive || status === "ready"} onClick={startLogin}>
          {buttonLabel}
        </button>
      </div>
      {authorizationUrl && attemptId && (status === "waiting_code" || status === "submitting" || status === "finishing") ? (
        <div className="mt-3 rounded-xl border border-orange-200 bg-white p-3">
          <label className="block text-xs font-black uppercase tracking-[0.16em] text-orange-700" htmlFor={`claude-code-${attemptId}`}>
            One-time Anthropic authorization code
          </label>
          <input
            id={`claude-code-${attemptId}`}
            className="mt-2 w-full rounded-xl border border-orange-300 bg-white px-3 py-2 font-mono text-sm"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={authorizationCode}
            disabled={status !== "waiting_code"}
            onChange={(event) => setAuthorizationCode(event.target.value)}
            placeholder="Paste the short-lived code shown by Anthropic"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <a className="btn secondary" href={authorizationUrl} target="_blank" rel="noopener noreferrer">Open Anthropic sign-in</a>
            <button className="btn secondary" type="button" disabled={!authorizationCode.trim() || status !== "waiting_code"} onClick={() => { void submitCode(); }}>Submit one-time code</button>
          </div>
          <p className="mt-2 text-xs leading-5 text-orange-800">Only paste the code shown after you started this flow. Never paste an API key, access token, refresh token, or Claude setup token.</p>
        </div>
      ) : null}
      {status === "error" ? <p className="mt-3 text-sm font-bold text-amber-900">Manual copy/paste remains available while you reconnect.</p> : null}
      {loginActive ? <button className="mt-3 text-sm font-bold text-orange-800 underline" type="button" onClick={cancelLogin}>Cancel sign-in</button> : null}
    </div>
  );
}
