import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authMode, env, isProductionLike, supabaseConfigured, type RuntimeEnv } from "@/lib/config/env";

const ACCOUNT_REQUIRED_PATHS = ["/agents", "/credits", "/dashboard", "/moderation"];
const ACCOUNT_REQUIRED_EXACT_OR_CHILD_PATHS = ["/challenges/new"];

export function isAccountRequiredAppPath(pathname: string) {
  return (
    ACCOUNT_REQUIRED_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)) ||
    ACCOUNT_REQUIRED_EXACT_OR_CHILD_PATHS.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
  );
}

export function shouldRedirectLocalAppRequest({ pathname, hasLocalUserCookie, runtime = env }: { pathname: string; hasLocalUserCookie: boolean; runtime?: RuntimeEnv }) {
  return authMode(runtime) === "local" && isAccountRequiredAppPath(pathname) && !hasLocalUserCookie && runtime.CMAI_ENABLE_DEMO_AUTH !== "1";
}

function applySecurityHeaders(response: NextResponse) {
  const contentSecurityPolicy = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://*.supabase.co https://*.posthog.com https://*.sentry.io https://*.ingest.sentry.io https://api.openrouter.ai",
  ].join("; ");

  response.headers.set("Content-Security-Policy", contentSecurityPolicy);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  return response;
}

function randomHex(bytes: number) {
  const values = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

function ensureCsrfCookie(request: NextRequest, response: NextResponse) {
  if (request.cookies.get("cmai_csrf")) return;
  response.cookies.set("cmai_csrf", randomHex(24), {
    sameSite: "lax",
    secure: isProductionLike(),
    path: "/",
  });
}

export async function proxy(request: NextRequest) {
  let response = applySecurityHeaders(NextResponse.next({ request }));
  ensureCsrfCookie(request, response);

  if (authMode() === "supabase" && supabaseConfigured()) {
    const supabase = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = applySecurityHeaders(NextResponse.next({ request }));
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
          ensureCsrfCookie(request, response);
        },
      },
    });

    const { data } = await supabase.auth.getUser();
    if (isProductionLike() && isAccountRequiredAppPath(request.nextUrl.pathname) && !data.user) {
      const loginUrl = request.nextUrl.clone();
      loginUrl.pathname = "/login";
      loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
      const redirect = applySecurityHeaders(NextResponse.redirect(loginUrl));
      ensureCsrfCookie(request, redirect);
      return redirect;
    }
  }

  if (shouldRedirectLocalAppRequest({ pathname: request.nextUrl.pathname, hasLocalUserCookie: Boolean(request.cookies.get("cmai_user_id")) })) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
    const redirect = applySecurityHeaders(NextResponse.redirect(loginUrl));
    ensureCsrfCookie(request, redirect);
    return redirect;
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
};
