import { buildDecisionArtifact, buildDecisionArtifacts } from "@/lib/archive/decisionArtifact";
import { ensureSeedData, getChallenge, getLatestSynthesis, listChallenges, listContributions } from "@/lib/store";
import type { Challenge, Contribution, SynthesisBrief } from "@/lib/types";
import { isChallengePubliclyEligible } from "@/lib/challenges/intent";

export type DecisionArtifactRow = {
  challenge: Challenge;
  contributions: Contribution[];
  synthesis: SynthesisBrief;
};

type ListDecisionArtifactsOptions = {
  query?: string;
  limit?: number;
};

export async function loadDecisionArtifactRows(): Promise<DecisionArtifactRow[]> {
  await ensureSeedData();
  const candidates = (await listChallenges()).filter(isChallengePubliclyEligible);
  const rows = await Promise.all(candidates.map(loadDecisionArtifactRowForChallenge));
  return rows.filter((row): row is DecisionArtifactRow => Boolean(row));
}

export async function listDecisionArtifacts(options: ListDecisionArtifactsOptions = {}) {
  const rows = await loadDecisionArtifactRows();
  return buildDecisionArtifacts({ rows, query: options.query, limit: options.limit });
}

export async function loadDecisionArtifact(id: string) {
  const row = await loadDecisionArtifactRow(id);
  return row ? buildDecisionArtifact(row) : undefined;
}

async function loadDecisionArtifactRow(id: string): Promise<DecisionArtifactRow | undefined> {
  await ensureSeedData();
  const challenge = await getChallenge(id);
  if (!challenge || !isChallengePubliclyEligible(challenge)) return undefined;
  return loadDecisionArtifactRowForChallenge(challenge);
}

async function loadDecisionArtifactRowForChallenge(challenge: Challenge): Promise<DecisionArtifactRow | undefined> {
  const synthesis = await getLatestSynthesis(challenge.id);
  if (!synthesis) return undefined;
  return {
    challenge,
    synthesis,
    contributions: await listContributions(challenge.id),
  };
}
