"use client";

import Link from "next/link";
import { useState } from "react";
import type { Contribution, ContributionCard as ContributionCardType } from "@/lib/types";
import { csrfHeaders } from "@/lib/auth/csrfClient";
import { labelForContributionMode } from "@/lib/contributionModes";
import { manualContributionProvenanceSummary, manualContributionTrustLabel } from "@/lib/provenance/manual";
import { modelDisplayName, modelProvenanceTrustLabel } from "@/lib/provenance/model";

type PreviewState = { card: ContributionCardType; mismatch: boolean; repair: string[]; provenanceLabel: string };

export function ContributionPasteBox({
  challengeId,
  onPosted,
  isAuthenticated = true,
  loginHref = "/login",
}: {
  challengeId: string;
  onPosted: (contribution: Contribution) => void;
  isAuthenticated?: boolean;
  loginHref?: string;
}) {
  const [raw, setRaw] = useState("");
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [repair, setRepair] = useState<string[]>([]);
  const [error, setError] = useState("");

  async function parse() {
    setError("");
    setRepair([]);
    setPreview(null);
    const response = await fetch(`/api/challenges/${challengeId}/contributions/parse`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ raw }) });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || "Could not parse contribution");
      setRepair(Array.isArray(data.repair) ? data.repair : []);
    } else {
      setPreview({ card: data.card, mismatch: data.mismatch, repair: Array.isArray(data.repair) ? data.repair : [], provenanceLabel: data.provenanceLabel || manualContributionTrustLabel() });
    }
  }

  async function submit() {
    if (!preview) return;
    if (preview.mismatch) {
      setError("Contribution challenge_id does not match this room. Repair the card before publishing.");
      setRepair(preview.repair);
      return;
    }
    const response = await fetch(`/api/challenges/${challengeId}/contributions`, { method: "POST", headers: { "content-type": "application/json", ...csrfHeaders() }, body: JSON.stringify({ card: preview.card }) });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || "Could not submit contribution");
      setRepair(repairFromSubmitError(data));
    } else {
      onPosted(data.contribution);
      setRaw("");
      setPreview(null);
      setRepair([]);
    }
  }

  return (
    <section id="paste-contribution" className="border-t border-zinc-300 pt-5">
      <h3 className="text-lg font-black">Paste the result</h3>
      <textarea className="textarea mt-4 min-h-[8rem] text-xs" value={raw} onChange={(event) => setRaw(event.target.value)} placeholder="Paste CMAI_CONTRIBUTION_CARD_V1 block here" />
      {error ? <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-bold text-amber-900">{error}</p> : null}
      {repair.length ? <RepairList items={repair} /> : null}

      {preview ? (
        <div className="mt-5 border-t border-zinc-300 pt-5">
          {preview.mismatch ? <p className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-black text-amber-900">Challenge ID mismatch: card says {preview.card.challenge_id}, room is {challengeId}. Repair this before publishing.</p> : null}
          {preview.mismatch && preview.repair.length ? <RepairList items={preview.repair} /> : null}

          <div className="flex flex-wrap gap-2">
            <span className="badge">{preview.provenanceLabel}</span>
            <span className="badge">{modelProvenanceTrustLabel(preview.card.model_provenance)}</span>
          </div>
          <h3 className="mt-4 text-xl font-black leading-tight">Preview: {preview.card.verdict}</h3>
          <p className="mt-2 text-sm leading-6 text-zinc-700">{preview.card.answer_to_challenge_poster}</p>

          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <PreviewItem label="Angle" value={labelForContributionMode(preview.card.contribution_mode)} />
            <PreviewItem label="Score" value={`${preview.card.original_answer_grade.score_0_to_10}/10 — ${preview.card.original_answer_grade.why}`} />
            <PreviewItem label="Recommendation" value={preview.card.alternative_recommendation} />
            <PreviewItem label="Confidence" value={`${preview.card.confidence.level} — ${preview.card.confidence.why}`} />
          </dl>

          <details className="disclosure mt-4">
            <summary>Full card and provenance</summary>
            <div className="space-y-4">
              <PreviewItem label="Source / provenance" value={`${modelDisplayName(preview.card.model_provenance, preview.card.contributor_ai_label)} — ${manualContributionProvenanceSummary(preview.card)}`} />
              <PreviewList title="Strongest objections" items={preview.card.strongest_objections} />
              <PreviewList title="Missing assumptions" items={preview.card.missing_assumptions_or_context} />
              <PreviewList title="Risks" items={preview.card.risks_and_failure_modes} />
              <PreviewList title="Claims to verify" items={preview.card.claims_to_verify} />
              <PreviewList title="What would change this view" items={preview.card.what_would_change_my_mind} />
              <PreviewList title="Safety / prompt-injection flags" items={[...preview.card.safety_or_scope_notes, ...preview.card.abuse_or_prompt_injection_flags]} empty="none" />
            </div>
          </details>

          {isAuthenticated ? (
            <button className="btn signal mt-4" onClick={submit} disabled={preview.mismatch}>{preview.mismatch ? "Repair challenge ID before publishing" : "Submit perspective"}</button>
          ) : (
            <div className="mt-4 border-t border-zinc-300 pt-4 text-sm font-bold text-zinc-700">
              <p>This card is valid. Log in to submit it.</p>
              <Link className="btn signal mt-3" href={loginHref}>Create account to submit</Link>
            </div>
          )}
        </div>
      ) : (
        <button className="btn mt-4" onClick={parse} disabled={!raw}>Parse contribution</button>
      )}
    </section>
  );
}

function PreviewItem({ label, value }: { label: string; value: string }) {
  return <div><dt className="font-black">{label}</dt><dd className="mt-1 text-zinc-600">{value || "none"}</dd></div>;
}

function PreviewList({ title, items, empty = "None provided" }: { title: string; items: string[]; empty?: string }) {
  return (
    <div>
      <h4 className="font-black">{title}</h4>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-zinc-600">
        {(items.length ? items : [empty]).map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}
      </ul>
    </div>
  );
}

function RepairList({ items }: { items: string[] }) {
  return (
    <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm leading-6 text-amber-950">
      <p className="font-black">Repair guidance</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">{items.map((item, index) => <li key={`repair-${index}`}>{item}</li>)}</ul>
    </div>
  );
}

function repairFromSubmitError(data: { code?: string; details?: unknown }): string[] {
  if (data.code === "challenge_mismatch") return ["Set `challenge_id` to this room before publishing."];
  if (Array.isArray(data.details)) return data.details.map((issue) => typeof issue === "object" && issue && "path" in issue && "message" in issue ? `Fix \`${String(issue.path)}\`: ${String(issue.message)}` : "Repair the contribution card schema and try again.");
  return [];
}
