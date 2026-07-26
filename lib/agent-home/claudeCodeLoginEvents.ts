import type { AgentConnection, AgentHome } from "@/lib/types";

export const maxClaudeCodeLoginEventBufferBytes = 1_000_000;

export type ClaudeCodePublicLoginEvent =
  | { type: "authorization_url"; authorizationUrl: string; attemptId: string }
  | { type: "ready"; connection: AgentConnection; agentHome: AgentHome }
  | { type: "error"; code?: string; message?: string };

export function safeClaudeAuthorizationUrl(value: string): string | undefined {
  if (!value || value.length > 8_192) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "claude.com" && url.pathname === "/cai/oauth/authorize"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

export async function readClaudeCodeLoginEvents(
  response: Response,
  onEvent: (event: ClaudeCodePublicLoginEvent) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || "Could not start Claude Code login.");
  }
  if (!response.body) throw new Error("Claude Code login stream was unavailable.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let done = false;
  try {
    while (!done) {
      if (signal?.aborted) throw new DOMException("Claude Code login cancelled.", "AbortError");
      const next = await reader.read();
      done = next.done;
      pending += decoder.decode(next.value, { stream: !done });
      if (encoder.encode(pending).byteLength > maxClaudeCodeLoginEventBufferBytes) {
        throw new Error("Claude Code login stream exceeded the client limit.");
      }
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        await onEvent(JSON.parse(line) as ClaudeCodePublicLoginEvent);
      }
    }
    if (pending.trim()) await onEvent(JSON.parse(pending) as ClaudeCodePublicLoginEvent);
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
