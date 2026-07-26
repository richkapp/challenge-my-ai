import Link from "next/link";
import { ArrowRight, Search } from "lucide-react";
import type { DecisionArtifact } from "@/lib/archive/decisionArtifact";
import { listDecisionArtifacts } from "@/lib/archive/decisionArtifactStore";
import { analyticsCountBucket, trackEvent } from "@/lib/analytics/events";

export const dynamic = "force-dynamic";

export default async function AnswerArchivePage({ searchParams }: { searchParams?: Promise<Record<string, string | undefined>> }) {
  const params = (await searchParams) || {};
  const query = typeof params.q === "string" ? params.q.trim() : "";
  const archive = await listDecisionArtifacts({ query, limit: 24 });

  if (query) {
    trackEvent("answer_search_performed", {
      artifact_result_count_bucket: analyticsCountBucket(archive.length),
      search_result_count_bucket: analyticsCountBucket(archive.length),
      reuse_surface: "archive_page_search",
      artifact_reused: false,
    });
  }

  return (
    <div>
      <header className="page-header">
        <div>
          <h1 className="page-title">Answers worth reusing.</h1>
          <p className="page-lede">The strongest version after the debate, with the objections and risks that survived.</p>
        </div>
        <Link href="/challenges/new" className="btn signal">Post a challenge</Link>
      </header>

      <form className="border-b border-zinc-300 py-6" action="/answers">
        <label className="sr-only" htmlFor="answer-archive-q">Search answers</label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="flex flex-1 items-center gap-2 rounded-lg border border-zinc-300 bg-white px-3">
            <Search size={16} className="shrink-0 text-zinc-500" />
            <input id="answer-archive-q" className="min-h-11 w-full bg-transparent text-sm outline-none placeholder:text-zinc-500" name="q" placeholder="Search answers" defaultValue={query} />
          </div>
          <button className="btn" type="submit">Search</button>
          {query ? <Link className="btn secondary" href="/answers">Clear</Link> : null}
        </div>
      </form>

      <section className="py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-black">{archive.length} answer{archive.length === 1 ? "" : "s"}</h2>
          {query ? <p className="text-sm font-bold text-zinc-500">“{query}”</p> : null}
        </div>

        <div className="mt-6 border-t border-zinc-300">
          {archive.map((item) => <AnswerArchiveRow key={item.id} item={item} />)}
        </div>

        {archive.length === 0 ? (
          <div className="border-t border-zinc-300 py-10">
            <h3 className="text-2xl font-black">Nothing matched.</h3>
            <p className="mt-3 max-w-xl text-zinc-600">Try a broader search or post the problem so the answer can be challenged.</p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link href="/challenges/new" className="btn signal">Post the problem</Link>
              <Link href="/lobby" className="btn secondary">Browse challenges</Link>
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function AnswerArchiveRow({ item }: { item: DecisionArtifact }) {
  return (
    <article className="grid gap-4 border-b border-zinc-300 py-6 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)_auto]">
      <div>
        <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs font-bold text-zinc-500">
          <span>{formatCategoryLabel(item.category)}</span>
          <span>·</span>
          <span>{item.contributionCount} perspective{item.contributionCount === 1 ? "" : "s"}</span>
          <span>·</span>
          <span>{item.reward} credits</span>
        </div>
        <Link href={item.artifactUrl} className="mt-2 block text-xl font-black leading-tight tracking-[-0.02em] hover:underline">{item.title}</Link>
        <p className="mt-2 line-clamp-2 text-sm leading-6 text-zinc-600">{item.problemStatement}</p>
      </div>

      <div>
        <p className="text-xs font-bold text-zinc-500">Current answer</p>
        <p className="mt-2 line-clamp-3 text-sm leading-6 text-zinc-700">{item.currentBestAnswer}</p>
        {item.whatChanged[0] ? <p className="mt-3 text-sm font-bold text-zinc-800">Changed: <span className="font-normal text-zinc-600">{item.whatChanged[0]}</span></p> : null}
      </div>

      <Link href={item.artifactUrl} className="inline-flex min-h-11 items-center gap-1 text-sm font-black text-[#f04438]">Open <ArrowRight size={15} /></Link>
    </article>
  );
}

function formatCategoryLabel(category: string) {
  return category.replaceAll("_", " ");
}
