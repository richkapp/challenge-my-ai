import { NextResponse } from "next/server";
import { demoAuthAllowed } from "@/lib/config/env";
import { HttpError, handleApiError } from "@/lib/api/responses";
import { displayNameFromEmail, safeAuthRedirect, setLocalAccountCookies } from "@/lib/auth/localAccount";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    if (!demoAuthAllowed()) throw new HttpError(404, "Local preview login is not available in this environment.", "local_auth_disabled");
    const url = new URL(request.url);
    const email = (url.searchParams.get("email") || "preview@challenge-my-ai.local").trim().toLowerCase();
    if (!email.includes("@")) throw new HttpError(422, "Enter a valid email address.", "invalid_email");
    const redirectTo = safeAuthRedirect(url.searchParams.get("redirect") || url.searchParams.get("next"), "/dashboard");
    const name = url.searchParams.get("name") || displayNameFromEmail(email);
    const response = NextResponse.redirect(new URL(redirectTo, url.origin), { status: 303 });
    return setLocalAccountCookies(response, { email, name });
  } catch (error) {
    return handleApiError(error);
  }
}
