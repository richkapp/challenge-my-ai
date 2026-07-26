import { describe, expect, it, vi } from "vitest";
import { RAILWAY_OAUTH_REFRESH_TOKEN_SECRET_REF, RailwayOAuthRefreshError } from "@/lib/sandbox/railwayOAuth";
import { createRailwayOAuthAccessTokenProvider } from "@/lib/sandbox/railwayOAuthTokenProvider";

function runtime(overrides: Partial<Parameters<typeof createRailwayOAuthAccessTokenProvider>[0]["runtime"]> = {}) {
  return {
    RAILWAY_OAUTH_REFRESH_TOKEN: "bootstrap-refresh-token",
    RAILWAY_OAUTH_CLIENT_ID: "railway-client-id",
    RAILWAY_OAUTH_CLIENT_SECRET: "railway-client-secret",
    RAILWAY_OAUTH_TOKEN_URL: "https://railway.example/oauth/token",
    ...overrides,
  };
}

function runtimeSecretStore(initial?: string) {
  let stored = initial;
  const getRuntimeSecret = vi.fn(async () => stored);
  const setRuntimeSecret = vi.fn(async (input: { ref: string; value: string }) => {
    stored = input.value;
    return { ref: input.ref, updatedAt: new Date("2026-07-06T00:00:00.000Z").toISOString(), rotatedAt: initial ? new Date("2026-07-06T00:00:00.000Z").toISOString() : undefined };
  });
  return {
    secrets: { getRuntimeSecret, setRuntimeSecret },
    getRuntimeSecret,
    setRuntimeSecret,
    current: () => stored,
  };
}

describe("Railway OAuth access-token provider", () => {
  it("uses the bootstrap refresh token, returns only the access token, and stores the returned refresh token", async () => {
    const store = runtimeSecretStore();
    const refresh = vi.fn(async () => ({
      accessToken: "railway-access-token-next",
      refreshToken: "railway-refresh-token-next",
      expiresIn: 3600,
      tokenType: "Bearer",
    }));
    const provider = createRailwayOAuthAccessTokenProvider({ runtime: runtime(), secrets: store.secrets, refresh });

    await expect(provider()).resolves.toBe("railway-access-token-next");

    expect(refresh).toHaveBeenCalledWith({
      refreshToken: "bootstrap-refresh-token",
      clientId: "railway-client-id",
      clientSecret: "railway-client-secret",
      tokenUrl: "https://railway.example/oauth/token",
    });
    expect(store.setRuntimeSecret).toHaveBeenCalledWith({
      ref: RAILWAY_OAUTH_REFRESH_TOKEN_SECRET_REF,
      value: "railway-refresh-token-next",
    });
    expect(store.current()).toBe("railway-refresh-token-next");
  });

  it("prefers the persisted refresh token over the bootstrap env token", async () => {
    const store = runtimeSecretStore("persisted-refresh-token");
    const refresh = vi.fn(async () => ({
      accessToken: "railway-access-token-from-persisted-token",
      refreshToken: "persisted-refresh-token",
    }));
    const provider = createRailwayOAuthAccessTokenProvider({ runtime: runtime(), secrets: store.secrets, refresh });

    await expect(provider()).resolves.toBe("railway-access-token-from-persisted-token");

    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ refreshToken: "persisted-refresh-token" }));
    expect(refresh).not.toHaveBeenCalledWith(expect.objectContaining({ refreshToken: "bootstrap-refresh-token" }));
    expect(store.setRuntimeSecret).not.toHaveBeenCalled();
  });

  it("retries once with a newer persisted refresh token after a rotation race", async () => {
    const getRuntimeSecret = vi
      .fn<() => Promise<string | undefined>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce("persisted-refresh-token-from-other-run");
    const setRuntimeSecret = vi.fn(async () => undefined);
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new RailwayOAuthRefreshError("invalid_grant: refresh token expired"))
      .mockResolvedValueOnce({
        accessToken: "railway-access-token-after-retry",
        refreshToken: "persisted-refresh-token-after-retry",
      });
    const provider = createRailwayOAuthAccessTokenProvider({
      runtime: runtime(),
      secrets: { getRuntimeSecret, setRuntimeSecret },
      refresh,
    });

    await expect(provider()).resolves.toBe("railway-access-token-after-retry");

    expect(refresh).toHaveBeenNthCalledWith(1, expect.objectContaining({ refreshToken: "bootstrap-refresh-token" }));
    expect(refresh).toHaveBeenNthCalledWith(2, expect.objectContaining({ refreshToken: "persisted-refresh-token-from-other-run" }));
    expect(setRuntimeSecret).toHaveBeenCalledWith({
      ref: RAILWAY_OAUTH_REFRESH_TOKEN_SECRET_REF,
      value: "persisted-refresh-token-after-retry",
    });
  });

  it("fails closed without replacing the stored token when refresh fails and no newer persisted token exists", async () => {
    const store = runtimeSecretStore("persisted-refresh-token");
    const refresh = vi.fn(async () => {
      throw new RailwayOAuthRefreshError("invalid_grant: refresh token expired");
    });
    const provider = createRailwayOAuthAccessTokenProvider({ runtime: runtime(), secrets: store.secrets, refresh });

    await expect(provider()).rejects.toThrow("invalid_grant: refresh token expired");

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(store.setRuntimeSecret).not.toHaveBeenCalled();
    expect(store.current()).toBe("persisted-refresh-token");
  });
});
