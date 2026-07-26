import Link from "next/link";
import { ExternalLink, Sparkles } from "lucide-react";
import type { PublicContributorProfileContribution } from "@/lib/profile/publicProfile";

export function ProfileContributionCard({ contribution }: { contribution: PublicContributorProfileContribution }) {
  return (
    <article className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 bg-[#f7f7f7] px-4 py-3">
        <div className="flex flex-wrap gap-2">
          <span className="badge">{contribution.challengeCategory}</span>
          <span className="badge bg-[#ecfdf5] text-[#065f46]">{contribution.contributionModeLabel}</span>
          <span className="badge bg-[#eef2ff] text-[#3730a3]">public contribution</span>
          {typeof contribution.usefulness === "number" ? <span className="badge bg-[#fff7ed] text-[#f04438]">{contribution.usefulness >= 7 ? "useful" : "rated"} {contribution.usefulness}/10</span> : <span className="badge">awaiting poster rating</span>}
        </div>
        <span className="text-xs font-black uppercase tracking-[0.14em] text-zinc-500">community {contribution.communityScore}</span>
      </div>
      <div className="p-5">
        <Link href={contribution.challengeHref} className="text-xl font-black leading-tight hover:underline">{contribution.challengeTitle}</Link>
        <h3 className="mt-3 text-2xl font-black leading-tight">{contribution.verdict}</h3>
        <p className="mt-2 text-sm leading-6 text-zinc-700">{contribution.answerSummary}</p>
        <div className="mt-4 flex flex-wrap gap-3">
          <Link className="inline-flex items-center gap-2 text-sm font-black text-[#f04438]" href={contribution.challengeHref}>Open debate <ExternalLink size={14} /></Link>
          {contribution.artifactHref ? <Link className="inline-flex items-center gap-2 text-sm font-black text-[#065f46]" href={contribution.artifactHref}>Open artifact <Sparkles size={14} /></Link> : null}
        </div>
      </div>
    </article>
  );
}
