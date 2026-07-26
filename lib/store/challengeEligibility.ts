import { isChallengePubliclyEligible } from "@/lib/challenges/intent";
import type {
  Challenge,
  ChallengeCriteriaQuarantineRecord,
  ChallengeCriteriaVersionRecord,
} from "@/lib/types";

export const activeAgentChallengeStatuses = [
  "open",
  "contributing",
  "ready_for_synthesis",
] as const;

export type ChallengeEligibilityState = {
  challenges: Challenge[];
  challengeCriteriaVersions: ChallengeCriteriaVersionRecord[];
  challengeCriteriaQuarantine: ChallengeCriteriaQuarantineRecord[];
};

export type EligibleAgentChallenge = {
  challenge: Challenge;
  criteria: ChallengeCriteriaVersionRecord & {
    snapshotFidelity: "exact";
    requestedPerspectives: NonNullable<ChallengeCriteriaVersionRecord["requestedPerspectives"]>;
    constraints: NonNullable<ChallengeCriteriaVersionRecord["constraints"]>;
    missingInformation: NonNullable<ChallengeCriteriaVersionRecord["missingInformation"]>;
    sensitivity: NonNullable<ChallengeCriteriaVersionRecord["sensitivity"]>;
    publicEligibility: NonNullable<ChallengeCriteriaVersionRecord["publicEligibility"]>;
  };
};

export function resolveEligibleAgentChallenge(
  state: ChallengeEligibilityState,
  challengeId: string,
  expectedRevision?: number,
): EligibleAgentChallenge | undefined {
  const challenge = state.challenges.find((candidate) => candidate.id === challengeId);
  if (!challenge) return undefined;
  if (!activeAgentChallengeStatuses.includes(challenge.status as (typeof activeAgentChallengeStatuses)[number])) return undefined;
  if (state.challengeCriteriaQuarantine.some((record) => record.challengeId === challenge.id)) return undefined;
  if (!isChallengePubliclyEligible(challenge)) return undefined;
  const revision = challenge.activeCriteriaVersion;
  if (!revision || revision < 1 || (expectedRevision !== undefined && revision !== expectedRevision)) return undefined;
  if (challenge.publicEligibility?.criteriaVersion !== revision || !challenge.publicEligibility.eligible) return undefined;
  const criteria = state.challengeCriteriaVersions.find((record) => record.challengeId === challenge.id && record.version === revision);
  if (
    !criteria
    || criteria.snapshotFidelity !== "exact"
    || criteria.criteriaStatus !== "confirmed"
    || criteria.sensitivity !== "public_ok"
    || !criteria.publicEligibility?.eligible
    || criteria.publicEligibility.criteriaVersion !== revision
    || !Array.isArray(criteria.requestedPerspectives)
    || !Array.isArray(criteria.constraints)
    || !Array.isArray(criteria.missingInformation)
  ) return undefined;
  return { challenge, criteria: criteria as EligibleAgentChallenge["criteria"] };
}
