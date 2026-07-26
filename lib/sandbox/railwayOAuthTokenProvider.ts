import { RAILWAY_OAUTH_REFRESH_TOKEN_SECRET_REF, refreshRailwayOAuthAccessToken, type RailwayOAuthRefreshInput, type RailwayOAuthRefreshResult } from "@/lib/sandbox/railwayOAuth";

export type RailwayOAuthTokenProviderRuntime = {
  RAILWAY_OAUTH_REFRESH_TOKEN?: string;
  RAILWAY_OAUTH_CLIENT_ID?: string;
  RAILWAY_OAUTH_CLIENT_SECRET?: string;
  RAILWAY_OAUTH_TOKEN_URL?: string;
};

type RuntimeSecretStore = {
  getRuntimeSecret(input: { ref: string }): string | undefined | Promise<string | undefined>;
  setRuntimeSecret(input: { ref: string; value: string }): unknown | Promise<unknown>;
};

type RailwayOAuthRefreshFn = (input: RailwayOAuthRefreshInput) => Promise<RailwayOAuthRefreshResult>;

export type CreateRailwayOAuthAccessTokenProviderInput = {
  runtime: RailwayOAuthTokenProviderRuntime;
  secrets: RuntimeSecretStore;
  refresh?: RailwayOAuthRefreshFn;
};

async function refreshWith(input: {
  runtime: RailwayOAuthTokenProviderRuntime;
  refreshToken: string;
  refresh: RailwayOAuthRefreshFn;
}) {
  return input.refresh({
    refreshToken: input.refreshToken,
    clientId: input.runtime.RAILWAY_OAUTH_CLIENT_ID || "",
    clientSecret: input.runtime.RAILWAY_OAUTH_CLIENT_SECRET || undefined,
    tokenUrl: input.runtime.RAILWAY_OAUTH_TOKEN_URL || undefined,
  });
}

async function persistReturnedRefreshToken(input: {
  secrets: RuntimeSecretStore;
  previousStoredRefreshToken: string | undefined;
  refreshed: RailwayOAuthRefreshResult;
}) {
  if (input.refreshed.refreshToken && input.refreshed.refreshToken !== input.previousStoredRefreshToken) {
    await input.secrets.setRuntimeSecret({
      ref: RAILWAY_OAUTH_REFRESH_TOKEN_SECRET_REF,
      value: input.refreshed.refreshToken,
    });
  }
}

export function createRailwayOAuthAccessTokenProvider(input: CreateRailwayOAuthAccessTokenProviderInput) {
  const refresh = input.refresh || refreshRailwayOAuthAccessToken;

  return async () => {
    const storedRefreshToken = await input.secrets.getRuntimeSecret({ ref: RAILWAY_OAUTH_REFRESH_TOKEN_SECRET_REF });
    const refreshToken = storedRefreshToken || input.runtime.RAILWAY_OAUTH_REFRESH_TOKEN || "";

    try {
      const refreshed = await refreshWith({ runtime: input.runtime, refreshToken, refresh });
      await persistReturnedRefreshToken({
        secrets: input.secrets,
        previousStoredRefreshToken: storedRefreshToken,
        refreshed,
      });
      return refreshed.accessToken;
    } catch (error) {
      const latestStoredRefreshToken = await input.secrets.getRuntimeSecret({ ref: RAILWAY_OAUTH_REFRESH_TOKEN_SECRET_REF });
      if (latestStoredRefreshToken && latestStoredRefreshToken !== refreshToken) {
        const refreshed = await refreshWith({ runtime: input.runtime, refreshToken: latestStoredRefreshToken, refresh });
        await persistReturnedRefreshToken({
          secrets: input.secrets,
          previousStoredRefreshToken: latestStoredRefreshToken,
          refreshed,
        });
        return refreshed.accessToken;
      }
      throw error;
    }
  };
}
