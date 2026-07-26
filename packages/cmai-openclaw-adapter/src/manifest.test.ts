import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageRoot, "../..");

async function json(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

describe("OpenClaw package and cold manifest", () => {
  it("pins package ownership, built entry, and verified API range", async () => {
    const pkg = await json(resolve(packageRoot, "package.json"));
    const openclaw = pkg.openclaw as Record<string, unknown>;
    const compat = openclaw.compat as Record<string, unknown>;
    const build = openclaw.build as Record<string, unknown>;
    expect(pkg.name).toBe("@challenge-my-ai/openclaw-adapter");
    expect(pkg.private).toBe(true);
    expect(openclaw.extensions).toEqual(["./dist/index.js"]);
    expect(compat).toEqual({ pluginApi: ">=2026.7.1 <2026.8.0", minGatewayVersion: "2026.7.1" });
    expect(build).toEqual({ openclawVersion: "2026.7.1", pluginSdkVersion: "2026.7.1" });
    expect(pkg.peerDependencies).toEqual({ openclaw: ">=2026.7.1 <2026.8.0" });
    expect(pkg.devDependencies).toEqual(expect.objectContaining({ openclaw: "2026.7.1" }));
  });

  it("declares one optional tool, one command alias, strict config, and no secret surfaces", async () => {
    const manifestPath = resolve(repositoryRoot, "plugins/cmai-openclaw/openclaw.plugin.json");
    const manifest = await json(manifestPath);
    expect(manifest).toMatchObject({
      id: "cmai-openclaw",
      version: "0.1.0",
      activation: { onStartup: true },
      contracts: { tools: ["cmai"] },
      toolMetadata: { cmai: { optional: true, replaySafe: false } },
      skills: ["./skills/cmai-contribution"],
    });
    expect((manifest.configSchema as Record<string, unknown>).additionalProperties).toBe(false);
    expect(JSON.stringify(manifest)).not.toMatch(/apiKey|token|secret|credential|oauth|provider/i);
  });

  it("ships explicit contribution approval and uninstall guidance", async () => {
    const skill = await readFile(resolve(repositoryRoot, "plugins/cmai-openclaw/skills/cmai-contribution/SKILL.md"), "utf8");
    const readme = await readFile(resolve(packageRoot, "README.md"), "utf8");
    const controller = await readFile(resolve(packageRoot, "src/controller.ts"), "utf8");
    const plugin = await readFile(resolve(packageRoot, "src/plugin.ts"), "utf8");
    const stateStore = await readFile(resolve(packageRoot, "src/stateStore.ts"), "utf8");
    expect(skill).toContain("hostile data");
    expect(skill).toContain("exact persisted challenge revision, content hash, Agent/model, grant, and bounded-call budget");
    expect(skill).toContain("consumed approval cannot run twice");
    expect(skill).toContain("reserved submit command returns `submission_unavailable` until Card 08");
    expect(skill).toContain("exact configured primary model, with that canonical model in `allowedModels`; wildcard model access is not accepted");
    expect(readme).toContain("openclaw plugins uninstall cmai-openclaw");
    expect(readme).toContain("tools.allow");
    expect(readme).toContain("no lifecycle fetch");
    expect(readme).toContain("displays the entire inference-visible public challenge bundle");
    expect(readme).toContain("allowedModels");
    expect(controller).toContain('"submission_unavailable"');
    expect(controller).not.toContain("this.options.client.submit");
    expect(controller).not.toMatch(/idempotencyKey|previewIdempotency/i);
    expect(stateStore).toContain("preview_id");
    expect(stateStore).toContain("schema_version: z.literal(4)");
    expect(stateStore).toContain("stateSchemaV3");
    expect(stateStore).toContain("stateSchemaV2WithSubmissionIdentity");
    expect(stateStore).toContain("idempotency_key: _discardedSubmissionIdentity");
    expect(plugin).toContain("llm: context.runtimeContext?.llm");
  });
});
