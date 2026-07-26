import type { Challenge, CurrentUser } from "@/lib/types";
import { HttpError } from "@/lib/api/responses";
import { authMode, demoAuthAllowed, env, isTestLike, type RuntimeEnv } from "@/lib/config/env";
import { userFromSupabaseRequest } from "./supabase";
import { assertSameOrigin } from "@/lib/security/origin";
import { assertRateLimitPolicy } from "@/lib/security/rateLimit";

export function cookieValue(headers: Headers, key: string) {
  const cookie = headers.get("cookie") || "";
  return cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${key}=`))?.slice(key.length + 1);
}

export function userFromHeaders(headers: Headers, options: { allowDevFallback?: boolean; allowHeaderIdentity?: boolean; allowLocalCookie?: boolean; runtime?: RuntimeEnv } = {}): CurrentUser | null {
  const runtime = options.runtime ?? env;
  const mode = authMode(runtime);
  const allowHeaderIdentity = options.allowHeaderIdentity ?? (isTestLike(runtime) || mode === "test");
  const allowLocalCookie = options.allowLocalCookie ?? (demoAuthAllowed(runtime) || isTestLike(runtime));

  const headerUser = headers.get("x-cmai-user-id");
  if (headerUser && allowHeaderIdentity) {
    return {
      id: headerUser,
      name: headers.get("x-cmai-user-name") || headerUser,
      role: headers.get("x-cmai-role") === "moderator" ? "moderator" : "user",
      authSource: "header",
    };
  }

  const cookieUser = cookieValue(headers, "cmai_user_id");
  if (cookieUser && allowLocalCookie) {
    return {
      id: decodeURIComponent(cookieUser),
      name: decodeURIComponent(cookieValue(headers, "cmai_user_name") || cookieUser),
      role: cookieValue(headers, "cmai_role") === "moderator" ? "moderator" : "user",
      authSource: "cookie",
    };
  }

  const allowDevFallback = options.allowDevFallback ?? ["1"].includes(runtime.CMAI_ENABLE_DEMO_AUTH || "");
  if (allowDevFallback && demoAuthAllowed(runtime)) {
    return { id: "local-op", name: "Demo user", role: "user", authSource: "local-dev" };
  }

  return null;
}

export async function currentUser(request: Request, options: { runtime?: RuntimeEnv } = {}): Promise<CurrentUser | null> {
  const runtime = options.runtime ?? env;
  const local = userFromHeaders(request.headers, { runtime });
  if (local) return local;
  if (authMode(runtime) === "supabase") return userFromSupabaseRequest(request, runtime);
  return null;
}

export async function requireUser(request: Request): Promise<CurrentUser> {
  const user = await currentUser(request);
  if (!user) throw new HttpError(401, "Authentication required.", "unauthenticated");
  assertCsrfIfCookieSession(request, user);
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    assertRateLimitPolicy("authenticated_mutation", `user:${user.id}:${new URL(request.url).pathname}`);
  }
  return user;
}

export async function requireModerator(request: Request): Promise<CurrentUser> {
  const user = await requireUser(request);
  if (user.role !== "moderator") throw new HttpError(403, "Moderator access required.", "forbidden");
  return user;
}

export function assertChallengePoster(user: CurrentUser, challenge: Challenge) {
  if (challenge.posterId !== user.id && user.role !== "moderator") {
    throw new HttpError(403, "Only the person who posted this challenge can perform this action.", "forbidden");
  }
}

export function assertCsrfIfCookieSession(request: Request, user: CurrentUser) {
  if (!["cookie", "supabase"].includes(user.authSource)) return;
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  assertSameOrigin(request);
  const csrfCookie = cookieValue(request.headers, "cmai_csrf");
  const csrfHeader = request.headers.get("x-cmai-csrf");
  if (!csrfCookie || !csrfHeader) throw new HttpError(403, "CSRF token required.", "csrf_required");
  if (csrfHeader !== csrfCookie) throw new HttpError(403, "CSRF token mismatch.", "csrf_mismatch");
}

export function currentLocalUser() {
  return { id: "local-op", name: "Demo user", credits: 100 };
}
