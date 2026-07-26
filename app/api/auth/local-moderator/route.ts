import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { demoAuthAllowed, env, isProductionLike } from "@/lib/config/env";
import { HttpError, handleApiError } from "@/lib/api/responses";

export const runtime = "nodejs";

function safeRedirect(value: string | null, fallback: string) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : fallback;
}

export async function GET(request: Request) {
  try {
    if (!demoAuthAllowed()) throw new HttpError(404, "Local demo moderator login is not available in this environment.", "local_auth_disabled");
    const url = new URL(request.url);
    const redirectTo = safeRedirect(url.searchParams.get("redirect") || url.searchParams.get("next"), "/moderation");
    const response = NextResponse.redirect(new URL(redirectTo, url.origin));
    const secure = isProductionLike(env);
    response.cookies.set("cmai_user_id", "local-moderator", { httpOnly: true, sameSite: "lax", secure, path: "/" });
    response.cookies.set("cmai_user_name", "Local Moderator", { httpOnly: true, sameSite: "lax", secure, path: "/" });
    response.cookies.set("cmai_role", "moderator", { httpOnly: true, sameSite: "lax", secure, path: "/" });
    response.cookies.set("cmai_csrf", crypto.randomBytes(24).toString("hex"), { sameSite: "lax", secure, path: "/" });
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
