import { describe, expect, it, vi } from "vitest";
import { refreshRailwayOAuthAccessToken, RailwayOAuthRefreshError } from "@/lib/sandbox/railwayOAuth";

describe("Railway OAuth refresh", () => {
  it("exchanges a refresh token for an access token without exposing secret values", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify({
      access_token: "access-token-next",
      refresh_token: "refresh-token-next",
      expires_in: 3600,
      token_type: "Bearer",
      scope: "openid offline_access project:admin",
    }), { status: 200 }));

    const result = await refreshRailwayOAuthAccessToken({
      refreshToken: "refresh-token-current",
      clientId: "client-id",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      accessToken: "access-token-next",
      refreshToken: "refresh-token-next",
      expiresIn: 3600,
      tokenType: "Bearer",
    });
    const body = fetchImpl.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-token-current");
    expect(body.get("client_id")).toBe("client-id");
  });

  it("surfaces sanitized OAuth endpoint failures", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: "invalid_grant",
      error_description: "refresh token expired",
    }), { status: 400 }));

    await expect(refreshRailwayOAuthAccessToken({
      refreshToken: "refresh-token-current",
      clientId: "client-id",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow(RailwayOAuthRefreshError);
    await expect(refreshRailwayOAuthAccessToken({
      refreshToken: "refresh-token-current",
      clientId: "client-id",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toThrow("invalid_grant: refresh token expired");
  });
});
