import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { demoAuthAllowed, env, isProductionLike, supabaseConfigured } from "@/lib/config/env";
import { handleApiError, HttpError } from "@/lib/api/responses";
import { safeAuthRedirect, setLocalAccountCookies } from "@/lib/auth/localAccount";

export const runtime = "nodejs";

function cookieList(request: Request) {
  return (request.headers.get("cookie") || "").split(";").map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return index === -1 ? { name: part, value: "" } : { name: part.slice(0, index), value: decodeURIComponent(part.slice(index + 1)) };
  });
}

function validateSignup(form: FormData) {
  const name = String(form.get("name") || "").trim();
  const email = String(form.get("email") || "").trim().toLowerCase();
  const password = String(form.get("password") || "");
  const next = safeAuthRedirect(form.get("next"), "/dashboard");
  if (!name) throw new HttpError(422, "Enter your name.", "invalid_name");
  if (!email || !email.includes("@")) throw new HttpError(422, "Enter a valid email address.", "invalid_email");
  if (password.length < 8) throw new HttpError(422, "Password must be at least 8 characters.", "weak_password");
  return { name, email, password, next };
}

function isAlreadyRegistered(error: { message?: string; code?: string; status?: number } | null | undefined) {
  const message = (error?.message || "").toLowerCase();
  return error?.status === 422 || error?.code === "email_exists" || message.includes("already") || message.includes("registered") || message.includes("exists");
}

export type SupabaseAdminCreateUser = (input: { email: string; password: string; email_confirm: true; user_metadata: { full_name: string } }) => Promise<{ error: { message?: string; code?: string; status?: number } | null }>;

export type SupabaseAdminClientWithCreateUser = {
  auth: {
    admin: {
      createUser: SupabaseAdminCreateUser;
    };
  };
};

export function supabaseAdminCreateUser(admin: SupabaseAdminClientWithCreateUser): SupabaseAdminCreateUser {
  return (input) => admin.auth.admin.createUser(input);
}

export async function ensureConfirmedSupabaseUserWithAdmin(createUser: SupabaseAdminCreateUser, { email, password, name }: { email: string; password: string; name: string }) {
  const { error } = await createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: name },
  });
  if (error && !isAlreadyRegistered(error)) {
    throw new HttpError(502, "Supabase Auth rejected account creation.", "auth_provider_error", { message: error.message });
  }
}

async function ensureConfirmedSupabaseUser({ email, password, name }: { email: string; password: string; name: string }) {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new HttpError(503, "Immediate account creation is not configured on this deployment.", "auth_provider_not_configured");
  }
  const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  await ensureConfirmedSupabaseUserWithAdmin(supabaseAdminCreateUser(admin), { email, password, name });
}

type SignupAuthResult = { data: { session: unknown | null }; error: { message?: string } | null };

type ImmediateSignupDeps = {
  ensureConfirmedUser: () => Promise<void>;
  signInWithPassword: () => Promise<SignupAuthResult>;
  signUp: () => Promise<SignupAuthResult>;
  setSessionReadyCookie: () => void;
};

export async function createImmediateSignupSession({ productionLike, serviceRoleKeyPresent }: { productionLike: boolean; serviceRoleKeyPresent: boolean }, deps: ImmediateSignupDeps) {
  if (serviceRoleKeyPresent) {
    await deps.ensureConfirmedUser();
    const { data, error } = await deps.signInWithPassword();
    if (error || !data.session) {
      throw new HttpError(502, "Supabase Auth could not start a session for the new account.", "auth_provider_error", { message: error?.message || "missing_session" });
    }
    deps.setSessionReadyCookie();
    return;
  }

  if (productionLike) {
    throw new HttpError(503, "Immediate account creation is not configured on this deployment.", "auth_provider_not_configured");
  }

  const { data, error } = await deps.signUp();
  if (error) throw new HttpError(502, "Supabase Auth rejected account creation.", "auth_provider_error", { message: error.message });
  if (!data.session) throw new HttpError(503, "Immediate account creation is not configured on this deployment.", "auth_provider_not_configured");
  deps.setSessionReadyCookie();
}

function supabaseServerClient(request: Request, response: NextResponse) {
  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll: () => cookieList(request),
      setAll: (cookiesToSet) => cookiesToSet.forEach(({ name: cookieName, value, options }) => response.cookies.set(cookieName, value, options)),
    },
  });
}

export async function POST(request: Request) {
  try {
    const form = await request.formData();
    const { name, email, password, next } = validateSignup(form);
    const url = new URL(request.url);

    if (!supabaseConfigured()) {
      if (!demoAuthAllowed()) throw new HttpError(503, "Account creation is not connected on this deployment yet.", "auth_provider_not_configured");
      const response = NextResponse.redirect(new URL(next, url.origin), { status: 303 });
      return setLocalAccountCookies(response, { email, name });
    }

    const response = NextResponse.redirect(new URL(next, url.origin), { status: 303 });
    const supabase = supabaseServerClient(request, response);
    await createImmediateSignupSession({ productionLike: isProductionLike(), serviceRoleKeyPresent: Boolean(env.SUPABASE_SERVICE_ROLE_KEY) }, {
      ensureConfirmedUser: () => ensureConfirmedSupabaseUser({ email, password, name }),
      signInWithPassword: () => supabase.auth.signInWithPassword({ email, password }),
      signUp: () => supabase.auth.signUp({
        email,
        password,
        options: {
          data: { full_name: name },
          emailRedirectTo: new URL(`/api/auth/callback?next=${encodeURIComponent(next)}`, url.origin).toString(),
        },
      }),
      setSessionReadyCookie: () => response.cookies.set("cmai_csrf", cryptoRandom(), { sameSite: "lax", secure: true, path: "/" }),
    });
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}

function cryptoRandom() {
  const values = new Uint8Array(24);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}
