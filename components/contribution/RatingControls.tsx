"use client";

import { useState } from "react";
import { csrfHeaders } from "@/lib/auth/csrfClient";

export function RatingControls({ contributionId }: { contributionId: string }) {
  const [message, setMessage] = useState("");
  async function rate(usefulness: number) {
    const response = await fetch(`/api/contributions/${contributionId}/ratings`, { method: "POST", headers: { "content-type": "application/json", ...csrfHeaders() }, body: JSON.stringify({ usefulness, comment: usefulness >= 7 ? "Useful" : "Not useful" }) });
    const data = await response.json();
    setMessage(response.ok ? `Rated. Credit delta: ${data.creditDelta ?? 0}; contributor total: ${data.creditTotal ?? 0}.` : data.error);
  }
  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs font-bold leading-5 text-zinc-600">Poster usefulness and safety settle reward credits. Community votes never mint rewards.</p>
      <div className="flex flex-wrap items-center gap-2">
        <button className="badge bg-[#ecfdf5] text-[#065f46]" onClick={() => rate(9)}>Useful</button>
        <button className="badge" onClick={() => rate(5)}>Mixed</button>
        <button className="badge bg-[#fff7ed] text-[#f04438]" onClick={() => rate(1)}>Unsafe/low value</button>
        {message ? <span className="text-xs font-bold">{message}</span> : null}
      </div>
    </div>
  );
}
