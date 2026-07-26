import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadEnv, type RuntimeEnv } from "../lib/config/env";
import { productionDataReadiness, renderProductionDataReadinessMarkdown } from "../lib/operations/productionDataReadiness";

export type ProductionDataReadinessCliResult = {
  exitCode: number;
  output: string;
  readiness: ReturnType<typeof productionDataReadiness>;
};

type CliOptions = {
  json?: boolean;
  markdown?: boolean;
  failOnBlocked?: boolean;
  env?: Record<string, string | undefined>;
  vercelProjectPath?: string;
};

function parseArgs(args: string[]) {
  return {
    json: args.includes("--json"),
    markdown: args.includes("--markdown") || !args.includes("--json"),
    failOnBlocked: args.includes("--fail-on-blocked"),
  };
}

const secretValueKeyPattern = /(secret|token|dsn|password|private|credential|databaseUrl|database_url|refresh)/i;
const safePresenceValues = new Set(["", "present", "missing", "configured", "unconfigured", "api_token", "oauth_refresh", "supabase_pooler", "supabase_direct_ipv6_risk", "local_database", "configured_external", "unparseable"]);

function redactString(value: string) {
  return value
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "postgres://[redacted]")
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "[redacted-secret]")
    .replace(/service_role_[A-Za-z0-9_-]+/g, "[redacted-service-role]")
    .replace(/railway[_-][a-z0-9][a-z0-9_-]{8,}/g, "[redacted-railway-token]");
}

function redactForJson(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => redactForJson(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactForJson(entryValue, entryKey)]));
  }
  if (typeof value !== "string") return value;
  const redacted = redactString(value);
  if (key !== "key" && secretValueKeyPattern.test(key) && !safePresenceValues.has(redacted)) return "[redacted]";
  return redacted;
}

function redactedJson(value: unknown) {
  return JSON.stringify(redactForJson(value), null, 2);
}

export function runProductionDataReadinessCli(args: string[] = [], options: CliOptions = {}): ProductionDataReadinessCliResult {
  const parsed = parseArgs(args);
  const runtime: RuntimeEnv = loadEnv({ ...process.env, ...(options.env || {}) });
  const vercelProjectPath = options.vercelProjectPath || ".vercel/project.json";
  const readiness = productionDataReadiness(runtime, { vercelProjectLinked: existsSync(vercelProjectPath) });
  const output = parsed.json ? redactedJson(readiness) : renderProductionDataReadinessMarkdown(readiness);
  const exitCode = parsed.failOnBlocked && readiness.status === "blocked" ? 1 : 0;
  return { exitCode, output, readiness };
}

async function main() {
  const result = runProductionDataReadinessCli(process.argv.slice(2));
  console.log(result.output);
  process.exitCode = result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
