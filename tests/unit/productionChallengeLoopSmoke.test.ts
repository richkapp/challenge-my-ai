import { describe, expect, it } from "vitest";
import { runProductionChallengeLoopSmoke, type ProductionChallengeLoopSmokeFetch } from "../../scripts/smoke-production-challenge-loop";

type RecordedRequest = {
  url: URL;
  method: string;
  headers: Headers;
  body: RequestInit["body"];
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
}

function htmlResponse(body = "<html><body>ok</body></html>", init: ResponseInit = {}) {
  return new Response(body, {
    ...init,
    headers: { "content-type": "text/html", ...(init.headers || {}) },
  });
}

function redirectWithSession(label: string) {
  const headers = new Headers({ location: "http://test.local/lobby" });
  headers.append("set-cookie", `cmai_user_id=${label}; Path=/`);
  headers.append("set-cookie", `cmai_user_name=${label}; Path=/`);
  headers.append("set-cookie", `cmai_csrf=csrf-${label}; Path=/`);
  return new Response("", {
    status: 303,
    headers,
  });
}

function productionHealth(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    mode: "production",
    productionReady: true,
    publicRuntime: { runtimeMode: "production", authMode: "supabase", storeDriver: "postgres" },
    trustedAgentRun: {
      ready: false,
      status: "launch_blocked",
      configIssues: ["RAILWAY_API_TOKEN is required for production Agent run cells"],
      components: {
        receiptSigningConfigured: false,
        railwayRunCellsConfigured: false,
        brokerVaultConfigured: false,
        modelProxyConfigured: false,
        modelProxyGrantStore: "broker_state",
        modelProxyGrantStoreConfigured: true,
      },
      proof: {
        substrate: "unavailable",
        brokerReceipt: "unavailable",
        modelProxy: "unavailable",
        providerMetadata: "unavailable",
        providerSigned: "not_implemented",
      },
    },
    providers: { supabaseAuth: true, supabaseAdmin: true, postgresStore: true },
    missingProductionKeys: [],
    productionConfigIssues: [],
    ...overrides,
  };
}

function productionHealthTrustedReady(overrides: Record<string, unknown> = {}) {
  return productionHealth({
    trustedAgentRun: {
      ready: true,
      status: "ready",
      configIssues: [],
      components: {
        receiptSigningConfigured: true,
        railwayRunCellsConfigured: true,
        brokerVaultConfigured: true,
        modelProxyConfigured: true,
        modelProxyGrantStore: "broker_state",
        modelProxyGrantStoreConfigured: true,
      },
      proof: {
        substrate: "configured",
        brokerReceipt: "configured",
        modelProxy: "configured",
        providerMetadata: "requires_live_smoke",
        providerSigned: "not_implemented",
      },
      ...overrides,
    },
  });
}

function fakeLoopFetch(options: { trustedRequiredSuccess?: boolean; trustedPreflightReady?: boolean; artifactPageFails?: boolean; moderationForbidden?: boolean; cleanupStillVisible?: boolean } = {}) {
  const requests: RecordedRequest[] = [];
  let signupCount = 0;
  let connectionId = "conn_smoke";
  let suppressed = false;
  const nextSignupLabel = () => ["poster", "contributor", "moderator"][signupCount++] || "extra";
  const fetch: ProductionChallengeLoopSmokeFetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const method = (init.method || "GET").toUpperCase();
    const headers = new Headers(init.headers);
    requests.push({ url: parsed, method, headers, body: init.body });

    if (parsed.pathname === "/api/system/health") return jsonResponse(options.trustedPreflightReady ? productionHealthTrustedReady() : productionHealth());
    if (["/", "/lobby", "/answers"].includes(parsed.pathname)) return htmlResponse();
    if (parsed.pathname === "/challenges/new") return htmlResponse("", { status: 307, headers: { location: "https://challenge.example/login?next=%2Fchallenges%2Fnew" } });
    if (parsed.pathname === "/api/auth/signup") return redirectWithSession(nextSignupLabel());
    if (parsed.pathname === "/api/challenges" && method === "POST") return jsonResponse({ challenge: { id: "challenge_smoke", visibility: "public", status: "open" } });
    if (parsed.pathname === "/api/challenges/challenge_smoke/prompt") return jsonResponse({ prompt: "Return a fenced CMAI_CONTRIBUTION_CARD_V1 card." });
    if (parsed.pathname === "/api/challenges/challenge_smoke/contributions/parse") return jsonResponse({ card: { challenge_id: "challenge_smoke" }, mismatch: false });
    if (parsed.pathname === "/api/challenges/challenge_smoke/contributions") return jsonResponse({ contribution: { id: "contribution_manual", contributorKind: "human", card: { model_provenance: { source: "client_attested" } } } });
    if (parsed.pathname === "/api/agent-home" && method === "GET") return jsonResponse({ readiness: { status: "setup_required", canRunHere: false, manualPasteFallback: "Copy prompt → paste local output remains available." } });
    if (parsed.pathname === "/api/agent-home/connections" && method === "POST") return jsonResponse({ connection: { id: connectionId, provider: "openrouter" } }, { status: 201 });
    if (parsed.pathname === `/api/agent-home/connections/${connectionId}/smoke`) return jsonResponse({ connection: { id: connectionId, status: "ready" } });
    if (parsed.pathname === `/api/agent-home/connections/${connectionId}` && method === "PATCH") return jsonResponse({ connection: { id: connectionId, status: "revoked" } });
    if (parsed.pathname === "/api/challenges/challenge_smoke/agent-runs") {
      if (!options.trustedRequiredSuccess) return jsonResponse({ run: { status: "failed", failure: { code: "delegation_unavailable" } } });
      return jsonResponse({
        run: {
          id: "run_smoke",
          status: "contributed",
          trustLabel: "sandboxed Hermes run",
          receiptSummary: { receiptId: "hr_smoke", receiptSha256: "a".repeat(64), provider: "openrouter" },
        },
        contribution: { id: "contribution_trusted" },
      });
    }
    if (parsed.pathname === "/api/contributions/contribution_manual/ratings") {
      const isRepeat = requests.filter((request) => request.url.pathname === parsed.pathname).length > 1;
      return jsonResponse({ rating: { id: isRepeat ? "rating_repeat" : "rating_one" }, creditDelta: isRepeat ? 0 : 8 });
    }
    if (parsed.pathname === "/api/challenges/challenge_smoke/synthesis") return jsonResponse({ synthesis: { id: "synthesis_smoke", confidence: "low" }, artifactUrl: "/answers/challenge_smoke" });
    if (parsed.pathname === "/api/answers/challenge_smoke/artifact") {
      if (suppressed && !options.cleanupStillVisible) return jsonResponse({ code: "not_found" }, { status: 404 });
      return jsonResponse({ artifact: { id: "challenge_smoke", artifactUrl: "/answers/challenge_smoke", debateUrl: "/challenges/challenge_smoke", contributionCount: options.trustedRequiredSuccess ? 2 : 1, usefulContributionCount: options.trustedRequiredSuccess ? 2 : 1 } });
    }
    if (parsed.pathname === "/answers/challenge_smoke") {
      if (options.artifactPageFails) return htmlResponse("<html><body>missing synthesized page marker</body></html>");
      if (suppressed && !options.cleanupStillVisible) return htmlResponse("not found", { status: 404 });
      return htmlResponse("<html><body>decision artifact challenge_smoke</body></html>");
    }
    if (parsed.pathname === "/challenges/challenge_smoke") {
      if (suppressed && !options.cleanupStillVisible) return htmlResponse("not found", { status: 404 });
      return htmlResponse("<html><body>challenge room challenge_smoke</body></html>");
    }
    if (parsed.pathname === "/api/moderation/actions" && method === "POST") {
      if (options.moderationForbidden) return jsonResponse({ code: "forbidden" }, { status: 403 });
      suppressed = true;
      return jsonResponse({ ok: true });
    }
    if (parsed.pathname === "/api/answers") return jsonResponse({ artifacts: suppressed && !options.cleanupStillVisible ? [] : [{ id: "challenge_smoke" }] });

    return jsonResponse({ error: `Unhandled ${method} ${parsed.pathname}` }, { status: 404 });
  };
  return { fetch, requests };
}

function fakePreflightFetch(requests: RecordedRequest[], health: Record<string, unknown> = productionHealth()) {
  const fetch: ProductionChallengeLoopSmokeFetch = async (url, init = {}) => {
    requests.push({ url: new URL(url), method: (init.method || "GET").toUpperCase(), headers: new Headers(init.headers), body: init.body });
    const parsed = new URL(url);
    if (parsed.pathname === "/api/system/health") return jsonResponse(health);
    if (["/", "/lobby", "/answers"].includes(parsed.pathname)) return htmlResponse();
    if (parsed.pathname === "/challenges/new") return htmlResponse("", { status: 307, headers: { location: "https://challenge.example/login?next=%2Fchallenges%2Fnew" } });
    return jsonResponse({ error: `Unhandled ${parsed.pathname}` }, { status: 404 });
  };
  return fetch;
}

describe("production challenge-loop smoke", () => {
  it("refuses non-local mutation without explicit operator opt-in after health preflight", async () => {
    const requests: RecordedRequest[] = [];
    const fetch = fakePreflightFetch(requests);
    const stderr: string[] = [];

    const code = await runProductionChallengeLoopSmoke({ baseUrl: "https://challenge.example", fetch, stderr: (line) => stderr.push(line), stdout: () => {}, smokeId: "guard" });

    expect(code).toBe(1);
    expect(requests.map((request) => request.url.pathname)).toEqual(["/api/system/health", "/", "/lobby", "/answers", "/challenges/new"]);
    expect(stderr.join("\n")).toContain("PRODUCTION_CHALLENGE_LOOP_MUTATION_NOT_ALLOWED");
    expect(stderr.join("\n")).not.toMatch(/cmai_csrf|sb-|postgres:\/\/|sk-/i);
  });

  it("can run a non-mutating live preflight summary without signup or challenge creation", async () => {
    const requests: RecordedRequest[] = [];
    const fetch = fakePreflightFetch(requests);
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runProductionChallengeLoopSmoke({ baseUrl: "https://challenge.example", fetch, preflightOnly: true, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line), smokeId: "preflightonly" });
    const summary = JSON.parse(stdout.join("\n")) as Record<string, unknown>;

    expect(code, stderr.join("\n")).toBe(0);
    expect(requests.map((request) => request.url.pathname)).toEqual(["/api/system/health", "/", "/lobby", "/answers", "/challenges/new"]);
    expect(requests.some((request) => request.url.pathname === "/api/auth/signup")).toBe(false);
    expect(requests.some((request) => request.url.pathname === "/api/challenges" && request.method === "POST")).toBe(false);
    expect(summary).toMatchObject({
      ok: true,
      mode: "production_http_preflight",
      base: "https://challenge.example",
      mutation: false,
      canonical_routes: { home: true, lobby: true, answers: true, anonymous_new_challenge_redirect: "/login" },
      trusted_lane_preflight: {
        status: "launch_blocked",
        ready: false,
        config_issue_count: 1,
        proof: {
          substrate: "unavailable",
          broker_receipt: "unavailable",
          model_proxy: "unavailable",
          provider_metadata: "unavailable",
          provider_signed: "not_implemented",
        },
      },
      manual_paste_fallback_available: true,
    });
  });

  it("rejects production targets that report local auth or local storage", async () => {
    const fetch: ProductionChallengeLoopSmokeFetch = async () => jsonResponse(productionHealth({
      productionReady: false,
      publicRuntime: { runtimeMode: "production", authMode: "local", storeDriver: "local" },
      productionConfigIssues: ["CMAI_AUTH_MODE must be supabase in production", "CMAI_STORE_DRIVER must be postgres in production"],
    }), { status: 503 });
    const stderr: string[] = [];

    const code = await runProductionChallengeLoopSmoke({ baseUrl: "https://challenge.example", fetch, allowMutation: true, stderr: (line) => stderr.push(line), stdout: () => {}, smokeId: "preflight" });

    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("PRODUCTION_CHALLENGE_LOOP_PREFLIGHT_FAILED");
    expect(stderr.join("\n")).toContain("authMode");
  });

  it("rejects unhealthy production targets before returning a preflight-only summary", async () => {
    const fetch: ProductionChallengeLoopSmokeFetch = async () => jsonResponse(productionHealth({
      productionReady: false,
      publicRuntime: { runtimeMode: "production", authMode: "local", storeDriver: "local" },
      productionConfigIssues: ["CMAI_AUTH_MODE must be supabase in production"],
    }), { status: 503 });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runProductionChallengeLoopSmoke({ baseUrl: "https://challenge.example", fetch, preflightOnly: true, stderr: (line) => stderr.push(line), stdout: (line) => stdout.push(line), smokeId: "badpreflight" });

    expect(code).toBe(1);
    expect(stdout).toHaveLength(0);
    expect(stderr.join("\n")).toContain("PRODUCTION_CHALLENGE_LOOP_PREFLIGHT_FAILED");
  });

  it("fails before mutation when canonical pages do not render", async () => {
    const requests: RecordedRequest[] = [];
    const fetch: ProductionChallengeLoopSmokeFetch = async (url, init = {}) => {
      const parsed = new URL(url);
      requests.push({ url: parsed, method: (init.method || "GET").toUpperCase(), headers: new Headers(init.headers), body: init.body });
      if (parsed.pathname === "/api/system/health") return jsonResponse(productionHealth());
      if (parsed.pathname === "/") return htmlResponse("<html><body>ok</body></html>");
      if (parsed.pathname === "/lobby") return htmlResponse("database unavailable", { status: 500 });
      return htmlResponse();
    };
    const stderr: string[] = [];

    const code = await runProductionChallengeLoopSmoke({ baseUrl: "https://challenge.example", fetch, allowMutation: true, stderr: (line) => stderr.push(line), stdout: () => {}, smokeId: "routefail" });

    expect(code).toBe(1);
    expect(requests.map((request) => request.url.pathname)).toEqual(["/api/system/health", "/", "/lobby"]);
    expect(stderr.join("\n")).toContain("PRODUCTION_CHALLENGE_LOOP_ROUTE_PREFLIGHT_FAILED");
  });

  it("fails before mutation when anonymous challenge creation does not redirect to login", async () => {
    const requests: RecordedRequest[] = [];
    const fetch: ProductionChallengeLoopSmokeFetch = async (url, init = {}) => {
      const parsed = new URL(url);
      requests.push({ url: parsed, method: (init.method || "GET").toUpperCase(), headers: new Headers(init.headers), body: init.body });
      if (parsed.pathname === "/api/system/health") return jsonResponse(productionHealth());
      if (["/", "/lobby", "/answers"].includes(parsed.pathname)) return htmlResponse();
      if (parsed.pathname === "/challenges/new") return htmlResponse("<html><body>unguarded form</body></html>");
      return jsonResponse({ error: `Unhandled ${parsed.pathname}` }, { status: 404 });
    };
    const stderr: string[] = [];

    const code = await runProductionChallengeLoopSmoke({ baseUrl: "https://challenge.example", fetch, allowMutation: true, stderr: (line) => stderr.push(line), stdout: () => {}, smokeId: "authroutefail" });

    expect(code).toBe(1);
    expect(requests.map((request) => request.url.pathname)).toEqual(["/api/system/health", "/", "/lobby", "/answers", "/challenges/new"]);
    expect(stderr.join("\n")).toContain("PRODUCTION_CHALLENGE_LOOP_AUTH_ROUTE_PREFLIGHT_FAILED");
  });

  it("returns a stable failure for invalid base URLs", async () => {
    const stderr: string[] = [];
    const fetch: ProductionChallengeLoopSmokeFetch = async () => {
      throw new Error("fetch should not be called for an invalid base URL");
    };

    const code = await runProductionChallengeLoopSmoke({ baseUrl: "not a url", fetch, stderr: (line) => stderr.push(line), stdout: () => {} });

    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("PRODUCTION_CHALLENGE_LOOP_INVALID_BASE_URL");
  });

  it("returns a stable failure for invalid cleanup modes before contacting the target", async () => {
    const requests: RecordedRequest[] = [];
    const stderr: string[] = [];
    const fetch: ProductionChallengeLoopSmokeFetch = async (url, init = {}) => {
      requests.push({ url: new URL(url), method: (init.method || "GET").toUpperCase(), headers: new Headers(init.headers), body: init.body });
      return jsonResponse(productionHealth());
    };

    const code = await runProductionChallengeLoopSmoke({ baseUrl: "https://challenge.example", fetch, env: { CMAI_SMOKE_CLEANUP_MODE: "surprise" }, stderr: (line) => stderr.push(line), stdout: () => {} });

    expect(code).toBe(1);
    expect(requests).toHaveLength(0);
    expect(stderr.join("\n")).toContain("PRODUCTION_CHALLENGE_LOOP_CLEANUP_MODE_INVALID");
  });

  it("times out stalled requests with a stable smoke failure", async () => {
    const stderr: string[] = [];
    const fetch: ProductionChallengeLoopSmokeFetch = async () => new Promise<Response>(() => {});

    const code = await runProductionChallengeLoopSmoke({
      baseUrl: "https://challenge.example",
      fetch,
      env: { CMAI_SMOKE_REQUEST_TIMEOUT_MS: "1" },
      stderr: (line) => stderr.push(line),
      stdout: () => {},
    });

    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("PRODUCTION_CHALLENGE_LOOP_TIMEOUT");
    expect(stderr.join("\n")).toContain("health preflight");
  });

  it("normalizes unsafe smoke ids before persisting or printing smoke data", async () => {
    const { fetch, requests } = fakeLoopFetch();
    const stdout: string[] = [];
    const rawSmokeId = "unsafe secret sk-live-secret value with spaces that should not leak";

    const code = await runProductionChallengeLoopSmoke({ baseUrl: "https://challenge.example", fetch, allowMutation: true, stdout: (line) => stdout.push(line), stderr: () => {}, smokeId: rawSmokeId });
    const summary = JSON.parse(stdout.join("\n")) as Record<string, unknown>;

    expect(code).toBe(0);
    expect(summary.smoke_id).toMatch(/^smoke-[a-f0-9]{16}$/);
    expect(stdout.join("\n")).not.toContain("sk-live-secret");
    expect(requests.some((request) => request.url.search.includes("sk-live-secret"))).toBe(false);
  });

  it("fails when the public answer page does not render the synthesized artifact", async () => {
    const { fetch } = fakeLoopFetch({ artifactPageFails: true });
    const stderr: string[] = [];

    const code = await runProductionChallengeLoopSmoke({ baseUrl: "https://challenge.example", fetch, allowMutation: true, stderr: (line) => stderr.push(line), stdout: () => {}, smokeId: "pagefail" });

    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("PRODUCTION_CHALLENGE_LOOP_ARTIFACT_PAGE_MISSING");
  });

  it("runs the manual production loop with cookie/CSRF sessions and redacted summary output", async () => {
    const { fetch, requests } = fakeLoopFetch();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runProductionChallengeLoopSmoke({ baseUrl: "https://challenge.example", fetch, allowMutation: true, stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line), smokeId: "prodloop" });
    const summary = JSON.parse(stdout.join("\n")) as Record<string, unknown>;
    const trustedLane = summary.trusted_lane as Record<string, unknown>;

    expect(code, stderr.join("\n")).toBe(0);
    expect(summary).toMatchObject({
      ok: true,
      mode: "production_http_challenge_loop",
      lanes: ["copy_prompt_paste_local_output", "run_my_agent_here"],
      trusted_lane_preflight: {
        status: "launch_blocked",
        ready: false,
        components: {
          receipt_signing: "missing",
          railway_run_cells: "missing",
          broker_vault: "missing",
          model_proxy: "missing",
          model_proxy_grant_store: "broker_state",
        },
      },
      visible_prompt_preview: true,
      manual_paste_fallback_available: true,
      challenge_id: "challenge_smoke",
    });
    expect(trustedLane).toMatchObject({ required: false, status: "fail_closed", readiness_state: "setup_required", manual_paste_fallback_available: true });
    expect(summary.poster_session).toMatchObject({ created: true, csrf: "present" });
    expect(summary.contributor_session).toMatchObject({ created: true, csrf: "present" });
    expect(summary.answer_artifact).toMatchObject({ searchable: true, public_page_rendered: true, url: "/answers/challenge_smoke" });
    expect(summary.cleanup).toMatchObject({ mode: "none", status: "retained", challenge_url: "/challenges/challenge_smoke", answer_url: "/answers/challenge_smoke" });

    const mutatingRequests = requests.filter((request) => !["GET", "HEAD", "OPTIONS"].includes(request.method));
    expect(mutatingRequests.length).toBeGreaterThan(0);
    expect(mutatingRequests.some((request) => request.headers.has("x-cmai-user-id"))).toBe(false);
    const sessionMutations = mutatingRequests.filter((request) => request.headers.has("cookie"));
    expect(sessionMutations.some((request) => request.headers.get("x-cmai-csrf") === "csrf-poster")).toBe(true);
    expect(sessionMutations.some((request) => request.headers.get("x-cmai-csrf") === "csrf-contributor")).toBe(true);
    expect(sessionMutations.every((request) => request.headers.get("origin") === "https://challenge.example")).toBe(true);
    expect(stdout.join("\n")).not.toMatch(/csrf-poster|csrf-contributor|cmai_user|DATABASE_URL|RAILWAY_API_TOKEN|OPENROUTER_API_KEY|ANTHROPIC_API_KEY|SUPABASE_SERVICE_ROLE_KEY|sk-/i);
  });

  it("fails before mutation when moderator cleanup credentials are missing", async () => {
    const { fetch, requests } = fakeLoopFetch();
    const stderr: string[] = [];

    const code = await runProductionChallengeLoopSmoke({
      baseUrl: "https://challenge.example",
      fetch,
      allowMutation: true,
      env: { CMAI_SMOKE_CLEANUP_MODE: "moderator_suppress" },
      stderr: (line) => stderr.push(line),
      stdout: () => {},
      smokeId: "cleanupmissing",
    });

    expect(code).toBe(1);
    expect(requests.map((request) => request.url.pathname)).toEqual(["/api/system/health", "/", "/lobby", "/answers", "/challenges/new"]);
    expect(requests.some((request) => request.url.pathname === "/api/auth/signup")).toBe(false);
    expect(requests.some((request) => request.url.pathname === "/api/challenges" && request.method === "POST")).toBe(false);
    expect(requests.some((request) => request.url.pathname === "/api/moderation/actions")).toBe(false);
    const output = stderr.join("\n");
    expect(output).toContain("PRODUCTION_CHALLENGE_LOOP_CLEANUP_NOT_CONFIGURED");
    expect(output).toContain("before creating smoke users/challenges");
    expect(output).not.toContain("/challenges/challenge_smoke");
    expect(output).not.toContain("/answers/challenge_smoke");
    expect(output).not.toMatch(/cmai_csrf=|sk-/i);
  });

  it("can suppress smoke artifacts with a separate moderator session", async () => {
    const { fetch, requests } = fakeLoopFetch();
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runProductionChallengeLoopSmoke({
      baseUrl: "https://challenge.example",
      fetch,
      allowMutation: true,
      env: { CMAI_SMOKE_CLEANUP_MODE: "moderator_suppress", CMAI_SMOKE_MODERATOR_EMAIL: "mod@example.test", CMAI_SMOKE_MODERATOR_PASSWORD: "moderator-secret-password" },
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      smokeId: "cleanupsuccess",
    });
    const summary = JSON.parse(stdout.join("\n")) as Record<string, unknown>;

    expect(code, stderr.join("\n")).toBe(0);
    expect(summary.cleanup).toMatchObject({ mode: "moderator_suppress", status: "suppressed", challenge_url: "/challenges/challenge_smoke", answer_url: "/answers/challenge_smoke" });
    expect(requests.filter((request) => request.url.pathname === "/api/auth/signup")).toHaveLength(3);
    const moderationRequest = requests.find((request) => request.url.pathname === "/api/moderation/actions");
    expect(moderationRequest).toBeTruthy();
    expect(moderationRequest?.headers.get("x-cmai-csrf")).toBe("csrf-moderator");
    expect(moderationRequest?.headers.get("cookie")).toContain("cmai_user_id=moderator");
    expect(requests.map((request) => request.url.pathname)).toEqual(expect.arrayContaining(["/challenges/challenge_smoke", "/api/answers/challenge_smoke/artifact", "/answers/challenge_smoke", "/api/answers"]));
    expect(stdout.join("\n")).not.toContain("moderator-secret-password");
  });

  it("fails cleanup when moderation refuses the moderator session", async () => {
    const { fetch } = fakeLoopFetch({ moderationForbidden: true });
    const stderr: string[] = [];

    const code = await runProductionChallengeLoopSmoke({
      baseUrl: "https://challenge.example",
      fetch,
      allowMutation: true,
      env: { CMAI_SMOKE_CLEANUP_MODE: "moderator_suppress", CMAI_SMOKE_MODERATOR_EMAIL: "mod@example.test", CMAI_SMOKE_MODERATOR_PASSWORD: "moderator-secret-password" },
      stderr: (line) => stderr.push(line),
      stdout: () => {},
      smokeId: "cleanupforbidden",
    });

    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("PRODUCTION_CHALLENGE_LOOP_CLEANUP_FAILED");
    expect(stderr.join("\n")).toContain("/challenges/challenge_smoke");
    expect(stderr.join("\n")).not.toContain("moderator-secret-password");
  });

  it("fails cleanup when suppressed artifacts remain publicly visible", async () => {
    const { fetch } = fakeLoopFetch({ cleanupStillVisible: true });
    const stderr: string[] = [];

    const code = await runProductionChallengeLoopSmoke({
      baseUrl: "https://challenge.example",
      fetch,
      allowMutation: true,
      env: { CMAI_SMOKE_CLEANUP_MODE: "moderator_suppress", CMAI_SMOKE_MODERATOR_EMAIL: "mod@example.test", CMAI_SMOKE_MODERATOR_PASSWORD: "moderator-secret-password" },
      stderr: (line) => stderr.push(line),
      stdout: () => {},
      smokeId: "cleanupvisible",
    });

    expect(code).toBe(1);
    expect(stderr.join("\n")).toContain("PRODUCTION_CHALLENGE_LOOP_CLEANUP_VERIFICATION_FAILED");
  });

  it("requires explicit trusted-run smoke configuration before exercising the trusted lane", async () => {
    const { fetch, requests } = fakeLoopFetch();
    const stderr: string[] = [];

    const code = await runProductionChallengeLoopSmoke({ baseUrl: "https://challenge.example", fetch, allowMutation: true, requireTrustedRun: true, env: {}, stderr: (line) => stderr.push(line), stdout: () => {}, smokeId: "trustedmissing" });

    expect(code).toBe(1);
    expect(requests.map((request) => request.url.pathname)).toEqual(["/api/system/health", "/", "/lobby", "/answers", "/challenges/new"]);
    expect(requests.some((request) => request.url.pathname === "/api/auth/signup")).toBe(false);
    expect(stderr.join("\n")).toContain("PRODUCTION_CHALLENGE_LOOP_TRUSTED_NOT_CONFIGURED");
    expect(stderr.join("\n")).not.toMatch(/secret|token|cmai_csrf/i);
  });

  it("fails before mutation when trusted-required production readiness is blocked", async () => {
    const { fetch, requests } = fakeLoopFetch();
    const stderr: string[] = [];

    const code = await runProductionChallengeLoopSmoke({
      baseUrl: "https://challenge.example",
      fetch,
      allowMutation: true,
      requireTrustedRun: true,
      env: { CMAI_SMOKE_AGENT_PROVIDER: "openrouter", CMAI_SMOKE_AGENT_PROVIDER_SECRET: "sk-test-secret" },
      stderr: (line) => stderr.push(line),
      stdout: () => {},
      smokeId: "trustedblocked",
    });

    expect(code).toBe(1);
    expect(requests.map((request) => request.url.pathname)).toEqual(["/api/system/health", "/", "/lobby", "/answers", "/challenges/new"]);
    expect(requests.some((request) => request.url.pathname === "/api/auth/signup")).toBe(false);
    const output = stderr.join("\n");
    expect(output).toContain("PRODUCTION_CHALLENGE_LOOP_TRUSTED_PREFLIGHT_BLOCKED");
    expect(output).toContain("trustedAgentRun.ready is not true");
    expect(output).not.toContain("sk-test-secret");
  });

  it("rejects unsupported trusted providers before production mutation", async () => {
    const { fetch, requests } = fakeLoopFetch({ trustedPreflightReady: true });
    const stderr: string[] = [];

    const code = await runProductionChallengeLoopSmoke({
      baseUrl: "https://challenge.example",
      fetch,
      allowMutation: true,
      requireTrustedRun: true,
      env: { CMAI_SMOKE_AGENT_PROVIDER: "local_fake", CMAI_SMOKE_AGENT_PROVIDER_SECRET: "fake-secret" },
      stderr: (line) => stderr.push(line),
      stdout: () => {},
      smokeId: "trustedprovider",
    });

    expect(code).toBe(1);
    expect(requests.map((request) => request.url.pathname)).toEqual(["/api/system/health", "/", "/lobby", "/answers", "/challenges/new"]);
    expect(requests.some((request) => request.url.pathname === "/api/auth/signup")).toBe(false);
    const output = stderr.join("\n");
    expect(output).toContain("PRODUCTION_CHALLENGE_LOOP_TRUSTED_PROVIDER_NOT_ALLOWED");
    expect(output).not.toContain("fake-secret");
  });

  it("requires a smoke-owned provider secret before trusted production mutation", async () => {
    const { fetch, requests } = fakeLoopFetch({ trustedPreflightReady: true });
    const stderr: string[] = [];

    const code = await runProductionChallengeLoopSmoke({
      baseUrl: "https://challenge.example",
      fetch,
      allowMutation: true,
      requireTrustedRun: true,
      env: { CMAI_SMOKE_AGENT_PROVIDER: "openrouter" },
      stderr: (line) => stderr.push(line),
      stdout: () => {},
      smokeId: "trustedsecret",
    });

    expect(code).toBe(1);
    expect(requests.map((request) => request.url.pathname)).toEqual(["/api/system/health", "/", "/lobby", "/answers", "/challenges/new"]);
    expect(requests.some((request) => request.url.pathname === "/api/auth/signup")).toBe(false);
    expect(stderr.join("\n")).toContain("PRODUCTION_CHALLENGE_LOOP_TRUSTED_SECRET_NOT_CONFIGURED");
  });

  it("can require a receipt-backed trusted contribution when smoke-owned connection details are provided", async () => {
    const { fetch, requests } = fakeLoopFetch({ trustedRequiredSuccess: true, trustedPreflightReady: true });
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runProductionChallengeLoopSmoke({
      baseUrl: "https://challenge.example",
      fetch,
      allowMutation: true,
      requireTrustedRun: true,
      env: { CMAI_SMOKE_AGENT_PROVIDER: "openai", CMAI_SMOKE_AGENT_MODEL: "gpt-5.6-sol", CMAI_SMOKE_AGENT_PROVIDER_SECRET: "«redacted:sk-…»" },
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      smokeId: "trustedsuccess",
    });
    const summary = JSON.parse(stdout.join("\n")) as Record<string, unknown>;

    expect(code, stderr.join("\n")).toBe(0);
    expect(summary.trusted_lane).toMatchObject({
      required: true,
      status: "contributed",
      contribution_id: "contribution_trusted",
      receipt_id: "hr_smoke",
      receipt_sha256: "a".repeat(64),
      connection_cleanup: { status: "revoked", connection_id: "conn_smoke" },
    });
    expect(requests.some((request) => request.method === "PATCH" && request.url.pathname === "/api/agent-home/connections/conn_smoke")).toBe(true);
    expect(stdout.join("\n")).not.toContain("«redacted:sk-…»");
  });

  it("redacts secret-shaped values from HTTP failure output", async () => {
    const fetch: ProductionChallengeLoopSmokeFetch = async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/api/system/health") return jsonResponse(productionHealth());
      if (["/", "/lobby", "/answers"].includes(parsed.pathname)) return htmlResponse();
      if (parsed.pathname === "/challenges/new") return htmlResponse("", { status: 307, headers: { location: "https://challenge.example/login?next=%2Fchallenges%2Fnew" } });
      return jsonResponse({
        error: "signup failed",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-value",
        access_token: "access-token-secret-value",
        cmai_csrf: "csrf-secret",
        nested: { password: "password-secret-value", secret: "nested-secret-value" },
      }, { status: 500 });
    };
    const stderr: string[] = [];

    const code = await runProductionChallengeLoopSmoke({ baseUrl: "https://challenge.example", fetch, allowMutation: true, stderr: (line) => stderr.push(line), stdout: () => {}, smokeId: "redact" });

    expect(code).toBe(1);
    const output = stderr.join("\n");
    expect(output).toContain("PRODUCTION_CHALLENGE_LOOP_SIGNUP_FAILED");
    expect(output).not.toContain("service-role-secret-value");
    expect(output).not.toContain("access-token-secret-value");
    expect(output).not.toContain("csrf-secret");
    expect(output).not.toContain("password-secret-value");
    expect(output).not.toContain("nested-secret-value");
  });
});
