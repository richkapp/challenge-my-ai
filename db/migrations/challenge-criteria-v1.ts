import {
  ChallengeIntentValidationError,
  createChallengeSemantics,
  declarativeRewardPosture,
  evaluateSuccessfulOutcome,
  normalizeChallengeIntentBrief,
  resolveChallengeSemantics,
  reviseChallengeCriteria,
  type ChallengeCriterionEvidence,
  type ChallengeCriteriaStatus,
  type ChallengeIntent,
  type ChallengeSuccessfulOutcome,
} from "@/lib/challenges/intent";
import { analyzeContentSafety } from "@/lib/safety/analyzeContent";
import { contributionModes } from "@/lib/types";
import type {
  Challenge,
  ChallengeBrief,
  ChallengeCriteriaHistory,
  ChallengeCriteriaQuarantineRecord,
  ChallengeCriteriaVersionRecord,
  ChallengePrivacySensitivity,
  ChallengePublicEligibility,
  ChallengePublicEligibilityReason,
  Contribution,
  ContributionMode,
  SafetyFlag,
} from "@/lib/types";

export type ChallengeCriteriaMigrationState = {
  challenges: Challenge[];
  contributions: Contribution[];
  challengeCriteriaVersions?: ChallengeCriteriaVersionRecord[];
  challengeCriteriaQuarantine?: ChallengeCriteriaQuarantineRecord[];
};

export type ChallengeCriteriaMigrationReport = {
  migratedChallenges: number;
  quarantinedChallenges: number;
  boundContributions: number;
};

export type ChallengeClosureEvaluation = { eligible: true } | { eligible: false; reasons: string[] };

export class ChallengeCriteriaPersistenceError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

type ExactChallengeCriteriaVersionRecord = ChallengeCriteriaVersionRecord & {
  snapshotFidelity: "exact";
  requestedPerspectives: ContributionMode[];
  constraints: string[];
  missingInformation: string[];
  sensitivity: ChallengePrivacySensitivity;
  publicEligibility: ChallengePublicEligibility;
};

function isExactCriteriaVersion(version: ChallengeCriteriaVersionRecord): version is ExactChallengeCriteriaVersionRecord {
  return version.snapshotFidelity === "exact"
    && Array.isArray(version.requestedPerspectives)
    && Array.isArray(version.constraints)
    && Array.isArray(version.missingInformation)
    && version.sensitivity !== null
    && version.publicEligibility !== null;
}

const publicBlockingFlags = new Set<SafetyFlag>(["secret_exposure", "privacy_risk", "sensitive_category"]);
const reviewRequiredFlags = new Set<SafetyFlag>(["prompt_injection", "malicious_code", "tool_use_request", "unsafe_link"]);

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isoOrFallback(value: string | undefined, fallback: string): string {
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : fallback;
}

function issueCode(path: string): string {
  const normalized = path.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 80);
  return normalized ? `invalid:${normalized}` : "invalid:challenge_semantics";
}

function rawHistorySafetyFlags(brief: ChallengeBrief): SafetyFlag[] {
  const text = (brief.criteria_history || []).flatMap((entry) => [
    ...entry.success_criteria,
    entry.change_reason,
  ]).join("\n");
  return analyzeContentSafety(text);
}

function briefPersistenceText(brief: ChallengeBrief): string {
  return [
    brief.title,
    brief.category,
    ...brief.challenge_mode_requested,
    brief.problem_statement,
    brief.original_ai_answer,
    brief.context,
    ...brief.constraints,
    ...brief.success_criteria,
    ...brief.assumptions_to_test,
    ...brief.claims_to_check,
    ...brief.known_risks,
    ...brief.what_a_useful_response_should_address,
    ...brief.missing_information,
    ...brief.abuse_or_safety_flags,
    ...(brief.criteria_history || []).flatMap((entry) => [...entry.success_criteria, entry.change_reason]),
  ].filter(Boolean).join("\n");
}

function briefPersistenceSafetyFlags(brief: ChallengeBrief): SafetyFlag[] {
  return analyzeContentSafety(briefPersistenceText(brief));
}

function persistedPublicText(challenge: Pick<Challenge, "title" | "category" | "brief" | "safetyFlags">): string {
  return [
    challenge.title,
    challenge.category,
    briefPersistenceText(challenge.brief),
  ].filter(Boolean).join("\n");
}

function publicEligibilityFor(input: {
  challenge: Pick<Challenge, "visibility" | "status" | "title" | "category" | "brief" | "safetyFlags">;
  criteriaVersion: number;
  criteriaStatus: ChallengeCriteriaStatus;
  sensitivity: ChallengePrivacySensitivity;
  assessedAt: string;
  invalid?: boolean;
  quarantined?: boolean;
}): ChallengePublicEligibility {
  const reasons: ChallengePublicEligibilityReason[] = [];
  if (input.challenge.visibility !== "public") reasons.push("not_public");
  if (input.challenge.status === "suppressed") reasons.push("suppressed");
  if (input.invalid) reasons.push("invalid_semantics");
  if (input.quarantined) reasons.push("quarantined");
  if (input.criteriaStatus !== "confirmed") reasons.push("criteria_unconfirmed");
  if (input.sensitivity === "private_only") reasons.push("private_only");
  if (input.sensitivity === "anonymize_first" || input.sensitivity === "unknown") reasons.push("privacy_approval_missing");

  const flags = new Set<SafetyFlag>([
    ...input.challenge.safetyFlags,
    ...analyzeContentSafety(persistedPublicText(input.challenge)),
  ]);
  if ([...flags].some((flag) => publicBlockingFlags.has(flag))) reasons.push("unsafe_public_content");
  else if ([...flags].some((flag) => reviewRequiredFlags.has(flag))) reasons.push("privacy_approval_missing");

  return {
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
    criteriaVersion: input.criteriaVersion,
    assessedAt: input.assessedAt,
  };
}

export function canonicalizeNewChallengeBrief(brief: ChallengeBrief, options: { publicWrite?: boolean } = {}): ChallengeBrief {
  const historyIsUnsafe = rawHistorySafetyFlags(brief).some((flag) => publicBlockingFlags.has(flag));
  if (options.publicWrite !== false && (historyIsUnsafe || briefPersistenceSafetyFlags(brief).some((flag) => publicBlockingFlags.has(flag)))) {
    throw new ChallengeCriteriaPersistenceError(historyIsUnsafe ? "unsafe_criteria_history" : "unsafe_challenge_content", "Challenge content is not eligible for public persistence.");
  }

  const resolved = resolveChallengeSemantics(brief);
  if (!resolved.ok) throw new ChallengeIntentValidationError(resolved.issues);
  if (resolved.legacy) return normalizeChallengeIntentBrief(brief);

  const semantics = createChallengeSemantics({
    intent: resolved.value.challenge_intent,
    successCriteria: brief.success_criteria,
    status: resolved.value.criteria_status,
    changeReason: "Initial challenge criteria persisted by the server.",
  });
  return { ...brief, ...semantics };
}

function criteriaVersionRecord(input: {
  challenge: Challenge;
  version: number;
  intent: ChallengeIntent;
  criteriaStatus: ChallengeCriteriaStatus;
  successCriteria: string[];
  successfulOutcomes: ChallengeSuccessfulOutcome[];
  changeReason: string;
  effectiveAt: string;
  effectiveAtSource: ChallengeCriteriaVersionRecord["effectiveAtSource"];
  changedBy: string;
  snapshotFidelity?: ChallengeCriteriaVersionRecord["snapshotFidelity"];
}): ChallengeCriteriaVersionRecord {
  const snapshotFidelity = input.snapshotFidelity || "exact";
  const eligibility = snapshotFidelity === "exact" ? publicEligibilityFor({
    challenge: input.challenge,
    criteriaVersion: input.version,
    criteriaStatus: input.criteriaStatus,
    sensitivity: input.challenge.brief.privacy_sensitivity,
    assessedAt: input.effectiveAt,
  }) : null;
  return {
    challengeId: input.challenge.id,
    version: input.version,
    snapshotFidelity,
    effectiveAt: input.effectiveAt,
    effectiveAtSource: input.effectiveAtSource,
    changedBy: input.changedBy,
    changeReason: input.changeReason,
    intent: input.intent,
    criteriaStatus: input.criteriaStatus,
    successCriteria: clone(input.successCriteria),
    successfulOutcomes: clone(input.successfulOutcomes),
    requestedPerspectives: snapshotFidelity === "exact" ? clone(input.challenge.brief.challenge_mode_requested) : null,
    constraints: snapshotFidelity === "exact" ? clone(input.challenge.brief.constraints) : null,
    missingInformation: snapshotFidelity === "exact" ? clone(input.challenge.brief.missing_information) : null,
    sensitivity: snapshotFidelity === "exact" ? input.challenge.brief.privacy_sensitivity : null,
    publicEligibility: eligibility,
    rewardPosture: clone(declarativeRewardPosture(input.intent)),
  };
}

export function initializeChallengeCriteriaPersistence(challengeInput: Challenge, changedBy: string, options: { migrated?: boolean } = {}): {
  challenge: Challenge;
  versions: ChallengeCriteriaVersionRecord[];
} {
  const challenge = clone(challengeInput);
  const brief = normalizeChallengeIntentBrief(challenge.brief);
  challenge.brief = brief;
  const semantics = resolveChallengeSemantics(brief);
  if (!semantics.ok) throw new ChallengeIntentValidationError(semantics.issues);
  const effectiveAt = isoOrFallback(challenge.createdAt, new Date(0).toISOString());
  const versions = semantics.value.criteria_history.map((entry, index) => criteriaVersionRecord({
    challenge,
    version: entry.version,
    intent: entry.intent,
    criteriaStatus: entry.status,
    successCriteria: entry.success_criteria,
    successfulOutcomes: entry.successful_outcomes,
    changeReason: entry.change_reason,
    effectiveAt: index === 0 ? effectiveAt : isoOrFallback(challenge.updatedAt, effectiveAt),
    effectiveAtSource: index === 0 ? "challenge_created_at" : "legacy_record_updated_at",
    changedBy,
    snapshotFidelity: options.migrated && index < semantics.value.criteria_history.length - 1 ? "legacy_partial" : "exact",
  }));
  challenge.activeCriteriaVersion = semantics.value.criteria_version;
  challenge.publicEligibility = clone(versions.at(-1)?.publicEligibility || publicEligibilityFor({
    challenge,
    criteriaVersion: semantics.value.criteria_version,
    criteriaStatus: semantics.value.criteria_status,
    sensitivity: brief.privacy_sensitivity,
    assessedAt: effectiveAt,
  }));
  return { challenge, versions };
}

function quarantineRecord(challenge: Challenge, reason: ChallengeCriteriaQuarantineRecord["reason"], issueCodes: string[]): ChallengeCriteriaQuarantineRecord {
  return {
    challengeId: challenge.id,
    reason,
    issueCodes: [...new Set(issueCodes)].slice(0, 20),
    detectedAt: isoOrFallback(challenge.updatedAt, isoOrFallback(challenge.createdAt, new Date(0).toISOString())),
  };
}

function validExistingHistory(challenge: Challenge, versions: ChallengeCriteriaVersionRecord[]): boolean {
  if (!versions.length) return false;
  const ordered = [...versions].sort((left, right) => left.version - right.version);
  if (!ordered.every((entry, index) => entry.challengeId === challenge.id && entry.version === index + 1)) return false;
  const latest = ordered.at(-1);
  if (!latest || !isExactCriteriaVersion(latest)) return false;
  return challenge.activeCriteriaVersion === latest.version
    && challenge.brief.criteria_version === latest.version
    && challenge.brief.challenge_intent === latest.intent
    && challenge.brief.criteria_status === latest.criteriaStatus
    && JSON.stringify(challenge.brief.success_criteria) === JSON.stringify(latest.successCriteria)
    && JSON.stringify(challenge.brief.successful_outcomes) === JSON.stringify(latest.successfulOutcomes)
    && JSON.stringify(challenge.requestedModes) === JSON.stringify(latest.requestedPerspectives);
}

export function refreshChallengePublicEligibility(challengeInput: Challenge, versions: ChallengeCriteriaVersionRecord[], assessedAt = challengeInput.updatedAt): Challenge {
  const challenge = clone(challengeInput);
  const current = versions.find((entry) => entry.challengeId === challenge.id && entry.version === challenge.activeCriteriaVersion);
  if (!current || !isExactCriteriaVersion(current)) {
    challenge.publicEligibility = publicEligibilityFor({
      challenge,
      criteriaVersion: challenge.activeCriteriaVersion || 0,
      criteriaStatus: "criteria_unconfirmed",
      sensitivity: challenge.brief.privacy_sensitivity,
      assessedAt: isoOrFallback(assessedAt, isoOrFallback(challenge.updatedAt, new Date(0).toISOString())),
      invalid: true,
    });
    return challenge;
  }
  challenge.publicEligibility = publicEligibilityFor({
    challenge,
    criteriaVersion: current.version,
    criteriaStatus: current.criteriaStatus,
    sensitivity: current.sensitivity,
    assessedAt: isoOrFallback(assessedAt, current.effectiveAt),
  });
  return challenge;
}

function versionAtContributionTime(versions: ChallengeCriteriaVersionRecord[], createdAt: string): ChallengeCriteriaVersionRecord | undefined {
  if (versions.length > 1 && versions.some((entry) => entry.effectiveAtSource === "legacy_record_updated_at")) return undefined;
  const contributionTime = Date.parse(createdAt);
  const ordered = [...versions].sort((left, right) => left.version - right.version);
  if (!Number.isFinite(contributionTime)) return ordered[0];
  const eligible = ordered.filter((entry) => Date.parse(entry.effectiveAt) <= contributionTime);
  return eligible.at(-1) || ordered[0];
}

export function migrateChallengeCriteriaState<T extends ChallengeCriteriaMigrationState>(rawState: T): {
  state: T & Required<Pick<ChallengeCriteriaMigrationState, "challengeCriteriaVersions" | "challengeCriteriaQuarantine">>;
  report: ChallengeCriteriaMigrationReport;
} {
  const state = clone(rawState) as T & Required<Pick<ChallengeCriteriaMigrationState, "challengeCriteriaVersions" | "challengeCriteriaQuarantine">>;
  state.challengeCriteriaVersions = clone(rawState.challengeCriteriaVersions || []);
  state.challengeCriteriaQuarantine = clone(rawState.challengeCriteriaQuarantine || []);
  let migratedChallenges = 0;
  let quarantinedChallenges = 0;
  let boundContributions = 0;

  state.challenges = state.challenges.map((challengeInput, index) => {
    const cloned = clone(challengeInput);
    const challenge = cloned && typeof cloned === "object" ? cloned : {} as Challenge;
    try {
      const existingQuarantine = state.challengeCriteriaQuarantine.find((entry) => entry.challengeId === challenge.id);
      if (existingQuarantine) return challenge;

      const existingVersions = state.challengeCriteriaVersions.filter((entry) => entry.challengeId === challenge.id);
      if (existingVersions.length) {
        if (!validExistingHistory(challenge, existingVersions)) {
          state.challengeCriteriaQuarantine.push(quarantineRecord(challenge, "invalid_persisted_history", ["invalid:criteria_version_history"]));
          quarantinedChallenges += 1;
          return challenge;
        }
        return challenge;
      }

      const resolved = resolveChallengeSemantics(challenge.brief);
      if (!resolved.ok) {
        const quarantine = quarantineRecord(challenge, "invalid_semantics", resolved.issues.map((issue) => issueCode(issue.path)));
        state.challengeCriteriaQuarantine.push(quarantine);
        challenge.publicEligibility = publicEligibilityFor({
          challenge,
          criteriaVersion: 0,
          criteriaStatus: "criteria_unconfirmed",
          sensitivity: challenge.brief.privacy_sensitivity,
          assessedAt: quarantine.detectedAt,
          invalid: true,
          quarantined: true,
        });
        quarantinedChallenges += 1;
        return challenge;
      }

      const historyFlags = rawHistorySafetyFlags(challenge.brief);
      const persistenceFlags = briefPersistenceSafetyFlags(challenge.brief);
      const unsafeFlags = persistenceFlags.filter((flag) => publicBlockingFlags.has(flag));
      if (challenge.visibility === "public" && unsafeFlags.length) {
        const historyIsUnsafe = historyFlags.some((flag) => publicBlockingFlags.has(flag));
        const quarantine = quarantineRecord(challenge, historyIsUnsafe ? "unsafe_history" : "unsafe_public_content", unsafeFlags.map((flag) => `safety:${flag}`));
        state.challengeCriteriaQuarantine.push(quarantine);
        challenge.publicEligibility = publicEligibilityFor({
          challenge,
          criteriaVersion: resolved.value.criteria_version,
          criteriaStatus: resolved.value.criteria_status,
          sensitivity: challenge.brief.privacy_sensitivity,
          assessedAt: quarantine.detectedAt,
          quarantined: true,
        });
        quarantinedChallenges += 1;
        return challenge;
      }

      challenge.brief = normalizeChallengeIntentBrief(challenge.brief);
      const initialized = initializeChallengeCriteriaPersistence(challenge, "system:migration", { migrated: true });
      state.challengeCriteriaVersions.push(...initialized.versions);
      migratedChallenges += 1;
      return initialized.challenge;
    } catch {
      const challengeId = typeof challenge.id === "string" && challenge.id ? challenge.id : `invalid-record-${index + 1}`;
      if (!state.challengeCriteriaQuarantine.some((entry) => entry.challengeId === challengeId)) {
        state.challengeCriteriaQuarantine.push({
          challengeId,
          reason: "invalid_semantics",
          issueCodes: ["invalid:record_shape"],
          detectedAt: isoOrFallback(challenge.updatedAt, isoOrFallback(challenge.createdAt, new Date(0).toISOString())),
        });
      }
      quarantinedChallenges += 1;
      return { ...challenge, id: challengeId, visibility: "private", status: "suppressed" };
    }
  });

  state.contributions = state.contributions.map((contributionInput) => {
    const contribution = clone(contributionInput);
    if (contribution.criteriaVersion !== undefined) return contribution;
    const versions = state.challengeCriteriaVersions.filter((entry) => entry.challengeId === contribution.challengeId);
    const version = versionAtContributionTime(versions, contribution.createdAt);
    contribution.criteriaVersion = version?.version ?? null;
    contribution.criteriaStatusAtSubmission = version?.criteriaStatus ?? null;
    if (version) boundContributions += 1;
    return contribution;
  });

  state.challengeCriteriaVersions.sort((left, right) => left.challengeId.localeCompare(right.challengeId) || left.version - right.version);
  state.challengeCriteriaQuarantine.sort((left, right) => left.challengeId.localeCompare(right.challengeId));

  return {
    state,
    report: { migratedChallenges, quarantinedChallenges, boundContributions },
  };
}

function validateRequestedPerspectives(values: ContributionMode[]): void {
  if (values.length < 1 || values.length > 3 || new Set(values).size !== values.length || values.some((value) => !contributionModes.includes(value))) {
    throw new ChallengeCriteriaPersistenceError("invalid_requested_perspectives", "Requested perspectives must contain one to three distinct values.");
  }
}

function validateSnapshotText(values: string[], field: string): string[] {
  if (values.length > 12) throw new ChallengeCriteriaPersistenceError(`invalid_${field}`, `${field} is limited to 12 items.`);
  if (values.some((value) => typeof value !== "string")) throw new ChallengeCriteriaPersistenceError(`invalid_${field}`, `${field} entries must be strings.`);
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => !value || value.length > 240)) {
    throw new ChallengeCriteriaPersistenceError(`invalid_${field}`, `${field} entries must be between 1 and 240 characters.`);
  }
  return normalized;
}

export function revisePersistedChallengeCriteria(input: {
  challenge: Challenge;
  versions: ChallengeCriteriaVersionRecord[];
  contributionCount: number;
  at: string;
  posterId: string;
  expectedVersion: number;
  intent: ChallengeIntent;
  successCriteria: string[];
  requestedPerspectives?: ContributionMode[];
  constraints?: string[];
  missingInformation?: string[];
  sensitivity?: ChallengePrivacySensitivity;
  status: ChallengeCriteriaStatus;
  changeReason: string;
}): { challenge: Challenge; version: ChallengeCriteriaVersionRecord } {
  if (input.challenge.posterId !== input.posterId) {
    throw new ChallengeCriteriaPersistenceError("poster_authorization_required", "Only the challenge poster may revise criteria.");
  }
  if (input.challenge.activeCriteriaVersion !== input.expectedVersion) {
    throw new ChallengeCriteriaPersistenceError("stale_criteria_version", "The criteria version changed before this revision was applied.");
  }
  if (!validExistingHistory(input.challenge, input.versions)) {
    throw new ChallengeCriteriaPersistenceError("invalid_persisted_history", "The persisted criteria history is incomplete or inconsistent.");
  }

  const requestedPerspectives = input.requestedPerspectives || input.challenge.brief.challenge_mode_requested;
  validateRequestedPerspectives(requestedPerspectives);
  const constraints = input.constraints ? validateSnapshotText(input.constraints, "constraints") : input.challenge.brief.constraints;
  const missingInformation = input.missingInformation ? validateSnapshotText(input.missingInformation, "missing_information") : input.challenge.brief.missing_information;
  const sensitivity = input.sensitivity || input.challenge.brief.privacy_sensitivity;
  if (!["public_ok", "anonymize_first", "private_only", "unknown"].includes(sensitivity)) {
    throw new ChallengeCriteriaPersistenceError("invalid_sensitivity", "Privacy sensitivity is invalid.");
  }
  const baseBrief: ChallengeBrief = {
    ...clone(input.challenge.brief),
    challenge_mode_requested: clone(requestedPerspectives),
    constraints: clone(constraints),
    missing_information: clone(missingInformation),
    privacy_sensitivity: sensitivity,
  };
  const brief = reviseChallengeCriteria(baseBrief, {
    intent: input.intent,
    successCriteria: input.successCriteria,
    status: input.status,
    contributionCount: input.contributionCount,
    changeReason: input.changeReason,
  });
  const unsafeFlags = briefPersistenceSafetyFlags(brief);
  if (input.challenge.visibility === "public" && unsafeFlags.some((flag) => publicBlockingFlags.has(flag))) {
    throw new ChallengeCriteriaPersistenceError("unsafe_challenge_content", "The criteria revision contains content that is not eligible for public persistence.");
  }

  const challenge: Challenge = {
    ...clone(input.challenge),
    updatedAt: new Date(input.at).toISOString(),
    requestedModes: clone(requestedPerspectives),
    brief,
    activeCriteriaVersion: brief.criteria_version,
  };
  const latest = brief.criteria_history.at(-1);
  if (!latest) throw new ChallengeCriteriaPersistenceError("invalid_persisted_history", "The criteria revision did not produce a history entry.");
  const version = criteriaVersionRecord({
    challenge,
    version: latest.version,
    intent: latest.intent,
    criteriaStatus: latest.status,
    successCriteria: latest.success_criteria,
    successfulOutcomes: latest.successful_outcomes,
    changeReason: latest.change_reason,
    effectiveAt: challenge.updatedAt,
    effectiveAtSource: "criteria_revision",
    changedBy: input.posterId,
  });
  const eligibility = version.publicEligibility;
  if (!eligibility) throw new ChallengeCriteriaPersistenceError("invalid_persisted_history", "The active criteria version is missing its eligibility snapshot.");
  challenge.publicEligibility = clone(eligibility);
  return { challenge, version };
}

export function challengeCriteriaHistory(challenge: Challenge, versions: ChallengeCriteriaVersionRecord[]): ChallengeCriteriaHistory | undefined {
  const ordered = versions.filter((entry) => entry.challengeId === challenge.id).sort((left, right) => left.version - right.version);
  if (!ordered.length || !challenge.activeCriteriaVersion) return undefined;
  return {
    challengeId: challenge.id,
    activeVersion: challenge.activeCriteriaVersion,
    versions: clone(ordered),
  };
}

function evidenceShapeIssues(input: {
  version: ExactChallengeCriteriaVersionRecord;
  criterionEvidence: ChallengeCriterionEvidence[];
  missingInformationEvidence: Array<{ item_number: number; evidence: string }>;
}): string[] {
  const reasons: string[] = [];
  if (input.criterionEvidence.length > input.version.successCriteria.length) reasons.push("unexpected_criterion_evidence");
  const criterionNumbers = input.criterionEvidence.map((entry) => entry.criterion_number);
  if (new Set(criterionNumbers).size !== criterionNumbers.length) reasons.push("duplicate_criterion_evidence");
  if (criterionNumbers.some((number) => !Number.isInteger(number) || number < 1 || number > input.version.successCriteria.length)) reasons.push("unexpected_criterion_evidence");
  if (input.criterionEvidence.some((entry) => typeof entry.evidence !== "string" || entry.evidence.length > 500)) reasons.push("invalid_criterion_evidence");

  if (input.missingInformationEvidence.length > input.version.missingInformation.length) reasons.push("unexpected_missing_information_evidence");
  const missingNumbers = input.missingInformationEvidence.map((entry) => entry.item_number);
  if (new Set(missingNumbers).size !== missingNumbers.length) reasons.push("duplicate_missing_information_evidence");
  if (missingNumbers.some((number) => !Number.isInteger(number) || number < 1 || number > input.version.missingInformation.length)) reasons.push("unexpected_missing_information_evidence");
  if (input.missingInformationEvidence.some((entry) => typeof entry.evidence !== "string" || entry.evidence.trim().length < 3 || entry.evidence.length > 500)) reasons.push("invalid_missing_information_evidence");
  input.version.missingInformation.forEach((_, index) => {
    if (!input.missingInformationEvidence.some((entry) => entry.item_number === index + 1)) reasons.push(`missing_information_${index + 1}_unresolved`);
  });
  return reasons;
}

export function evaluatePersistedChallengeClosure(input: {
  challenge: Challenge;
  history: ChallengeCriteriaHistory | undefined;
  posterId: string;
  outcome: ChallengeSuccessfulOutcome;
  criteriaVersion: number;
  criterionEvidence: ChallengeCriterionEvidence[];
  missingInformationEvidence: Array<{ item_number: number; evidence: string }>;
}): ChallengeClosureEvaluation {
  if (input.challenge.posterId !== input.posterId) return { eligible: false, reasons: ["poster_authorization_required"] };
  if (!input.history || input.criteriaVersion !== input.history.activeVersion) return { eligible: false, reasons: ["stale_criteria_version"] };
  const version = input.history.versions.find((entry) => entry.version === input.history?.activeVersion);
  if (!version || !isExactCriteriaVersion(version)) return { eligible: false, reasons: ["invalid_persisted_history"] };
  if (version.criteriaStatus !== "confirmed") return { eligible: false, reasons: ["criteria_unconfirmed"] };
  if (input.challenge.status === "suppressed") return { eligible: false, reasons: ["suppressed"] };
  if (!input.challenge.publicEligibility?.eligible) return { eligible: false, reasons: input.challenge.publicEligibility?.reasons || ["invalid_persisted_history"] };

  const evidenceIssues = evidenceShapeIssues({
    version,
    criterionEvidence: input.criterionEvidence,
    missingInformationEvidence: input.missingInformationEvidence,
  });
  if (evidenceIssues.length) return { eligible: false, reasons: [...new Set(evidenceIssues)] };
  const evaluation = evaluateSuccessfulOutcome({
    brief: input.challenge.brief,
    outcome: input.outcome,
    criteriaVersion: input.criteriaVersion,
    criterionEvidence: input.criterionEvidence,
    missingInformationResolved: version.missingInformation.every((_, index) => input.missingInformationEvidence.some((entry) => entry.item_number === index + 1)),
    posterConfirmed: true,
  });
  if (!evaluation.eligible) evidenceIssues.push(...evaluation.reasons);
  return evidenceIssues.length ? { eligible: false, reasons: [...new Set(evidenceIssues)] } : { eligible: true };
}
