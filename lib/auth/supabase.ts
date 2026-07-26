import { createServerClient } from "@supabase/ssr";
import { createClient, type User } from "@supabase/supabase-js";
import type { CurrentUser } from "@/lib/types";
import { env, supabaseConfigured, type RuntimeEnv } from "@/lib/config/env";

function parseCookieHeader(cookieHeader: string) {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const index = part.indexOf("=");
      if (index === -1) return { name: part, value: "" };
      return { name: part.slice(0, index), value: decodeURIComponent(part.slice(index + 1)) };
    });
}

export function supabaseAuthConfigured(runtime: RuntimeEnv = env) {
  return supabaseConfigured(runtime);
}

export function currentUserFromSupabaseUser(user: User): CurrentUser {
  // Supabase user_metadata is writable by the authenticated user. Privileged
  // roles must come only from admin-controlled app_metadata.
  const role = user.app_metadata?.cmai_role === "moderator" ? "moderator" : "user";
  const name =
    (typeof user.user_metadata?.full_name === "string" && user.user_metadata.full_name) ||
    (typeof user.user_metadata?.name === "string" && user.user_metadata.name) ||
    user.email ||
    user.id;
  return { id: user.id, name, role, authSource: "supabase" };
}

export async function userFromSupabaseRequest(request: Request, runtime: RuntimeEnv = env): Promise<CurrentUser | null> {
  if (!supabaseConfigured(runtime)) return null;

  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) {
    const supabase = createClient(runtime.NEXT_PUBLIC_SUPABASE_URL, runtime.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${bearer}` } },
    });
    const { data, error } = await supabase.auth.getUser(bearer);
    if (!error && data.user) return currentUserFromSupabaseUser(data.user);
  }

  const cookies = parseCookieHeader(request.headers.get("cookie") || "");
  if (!cookies.length) return null;

  const supabase = createServerClient(runtime.NEXT_PUBLIC_SUPABASE_URL, runtime.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookies;
      },
      setAll() {
        // Route handlers return their own NextResponse objects. Middleware owns cookie refresh writes.
      },
    },
  });
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return currentUserFromSupabaseUser(data.user);
}
