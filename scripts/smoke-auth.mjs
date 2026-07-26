#!/usr/bin/env node

const base = (process.argv[2] || process.env.CMAI_SMOKE_BASE_URL || "http://localhost:3000").replace(/\/$/, "");

async function fetchText(path, init) {
  const response = await fetch(`${base}${path}`, { redirect: "manual", ...init });
  return { response, text: await response.text() };
}

function headerLocation(response) {
  return response.headers.get("location") || "";
}

function setCookieHeader(response) {
  if (typeof response.headers.getSetCookie === "function") return response.headers.getSetCookie().join("\n");
  return response.headers.get("set-cookie") || "";
}

const failures = [];

const healthResponse = await fetch(`${base}/api/system/health`, { redirect: "manual" });
const healthText = await healthResponse.text();
let health;
try {
  health = JSON.parse(healthText);
} catch {
  failures.push(`health did not return JSON: ${healthText.slice(0, 160)}`);
  health = {};
}

const googleReady = Boolean(health?.providers?.googleAuth || health?.publicRuntime?.googleAuthConfigured);
const supabaseReady = Boolean(health?.providers?.supabaseAuth);
const mode = String(health?.mode || "unknown");
const authMode = String(health?.publicRuntime?.authMode || "unknown");

const login = await fetchText("/login?provider=google&error=provider_not_configured&next=%2Fanswers");
const hasActiveGoogleHref = login.text.includes('href="/api/auth/google') || login.text.includes("href='/api/auth/google");
const hasUnavailableCopy = login.text.includes("Google sign-in unavailable") || login.text.includes("Google login is not connected");
if (!login.text.includes('name="next" value="/answers"')) failures.push("login page does not preserve hidden next=/answers for email/signup flows");
if (!login.text.includes("Post a challenge when you have a risky Agent answer")) failures.push("login page does not explain post/browse/contribute/Agent Home onboarding actions");

if (!googleReady && hasActiveGoogleHref) {
  failures.push("login page exposes an active /api/auth/google href while health reports googleAuth=false");
}
if (!googleReady && !hasUnavailableCopy) {
  failures.push("login page does not explain that Google sign-in is unavailable while googleAuth=false");
}
if (googleReady && !hasActiveGoogleHref) {
  failures.push("health reports googleAuth=true but login page does not expose an active /api/auth/google href");
}

const google = await fetchText("/api/auth/google?next=/answers");
const googleLocation = headerLocation(google.response);
if (!googleReady && !(google.response.status >= 300 && google.response.status < 400 && googleLocation.includes("provider_not_configured") && googleLocation.includes("next=%2Fanswers"))) {
  failures.push(`google route should redirect to provider_not_configured with next=/answers when googleAuth=false; got status=${google.response.status} location=${googleLocation}`);
}
if (googleReady && googleLocation.includes("provider_not_configured")) {
  failures.push("google route still returns provider_not_configured while health reports googleAuth=true");
}

const gatedNewChallenge = await fetchText("/challenges/new?template=first");
const gatedLocation = headerLocation(gatedNewChallenge.response);
const expectsAnonymousComposerRedirect = authMode !== "test";
if (expectsAnonymousComposerRedirect && !(gatedNewChallenge.response.status >= 300 && gatedNewChallenge.response.status < 400 && gatedLocation.includes("/login") && gatedLocation.includes("next=%2Fchallenges%2Fnew%3Ftemplate%3Dfirst"))) {
  failures.push(`anonymous /challenges/new should preserve next redirect to login; got status=${gatedNewChallenge.response.status} location=${gatedLocation}`);
}

const publicAnswers = await fetchText("/answers");
if (publicAnswers.response.status !== 200 || !publicAnswers.text.includes("decision artifacts")) {
  failures.push(`/answers should remain public-readable; got status=${publicAnswers.response.status}`);
}

let localSignupChecked = false;
if (mode !== "production" && authMode !== "test" && !supabaseReady) {
  localSignupChecked = true;
  const body = new URLSearchParams({ name: "Auth Smoke", email: "auth-smoke@example.test", password: "long-enough", next: "/dashboard" });
  const signup = await fetchText("/api/auth/signup", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const signupLocation = headerLocation(signup.response);
  const signupCookie = setCookieHeader(signup.response);
  if (!(signup.response.status === 303 && signupLocation.endsWith("/dashboard") && signupCookie.includes("cmai_user_id=preview-") && signupCookie.includes("cmai_csrf="))) {
    failures.push(`local signup should create a preview account session and redirect to /dashboard; got status=${signup.response.status} location=${signupLocation} set-cookie=${signupCookie.slice(0, 120)}`);
  }

  const logout = await fetchText("/api/auth/logout", { method: "POST", headers: { cookie: signupCookie.replace(/\n/g, "; ") } });
  const logoutCookie = setCookieHeader(logout.response);
  if (!(logout.response.status === 303 && headerLocation(logout.response).includes("/login?signedOut=1") && logoutCookie.includes("Max-Age=0"))) {
    failures.push(`logout should clear local preview cookies and return to login; got status=${logout.response.status} location=${headerLocation(logout.response)}`);
  }
}

if (failures.length) {
  console.error(`Auth smoke failed for ${base}`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(JSON.stringify({ ok: true, base, mode, authMode, googleReady, supabaseReady, localSignupChecked, expectsAnonymousComposerRedirect, healthStatus: healthResponse.status, googleStatus: google.response.status, googleLocation }, null, 2));
