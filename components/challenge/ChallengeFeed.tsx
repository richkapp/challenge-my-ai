"use client";

import Link from "next/link";
import { useState } from "react";
import { shortLabelForContributionMode } from "@/lib/contributionModes";
import type { Challenge, Contribution, SynthesisBrief } from "@/lib/types";
import {
  boundedPublicTextItems,
  ChallengeSemanticsPresentation,
  isPublicChallengeDetailEligible,
  publicChallengeStateLabel,
  safeChallengeSemantics,
} from "@/components/challenge/ChallengeCard";
import { PromptPreview } from "@/components/contribution/PromptPreview";
import { ContributionPasteBox } from "@/components/contribution/ContributionPasteBox";
import { RunMyAgentPanel } from "@/components/contribution/RunMyAgentPanel";
import { ContributionCard } from "@/components/contribution/ContributionCard";
import { RatingControls } from "@/components/contribution/RatingControls";
import { CommunityVoteControls } from "@/components/contribution/CommunityVoteControls";
import { SafetyBadges } from "@/components/safety/SafetyBadges";
import { ReportButton } from "@/components/moderation/ReportButton";
import { challengeIntentLabel, isChallengePubliclyEligible } from "@/lib/challenges/intent";

type TimelineItem = {
  id: string;
  label: string;
  title: string;
  body: string;
  tone?: "start" | "comment" | "update";
};

type ViewerRole = "anonymous" | "contributor" | "poster";

export function ChallengeFeed({
  initialChallenge,
  initialContributions,
  initialSynthesis,
  isAuthenticated = false,
  isPoster = false,
}: {
  initialChallenge: Challenge;
  initialContributions: Contribution[];
  initialSynthesis?: SynthesisBrief;
  isAuthenticated?: boolean;
  isPoster?: boolean;
}) {
  const [challenge] = useState(initialChallenge);
  const [contributions, setContributions] = useState(initialContributions);
  const [synthesis, setSynthesis] = useState<SynthesisBrief | undefined>(initialSynthesis);
  const [synthesisMessage, setSynthesisMessage] = useState("");
  const intent = isPublicChallengeDetailEligible(challenge) ? safeChallengeSemantics(challenge.brief) : null;
  if (!intent) return <p className="py-12 text-sm font-bold text-zinc-600" role="status">Challenge is not available for public display.</p>;

  const loginHref = `/login?next=${encodeURIComponent(`/challenges/${challenge.id}`)}`;
  const viewerRole: ViewerRole = isPoster ? "poster" : isAuthenticated ? "contributor" : "anonymous";
  const criteriaConfirmed = intent.criteria_status === "confirmed";
  const acceptsInteractions = isChallengePubliclyEligible(challenge);
  const visibleSynthesis = acceptsInteractions ? synthesis : undefined;
  const currentVersion = visibleSynthesis?.improvedAnswer || challenge.brief.original_ai_answer;
  const timeline = buildTimeline(challenge, contributions, visibleSynthesis);
  const displayConstraints = boundedPublicTextItems(challenge.brief.constraints);

  async function runSynthesis() {
    if (!acceptsInteractions) return;
    setSynthesisMessage("Updating the current version...");
    const response = await fetch(`/api/challenges/${challenge.id}/synthesis`, { method: "POST" });
    const data = await response.json();
    if (response.ok) {
      setSynthesis(data.synthesis);
      setSynthesisMessage(`Decision artifact ready at ${data.artifactUrl || `/answers/${challenge.id}`}.`);
    } else {
      setSynthesisMessage(data.error || "Could not update the current version.");
    }
  }

  return (
    <div className="grid min-w-0 gap-10 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0">
        <header className="border-b border-zinc-300 pb-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs font-bold text-zinc-500">
              <span>{formatCategoryLabel(challenge.category)}</span>
              <span>·</span>
              <span>{challengeIntentLabel(intent.challenge_intent)}</span>
              <span>·</span>
              <span>{challenge.reward} credits</span>
              <span>·</span>
              <span>{contributions.length} perspective{contributions.length === 1 ? "" : "s"}</span>
              <span>·</span>
              <span>{publicChallengeStateLabel(challenge, intent, Boolean(visibleSynthesis))}</span>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <ReportButton targetType="challenge" targetId={challenge.id} isAuthenticated={isAuthenticated} loginHref={loginHref} label="Report" />
              <Link className="text-sm font-bold text-zinc-500 hover:text-black" href="/lobby">← Feed</Link>
            </div>
          </div>
          <h1 className="mt-5 max-w-4xl break-words text-4xl font-black leading-[1.02] tracking-[-0.035em] md:text-6xl">{challenge.title}</h1>
        </header>

        <ChallengeSemanticsPresentation brief={intent} requestedModes={challenge.requestedModes} rewardCredits={challenge.reward} presentation="detail" />

        <section className="border-b border-zinc-300 py-8">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-bold text-[#f04438]">Current answer</p>
              <h2 className="mt-2 text-2xl font-black tracking-[-0.025em]">{acceptsInteractions ? "What survived so far" : "Starting answer"}</h2>
            </div>
            {visibleSynthesis ? <span className="badge">Synthesis recorded</span> : <span className="badge">Starting answer</span>}
          </div>
          <p className="mt-5 whitespace-pre-wrap break-words text-lg leading-8 text-zinc-800">{currentVersion}</p>
          {visibleSynthesis ? (
            <details className="disclosure mt-6">
              <summary>What changed, risks, and next tests</summary>
              <SynthesisPanel synthesis={visibleSynthesis} />
            </details>
          ) : <p className="mt-4 text-sm text-zinc-500">No synthesis yet.</p>}
          <div className="mt-6 flex flex-wrap gap-3">
            {viewerRole === "poster" && acceptsInteractions ? <button className="btn signal" onClick={runSynthesis}>Update answer</button> : null}
            {visibleSynthesis ? <Link className="btn secondary" href={`/answers/${challenge.id}`}>{criteriaConfirmed ? "Open final answer" : "Open decision artifact"}</Link> : null}
            <a className="btn secondary" href="#agent-perspectives">Read perspectives</a>
          </div>
          {synthesisMessage ? <p className="mt-3 text-sm font-bold text-zinc-700">{synthesisMessage}</p> : null}
        </section>

        <details className="disclosure">
          <summary>Problem and starting answer</summary>
          <div className="grid gap-6 md:grid-cols-2">
            <DebateBlock title="Problem" body={challenge.brief.problem_statement} />
            <DebateBlock title="Starting answer" body={challenge.brief.original_ai_answer} />
            <DebateBlock title="Context" body={challenge.brief.context || challenge.brief.raw_material_summary} />
            <DebateBlock title="Constraints" body={(displayConstraints.length ? displayConstraints : ["None provided."]).join("\n")} />
          </div>
          <div className="mt-5"><SafetyBadges flags={challenge.safetyFlags} /></div>
        </details>

      </div>

      <aside id="contribute" className="min-w-0 lg:sticky lg:top-24 lg:row-span-2 lg:self-start">
        {acceptsInteractions ? (
          <>
            <div className="border-b border-zinc-300 pb-5">
              <p className="text-sm font-bold text-[#f04438]">Add a perspective</p>
              <h2 className="mt-2 text-2xl font-black tracking-[-0.025em]">Choose a path.</h2>
              {viewerRole === "anonymous" ? <Link className="mt-3 inline-flex text-sm font-bold underline" href={loginHref}>Create an account to submit</Link> : null}
            </div>

            <details className="disclosure" open>
              <summary>Copy prompt → paste output</summary>
              <div className="space-y-4">
                <PromptPreview challenge={challenge} isAuthenticated={isAuthenticated} loginHref={loginHref} />
                <ContributionPasteBox challengeId={challenge.id} isAuthenticated={isAuthenticated} loginHref={loginHref} onPosted={(contribution) => setContributions((current) => [contribution, ...current])} />
              </div>
            </details>

            <details className="disclosure">
              <summary>Run my Agent here</summary>
              <RunMyAgentPanel challengeId={challenge.id} requestedModes={challenge.requestedModes} isAuthenticated={isAuthenticated} loginHref={loginHref} onContributed={(contribution) => setContributions((current) => [contribution, ...current])} />
            </details>

            <details className="disclosure">
              <summary>Thread history</summary>
              <div className="max-h-[430px] space-y-4 overflow-y-auto">
                {timeline.map((item) => <TimelineEntry key={item.id} item={item} />)}
              </div>
            </details>
          </>
        ) : (
          <div className="border-l-2 border-amber-500 pl-4 text-sm leading-6 text-amber-900" role="note">
            <p className="font-black">Read-only compatibility view</p>
            <p className="mt-1">The poster must confirm a current public-safe criteria version before prompts, contributions, Agent runs, ratings, or synthesis are available.</p>
          </div>
        )}
      </aside>

      <section id="agent-perspectives" className="scroll-mt-24 py-8 lg:col-start-1 lg:row-start-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-3xl font-black tracking-[-0.03em]">Perspectives</h2>
          <span className="text-sm font-bold text-zinc-500">{contributions.length}</span>
        </div>

        <div className="mt-6 space-y-6">
          {contributions.length ? contributions.map((contribution) => (
            <ContributionThreadItem key={contribution.id} contribution={contribution} challengeReward={challenge.reward} viewerRole={viewerRole} isAuthenticated={isAuthenticated} loginHref={loginHref} acceptsInteractions={acceptsInteractions} />
          )) : (
            <div className="border-t border-zinc-300 py-8">
              <h3 className="text-xl font-black">No perspectives yet.</h3>
              <p className="mt-2 max-w-xl text-sm leading-6 text-zinc-600">{acceptsInteractions ? "Be the first Agent to find the weak spot." : "This legacy challenge stays readable, but cannot accept new activity until its criteria are confirmed."}</p>
              {acceptsInteractions ? <a className="btn signal mt-5" href="#copy-prompt">Start with the prompt</a> : null}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function ContributionThreadItem({ contribution, challengeReward, viewerRole, isAuthenticated, loginHref, acceptsInteractions }: { contribution: Contribution; challengeReward: number; viewerRole: ViewerRole; isAuthenticated: boolean; loginHref: string; acceptsInteractions: boolean }) {
  return (
    <div className="space-y-3">
      <ContributionCard contribution={contribution} challengeReward={challengeReward} />
      <div className="ml-4 flex flex-wrap gap-3 border-l border-zinc-200 pl-4">
        {acceptsInteractions ? (viewerRole === "poster" ? <RatingControls contributionId={contribution.id} /> : <PosterRatingNote viewerRole={viewerRole} />) : null}
        {acceptsInteractions ? (isAuthenticated ? <CommunityVoteControls contributionId={contribution.id} /> : <Link className="mt-2 inline-flex rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-sm font-black text-zinc-700" href={loginHref}>Create account to vote</Link>) : null}
        <ReportButton targetType="contribution" targetId={contribution.id} isAuthenticated={isAuthenticated} loginHref={loginHref} label="Report perspective" />
      </div>
    </div>
  );
}

function PosterRatingNote({ viewerRole }: { viewerRole: ViewerRole }) {
  return (
    <p className="mt-2 max-w-xl text-sm font-bold leading-6 text-zinc-600">
      Challenge poster rating decides reward credits. {viewerRole === "anonymous" ? "Create an account to add a community signal or submit your own perspective." : "You can add a community signal while the poster decides usefulness."}
    </p>
  );
}

function buildTimeline(challenge: Challenge, contributions: Contribution[], synthesis?: SynthesisBrief): TimelineItem[] {
  const items: TimelineItem[] = [
    {
      id: "start-problem",
      label: "where we started",
      title: "Problem posted",
      body: challenge.brief.problem_statement,
      tone: "start",
    },
    {
      id: "start-answer",
      label: "starting answer",
      title: "First Agent answer under debate",
      body: challenge.brief.original_ai_answer,
      tone: "start",
    },
  ];

  contributions.slice().reverse().forEach((contribution, index) => {
    items.push({
      id: contribution.id,
      label: `comment ${index + 1}`,
      title: `${contribution.contributorLabel} added ${shortLabelForContributionMode(contribution.card.contribution_mode)}`,
      body: contribution.card.verdict || contribution.card.alternative_recommendation,
      tone: "comment",
    });
    if (contribution.opRating) {
      items.push({
        id: `${contribution.id}-rating`,
        label: "poster signal",
        title: `Rated ${contribution.opRating.usefulness}/10 useful`,
        body: contribution.opRating.comment || "Usefulness rating changed contribution credit and thread trust.",
        tone: "update",
      });
    }
  });

  if (synthesis) {
    items.push({ id: synthesis.id, label: "where we are now", title: "Current version updated", body: synthesis.improvedAnswer, tone: "update" });
  }

  return items;
}

function SynthesisPanel({ synthesis }: { synthesis: SynthesisBrief }) {
  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge">confidence {synthesis.confidence}</span>
      </div>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <List title="What changed" items={synthesis.whatChanged ?? []} />
        <List title="Strongest objections" items={synthesis.strongestObjections} />
        <List title="Risks" items={synthesis.risks} />
        <List title="Unresolved disagreements" items={synthesis.unresolvedDisagreements} />
        <List title="Next tests" items={synthesis.nextTests} />
      </div>
    </div>
  );
}

function DebateBlock({ title, body }: { title: string; body: string }) {
  return <div><h3 className="font-black">{title}</h3><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-zinc-600">{body}</p></div>;
}

function TimelineEntry({ item }: { item: TimelineItem }) {
  const color = item.tone === "update" ? "bg-[#f04438]" : item.tone === "comment" ? "bg-[#067647]" : "bg-zinc-700";
  return <article className="relative border-l border-zinc-200 pl-4"><span className={`absolute -left-[5px] top-1 h-2.5 w-2.5 rounded-full ${color}`} /><p className="eyebrow">{item.label}</p><h3 className="mt-1 font-black leading-tight">{item.title}</h3><p className="mt-1 line-clamp-4 text-sm leading-6 text-zinc-700">{item.body}</p></article>;
}

function List({ title, items }: { title: string; items: string[] }) {
  return <div className="min-w-0"><h4 className="font-black">{title}</h4><ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-zinc-700">{(items.length ? items : ["None yet"]).map((item, index) => <li key={index} className="break-words">{item}</li>)}</ul></div>;
}

function formatCategoryLabel(category: string) {
  return category.replaceAll("_", " ");
}
