import Link from "next/link";
import { cookies } from "next/headers";

const publicLinks = [
  ["/lobby", "Feed"],
  ["/answers", "Answers"],
  ["/docs", "Docs"],
] as const;

type CookieReader = {
  get(name: string): { value?: string } | undefined;
  getAll(): Array<{ name: string; value?: string }>;
};

export function hasAccountSession(cookieStore: CookieReader) {
  if (cookieStore.get("cmai_user_id")?.value) return true;
  return cookieStore.getAll().some((cookie) => cookie.name.startsWith("sb-") && cookie.name.includes("auth-token") && Boolean(cookie.value));
}

export function AppChrome({ children, isAuthenticated }: { children: React.ReactNode; isAuthenticated: boolean }) {
  return (
    <div className="min-h-screen bg-paper">
      <header className="sticky top-0 z-20 border-b border-zinc-200 bg-paper/95 backdrop-blur-sm">
        <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3 sm:px-6">
          <Link href="/" className="basis-full whitespace-nowrap text-base font-black tracking-[-0.025em] sm:mr-auto sm:basis-auto">Challenge My AI</Link>
          <div className="flex flex-wrap items-center gap-1 text-sm font-bold">
            {publicLinks.map(([href, label]) => (
              <Link key={href} href={href} className="rounded-lg px-2.5 py-2 text-zinc-600 hover:bg-white hover:text-ink">{label}</Link>
            ))}
            {isAuthenticated ? (
              <>
                <Link href="/dashboard" className="rounded-lg px-2.5 py-2 text-zinc-600 hover:bg-white hover:text-ink">Account</Link>
                <form action="/api/auth/logout" method="post">
                  <button className="rounded-lg px-2.5 py-2 text-zinc-500 hover:bg-white hover:text-ink" type="submit">Sign out</button>
                </form>
              </>
            ) : (
              <Link href="/login?next=%2Fchallenges%2Fnew" className="rounded-lg px-2.5 py-2 text-zinc-600 hover:bg-white hover:text-ink">Log in</Link>
            )}
            <Link href="/challenges/new" className="ml-1 rounded-lg bg-[#f04438] px-3 py-2 text-white hover:bg-[#d92d20]">Post</Link>
          </div>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-12">{children}</main>
    </div>
  );
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const cookieStore = await cookies();
  return <AppChrome isAuthenticated={hasAccountSession(cookieStore)}>{children}</AppChrome>;
}
