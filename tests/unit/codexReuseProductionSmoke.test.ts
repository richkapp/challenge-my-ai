import { describe, expect, it } from "vitest";
import { railwayCliPath, runCodexReuseProductionProof } from "../../scripts/smoke-codex-reuse-production";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

function signupResponse() {
  const headers = new Headers({ location: "/lobby" });
  headers.append("set-cookie", "cmai_session=fixture-session; Path=/; HttpOnly; SameSite=Lax");
  headers.append("set-cookie", "cmai_csrf=fixture-csrf; Path=/; SameSite=Lax");
  return new Response("", { status: 303, headers });
}

function deviceStream() {
  const encoder = new TextEncoder();
  const lines = [
    { type: "device_code", verificationUrl: "https://auth.openai.com/codex/device", userCode: "ABCD-EFGH" },
    { type: "connected", planType: "plus" },
    { type: "ready", connection: { id: "conn-codex", status: "ready" }, agentHome: { readiness: { canRunHere: true } } },
  ];
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(lines.map((line) => JSON.stringify(line)).join("\n") + "\n")); controller.close(); } }), { status: 200, headers: { "content-type": "application/x-ndjson" } });
}

describe("production Codex reuse proof harness", () => {
  it("supports an absolute Railway CLI path under a sanitized proof environment", () => {
    expect(railwayCliPath({})).toBe("railway");
    expect(railwayCliPath({ CMAI_RAILWAY_CLI_PATH: "/opt/railway/bin/railway" })).toBe("/opt/railway/bin/railway");
    expect(() => railwayCliPath({ CMAI_RAILWAY_CLI_PATH: "./railway" })).toThrow("must be an absolute path");
  });

  it("fails closed before network mutation without the explicit mutation guard", async () => {
    const output: string[] = [];
    let requests = 0;
    const code = await runCodexReuseProductionProof({
      baseUrl: "https://challenge-my-ai.vercel.app",
      env: { CMAI_SMOKE_CLEANUP_MODE: "moderator_suppress" },
      fetch: async () => { requests += 1; throw new Error("should not fetch"); },
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
    });
    expect(code).toBe(1);
    expect(requests).toBe(0);
    expect(output.join("\n")).toContain("CMAI_SMOKE_ALLOW_MUTATION=1");
  });

  it("records one device login, two fresh approvals, and distinct receipt/sandbox proof before cleanup", async () => {
    const output: string[] = [];
    const requests: Array<{ path: string; method: string; body: string }> = [];
    let challengeCount = 0;
    let approvedRunCount = 0;
    const fetcher = async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = String(init.method || "GET").toUpperCase();
      const body = typeof init.body === "string" ? init.body : "";
      requests.push({ path: url.pathname, method, body });
      if (url.pathname === "/api/system/health") return json({ ok: true, productionReady: true });
      if (url.pathname === "/api/auth/signup") return signupResponse();
      if (url.pathname === "/api/challenges" && method === "POST") {
        challengeCount += 1;
        return json({ challenge: { id: `challenge-${challengeCount}` } }, 201);
      }
      if (url.pathname === "/api/agent-home/codex/device-login") return deviceStream();
      if (url.pathname === "/api/agent-home" && method === "GET") return json({ agentHome: { connections: [{ id: "conn-codex", status: "ready", readiness: { canRunHere: true } }] } });
      if (/^\/api\/challenges\/challenge-[12]\/agent-runs$/.test(url.pathname)) {
        const parsed = JSON.parse(body) as { approved?: boolean };
        if (parsed.approved !== true) return json({ code: "approval_required" }, 400);
        approvedRunCount += 1;
        return json({ run: {
          id: `run-${approvedRunCount}`,
          status: "contributed",
          contributionId: `contribution-${approvedRunCount}`,
          receiptSummary: {
            receiptId: `receipt-${approvedRunCount}`,
            receiptSha256: String(approvedRunCount).repeat(64),
            sandboxId: `sandbox-${approvedRunCount}`,
          },
        } });
      }
      if (url.pathname === "/api/agent-home/connections/conn-codex" && method === "PATCH") return json({ connection: { id: "conn-codex", status: "revoked" } });
      if (url.pathname === "/api/moderation/actions" && method === "POST") return json({ ok: true });
      if (/^\/challenges\/challenge-[12]$/.test(url.pathname)) return new Response("Not found", { status: 404 });
      if (/^\/api\/answers\/challenge-[12]\/artifact$/.test(url.pathname)) return new Response("Not found", { status: 404 });
      if (/^\/answers\/challenge-[12]$/.test(url.pathname)) return new Response("Not found", { status: 404 });
      if (url.pathname === "/api/answers") return json({ artifacts: [] });
      return json({ code: "unexpected", path: url.pathname, method }, 500);
    };

    const code = await runCodexReuseProductionProof({
      baseUrl: "https://challenge-my-ai.vercel.app",
      smokeId: "codex-reuse-unit",
      env: {
        CMAI_SMOKE_ALLOW_MUTATION: "1",
        CMAI_SMOKE_CLEANUP_MODE: "moderator_suppress",
        CMAI_SMOKE_MODERATOR_EMAIL: "moderator@example.com",
        CMAI_SMOKE_MODERATOR_PASSWORD: "fixture-password",
      },
      fetch: fetcher,
      listActiveSandboxIds: async () => [],
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
    });

    expect(code).toBe(0);
    const deviceLines = output.filter((line) => line.includes("CODEX_DEVICE_CODE"));
    expect(deviceLines).toHaveLength(1);
    const summary = JSON.parse(output.find((line) => line.includes("production_codex_reuse_proof")) || "{}") as Record<string, unknown>;
    expect(summary).toMatchObject({ authentication_events: 1, same_connection_ready_between_runs: true, fresh_approval_per_challenge: true, no_second_oauth: true });
    expect(approvedRunCount).toBe(2);
    expect(requests.filter((request) => request.path === "/api/agent-home/codex/device-login")).toHaveLength(1);
    expect(requests.filter((request) => request.path === "/api/moderation/actions")).toHaveLength(2);
    expect(requests.some((request) => request.method === "PATCH" && request.path.endsWith("/conn-codex"))).toBe(true);
  });
});
