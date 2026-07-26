"use client";

import Link from "next/link";
import { useState } from "react";
import { csrfHeaders } from "@/lib/auth/csrfClient";
import type { ModerationReason, ModerationTargetType } from "@/lib/types";

const reasonOptions: Array<{ value: ModerationReason; label: string }> = [
  { value: "spam", label: "Spam / self-promotion" },
  { value: "unsafe_content", label: "Unsafe content" },
  { value: "secrets_or_private_info", label: "Secrets or private info" },
  { value: "harassment_or_abuse", label: "Harassment or abuse" },
  { value: "illegal_or_harmful", label: "Illegal or harmful" },
  { value: "copyright_or_proprietary", label: "Copyright / proprietary material" },
  { value: "off_topic_or_low_quality", label: "Off-topic or low quality" },
  { value: "other", label: "Other" },
];

export function ReportButton({ targetType, targetId, isAuthenticated, loginHref, label = "Report" }: { targetType: ModerationTargetType; targetId: string; isAuthenticated: boolean; loginHref: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ModerationReason>("unsafe_content");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  if (!isAuthenticated) {
    return <Link className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-sm font-black text-zinc-700 hover:border-zinc-300" href={loginHref}>Sign in to report</Link>;
  }

  async function submitReport() {
    setBusy(true);
    setMessage("Sending report…");
    try {
      const response = await fetch("/api/moderation/reports", {
        method: "POST",
        headers: { "content-type": "application/json", ...csrfHeaders() },
        body: JSON.stringify({ targetType, targetId, reason, note: note.trim() || undefined }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not submit report.");
      setMessage("Report sent to the moderation queue.");
      setNote("");
      setOpen(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not submit report.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-w-0">
      <button type="button" className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-sm font-black text-zinc-700 hover:border-zinc-300" onClick={() => setOpen((value) => !value)}>
        {label}
      </button>
      {open ? (
        <div className="mt-3 max-w-md rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm">
          <p className="eyebrow">moderation report</p>
          <label className="mt-3 block text-sm font-black text-zinc-700" htmlFor={`report-reason-${targetType}-${targetId}`}>Reason</label>
          <select id={`report-reason-${targetType}-${targetId}`} className="select mt-2" value={reason} onChange={(event) => setReason(event.target.value as ModerationReason)}>
            {reasonOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <label className="mt-3 block text-sm font-black text-zinc-700" htmlFor={`report-note-${targetType}-${targetId}`}>Optional note</label>
          <textarea id={`report-note-${targetType}-${targetId}`} className="textarea mt-2 min-h-[7rem]" value={note} onChange={(event) => setNote(event.target.value)} placeholder="Briefly explain what a moderator should review. Do not paste raw secrets." />
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className="btn" disabled={busy} onClick={submitReport}>{busy ? "Sending…" : "Send report"}</button>
            <button type="button" className="rounded-full border border-zinc-200 bg-white px-4 py-2 text-sm font-black text-zinc-700 hover:border-zinc-300" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      ) : null}
      {message ? <p className="mt-2 text-sm font-bold leading-6 text-zinc-700">{message}</p> : null}
    </div>
  );
}
