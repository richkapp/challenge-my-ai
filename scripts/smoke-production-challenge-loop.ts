import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { ChallengeBrief, ContributionCard } from "../lib/types";

export type ProductionChallengeLoopSmokeEnv = Record<string, string | undefined>;
export type ProductionChallengeLoopSmokeLogger = (line: string) => void;
export type ProductionChallengeLoopSmokeFetch = (url: string, init?: RequestInit) => Promise<Response>;

type SmokeRequestOptions = {
  step?: string;
  timeoutMs?: number;
};

type JsonObject = Record<string, unknown>;

export type SmokeUser = {
  label: string;
  email: string;
  jar: CookieJar;
};

export type SmokeCleanupMode = "none" | "moderator_suppress";

type SmokeCleanupResult = {
  mode: SmokeCleanupMode;
  status: "retained" | "suppressed";
  challenge_id: string;
  challenge_url: string;
  answer_url: string;
};

export type SmokeClient = {
  base: URL;
  fetch: ProductionChallengeLoopSmokeFetch;
  request(path: string, init?: RequestInit, jar?: CookieJar, options?: SmokeRequestOptions): Promise<Response>;
  json(path: string, init?: RequestInit, jar?: CookieJar, step?: string, options?: SmokeRequestOptions): Promise<JsonObject>;
};

class SmokeFailure extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const LONG_REQUEST_TIMEOUT_MS = 120_000;
const MAX_REQUEST_TIMEOUT_MS = 300_000;
const PRODUCTION_TRUSTED_SMOKE_PROVIDERS = new Set(["openrouter", "anthropic", "openai"]);

const SECRET_KEY_PATTERN = [
  "DATABASE_URL",
  "RAILWAY_API_TOKEN",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "CMAI_RECEIPT_SIGNING_SECRET",
  "CMAI_AGENT_BROKER_VAULT_SECRET",
  "api[_-]?key",
  "access[_-]?token",
  "refresh[_-]?token",
  "service[_-]?role",
  "secret",
  "password",
  "cmai_csrf",
  "cmai_user_id",
  "cmai_user_name",
].join("|");

const QUOTED_SECRET_VALUE = new RegExp(`(["']?\\b(?:${SECRET_KEY_PATTERN})\\b["']?\\s*[:=]\\s*)(["'])[^"']*\\2`, "gi");
const UNQUOTED_SECRET_VALUE = new RegExp(`(["']?\\b(?:${SECRET_KEY_PATTERN})\\b["']?\\s*[:=]\\s*)(?!["'])[^\\s,;}]+`, "gi");

export class CookieJar {
  private cookies = new Map<string, string>();

  absorb(response: Response) {
    for (const cookie of getSetCookieHeaders(response.headers)) {
      const [pair] = cookie.split(";");
      const index = pair.indexOf("=");
      if (index <= 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (name) this.cookies.set(name, value);
    }
  }

  header() {
    return Array.from(this.cookies.entries()).map(([name, value]) => `${name}=${value}`).join("; ");
  }

  csrf() {
    return this.cookies.get("cmai_csrf") || "";
  }

  hasSession() {
    return this.cookies.size > 0 && Boolean(this.csrf());
  }
}

function getSetCookieHeaders(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === "function") return withGetSetCookie.getSetCookie();
  const single = headers.get("set-cookie");
  if (!single) return [];
  return single.split(/,(?=\s*[^;,\s]+=)/).map((value) => value.trim()).filter(Boolean);
}

function redact(value: string) {
  return value
    .replace(QUOTED_SECRET_VALUE, "$1$2[redacted-secret]$2")
    .replace(UNQUOTED_SECRET_VALUE, "$1[redacted-secret]")
    .replace(/sb-[A-Za-z0-9._-]+/g, "sb-[redacted-cookie]")
    .replace(/postgres:\/\/[^\s"']+/gi, "postgres://[redacted]")
    .replace(/sk-[A-Za-z0-9._-]+/g, "sk-[redacted]");
}

function parseTimeoutMs(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, MAX_REQUEST_TIMEOUT_MS);
}

function timeoutFailure(step: string, timeoutMs: number) {
  return new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_TIMEOUT", `${step} timed out after ${timeoutMs}ms`);
}

function isAbortError(error: unknown) {
  return isObject(error) && stringValue((error as { name?: unknown }).name) === "AbortError";
}

async function readJsonResponse(response: Response, step: string) {
  const text = await response.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_NON_JSON", `${step} did not return JSON: ${redact(text.slice(0, 600))}`);
  }
  return objectValue(data);
}

export function resolveBaseUrl(rawBaseUrl: string) {
  try {
    const base = new URL(rawBaseUrl.replace(/\/$/, ""));
    if (!["http:", "https:"].includes(base.protocol)) throw new Error("unsupported protocol");
    return base;
  } catch {
    throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_INVALID_BASE_URL", `Invalid smoke base URL: ${redact(rawBaseUrl.slice(0, 300))}`);
  }
}

function defaultSmokeId() {
  return new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14).toLowerCase();
}

export function normalizeSmokeId(raw: string | undefined) {
  const candidate = (raw || defaultSmokeId()).trim().toLowerCase();
  if (/^[a-z0-9-]{1,32}$/.test(candidate)) return candidate;
  return `smoke-${createHash("sha256").update(candidate || defaultSmokeId()).digest("hex").slice(0, 16)}`;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function objectValue(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function boolValue(value: unknown): boolean {
  return value === true;
}

export function cleanupModeFromEnv(env: ProductionChallengeLoopSmokeEnv): SmokeCleanupMode {
  const raw = (env.CMAI_SMOKE_CLEANUP_MODE || "none").trim().toLowerCase();
  if (!raw || raw === "none") return "none";
  if (raw === "moderator_suppress") return "moderator_suppress";
  throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_CLEANUP_MODE_INVALID", `Unsupported CMAI_SMOKE_CLEANUP_MODE=${redact(raw)}. Use none or moderator_suppress.`);
}

function cleanupPaths(challengeId: string, artifactUrl: string) {
  return {
    challenge_id: challengeId,
    challenge_url: `/challenges/${challengeId}`,
    answer_url: artifactUrl,
  };
}

function retainedCleanup(mode: SmokeCleanupMode, challengeId: string, artifactUrl: string): SmokeCleanupResult {
  return { mode, status: "retained", ...cleanupPaths(challengeId, artifactUrl) };
}

function cleanupFailure(code: string, message: string, challengeId: string, artifactUrl: string) {
  return new SmokeFailure(code, `${message} Public smoke data may remain: ${JSON.stringify(cleanupPaths(challengeId, artifactUrl))}`);
}

function isLocalBase(base: URL) {
  return ["localhost", "127.0.0.1", "::1", "test.local"].includes(base.hostname);
}

export function createClient(base: URL, fetchImpl: ProductionChallengeLoopSmokeFetch, env: ProductionChallengeLoopSmokeEnv): SmokeClient {
  return {
    base,
    fetch: fetchImpl,
    async request(path, init = {}, jar, requestOptions = {}) {
      const target = new URL(path, base);
      const headers = new Headers(init.headers);
      if (!headers.has("accept")) headers.set("accept", "application/json");
      const method = (init.method || "GET").toUpperCase();
      if (jar) {
        const cookie = jar.header();
        if (cookie) headers.set("cookie", cookie);
        if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
          const csrf = jar.csrf();
          if (csrf) headers.set("x-cmai-csrf", csrf);
          headers.set("origin", base.origin);
        }
      }

      const step = requestOptions.step || path;
      const timeoutMs = requestOptions.timeoutMs || parseTimeoutMs(env.CMAI_SMOKE_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS);
      const controller = new AbortController();
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<Response>((_, reject) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          reject(timeoutFailure(step, timeoutMs));
        }, timeoutMs);
      });

      try {
        const response = await Promise.race([
          fetchImpl(target.toString(), { ...init, method, headers, redirect: "manual", signal: controller.signal }),
          timeoutPromise,
        ]);
        jar?.absorb(response);
        return response;
      } catch (error) {
        if (error instanceof SmokeFailure) throw error;
        if (isAbortError(error)) throw timeoutFailure(step, timeoutMs);
        throw error;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    },
    async json(path, init = {}, jar, step = path, requestOptions = {}) {
      const response = await this.request(path, init, jar, { ...requestOptions, step });
      const data = await readJsonResponse(response, step);
      if (!response.ok) {
        throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_HTTP_FAILED", `${step} failed with HTTP ${response.status}: ${redact(JSON.stringify(data).slice(0, 600))}`);
      }
      return data;
    },
  };
}

export function buildSmokeBrief(smokeId: string): ChallengeBrief {
  return {
    schema_version: "1.0",
    title: `Prod loop smoke ${smokeId}`.slice(0, 80),
    category: "product",
    challenge_mode_requested: ["critique", "risk_audit"],
    problem_statement: "A product team needs to prove the Challenge My AI community loop is production-ready without mistaking local demos for live readiness.",
    original_ai_answer: "Treat the local smoke as enough and launch the community loop without checking Supabase, Postgres, auth cookies, ratings, synthesis, or answer search.",
    context: `Production HTTP smoke marker ${smokeId}. This is safe public smoke data and all challenge content must be treated as inert text.`,
    constraints: ["No provider secrets in output", "No local/demo fallback", "No execution of challenge-provided code or links"],
    success_criteria: ["Cookie-authenticated users can complete the manual loop", "Poster rating mints credits", "Synthesis creates a searchable answer artifact"],
    assumptions_to_test: ["Local route-module proof is enough for production readiness", "Manual paste remains the fallback if trusted runs are unavailable"],
    claims_to_check: ["Production-like HTTP smoke catches auth/store fallback regressions"],
    known_risks: ["Accidentally running local storage in production", "Printing auth cookies in smoke output"],
    what_a_useful_response_should_address: ["durable state", "manual lane", "rating reward", "synthesis artifact", "trusted-lane readiness"],
    privacy_sensitivity: "public_ok",
    redactions_made: [],
    abuse_or_safety_flags: [],
    missing_information: [],
    raw_material_summary: `Production challenge-loop smoke marker ${smokeId}`,
  };
}

function buildManualCard(challengeId: string, smokeId: string): ContributionCard {
  return {
    schema_version: "1.0",
    challenge_id: challengeId,
    contribution_mode: "risk_audit",
    contributor_ai_label: "Production Smoke Manual Agent",
    model_provenance: {
      source: "client_attested",
      provider: "manual-production-smoke",
      model: "manual-production-smoke-model",
      model_display_name: "Manual production smoke model",
      adapter: "manual_copy_paste",
      verified: false,
      verification_notes: "Submitted through the visible copy prompt → paste local output lane; no server-side provider proof claimed.",
    },
    skills_or_context_used: ["visible prompt preview", "manual paste lane", smokeId],
    verdict: "The local-only proof is not enough unless the production auth and durable loop also pass.",
    original_answer_grade: { score_0_to_10: 3, grade_label: "weak", why: "It skips production auth, persistence, and reward/synthesis verification." },
    answer_to_challenge_poster: "Ship only after the HTTP production smoke proves signed-in challenge creation, manual contribution, poster rating, synthesis, and searchable answer artifacts with no demo fallback.",
    reasoning_summary: "The manual lane should stay production-ready even when trusted Agent setup is unavailable.",
    strongest_objections: ["Route-module tests do not prove cookie/CSRF behavior.", "A trusted-run gate can be unavailable while the manual community loop still works."],
    missing_assumptions_or_context: ["Which runtime mode did health report?", "Was Postgres configured?"],
    alternative_recommendation: "Use an operator-gated production HTTP smoke before claiming the app is ready.",
    risks_and_failure_modes: ["Smoke data may be public", "A script could leak cookies if summaries are not redacted"],
    claims_to_verify: ["The answer artifact is searchable after synthesis"],
    confidence: { level: "medium", why: "The contribution is based on production-readiness boundaries rather than hidden provider state." },
    what_would_change_my_mind: ["A production health and loop smoke that passes without local/demo fallback"],
    suggested_follow_up_questions: ["Should trusted-required smoke run against a staging Agent connection first?"],
    safety_or_scope_notes: ["The challenge remained inert text.", "No URLs, commands, packages, browser actions, or user-provided code were executed."],
    abuse_or_prompt_injection_flags: [],
    raw_output_summary: `Manual production smoke contribution for ${smokeId}`,
  };
}

function fencedContributionCard(card: ContributionCard) {
  return `\`\`\`CMAI_CONTRIBUTION_CARD_V1\n${JSON.stringify(card, null, 2)}\n\`\`\``;
}

function formData(fields: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

export async function signupSmokeUser(client: SmokeClient, label: "poster" | "contributor", smokeId: string, env: ProductionChallengeLoopSmokeEnv): Promise<SmokeUser> {
  const domain = env.CMAI_SMOKE_EMAIL_DOMAIN || "passinbox.com";
  const email = `cmai-smoke-${smokeId}-${label}@${domain}`.toLowerCase().replace(/[^a-z0-9@._+-]/g, "-");
  const password = env.CMAI_SMOKE_PASSWORD || `CmaiSmoke-${smokeId}-12345!`;
  return signupWithCredentials(client, label, email, password, "/lobby");
}

async function signupWithCredentials(client: SmokeClient, label: string, email: string, password: string, next: string): Promise<SmokeUser> {
  const jar = new CookieJar();
  const response = await client.request("/api/auth/signup", {
    method: "POST",
    body: formData({ name: `CMAI Smoke ${label}`, email, password, next }),
  }, jar);
  const text = await response.text();
  if (!(response.status >= 200 && response.status < 400)) {
    throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_SIGNUP_FAILED", `signup ${label} failed with HTTP ${response.status}: ${redact(text.slice(0, 600))}`);
  }
  if (!jar.hasSession()) {
    throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_SESSION_MISSING", `signup ${label} did not return a session cookie and cmai_csrf token`);
  }
  return { label, email, jar };
}

async function signupSmokeModerator(client: SmokeClient, env: ProductionChallengeLoopSmokeEnv, challengeId: string, artifactUrl: string): Promise<SmokeUser> {
  const email = env.CMAI_SMOKE_MODERATOR_EMAIL?.trim().toLowerCase();
  const password = env.CMAI_SMOKE_MODERATOR_PASSWORD || "";
  if (!email || !password) {
    throw cleanupFailure("PRODUCTION_CHALLENGE_LOOP_CLEANUP_NOT_CONFIGURED", "Cleanup mode moderator_suppress needs CMAI_SMOKE_MODERATOR_EMAIL and CMAI_SMOKE_MODERATOR_PASSWORD.", challengeId, artifactUrl);
  }
  try {
    return await signupWithCredentials(client, "moderator", email, password, "/moderation");
  } catch (error) {
    if (error instanceof SmokeFailure) {
      throw cleanupFailure("PRODUCTION_CHALLENGE_LOOP_CLEANUP_AUTH_FAILED", error.message, challengeId, artifactUrl);
    }
    throw error;
  }
}

function assertMutationAllowed(base: URL, allowMutation: boolean) {
  if (!isLocalBase(base) && !allowMutation) {
    throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_MUTATION_NOT_ALLOWED", `Refusing to create smoke users/challenges on ${base.origin} without CMAI_SMOKE_ALLOW_MUTATION=1.`);
  }
}

function assertCleanupConfiguredBeforeMutation(cleanupMode: SmokeCleanupMode, env: ProductionChallengeLoopSmokeEnv) {
  if (cleanupMode !== "moderator_suppress") return;
  const email = env.CMAI_SMOKE_MODERATOR_EMAIL?.trim();
  const password = env.CMAI_SMOKE_MODERATOR_PASSWORD || "";
  if (!email || !password) {
    throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_CLEANUP_NOT_CONFIGURED", "Cleanup mode moderator_suppress needs CMAI_SMOKE_MODERATOR_EMAIL and CMAI_SMOKE_MODERATOR_PASSWORD before creating smoke users/challenges.");
  }
}

function assertTrustedRequiredPreflight(base: URL, health: JsonObject, requireTrustedRun: boolean, env: ProductionChallengeLoopSmokeEnv) {
  if (!requireTrustedRun) return;
  const providerRaw = env.CMAI_SMOKE_AGENT_PROVIDER?.trim() || "";
  if (!providerRaw) {
    throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_TRUSTED_NOT_CONFIGURED", "Trusted-required mode needs CMAI_SMOKE_AGENT_PROVIDER before creating smoke users/challenges.");
  }
  if (isLocalBase(base)) return;

  const trustedAgentRun = objectValue(health.trustedAgentRun);
  if (!boolValue(trustedAgentRun.ready)) {
    throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_TRUSTED_PREFLIGHT_BLOCKED", `Trusted-required mode refused to create smoke users/challenges because /api/system/health.trustedAgentRun.ready is not true: ${redact(JSON.stringify(trustedLanePreflightSummary(health)).slice(0, 600))}`);
  }

  const provider = providerRaw.toLowerCase();
  if (!PRODUCTION_TRUSTED_SMOKE_PROVIDERS.has(provider)) {
    throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_TRUSTED_PROVIDER_NOT_ALLOWED", `Trusted-required production smoke supports only openrouter, anthropic, or openai provider connections; got ${redact(providerRaw)}.`);
  }
  if (!env.CMAI_SMOKE_AGENT_PROVIDER_SECRET?.trim()) {
    throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_TRUSTED_SECRET_NOT_CONFIGURED", "Trusted-required production smoke needs CMAI_SMOKE_AGENT_PROVIDER_SECRET for a smoke-owned provider connection.");
  }
}

function assertProductionPreflight(base: URL, health: JsonObject) {
  if (isLocalBase(base)) return;
  const publicRuntime = objectValue(health.publicRuntime);
  const issues = arrayValue(health.productionConfigIssues);
  const mode = stringValue(health.mode || publicRuntime.runtimeMode);
  const authMode = stringValue(publicRuntime.authMode);
  const storeDriver = stringValue(publicRuntime.storeDriver);
  if (mode !== "production" || authMode !== "supabase" || storeDriver !== "postgres" || !boolValue(health.productionReady) || issues.length > 0) {
    throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_PREFLIGHT_FAILED", `Target is not production-ready Supabase/Postgres runtime: ${redact(JSON.stringify({ mode, authMode, storeDriver, productionReady: health.productionReady, issues }).slice(0, 600))}`);
  }
}

async function assertCanonicalRoutes(client: SmokeClient) {
  for (const path of ["/", "/lobby", "/answers"]) {
    const response = await client.request(path, { method: "GET", headers: { accept: "text/html" } });
    const text = await response.text();
    if (!response.ok || text.length === 0) {
      throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_ROUTE_PREFLIGHT_FAILED", `${path} did not render successfully: HTTP ${response.status} ${redact(text.slice(0, 300))}`);
    }
  }

  const newChallenge = await client.request("/challenges/new", { method: "GET", headers: { accept: "text/html" } });
  const location = newChallenge.headers.get("location") || "";
  const redirectPath = location ? new URL(location, client.base).pathname : "";
  if (newChallenge.status < 300 || newChallenge.status >= 400 || redirectPath !== "/login") {
    const text = await newChallenge.text();
    throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_AUTH_ROUTE_PREFLIGHT_FAILED", `/challenges/new should redirect an anonymous browser to /login; got HTTP ${newChallenge.status} location=${redact(location)} body=${redact(text.slice(0, 300))}`);
  }
}

async function assertSuppressedHtml(client: SmokeClient, path: string, challengeId: string, label: string) {
  const response = await client.request(path, { method: "GET", headers: { accept: "text/html" } }, undefined, { step: label });
  const text = await response.text();
  if (response.status === 404) return;
  if (response.ok && !text.includes(challengeId) && !text.toLowerCase().includes("decision artifact")) return;
  throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_CLEANUP_VERIFICATION_FAILED", `${label} still exposes smoke data after cleanup: HTTP ${response.status} ${redact(text.slice(0, 300))}`);
}

async function assertSuppressedArtifactApi(client: SmokeClient, challengeId: string) {
  const response = await client.request(`/api/answers/${encodeURIComponent(challengeId)}/artifact`, { method: "GET" }, undefined, { step: "verify suppressed answer artifact API" });
  if (response.status === 404) return;
  const text = await response.text();
  throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_CLEANUP_VERIFICATION_FAILED", `answer artifact API still exposes smoke data after cleanup: HTTP ${response.status} ${redact(text.slice(0, 300))}`);
}

async function assertSuppressedSearch(client: SmokeClient, challengeId: string, smokeId: string) {
  const searchJson = await client.json(`/api/answers?q=${encodeURIComponent(smokeId)}&limit=5`, { method: "GET" }, undefined, "verify suppressed answer search");
  const foundInSearch = arrayValue(searchJson.artifacts).some((item) => objectValue(item).id === challengeId);
  if (foundInSearch) {
    throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_CLEANUP_VERIFICATION_FAILED", "answer search still returns the smoke challenge after cleanup.");
  }
}

export async function cleanupSmokeChallenge(client: SmokeClient, mode: SmokeCleanupMode, challengeId: string, artifactUrl: string, smokeId: string, env: ProductionChallengeLoopSmokeEnv): Promise<SmokeCleanupResult> {
  if (mode === "none") return retainedCleanup(mode, challengeId, artifactUrl);

  const moderator = await signupSmokeModerator(client, env, challengeId, artifactUrl);
  try {
    await client.json("/api/moderation/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "suppress_challenge", targetId: challengeId, reason: "smoke_or_test_artifact", note: `production smoke cleanup ${smokeId}` }),
    }, moderator.jar, "suppress smoke challenge");
  } catch (error) {
    if (error instanceof SmokeFailure) {
      throw cleanupFailure("PRODUCTION_CHALLENGE_LOOP_CLEANUP_FAILED", error.message, challengeId, artifactUrl);
    }
    throw error;
  }

  await assertSuppressedHtml(client, `/challenges/${encodeURIComponent(challengeId)}`, challengeId, "verify suppressed challenge page");
  await assertSuppressedArtifactApi(client, challengeId);
  await assertSuppressedHtml(client, artifactUrl, challengeId, "verify suppressed answer page");
  await assertSuppressedSearch(client, challengeId, smokeId);

  return { mode, status: "suppressed", ...cleanupPaths(challengeId, artifactUrl) };
}

function safeSummary(summary: JsonObject) {
  return JSON.parse(redact(JSON.stringify(summary))) as JsonObject;
}

function trustedLanePreflightSummary(health: JsonObject) {
  if (!isObject(health.trustedAgentRun)) {
    return {
      status: "not_reported",
      ready: false,
      config_issue_count: 0,
      components: {
        receipt_signing: "not_reported",
        railway_run_cells: "not_reported",
        broker_vault: "not_reported",
        model_proxy: "not_reported",
        model_proxy_grant_store: "not_reported",
      },
      proof: {
        substrate: "not_reported",
        broker_receipt: "not_reported",
        model_proxy: "not_reported",
        provider_metadata: "not_reported",
        provider_signed: "not_reported",
      },
      manual_paste_fallback_available: true,
    };
  }

  const trusted = objectValue(health.trustedAgentRun);
  const components = objectValue(trusted.components);
  const proof = objectValue(trusted.proof);
  return {
    status: stringValue(trusted.status) || "not_reported",
    ready: boolValue(trusted.ready),
    config_issue_count: arrayValue(trusted.configIssues).length,
    components: {
      receipt_signing: boolValue(components.receiptSigningConfigured) ? "configured" : "missing",
      railway_run_cells: boolValue(components.railwayRunCellsConfigured) ? "configured" : "missing",
      broker_vault: boolValue(components.brokerVaultConfigured) ? "configured" : "missing",
      model_proxy: boolValue(components.modelProxyConfigured) ? "configured" : "missing",
      model_proxy_grant_store: stringValue(components.modelProxyGrantStore),
    },
    proof: {
      substrate: stringValue(proof.substrate) || "not_reported",
      broker_receipt: stringValue(proof.brokerReceipt) || "not_reported",
      model_proxy: stringValue(proof.modelProxy) || "not_reported",
      provider_metadata: stringValue(proof.providerMetadata) || "not_reported",
      provider_signed: stringValue(proof.providerSigned) || "not_reported",
    },
    manual_paste_fallback_available: true,
  };
}

export async function revokeSmokeConnection(client: SmokeClient, contributor: SmokeUser, connectionId: string) {
  await client.json(`/api/agent-home/connections/${encodeURIComponent(connectionId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "revoke" }),
  }, contributor.jar, "revoke smoke Agent connection");
  return { status: "revoked", connection_id: connectionId };
}

async function maybeCheckTrustedLane(client: SmokeClient, contributor: SmokeUser, challengeId: string, options: { requireTrustedRun: boolean; smokeId: string; env: ProductionChallengeLoopSmokeEnv }) {
  const home = await client.json("/api/agent-home", { method: "GET" }, contributor.jar, "load Agent Home readiness");
  const readiness = objectValue(home.readiness);
  const baseSummary: JsonObject = {
    required: options.requireTrustedRun,
    readiness_state: stringValue(readiness.state || readiness.status),
    can_run_here: boolValue(readiness.canRunHere),
    manual_paste_fallback_available: true,
  };

  if (!options.requireTrustedRun) {
    return { ...baseSummary, status: boolValue(readiness.canRunHere) ? "ready_not_exercised" : "fail_closed" };
  }

  const provider = options.env.CMAI_SMOKE_AGENT_PROVIDER;
  if (!provider) {
    throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_TRUSTED_NOT_CONFIGURED", "Trusted-required mode needs CMAI_SMOKE_AGENT_PROVIDER for a smoke-owned Agent connection.");
  }

  const connectionBody: JsonObject = {
    provider,
    displayLabel: `CMAI smoke ${provider} Agent`,
  };
  if (options.env.CMAI_SMOKE_AGENT_MODEL) connectionBody.defaultModel = options.env.CMAI_SMOKE_AGENT_MODEL;
  if (options.env.CMAI_SMOKE_AGENT_PROVIDER_SECRET) connectionBody.providerSecret = options.env.CMAI_SMOKE_AGENT_PROVIDER_SECRET;

  let connectionId = "";
  try {
    const connectionJson = await client.json("/api/agent-home/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(connectionBody),
    }, contributor.jar, "create smoke Agent connection");
    const connection = objectValue(connectionJson.connection);
    connectionId = stringValue(connection.id);
    if (!connectionId) throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_CONNECTION_MISSING", "Agent connection creation did not return an id.");

    await client.json(`/api/agent-home/connections/${encodeURIComponent(connectionId)}/smoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }, contributor.jar, "smoke Agent connection", { timeoutMs: parseTimeoutMs(options.env.CMAI_SMOKE_LONG_REQUEST_TIMEOUT_MS, LONG_REQUEST_TIMEOUT_MS) });

    const runJson = await client.json(`/api/challenges/${encodeURIComponent(challengeId)}/agent-runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: true, connectionId, contributionMode: "critique", idempotencyKey: `production-smoke-${options.smokeId}` }),
    }, contributor.jar, "run trusted Agent contribution", { timeoutMs: parseTimeoutMs(options.env.CMAI_SMOKE_LONG_REQUEST_TIMEOUT_MS, LONG_REQUEST_TIMEOUT_MS) });
    const run = objectValue(runJson.run);
    const contribution = objectValue(runJson.contribution);
    const contributionId = stringValue(contribution.id);
    if (stringValue(run.status) !== "contributed" || !contributionId) {
      throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_TRUSTED_RUN_FAILED", `Trusted-required run did not post a contribution: ${redact(JSON.stringify(run).slice(0, 600))}`);
    }

    const connectionCleanup = await revokeSmokeConnection(client, contributor, connectionId);
    return {
      ...baseSummary,
      status: "contributed",
      run_id: stringValue(run.id),
      contribution_id: contributionId,
      trust_label: stringValue(run.trustLabel),
      receipt_id: stringValue(objectValue(run.receiptSummary).receiptId),
      receipt_sha256: stringValue(objectValue(run.receiptSummary).receiptSha256),
      connection_cleanup: connectionCleanup,
    };
  } catch (error) {
    if (connectionId) {
      try {
        await revokeSmokeConnection(client, contributor, connectionId);
      } catch {
        // Keep the original trusted-run failure. A successful run only reports ok after cleanup succeeds.
      }
    }
    throw error;
  }
}

export async function runProductionChallengeLoopSmoke(options: {
  env?: ProductionChallengeLoopSmokeEnv;
  fetch?: ProductionChallengeLoopSmokeFetch;
  stdout?: ProductionChallengeLoopSmokeLogger;
  stderr?: ProductionChallengeLoopSmokeLogger;
  baseUrl?: string;
  allowMutation?: boolean;
  requireTrustedRun?: boolean;
  preflightOnly?: boolean;
  smokeId?: string;
} = {}): Promise<number> {
  const env = options.env || process.env;
  const stdout = options.stdout || console.log;
  const stderr = options.stderr || console.error;
  const fetchImpl = options.fetch || globalThis.fetch.bind(globalThis);
  const baseSource = options.baseUrl || process.argv[2] || env.CMAI_SMOKE_BASE_URL || "http://localhost:3000";
  const allowMutation = options.allowMutation ?? env.CMAI_SMOKE_ALLOW_MUTATION === "1";
  const requireTrustedRun = options.requireTrustedRun ?? env.CMAI_SMOKE_REQUIRE_TRUSTED_RUN === "1";
  const preflightOnly = options.preflightOnly ?? env.CMAI_SMOKE_PREFLIGHT_ONLY === "1";
  const smokeId = normalizeSmokeId(options.smokeId || env.CMAI_SMOKE_RUN_ID);

  try {
    const cleanupMode = cleanupModeFromEnv(env);
    const base = resolveBaseUrl(baseSource);
    const client = createClient(base, fetchImpl, env);
    const healthResponse = await client.request("/api/system/health", { method: "GET" }, undefined, { step: "health preflight" });
    const health = await readJsonResponse(healthResponse, "health preflight");
    assertProductionPreflight(base, health);
    await assertCanonicalRoutes(client);
    if (preflightOnly) {
      const summary = safeSummary({
        ok: true,
        mode: isLocalBase(base) ? "local_http_preflight" : "production_http_preflight",
        base: base.origin,
        mutation: false,
        health: {
          mode: stringValue(health.mode || objectValue(health.publicRuntime).runtimeMode),
          production_ready: boolValue(health.productionReady),
          auth_mode: stringValue(objectValue(health.publicRuntime).authMode),
          store_driver: stringValue(objectValue(health.publicRuntime).storeDriver),
        },
        canonical_routes: {
          home: true,
          lobby: true,
          answers: true,
          anonymous_new_challenge_redirect: "/login",
        },
        lanes: ["copy_prompt_paste_local_output", "run_my_agent_here"],
        trusted_lane_preflight: trustedLanePreflightSummary(health),
        manual_paste_fallback_available: true,
      });
      stdout(JSON.stringify(summary, null, 2));
      return 0;
    }
    assertTrustedRequiredPreflight(base, health, requireTrustedRun, env);
    assertCleanupConfiguredBeforeMutation(cleanupMode, env);
    assertMutationAllowed(base, allowMutation);

    const poster = await signupSmokeUser(client, "poster", smokeId, env);
    const contributor = await signupSmokeUser(client, "contributor", smokeId, env);
    const brief = buildSmokeBrief(smokeId);

    const challengeJson = await client.json("/api/challenges", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ brief, reward: 30, visibility: "public" }),
    }, poster.jar, "create challenge");
    const challenge = objectValue(challengeJson.challenge);
    const challengeId = stringValue(challenge.id);
    if (!challengeId) throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_CHALLENGE_MISSING", "Challenge creation did not return an id.");

    const promptJson = await client.json(`/api/challenges/${encodeURIComponent(challengeId)}/prompt?mode=critique`, { method: "GET" }, undefined, "load visible prompt");
    const prompt = stringValue(promptJson.prompt);
    if (!prompt.includes("CMAI_CONTRIBUTION_CARD_V1")) throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_PROMPT_CONTRACT_MISSING", "Visible prompt did not include the contribution-card contract.");

    const manualCard = buildManualCard(challengeId, smokeId);
    const parseJson = await client.json(`/api/challenges/${encodeURIComponent(challengeId)}/contributions/parse`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ raw: fencedContributionCard(manualCard) }),
    }, undefined, "parse manual contribution");
    if (parseJson.mismatch === true) throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_CARD_MISMATCH", "Manual contribution card unexpectedly mismatched the challenge id.");

    const manualContributionJson = await client.json(`/api/challenges/${encodeURIComponent(challengeId)}/contributions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ card: parseJson.card }),
    }, contributor.jar, "submit manual contribution");
    const manualContribution = objectValue(manualContributionJson.contribution);
    const manualContributionId = stringValue(manualContribution.id);
    if (!manualContributionId) throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_CONTRIBUTION_MISSING", "Manual contribution did not return an id.");

    const trustedLane = await maybeCheckTrustedLane(client, contributor, challengeId, { requireTrustedRun, smokeId, env });

    const ratingJson = await client.json(`/api/contributions/${encodeURIComponent(manualContributionId)}/ratings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usefulness: 9, safety: 9, comment: `Production smoke ${smokeId}: useful manual critique.` }),
    }, poster.jar, "rate manual contribution");
    const creditDelta = numberValue(ratingJson.creditDelta);
    if (creditDelta <= 0) throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_CREDIT_MISSING", "Poster rating did not mint a positive credit delta.");

    const repeatRatingJson = await client.json(`/api/contributions/${encodeURIComponent(manualContributionId)}/ratings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ usefulness: 9, safety: 9, comment: `Production smoke ${smokeId}: repeat rating should not duplicate.` }),
    }, poster.jar, "repeat manual contribution rating");
    if (numberValue(repeatRatingJson.creditDelta) !== 0) throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_DUPLICATE_CREDIT", "Repeating the same rating minted duplicate credits.");

    const synthesisJson = await client.json(`/api/challenges/${encodeURIComponent(challengeId)}/synthesis`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    }, poster.jar, "synthesize challenge", { timeoutMs: parseTimeoutMs(env.CMAI_SMOKE_LONG_REQUEST_TIMEOUT_MS, LONG_REQUEST_TIMEOUT_MS) });
    const artifactUrl = stringValue(synthesisJson.artifactUrl);
    if (artifactUrl !== `/answers/${challengeId}`) throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_ARTIFACT_URL_MISMATCH", "Synthesis did not return the expected answer artifact URL.");

    const artifactJson = await client.json(`/api/answers/${encodeURIComponent(challengeId)}/artifact`, { method: "GET" }, undefined, "load answer artifact");
    const artifact = objectValue(artifactJson.artifact);
    if (stringValue(artifact.id) !== challengeId) throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_ARTIFACT_MISMATCH", "Loaded answer artifact did not match challenge id.");

    let publicPageRendered = false;
    if (!isLocalBase(base)) {
      const artifactPageResponse = await client.request(artifactUrl, { method: "GET", headers: { accept: "text/html" } }, undefined, { step: "load public answer page" });
      const artifactPageHtml = await artifactPageResponse.text();
      if (!artifactPageResponse.ok || !artifactPageHtml.includes("decision artifact") || !artifactPageHtml.includes(challengeId)) {
        throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_ARTIFACT_PAGE_MISSING", `Public answer page did not render the synthesized artifact: HTTP ${artifactPageResponse.status} ${redact(artifactPageHtml.slice(0, 300))}`);
      }
      publicPageRendered = true;
    }

    const searchJson = await client.json(`/api/answers?q=${encodeURIComponent(smokeId)}&limit=5`, { method: "GET" }, undefined, "search answer artifacts");
    const foundInSearch = arrayValue(searchJson.artifacts).some((item) => objectValue(item).id === challengeId);
    if (!foundInSearch) throw new SmokeFailure("PRODUCTION_CHALLENGE_LOOP_SEARCH_MISSING", "Synthesized decision artifact was not searchable from /answers.");

    const cleanup = await cleanupSmokeChallenge(client, cleanupMode, challengeId, artifactUrl, smokeId, env);

    const summary = safeSummary({
      ok: true,
      mode: isLocalBase(base) ? "local_http_challenge_loop" : "production_http_challenge_loop",
      base: base.origin,
      smoke_id: smokeId,
      health: {
        mode: stringValue(health.mode || objectValue(health.publicRuntime).runtimeMode),
        production_ready: boolValue(health.productionReady),
        auth_mode: stringValue(objectValue(health.publicRuntime).authMode),
        store_driver: stringValue(objectValue(health.publicRuntime).storeDriver),
      },
      lanes: ["copy_prompt_paste_local_output", "run_my_agent_here"],
      trusted_lane_preflight: trustedLanePreflightSummary(health),
      visible_prompt_preview: true,
      manual_paste_fallback_available: true,
      poster_session: { created: true, csrf: "present" },
      contributor_session: { created: true, csrf: "present" },
      challenge_id: challengeId,
      manual_contribution: {
        id: manualContributionId,
        contributor_kind: stringValue(manualContribution.contributorKind),
        trust_label: stringValue(objectValue(objectValue(manualContribution.card).model_provenance).source),
      },
      trusted_lane: trustedLane,
      credits: {
        manual_delta: creditDelta,
        repeat_delta: numberValue(repeatRatingJson.creditDelta),
      },
      synthesis: {
        artifact_url: artifactUrl,
        confidence: stringValue(objectValue(synthesisJson.synthesis).confidence),
      },
      answer_artifact: {
        url: stringValue(artifact.artifactUrl),
        debate_url: stringValue(artifact.debateUrl),
        contribution_count: numberValue(artifact.contributionCount),
        useful_contribution_count: numberValue(artifact.usefulContributionCount),
        public_page_rendered: publicPageRendered,
        searchable: foundInSearch,
      },
      cleanup,
    });

    stdout(JSON.stringify(summary, null, 2));
    return 0;
  } catch (error) {
    const code = error instanceof SmokeFailure ? error.code : "PRODUCTION_CHALLENGE_LOOP_SMOKE_FAILED";
    const reason = error instanceof Error ? error.message : String(error);
    stderr(JSON.stringify(safeSummary({ ok: false, code, reason }), null, 2));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const exitCode = await runProductionChallengeLoopSmoke();
  process.exitCode = exitCode;
}
