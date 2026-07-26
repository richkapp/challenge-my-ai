#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";

const HOST = "localhost";
const START_TIMEOUT_MS = Number.parseInt(process.env.CMAI_LOCAL_HTTP_SMOKE_START_TIMEOUT_MS || "90000", 10);

function localPreviewEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.DATABASE_URL;
  env.NODE_ENV = "production";
  env.CMAI_RUNTIME_ENV = "preview";
  env.CMAI_AUTH_MODE = "local";
  env.CMAI_STORE_DRIVER = "local";
  return env;
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, HOST);
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve(undefined)));
  if (!port) throw new Error("Unable to allocate a local smoke port.");
  return port;
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: options.env || process.env,
      cwd: options.cwd || process.cwd(),
    });
    child.on("exit", (code, signal) => resolve({ code: code ?? 1, signal }));
    child.on("error", (error) => {
      console.error(`[local-http-smoke] failed to start ${command}: ${error.message}`);
      resolve({ code: 1, signal: null });
    });
  });
}

function spawnServer(port) {
  const nextBin = process.platform === "win32" ? "node_modules/.bin/next.cmd" : "node_modules/.bin/next";
  const child = spawn(nextBin, ["start", "--hostname", HOST, "--port", String(port)], {
    cwd: process.cwd(),
    env: localPreviewEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout?.on("data", (chunk) => process.stdout.write(`[next-start] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[next-start] ${chunk}`));
  return child;
}

async function waitForHealth(baseUrl, server) {
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < START_TIMEOUT_MS) {
    if (server.exitCode !== null) {
      throw new Error(`next start exited before health check passed with code ${server.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/system/health`, { redirect: "manual" });
      const text = await response.text();
      if (response.ok && text.includes("publicRuntime")) return;
      lastError = `HTTP ${response.status}: ${text.slice(0, 160)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`next start did not become ready at ${baseUrl}: ${lastError}`);
}

function stopServer(child) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch { /* already stopped */ }
  }
}

async function main() {
  if (process.env.CMAI_LOCAL_HTTP_SMOKE_SKIP_BUILD !== "1") {
    console.log("[local-http-smoke] building preview/local production bundle");
    const build = await run("bun", ["run", "build"], { env: localPreviewEnv() });
    if (build.code !== 0) return build.code;
  }

  const port = process.env.CMAI_LOCAL_HTTP_SMOKE_PORT ? Number.parseInt(process.env.CMAI_LOCAL_HTTP_SMOKE_PORT, 10) : await freePort();
  if (!Number.isFinite(port) || port <= 0) throw new Error("CMAI_LOCAL_HTTP_SMOKE_PORT must be a positive integer.");
  const baseUrl = `http://${HOST}:${port}`;
  const server = spawnServer(port);
  try {
    await waitForHealth(baseUrl, server);
    console.log(`[local-http-smoke] running production challenge-loop smoke against ${baseUrl}`);
    const smoke = await run("bun", ["scripts/smoke-production-challenge-loop.ts", baseUrl], { env: localPreviewEnv() });
    return smoke.code;
  } finally {
    stopServer(server);
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    console.error(JSON.stringify({ ok: false, code: "LOCAL_HTTP_CHALLENGE_LOOP_SMOKE_FAILED", reason: error instanceof Error ? error.message : String(error) }, null, 2));
    process.exitCode = 1;
  });
