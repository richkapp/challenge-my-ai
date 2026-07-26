import {
  agentPublicChallengeSchema,
  agentPublicChallengeSummarySchema,
  type AgentChallengeRunGrant,
  type AgentPublicChallenge,
  type AgentPublicChallengeSummary,
} from "@/lib/agent-protocol/schemas";
import { AgentFeedProjectionError, assertSafeAgentRelativePath, truncateCodePoints } from "@/lib/agent-feed/egress";
import type { Challenge, ChallengeCriteriaVersionRecord } from "@/lib/types";

const ACTIVE_AGENT_STATUSES = new Set(["open", "contributing", "ready_for_synthesis"] as const);
const MAX_SUMMARY_CODE_POINTS = 2_000;
const MAX_TEXT_CODE_POINTS = 40_000;
const MAX_LIST_ITEMS = 100;

function text(value: string, max = MAX_TEXT_CODE_POINTS): string {
  return truncateCodePoints(value.normalize("NFC"), max);
}

function list(values: readonly string[], maxItems = MAX_LIST_ITEMS, maxCodePoints = MAX_TEXT_CODE_POINTS): string[] {
  return values.slice(0, maxItems).map((value) => text(value, maxCodePoints));
}

function assertProjection<T>(result: { success: true; data: T } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } }): T {
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = issue?.path.length ? `$.${issue.path.join(".")}` : "$";
  throw new AgentFeedProjectionError("projection_invalid", `Agent challenge projection failed at ${path}: ${issue?.message || "invalid projection"}`);
}

export function projectAgentChallengeSummary(
  challenge: Challenge,
  criteria: ChallengeCriteriaVersionRecord,
): AgentPublicChallengeSummary {
  if (!ACTIVE_AGENT_STATUSES.has(challenge.status as "open" | "contributing" | "ready_for_synthesis")) {
    throw new AgentFeedProjectionError("projection_invalid", "Only active public challenges may be projected.");
  }
  if (criteria.challengeId !== challenge.id || criteria.version !== challenge.activeCriteriaVersion) {
    throw new AgentFeedProjectionError("projection_invalid", "Challenge criteria revision does not match the active challenge revision.");
  }
  const requestedPerspectives = criteria.requestedPerspectives?.length ? criteria.requestedPerspectives : challenge.requestedModes;
  const summary = challenge.brief.raw_material_summary || challenge.brief.problem_statement;
  return assertProjection(agentPublicChallengeSummarySchema.safeParse({
    challenge_id: challenge.id,
    revision: criteria.version,
    title: text(challenge.title, 200),
    category: text(challenge.category, 100),
    status: challenge.status,
    summary: text(summary, MAX_SUMMARY_CODE_POINTS),
    requested_modes: [...challenge.requestedModes],
    requested_perspectives: list(requestedPerspectives, 12, 240),
    reward_credits: Math.max(0, Math.trunc(challenge.reward)),
    contribution_count: Math.max(0, Math.trunc(challenge.contributionCount)),
    safety_flags: list(challenge.safetyFlags, 30, 160),
    published_at: challenge.createdAt,
    updated_at: challenge.updatedAt,
    urls: {
      room: assertSafeAgentRelativePath(`/challenges/${challenge.id}`),
      challenge: assertSafeAgentRelativePath(`/api/challenges/${challenge.id}/prompt`),
    },
  }));
}

export function projectAgentChallenge(
  challenge: Challenge,
  criteria: ChallengeCriteriaVersionRecord,
  runGrant: AgentChallengeRunGrant,
): AgentPublicChallenge {
  const summary = projectAgentChallengeSummary(challenge, criteria);
  return assertProjection(agentPublicChallengeSchema.safeParse({
    ...summary,
    challenge_semantics: {
      challenge_semantics_version: "1.0",
      challenge_intent: criteria.intent,
      criteria_status: "confirmed",
      criteria_version: criteria.version,
      successful_outcomes: [...criteria.successfulOutcomes],
      privacy_sensitivity: "public_ok",
      reward_posture: criteria.rewardPosture,
    },
    content: {
      problem_statement: text(challenge.brief.problem_statement),
      original_ai_answer: text(challenge.brief.original_ai_answer),
      context: text(challenge.brief.context),
      constraints: list(criteria.constraints ?? challenge.brief.constraints),
      success_criteria: list(criteria.successCriteria),
      assumptions_to_test: list(challenge.brief.assumptions_to_test),
      claims_to_check: list(challenge.brief.claims_to_check),
      known_risks: list(challenge.brief.known_risks),
      useful_response_should_address: list(challenge.brief.what_a_useful_response_should_address),
      missing_information: list(criteria.missingInformation ?? challenge.brief.missing_information),
    },
    run_grant: runGrant,
  }));
}
