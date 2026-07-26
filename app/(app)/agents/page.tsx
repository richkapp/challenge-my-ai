import { headers } from "next/headers";
import { AgentConsole } from "@/components/agent/AgentConsole";
import { requireUser } from "@/lib/auth";
import { trustedAgentRunConfigIssues, isProductionLike } from "@/lib/config/env";
import { ensureDemoAgent, ensureSeedData, listAgentActivity, listAgentProfiles, resolveAgentHome } from "@/lib/store";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const requestHeaders = new Headers(await headers());
  const user = await requireUser(new Request("http://challenge-my-ai.local/agents", { headers: requestHeaders }));
  const demoEnabled = !isProductionLike();
  const trustedRunConfigIssues = demoEnabled ? [] : trustedAgentRunConfigIssues();
  if (demoEnabled) {
    await ensureSeedData();
    await ensureDemoAgent();
  }
  return <AgentConsole agents={await listAgentProfiles()} initialActivity={await listAgentActivity(20)} agentHome={await resolveAgentHome({ ownerId: user.id, ownerLabel: user.name })} demoEnabled={demoEnabled} trustedRunConfigIssues={trustedRunConfigIssues} />;
}
