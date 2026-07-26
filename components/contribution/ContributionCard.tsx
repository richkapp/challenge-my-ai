import { ProfileLink } from "@/components/profile/ProfileLink";
import type { Contribution, ModelProvenance } from "@/lib/types";
import { shortLabelForContributionMode } from "@/lib/contributionModes";
import { rewardForRating } from "@/lib/credits/settlement";
import { manualContributionTrustLabel } from "@/lib/provenance/manual";
import { modelDisplayName, modelProvenanceTrustLabel, sandboxProofLimitNote } from "@/lib/provenance/model";

export function ContributionCard({ contribution, challengeReward }: { contribution: Contribution; challengeReward?: number }) {
  const card = contribution.card;
  const rewardSignal = contributionRewardSignal(contribution, challengeReward);

  return (
    <article className="border-t border-zinc-300 py-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge">{contribution.contributorKind === "agent" ? "Agent perspective" : "Agent-assisted perspective"}</span>
        <ProfileLink contributorId={contribution.contributorId} contributorLabel={contribution.contributorLabel} className="px-3 py-2 text-xs" />
        <span className="badge">{shortLabelForContributionMode(card.contribution_mode)}</span>
        {contribution.externallyGenerated && contribution.contributorKind === "human" ? <span className="badge">{manualContributionTrustLabel()}</span> : null}
        <span className="badge">{modelDisplayName(card.model_provenance, card.contributor_ai_label)}</span>
        <span className="badge">{rewardSignal.label}</span>
      </div>

      <h3 className="mt-4 text-2xl font-black leading-tight tracking-[-0.025em]">{card.verdict}</h3>
      <p className="mt-3 text-base leading-7 text-zinc-800">{card.answer_to_challenge_poster}</p>

      <div className="mt-5 border-t border-zinc-200 pt-4">
        <h4 className="font-black">Recommendation</h4>
        <p className="mt-2 text-sm leading-6 text-zinc-600">{card.alternative_recommendation}</p>
      </div>

      <details className="disclosure mt-4">
        <summary>Objections, risks, and assumptions</summary>
        <div className="grid gap-5 sm:grid-cols-2">
          <List title="Strongest objections" items={card.strongest_objections} />
          <List title="Risks" items={card.risks_and_failure_modes} />
          <List title="Missing assumptions" items={card.missing_assumptions_or_context} />
          <List title="What changes this view" items={card.what_would_change_my_mind} />
        </div>
      </details>

      <details className="disclosure">
        <summary>Trust and provenance</summary>
        <div className="flex flex-wrap gap-2">
          <span className="badge">grade {card.original_answer_grade.score_0_to_10}/10</span>
          <span className="badge">confidence {card.confidence.level}</span>
          <span className="badge">community {contribution.communityScore}</span>
          <span className="badge">{modelProvenanceTrustLabel(card.model_provenance)}</span>
          {contribution.opRating ? <span className="badge">rated useful {contribution.opRating.usefulness}/10</span> : null}
        </div>
        {card.model_provenance ? <ProvenanceDetail provenance={card.model_provenance} /> : contribution.externallyGenerated ? <ManualProvenanceDetail /> : null}
      </details>
    </article>
  );
}

function contributionRewardSignal(contribution: Contribution, challengeReward?: number) {
  const rating = contribution.opRating;
  if (rating && typeof challengeReward === "number") {
    const reward = rewardForRating({ usefulness: rating.usefulness, safety: rating.safety, challengeReward });
    return reward > 0 ? { label: `earned ${reward} credits` } : { label: "no reward" };
  }
  if (rating) return { label: `poster rating ${rating.usefulness}/10` };
  if (contribution.communityScore > 0) return { label: "community trust" };
  if (contribution.communityScore < 0) return { label: "community caution" };
  return { label: "awaiting rating" };
}

function ProvenanceDetail({ provenance }: { provenance: ModelProvenance }) {
  const sandboxRun = provenance.source === "hermes_sandbox_run";
  const proofLimit = sandboxRun
    ? sandboxProofLimitNote(provenance).trim()
    : "Manual paste is self-submitted. Provider and model identity are not verified.";
  const teardownLabel = provenance.sandbox_teardown_completed === undefined
    ? undefined
    : provenance.sandbox_teardown_completed
      ? "completed"
      : "not completed";

  return (
    <div className="mt-4 text-xs leading-5 text-zinc-600" aria-label="Contribution provenance inspection">
      <p className="font-bold text-zinc-800">{provenance.verification_notes}</p>
      <dl className="mt-3 grid gap-2 sm:grid-cols-2">
        <div><dt className="font-black">Trust</dt><dd>{modelProvenanceTrustLabel(provenance)}</dd></div>
        <div><dt className="font-black">Provider</dt><dd>{provenance.provider}</dd></div>
        <div><dt className="font-black">Model</dt><dd>{modelDisplayName(provenance)}</dd></div>
        {provenance.receipt_id ? <div><dt className="font-black">Receipt</dt><dd className="break-all">{provenance.receipt_id}</dd></div> : null}
        {provenance.receipt_sha256 ? <div><dt className="font-black">Receipt hash</dt><dd className="break-all">{provenance.receipt_sha256}</dd></div> : null}
        {provenance.sandbox_provider ? <div><dt className="font-black">Sandbox</dt><dd>{provenance.sandbox_provider}</dd></div> : null}
        {sandboxRun ? <div><dt className="font-black">Broker proof</dt><dd>CMAI-controlled run cell</dd></div> : null}
        {provenance.provider_response_id ? <div><dt className="font-black">Provider response</dt><dd className="break-all">{provenance.provider_response_id}</dd></div> : null}
        {teardownLabel ? <div><dt className="font-black">Teardown</dt><dd>{teardownLabel}</dd></div> : null}
      </dl>
      <p className="mt-3">Proof limits: {proofLimit}</p>
    </div>
  );
}

function ManualProvenanceDetail() {
  return <p className="mt-4 text-xs leading-5 text-zinc-600" aria-label="Manual contribution provenance inspection">Manual paste is self-submitted. Challenge My AI does not verify the provider, exact model, or run lifecycle.</p>;
}

function List({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h4 className="font-black">{title}</h4>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-zinc-600">
        {(items.length ? items : ["None provided"]).map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}
      </ul>
    </div>
  );
}
