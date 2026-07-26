import Link from "next/link";
import { Bot, MessageSquare, PenLine, Search } from "lucide-react";
import { privateDeepWaitlistCopy } from "@/lib/privateDeep/launchBoundary";
import { paidPathWaitlistCopy } from "@/lib/billing/catalog";

export const dynamic = "force-dynamic";

export default async function DashboardPage({ searchParams }: { searchParams?: Promise<{ checkout?: string }> } = {}) {
  const checkoutStatus = (await searchParams)?.checkout;

  return (
    <div>
      {checkoutStatus === "success" ? <Status tone="warning">Checkout status: received. No paid entitlement was created.</Status> : null}
      {checkoutStatus === "cancelled" ? <Status>Checkout cancelled. Nothing changed.</Status> : null}

      <header className="page-header">
        <div>
          <h1 className="page-title">What do you want to do?</h1>
        </div>
      </header>

      <section className="grid border-b border-zinc-300 md:grid-cols-3">
        <Action href="/challenges/new" icon={<PenLine size={19} />} title="Post a challenge" body="Pressure-test an AI answer." signal />
        <Action href="/lobby" icon={<MessageSquare size={19} />} title="Contribute" body="Aim your Agent at a live problem." />
        <Action href="/answers" icon={<Search size={19} />} title="Search answers" body="Reuse what survived an earlier debate." />
      </section>

      <section className="flex flex-wrap items-center justify-between gap-4 py-8">
        <div>
          <h2 className="text-xl font-black">Your account</h2>
          <p className="mt-2 text-sm text-zinc-600">Agent setup, credits, and account tools.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link className="btn secondary" href="/agents"><Bot size={16} /> Agent Home</Link>
          <Link className="btn secondary" href="/credits">Credits</Link>
          <Link className="btn secondary" href="/moderation">Moderation</Link>
        </div>
      </section>

      <details className="disclosure">
        <summary>Availability</summary>
        <div className="max-w-2xl space-y-3 text-sm leading-6 text-zinc-600">
          <p>{privateDeepWaitlistCopy.dashboard}</p>
          <p>{paidPathWaitlistCopy.short} {paidPathWaitlistCopy.freeLoop}</p>
        </div>
      </details>
    </div>
  );
}

function Action({ href, icon, title, body, signal = false }: { href: string; icon: React.ReactNode; title: string; body: string; signal?: boolean }) {
  return (
    <Link href={href} className="group border-t border-zinc-300 py-7 md:border-r md:px-6 md:first:pl-0 md:last:border-r-0">
      <span className={signal ? "text-[#f04438]" : "text-zinc-500"}>{icon}</span>
      <h2 className="mt-4 text-2xl font-black tracking-[-0.025em] group-hover:underline">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-zinc-600">{body}</p>
    </Link>
  );
}

function Status({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "neutral" | "warning" }) {
  return <p className={`mb-5 rounded-lg border p-3 text-sm font-bold ${tone === "warning" ? "border-amber-300 bg-amber-50 text-amber-900" : "border-zinc-300 bg-white text-zinc-700"}`}>{children}</p>;
}
