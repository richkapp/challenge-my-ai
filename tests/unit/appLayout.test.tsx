import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppChrome, hasAccountSession } from "@/app/(app)/layout";

function cookieReader(cookies: Array<{ name: string; value?: string }>) {
  return {
    get(name: string) {
      return cookies.find((cookie) => cookie.name === name);
    },
    getAll() {
      return cookies;
    },
  };
}

describe("app layout account controls", () => {
  it("shows public browsing links and account creation for anonymous readers", () => {
    const html = renderToStaticMarkup(<AppChrome isAuthenticated={false}><div>App content</div></AppChrome>);

    expect(html).toContain("Feed");
    expect(html).toContain("Answers");
    expect(html).toContain("Docs");
    expect(html).toContain('href="/answers"');
    expect(html).toContain("Post");
    expect(html).toContain("Log in");
    expect(html).not.toContain("Sign out");
    expect(html).not.toContain('action="/api/auth/logout"');
  });

  it("exposes a visible POST sign-out control after an account session exists", () => {
    const html = renderToStaticMarkup(<AppChrome isAuthenticated><div>App content</div></AppChrome>);

    expect(html).toContain("Sign out");
    expect(html).toContain("Account");
    expect(html).toContain("Answers");
    expect(html).toContain('href="/answers"');
    expect(html).toContain('action="/api/auth/logout"');
    expect(html).toContain('method="post"');
  });

  it("detects local preview and Supabase cookie-backed account sessions", () => {
    expect(hasAccountSession(cookieReader([{ name: "cmai_user_id", value: "preview-user" }]))).toBe(true);
    expect(hasAccountSession(cookieReader([{ name: "sb-project-auth-token", value: "token" }]))).toBe(true);
    expect(hasAccountSession(cookieReader([]))).toBe(false);
  });
});
