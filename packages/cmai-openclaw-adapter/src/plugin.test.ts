import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  OpenClawPluginApi,
  OpenClawPluginCommandDefinition,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "openclaw/plugin-sdk/plugin-entry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCmaiOpenClawPlugin } from "./plugin";

type Action = (...args: unknown[]) => unknown;
type OpenClawPluginCliRegistrar = Parameters<OpenClawPluginApi["registerCli"]>[0];
class FakeCommand {
  readonly children = new Map<string, FakeCommand>();
  actionHandler?: Action;

  command(rawName: string): FakeCommand {
    const name = rawName.split(/[ <[]/, 1)[0]!;
    const child = new FakeCommand();
    this.children.set(name, child);
    return child;
  }

  description(_text: string): this { return this; }
  argument(_syntax: string): this { return this; }
  action(handler: Action): this { this.actionHandler = handler; return this; }
}

const cleanup: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function harness(pluginConfig: Record<string, unknown> = {}) {
  const stateRoot = await mkdtemp(join(tmpdir(), "cmai-openclaw-plugin-"));
  cleanup.push(stateRoot);
  let command: OpenClawPluginCommandDefinition | undefined;
  let cli: OpenClawPluginCliRegistrar | undefined;
  let cliOptions: unknown;
  let toolFactory: OpenClawPluginToolFactory | undefined;
  let toolOptions: unknown;
  const api = {
    pluginConfig,
    runtime: {
      version: "2026.7.1",
      state: { resolveStateDir: () => stateRoot },
    },
    logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
    registerCommand: (definition: OpenClawPluginCommandDefinition) => { command = definition; },
    registerCli: (registrar: OpenClawPluginCliRegistrar, options: unknown) => { cli = registrar; cliOptions = options; },
    registerTool: (factory: OpenClawPluginToolFactory, options: unknown) => { toolFactory = factory; toolOptions = options; },
  } as unknown as OpenClawPluginApi;
  registerCmaiOpenClawPlugin(api);
  return {
    api,
    command: () => command!,
    cli: () => cli!,
    cliOptions: () => cliOptions,
    toolFactory: () => toolFactory!,
    toolOptions: () => toolOptions,
  };
}

describe("native OpenClaw plugin registration", () => {
  it("registers only bounded command, CLI, and optional tool surfaces without lifecycle work", async () => {
    const registration = await harness();
    expect(registration.command()).toMatchObject({ name: "cmai", acceptsArgs: true, requireAuth: true, exposeSenderIsOwner: true });
    expect(registration.cliOptions()).toEqual(expect.objectContaining({
      descriptors: [{ name: "cmai", description: expect.any(String), hasSubcommands: true }],
    }));
    expect(registration.toolOptions()).toEqual({ name: "cmai", optional: true });
    expect(Object.keys(registration.api).sort()).toEqual([
      "logger", "pluginConfig", "registerCli", "registerCommand", "registerTool", "runtime",
    ]);
  });

  it("keeps slash commands owner-only and reports unconfigured state without a fetch", async () => {
    const registration = await harness();
    const unauthorized = await registration.command().handler({ args: "status", senderIsOwner: false } as never);
    expect(unauthorized).toEqual({ text: "CMAI commands are owner-only. No network, model, or state action ran." });
    const status = await registration.command().handler({ args: "status", senderIsOwner: true } as never);
    expect(status.text).toContain("enabled but unconfigured");
  });

  it("registers every cmai CLI subcommand from one lazy root descriptor", async () => {
    const registration = await harness();
    const program = new FakeCommand();
    await registration.cli()({ program, parentPath: [], config: {}, logger: registration.api.logger } as never);
    const root = program.children.get("cmai");
    expect([...root!.children.keys()].sort()).toEqual([
      "discard", "feed", "pair", "preview", "revoke", "run", "status", "submit", "update",
    ]);
  });

  it("withholds the optional tool from non-owners and refuses model-selected runs or mutations", async () => {
    const registration = await harness();
    expect(registration.toolFactory()({ senderIsOwner: false } as OpenClawPluginToolContext)).toBeNull();
    const tool = registration.toolFactory()({ senderIsOwner: true } as OpenClawPluginToolContext);
    expect(tool).not.toBeNull();
    const selected = Array.isArray(tool) ? tool[0]! : tool!;
    expect(selected.name).toBe("cmai");
    const pairResult = await selected.execute("tool_1", { action: "pair", arguments: "PAIR-123456" });
    expect(pairResult.details).toEqual({ ok: false, code: "direct_user_command_required" });
    expect(pairResult.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("not human approval") });
    const runResult = await selected.execute("tool_run", { action: "run", arguments: "challenge_protocol_1" });
    expect(runResult.details).toEqual({ ok: false, code: "direct_user_command_required" });
    expect(runResult.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("/cmai run <challenge-id>") });
    const statusResult = await selected.execute("tool_2", { action: "status" });
    expect(statusResult.details).toEqual({ ok: false, code: "adapter_unconfigured" });
  });
});
