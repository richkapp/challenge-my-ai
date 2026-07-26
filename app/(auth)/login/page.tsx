import Link from "next/link";
import { authMode, demoAuthAllowed, env, googleAuthConfigured, missingProductionKeys, supabaseConfigured } from "@/lib/config/env";

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LoginPage({ searchParams }: { searchParams?: Promise<Record<string, string | string[] | undefined>> }) {
  const params = (await searchParams) || {};
  const nextParam = firstParam(params.next);
  const next = nextParam && nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/dashboard";
  const sent = firstParam(params.sent) === "1";
  const created = firstParam(params.created) === "1";
  const email = firstParam(params.email) || "";
  const signedOut = firstParam(params.signedOut) === "1";
  const error = firstParam(params.error) || "";
  const provider = firstParam(params.provider) || "";
  const showSupabase = authMode() === "supabase";
  const hasSupabase = supabaseConfigured(env);
  const showEmailLogin = showSupabase && hasSupabase;
  const showPreviewAccount = demoAuthAllowed(env) && !hasSupabase;
  const googleReady = googleAuthConfigured(env);
  const missing = missingProductionKeys();
  const googleHref = `/api/auth/google?next=${encodeURIComponent(next)}`;
  const joiningChallenge = /^\/challenges\/(?!new(?:\/|$))/.test(next);

  return (
    <main className="mx-auto min-h-[75vh] max-w-3xl px-4 py-12 sm:px-6 sm:py-20">
      <Link className="text-sm font-bold text-zinc-500 hover:text-black" href="/">← Challenge My AI</Link>
      <header className="mt-10 border-b border-zinc-300 pb-8">
        <h1 className="max-w-xl text-4xl font-black tracking-[-0.035em] sm:text-6xl">{joiningChallenge ? "Join the challenge." : "Log in."}</h1>
        <p className="mt-4 max-w-xl text-lg leading-8 text-zinc-600">{joiningChallenge ? "Create an account to submit your perspective." : "Browse without an account. Log in when you want to post or contribute."}</p>
      </header>

      <StatusMessages signedOut={signedOut} sent={sent} created={created} email={email} error={error} provider={provider} />

      <div className="grid gap-8 py-8 md:grid-cols-2">
        <form action="/api/auth/signup" method="post">
          <input type="hidden" name="next" value={next} />
          <h2 className="text-xl font-black">Create account</h2>
          <div className="mt-5 space-y-4">
            <Field label="Name" id="signup-name"><input className="input" id="signup-name" name="name" type="text" required placeholder="Your name" /></Field>
            <Field label="Email" id="signup-email"><input className="input" id="signup-email" name="email" type="email" required placeholder="you@example.com" /></Field>
            <Field label="Password" id="signup-password"><input autoComplete="new-password" className="input" id="signup-password" name="password" type="password" required minLength={8} placeholder="8+ characters" /></Field>
            <button className="btn signal w-full" type="submit">Create account</button>
          </div>
          {showPreviewAccount ? <p className="mt-3 text-xs leading-5 text-zinc-500">Preview accounts are temporary.</p> : null}
        </form>

        <section className="border-t border-zinc-300 pt-8 md:border-l md:border-t-0 md:pl-8 md:pt-0">
          <h2 className="text-xl font-black">Continue</h2>
          <div className="mt-5 space-y-4">
            <GoogleLoginAction googleHref={googleHref} googleReady={googleReady} hasSupabase={hasSupabase} />
            {showEmailLogin ? (
              <form className="space-y-4" action="/api/auth/supabase-login" method="post">
                <input type="hidden" name="next" value={next} />
                <Field label="Email" id="email"><input className="input" id="email" name="email" type="email" required placeholder="you@example.com" /></Field>
                <button className="btn w-full" type="submit">Email me a login link</button>
              </form>
            ) : showPreviewAccount ? (
              <form className="space-y-4" action="/api/auth/local-login" method="get">
                <input type="hidden" name="next" value={next} />
                <Field label="Preview email" id="preview-email"><input className="input" id="preview-email" name="email" type="email" required placeholder="you@example.com" /></Field>
                <button className="btn w-full" type="submit">Continue</button>
              </form>
            ) : null}
          </div>
        </section>
      </div>

      {showSupabase && !hasSupabase && !showPreviewAccount ? (
        <div className="border-t border-amber-300 py-5 text-sm text-amber-900">
          <strong>Sign-in is not connected.</strong>
          <p className="mt-2">Missing: {missing.length ? missing.join(", ") : "Supabase public URL / anon key"}</p>
        </div>
      ) : null}
    </main>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return <label className="block text-sm font-bold text-zinc-800" htmlFor={id}>{label}<span className="mt-2 block">{children}</span></label>;
}

export function GoogleLoginAction({ googleHref, googleReady, hasSupabase }: { googleHref: string; googleReady: boolean; hasSupabase: boolean }) {
  if (googleReady) return <Link className="btn secondary w-full" href={googleHref}>Continue with Google</Link>;
  return (
    <details className="disclosure">
      <summary>Google sign-in unavailable</summary>
      <p className="text-xs leading-5 text-zinc-600">{hasSupabase ? "Google needs to be enabled and tested." : "Account-provider setup is missing."}</p>
    </details>
  );
}

function StatusMessages({ signedOut, sent, created, email, error, provider }: { signedOut: boolean; sent: boolean; created: boolean; email: string; error: string; provider: string }) {
  return (
    <div className="mt-5 space-y-2">
      {sent ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-bold text-emerald-800">Check your email{email ? ` at ${email}` : ""}.</p> : null}
      {created ? <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-bold text-emerald-800">Account created{email ? ` for ${email}` : ""}.</p> : null}
      {signedOut ? <p className="rounded-lg border border-zinc-300 bg-white p-3 text-sm font-bold text-zinc-700">You&apos;re signed out.</p> : null}
      {error === "provider_not_configured" ? <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm font-bold text-amber-900">{provider === "google" ? "Google login" : "This login provider"} is not connected.</p> : null}
      {error === "provider_error" ? <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-bold text-red-900">Login did not start. Try email.</p> : null}
    </div>
  );
}
