import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDirectory, "..");
const repositoryRoot = resolve(packageRoot, "../..");
const pluginSource = join(repositoryRoot, "plugins/cmai-hermes");
const workerSource = join(packageRoot, "src/worker.ts");

function outputArgument(): string {
  const index = process.argv.indexOf("--out-dir");
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) throw new Error("Usage: bun scripts/stage-local.ts --out-dir /absolute/disposable/path");
  if (!isAbsolute(value)) throw new Error("--out-dir must be absolute.");
  const output = resolve(value);
  const fromRepository = relative(repositoryRoot, output);
  if (!fromRepository.startsWith("..") && fromRepository !== "") {
    throw new Error("This scaffold stages only outside the repository; use a disposable absolute path.");
  }
  return output;
}

async function copyDirectory(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (["tests", "__pycache__", "runtime", ".pytest_cache", ".mypy_cache", ".ruff_cache"].includes(entry.name) || entry.name.endsWith(".pyc")) continue;
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) await copyDirectory(sourcePath, destinationPath);
    else if (entry.isFile()) await copyFile(sourcePath, destinationPath);
  }
}

async function listFiles(root: string, current = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, path));
    else if (entry.isFile()) files.push(relative(root, path));
  }
  return files.sort();
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function main(): Promise<void> {
  const output = outputArgument();
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true, mode: 0o755 });
  await copyDirectory(pluginSource, output);
  const runtimeDirectory = join(output, "runtime");
  await mkdir(runtimeDirectory, { recursive: true });
  const workerOutput = join(runtimeDirectory, "worker.js");
  const build = spawnSync(process.execPath, ["build", workerSource, "--target=bun", "--outfile", workerOutput], {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (build.status !== 0 || !(await stat(workerOutput)).isFile()) {
    throw new Error(`Bun worker build failed (${build.status ?? "signal"}).`);
  }

  const files = await listFiles(output);
  const entries = await Promise.all(files.map(async (path) => ({ path, sha256: await sha256(join(output, path)) })));
  const manifest = {
    schema_version: 1,
    package: "@challenge-my-ai/hermes-adapter",
    version: "0.1.0",
    distribution: "private_local_only",
    hermes_supported: ">=0.18.2 <0.20.0",
    bun_verified: ">=1.3.0 <2",
    files: entries,
  };
  await writeFile(join(output, "artifact-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${output}\n`);
}

await main();
