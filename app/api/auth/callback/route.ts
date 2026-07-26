import crypto from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import { env, supabaseConfigured } from "@/lib/config/env";

export const runtime = "nodejs";

function cookieList(request: Request) {
  return (request.headers.get("cookie") || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index === -1 ? { name: part, value: "" } : { name: part.slice(0, index), value: decodeURIComponent(part.slice(index + 1)) };
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next") || "/dashboard";
  const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
  let response = NextResponse.redirect(new URL(safeNext, url.origin));
  if (code && supabaseConfigured()) {
    const supabase = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      cookies: {
        getAll: () => cookieList(request),
        setAll: (cookiesToSet) => cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options)),
      },
    });
    await supabase.auth.exchangeCodeForSession(code);
    response.cookies.set("cmai_csrf", crypto.randomBytes(24).toString("hex"), { sameSite: "lax", secure: true, path: "/" });
  }
  return response;
}
