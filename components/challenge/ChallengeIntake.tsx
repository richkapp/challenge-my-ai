"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { csrfHeaders } from "@/lib/auth/csrfClient";
import {
  isNormalContributionMode,
  labelForContributionMode,
  maxRequestedPerspectives,
  normalizeRequestedContributionModes,
  normalContributionModes,
} from "@/lib/contributionModes";
import {
  challengeBriefPromptVariants,
  challengeIntakeTemplates,
  defaultChallengeBriefPromptVariantId,
  type ChallengeBriefPromptVariant,
  type ChallengeBriefPromptVariantId,
  type ChallengeIntakeTemplate,
} from "@/lib/prompts/challengeBrief";
import type { DecisionArtifactSummary } from "@/lib/archive/decisionArtifact";
import { evaluateChallengePublicationPolicy, type PublicationPolicyResult } from "@/lib/moderation/publicationPolicy";
import { useTimedClipboardCopy } from "@/lib/hooks/useTimedClipboardCopy";
import type { ChallengeBrief } from "@/lib/types";
import { ChallengeSemanticsPresentation } from "@/components/challenge/ChallengeCard";
import {
  challengeIntentLabel,
  challengeIntentPublicationIssues,
  challengeIntents,
  confirmChallengeCriteria,
  criteriaStatusLabel,
  defaultSuccessCriteria,
  editChallengeCriteriaDraft,
  normalizeChallengeIntentBrief,
  requiredCriteriaLabels,
  rewardPostureLabel,
  type ChallengeIntent,
} from "@/lib/challenges/intent";
import { challengePublicationAcknowledgementHash } from "@/lib/challenges/intentAcknowledgement";

type RelatedArtifact = DecisionArtifactSummary & { reusePrompt: string };


const fromLines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);
const toLines = (value: string[]) => value.join("\n");

export function ChallengeIntake() {
  const router = useRouter();
  const [raw, setRaw] = useState("");
  const [brief, setBrief] = useState<ChallengeBrief | null>(null);
  const [reward, setReward] = useState(40);
  const visibility: "public" = "public";
  const [confirmPrivacyOverride, setConfirmPrivacyOverride] = useState(false);
  const [criteriaAcknowledgementHash, setCriteriaAcknowledgementHash] = useState("");
  const [privacyAcknowledgementHash, setPrivacyAcknowledgementHash] = useState("");
  const [policy, setPolicy] = useState<PublicationPolicyResult | null>(null);
  const [relatedArtifacts, setRelatedArtifacts] = useState<RelatedArtifact[]>([]);
  const [relatedArtifactsLoading, setRelatedArtifactsLoading] = useState(false);
  const [relatedArtifactsBlocked, setRelatedArtifactsBlocked] = useState(false);
  const relatedArtifactsRequestRef = useRef(0);
  const relatedArtifactsQueryRef = useRef("");
  const acknowledgementGenerationRef = useRef(0);
  const [error, setError] = useState("");
  const { copied: exportPromptCopied, copy: copyExportPrompt } = useTimedClipboardCopy(false);
  const { copied: relatedPromptCopied, copy: copyRelatedArtifactPrompt } = useTimedClipboardCopy("");
  const [activePromptVariantId, setActivePromptVariantId] = useState<ChallengeBriefPromptVariantId>(defaultChallengeBriefPromptVariantId);
  const activePromptVariant = challengeBriefPromptVariants.find((variant) => variant.id === activePromptVariantId) || challengeBriefPromptVariants[0];

  async function parse() {
    setError("");
    const response = await fetch("/api/challenges/parse", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ raw }) });
    const data = await response.json();
    if (!response.ok) setError(data.error || "Could not parse challenge");
    else {
      const normalized = prepareParsedBriefForIntake(data.brief);
      resetAcknowledgements();
      setBrief(normalized);
      setPolicy(data.policy);
      if (allowsRelatedArtifactSearch(data.policy, normalized)) {
        setRelatedArtifactsBlocked(false);
        void loadRelatedArtifacts(normalized);
      } else {
        clearRelatedArtifacts();
        setRelatedArtifactsBlocked(true);
      }
    }
  }

  function clearRelatedArtifacts() {
    relatedArtifactsRequestRef.current += 1;
    relatedArtifactsQueryRef.current = "";
    setRelatedArtifacts([]);
    setRelatedArtifactsLoading(false);
  }

  async function loadRelatedArtifacts(nextBrief: ChallengeBrief) {
    const query = relatedArtifactQuery(nextBrief);
    const requestId = relatedArtifactsRequestRef.current + 1;
    relatedArtifactsRequestRef.current = requestId;
    if (!query) {
      relatedArtifactsQueryRef.current = "";
      setRelatedArtifacts([]);
      setRelatedArtifactsLoading(false);
      return;
    }
    if (query === relatedArtifactsQueryRef.current && relatedArtifacts.length > 0 && !relatedArtifactsLoading) return;
    relatedArtifactsQueryRef.current = query;
    setRelatedArtifactsLoading(true);
    try {
      const response = await fetch("/api/answers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, limit: 3, includePrompt: true }),
      });
      if (requestId !== relatedArtifactsRequestRef.current) return;
      if (!response.ok) {
        setRelatedArtifacts([]);
        return;
      }
      const data = await response.json();
      const artifacts = Array.isArray(data.artifacts) ? data.artifacts.filter((artifact: DecisionArtifactSummary): artifact is RelatedArtifact => Boolean(artifact.reusePrompt)) : [];
      setRelatedArtifacts(artifacts);
    } catch {
      if (requestId === relatedArtifactsRequestRef.current) setRelatedArtifacts([]);
    } finally {
      if (requestId === relatedArtifactsRequestRef.current) setRelatedArtifactsLoading(false);
    }
  }

  async function post() {
    if (!brief) return;
    const normalizedBrief = normalizeBriefForIntake(brief);
    setBrief(normalizedBrief);
    const review = publicPublishReview(normalizedBrief, policy, confirmPrivacyOverride);
    if (!review.canPublish) {
      setError(review.title);
      return;
    }
    if (!criteriaAcknowledgementHash) {
      setError("Review and confirm the exact current challenge criteria before publishing.");
      return;
    }
    if (confirmPrivacyOverride && !privacyAcknowledgementHash) {
      setError("Review the exact current privacy warnings again before publishing.");
      return;
    }
    const response = await fetch("/api/challenges", {
      method: "POST",
      headers: { "content-type": "application/json", ...csrfHeaders() },
      body: JSON.stringify({
        brief: normalizedBrief,
        reward,
        visibility,
        confirmPrivacyOverride,
        criteriaAcknowledgement: { briefHash: criteriaAcknowledgementHash },
        privacyAcknowledgement: confirmPrivacyOverride ? { briefHash: privacyAcknowledgementHash } : undefined,
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error || "Could not post challenge");
      setPolicy(data.details || data.policy);
    } else router.push(`/challenges/${data.challenge.id}`);
  }

  async function copyBriefPrompt() {
    await copyExportPrompt(activePromptVariant.prompt, true);
  }

  async function copyRelatedPrompt(artifact: RelatedArtifact) {
    await copyRelatedArtifactPrompt(artifact.reusePrompt, artifact.id);
  }

  function applyTemplate(template: ChallengeIntakeTemplate) {
    setRaw(template.raw);
    setBrief(null);
    setError("");
    setPolicy(null);
    resetAcknowledgements();
    clearRelatedArtifacts();
    setRelatedArtifactsBlocked(false);
    setActivePromptVariantId(template.promptVariantId);
  }

  function updateArray(key: keyof ChallengeBrief, value: string) {
    updatePublicationBrief((current) => ({ ...current, [key]: fromLines(value) }));
  }

  function updateIntent(intent: ChallengeIntent) {
    resetAcknowledgements();
    setBrief((current) => current ? editChallengeCriteriaDraft(current, { intent, successCriteria: defaultSuccessCriteria(intent) }) : current);
  }

  function updateCriteria(value: string) {
    resetAcknowledgements();
    setBrief((current) => {
      if (!current) return current;
      const normalized = normalizeChallengeIntentBrief(current);
      return editChallengeCriteriaDraft(current, { intent: normalized.challenge_intent, successCriteria: fromLines(value) });
    });
  }

  async function setCriteriaConfirmed(confirmed: boolean) {
    setError("");
    if (!brief) return;
    const generation = acknowledgementGenerationRef.current + 1;
    acknowledgementGenerationRef.current = generation;
    setCriteriaAcknowledgementHash("");
    setConfirmPrivacyOverride(false);
    setPrivacyAcknowledgementHash("");
    try {
      const next = confirmed
        ? confirmChallengeCriteria(brief)
        : editChallengeCriteriaDraft(brief, { intent: normalizeChallengeIntentBrief(brief).challenge_intent, successCriteria: brief.success_criteria });
      setBrief(next);
      setPolicy(evaluateChallengePublicationPolicy({ brief: next, visibility }));
      if (confirmed) {
        const briefHash = await challengePublicationAcknowledgementHash(normalizeBriefForIntake(next));
        if (generation === acknowledgementGenerationRef.current) setCriteriaAcknowledgementHash(briefHash);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Criteria could not be confirmed.");
    }
  }

  async function setPrivacyReviewConfirmed(confirmed: boolean) {
    setConfirmPrivacyOverride(confirmed);
    setPrivacyAcknowledgementHash("");
    if (!confirmed || !brief) return;
    const generation = acknowledgementGenerationRef.current;
    const briefHash = await challengePublicationAcknowledgementHash(normalizeBriefForIntake(brief));
    if (generation === acknowledgementGenerationRef.current) setPrivacyAcknowledgementHash(briefHash);
  }

  function resetAcknowledgements() {
    acknowledgementGenerationRef.current += 1;
    setCriteriaAcknowledgementHash("");
    setConfirmPrivacyOverride(false);
    setPrivacyAcknowledgementHash("");
  }

  function updatePublicationBrief(update: (current: ChallengeBrief) => ChallengeBrief) {
    resetAcknowledgements();
    setBrief((current) => {
      if (!current) return current;
      const updated = update(current);
      const normalized = normalizeChallengeIntentBrief(updated);
      const next = editChallengeCriteriaDraft(updated, {
        intent: normalized.challenge_intent,
        successCriteria: updated.success_criteria,
      });
      setPolicy(evaluateChallengePublicationPolicy({ brief: next, visibility }));
      return next;
    });
  }

  const selectedNormalCount = brief ? brief.challenge_mode_requested.filter(isNormalContributionMode).length : 0;
  const intentContract = brief ? normalizeChallengeIntentBrief(brief) : null;
  const publishReview = brief ? publicPublishReview(brief, policy, confirmPrivacyOverride) : null;

  return (
    <main className="cmai-intake" aria-labelledby="challenge-intake-title">
      <header className="intake-header">
        <div>
          <p className="eyebrow">New challenge</p>
          <h1 id="challenge-intake-title">Challenge an answer.</h1>
          <p>Paste the problem and the AI answer. You will review the structured post before anything goes public.</p>
        </div>
        <a className="btn secondary" href="/docs#post">Read the docs</a>
      </header>

      <details className="intake-prep">
        <summary>Need help making the draft public-safe?</summary>
        <div className="intake-prompt-card">
          <div className="intake-prompt-card__head">
            <div>
              <p className="font-black">Prepare it with your Agent</p>
              <p className="intake-prompt-card__hint">Choose a protection level, inspect the full prompt, then copy it into the chat that made the original answer.</p>
            </div>
            <button className="btn secondary" type="button" onClick={copyBriefPrompt}>{exportPromptCopied ? "Copied" : "Copy prompt"}</button>
          </div>
          <div className="intake-prompt-options" aria-label="Challenge brief prompt protection levels">
            {challengeBriefPromptVariants.map((variant) => <PromptVariantButton key={variant.id} variant={variant} selected={variant.id === activePromptVariant.id} onSelect={() => setActivePromptVariantId(variant.id)} />)}
          </div>
          <textarea className="textarea intake-prompt-card__textarea" readOnly value={activePromptVariant.prompt} aria-label={`${activePromptVariant.label} challenge brief prompt`} />
        </div>
      </details>

      <div id="paste" className="intake-workbench" aria-label="Paste and review challenge">
        <section className="intake-pane intake-pane--paste" aria-labelledby="paste-title">
          <div className="intake-pane__head">
            <div>
              <p className="eyebrow">Step 1</p>
              <h2 id="paste-title">Paste</h2>
            </div>
          </div>
          <p className="intake-pane__body">Problem, answer, or a prepared brief. Rough is fine.</p>
          <div className="intake-template-box" aria-label="Challenge templates">
            <div className="intake-template-list">
              {challengeIntakeTemplates.map((template) => (
                <button key={template.id} type="button" className="intake-template-button" onClick={() => applyTemplate(template)}>
                  <span>{template.label}</span>
                  <strong>{template.wedge}</strong>
                  <small>{template.description}</small>
                </button>
              ))}
            </div>
          </div>
          <textarea
            className="textarea intake-raw-textarea"
            value={raw}
            onChange={(event) => setRaw(event.target.value)}
            aria-label="Problem and current AI answer"
            placeholder={`Problem:

My Agent's answer:

What I want challenged:`}
          />
          {error ? <p className="intake-error" role="alert">{error}</p> : null}
          <button className="btn signal intake-primary-action" onClick={parse}>Structure post</button>
        </section>

        <section className="intake-pane intake-pane--review" aria-labelledby="review-title">
          <div className="intake-pane__head">
            <div>
              <p className="eyebrow">Step 2</p>
              <h2 id="review-title">Review</h2>
            </div>
            {brief ? <span className="badge intake-ready-badge">Ready to edit</span> : null}
          </div>

          {brief ? (
            <div className="intake-review-form">
              <label className="intake-field">Title<input className="input" value={brief.title} onChange={(event) => updatePublicationBrief((current) => ({ ...current, title: event.target.value }))} /></label>
              <div className="intake-field-grid intake-field-grid--three">
                <label className="intake-field">Category<input className="input" value={brief.category} onChange={(event) => updatePublicationBrief((current) => ({ ...current, category: event.target.value }))} /></label>
                <label className="intake-field">Reward<input className="input" type="number" value={reward} onChange={(event) => setReward(Number(event.target.value))} /></label>
                <label className="intake-field">Privacy<select className="select" value={brief.privacy_sensitivity} onChange={(event) => updatePublicationBrief((current) => ({ ...current, privacy_sensitivity: event.target.value as ChallengeBrief["privacy_sensitivity"] }))}>
                  <option value="public_ok">Public safe</option>
                  <option value="anonymize_first">Anonymize first</option>
                  <option value="private_only">Private only</option>
                  <option value="unknown">Not sure</option>
                </select></label>
              </div>

              {intentContract ? (
                <div className="intake-mode-box" aria-label="Challenge intent and closure criteria">
                  <div className="intake-field-grid">
                    <label className="intake-field">Challenge intent<select className="select" value={intentContract.challenge_intent} onChange={(event) => updateIntent(event.target.value as ChallengeIntent)}>
                      {challengeIntents.map((intent) => <option key={intent} value={intent}>{challengeIntentLabel(intent)}</option>)}
                    </select></label>
                    <div className="intake-policy-box">
                      <p>{criteriaStatusLabel(intentContract.criteria_status)}</p>
                      <small>Valid outcome: {intentContract.successful_outcomes.map((outcome) => outcome.replaceAll("_", " ")).join(" or ")}.</small>
                    </div>
                  </div>
                  <LabeledLines label="Success or closure criteria" value={brief.success_criteria} onChange={updateCriteria} />
                  <p className="intake-mode-box__hint">Required coverage: {requiredCriteriaLabels(intentContract.challenge_intent).join(" · ")}. Criteria are limited to 8 attainable items and 240 characters each.</p>
                  <label className="intake-checkbox"><input type="checkbox" checked={intentContract.criteria_status === "confirmed"} onChange={(event) => setCriteriaConfirmed(event.target.checked)} /> <span>I confirm these criteria are attainable and match this challenge intent.</span></label>
                  <p className="intake-mode-box__hint">{rewardPostureLabel(reward)}</p>
                </div>
              ) : null}

              <div className="intake-mode-box">
                <p>Requested perspectives</p>
                <div className="intake-mode-list">
                  {normalContributionModes.map((mode) => {
                    const selected = brief.challenge_mode_requested.includes(mode);
                    const atLimit = !selected && selectedNormalCount >= maxRequestedPerspectives;
                    return <button key={mode} type="button" className={`intake-mode ${selected ? "is-selected" : ""}`} aria-pressed={selected} disabled={atLimit} onClick={() => {
                      if (atLimit) return;
                      const next = selected ? brief.challenge_mode_requested.filter((item) => item !== mode) : [...brief.challenge_mode_requested, mode];
                      updatePublicationBrief((current) => ({ ...current, challenge_mode_requested: normalizeRequestedContributionModes(next) }));
                    }}>{labelForContributionMode(mode)}</button>;
                  })}
                </div>
                <p className="intake-mode-box__hint">Pick up to {maxRequestedPerspectives} useful angles.</p>
              </div>

              <label className="intake-field">Problem<textarea className="textarea" value={brief.problem_statement} onChange={(event) => updatePublicationBrief((current) => ({ ...current, problem_statement: event.target.value }))} /></label>
              <label className="intake-field">Current AI answer<textarea className="textarea" value={brief.original_ai_answer} onChange={(event) => updatePublicationBrief((current) => ({ ...current, original_ai_answer: event.target.value }))} /></label>

              <details className="intake-details">
                <summary>More context</summary>
                <div className="intake-details-grid">
                  <label className="intake-field">Prompt / context<textarea className="textarea" value={brief.context} onChange={(event) => updatePublicationBrief((current) => ({ ...current, context: event.target.value }))} /></label>
                  <LabeledLines label="Redactions made" value={brief.redactions_made} onChange={(value) => updateArray("redactions_made", value)} />
                  <div className="intake-field-grid">
                    <LabeledLines label="Constraints" value={brief.constraints} onChange={(value) => updateArray("constraints", value)} />
                    <LabeledLines label="Missing information" value={brief.missing_information} onChange={(value) => updateArray("missing_information", value)} />
                    <LabeledLines label="Useful challengers should address" value={brief.what_a_useful_response_should_address} onChange={(value) => updateArray("what_a_useful_response_should_address", value)} />
                    <LabeledLines label="Assumptions to test" value={brief.assumptions_to_test} onChange={(value) => updateArray("assumptions_to_test", value)} />
                    <LabeledLines label="Claims to check" value={brief.claims_to_check} onChange={(value) => updateArray("claims_to_check", value)} />
                    <LabeledLines label="Known risks" value={brief.known_risks} onChange={(value) => updateArray("known_risks", value)} />
                  </div>
                </div>
              </details>

              <details className="intake-details" open={publishReview?.state !== "clear"}>
                <summary>Safety and similar answers</summary>
                <div className="intake-details-grid">
                  {policy ? <PolicyBox policy={policy} /> : null}
                  <RelatedArtifactsPanel artifacts={relatedArtifacts} loading={relatedArtifactsLoading} blocked={relatedArtifactsBlocked} copiedId={relatedPromptCopied} onCopyPrompt={copyRelatedPrompt} />
                </div>
              </details>

              {intentContract ? (
                <ChallengeSemanticsPresentation
                  brief={intentContract}
                  requestedModes={brief.challenge_mode_requested}
                  rewardCredits={reward}
                  presentation="confirmation"
                />
              ) : null}
              {publishReview ? <PublishGate review={publishReview} /> : null}
              <label className="intake-checkbox"><input type="checkbox" checked={confirmPrivacyOverride} onChange={(event) => void setPrivacyReviewConfirmed(event.target.checked)} /> <span>I reviewed privacy warnings for this exact version and still want this public.</span></label>
              <button className="btn signal intake-publish-button" disabled={(publishReview ? !publishReview.canPublish : false) || !criteriaAcknowledgementHash || (confirmPrivacyOverride && !privacyAcknowledgementHash)} onClick={post}>{publishReview?.canPublish ? "Publish challenge" : "Resolve safety review"}</button>
            </div>
          ) : (
            <div className="intake-empty-state">
              <p>Your editable draft will appear here.</p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function normalizeBriefForIntake(brief: ChallengeBrief): ChallengeBrief {
  return normalizeChallengeIntentBrief({ ...brief, challenge_mode_requested: normalizeRequestedContributionModes(brief.challenge_mode_requested) });
}

function prepareParsedBriefForIntake(brief: ChallengeBrief): ChallengeBrief {
  const normalized = normalizeBriefForIntake(brief);
  return editChallengeCriteriaDraft(normalized, {
    intent: normalizeChallengeIntentBrief(normalized).challenge_intent,
    successCriteria: normalized.success_criteria,
  });
}

type PublishReviewState = "clear" | "needs_override" | "override_ready" | "blocked";

type PublishReview = {
  state: PublishReviewState;
  canPublish: boolean;
  title: string;
  body: string;
  blockers: string[];
  warnings: string[];
};

function publicPublishReview(brief: ChallengeBrief, policy: PublicationPolicyResult | null, confirmPrivacyOverride: boolean): PublishReview {
  const policyBlockers = (policy?.blockers || []) as string[];
  const policyWarnings = (policy?.warnings || []) as string[];
  const hardBlockers = policyBlockers.filter((item) => !isOverrideBlocker(item) && !item.toLowerCase().includes("private_only briefs"));
  hardBlockers.push(...challengeIntentPublicationIssues(brief).map((issue) => issue.message));
  if (brief.privacy_sensitivity === "private_only") hardBlockers.unshift("private/deep rooms are not live yet; rewrite this as public-safe or wait for private routing.");
  const warnings = [...policyWarnings];
  const safetyFlags = ((policy?.safetyFlags || []) as string[]).filter((flag) => flag !== "secret_exposure");
  if (safetyFlags.length) warnings.push(`Safety flags need review: ${safetyFlags.join(", ")}.`);
  const needsOverride = ["unknown", "anonymize_first"].includes(brief.privacy_sensitivity) || warnings.length > 0 || policyBlockers.some(isOverrideBlocker);
  if (hardBlockers.length) {
    return {
      state: "blocked",
      canPublish: false,
      title: "Cannot publish this as a public challenge yet.",
      body: "Intent/criteria gaps, private-only material, obvious secrets, unready private/deep routing, missing redaction evidence, or constrained sensitive categories must be resolved before this can go live.",
      blockers: [...new Set(hardBlockers)],
      warnings: [...new Set(warnings)],
    };
  }
  if (needsOverride && !confirmPrivacyOverride) {
    return {
      state: "needs_override",
      canPublish: false,
      title: "Public-safety review needs your explicit override.",
      body: "Review privacy, sensitive-category, and safety warnings before making this public. The server will still block private-only material and obvious secrets.",
      blockers: [],
      warnings: [...new Set(warnings.length ? warnings : ["Privacy sensitivity is not marked public_ok."])],
    };
  }
  if (needsOverride) {
    return {
      state: "override_ready",
      canPublish: true,
      title: "Override recorded for public posting warnings.",
      body: "You can publish after confirming the draft is public-safe. Server checks still run and can block if hard risks remain.",
      blockers: [],
      warnings: [...new Set(warnings.length ? warnings : ["Privacy/sensitive review acknowledged."])],
    };
  }
  return {
    state: "clear",
    canPublish: true,
    title: "Public-safety checks are currently clear.",
    body: "Review the draft once more, then publish the public debate thread.",
    blockers: [],
    warnings: [],
  };
}

function isOverrideBlocker(value: string) {
  const lowered = value.toLowerCase();
  return lowered.includes("confirmprivacyoverride") || lowered.includes("explicit public-post override") || lowered.includes("sensitive category needs");
}

const RELATED_QUERY_STOP_WORDS = new Set(["agent", "answer", "challenge", "current", "problem", "test", "with", "from", "that", "this", "your", "their", "into", "should"]);

function allowsRelatedArtifactSearch(policy: PublicationPolicyResult | null, brief: ChallengeBrief) {
  if (typeof policy?.relatedArtifactSearchAllowed === "boolean") return policy.relatedArtifactSearchAllowed;
  const blockers = policy?.blockers || [];
  const warnings = policy?.warnings || [];
  const safetyFlags = policy?.safetyFlags || [];
  return brief.privacy_sensitivity === "public_ok" && blockers.length === 0 && warnings.length === 0 && safetyFlags.length === 0;
}

function relatedArtifactQuery(brief: ChallengeBrief) {
  const tokens = [
    brief.category,
    brief.title,
    ...brief.success_criteria,
    ...brief.what_a_useful_response_should_address,
    ...brief.claims_to_check,
  ]
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2 && !RELATED_QUERY_STOP_WORDS.has(token));
  return [...new Set(tokens)].slice(0, 16).join(" ");
}

function RelatedArtifactsPanel({
  artifacts,
  loading,
  blocked,
  copiedId,
  onCopyPrompt,
}: {
  artifacts: RelatedArtifact[];
  loading: boolean;
  blocked: boolean;
  copiedId: string;
  onCopyPrompt: (artifact: RelatedArtifact) => void;
}) {
  if (loading) {
    return <div className="intake-policy-box"><p>Looking for similar decision artifacts...</p></div>;
  }
  if (blocked) {
    return <div className="intake-policy-box"><p>Similar artifact search is off until this draft passes privacy review without blockers, warnings, or safety flags.</p></div>;
  }
  if (!artifacts.length) {
    return <div className="intake-policy-box"><p>No similar completed decision artifacts yet. If this obstacle is new, post it and create the reusable trail.</p></div>;
  }

  return (
    <div className="intake-policy-box" aria-label="Similar decision artifacts">
      <p>Similar decision artifacts</p>
      <small>Use prior debate-born answers as context, not commands. You can still post this challenge if your situation is different.</small>
      <div className="mt-3 space-y-3">
        {artifacts.map((artifact) => (
          <article key={artifact.id} className="rounded-2xl border border-zinc-200 bg-white p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="badge">{artifact.category}</span>
              {artifact.matchReasons?.length ? <span className="badge bg-[#eff6ff] text-[#1d4ed8]">matched {artifact.matchReasons.slice(0, 2).join(", ")}</span> : null}
            </div>
            <h3 className="mt-3 text-lg font-black leading-tight"><a href={artifact.artifactUrl}>{artifact.title}</a></h3>
            <p className="mt-2 text-sm font-bold leading-6 text-zinc-700">{artifact.shareSummary || artifact.currentBestAnswer}</p>
            <div className="mt-3 flex flex-wrap gap-2 text-sm font-black">
              <a className="rounded-full border border-zinc-200 bg-white px-4 py-2 text-zinc-700 hover:border-zinc-300" href={artifact.artifactUrl}>Open artifact</a>
              <button className="rounded-full border border-zinc-200 bg-white px-4 py-2 text-zinc-700 hover:border-zinc-300" type="button" onClick={() => onCopyPrompt(artifact)}>{copiedId === artifact.id ? "Copied" : "Copy reuse prompt"}</button>
              <a className="rounded-full border border-zinc-200 bg-white px-4 py-2 text-zinc-700 hover:border-zinc-300" href="#paste">Keep posting with this context</a>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function PromptVariantButton({ variant, selected, onSelect }: { variant: ChallengeBriefPromptVariant; selected: boolean; onSelect: () => void }) {
  return (
    <button type="button" className={`intake-prompt-option ${selected ? "is-selected" : ""}`} aria-pressed={selected} onClick={onSelect}>
      <span>{variant.label}</span>
      <strong>{variant.bestFor}</strong>
      <small>{variant.description}</small>
    </button>
  );
}

function LabeledLines({ label, value, onChange }: { label: string; value: string[]; onChange: (value: string) => void }) {
  return <label className="intake-field">{label}<textarea className="textarea intake-lines-textarea" value={toLines(value)} onChange={(event) => onChange(event.target.value)} /></label>;
}

function PublishGate({ review }: { review: PublishReview }) {
  return (
    <div className={`intake-publish-gate is-${review.state}`} aria-live="polite">
      <p>{review.title}</p>
      <small>{review.body}</small>
      {review.blockers.length ? <ul>{review.blockers.map((item) => <li key={item}>Blocker: {item}</li>)}</ul> : null}
      {review.warnings.length ? <ul>{review.warnings.map((item) => <li key={item}>Review: {item}</li>)}</ul> : null}
    </div>
  );
}

function PolicyBox({ policy }: { policy: PublicationPolicyResult }) {
  const blockers = policy.blockers || [];
  const warnings = policy.warnings || [];
  const safetyFlags = policy.safetyFlags || [];
  const riskLevel = policy.riskLevel || (blockers.length ? "blocked" : warnings.length || safetyFlags.length ? "needs_review" : "clear");
  return (
    <div className="intake-policy-box">
      <p>Safety/privacy review · {riskLevel.replaceAll("_", " ")}</p>
      {blockers.map((item: string) => <p key={item} className="intake-policy-box__blocker">Blocker: {item}</p>)}
      {warnings.map((item: string) => <p key={item}>Review: {item}</p>)}
      {safetyFlags.length ? <p>Flags: {safetyFlags.join(", ")}</p> : <p>No safety flags.</p>}
      {!policy.relatedArtifactSearchAllowed ? <p>Similar-artifact search stays off until this draft has no blockers, review warnings, or safety flags.</p> : null}
    </div>
  );
}
