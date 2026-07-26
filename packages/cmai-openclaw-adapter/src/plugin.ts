import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { CMAI_OPENCLAW_PLUGIN_ID } from "./constants";
import type { OpenClawCommandResult } from "./controller";
import { executeOpenClawCommand } from "./runtime";

const TOOL_DIRECT_ONLY = new Set(["pair", "run", "submit", "discard", "revoke"]);
const ACTIONS = ["help", "pair", "status", "feed", "run", "preview", "submit", "discard", "revoke", "update"] as const;
type CmaiAction = typeof ACTIONS[number];

function toolResult(result: OpenClawCommandResult) {
  return {
    content: [{ type: "text" as const, text: result.text }],
    details: { ok: result.ok, code: result.code },
  };
}

function directOnlyToolResult(action: CmaiAction) {
  const commandSuffix = action === "submit" || action === "revoke"
    ? " confirm"
    : action === "run"
      ? " <challenge-id>"
      : "";
  return toolResult({
    ok: false,
    code: "direct_user_command_required",
    text: `The cmai Agent tool cannot ${action}. A model-selected tool call is not human approval. Use /cmai ${action}${commandSuffix} or the local OpenClaw CLI directly. Nothing changed.`,
  });
}

async function printCliResult(api: OpenClawPluginApi, argumentsText: string): Promise<void> {
  const result = await executeOpenClawCommand(api, argumentsText);
  const output = result.ok ? api.logger.info : api.logger.error;
  output(result.text);
  if (!result.ok) process.exitCode = 1;
}

function registerCli(api: OpenClawPluginApi): void {
  api.registerCli(({ program }) => {
    const root = program.command("cmai").description("Challenge My AI paired-Agent controls");
    root.command("status").description("Show local adapter state").action(() => printCliResult(api, "status"));
    root.command("pair").description("Pair with a one-time CMAI code")
      .argument("<code>").argument("[label...]")
      .action((code: string, label: string[]) => printCliResult(api, `pair ${code} ${label.join(" ")}`.trim()));
    root.command("feed").description("List bounded public challenge summaries")
      .argument("[query...]")
      .action((query: string[]) => printCliResult(api, `feed ${query.join(" ")}`.trim()));
    root.command("run").description("Prepare or explicitly confirm one bounded Agent run")
      .argument("<challenge-id>").argument("[confirmation]").argument("[revision]")
      .action((challengeId: string, confirmation?: string, revision?: string) => (
        printCliResult(api, `run ${challengeId} ${confirmation ?? ""} ${revision ?? ""}`.trim())
      ));
    root.command("preview").description("Show the complete validated contribution card")
      .action(() => printCliResult(api, "preview"));
    root.command("submit").description("Submit only after exact confirmation")
      .argument("[confirmation]")
      .action((confirmation?: string) => printCliResult(api, `submit ${confirmation ?? ""}`.trim()));
    root.command("discard").description("Discard the local contribution preview")
      .action(() => printCliResult(api, "discard"));
    root.command("revoke").description("Revoke pairing only after exact confirmation")
      .argument("[confirmation]")
      .action((confirmation?: string) => printCliResult(api, `revoke ${confirmation ?? ""}`.trim()));
    root.command("update").description("Show pinned compatibility and manual update guidance")
      .action(() => printCliResult(api, "update"));
    root.action(() => printCliResult(api, "help"));
  }, {
    descriptors: [{ name: "cmai", description: "Challenge My AI paired-Agent controls", hasSubcommands: true }],
  });
}

export function registerCmaiOpenClawPlugin(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: "cmai",
    description: "Challenge My AI paired-Agent controls",
    acceptsArgs: true,
    requireAuth: true,
    exposeSenderIsOwner: true,
    handler: async (context) => {
      if (context.senderIsOwner !== true) {
        return { text: "CMAI commands are owner-only. No network, model, or state action ran." };
      }
      const result = await executeOpenClawCommand(api, context.args ?? "help", {
        agentId: context.agentId,
        config: context.config,
        llm: context.runtimeContext?.llm,
      });
      return { text: result.text };
    },
  });

  registerCli(api);

  api.registerTool((context) => {
    if (context.senderIsOwner !== true) return null;
    return {
      name: "cmai",
      label: "Challenge My AI",
      description: "Read CMAI status/feed/preview metadata. Pairing, run preparation, submission, discard, and revocation require a direct owner command.",
      parameters: Type.Object({
        action: Type.Union(ACTIONS.map((action) => Type.Literal(action))),
        arguments: Type.Optional(Type.String({ maxLength: 8_000 })),
      }, { additionalProperties: false }),
      execute: async (_toolCallId, rawParams) => {
        const params = rawParams as { action: CmaiAction; arguments?: string };
        if (TOOL_DIRECT_ONLY.has(params.action)) return directOnlyToolResult(params.action);
        return toolResult(await executeOpenClawCommand(api, `${params.action} ${params.arguments ?? ""}`.trim()));
      },
    };
  }, { name: "cmai", optional: true });
}

export default definePluginEntry({
  id: CMAI_OPENCLAW_PLUGIN_ID,
  name: "Challenge My AI",
  description: "Pairs OpenClaw with Challenge My AI for explicit, previewed contributions.",
  register: registerCmaiOpenClawPlugin,
});
