"use client";

import Link from "next/link";
import { useState } from "react";
import type { ModerationAction, ModerationEvent, ModerationReason, ModerationTargetType } from "@/lib/types";

type ModerationQueueRow = {
  event: ModerationEvent;
  title: string;
  href?: string;
  targetStatus: string;
  targetSummary: string;
  actionTargetType: ModerationTargetType;
  actionTargetId: string;
};

const reasonLabels: Record<ModerationReason, string> = {
  spam: "Spam",
  unsafe_content: "Unsafe content",
  secrets_or_private_info: "Secrets/private info",
  harassment_or_abuse: "Harassment/abuse",
  illegal_or_harmful: "Illegal/harmful",
  copyright_or_proprietary: "Copyright/proprietary",
  off_topic_or_low_quality: "Off-topic/low quality",
  smoke_or_test_artifact: "Smoke/test artifact",
  other: "Other",
};

export function ModerationQueue({ rows }: { rows: ModerationQueueRow[] }) {
  const [messages, setMessages] = useState<Record<string, string>>({});

  async function act(row: ModerationQueueRow, action: Exclude<ModerationAction, "report">) {
    setMessages((current) => ({ ...current, [row.event.id]: `${action === "suppress" ? "Suppressing" : "Restoring"}…` }));
    try {
      const response = await fetch("/api/moderation/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, targetType: row.actionTargetType, targetId: row.actionTargetId, reason: row.event.reason, note: `queue action from report ${row.event.id}` }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Moderation action failed.");
      setMessages((current) => ({ ...current, [row.event.id]: `${action === "suppress" ? "Suppressed" : "Restored"}. Refresh to see the latest queue state.` }));
    } catch (error) {
      setMessages((current) => ({ ...current, [row.event.id]: error instanceof Error ? error.message : "Moderation action failed." }));
    }
  }

  if (!rows.length) {
    return (
      <section className="card p-6">
        <p className="eyebrow">clear queue</p>
        <h2 className="mt-3 text-2xl font-black">No reports or suppression actions yet.</h2>
        <p className="mt-3 text-sm font-bold leading-6 text-zinc-700">Reports from challenges, contributions, and decision artifacts will appear here with moderator actions.</p>
      </section>
    );
  }

  return (
    <section className="space-y-4">
      {rows.map((row) => {
        const canRestore = row.targetStatus === "suppressed";
        return (
          <article key={row.event.id} className="card overflow-hidden p-0">
            <div className="border-b border-zinc-200 bg-[#f7f7f7] px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-2">
                  <span className="badge bg-white">{row.event.action}</span>
                  <span className="badge bg-white">{row.event.targetType}</span>
                  <span className="badge bg-white">{reasonLabels[row.event.reason]}</span>
                  <span className={`badge ${canRestore ? "bg-[#fff7ed] text-[#f04438]" : "bg-[#ecfdf5] text-[#065f46]"}`}>{row.targetStatus}</span>
                </div>
                <span className="text-xs font-black uppercase tracking-[0.16em] text-zinc-500">{new Date(row.event.createdAt).toLocaleString()}</span>
              </div>
              <h2 className="mt-4 text-2xl font-black leading-tight">{row.title}</h2>
              <p className="mt-2 text-sm font-bold leading-6 text-zinc-700">{row.targetSummary}</p>
            </div>
            <div className="p-5">
              <dl className="grid gap-3 text-sm md:grid-cols-3">
                <div><dt className="font-black uppercase tracking-[0.16em] text-zinc-500">Reported by</dt><dd className="mt-1 break-all font-bold text-zinc-700">{row.event.actorId}</dd></div>
                <div><dt className="font-black uppercase tracking-[0.16em] text-zinc-500">Resolved target</dt><dd className="mt-1 break-all font-bold text-zinc-700">{row.event.resolvedTargetType}:{row.event.resolvedTargetId}</dd></div>
                <div><dt className="font-black uppercase tracking-[0.16em] text-zinc-500">Public link</dt><dd className="mt-1">{row.href ? <Link className="font-black text-[#f04438]" href={row.href}>Open target</Link> : <span className="font-bold text-zinc-500">Hidden while suppressed</span>}</dd></div>
              </dl>
              {row.event.note ? <p className="mt-4 rounded-2xl border border-zinc-200 bg-[#f8fafc] p-4 text-sm font-bold leading-6 text-zinc-700">{row.event.note}</p> : null}
              <div className="mt-5 flex flex-wrap gap-3">
                <button className="btn" type="button" disabled={canRestore} onClick={() => act(row, "suppress")}>Suppress target</button>
                <button className="rounded-full border border-zinc-200 bg-white px-4 py-2 text-sm font-black text-zinc-700 hover:border-zinc-300 disabled:opacity-50" type="button" disabled={!canRestore} onClick={() => act(row, "restore")}>Restore target</button>
              </div>
              {messages[row.event.id] ? <p className="mt-3 text-sm font-black text-zinc-700">{messages[row.event.id]}</p> : null}
            </div>
          </article>
        );
      })}
    </section>
  );
}

export type { ModerationQueueRow };
