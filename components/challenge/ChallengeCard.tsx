import Link from "next/link";
import { requestedContributionModesForNormalSurface, shortLabelForContributionMode } from "@/lib/contributionModes";
import type { Challenge, ChallengeBrief, ChallengePrivacySensitivity } from "@/lib/types";
import { SafetyBadges } from "@/components/safety/SafetyBadges";
import {
  buildChallengeDiscoveryMeta,
  challengeLifecycleLabelFor,
  formatChallengeCategory,
  type ChallengeDiscoveryMeta,
} from "@/lib/discovery/challengeDiscovery";
import {
  challengeIntentLabel,
  criteriaStatusLabel,
  isChallengePubliclyEligible,
  isChallengeReadOnlyCompatibilityEligible,
  normalizeChallengeIntentBrief,
  rewardPostureLabel,
  successfulOutcomeLabel,
  type ChallengeSemantics,
} from "@/lib/challenges/intent";

type NormalizedChallengeBrief = ChallengeBrief & ChallengeSemantics;
type SemanticsPresentation = "card" | "detail" | "confirmation";

export function isPublicChallengeDisplayEligible(challenge: Challenge): boolean {
  return isChallengePubliclyEligible(challenge);
}

export function isPublicChallengeDetailEligible(challenge: Challenge): boolean {
  return isChallengePubliclyEligible(challenge) || isChallengeReadOnlyCompatibilityEligible(challenge);
}

export function safeChallengeSemantics(brief: ChallengeBrief): NormalizedChallengeBrief | null {
  try {
    return normalizeChallengeIntentBrief(brief);
  } catch {
    return null;
  }
}

export function challengeSensitivityLabel(sensitivity: ChallengePrivacySensitivity): string {
  if (sensitivity === "public_ok") return "Marked public-safe";
  if (sensitivity === "anonymize_first") return "Anonymization review required before public display";
  if (sensitivity === "private_only") return "Private-only; not eligible for public display";
  return "Sensitivity not confirmed";
}

export function publicChallengeStateLabel(challenge: Challenge, semantics: ChallengeSemantics, hasSynthesis = false): string {
  if (semantics.criteria_status !== "confirmed") return hasSynthesis ? "artifact ready · outcome not verified" : "outcome not verified";
  if (hasSynthesis && challenge.status !== "closed") return "artifact ready";
  return challengeLifecycleLabelFor(challenge);
}

export function boundedPublicTextItems(items: readonly string[], maxItems = 8, maxCharacters = 240): string[] {
  return items
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .slice(0, maxItems)
    .map((item) => item.trim().slice(0, maxCharacters));
}

export function ChallengeCard({ challenge, discovery }: { challenge: Challenge; discovery?: ChallengeDiscoveryMeta }) {
  if (!isPublicChallengeDisplayEligible(challenge)) return null;
  const intent = safeChallengeSemantics(challenge.brief);
  if (!intent) return null;

  const meta = discovery || buildChallengeDiscoveryMeta(challenge);
  const criteriaConfirmed = intent.criteria_status === "confirmed";

  return (
    <article className="group flex min-w-0 flex-col border-t border-zinc-300 py-5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-bold text-zinc-500">
        <span>{formatChallengeCategory(challenge.category)}</span>
        <span>·</span>
        <span>{challengeIntentLabel(intent.challenge_intent)}</span>
        <span>·</span>
        <span>{challenge.reward} credits</span>
        <span>·</span>
        <span>{challenge.contributionCount} perspective{challenge.contributionCount === 1 ? "" : "s"}</span>
        <span>·</span>
        <span>{publicChallengeStateLabel(challenge, intent)}</span>
      </div>

      <Link href={`/challenges/${challenge.id}`} className="mt-3 text-2xl font-black leading-tight tracking-[-0.025em] group-hover:underline">
        {challenge.title}
      </Link>
      <p className="mt-2 line-clamp-3 text-sm leading-6 text-zinc-600">{challenge.brief.problem_statement}</p>

      <ChallengeSemanticsPresentation
        brief={intent}
        requestedModes={challenge.requestedModes}
        rewardCredits={challenge.reward}
        presentation="card"
      />
      {criteriaConfirmed && meta.matchReasons.length ? <p className="mt-3 text-xs font-bold text-zinc-500">{meta.matchReasons[0]}</p> : null}

      <div className="mt-3"><SafetyBadges flags={challenge.safetyFlags} /></div>
      <Link href={`/challenges/${challenge.id}`} className="mt-5 inline-flex min-h-11 items-center text-sm font-black text-[#f04438]">Open challenge →</Link>
    </article>
  );
}

export function ChallengeSemanticsPresentation({
  brief,
  requestedModes,
  rewardCredits,
  presentation,
}: {
  brief: NormalizedChallengeBrief;
  requestedModes: Challenge["requestedModes"];
  rewardCredits: number;
  presentation: SemanticsPresentation;
}) {
  const criteria = boundedPublicTextItems(brief.success_criteria);
  const constraints = boundedPublicTextItems(brief.constraints);
  const missingInformation = boundedPublicTextItems(brief.missing_information);
  const requestedPerspectives = requestedContributionModesForNormalSurface(requestedModes).map(shortLabelForContributionMode);
  const criteriaConfirmed = brief.criteria_status === "confirmed";
  const criteriaNeedDisclosure = criteria.length > 2 || criteria.some((criterion) => criterion.length > 140);
  const title = presentation === "confirmation" ? "Publication confirmation" : "Challenge criteria and declarations";
  const shellClass = presentation === "card"
    ? "mt-4 border-l-2 border-zinc-200 pl-4"
    : "border-b border-zinc-300 py-8";

  return (
    <section className={shellClass} aria-label={title}>
      <p className="text-xs font-black uppercase tracking-[0.12em] text-[#f04438]">{title}</p>
      {presentation === "detail" ? <h2 className="mt-2 text-2xl font-black tracking-[-0.025em]">What would move this challenge?</h2> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="badge">{challengeIntentLabel(brief.challenge_intent)}</span>
        <span className="badge">{criteriaStatusLabel(brief.criteria_status)}</span>
        <span className="text-xs font-bold text-zinc-500">active version {brief.criteria_version}</span>
      </div>
      {presentation === "card" ? (
        <div className="mt-2 flex flex-wrap items-center gap-2" aria-label="Requested perspective labels">
          <span className="text-xs font-black text-zinc-500">Requested:</span>
          {requestedPerspectives.map((perspective) => <span key={perspective} className="badge">{perspective}</span>)}
        </div>
      ) : null}

      {criteriaConfirmed ? (
        <p className="mt-3 text-sm leading-6 text-zinc-700">
          <strong>Permitted recorded outcome:</strong> {brief.successful_outcomes.map(successfulOutcomeLabel).join(" or ")}.
        </p>
      ) : (
        <p className="mt-3 border-l-2 border-amber-500 pl-3 text-sm font-bold leading-6 text-amber-900" role="note">
          No successful outcome can be recorded until the active criteria are confirmed. Activity, reward, and synthesis do not change that.
        </p>
      )}

      <h3 className="mt-4 text-sm font-black text-zinc-900">Active success or closure criteria</h3>
      {criteria.length ? (
        criteriaNeedDisclosure ? (
          <>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-6 text-zinc-700" aria-label="Active success or closure criteria preview">
              {criteria.slice(0, 2).map((criterion, index) => <li key={`${index}-${criterion}`} className="line-clamp-2 break-words">{criterion}</li>)}
            </ol>
            <details className="mt-2" open={presentation === "confirmation"}>
              <summary className="cursor-pointer text-sm font-black text-zinc-700">Show all {criteria.length} active criteria</summary>
              <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm leading-6 text-zinc-700" aria-label="All active success or closure criteria">
                {criteria.map((criterion, index) => <li key={`${index}-${criterion}`} className="whitespace-pre-wrap break-words">{criterion}</li>)}
              </ol>
            </details>
          </>
        ) : (
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-6 text-zinc-700" aria-label="Active success or closure criteria">
            {criteria.map((criterion, index) => <li key={`${index}-${criterion}`} className="whitespace-pre-wrap break-words">{criterion}</li>)}
          </ol>
        )
      ) : <p className="mt-2 text-sm font-bold text-amber-900">No active criteria are available.</p>}

      {presentation === "card" ? (
        <>
          <p className="mt-4 text-xs font-bold leading-5 text-zinc-500">{rewardPostureLabel(rewardCredits)}</p>
          <details className="mt-3">
            <summary className="cursor-pointer text-sm font-black text-zinc-700">Requested perspectives, constraints, and reward declarations</summary>
            <DeclarationFacts requestedPerspectives={requestedPerspectives} constraints={constraints} missingInformation={missingInformation} sensitivity={brief.privacy_sensitivity} />
            <RewardPostureFacts brief={brief} rewardCredits={rewardCredits} />
          </details>
        </>
      ) : (
        <>
          <DeclarationFacts requestedPerspectives={requestedPerspectives} constraints={constraints} missingInformation={missingInformation} sensitivity={brief.privacy_sensitivity} />
          <RewardPostureFacts brief={brief} rewardCredits={rewardCredits} />
        </>
      )}
    </section>
  );
}

function DeclarationFacts({
  requestedPerspectives,
  constraints,
  missingInformation,
  sensitivity,
}: {
  requestedPerspectives: string[];
  constraints: string[];
  missingInformation: string[];
  sensitivity: ChallengePrivacySensitivity;
}) {
  return (
    <div className="mt-4 grid gap-4 text-sm md:grid-cols-2">
      <FactList title="Requested perspectives" items={requestedPerspectives} emptyLabel="None declared." />
      <FactList title="Constraints" items={constraints} emptyLabel="None declared." />
      <FactList title="Declared missing information" items={missingInformation} emptyLabel="None declared." />
      <div className="min-w-0">
        <h4 className="font-black text-zinc-900">Sensitivity</h4>
        <p className="mt-1 leading-6 text-zinc-600">{challengeSensitivityLabel(sensitivity)}</p>
      </div>
    </div>
  );
}

function RewardPostureFacts({ brief, rewardCredits }: { brief: NormalizedChallengeBrief; rewardCredits: number }) {
  const completionBonus = brief.reward_posture.completion_bonus === "eligible"
    ? "May be considered after poster-confirmed completion"
    : "Not applicable for this intent";

  return (
    <div className="mt-4 border-t border-zinc-200 pt-4 text-sm" aria-label="Declarative reward posture">
      <h4 className="font-black text-zinc-900">Declarative reward posture</h4>
      <p className="mt-1 leading-6 text-zinc-600">{rewardPostureLabel(rewardCredits)}</p>
      <dl className="mt-2 grid gap-x-4 gap-y-1 text-xs leading-5 text-zinc-600 sm:grid-cols-[max-content_1fr]">
        <dt className="font-black text-zinc-800">Basis</dt><dd>Poster-confirmed impact</dd>
        <dt className="font-black text-zinc-800">Funding</dt><dd>Declarative only</dd>
        <dt className="font-black text-zinc-800">Impact review tiers</dt><dd>{brief.reward_posture.eligible_impact_tiers.join(", ")}</dd>
        <dt className="font-black text-zinc-800">Completion bonus</dt><dd>{completionBonus}</dd>
      </dl>
      <p className="mt-2 text-xs font-bold leading-5 text-zinc-500">Impact tiers are reward-review labels, not closure outcomes. No credit reservation or settlement is represented.</p>
    </div>
  );
}

function FactList({ title, items, emptyLabel }: { title: string; items: string[]; emptyLabel: string }) {
  return (
    <div className="min-w-0">
      <h4 className="font-black text-zinc-900">{title}</h4>
      {items.length ? (
        <ul className="mt-1 list-disc space-y-1 pl-5 leading-6 text-zinc-600">
          {items.map((item, index) => <li key={`${index}-${item}`} className="whitespace-pre-wrap break-words">{item}</li>)}
        </ul>
      ) : <p className="mt-1 leading-6 text-zinc-500">{emptyLabel}</p>}
    </div>
  );
}
