import type { AgentConnection, AgentHome } from "@/lib/types";

export const maxCodexDeviceEventBufferBytes = 1_000_000;

export type CodexPublicDeviceEvent =
  | { type: "device_code"; verificationUrl: string; userCode: string }
  | { type: "connected"; planType?: string }
  | { type: "ready"; connection: AgentConnection; agentHome: AgentHome }
  | { type: "error"; code?: string; message?: string };

export async function readCodexDeviceEvents(
  response: Response,
  onEvent: (event: CodexPublicDeviceEvent) => void | Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error || "Could not start Codex login.");
  }
  if (!response.body) throw new Error("Codex login stream was unavailable.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  let done = false;
  try {
    while (!done) {
      if (signal?.aborted) throw new DOMException("Codex login cancelled.", "AbortError");
      const next = await reader.read();
      done = next.done;
      pending += decoder.decode(next.value, { stream: !done });
      if (encoder.encode(pending).byteLength > maxCodexDeviceEventBufferBytes) {
        throw new Error("Codex login stream exceeded the client limit.");
      }
      const lines = pending.split("\n");
      pending = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        await onEvent(JSON.parse(line) as CodexPublicDeviceEvent);
      }
    }
    if (pending.trim()) await onEvent(JSON.parse(pending) as CodexPublicDeviceEvent);
  } finally {
    if (!done) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
