import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveCodexCommand, runCodexDeviceLogin } from "@/lib/agent-home/codexCli";

const authCache = {
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: {
    id_token: "codex-id-token-device-fixture-123456",
    access_token: "codex-access-token-device-fixture-123456",
    refresh_token: "codex-refresh-token-device-fixture-123456",
    account_id: "acct_device_fixture_123456",
  },
  last_refresh: "2026-07-11T12:00:00.000Z",
};

let tempRoots: string[] = [];

afterEach(async () => {
  delete process.env.CMAI_CODEX_EXECUTABLE;
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fakeAppServer(options: { fail?: boolean; delayMs?: number; verificationUrl?: string; oversizedLine?: boolean } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "cmai-codex-device-test-"));
  tempRoots.push(root);
  const executable = path.join(root, "fake-codex.mjs");
  const source = `
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    ${options.oversizedLine ? `process.stdout.write("x".repeat(1_000_001)); return;` : ""}
    send({ id: message.id, result: { userAgent: "fake-codex" } });
    return;
  }
  if (message.method === "account/login/start") {
    send({ id: message.id, result: { type: "chatgptDeviceCode", loginId: "login_device_1", verificationUrl: ${JSON.stringify(options.verificationUrl || "https://auth.openai.com/codex/device")}, userCode: "ABCD-1234" } });
    setTimeout(() => {
      ${options.fail ? `process.stderr.write("refresh_token=codex-refresh-token-device-fixture-123456\\n"); send({ method: "account/login/completed", params: { loginId: "login_device_1", success: false, error: "authorization denied refresh_token=codex-refresh-token-device-fixture-123456" } }); process.exit(4);` : `fs.writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), JSON.stringify(${JSON.stringify(authCache)})); send({ method: "account/updated", params: { authMode: "chatgpt", planType: "plus" } }); send({ method: "account/login/completed", params: { loginId: "login_device_1", success: true, error: null } }); setTimeout(() => process.exit(0), 5);`}
    }, ${options.delayMs || 5});
  }
  if (message.method === "account/login/cancel") {
    send({ id: message.id, result: {} });
    process.exit(0);
  }
});
`;
  await writeFile(executable, source, "utf8");
  await chmod(executable, 0o700);
  process.env.CMAI_CODEX_EXECUTABLE = executable;
  return executable;
}

describe("Codex app-server device login", () => {
  it("uses the traced native Linux binary without runtime package resolution", () => {
    if (process.platform !== "linux" || process.arch !== "x64") return;
    const previousVercel = process.env.VERCEL;
    delete process.env.CMAI_CODEX_EXECUTABLE;
    delete process.env.CMAI_CODEX_CLI_BIN;
    try {
      process.env.VERCEL = "1";
      const resolved = resolveCodexCommand();
      expect(resolved.command).toBe("/var/task/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex");
      expect(resolved.prefixArgs).toEqual([]);
    } finally {
      if (previousVercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = previousVercel;
    }
  });

  it("returns the official verification ceremony and a validated managed auth cache", async () => {
    await fakeAppServer();
    const events: unknown[] = [];
    const result = await runCodexDeviceLogin({ onEvent: (event) => { events.push(event); }, timeoutMs: 2_000 });

    expect(events).toEqual([
      { type: "device_code", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-1234" },
      { type: "connected", planType: "plus" },
    ]);
    expect(JSON.stringify(events)).not.toContain("login_device_1");
    expect(result.authCache).toMatchObject({ auth_mode: "chatgpt", last_refresh: "2026-07-11T12:00:00.000Z" });
    expect(result.planType).toBe("plus");
    expect(JSON.stringify(events)).not.toContain("codex-access-token-device-fixture");
    expect(JSON.stringify(events)).not.toContain("codex-refresh-token-device-fixture");
  });

  it("fails with a stable redacted error when app-server rejects login", async () => {
    await fakeAppServer({ fail: true });
    await expect(runCodexDeviceLogin({ timeoutMs: 2_000 })).rejects.toMatchObject({ code: "CODEX_DEVICE_LOGIN_FAILED" });
    try {
      await runCodexDeviceLogin({ timeoutMs: 2_000 });
    } catch (error) {
      expect(String(error)).not.toContain("codex-refresh-token-device-fixture");
      expect(String(error)).not.toContain("authorization denied");
    }
  });

  it("rejects non-OpenAI or non-HTTPS verification URLs before exposing them", async () => {
    await fakeAppServer({ verificationUrl: "javascript:alert(1)" });
    await expect(runCodexDeviceLogin({ timeoutMs: 2_000 })).rejects.toMatchObject({ code: "CODEX_DEVICE_LOGIN_PROTOCOL_INVALID" });
  });

  it("kills an app-server that emits an oversized unterminated protocol line", async () => {
    await fakeAppServer({ oversizedLine: true });
    await expect(runCodexDeviceLogin({ timeoutMs: 2_000 })).rejects.toMatchObject({ code: "CODEX_DEVICE_LOGIN_PROTOCOL_TOO_LARGE" });
  });

  it("cancels the official login attempt when the caller aborts", async () => {
    await fakeAppServer({ delayMs: 500 });
    const controller = new AbortController();
    const events: unknown[] = [];
    const promise = runCodexDeviceLogin({ signal: controller.signal, onEvent: (event) => {
      events.push(event);
      if (event.type === "device_code") controller.abort();
    }, timeoutMs: 2_000 });

    await expect(promise).rejects.toMatchObject({ code: "CODEX_DEVICE_LOGIN_CANCELLED" });
    expect(events).toHaveLength(1);
  });
});
