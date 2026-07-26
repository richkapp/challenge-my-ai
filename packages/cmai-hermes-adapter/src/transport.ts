import { CmaiAgentClientError } from "../../cmai-agent-client/src/errors";
import type {
  CmaiAgentTransport,
  CmaiAgentTransportOptions,
  CmaiAgentTransportRequest,
  CmaiAgentTransportResponse,
} from "../../cmai-agent-client/src/types";
import { CMAI_AGENT_PROTOCOL_VERSION, type AgentProtocolOperation } from "../../../lib/agent-protocol/constants";

const MAX_RESPONSE_BYTES = 512 * 1024;

const implementedRoutes = {
  "pair.create": "/api/agent/pair",
  "pairing.rotate_key": "/api/agent/pair/rotate",
  "pairing.revoke": "/api/agent/revoke",
  "feed.list": "/api/agent/feed",
  "challenge.get": "/api/agent/feed",
} as const satisfies Partial<Record<AgentProtocolOperation, string>>;

function normalizeBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("CMAI_AGENT_BASE_URL must be an absolute URL.");
  }
  const localHttp = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHttp) {
    throw new Error("CMAI_AGENT_BASE_URL must use HTTPS, except for loopback development.");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/")) {
    throw new Error("CMAI_AGENT_BASE_URL must be an origin without credentials, path, query, or fragment.");
  }
  return parsed.origin;
}

export class FetchCmaiAgentTransport implements CmaiAgentTransport {
  private readonly baseUrl: string;

  constructor(rawBaseUrl: string, private readonly fetchFn: typeof fetch = fetch) {
    this.baseUrl = normalizeBaseUrl(rawBaseUrl);
  }

  async send<TOperation extends AgentProtocolOperation>(
    request: CmaiAgentTransportRequest<TOperation>,
    options: CmaiAgentTransportOptions,
  ): Promise<CmaiAgentTransportResponse> {
    const route = implementedRoutes[request.operation as keyof typeof implementedRoutes];
    if (!route) {
      throw new CmaiAgentClientError({
        code: "transport_unavailable",
        source: "transport",
        message: `The platform ${request.operation} route is not available in this adapter scaffold. Manual copy/paste remains available.`,
        retryable: false,
        recovery: "manual_copy_fallback",
      });
    }

    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}${route}`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(request.envelope),
        redirect: "error",
        signal: options.signal,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new CmaiAgentClientError({
        code: "transport_unavailable",
        source: "transport",
        message: "The CMAI platform could not be reached. No response content was retained.",
        retryable: true,
        recovery: "retry_same_request",
      });
    }

    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) {
      throw new CmaiAgentClientError({
        code: "transport_response_malformed",
        source: "transport",
        message: "The CMAI platform response exceeded the adapter limit and was discarded.",
        retryable: false,
        recovery: "none",
      });
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new CmaiAgentClientError({
        code: "transport_response_malformed",
        source: "transport",
        message: "The CMAI platform returned non-JSON content, which was discarded.",
        retryable: false,
        recovery: "none",
      });
    }
    return { status: response.status, body };
  }
}

export class PairingHydrationTransport implements CmaiAgentTransport {
  private hydrated = false;

  constructor(
    private readonly pairingState: unknown,
    private readonly delegate: CmaiAgentTransport,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async send<TOperation extends AgentProtocolOperation>(
    request: CmaiAgentTransportRequest<TOperation>,
    options: CmaiAgentTransportOptions,
  ): Promise<CmaiAgentTransportResponse> {
    if (!this.hydrated && request.operation === "pair.create") {
      this.hydrated = true;
      return {
        status: 201,
        body: {
          protocol: "CMAI_AGENT_PROTOCOL_V1",
          protocol_version: CMAI_AGENT_PROTOCOL_VERSION,
          request_id: request.envelope.request_id,
          server_time: this.now().toISOString(),
          result: { pairing: this.pairingState },
        },
      };
    }
    return this.delegate.send(request, options);
  }
}
