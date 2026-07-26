import { NextResponse } from "next/server";
import { z } from "zod";
import { handleApiError, HttpError, parseJsonBody, validateBody } from "@/lib/api/responses";
import { requireUser } from "@/lib/auth";
import { createChallenge, ensureSeedData, listChallenges } from "@/lib/store";
import { challengeBriefSchema } from "@/lib/validation/schemas";
import { challengeIntakeValidationIssues, evaluateChallengePublicationPolicy, normalizeChallengeIntakeBrief } from "@/lib/moderation/publicationPolicy";
import { normalizeRequestedContributionModes } from "@/lib/contributionModes";
import { privateChallengeNotReadyDetails } from "@/lib/privateDeep/launchBoundary";
import { assertRateLimitPolicy } from "@/lib/security/rateLimit";
import { trackEvent } from "@/lib/analytics/events";
import { ChallengeIntentValidationError, challengeIntentPublicationIssues, normalizeChallengeIntentBrief } from "@/lib/challenges/intent";
import { canonicalChallengePublicationAcknowledgementBrief, challengePublicationAcknowledgementHash, challengePublicationAcknowledgementHashPattern } from "@/lib/challenges/intentAcknowledgement";
import type { Challenge } from "@/lib/types";

export const runtime = "nodejs";

const CREATE_CHALLENGE_MAX_BYTES = 64 * 1024;
const publicationAcknowledgementSchema = z.object({
  briefHash: z.string().regex(challengePublicationAcknowledgementHashPattern),
}).strict();
const createChallengeRequestSchema = z.object({
  brief: challengeBriefSchema,
  reward: z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  visibility: z.enum(["public", "private"]),
  confirmPrivacyOverride: z.boolean().optional(),
  criteriaAcknowledgement: publicationAcknowledgementSchema.optional(),
  privacyAcknowledgement: publicationAcknowledgementSchema.optional(),
}).strict();

export async function GET() {
  try {
    await ensureSeedData();
    const challenges = (await listChallenges())
      .filter((challenge) => challenge.publicEligibility?.eligible === true)
      .slice(0, 50)
      .map(publicChallengeProjection);
    return NextResponse.json({ challenges });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser(request);
    assertRateLimitPolicy("challenge_create", `user:${user.id}`);
    const body = validateBody(createChallengeRequestSchema, await parseJsonBody(request, { maxBytes: CREATE_CHALLENGE_MAX_BYTES }));
    const candidateBrief = normalizeChallengeIntakeBrief(body.brief);
    const intakeIssues = challengeIntakeValidationIssues(candidateBrief);
    if (intakeIssues.length) {
      throw new HttpError(422, "Challenge intake fields failed validation.", "invalid_challenge_intake", intakeIssues);
    }

    const intentIssues = challengeIntentPublicationIssues(candidateBrief);
    if (!candidateBrief.challenge_semantics_version) intentIssues.push({ path: "challenge_semantics_version", message: "Public intake requires the current challenge semantics version." });
    if (!candidateBrief.challenge_intent) intentIssues.push({ path: "challenge_intent", message: "Choose one of the seven supported challenge intents before publishing." });
    if (!candidateBrief.criteria_status) intentIssues.push({ path: "criteria_status", message: "The poster must confirm the active criteria before publishing." });
    if (intentIssues.length) {
      throw new HttpError(422, "Challenge intent and criteria are not ready for publication.", "invalid_challenge_intent", dedupeIntentIssues(intentIssues));
    }

    const normalizedBrief = (() => {
      try {
        return normalizeChallengeIntentBrief(candidateBrief);
      } catch (error) {
        if (error instanceof ChallengeIntentValidationError) {
          throw new HttpError(422, "Challenge intent and criteria failed validation.", "invalid_challenge_intent", error.issues);
        }
        throw error;
      }
    })();
    if (body.visibility === "private") {
      throw new HttpError(409, "Private challenge rooms are not live yet. Publish a public-safe challenge or wait for private/deep rooms.", "private_challenges_not_ready", privateChallengeNotReadyDetails("private"));
    }

    const visibility = "public";
    const policy = evaluateChallengePublicationPolicy({ brief: normalizedBrief, visibility, confirmPrivacyOverride: body.confirmPrivacyOverride === true });
    if (!policy.ok || policy.riskLevel !== "clear") {
      throw new HttpError(409, "Challenge cannot be posted with current privacy/safety settings.", "publication_policy_blocked", failClosedPolicy(policy));
    }
    const expectedAcknowledgementHash = await challengePublicationAcknowledgementHash(candidateBrief);
    if (!body.criteriaAcknowledgement) {
      throw new HttpError(422, "Review and confirm the exact current challenge criteria before publishing.", "challenge_acknowledgement_required", {
        path: "criteriaAcknowledgement.briefHash",
      });
    }
    if (body.criteriaAcknowledgement.briefHash !== expectedAcknowledgementHash) {
      throw new HttpError(422, "The challenge changed after criteria review. Review and confirm the current version again.", "stale_challenge_acknowledgement", {
        path: "criteriaAcknowledgement.briefHash",
      });
    }
    if (body.confirmPrivacyOverride === true && body.privacyAcknowledgement?.briefHash !== expectedAcknowledgementHash) {
      throw new HttpError(422, "The challenge changed after privacy review. Review the current version again.", "stale_challenge_acknowledgement", {
        path: "privacyAcknowledgement.briefHash",
      });
    }
    const brief = {
      ...canonicalChallengePublicationAcknowledgementBrief(normalizedBrief),
      challenge_mode_requested: normalizeRequestedContributionModes(normalizedBrief.challenge_mode_requested),
    };
    const challenge = await createChallenge({ posterId: user.id, brief, reward: body.reward, visibility, safetyFlags: policy.safetyFlags });
    trackEvent("challenge_created", {
      challenge_id: challenge.id,
      challenge_category_group: brief.category,
      requested_perspective_count: brief.challenge_mode_requested.length,
      requested_perspective_modes: brief.challenge_mode_requested,
      reward_bucket: rewardBucket(challenge.reward),
      privacy_sensitivity: brief.privacy_sensitivity,
      policy_blocker_count: policy.blockers.length,
      policy_warning_count: policy.warnings.length,
      safety_flag_count: policy.safetyFlags.length,
    });
    return NextResponse.json({ challenge: publicChallengeProjection(challenge), policy });
  } catch (error) {
    return handleApiError(error);
  }
}

function publicChallengeProjection(challenge: Challenge) {
  const brief = { ...challenge.brief };
  delete brief.criteria_history;
  return {
    id: challenge.id,
    createdAt: challenge.createdAt,
    updatedAt: challenge.updatedAt,
    status: challenge.status,
    title: challenge.title,
    category: challenge.category,
    visibility: "public" as const,
    reward: challenge.reward,
    requestedModes: [...challenge.requestedModes],
    brief,
    safetyFlags: [...challenge.safetyFlags],
    contributionCount: challenge.contributionCount,
    activeCriteriaVersion: challenge.activeCriteriaVersion ?? brief.criteria_version,
    publicEligibility: {
      eligible: true,
      criteriaVersion: challenge.publicEligibility?.criteriaVersion ?? challenge.activeCriteriaVersion ?? brief.criteria_version,
    },
  };
}

function dedupeIntentIssues(issues: Array<{ path: string; message: string }>) {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.path}:${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function failClosedPolicy(policy: ReturnType<typeof evaluateChallengePublicationPolicy>) {
  if (!policy.ok) return policy;
  return {
    ...policy,
    ok: false,
    blockers: [...policy.blockers, "Public eligibility requires a clear, public-safe brief; unbound warning overrides cannot publish."],
    canOverride: false,
    relatedArtifactSearchAllowed: false,
  };
}

function rewardBucket(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value <= 10) return "1_10";
  if (value <= 50) return "11_50";
  return "51_plus";
}
