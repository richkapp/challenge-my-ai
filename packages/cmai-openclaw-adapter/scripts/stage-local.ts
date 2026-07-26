import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = resolve(import.meta.dirname, "..");
const repositoryRoot = resolve(packageRoot, "../..");
const pluginAssets = join(repositoryRoot, "plugins", "cmai-openclaw");
const outputRoot = resolve(process.env.CMAI_OPENCLAW_STAGE_DIR || "/tmp/cmai-openclaw-adapter");
const distDirectory = join(outputRoot, "dist");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(distDirectory, { recursive: true });

const build = spawnSync("bun", [
  "build", join(packageRoot, "src", "plugin.ts"),
  "--target=node", "--format=esm", "--external=openclaw/*",
  `--outfile=${join(distDirectory, "index.js")}`,
], {
  cwd: repositoryRoot,
  stdio: "inherit",
  env: {
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    NODE_ENV: process.env.NODE_ENV || "production",
  },
});
if (build.status !== 0) throw new Error("CMAI OpenClaw local build failed.");

const sourcePackage = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
const stagedPackage = {
  ...sourcePackage,
  main: "./dist/index.js",
  exports: { ".": "./dist/index.js" },
  scripts: undefined,
  devDependencies: undefined,
};
await writeFile(join(outputRoot, "package.json"), `${JSON.stringify(stagedPackage, null, 2)}\n`, "utf8");
await cp(join(pluginAssets, "openclaw.plugin.json"), join(outputRoot, "openclaw.plugin.json"));
await cp(join(pluginAssets, "skills"), join(outputRoot, "skills"), { recursive: true });
await cp(join(packageRoot, "README.md"), join(outputRoot, "README.md"));

const compiledEntry = await readFile(join(distDirectory, "index.js"), "utf8");
if (!compiledEntry.includes("cmai-openclaw") || compiledEntry.length < 1_000) {
  throw new Error("Staged CMAI OpenClaw plugin entry is invalid.");
}

const dependencyLink = join(outputRoot, "node_modules");
await symlink(join(packageRoot, "node_modules"), dependencyLink, "dir");
const registrations = { commands: 0, tools: 0, cli: 0 };
try {
  const staged = await import(`${pathToFileURL(join(distDirectory, "index.js")).href}?verify=${Date.now()}`);
  staged.default.register({
    pluginConfig: { baseUrl: "https://example.invalid", displayName: "Stage verifier" },
    runtime: { version: "2026.7.1", state: { resolveStateDir: () => join(outputRoot, ".verify-state") } },
    registerCommand: () => { registrations.commands += 1; },
    registerTool: () => { registrations.tools += 1; },
    registerCli: () => { registrations.cli += 1; },
  });
} finally {
  await rm(dependencyLink, { force: true });
}
if (registrations.commands !== 1 || registrations.tools !== 1 || registrations.cli !== 1) {
  throw new Error(`Staged CMAI OpenClaw plugin registration failed: ${JSON.stringify(registrations)}`);
}

process.stdout.write(`${JSON.stringify({
  artifact: outputRoot,
  entry: "dist/index.js",
  plugin_id: "cmai-openclaw",
  version: sourcePackage.version,
  verified_registrations: registrations,
}, null, 2)}\n`);
