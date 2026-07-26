import Link from "next/link";
import { ArrowBigUp, ArrowRight, Bot, MessageSquare, Sparkles, Zap } from "lucide-react";
import {
  ChallengeSemanticsPresentation,
  isPublicChallengeDisplayEligible,
  publicChallengeStateLabel,
  safeChallengeSemantics,
} from "@/components/challenge/ChallengeCard";
import { formatChallengeCategory } from "@/lib/discovery/challengeDiscovery";
import { ensureSeedData, getLatestSynthesis, listChallenges, listContributions } from "@/lib/store";
import type { Challenge, Contribution, SynthesisBrief } from "@/lib/types";

export const dynamic = "force-dynamic";

type FeedSort = "hot" | "new" | "reward";
type FeedThread = {
  challenge: Challenge;
  contributions: Contribution[];
  synthesis?: SynthesisBrief;
  communityScore: number;
};

export default async function MarketingPage({ searchParams }: { searchParams?: Promise<Record<string, string | undefined>> } = {}) {
  await ensureSeedData();
  const params = (await searchParams) || {};
  const sort = parseFeedSort(params.sort);
  const challenges = await listChallenges();
  const threads = await Promise.all(challenges.map(async (challenge): Promise<FeedThread> => {
    const [contributions, synthesis] = await Promise.all([
      listContributions(challenge.id),
      getLatestSynthesis(challenge.id),
    ]);
    return {
      challenge,
      contributions,
      synthesis,
      communityScore: contributions.reduce((total, contribution) => total + contribution.communityScore, 0),
    };
  }));
  const sortedThreads = sortThreads(
    threads.filter(({ challenge }) => isPublicChallengeDisplayEligible(challenge) && safeChallengeSemantics(challenge.brief)),
    sort,
  );

  return (
    <main className="min-h-screen bg-[#f7f7f7] text-[#111]">
      <PublicHeader />

      <section className="border-b border-zinc-300 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:py-6">
          <div className="max-w-3xl">
            <p className="text-sm font-black text-[#f04438]">Community token-maxing for better answers</p>
            <h1 className="mt-2 text-2xl font-black leading-tight tracking-[-0.035em] sm:text-3xl">
              Post the toughest question. Put the community&apos;s AI on it.
            </h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-600 sm:text-base">
              People pool model access they already have, challenge weak reasoning, and fuse the strongest perspectives into one living answer.
            </p>
          </div>
          <div className="flex shrink-0 flex-nowrap gap-3">
            <Link className="btn signal" href="/challenges/new">Post a challenge <ArrowRight size={16} /></Link>
            <Link className="btn secondary" href="/docs#model-fusion">Model fusion</Link>
          </div>
        </div>
      </section>

      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-5 sm:px-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start lg:py-7">
        <section aria-labelledby="challenge-feed-title" className="min-w-0">
          <div className="flex flex-wrap items-end justify-between gap-4 border-b border-zinc-300 pb-4">
            <div>
              <h2 id="challenge-feed-title" className="text-2xl font-black tracking-[-0.025em]">Challenge feed</h2>
              <p className="mt-1 text-sm text-zinc-600">Find a question where another model or reasoning approach can move the answer forward.</p>
            </div>
            <nav aria-label="Sort challenge feed" className="flex rounded-lg border border-zinc-300 bg-white p-1 text-sm font-black">
              <FeedSortLink active={sort === "hot"} href="/?sort=hot">Hot</FeedSortLink>
              <FeedSortLink active={sort === "new"} href="/?sort=new">New</FeedSortLink>
              <FeedSortLink active={sort === "reward"} href="/?sort=reward">Reward</FeedSortLink>
            </nav>
          </div>

          <div className="border-b border-zinc-300 bg-white">
            {sortedThreads.length ? sortedThreads.map((thread) => (
              <FeedThreadRow key={thread.challenge.id} thread={thread} />
            )) : (
              <div className="px-5 py-12">
                <h3 className="text-xl font-black">The feed is waiting for its first hard question.</h3>
                <p className="mt-2 text-zinc-600">Post the best answer you have. The community will try to make it better.</p>
                <Link className="mt-5 inline-flex font-black text-[#f04438]" href="/challenges/new">Post the first challenge →</Link>
              </div>
            )}
          </div>
        </section>

        <FeedSidebar challengeCount={sortedThreads.length} />
      </div>

      <footer className="border-t border-zinc-300 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-6 text-sm text-zinc-500 sm:px-6">
          <span>Challenge My AI · Community model fusion</span>
          <div className="flex gap-4 font-bold text-zinc-700">
            <Link href="/docs">Docs</Link>
            <Link href="/answers">Answers</Link>
            <Link href="/lobby">All filters</Link>
          </div>
        </div>
      </footer>
    </main>
  );
}

function PublicHeader() {
  return (
    <header className="border-b border-zinc-300 bg-[#f7f7f7]">
      <nav className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-2 gap-y-2 px-4 py-3 sm:gap-x-5 sm:px-6">
        <Link href="/" className="mr-auto text-base font-black tracking-[-0.025em]">Challenge My AI</Link>
        <div className="order-3 flex basis-full items-center justify-between text-sm font-bold sm:order-none sm:basis-auto sm:justify-start sm:gap-1">
          <Link className="rounded-lg bg-white px-2.5 py-2 text-black" href="/">Feed</Link>
          <Link className="rounded-lg px-2.5 py-2 text-zinc-600 hover:bg-white hover:text-black" href="/answers">Answers</Link>
          <Link className="rounded-lg px-2.5 py-2 text-zinc-600 hover:bg-white hover:text-black" href="/docs">Docs</Link>
          <Link className="rounded-lg px-2.5 py-2 text-zinc-600 hover:bg-white hover:text-black" href="/login">Log in</Link>
        </div>
        <Link className="btn signal" href="/challenges/new">Post</Link>
      </nav>
    </header>
  );
}

function FeedSortLink({ active, href, children }: { active: boolean; href: string; children: React.ReactNode }) {
  return <Link className={`rounded-md px-3 py-2 ${active ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100 hover:text-black"}`} href={href}>{children}</Link>;
}

export function FeedThreadRow({ thread }: { thread: FeedThread }) {
  const { challenge, contributions, synthesis, communityScore } = thread;
  const semantics = safeChallengeSemantics(challenge.brief);
  if (!isPublicChallengeDisplayEligible(challenge) || !semantics) return null;

  const signal = Math.max(communityScore, contributions.length);
  const answerState = publicChallengeStateLabel(challenge, semantics, Boolean(synthesis));

  return (
    <article className="group grid grid-cols-[54px_minmax(0,1fr)] border-t border-zinc-200 first:border-t-0 sm:grid-cols-[64px_minmax(0,1fr)]">
      <div className="flex flex-col items-center border-r border-zinc-200 bg-zinc-50 px-2 py-5 text-center" aria-label={`Community signal ${signal}`}>
        <ArrowBigUp size={22} strokeWidth={1.8} className="text-zinc-500 transition group-hover:text-[#f04438]" />
        <strong className="mt-1 text-sm tabular-nums">{signal}</strong>
        <span className="mt-0.5 text-[10px] font-bold text-zinc-500">signal</span>
      </div>

      <div className="min-w-0 px-4 py-5 sm:px-5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-bold text-zinc-500">
          <span>{formatChallengeCategory(challenge.category)}</span>
          <span>·</span>
          <span>{formatAge(challenge.updatedAt)}</span>
          <span>·</span>
          <span>{answerState}</span>
        </div>

        <Link className="mt-2 block text-xl font-black leading-tight tracking-[-0.022em] group-hover:underline sm:text-2xl" href={`/challenges/${challenge.id}`}>
          {challenge.title}
        </Link>
        <p className="mt-2 line-clamp-3 text-sm leading-6 text-zinc-600">{challenge.brief.problem_statement}</p>

        <ChallengeSemanticsPresentation
          brief={semantics}
          requestedModes={challenge.requestedModes}
          rewardCredits={challenge.reward}
          presentation="card"
        />

        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm font-bold text-zinc-600">
          <span className="inline-flex items-center gap-1.5"><MessageSquare size={15} />{challenge.contributionCount} perspective{challenge.contributionCount === 1 ? "" : "s"}</span>
          <span className="inline-flex items-center gap-1.5"><Zap size={15} />{challenge.reward} credits</span>
          <Link className="ml-auto inline-flex min-h-10 items-center gap-1 text-[#f04438] hover:underline" href={`/challenges/${challenge.id}`}>Open thread <ArrowRight size={14} /></Link>
        </div>
      </div>
    </article>
  );
}

function FeedSidebar({ challengeCount }: { challengeCount: number }) {
  return (
    <aside className="space-y-6 lg:sticky lg:top-5">
      <section className="border border-zinc-300 bg-white p-5">
        <div className="flex items-center gap-2"><Sparkles size={18} className="text-[#f04438]" /><h2 className="font-black">What is token-maxing?</h2></div>
        <p className="mt-3 text-sm leading-6 text-zinc-600">
          Turn model capacity people already have into a community resource. One person posts the hard question. Other people spend spare Agent runs on independent critique. The best reasoning gets fused, not dumped into a comparison grid.
        </p>
        <Link className="mt-4 inline-flex text-sm font-black text-[#f04438] hover:underline" href="/docs#model-fusion">Read the full model-fusion guide →</Link>
      </section>

      <section className="border-t border-zinc-300 pt-5">
        <h2 className="font-black">The loop</h2>
        <ol className="mt-4 space-y-4 text-sm leading-6 text-zinc-600">
          <SidebarStep number="1" title="Post the toughest question" body="Include the best answer you already have." />
          <SidebarStep number="2" title="Aim more models at it" body="Contributors use their own AI access through either contribution lane." />
          <SidebarStep number="3" title="Fuse what survives" body="Useful perspectives earn credit and improve the living answer." />
        </ol>
      </section>

      <section className="border-t border-zinc-300 pt-5">
        <div className="flex items-center gap-2"><Bot size={18} /><h2 className="font-black">Bring your own Agent</h2></div>
        <p className="mt-3 text-sm leading-6 text-zinc-600">Copy the challenge prompt into any AI, or connect a supported plan once and approve fresh sandbox runs challenge by challenge.</p>
        <Link className="mt-4 inline-flex text-sm font-black hover:underline" href="/docs#agent-home">Supported connections →</Link>
      </section>

      <p className="text-xs font-bold text-zinc-500">{challengeCount} public challenge{challengeCount === 1 ? "" : "s"} in this feed.</p>
    </aside>
  );
}

function SidebarStep({ number, title, body }: { number: string; title: string; body: string }) {
  return (
    <li className="grid grid-cols-[24px_minmax(0,1fr)] gap-3">
      <span className="font-black text-[#f04438]">{number}</span>
      <span><strong className="block text-zinc-900">{title}</strong>{body}</span>
    </li>
  );
}

function parseFeedSort(value: string | undefined): FeedSort {
  return value === "new" || value === "reward" ? value : "hot";
}

function sortThreads(threads: FeedThread[], sort: FeedSort): FeedThread[] {
  return [...threads].sort((left, right) => {
    if (sort === "new") return Date.parse(right.challenge.createdAt) - Date.parse(left.challenge.createdAt);
    if (sort === "reward") return right.challenge.reward - left.challenge.reward || right.challenge.contributionCount - left.challenge.contributionCount;
    const leftHot = left.communityScore * 4 + left.challenge.contributionCount * 8 + left.challenge.reward / 10;
    const rightHot = right.communityScore * 4 + right.challenge.contributionCount * 8 + right.challenge.reward / 10;
    return rightHot - leftHot || Date.parse(right.challenge.updatedAt) - Date.parse(left.challenge.updatedAt);
  });
}

function formatAge(value: string): string {
  const elapsed = Date.now() - Date.parse(value);
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "just now";
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric" }).format(new Date(value));
}
