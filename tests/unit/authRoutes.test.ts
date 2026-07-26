import { describe, expect, it, vi } from "vitest";
import { GET as callbackGet } from "@/app/api/auth/callback/route";
import { GET as googleGet } from "@/app/api/auth/google/route";
import { GET as localLoginGet } from "@/app/api/auth/local-login/route";
import { POST as logoutPost } from "@/app/api/auth/logout/route";
import { POST as signupPost, createImmediateSignupSession, ensureConfirmedSupabaseUserWithAdmin, supabaseAdminCreateUser } from "@/app/api/auth/signup/route";
import { HttpError } from "@/lib/api/responses";
import { safeAuthRedirect } from "@/lib/auth/localAccount";

function formRequest(url: string, entries: Record<string, string>) {
  const form = new FormData();
  Object.entries(entries).forEach(([key, value]) => form.set(key, value));
  return new Request(url, { method: "POST", body: form });
}

describe("auth routes", () => {
  it("logs out with a browser-safe redirect and expires local cookies", async () => {
    const response = await logoutPost(new Request("http://test.local/api/auth/logout", { method: "POST", headers: { cookie: "cmai_user_id=user-1; cmai_user_name=Alice; cmai_role=user; cmai_csrf=abc" } }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://test.local/login?signedOut=1");
    const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie().join("\n") : response.headers.get("set-cookie") || "";
    expect(setCookie).toContain("cmai_user_id=");
    expect(setCookie).toContain("Max-Age=0");
    expect(setCookie).toContain("cmai_user_name=");
    expect(setCookie).toContain("cmai_csrf=");
  });

  it("creates a local preview account from signup when Supabase is absent", async () => {
    const response = await signupPost(formRequest("http://test.local/api/auth/signup", { name: "Z K", email: "z@example.com", password: "long-enough", next: "/lobby" }));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://test.local/lobby");
    const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie().join("\n") : response.headers.get("set-cookie") || "";
    expect(setCookie).toContain("cmai_user_id=preview-");
    expect(setCookie).toContain("cmai_user_name=Z%20K");
    expect(setCookie).toContain("cmai_role=user");
    expect(setCookie).toContain("cmai_csrf=");
  });

  it("rejects weak signup passwords", async () => {
    const response = await signupPost(formRequest("http://test.local/api/auth/signup", { name: "Z K", email: "z@example.com", password: "short", next: "/lobby" }));

    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "weak_password" });
  });

  it("creates an immediate Supabase session after server-confirmed signup", async () => {
    const ensureConfirmedUser = vi.fn(async () => {});
    const signInWithPassword = vi.fn(async () => ({ data: { session: { access_token: "session-token" } }, error: null }));
    const signUp = vi.fn(async () => ({ data: { session: null }, error: null }));
    const setSessionReadyCookie = vi.fn();

    await createImmediateSignupSession({ productionLike: true, serviceRoleKeyPresent: true }, { ensureConfirmedUser, signInWithPassword, signUp, setSessionReadyCookie });

    expect(ensureConfirmedUser).toHaveBeenCalledTimes(1);
    expect(signInWithPassword).toHaveBeenCalledTimes(1);
    expect(signUp).not.toHaveBeenCalled();
    expect(setSessionReadyCookie).toHaveBeenCalledTimes(1);
  });

  it("creates a confirmed Supabase user and ignores existing-user conflicts before sign-in", async () => {
    const adminCreateUser = vi.fn(async () => ({ error: { status: 422, message: "User already registered" } }));

    await ensureConfirmedSupabaseUserWithAdmin(adminCreateUser, { email: "z@example.com", password: "long-enough", name: "Z K" });

    expect(adminCreateUser).toHaveBeenCalledWith({ email: "z@example.com", password: "long-enough", email_confirm: true, user_metadata: { full_name: "Z K" } });
  });

  it("keeps Supabase admin createUser bound to its client context", async () => {
    let touched = false;
    const admin = {
      auth: {
        admin: {
          async createUser(this: unknown, input: Parameters<typeof ensureConfirmedSupabaseUserWithAdmin>[0] extends (arg: infer Arg) => unknown ? Arg : never) {
            if (this !== admin.auth.admin) throw new Error("lost createUser context");
            touched = true;
            expect(input.email).toBe("z@example.com");
            return { error: null };
          },
        },
      },
    };

    await ensureConfirmedSupabaseUserWithAdmin(supabaseAdminCreateUser(admin), { email: "z@example.com", password: "long-enough", name: "Z K" });

    expect(touched).toBe(true);
  });

  it("fails closed instead of falling back to email-confirmation limbo when production immediate signup lacks a service role", async () => {
    const ensureConfirmedUser = vi.fn(async () => {});
    const signInWithPassword = vi.fn(async () => ({ data: { session: { access_token: "session-token" } }, error: null }));
    const signUp = vi.fn(async () => ({ data: { session: null }, error: null }));
    const setSessionReadyCookie = vi.fn();

    let thrown: unknown;
    try {
      await createImmediateSignupSession({ productionLike: true, serviceRoleKeyPresent: false }, { ensureConfirmedUser, signInWithPassword, signUp, setSessionReadyCookie });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpError);
    expect(thrown).toMatchObject({ status: 503, code: "auth_provider_not_configured" });
    expect(ensureConfirmedUser).not.toHaveBeenCalled();
    expect(signInWithPassword).not.toHaveBeenCalled();
    expect(signUp).not.toHaveBeenCalled();
    expect(setSessionReadyCookie).not.toHaveBeenCalled();
  });

  it("creates a local preview login from email", async () => {
    const response = await localLoginGet(new Request("http://test.local/api/auth/local-login?email=z%40example.com&next=/credits"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://test.local/credits");
    const setCookie = response.headers.getSetCookie ? response.headers.getSetCookie().join("\n") : response.headers.get("set-cookie") || "";
    expect(setCookie).toContain("cmai_user_id=preview-");
  });

  it("keeps Google login honest when Supabase is not configured", async () => {
    const response = await googleGet(new Request("http://test.local/api/auth/google?next=/dashboard"));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://test.local/login?provider=google&error=provider_not_configured&next=%2Fdashboard");
  });

  it("preserves safe next redirects and rejects external auth redirects", async () => {
    expect(safeAuthRedirect("/challenges/new?from=login", "/dashboard")).toBe("/challenges/new?from=login");
    expect(safeAuthRedirect("//evil.example/path", "/dashboard")).toBe("/dashboard");
    expect(safeAuthRedirect("https://evil.example/path", "/dashboard")).toBe("/dashboard");
  });

  it("callback redirects to safe next paths without requiring a code", async () => {
    const response = await callbackGet(new Request("http://test.local/api/auth/callback?next=%2Flobby%3Fsort%3Dhot"));

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://test.local/lobby?sort=hot");
  });
});
