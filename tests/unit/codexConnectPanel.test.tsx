import { describe, expect, it } from "vitest";
import { readCodexDeviceEvents } from "@/components/agent/CodexConnectPanel";

function streamResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

describe("Connect Codex UI stream", () => {
  it("parses split NDJSON events without exposing token material", async () => {
    const received: unknown[] = [];
    await readCodexDeviceEvents(streamResponse([
      '{"type":"device_code","verificationUrl":"https://auth.openai.com/codex/device",',
      '"userCode":"ABCD-1234"}\n{"type":"connected","planType":"plus"}\n',
    ]), (event) => { received.push(event); });

    expect(received).toEqual([
      { type: "device_code", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" },
      { type: "connected", planType: "plus" },
    ]);
    expect(JSON.stringify(received)).not.toMatch(/access_token|refresh_token|id_token/);
  });

  it("surfaces a stable start error when the route fails before streaming", async () => {
    await expect(readCodexDeviceEvents(new Response(JSON.stringify({ error: "A Codex login is already active for this account." }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }), () => undefined)).rejects.toThrow("already active");
  });
});
