import { describe, expect, it, vi } from "vitest";
import { backwardCompatiblePairCreateFixture } from "../../../lib/agent-protocol/fixtures";
import type { CmaiAgentTransportRequest } from "../../cmai-agent-client/src/types";
import { FetchCmaiAgentTransport } from "./transport";

function request(operation: "pair.create" | "feed.list" | "contribution.submit"): CmaiAgentTransportRequest<typeof operation> {
  if (operation === "pair.create") {
    return { operation, envelope: backwardCompatiblePairCreateFixture } as unknown as CmaiAgentTransportRequest<typeof operation>;
  }
  return { operation, envelope: { operation, request_id: "req_feed_1" } } as unknown as CmaiAgentTransportRequest<typeof operation>;
}

describe("OpenClaw adapter transport boundary", () => {
  it("routes the opened feed and challenge surfaces through the canonical Agent Protocol endpoint", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const transport = new FetchCmaiAgentTransport("https://challenge-my-ai.example", fetchFn);
    expect(await transport.send(request("feed.list"), { signal: new AbortController().signal, timeoutMs: 1_000, requestId: "req_feed_1" }))
      .toEqual({ status: 200, body: { ok: true } });
    expect(fetchFn).toHaveBeenCalledWith("https://challenge-my-ai.example/api/agent/feed", expect.objectContaining({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    }));
  });

  it("keeps contribution submission fail-closed for Card 08", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const transport = new FetchCmaiAgentTransport("https://challenge-my-ai.example", fetchFn);
    await expect(transport.send(request("contribution.submit"), {
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      requestId: "req_submit_1",
    })).rejects.toMatchObject({ code: "transport_unavailable", retryable: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sends only strict envelopes without cookies or auth headers", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 201 }));
    const transport = new FetchCmaiAgentTransport("https://challenge-my-ai.example", fetchFn);
    expect(await transport.send(request("pair.create"), { signal: new AbortController().signal, timeoutMs: 1_000, requestId: "req_pair_1" }))
      .toEqual({ status: 201, body: { ok: true } });
    expect(fetchFn).toHaveBeenCalledWith("https://challenge-my-ai.example/api/agent/pair", expect.objectContaining({
      method: "POST",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { accept: "application/json", "content-type": "application/json" },
    }));
    const options = fetchFn.mock.calls[0]![1] as RequestInit;
    expect(JSON.stringify(options.headers)).not.toMatch(/authorization|cookie|token|credential/i);
  });

  it("stops oversized response streams before JSON parsing", async () => {
    const oversized = new Uint8Array((512 * 1024) + 1);
    oversized.fill("{".charCodeAt(0));
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(oversized);
        controller.close();
      },
    }), { status: 201 }));
    const transport = new FetchCmaiAgentTransport("https://challenge-my-ai.example", fetchFn);
    await expect(transport.send(request("pair.create"), {
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      requestId: "req_pair_oversized",
    })).rejects.toMatchObject({ code: "transport_response_malformed", retryable: false });
  });

  it("rejects credential-bearing and non-loopback HTTP origins", () => {
    expect(() => new FetchCmaiAgentTransport("https://user:secret@example.com")).toThrow("without credentials");
    expect(() => new FetchCmaiAgentTransport("http://example.com")).toThrow("must use HTTPS");
    expect(() => new FetchCmaiAgentTransport("http://127.0.0.1:3000")).not.toThrow();
  });
});
