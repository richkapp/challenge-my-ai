import { Buffer } from "node:buffer";
import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { canonicalAgentSigningBytes } from "../../../lib/agent-protocol/canonical";
import { backwardCompatiblePairCreateFixture, fixturePublicKey } from "../../../lib/agent-protocol/fixtures";
import type { CmaiAgentTransportRequest } from "../../cmai-agent-client/src/types";
import { FetchCmaiAgentTransport } from "./transport";

function request(operation: "pair.create" | "feed.list" | "contribution.submit"): CmaiAgentTransportRequest<typeof operation> {
  if (operation === "pair.create") {
    return { operation, envelope: backwardCompatiblePairCreateFixture } as unknown as CmaiAgentTransportRequest<typeof operation>;
  }
  return {
    operation,
    envelope: {
      protocol: "CMAI_AGENT_PROTOCOL_V1",
      protocol_version: "1.2",
      operation,
      request_id: "req_feed_1",
      sent_at: "2026-07-14T12:00:00.000Z",
      auth: { pairing_id: "pairing_1", key_id: "key_1", signature: { algorithm: "ed25519", value: "Ak7hv12t0JvEtqmBytcJR2CwS7Iva2rr85Ao4r5HcoDyE_YOgYcnaRog3idJLNYd7TANwjqEswUf8t_6G2-uBQ" } },
      payload: { limit: 10 },
    },
  } as CmaiAgentTransportRequest<typeof operation>;
}

describe("Hermes adapter transport boundary", () => {
  it("pins the feed fixture signature to its exact protocol 1.2 signing bytes", () => {
    const feedRequest = request("feed.list");
    const envelope = feedRequest.envelope;
    if (!("auth" in envelope)) throw new Error("feed fixture must be signed");
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(fixturePublicKey, "base64url"),
      ]),
      format: "der",
      type: "spki",
    });
    expect(verify(
      null,
      Buffer.from(canonicalAgentSigningBytes({
        protocol: envelope.protocol,
        protocol_version: envelope.protocol_version,
        operation: envelope.operation,
        request_id: envelope.request_id,
        sent_at: envelope.sent_at,
        pairing_id: envelope.auth.pairing_id,
        key_id: envelope.auth.key_id,
        payload: envelope.payload,
      })),
      publicKey,
      Buffer.from(envelope.auth.signature.value, "base64url"),
    )).toBe(true);
  });

  it("routes feed protocol envelopes to the authenticated feed endpoint", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const transport = new FetchCmaiAgentTransport("https://challenge-my-ai.example", fetchFn);
    await expect(transport.send(request("feed.list"), { signal: new AbortController().signal, timeoutMs: 1_000, requestId: "req_feed_1" }))
      .resolves.toEqual({ status: 200, body: { ok: true } });
    expect(fetchFn).toHaveBeenCalledWith("https://challenge-my-ai.example/api/agent/feed", expect.objectContaining({
      method: "POST",
      credentials: "omit",
    }));
  });

  it("does not expose a contribution submission endpoint in Card 07A", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const transport = new FetchCmaiAgentTransport("https://challenge-my-ai.example", fetchFn);
    await expect(transport.send(request("contribution.submit"), { signal: new AbortController().signal, timeoutMs: 1_000, requestId: "req_submit_1" }))
      .rejects.toThrow("contribution.submit route is not available");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sends known protocol envelopes without cookies or auth headers", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), { status: 201, headers: { "content-type": "application/json" } }));
    const transport = new FetchCmaiAgentTransport("https://challenge-my-ai.example", fetchFn);
    const result = await transport.send(request("pair.create"), { signal: new AbortController().signal, timeoutMs: 1_000, requestId: "req_pair_1" });
    expect(result).toEqual({ status: 201, body: { ok: true } });
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

  it("rejects credential-bearing and non-loopback HTTP base URLs", () => {
    expect(() => new FetchCmaiAgentTransport("https://user:secret@example.com")).toThrow("without credentials");
    expect(() => new FetchCmaiAgentTransport("http://example.com")).toThrow("must use HTTPS");
    expect(() => new FetchCmaiAgentTransport("http://127.0.0.1:3000")).not.toThrow();
  });
});
