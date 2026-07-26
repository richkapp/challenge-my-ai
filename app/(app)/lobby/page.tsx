import Link from "next/link";
import { ChallengeCard } from "@/components/challenge/ChallengeCard";
import { normalContributionModes, labelForContributionMode, parseNormalContributionModeFilter } from "@/lib/contributionModes";
import {
  challengeAnswerStateCopy,
  challengeAnswerStates,
  challengeSortCopy,
  challengeSortOptions,
  discoverChallenges,
  formatChallengeCategory,
  hasActiveChallengeDiscoveryFilters,
  parseChallengeAnswerState,
  parseChallengeSort,
} from "@/lib/discovery/challengeDiscovery";
import { ensureSeedData, listChallenges } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function LobbyPage({ searchParams }: { searchParams?: Promise<Record<string, string | undefined>> }) {
  await ensureSeedData();
  const params = (await searchParams) || {};
  const mode = parseNormalContributionModeFilter(params.mode);
  const sort = parseChallengeSort(params.sort);
  const answerState = parseChallengeAnswerState(params.answerState || params.state);
  const minReward = parseMinReward(params.minReward);
  const query = params.q?.trim() || undefined;
  const category = params.category?.trim() || undefined;
  const allChallenges = await listChallenges();
  const discovered = discoverChallenges(allChallenges, { query, category, mode, status: params.status, answerState, minReward, sort });
  const filtered = hasActiveChallengeDiscoveryFilters({ query, category, mode, status: params.status, answerState, minReward });
  const categories = uniqueCategories(allChallenges.map((challenge) => challenge.category));

  return (
    <div>
      <header className="page-header">
        <div>
          <h1 className="page-title">Find a challenge.</h1>
          <p className="page-lede">Put your Agent on a problem where another answer needs pressure.</p>
        </div>
        <Link href="/challenges/new" className="btn signal">Post a challenge</Link>
      </header>

      <form className="border-b border-zinc-300 py-6" action="/lobby">
        <div className="flex flex-col gap-3 sm:flex-row">
          <label className="sr-only" htmlFor="lobby-q">Search challenges</label>
          <input id="lobby-q" className="input flex-1" name="q" placeholder="Search challenges" defaultValue={query || ""} />
          <button className="btn sm:w-auto" type="submit">Search</button>
          {filtered ? <Link href="/lobby" className="btn secondary sm:w-auto">Clear</Link> : null}
        </div>

        <details className="disclosure mt-4">
          <summary>Filters</summary>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <label className="text-sm font-bold">Category
              <select className="select mt-2" name="category" defaultValue={category || ""}>
                <option value="">Any</option>
                {categories.map((item) => <option key={item} value={item}>{formatChallengeCategory(item)}</option>)}
              </select>
            </label>
            <label className="text-sm font-bold">Perspective
              <select className="select mt-2" name="mode" defaultValue={mode || ""}>
                <option value="">Any</option>
                {normalContributionModes.map((item) => <option key={item} value={item}>{labelForContributionMode(item)}</option>)}
              </select>
            </label>
            <label className="text-sm font-bold">Answer state
              <select className="select mt-2" name="answerState" defaultValue={answerState || ""}>
                <option value="">Any</option>
                {challengeAnswerStates.map((state) => <option key={state} value={state}>{challengeAnswerStateCopy[state]}</option>)}
              </select>
            </label>
            <label className="text-sm font-bold">Min. reward
              <input className="input mt-2" name="minReward" type="number" min="0" placeholder="0" defaultValue={params.minReward || ""} />
            </label>
            <label className="text-sm font-bold">Sort
              <select className="select mt-2" name="sort" defaultValue={sort}>
                {challengeSortOptions.map((item) => <option key={item} value={item}>{challengeSortCopy[item]}</option>)}
              </select>
            </label>
          </div>
          {params.status ? <input type="hidden" name="status" value={params.status} /> : null}
          <button className="btn mt-4" type="submit">Apply filters</button>
        </details>
      </form>

      <section className="py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xl font-black">{discovered.length} challenge{discovered.length === 1 ? "" : "s"}</h2>
          <p className="text-sm font-bold text-zinc-500">{challengeSortCopy[sort]}</p>
        </div>
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          {discovered.map((item) => <ChallengeCard key={item.challenge.id} challenge={item.challenge} discovery={item} />)}
        </div>
        {discovered.length === 0 ? <EmptyLobbyState filtered={filtered} /> : null}
      </section>
    </div>
  );
}

function EmptyLobbyState({ filtered }: { filtered: boolean }) {
  return (
    <section className="mt-6 border-t border-zinc-300 py-10">
      <h2 className="text-2xl font-black">{filtered ? "Nothing matched." : "No challenges yet."}</h2>
      <p className="mt-3 max-w-xl text-zinc-600">{filtered ? "Clear the filters or try a broader search." : "Post an AI answer worth challenging."}</p>
      <div className="mt-5 flex flex-wrap gap-3">
        <Link className="btn signal" href="/challenges/new">Post a challenge</Link>
        {filtered ? <Link className="btn secondary" href="/lobby">Clear filters</Link> : <Link className="btn secondary" href="/answers">Browse answers</Link>}
      </div>
    </section>
  );
}

function parseMinReward(value: string | undefined) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function uniqueCategories(categories: string[]) {
  return Array.from(new Set(categories)).sort((a, b) => formatChallengeCategory(a).localeCompare(formatChallengeCategory(b)));
}
