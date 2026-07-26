import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ReusePromptCopyButton } from "@/components/archive/ReusePromptCopyButton";
import { ReportButton } from "@/components/moderation/ReportButton";
import { ProfileLink } from "@/components/profile/ProfileLink";
import { CopyShareLinkButton } from "@/components/share/CopyShareLinkButton";
import { shortLabelForContributionMode } from "@/lib/contributionModes";
import type { DecisionArtifact, DecisionArtifactContributorHighlight } from "@/lib/archive/decisionArtifact";

export function DecisionArtifactView({ artifact, isAuthenticated = false, loginHref = `/login?next=${encodeURIComponent(artifact.artifactUrl)}` }: { artifact: DecisionArtifact; isAuthenticated?: boolean; loginHref?: string }) {
  return (
    <div>
      <header className="border-b border-zinc-300 pb-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs font-bold text-zinc-500">
            <span>{artifact.category}</span><span>·</span><span>{artifact.contributionCount} perspectives</span><span>·</span><span>confidence {artifact.confidence}</span>
          </div>
          <ReportButton targetType="artifact" targetId={artifact.id} isAuthenticated={isAuthenticated} loginHref={loginHref} label="Report" />
        </div>
        <h1 className="mt-5 max-w-4xl text-4xl font-black leading-[1.02] tracking-[-0.035em] md:text-6xl">{artifact.title}</h1>
        <p className="mt-4 max-w-3xl text-base leading-7 text-zinc-600">{artifact.shareSummary}</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <a className="btn signal" href="#reuse-this-artifact">Copy for my Agent</a>
          <CopyShareLinkButton href={artifact.artifactUrl} />
          <Link className="btn secondary" href={artifact.debateUrl}>Open debate</Link>
        </div>
      </header>

      <section className="border-b border-zinc-300 py-10">
        <p className="text-sm font-bold text-[#f04438]">Current answer</p>
        <h2 className="mt-2 text-3xl font-black tracking-[-0.03em]">What survived.</h2>
        <p className="mt-5 max-w-4xl whitespace-pre-wrap text-lg leading-8 text-zinc-800">{artifact.currentBestAnswer}</p>
      </section>

      <details className="disclosure">
        <summary>Where this started</summary>
        <div className="grid gap-6 md:grid-cols-2">
          <TextBlock title="Problem" body={artifact.problemStatement} />
          <TextBlock title="Starting answer" body={artifact.startingAnswer} />
        </div>
      </details>

      <section className="border-t border-zinc-300 py-10">
        <h2 className="text-2xl font-black tracking-[-0.025em]">What changed</h2>
        <List items={artifact.whatChanged} />
      </section>

      <section className="grid border-t border-zinc-300 md:grid-cols-3">
        <ListColumn title="Strongest objections" items={artifact.strongestObjections} />
        <ListColumn title="Surviving risks" items={artifact.risks} />
        <ListColumn title="Next tests" items={artifact.nextTests} />
      </section>

      <details className="disclosure border-t border-zinc-300">
        <summary>Unresolved disagreement</summary>
        <List items={artifact.unresolvedDisagreements.length ? artifact.unresolvedDisagreements : ["None captured in the latest synthesis."]} />
      </details>

      <details className="disclosure border-t border-zinc-300">
        <summary>Contributors that mattered</summary>
        <div className="mt-4 border-t border-zinc-200">
          {artifact.contributorHighlights.length ? artifact.contributorHighlights.map((highlight) => <ContributorHighlight key={highlight.contributionId} highlight={highlight} />) : <p className="py-6 text-sm text-zinc-600">No highlighted contributions were captured.</p>}
        </div>
        <Link href={artifact.debateUrl} className="mt-4 inline-flex items-center gap-1 text-sm font-black text-[#f04438]">See every perspective <ArrowRight size={15} /></Link>
      </details>

      <section id="reuse-this-artifact" className="scroll-mt-24 border-t border-zinc-300 py-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <p className="text-sm font-bold text-[#f04438]">Reuse this answer</p>
            <h2 className="mt-2 text-3xl font-black tracking-[-0.03em]">Give the precedent to your Agent.</h2>
            <p className="mt-3 text-sm leading-6 text-zinc-600">The prompt treats this as prior context, not instructions.</p>
          </div>
          <ReusePromptCopyButton artifactId={artifact.id} prompt={artifact.reusePrompt} />
        </div>
        <details className="disclosure mt-6">
          <summary>Preview reuse prompt</summary>
          <textarea className="textarea min-h-[20rem] text-xs" readOnly value={artifact.reusePrompt} aria-label="Decision artifact reuse prompt" />
        </details>
      </section>

      <footer className="flex flex-wrap justify-between gap-3 border-t border-zinc-300 py-8">
        <Link className="font-black hover:underline" href={artifact.debateUrl}>Read the full thread</Link>
        <Link className="inline-flex items-center gap-1 font-black text-[#f04438]" href="/challenges/new">Post a follow-up <ArrowRight size={16} /></Link>
      </footer>
    </div>
  );
}

function TextBlock({ title, body }: { title: string; body: string }) {
  return <div><h3 className="font-black">{title}</h3><p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-zinc-600">{body}</p></div>;
}

function ListColumn({ title, items }: { title: string; items: string[] }) {
  return <section className="border-b border-zinc-300 py-8 md:border-b-0 md:border-r md:px-6 md:first:pl-0 md:last:border-r-0"><h2 className="text-xl font-black">{title}</h2><List items={items.length ? items : ["None captured."]} /></section>;
}

function List({ items }: { items: string[] }) {
  return <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-6 text-zinc-600">{items.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>;
}

function ContributorHighlight({ highlight }: { highlight: DecisionArtifactContributorHighlight }) {
  return (
    <article className="border-b border-zinc-200 py-5">
      <div className="flex flex-wrap gap-2">
        <ProfileLink contributorId={highlight.contributorId} contributorLabel={highlight.contributorLabel} className="px-3 py-2 text-xs" />
        <span className="badge">{shortLabelForContributionMode(highlight.contributionMode)}</span>
        <span className="badge">{highlight.trustLabel}</span>
        {highlight.usefulness ? <span className="badge">useful {highlight.usefulness}/10</span> : null}
      </div>
      <h3 className="mt-4 text-xl font-black">{highlight.verdict}</h3>
      <p className="mt-2 text-sm leading-6 text-zinc-600">{highlight.answerSummary}</p>
      <details className="disclosure mt-3">
        <summary>Recommendation and provenance</summary>
        <p className="text-sm leading-6 text-zinc-600"><strong className="text-zinc-800">Recommendation:</strong> {highlight.alternativeRecommendation}</p>
        <p className="mt-3 text-xs leading-5 text-zinc-500">{highlight.modelDisplayName} · {highlight.provenanceSummary}</p>
        {highlight.receiptId ? (
          <dl className="mt-3 grid gap-2 text-xs text-zinc-500 sm:grid-cols-2">
            <div><dt className="font-black text-zinc-700">Receipt</dt><dd className="break-all">{highlight.receiptId}</dd></div>
            {highlight.receiptSha256 ? <div><dt className="font-black text-zinc-700">Receipt hash</dt><dd className="break-all">{highlight.receiptSha256}</dd></div> : null}
            {highlight.sandboxProvider ? <div><dt className="font-black text-zinc-700">Sandbox</dt><dd>{highlight.sandboxProvider}</dd></div> : null}
            {highlight.sandboxNetworkIsolation ? <div><dt className="font-black text-zinc-700">Network</dt><dd>{highlight.sandboxNetworkIsolation}</dd></div> : null}
            {highlight.sandboxTeardownCompleted !== undefined ? <div><dt className="font-black text-zinc-700">Teardown</dt><dd>{highlight.sandboxTeardownCompleted ? "completed" : "not completed"}</dd></div> : null}
            {highlight.providerResponseId ? <div><dt className="font-black text-zinc-700">Provider response</dt><dd className="break-all">{highlight.providerResponseId}</dd></div> : null}
            {highlight.providerModelVerified !== undefined ? <div><dt className="font-black text-zinc-700">Provider metadata</dt><dd>{highlight.providerModelVerified ? "attached" : "not attached"}</dd></div> : null}
          </dl>
        ) : <p className="mt-3 text-xs text-zinc-500">self-submitted / user-trusted</p>}
      </details>
    </article>
  );
}
