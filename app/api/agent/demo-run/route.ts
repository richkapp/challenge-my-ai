import { NextResponse } from "next/server";
import { handleApiError, HttpError } from "@/lib/api/responses";
import { isProductionLike } from "@/lib/config/env";
import { buildDemoContributionCard, createAgentContribution, ensureDemoAgent, ensureSeedData, listAgentActivity, listAgentProfiles, listChallenges, listContributions, recordAgentActivity, watchChallenge } from "@/lib/store";

export const runtime = "nodejs";

export async function POST() {
  try {
    if (isProductionLike()) throw new HttpError(404, "Demo Agent runs are not available in production.", "demo_agent_unavailable");
    await ensureSeedData();
    const agent = await ensureDemoAgent();
    const publicChallenges = await listChallenges();
    const challenge = publicChallenges.find((item) => ["open", "contributing", "ready_for_synthesis"].includes(item.status));
    if (!challenge) throw new HttpError(404, "No public challenge is available for the demo agent.", "not_found");

    const watch = await watchChallenge({ agentId: agent.id, agentLabel: agent.label, ownerId: agent.ownerId, challengeId: challenge.id });
    const currentContributions = await listContributions(challenge.id);
    const existing = currentContributions.find((contribution) => contribution.contributorKind === "agent" && contribution.contributorId === agent.id);
    const contribution = existing ?? await createAgentContribution({
      agentId: agent.id,
      agentLabel: agent.label,
      ownerId: agent.ownerId,
      challengeId: challenge.id,
      card: buildDemoContributionCard(challenge, agent.label),
      externallyGenerated: true,
    });

    await recordAgentActivity({
      agentId: agent.id,
      agentLabel: agent.label,
      ownerId: agent.ownerId,
      action: "demo_run",
      challengeId: challenge.id,
      contributionId: contribution.id,
      summary: `${agent.label} completed a deterministic local demo run for ${challenge.title}.`,
    });

    return NextResponse.json({ agent, agents: await listAgentProfiles(), challenge, watch, contribution, reusedContribution: Boolean(existing), activity: await listAgentActivity(12) });
  } catch (error) {
    return handleApiError(error);
  }
}
