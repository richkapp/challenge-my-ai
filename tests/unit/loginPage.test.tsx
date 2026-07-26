import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import LoginPage, { GoogleLoginAction } from "@/app/(auth)/login/page";

describe("login page copy", () => {
  it("exposes create-account and preview login without a dead Google href when provider config is missing", async () => {
    const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain("Log in.");
    expect(html).toContain("Browse without an account");
    expect(html).toContain("Create account");
    expect(html).toContain("Google sign-in unavailable");
    expect(html).toContain("Preview email");
    expect(html).toContain("Preview accounts are temporary");
    expect(html).not.toContain('href="/api/auth/google');
    expect(html).not.toContain("Local OP");
    expect(html).not.toContain("Continue as");
    expect(html).not.toContain("Moderator");
    expect(html).not.toContain("Supabase Auth");
  });

  it("renders an active Google link only after provider readiness is true", () => {
    const html = renderToStaticMarkup(<GoogleLoginAction googleHref="/api/auth/google?next=%2Fanswers" googleReady hasSupabase />);

    expect(html).toContain("Continue with Google");
    expect(html).toContain('href="/api/auth/google?next=%2Fanswers"');
    expect(html).not.toContain("Google sign-in unavailable");
  });

  it("frames challenge-return signup as joining the same thread", async () => {
    const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ next: "/challenges/seed-reddit-ai-debate-feed" }) }));

    expect(html).toContain("Join the challenge.");
    expect(html).toContain("Create an account to submit your perspective.");
    expect(html).toContain('name="next" value="/challenges/seed-reddit-ai-debate-feed"');
  });

  it("confirms when the user has signed out", async () => {
    const html = renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({ signedOut: "1" }) }));

    expect(html).toContain("You&#x27;re signed out");
  });
});
