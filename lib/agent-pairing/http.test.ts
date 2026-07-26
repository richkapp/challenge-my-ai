import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AgentProtocolError } from "@/lib/agent-protocol/errors";
import {
  agentProtocolNetworkIdentity,
  handlePairingRouteError,
} from "@/lib/agent-pairing/http";

describe("Agent protocol HTTP security boundary", () => {
  it("accepts only an HMAC-authenticated trusted-edge identity and ignores spoofable forwarding headers", () => {
    const secret = "agent-protocol-edge-identity-test-secret-32-bytes";
    const identity = "edge-network-198.51.100.20";
    const signature = createHmac("sha256", secret)
      .update(`CMAI_AGENT_EDGE_NETWORK_IDENTITY_V1\0${identity}`, "utf8")
      .digest("base64url");
    const request = new Request("https://cmai.test/api/agent/feed", {
      headers: {
        "x-forwarded-for": "203.0.113.99",
        "x-real-ip": "203.0.113.100",
        "x-cmai-edge-network-id": identity,
        "x-cmai-edge-network-signature": signature,
      },
    });
    expect(agentProtocolNetworkIdentity(request, { production: false, trustProxyHeaders: false })).toBe("local-development");
    expect(agentProtocolNetworkIdentity(request, {
      production: true,
      trustProxyHeaders: true,
      edgeIdentitySecret: secret,
    })).toBe(identity);
    expect(() => agentProtocolNetworkIdentity(request, { production: true, trustProxyHeaders: false }))
      .toThrow(AgentProtocolError);
  });

  it("fails closed for absent, unsigned, or forged trusted-edge identities", () => {
    const options = {
      production: true,
      trustProxyHeaders: true,
      edgeIdentitySecret: "agent-protocol-edge-identity-test-secret-32-bytes",
    };
    expect(() => agentProtocolNetworkIdentity(new Request("https://cmai.test"), options))
      .toThrow(AgentProtocolError);
    expect(() => agentProtocolNetworkIdentity(new Request("https://cmai.test", {
      headers: {
        "x-cmai-edge-network-id": "edge-network-1",
        "x-cmai-edge-network-signature": "A".repeat(43),
        "x-forwarded-for": "198.51.100.20",
      },
    }), options)).toThrow(AgentProtocolError);
  });

  it("returns retry metadata inside the strict Protocol 1.2 error envelope", async () => {
    const response = handlePairingRouteError(
      new AgentProtocolError("rate_limited", "Too many requests.", 429, true, undefined, 17),
      { protocol: true, requestId: "req_rate_1" },
    );
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({
      protocol_version: "1.2",
      request_id: "req_rate_1",
      error: { code: "rate_limited", retryable: true, retry_after_seconds: 17 },
    });
  });
});
