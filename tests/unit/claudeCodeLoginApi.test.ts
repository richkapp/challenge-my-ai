import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { POST as loginPost, maxDuration } from "@/app/api/agent-home/claude-code/login/route";
import { POST as codePost } from "@/app/api/agent-home/claude-code/login/code/route";
import { claudeCodeLoginProductionTimeoutMs } from "@/lib/agent-home/claudeCodeCli";
import { beginClaudeCodeLoginAttempt, getAgentConnectionCredential, releaseClaudeCodeLoginAttempt, resetStoreForTests, submitClaudeCodeLoginCode, takeClaudeCodeLoginCode } from "@/lib/store";

let roots: string[] = [];

const managedCredential = {
  claudeAiOauth: {
    accessToken: "claude-route-access-token-fixture-123456",
    refreshToken: "claude-route-refresh-token-fixture-123456",
    expiresAt: Date.parse("2030-01-01T00:00:00.000Z"),
    scopes: ["user:inference"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
  },
};

beforeEach(async () => {
  await resetStoreForTests();
});

afterEach(async () => {
  delete process.env.CMAI_CLAUDE_CODE_EXECUTABLE;
  delete process.env.CMAI_MODEL_PROXY_URL;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function installFakeClaude() {
  const root = await mkdtemp(path.join(tmpdir(), "cmai-claude-route-"));
  roots.push(root);
  const executable = path.join(root, "fake-claude.cjs");
  await writeFile(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
process.stdout.write("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=route-fixture\\nPaste code here if prompted > ");
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk.toString();
  if (!input.includes("\\n")) return;
  if (input.trim() !== "route-one-time-code#route-state") process.exit(2);
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"), JSON.stringify(${JSON.stringify(managedCredential)}), { mode: 0o600 });
  process.stdout.write("Login successful\\n");
  process.exit(0);
});
`, { mode: 0o700 });
  await chmod(executable, 0o700);
  process.env.CMAI_CLAUDE_CODE_EXECUTABLE = executable;
  process.env.CMAI_MODEL_PROXY_URL = "http://test.local/api/agent-home/model-proxy";
}

function request(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://test.local",
      "x-cmai-user-id": "claude-route-user",
      "x-cmai-user-name": "Claude Route User",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function readEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const next = await reader.read();
  expect(next.done).toBe(false);
  return JSON.parse(new TextDecoder().decode(next.value).trim()) as Record<string, unknown>;
}

async function readRemainingEvents(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  text += decoder.decode();
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("Claude Code official login API", () => {
  it("finishes with an application error before the Vercel function limit", () => {
    expect(maxDuration).toBe(300);
    expect(claudeCodeLoginProductionTimeoutMs).toBe(270_000);
    expect(claudeCodeLoginProductionTimeoutMs).toBeLessThan(maxDuration * 1_000);
  });

  it("keeps an authorization-code slot consumed after the waiting process takes it", async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    expect(await beginClaudeCodeLoginAttempt({ ownerId: "claude-route-user", attemptId: "attempt-consumed", expiresAt })).toBe(true);
    expect(await submitClaudeCodeLoginCode({ ownerId: "claude-route-user", attemptId: "attempt-consumed", code: "first-code" })).toBe(true);
    expect(await takeClaudeCodeLoginCode({ ownerId: "claude-route-user", attemptId: "attempt-consumed" })).toBe("first-code");
    expect(await submitClaudeCodeLoginCode({ ownerId: "claude-route-user", attemptId: "attempt-consumed", code: "second-code" })).toBe(false);
    expect(await takeClaudeCodeLoginCode({ ownerId: "claude-route-user", attemptId: "attempt-consumed" })).toBeUndefined();
    expect(await releaseClaudeCodeLoginAttempt({ ownerId: "claude-route-user", attemptId: "attempt-consumed" })).toBe(true);
  });

  it("hands off one encrypted code, stores managed auth, and reuses the same connection", async () => {
    await installFakeClaude();
    const first = await loginPost(request("http://test.local/api/agent-home/claude-code/login", { displayLabel: "My Claude" }));
    expect(first.status).toBe(200);
    const firstReader = first.body!.getReader();
    const authorization = await readEvent(firstReader);
    const firstAttemptId = authorization.attemptId;
    expect(typeof firstAttemptId).toBe("string");
    expect(authorization).toMatchObject({
      type: "authorization_url",
      authorizationUrl: "https://claude.com/cai/oauth/authorize?state=route-fixture",
      attemptId: expect.any(String),
    });

    const accepted = await codePost(request("http://test.local/api/agent-home/claude-code/login/code", {
      attemptId: firstAttemptId,
      authorizationCode: "route-one-time-code#route-state",
    }));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ accepted: true });

    const readyEvents = await readRemainingEvents(firstReader);
    expect(readyEvents.map((event) => event.type)).toEqual(["ready"]);
    const ready = readyEvents[0] as { connection: { id: string; provider: string; readiness: { canRunHere: boolean }; credentialPublicMetadata?: Record<string, string> } };
    expect(ready.connection).toMatchObject({ provider: "claude_code", readiness: { canRunHere: true }, credentialPublicMetadata: { auth_mode: "claude_subscription", subscription_type: "max" } });
    const serialized = JSON.stringify([authorization, ...readyEvents]);
    expect(serialized).not.toContain("claude-route-access-token-fixture");
    expect(serialized).not.toContain("claude-route-refresh-token-fixture");
    expect(serialized).not.toContain("route-one-time-code");

    const stored = await getAgentConnectionCredential({ ownerId: "claude-route-user", connectionId: ready.connection.id });
    expect(stored).toMatchObject({ provider: "claude_code", revision: 1, value: managedCredential });

    const replay = await codePost(request("http://test.local/api/agent-home/claude-code/login/code", {
      attemptId: firstAttemptId,
      authorizationCode: "route-one-time-code#route-state",
    }));
    expect(replay.status).toBe(409);

    const second = await loginPost(request("http://test.local/api/agent-home/claude-code/login", { connectionId: ready.connection.id }));
    const secondReader = second.body!.getReader();
    const secondAuthorization = await readEvent(secondReader);
    const secondAccepted = await codePost(request("http://test.local/api/agent-home/claude-code/login/code", {
      attemptId: secondAuthorization.attemptId,
      authorizationCode: "route-one-time-code#route-state",
    }));
    expect(secondAccepted.status).toBe(200);
    const secondReady = (await readRemainingEvents(secondReader))[0] as { connection: { id: string } };
    expect(secondReady.connection.id).toBe(ready.connection.id);
    const rotated = await getAgentConnectionCredential({ ownerId: "claude-route-user", connectionId: ready.connection.id });
    expect(rotated?.revision).toBe(2);
  });

  it("rejects cross-origin, wrong-owner, and duplicate login activity", async () => {
    await installFakeClaude();
    const crossOrigin = await loginPost(request("http://test.local/api/agent-home/claude-code/login", {}, { origin: "https://attacker.example" }));
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.json()).toMatchObject({ code: "claude_code_login_origin_invalid" });

    const first = await loginPost(request("http://test.local/api/agent-home/claude-code/login", {}));
    const reader = first.body!.getReader();
    const authorization = await readEvent(reader);

    const duplicate = await loginPost(request("http://test.local/api/agent-home/claude-code/login", {}));
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: "claude_code_login_already_active" });

    const wrongOwner = await codePost(request("http://test.local/api/agent-home/claude-code/login/code", {
      attemptId: authorization.attemptId,
      authorizationCode: "route-one-time-code#route-state",
    }, { "x-cmai-user-id": "different-user" }));
    expect(wrongOwner.status).toBe(409);

    await reader.cancel();
    const retry = await loginPost(request("http://test.local/api/agent-home/claude-code/login", {}));
    expect(retry.status).toBe(200);
    await retry.body?.cancel();
  });
});
