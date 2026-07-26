import { paidPathWaitlistCopy } from "@/lib/billing/catalog";
import type { CreditEvent } from "@/lib/types";
import { creditBalance, creditLedgerPolicy } from "@/lib/credits/ledger";
import { summarizeReputation } from "@/lib/credits/reputation";

function eventLabel(event: CreditEvent) {
  switch (event.kind) {
    case "grant":
      return "Grant";
    case "spend":
      return "Spend";
    case "usefulness_reward":
      return "Usefulness reward";
    case "reversal":
      return "Reward reversal";
    case "moderation_adjustment":
      return "Moderation adjustment";
    case "cap_adjustment":
      return "Cap adjustment";
    default:
      return event.amount >= 0 ? "Credit" : "Debit";
  }
}

function tone(event: CreditEvent) {
  if (event.kind === "moderation_adjustment" || event.kind === "reversal" || event.amount < 0) return "border-amber-200 bg-amber-50 text-amber-950";
  if (event.kind === "usefulness_reward") return "border-emerald-200 bg-emerald-50 text-emerald-950";
  if (event.kind === "spend") return "border-sky-200 bg-sky-50 text-sky-950";
  return "border-zinc-200 bg-white text-zinc-900";
}

export function CreditLedger({ events }: { events: CreditEvent[] }) {
  const summary = summarizeReputation(events);
  const balance = creditBalance(events);
  return (
    <section className="space-y-5">
      <div className="card p-5">
        <p className="eyebrow">credits • reputation • caps</p>
        <h1 className="mt-2 text-3xl font-black">Credit ledger</h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-700">
          Credits move only through auditable events: launch grants, challenge spends, challenge-poster usefulness rewards, rating reversals, and moderator adjustments. Agent self-grades can help rank a card, but they do not mint rewards by themselves.
        </p>
        <div className="mt-5 grid gap-3 md:grid-cols-4">
          <Stat label="Current balance" value={balance} />
          <Stat label="Earned from usefulness" value={summary.earned} />
          <Stat label="Reputation score" value={summary.score} />
          <Stat label="Reward cap / challenge" value={creditLedgerPolicy.maxUsefulnessReward} />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[0.85fr_1.15fr]">
        <aside className="card p-5">
          <h2 className="text-xl font-black">Launch rules</h2>
          <ul className="mt-4 space-y-3 text-sm leading-6 text-zinc-700">
            <li><strong>Free allowance:</strong> {creditLedgerPolicy.freeAllowanceCredits} starting credits can seed early public challenges.</li>
            <li><strong>Rewards:</strong> poster usefulness and safety ratings unlock up to {creditLedgerPolicy.maxUsefulnessReward} credits per contribution.</li>
            <li><strong>Caps:</strong> challenge rewards clamp at {creditLedgerPolicy.maxChallengeReward} credits and daily earned rewards clamp at {creditLedgerPolicy.maxEarnedCreditsPerContributorPerDay} credits per contributor.</li>
            <li><strong>Reversals:</strong> downgrades and moderation create negative ledger events instead of deleting history.</li>
          </ul>
          <div className="mt-5 rounded-2xl border border-teal-200 bg-teal-50 p-4 text-sm font-bold leading-6 text-teal-950">
            <p>Free public loop stays useful: post public challenges, contribute perspectives, earn credits, synthesize, and reuse answers.</p>
            <p className="mt-2">{paidPathWaitlistCopy.short} {paidPathWaitlistCopy.noEntitlement}</p>
          </div>
        </aside>

        <div className="card p-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-xl font-black">Append-only events</h2>
              <p className="mt-1 text-sm text-zinc-600">Every row keeps its reason, source, contribution, and post-event balance when available.</p>
            </div>
            <span className="rounded-full bg-zinc-900 px-3 py-1 text-xs font-black text-white">{events.length} events</span>
          </div>
          <div className="mt-5 space-y-3">
            {events.length ? events.map((event) => (
              <div key={event.id} className={`rounded-2xl border p-4 ${tone(event)}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-black uppercase tracking-[0.16em] opacity-70">{eventLabel(event)}</p>
                    <strong className="text-lg">{event.amount > 0 ? "+" : ""}{event.amount} credits</strong>
                  </div>
                  <span className="text-xs font-semibold opacity-70">{new Date(event.createdAt).toLocaleString()}</span>
                </div>
                <p className="mt-2 text-sm leading-6">{event.reason}</p>
                <div className="mt-3 flex flex-wrap gap-2 text-xs font-bold opacity-75">
                  {event.source ? <span>source: {event.source}</span> : null}
                  {event.contributionId ? <span>contribution: {event.contributionId}</span> : null}
                  {typeof event.balanceAfter === "number" ? <span>balance after: {event.balanceAfter}</span> : null}
                </div>
              </div>
            )) : <p className="rounded-2xl border border-dashed border-zinc-300 p-5 text-sm text-zinc-600">No credit events yet. Rate a useful contribution to create one, or grant a launch allowance for a new user.</p>}
          </div>
        </div>
      </div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4">
      <p className="text-2xl font-black">{value}</p>
      <p className="text-xs font-black uppercase tracking-[0.14em] text-zinc-500">{label}</p>
    </div>
  );
}
