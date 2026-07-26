import { Buffer } from "node:buffer";

export const DEFAULT_RAILWAY_OAUTH_TOKEN_URL = "https://backboard.railway.com/oauth/token";
export const RAILWAY_OAUTH_REFRESH_TOKEN_SECRET_REF = "railway_oauth_refresh_token";

export type RailwayOAuthRefreshResult = {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  scope?: string;
};

export type RailwayOAuthRefreshInput = {
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
  tokenUrl?: string;
  fetchImpl?: typeof fetch;
};

export class RailwayOAuthRefreshError extends Error {
  readonly code = "RAILWAY_OAUTH_REFRESH_FAILED" as const;

  constructor(message = "Railway OAuth refresh failed.", options?: ErrorOptions) {
    super(message, options);
  }
}

function safeErrorMessage(status: number, text: string) {
  const trimmed = text.trim();
  if (!trimmed) return `Railway OAuth token endpoint returned HTTP ${status}.`;
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const error = typeof parsed.error === "string" ? parsed.error : undefined;
    const description = typeof parsed.error_description === "string" ? parsed.error_description : undefined;
    return [error, description].filter(Boolean).join(": ") || `Railway OAuth token endpoint returned HTTP ${status}.`;
  } catch {
    return `Railway OAuth token endpoint returned HTTP ${status}.`;
  }
}

export async function refreshRailwayOAuthAccessToken(input: RailwayOAuthRefreshInput): Promise<RailwayOAuthRefreshResult> {
  const refreshToken = input.refreshToken.trim();
  const clientId = input.clientId.trim();
  if (!refreshToken) throw new RailwayOAuthRefreshError("RAILWAY_OAUTH_REFRESH_TOKEN is required for Railway OAuth refresh.");
  if (!clientId) throw new RailwayOAuthRefreshError("RAILWAY_OAUTH_CLIENT_ID is required for Railway OAuth refresh.");

  const fetchImpl = input.fetchImpl || globalThis.fetch;
  if (!fetchImpl) throw new RailwayOAuthRefreshError("No fetch implementation is available for Railway OAuth refresh.");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const headers: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
  };
  if (input.clientSecret) {
    headers.Authorization = `Basic ${Buffer.from(`${clientId}:${input.clientSecret}`).toString("base64")}`;
  }

  const response = await fetchImpl(input.tokenUrl || DEFAULT_RAILWAY_OAUTH_TOKEN_URL, {
    method: "POST",
    headers,
    body,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new RailwayOAuthRefreshError(safeErrorMessage(response.status, text));
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new RailwayOAuthRefreshError("Railway OAuth token endpoint returned invalid JSON.", { cause: error });
  }

  const accessToken = typeof parsed.access_token === "string" ? parsed.access_token : "";
  if (!accessToken) throw new RailwayOAuthRefreshError("Railway OAuth token endpoint did not return an access token.");
  const refreshTokenOut = typeof parsed.refresh_token === "string" && parsed.refresh_token.trim() ? parsed.refresh_token : undefined;
  const expiresIn = typeof parsed.expires_in === "number" ? parsed.expires_in : undefined;
  const tokenType = typeof parsed.token_type === "string" ? parsed.token_type : undefined;
  const scope = typeof parsed.scope === "string" ? parsed.scope : undefined;
  return { accessToken, refreshToken: refreshTokenOut, expiresIn, tokenType, scope };
}
