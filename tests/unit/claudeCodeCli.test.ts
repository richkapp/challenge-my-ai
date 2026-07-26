import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  claudeAuthorizationUrl,
  claudeCodeProcessEnv,
  resolveClaudeCodeCommand,
  runClaudeCodeLogin,
  runClaudeCodeSession,
} from "@/lib/agent-home/claudeCodeCli";
import {
  claudeCodeCredentialPublicMetadata,
  parseClaudeCodeCredential,
  parseClaudeCodeCredentialSecret,
} from "@/lib/agent-home/claudeCodeSession";

const originalExecutable = process.env.CMAI_CLAUDE_CODE_EXECUTABLE;
const originalVercel = process.env.VERCEL;
const originalDatabaseUrl = process.env.DATABASE_URL;

const credential = {
  claudeAiOauth: {
    accessToken: "access-token-fixture-value",
    refreshToken: "refresh-token-fixture-value",
    expiresAt: Date.parse("2030-01-01T00:00:00.000Z"),
    scopes: ["user:inference"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
  },
};

afterEach(() => {
  if (originalExecutable === undefined) delete process.env.CMAI_CLAUDE_CODE_EXECUTABLE;
  else process.env.CMAI_CLAUDE_CODE_EXECUTABLE = originalExecutable;
  if (originalVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = originalVercel;
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

async function fakeCli(source: string) {
  const root = await mkdtemp(path.join(tmpdir(), "cmai-fake-claude-"));
  const file = path.join(root, "claude.cjs");
  await writeFile(file, `#!/usr/bin/env node\n${source}\n`, { mode: 0o755 });
  return { root, file };
}

describe("Claude Code managed credential", () => {
  it("validates the official managed credential shape and exposes only public metadata", () => {
    expect(parseClaudeCodeCredential(credential)).toMatchObject(credential);
    expect(claudeCodeCredentialPublicMetadata(credential)).toEqual({
      auth_mode: "claude_subscription",
      expires_at: "2030-01-01T00:00:00.000Z",
      subscription_type: "max",
      rate_limit_tier: "default_claude_max_20x",
    });
  });

  it("rejects pasted API keys, bearer values, setup tokens, and malformed JSON", () => {
    expect(() => parseClaudeCodeCredentialSecret("sk-ant-api03-not-accepted")).toThrow(/official CLI-managed login/);
    expect(() => parseClaudeCodeCredentialSecret("Bearer not-accepted")).toThrow(/official CLI-managed login/);
    expect(() => parseClaudeCodeCredentialSecret("sk-ant-oat-not-accepted")).toThrow(/official CLI-managed login/);
    expect(() => parseClaudeCodeCredentialSecret("not-json")).toThrow(/JSON object/);
    expect(() => parseClaudeCodeCredential({ claudeAiOauth: { ...credential.claudeAiOauth, expiresAt: Number.MAX_SAFE_INTEGER } })).toThrow(/failed validation/);
  });
});

describe("Claude Code CLI isolation", () => {
  it("allowlists only the official Claude authorization URL", () => {
    expect(claudeAuthorizationUrl("https://claude.com/cai/oauth/authorize?code=true")).toBe("https://claude.com/cai/oauth/authorize?code=true");
    expect(claudeAuthorizationUrl("https://claude.com.evil.test/cai/oauth/authorize?code=true")).toBeUndefined();
    expect(claudeAuthorizationUrl("javascript:alert(1)")).toBeUndefined();
  });

  it("does not pass deployment secrets into the subprocess environment", () => {
    process.env.DATABASE_URL = "postgres://sensitive.example/db";
    const env = claudeCodeProcessEnv("/tmp/isolated-claude");
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.HOME).toBe("/tmp/isolated-claude");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/tmp/isolated-claude");
  });

  it("uses a configured executable and the traced Vercel Linux binary", () => {
    process.env.CMAI_CLAUDE_CODE_EXECUTABLE = "/tmp/fake-claude";
    expect(resolveClaudeCodeCommand()).toEqual({ command: "/tmp/fake-claude", prefixArgs: [] });
    delete process.env.CMAI_CLAUDE_CODE_EXECUTABLE;
    delete process.env.VERCEL;
    expect(resolveClaudeCodeCommand().command).toBe("claude");
    process.env.VERCEL = "1";
    expect(resolveClaudeCodeCommand().command).toBe("/var/task/node_modules/@anthropic-ai/claude-code-linux-x64/claude");
  });

  it("completes official CLI login through a one-time code callback", async () => {
    const fake = await fakeCli(`
const fs = require("node:fs");
const path = require("node:path");
process.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=fake\\nPaste code here if prompted > ");
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk.toString();
  if (!input.includes("\\n")) return;
  if (input.trim() !== "one-time-code#state") process.exit(2);
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"), JSON.stringify(${JSON.stringify(credential)}), { mode: 0o600 });
  process.stdout.write("Login successful\\n");
  process.exit(0);
});`);
    process.env.CMAI_CLAUDE_CODE_EXECUTABLE = fake.file;
    const events: unknown[] = [];
    try {
      const result = await runClaudeCodeLogin({
        timeoutMs: 5_000,
        onEvent: (event) => { events.push(event); },
        getAuthorizationCode: async () => "one-time-code#state",
      });
      expect(events).toEqual([{ type: "authorization_url", authorizationUrl: "https://claude.com/cai/oauth/authorize?state=fake" }]);
      expect(result.credential).toMatchObject(credential);
    } finally {
      await rm(fake.root, { recursive: true, force: true });
    }
  });

  it("maps structured stdout login failures to reconnect-required", async () => {
    const fake = await fakeCli(`
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" }));
  process.exit(1);
});`);
    process.env.CMAI_CLAUDE_CODE_EXECUTABLE = fake.file;
    try {
      await expect(runClaudeCodeSession({ credential, model: "sonnet", prompt: "safe prompt", timeoutMs: 5_000 })).rejects.toMatchObject({
        code: "CLAUDE_CODE_AUTH_REQUIRED",
        status: 401,
      });
    } finally {
      await rm(fake.root, { recursive: true, force: true });
    }
  });

  it("does not misclassify ordinary token-limit failures as expired authentication", async () => {
    const fake = await fakeCli(`
process.stdin.resume();
process.stdin.on("end", () => {
  process.stderr.write("Maximum output token limit exceeded.");
  process.exit(1);
});`);
    process.env.CMAI_CLAUDE_CODE_EXECUTABLE = fake.file;
    try {
      await expect(runClaudeCodeSession({ credential, model: "sonnet", prompt: "safe prompt", timeoutMs: 5_000 })).rejects.toMatchObject({
        code: "CLAUDE_CODE_EXECUTION_FAILED",
        status: 502,
      });
    } finally {
      await rm(fake.root, { recursive: true, force: true });
    }
  });

  it("waits for forced process-tree teardown before returning a timeout", async () => {
    const fake = await fakeCli(`
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
fs.writeFileSync(path.join(__dirname, "pid"), String(process.pid));
const grandchild = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
fs.writeFileSync(path.join(__dirname, "grandchild-pid"), String(grandchild.pid));
process.on("SIGTERM", () => {});
process.stdin.resume();
setInterval(() => {}, 1000);`);
    process.env.CMAI_CLAUDE_CODE_EXECUTABLE = fake.file;
    const startedAt = Date.now();
    try {
      await expect(runClaudeCodeSession({ credential, model: "sonnet", prompt: "safe prompt", timeoutMs: 1_000 })).rejects.toMatchObject({
        code: "CLAUDE_CODE_EXECUTION_TIMEOUT",
        status: 504,
      });
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_650);
      const pid = Number(await readFile(path.join(fake.root, "pid"), "utf8"));
      const grandchildPid = Number(await readFile(path.join(fake.root, "grandchild-pid"), "utf8"));
      expect(() => process.kill(pid, 0)).toThrow();
      expect(() => process.kill(grandchildPid, 0)).toThrow();
    } finally {
      await rm(fake.root, { recursive: true, force: true });
    }
  });

  it("runs the official CLI in isolated print mode and captures refreshed credentials", async () => {
    const refreshed = {
      claudeAiOauth: {
        ...credential.claudeAiOauth,
        accessToken: "access-token-refreshed-value",
        refreshToken: "refresh-token-refreshed-value",
      },
    };
    const fake = await fakeCli(`
const fs = require("node:fs");
const path = require("node:path");
if (process.env.DATABASE_URL) process.exit(5);
const args = process.argv.slice(2);
for (const required of ["-p", "--output-format", "--no-session-persistence", "--strict-mcp-config", "--disable-slash-commands", "--no-chrome", "--model"]) {
  if (!args.includes(required)) process.exit(6);
}
let prompt = "";
process.stdin.on("data", (chunk) => { prompt += chunk.toString(); });
process.stdin.on("end", () => {
  if (prompt !== "safe prompt") process.exit(7);
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"), JSON.stringify(${JSON.stringify(refreshed)}), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ type: "result", result: "{\\\"schema_version\\\":\\\"1.0\\\"}", is_error: false, modelUsage: { "claude-sonnet-4-6": { inputTokens: 1 } } }));
});`);
    process.env.CMAI_CLAUDE_CODE_EXECUTABLE = fake.file;
    process.env.DATABASE_URL = "postgres://must-not-leak.example/db";
    try {
      const result = await runClaudeCodeSession({ credential, model: "claude-sonnet-4-6", prompt: "safe prompt", timeoutMs: 5_000 });
      expect(result.content).toBe('{"schema_version":"1.0"}');
      expect(result.returnedModel).toBe("claude-sonnet-4-6");
      expect(result.refreshedCredential).toMatchObject(refreshed);
      expect(await readFile(fake.file, "utf8")).not.toContain("postgres://must-not-leak.example/db");
    } finally {
      await rm(fake.root, { recursive: true, force: true });
    }
  });
});
