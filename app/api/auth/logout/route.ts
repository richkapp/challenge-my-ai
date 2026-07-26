import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import { env, supabaseConfigured } from "@/lib/config/env";

export const runtime = "nodejs";

async function signOut(request: Request) {
  const url = new URL(request.url);
  let response = NextResponse.redirect(new URL("/login?signedOut=1", url.origin), { status: 303 });
  if (supabaseConfigured()) {
    const supabase = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      cookies: {
        getAll() {
          return (request.headers.get("cookie") || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
            const index = part.indexOf("=");
            return index === -1 ? { name: part, value: "" } : { name: part.slice(0, index), value: decodeURIComponent(part.slice(index + 1)) };
          });
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    });
    await supabase.auth.signOut();
  }
  response.cookies.set("cmai_user_id", "", { path: "/", maxAge: 0 });
  response.cookies.set("cmai_user_name", "", { path: "/", maxAge: 0 });
  response.cookies.set("cmai_role", "", { path: "/", maxAge: 0 });
  response.cookies.set("cmai_csrf", "", { path: "/", maxAge: 0 });
  return response;
}

export async function GET(request: Request) {
  return signOut(request);
}

export async function POST(request: Request) {
  return signOut(request);
}
