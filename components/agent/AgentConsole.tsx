"use client";

import { useState } from "react";
import type { AgentActivity, AgentHome, AgentProfile } from "@/lib/types";
import { AgentActivityFeed } from "@/components/agent/AgentActivityFeed";
import { AgentHomePanel } from "@/components/agent/AgentHomePanel";

const feedExample = `curl -s https://your-domain.test/api/agent/feed \\
  -H 'x-cmai-agent-id: agent-redteam-demo' \\
  -H 'x-cmai-agent-label: Red-Team Demo Agent'`;

const watchExample = `curl -s https://your-domain.test/api/agent/watch \\
  -X POST \\
  -H 'content-type: application/json' \\
  -H 'x-cmai-agent-id: agent-redteam-demo' \\
  -d '{"challengeId":"<challenge-id>"}'`;

export function AgentConsole({ agents, initialActivity, agentHome, demoEnabled = true, trustedRunConfigIssues = [] }: { agents: AgentProfile[]; initialActivity: AgentActivity[]; agentHome: AgentHome; demoEnabled?: boolean; trustedRunConfigIssues?: string[] }) {
  const [agentsState, setAgentsState] = useState(agents);
  const [activity, setActivity] = useState(initialActivity);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("Demo Agent is idle.");

  async function runDemoAgent() {
    setRunning(true);
    setMessage("Running deterministic local Agent...");
    try {
      const response = await fetch("/api/agent/demo-run", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Agent run failed");
      setActivity(data.activity || []);
      if (data.agents) setAgentsState(data.agents);
      setMessage(data.reusedContribution ? "Demo Agent reused its contribution and logged a fresh run." : "Demo Agent submitted a perspective.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Agent run failed");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div>
      <AgentHomePanel agentHome={agentHome} devConnectionEnabled={demoEnabled} trustedRunConfigIssues={trustedRunConfigIssues} />

      <details className="disclosure border-t border-zinc-300 py-8">
        <summary>Developer tools</summary>
        <div className="space-y-8">
          <section>
            <h2 className="text-xl font-black">Local demo</h2>
            {demoEnabled ? (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <button className="btn" onClick={runDemoAgent} disabled={running}>{running ? "Running..." : "Run demo Agent"}</button>
                <p className="text-sm font-bold text-zinc-600">{message}</p>
              </div>
            ) : <p className="mt-3 text-sm text-zinc-600">Local demo Agents are hidden in production.</p>}
          </section>

          <section className="border-t border-zinc-300 pt-6">
            <div className="flex items-center justify-between gap-3"><h2 className="text-xl font-black">Registered Agents</h2><span className="badge">{agentsState.length}</span></div>
            <div className="mt-4 border-t border-zinc-200">
              {agentsState.map((agent) => (
                <article key={agent.id} className="border-b border-zinc-200 py-4">
                  <div className="flex flex-wrap gap-2"><span className="badge">{agent.status}</span><span className="badge">{agent.contributionCount} contributions</span><span className="badge">{agent.watchCount} watches</span></div>
                  <h3 className="mt-3 font-black">{agent.label}</h3>
                  <p className="mt-1 text-sm text-zinc-600">{agent.description}</p>
                </article>
              ))}
            </div>
          </section>

          <details className="disclosure border-t border-zinc-300 pt-6">
            <summary>Terminal/API shape</summary>
            <pre className="max-w-full overflow-x-auto rounded-lg bg-black p-4 text-xs text-white"><code className="whitespace-pre-wrap break-all">{feedExample}</code></pre>
            <pre className="mt-3 max-w-full overflow-x-auto rounded-lg bg-black p-4 text-xs text-white"><code className="whitespace-pre-wrap break-all">{watchExample}</code></pre>
          </details>

          <AgentActivityFeed activity={activity} />
        </div>
      </details>
    </div>
  );
}
