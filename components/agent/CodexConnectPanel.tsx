"use client";

import { useEffect, useRef, useState } from "react";
import { csrfHeaders } from "@/lib/auth/csrfClient";
import type { AgentConnection, AgentHome } from "@/lib/types";
import { readCodexDeviceEvents } from "@/lib/agent-home/codexDeviceEvents";
export { readCodexDeviceEvents } from "@/lib/agent-home/codexDeviceEvents";

type Props = {
  connectionId?: string;
  displayLabel?: string;
  compact?: boolean;
  onReady: (agentHome: AgentHome, connection: AgentConnection) => void;
};

export function CodexConnectPanel({ connectionId, displayLabel, compact = false, onReady }: Props) {
  const [status, setStatus] = useState<"idle" | "starting" | "waiting" | "connected" | "ready" | "error">("idle");
  const [verificationUrl, setVerificationUrl] = useState<string>();
  const [userCode, setUserCode] = useState<string>();
  const [message, setMessage] = useState("Authenticate once with ChatGPT. Future challenges reuse this connection, but every run still needs your approval.");
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const authWindowRef = useRef<Window | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
    controllerRef.current?.abort();
    authWindowRef.current?.close();
  }, []);

  function cancelLogin() {
    controllerRef.current?.abort();
    authWindowRef.current?.close();
    controllerRef.current = undefined;
    authWindowRef.current = null;
    setStatus("idle");
    setMessage("Codex sign-in cancelled. You can retry or use manual copy/paste.");
  }

  async function startLogin() {
    if (status === "starting" || status === "waiting") return;
    setStatus("starting");
    setMessage("Starting the official Codex sign-in flow...");
    const authWindow = typeof window !== "undefined" ? window.open("about:blank", "cmai-codex-login") : null;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    authWindowRef.current = authWindow;
    try {
      const response = await fetch("/api/agent-home/codex/device-login", {
        method: "POST",
        headers: { "content-type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ connectionId, displayLabel }),
        signal: controller.signal,
      });
      await readCodexDeviceEvents(response, async (event) => {
        if (!mountedRef.current || controller.signal.aborted) return;
        if (event.type === "device_code") {
          setVerificationUrl(event.verificationUrl);
          setUserCode(event.userCode);
          setStatus("waiting");
          setMessage("Sign in to ChatGPT in the opened OpenAI page, then enter this one-time code. It expires in 15 minutes.");
          if (authWindow) authWindow.location.href = event.verificationUrl;
          return;
        }
        if (event.type === "connected") {
          setStatus("connected");
          setMessage("ChatGPT approved the connection. Saving it securely in Agent Home...");
          return;
        }
        if (event.type === "ready") {
          setStatus("ready");
          setMessage("Codex is connected. You will not need to sign in again for the next challenge unless OpenAI revokes or expires the session.");
          onReady(event.agentHome, event.connection);
          return;
        }
        if (event.type === "error") throw new Error(event.message || "Codex login failed.");
      }, controller.signal);
    } catch (error) {
      authWindow?.close();
      if (!mountedRef.current || controller.signal.aborted) return;
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Codex login failed. Try again or use manual paste.");
    } finally {
      if (controllerRef.current === controller) controllerRef.current = undefined;
      if (authWindowRef.current === authWindow) authWindowRef.current = null;
    }
  }

  async function copyCode() {
    if (!userCode) return;
    await navigator.clipboard?.writeText(userCode);
    setMessage("Code copied. Paste it on the OpenAI device-login page.");
  }

  const buttonLabel = status === "starting"
    ? "Starting..."
    : status === "waiting"
      ? "Waiting for OpenAI..."
      : status === "ready"
        ? "Codex connected"
        : connectionId
          ? "Reconnect Codex"
          : "Connect Codex";

  return (
    <div className={`rounded-2xl border border-indigo-200 bg-indigo-50 ${compact ? "p-3" : "p-4"}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-black text-indigo-950">Codex with your ChatGPT plan</p>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-indigo-900">{message}</p>
        </div>
        <button className="btn" type="button" disabled={status === "starting" || status === "waiting" || status === "ready"} onClick={startLogin}>
          {buttonLabel}
        </button>
      </div>
      {verificationUrl && userCode ? (
        <div className="mt-3 rounded-xl border border-indigo-200 bg-white p-3" aria-live="polite">
          <p className="text-xs font-black uppercase tracking-[0.16em] text-indigo-700">One-time OpenAI code</p>
          <p className="mt-2 font-mono text-2xl font-black tracking-[0.12em] text-indigo-950">{userCode}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <a className="btn secondary" href={verificationUrl} target="_blank" rel="noreferrer">Open OpenAI sign-in</a>
            <button className="btn secondary" type="button" onClick={copyCode}>Copy code</button>
          </div>
          <p className="mt-2 text-xs leading-5 text-indigo-800">Only enter this code because you started Connect Codex here. Never share it with another person.</p>
        </div>
      ) : null}
      {status === "error" ? <p className="mt-3 text-sm font-bold text-amber-900">Manual copy/paste is still available while you reconnect.</p> : null}
      {status === "starting" || status === "waiting" ? <button className="mt-3 text-sm font-bold text-indigo-800 underline" type="button" onClick={cancelLogin}>Cancel sign-in</button> : null}
    </div>
  );
}
