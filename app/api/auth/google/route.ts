import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import { env, googleAuthConfigured } from "@/lib/config/env";
import { safeAuthRedirect } from "@/lib/auth/localAccount";

export const runtime = "nodejs";

function cookieList(request: Request) {
  return (request.headers.get("cookie") || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index === -1 ? { name: part, value: "" } : { name: part.slice(0, index), value: decodeURIComponent(part.slice(index + 1)) };
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const next = safeAuthRedirect(url.searchParams.get("next"), "/dashboard");
  if (!googleAuthConfigured()) {
    return NextResponse.redirect(new URL(`/login?provider=google&error=provider_not_configured&next=${encodeURIComponent(next)}`, url.origin), { status: 303 });
  }

  let response = NextResponse.redirect(new URL("/login?error=provider_error", url.origin), { status: 303 });
  const supabase = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => cookieList(request),
      setAll: (cookiesToSet) => cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options)),
    },
  });
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: new URL(`/api/auth/callback?next=${encodeURIComponent(next)}`, url.origin).toString() },
  });
  if (error || !data.url) {
    return NextResponse.redirect(new URL(`/login?provider=google&error=provider_error&next=${encodeURIComponent(next)}`, url.origin), { status: 303 });
  }
  response = NextResponse.redirect(data.url, { status: 303 });
  return response;
}
