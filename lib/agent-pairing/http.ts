import { createHmac, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { NextResponse } from "next/server";
import { CMAI_AGENT_PROTOCOL, CMAI_AGENT_PROTOCOL_VERSION } from "@/lib/agent-protocol/constants";
import { AgentProtocolError } from "@/lib/agent-protocol/errors";
import { HttpError, handleApiError } from "@/lib/api/responses";
import { isProductionLike } from "@/lib/config/env";
import { PairingPlatformError } from "@/lib/agent-pairing/service";

export async function readBoundedRequestText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AgentProtocolError("body_too_large", `Request body exceeds ${maxBytes} bytes.`, 413, false, "$");
  }
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AgentProtocolError("body_too_large", `Request body exceeds ${maxBytes} bytes.`, 413, false, "$");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new AgentProtocolError("malformed_request", "Request body must be valid UTF-8 JSON.", 400, false, "$");
  }
}

export function agentProtocolSuccess(requestId: string, result: unknown, status = 200): NextResponse {
  return NextResponse.json({
    protocol: CMAI_AGENT_PROTOCOL,
    protocol_version: CMAI_AGENT_PROTOCOL_VERSION,
    request_id: requestId,
    server_time: new Date().toISOString(),
    result,
  }, { status });
}

function pairingPlatformProtocolError(error: PairingPlatformError): AgentProtocolError {
  const retryAfterSeconds = Math.max(1, Math.ceil((error.retryAfterMs ?? 1_000) / 1_000));
  if (error.code === "pairing_rate_limited") {
    return new AgentProtocolError("rate_limited", error.message, 429, true, undefined, retryAfterSeconds);
  }
  if (error.status >= 500) {
    return new AgentProtocolError("capacity_exceeded", error.message, 503, true, undefined, retryAfterSeconds);
  }
  if (error.code === "pairing_not_found") {
    return new AgentProtocolError("pairing_not_found", error.message, 401, false);
  }
  if (error.code === "pairing_revoked") {
    return new AgentProtocolError("pairing_revoked", error.message, 401, false);
  }
  return new AgentProtocolError("malformed_request", error.message, 400, false);
}

export function handlePairingRouteError(error: unknown, options: { requestId?: string; protocol?: boolean; surface?: string } = {}): NextResponse {
  if (options.protocol && error instanceof AgentProtocolError) {
    const headers: Record<string, string> = { "cache-control": "no-store" };
    if (error.retryAfterSeconds !== undefined) headers["retry-after"] = String(error.retryAfterSeconds);
    const body = {
      protocol: CMAI_AGENT_PROTOCOL,
      protocol_version: CMAI_AGENT_PROTOCOL_VERSION,
      ...(options.requestId ? { request_id: options.requestId } : {}),
      server_time: new Date().toISOString(),
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.field ? { field: error.field } : {}),
        ...(error.retryAfterSeconds ? { retry_after_seconds: error.retryAfterSeconds } : {}),
        ...(error.code === "unsupported_protocol_version" ? { supported_versions: [CMAI_AGENT_PROTOCOL_VERSION] } : {}),
      },
    };
    return NextResponse.json(body, { status: error.status, headers });
  }
  if (options.protocol && error instanceof PairingPlatformError) {
    return handlePairingRouteError(pairingPlatformProtocolError(error), options);
  }
  if (options.protocol) {
    return handlePairingRouteError(new AgentProtocolError(
      "service_unavailable",
      "Agent protocol persistence is temporarily unavailable.",
      503,
      true,
      undefined,
      1,
    ), options);
  }
  if (error instanceof PairingPlatformError) {
    const headers: Record<string, string> = { "cache-control": "no-store" };
    if (error.retryAfterMs !== undefined) headers["retry-after"] = String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000)));
    return NextResponse.json({
      error: error.message,
      code: error.code,
      ...(error.retryAfterMs !== undefined ? { retry_after_ms: error.retryAfterMs } : {}),
    }, { status: error.status, headers });
  }
  return handleApiError(error, { surface: options.surface || "agent_pairing" });
}

export function forbidPairingCodeInQuery(request: Request): void {
  const forbidden = new Set(["code", "pairing_code", "pairing-code", "pairingcode"]);
  for (const key of new URL(request.url).searchParams.keys()) {
    if (forbidden.has(key.toLowerCase())) {
      throw new HttpError(400, "Pairing codes are accepted only in POST request bodies.", "pairing_code_query_forbidden");
    }
  }
}

export function agentProtocolNetworkIdentity(
  request: Request,
  options: { production?: boolean; trustProxyHeaders?: boolean; edgeIdentitySecret?: string } = {},
): string {
  const production = options.production ?? isProductionLike();
  const trustProxyHeaders = options.trustProxyHeaders ?? process.env.CMAI_TRUST_PROXY_HEADERS === "1";
  if (!trustProxyHeaders) {
    if (production) {
      throw new AgentProtocolError("service_unavailable", "Agent protocol network identity is unavailable.", 503, true, undefined, 1);
    }
    return "local-development";
  }

  const secret = options.edgeIdentitySecret ?? process.env.CMAI_EDGE_IDENTITY_SECRET ?? "";
  const identity = (request.headers.get("x-cmai-edge-network-id") || "").normalize("NFKC");
  const suppliedSignature = request.headers.get("x-cmai-edge-network-signature") || "";
  if (
    Buffer.byteLength(secret, "utf8") < 32
    || !/^[A-Za-z0-9._:/-]{1,128}$/u.test(identity)
    || !/^[A-Za-z0-9_-]{43}$/u.test(suppliedSignature)
  ) {
    throw new AgentProtocolError("service_unavailable", "Agent protocol network identity is unavailable.", 503, true, undefined, 1);
  }
  const expected = createHmac("sha256", secret)
    .update(`CMAI_AGENT_EDGE_NETWORK_IDENTITY_V1\0${identity}`, "utf8")
    .digest();
  const supplied = Buffer.from(suppliedSignature, "base64url");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new AgentProtocolError("service_unavailable", "Agent protocol network identity is unavailable.", 503, true, undefined, 1);
  }
  return identity;
}

export function pairingRequestIdentity(request: Request): string {
  return agentProtocolNetworkIdentity(request);
}
