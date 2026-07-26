import { describe, expect, it } from "vitest";
import { readClaudeCodeLoginEvents } from "@/components/agent/ClaudeCodeConnectPanel";
import { safeClaudeAuthorizationUrl } from "@/lib/agent-home/claudeCodeLoginEvents";

function streamResponse(chunks: string[]) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

describe("Connect Claude Code UI stream", () => {
  it("parses split NDJSON events without exposing managed credential material", async () => {
    const received: unknown[] = [];
    await readClaudeCodeLoginEvents(streamResponse([
      '{"type":"authorization_url","authorizationUrl":"https://claude.com/cai/oauth/authorize?state=test",',
      '"attemptId":"attempt-123456789"}\n{"type":"error","code":"fixture","message":"retry"}\n',
    ]), (event) => { received.push(event); });

    expect(received).toEqual([
      { type: "authorization_url", authorizationUrl: "https://claude.com/cai/oauth/authorize?state=test", attemptId: "attempt-123456789" },
      { type: "error", code: "fixture", message: "retry" },
    ]);
    expect(JSON.stringify(received)).not.toMatch(/accessToken|refreshToken|access_token|refresh_token|authorizationCode/);
  });

  it("rejects client-side authorization URL drift before navigation or rendering", () => {
    expect(safeClaudeAuthorizationUrl("https://claude.com/cai/oauth/authorize?state=test")).toBe("https://claude.com/cai/oauth/authorize?state=test");
    expect(safeClaudeAuthorizationUrl("http://claude.com/cai/oauth/authorize?state=test")).toBeUndefined();
    expect(safeClaudeAuthorizationUrl("https://claude.com/other?state=test")).toBeUndefined();
    expect(safeClaudeAuthorizationUrl("https://attacker.example/cai/oauth/authorize?state=test")).toBeUndefined();
  });

  it("surfaces a stable start error when the route fails before streaming", async () => {
    await expect(readClaudeCodeLoginEvents(new Response(JSON.stringify({ error: "A Claude Code login is already active for this account." }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }), () => undefined)).rejects.toThrow("already active");
  });
});
