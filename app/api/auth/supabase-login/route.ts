import { createServerClient } from "@supabase/ssr";
import { NextResponse } from "next/server";
import { env, supabaseConfigured } from "@/lib/config/env";
import { handleApiError, HttpError } from "@/lib/api/responses";

export const runtime = "nodejs";

function cookieList(request: Request) {
  return (request.headers.get("cookie") || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index === -1 ? { name: part, value: "" } : { name: part.slice(0, index), value: decodeURIComponent(part.slice(index + 1)) };
  });
}

export async function POST(request: Request) {
  try {
    if (!supabaseConfigured()) throw new HttpError(503, "Supabase Auth is not configured.", "auth_provider_not_configured");
    const form = await request.formData();
    const email = String(form.get("email") || "").trim().toLowerCase();
    if (!email || !email.includes("@")) throw new HttpError(422, "Enter a valid email address.", "invalid_email");
    const url = new URL(request.url);
    const next = String(form.get("next") || "/dashboard");
    const safeNext = next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
    const response = NextResponse.redirect(new URL(`/login?sent=1&email=${encodeURIComponent(email)}`, url.origin), { status: 303 });
    const supabase = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      cookies: {
        getAll: () => cookieList(request),
        setAll: (cookiesToSet) => cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options)),
      },
    });
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: new URL(`/api/auth/callback?next=${encodeURIComponent(safeNext)}`, url.origin).toString() },
    });
    if (error) throw new HttpError(502, "Supabase Auth rejected the login request.", "auth_provider_error", { message: error.message });
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
