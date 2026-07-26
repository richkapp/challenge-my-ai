import type { ChallengeBrief } from "@/lib/types";
import { createChallengeSemantics, normalizeChallengeIntentBrief } from "@/lib/challenges/intent";

export type ChallengePublicationAcknowledgement = {
  briefHash: string;
};

export const challengePublicationAcknowledgementHashPattern = /^[a-f0-9]{64}$/;

export async function challengePublicationAcknowledgementHash(brief: ChallengeBrief): Promise<string> {
  const bytes = new TextEncoder().encode(challengePublicationAcknowledgementPayload(brief));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function challengePublicationAcknowledgementPayload(brief: ChallengeBrief): string {
  const canonical = canonicalChallengePublicationAcknowledgementBrief(brief);
  return JSON.stringify({
    schema_version: canonical.schema_version,
    challenge_semantics_version: canonical.challenge_semantics_version,
    challenge_intent: canonical.challenge_intent,
    criteria_status: canonical.criteria_status,
    criteria_version: canonical.criteria_version,
    title: canonical.title,
    category: canonical.category,
    challenge_mode_requested: canonical.challenge_mode_requested,
    problem_statement: canonical.problem_statement,
    original_ai_answer: canonical.original_ai_answer,
    context: canonical.context,
    constraints: canonical.constraints,
    success_criteria: canonical.success_criteria,
    assumptions_to_test: canonical.assumptions_to_test,
    claims_to_check: canonical.claims_to_check,
    known_risks: canonical.known_risks,
    what_a_useful_response_should_address: canonical.what_a_useful_response_should_address,
    privacy_sensitivity: canonical.privacy_sensitivity,
    redactions_made: canonical.redactions_made,
    abuse_or_safety_flags: canonical.abuse_or_safety_flags,
    missing_information: canonical.missing_information,
    raw_material_summary: canonical.raw_material_summary,
  });
}

export function canonicalChallengePublicationAcknowledgementBrief(brief: ChallengeBrief): ChallengeBrief {
  const normalized = normalizeChallengeIntentBrief(brief);
  return {
    ...normalized,
    ...createChallengeSemantics({
      intent: normalized.challenge_intent,
      successCriteria: normalized.success_criteria,
      status: "confirmed",
      changeReason: "Server initialized canonical criteria version 1.",
    }),
  };
}
