import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { POST as deviceLoginPost, maxDuration } from "@/app/api/agent-home/codex/device-login/route";
import { codexDeviceLoginProductionTimeoutMs } from "@/lib/agent-home/codexCli";
import { getAgentConnectionCredential, resetStoreForTests } from "@/lib/store";

let roots: string[] = [];

beforeEach(async () => {
  await resetStoreForTests();
});

afterEach(async () => {
  delete process.env.CMAI_CODEX_EXECUTABLE;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function installFakeCodex(delayMs = 5) {
  const root = await mkdtemp(path.join(tmpdir(), "cmai-device-route-"));
  roots.push(root);
  const executable = path.join(root, "fake-codex.mjs");
  await writeFile(executable, `
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: {} });
  if (message.method === "account/login/start") {
    send({ id: message.id, result: { type: "chatgptDeviceCode", loginId: "login_route_1", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ROUTE-1234" } });
    setTimeout(() => {
      fs.writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: { id_token: "route-id-token-fixture-123456", access_token: "route-access-token-fixture-123456", refresh_token: "route-refresh-token-fixture-123456", account_id: "acct_route_123456" },
        last_refresh: "2026-07-11T13:00:00.000Z"
      }));
      send({ method: "account/login/completed", params: { loginId: "login_route_1", success: true, error: null } });
      send({ method: "account/updated", params: { authMode: "chatgpt", planType: "plus" } });
    }, ${delayMs});
  }
});
`, "utf8");
  await chmod(executable, 0o700);
  process.env.CMAI_CODEX_EXECUTABLE = executable;
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://test.local/api/agent-home/codex/device-login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "origin": "http://test.local",
      "x-cmai-user-id": "device-route-user",
      "x-cmai-user-name": "Device Route User",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function events(response: Response) {
  return (await response.text()).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("Codex device-login API", () => {
  it("finishes with an application error before the Vercel Hobby function limit", () => {
    expect(maxDuration).toBe(300);
    expect(codexDeviceLoginProductionTimeoutMs).toBe(270_000);
    expect(codexDeviceLoginProductionTimeoutMs).toBeLessThan(maxDuration * 1_000);
  });

  it("streams device login and stores one reusable encrypted Agent Home connection", async () => {
    await installFakeCodex();
    const first = await deviceLoginPost(request({ displayLabel: "My Codex" }));
    expect(first.status).toBe(200);
    const firstEvents = await events(first);
    expect(firstEvents.map((event) => event.type)).toEqual(["device_code", "connected", "ready"]);
    expect(firstEvents[0]).toMatchObject({ verificationUrl: "https://auth.openai.com/codex/device", userCode: "ROUTE-1234" });
    const ready = firstEvents[2] as { connection: { id: string } };
    const serialized = JSON.stringify(firstEvents);
    expect(serialized).not.toContain("route-access-token-fixture");
    expect(serialized).not.toContain("route-refresh-token-fixture");
    expect(serialized).not.toContain("route-id-token-fixture");
    expect(serialized).not.toContain("login_route_1");

    const credential = await getAgentConnectionCredential({ ownerId: "device-route-user", connectionId: ready.connection.id });
    expect(credential).toMatchObject({ provider: "codex", revision: 1, value: expect.objectContaining({ auth_mode: "chatgpt" }) });

    const second = await deviceLoginPost(request({ connectionId: ready.connection.id }));
    const secondEvents = await events(second);
    const secondReady = secondEvents.at(-1) as { connection: { id: string } };
    expect(secondReady.connection.id).toBe(ready.connection.id);
    const rotated = await getAgentConnectionCredential({ ownerId: "device-route-user", connectionId: ready.connection.id });
    expect(rotated?.revision).toBe(2);
  });

  it("rejects cross-origin and unauthenticated login starts before spawning Codex", async () => {
    const crossOrigin = await deviceLoginPost(request({}, { origin: "https://attacker.example" }));
    expect(crossOrigin.status).toBe(403);
    expect(await crossOrigin.json()).toMatchObject({ code: "codex_login_origin_invalid" });

    const anonymous = await deviceLoginPost(new Request("http://test.local/api/agent-home/codex/device-login", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://test.local" },
      body: "{}",
    }));
    expect(anonymous.status).toBe(401);
  });

  it("cancels a closed response stream cleanly and allows a fresh login attempt", async () => {
    await installFakeCodex(500);
    const first = await deviceLoginPost(request({ displayLabel: "My Codex" }));
    expect(first.status).toBe(200);
    const reader = first.body?.getReader();
    expect(reader).toBeDefined();
    const firstChunk = await reader!.read();
    expect(new TextDecoder().decode(firstChunk.value)).toContain('"type":"device_code"');

    const duplicate = await deviceLoginPost(request({ displayLabel: "My Codex" }));
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: "codex_login_already_active" });

    await reader!.cancel();

    const retry = await deviceLoginPost(request({ displayLabel: "My Codex" }));
    expect(retry.status).toBe(200);
    await retry.body?.cancel();
  });
});
