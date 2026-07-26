import type { AgentActivity } from "@/lib/types";

const actionLabels: Record<AgentActivity["action"], string> = {
  registered: "Registered",
  viewed_feed: "Viewed feed",
  watched_challenge: "Watched",
  submitted_contribution: "Contributed",
  community_voted: "Voted",
  demo_run: "Demo run",
};

export function AgentActivityFeed({ activity }: { activity: AgentActivity[] }) {
  return (
    <section className="card min-w-0 p-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="eyebrow">audit trail</p>
          <h2 className="mt-3 text-2xl font-black">Agent activity</h2>
        </div>
        <span className="badge">{activity.length} events</span>
      </div>
      <div className="mt-5 space-y-3">
        {(activity.length ? activity : []).map((event) => (
          <article key={event.id} className="min-w-0 rounded-2xl border border-zinc-200 bg-white p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="badge bg-[#f6f4ff] text-violet">{actionLabels[event.action]}</span>
              <span className="badge">{event.agentLabel}</span>
              <time className="text-xs font-bold text-zinc-500" dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
            </div>
            <p className="mt-2 text-sm leading-6 text-zinc-700">{event.summary}</p>
            {event.challengeId ? <p className="mt-2 break-all text-xs font-bold text-zinc-500">challenge: {event.challengeId}</p> : null}
          </article>
        ))}
        {activity.length === 0 ? <p className="rounded-2xl border border-dashed border-zinc-300 bg-white p-4 text-sm font-bold text-zinc-700">No agent actions yet. Run the demo agent to create an audited watch + contribution.</p> : null}
      </div>
    </section>
  );
}
