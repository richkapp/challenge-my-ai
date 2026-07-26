"use client";

import { useState } from "react";
import { csrfHeaders } from "@/lib/auth/csrfClient";

export function CommunityVoteControls({ contributionId }: { contributionId: string }) {
  const [score, setScore] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  async function vote(value: 1 | -1) {
    const response = await fetch(`/api/contributions/${contributionId}/community-votes`, { method: "POST", headers: { "content-type": "application/json", ...csrfHeaders() }, body: JSON.stringify({ value }) });
    const data = await response.json();
    if (response.ok) {
      setScore(data.contribution.communityScore);
      setMessage(data.vote?.message || "Community vote recorded.");
    } else {
      setMessage(data.error || "Community vote was not counted.");
    }
  }
  return (
    <div className="mt-2 space-y-2 text-sm">
      <p className="text-xs font-bold leading-5 text-zinc-600">Community votes affect visibility and trust only; poster ratings decide credits.</p>
      <div className="flex flex-wrap gap-2">
        <button className="badge" onClick={() => vote(1)}>community +</button>
        <button className="badge" onClick={() => vote(-1)}>community -</button>
        {score !== null ? <span className="font-bold">score {score}</span> : null}
      </div>
      {message ? <p className="text-xs font-bold leading-5 text-zinc-700">{message}</p> : null}
    </div>
  );
}
