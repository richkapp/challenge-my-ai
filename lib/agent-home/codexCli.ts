import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseCodexAuthCache, type CodexAuthCache } from "@/lib/agent-home/codexSession";

const defaultLoginTimeoutMs = 13 * 60 * 1_000;
const maxProtocolLineBytes = 1_000_000;

export const codexDeviceLoginProductionTimeoutMs = 270_000;

export type CodexDeviceLoginEvent =
  | { type: "device_code"; verificationUrl: string; userCode: string }
  | { type: "connected"; planType?: string };

export type CodexDeviceLoginResult = {
  authCache: CodexAuthCache;
  planType?: string;
};

export class CodexCliError extends Error {
  constructor(readonly code: string, message: string, readonly status = 502) {
    super(message);
  }
}

type CodexCommand = { command: string; prefixArgs: string[] };

export function codexProcessEnv(codexHome: string): NodeJS.ProcessEnv {
  const allowed = ["PATH", "LANG", "LC_ALL", "TZ"] as const;
  const inherited = Object.fromEntries(allowed.flatMap((key) => process.env[key] ? [[key, process.env[key]]] : []));
  return {
    ...inherited,
    NODE_ENV: process.env.NODE_ENV || "production",
    HOME: codexHome,
    CODEX_HOME: codexHome,
    TMPDIR: codexHome,
    TMP: codexHome,
    TEMP: codexHome,
    NO_COLOR: "1",
    RUST_LOG: "off",
  };
}

export function resolveCodexCommand(): CodexCommand {
  const configured = process.env.CMAI_CODEX_EXECUTABLE || process.env.CMAI_CODEX_CLI_BIN;
  if (configured) {
    return /\.(?:c?m?js|ts)$/i.test(configured)
      ? { command: process.execPath, prefixArgs: [configured] }
      : { command: configured, prefixArgs: [] };
  }
  if (process.env.VERCEL && process.platform === "linux" && process.arch === "x64") {
    return { command: "/var/task/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex", prefixArgs: [] };
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return { command: "node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex", prefixArgs: [] };
  }
  return { command: process.execPath, prefixArgs: ["node_modules/@openai/codex/bin/codex.js"] };
}

function appServerMessage(line: string): Record<string, unknown> | undefined {
  if (Buffer.byteLength(line, "utf8") > maxProtocolLineBytes) return undefined;
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function send(child: ChildProcessWithoutNullStreams, message: unknown): void {
  if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
}

function boundedProtocolString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : undefined;
}

function openAiDeviceVerificationUrl(value: unknown): string | undefined {
  const raw = boundedProtocolString(value, 2_048);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.hostname === "auth.openai.com" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

async function stopCodexChild(child: ChildProcessWithoutNullStreams | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, "close").then(() => true, () => true);
  child.kill("SIGTERM");
  const stopped = await Promise.race([closed, delay(500, false, { ref: false })]);
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([closed, delay(1_000, true, { ref: false })]);
  }
}

export async function runCodexDeviceLogin(input: {
  signal?: AbortSignal;
  timeoutMs?: number;
  onEvent?: (event: CodexDeviceLoginEvent) => void | Promise<void>;
} = {}): Promise<CodexDeviceLoginResult> {
  const root = await mkdtemp(path.join(tmpdir(), "cmai-codex-login-"));
  const command = resolveCodexCommand();
  const timeoutMs = Math.max(1_000, Math.min(input.timeoutMs || defaultLoginTimeoutMs, defaultLoginTimeoutMs));
  await writeFile(path.join(root, "config.toml"), 'cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\n', { mode: 0o600 });

  let child: ChildProcessWithoutNullStreams | undefined;
  let loginId: string | undefined;
  let planType: string | undefined;
  let settled = false;
  let timeout: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;

  try {
    return await new Promise<CodexDeviceLoginResult>((resolve, reject) => {
      const finishReject = (error: CodexCliError) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (onAbort) input.signal?.removeEventListener("abort", onAbort);
        reject(error);
      };
      const cancel = () => {
        if (loginId && child) send(child, { method: "account/login/cancel", id: 3, params: { loginId } });
      };
      onAbort = () => {
        cancel();
        finishReject(new CodexCliError("CODEX_DEVICE_LOGIN_CANCELLED", "Codex device login was cancelled.", 499));
      };

      if (input.signal?.aborted) return onAbort();
      input.signal?.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => {
        cancel();
        finishReject(new CodexCliError("CODEX_DEVICE_LOGIN_EXPIRED", "Codex device login expired before authorization completed.", 408));
      }, timeoutMs);
      timeout.unref();

      try {
        child = spawn(command.command, [...command.prefixArgs, "app-server"], {
          env: codexProcessEnv(root),
          stdio: ["pipe", "pipe", "pipe"],
        });
        // The child can exit between the writable-state check and a best-effort cancel write.
        // Process close/error owns the login outcome; contain late pipe teardown locally.
        child.stdin.on("error", () => undefined);
      } catch {
        finishReject(new CodexCliError("CODEX_CLI_UNAVAILABLE", "The Codex runtime could not start.", 503));
        return;
      }

      child.once("error", () => finishReject(new CodexCliError("CODEX_CLI_UNAVAILABLE", "The Codex runtime could not start.", 503)));
      child.stderr.resume();

      let pending = Buffer.alloc(0);
      let processing = Promise.resolve();
      const handleLine = async (line: string) => {
        const message = appServerMessage(line);
        if (!message || settled) return;
        if (message.id === 1 && message.result) {
          send(child!, { method: "initialized", params: {} });
          send(child!, { method: "account/login/start", id: 2, params: { type: "chatgptDeviceCode" } });
          return;
        }
        if (message.id === 2) {
          const result = message.result as Record<string, unknown> | undefined;
          const nextLoginId = boundedProtocolString(result?.loginId, 256);
          const verificationUrl = openAiDeviceVerificationUrl(result?.verificationUrl);
          const userCode = boundedProtocolString(result?.userCode, 64);
          if (!result || result.type !== "chatgptDeviceCode" || !nextLoginId || !verificationUrl || !userCode) {
            cancel();
            finishReject(new CodexCliError("CODEX_DEVICE_LOGIN_PROTOCOL_INVALID", "Codex returned an invalid device-login response."));
            return;
          }
          loginId = nextLoginId;
          await input.onEvent?.({ type: "device_code", verificationUrl, userCode });
          return;
        }
        if (message.method === "account/updated") {
          const params = message.params as Record<string, unknown> | undefined;
          if (typeof params?.planType === "string") planType = params.planType;
          return;
        }
        if (message.method === "account/login/completed") {
          const params = message.params as Record<string, unknown> | undefined;
          if (params?.success !== true || (loginId && params.loginId !== loginId)) {
            cancel();
            finishReject(new CodexCliError("CODEX_DEVICE_LOGIN_FAILED", "Codex device authorization was not completed."));
            return;
          }
          try {
            const authCache = parseCodexAuthCache(JSON.parse(await readFile(path.join(/*turbopackIgnore: true*/ root, "auth.json"), "utf8")) as unknown);
            await input.onEvent?.({ type: "connected", ...(planType ? { planType } : {}) });
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            if (onAbort) input.signal?.removeEventListener("abort", onAbort);
            resolve({ authCache, ...(planType ? { planType } : {}) });
          } catch {
            finishReject(new CodexCliError("CODEX_AUTH_CACHE_INVALID", "Codex completed login but did not produce a valid managed auth cache."));
          }
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        pending = Buffer.concat([pending, Buffer.from(chunk)]);
        let newline = pending.indexOf(0x0a);
        while (newline >= 0) {
          let lineBytes = pending.subarray(0, newline);
          pending = pending.subarray(newline + 1);
          if (lineBytes.at(-1) === 0x0d) lineBytes = lineBytes.subarray(0, -1);
          if (lineBytes.length > maxProtocolLineBytes) {
            finishReject(new CodexCliError("CODEX_DEVICE_LOGIN_PROTOCOL_TOO_LARGE", "Codex returned an oversized device-login response.", 502));
            return;
          }
          const line = lineBytes.toString("utf8");
          processing = processing.then(() => handleLine(line)).catch(() => {
            finishReject(new CodexCliError("CODEX_DEVICE_LOGIN_PROTOCOL_INVALID", "Codex returned an invalid device-login response.", 502));
          });
          newline = pending.indexOf(0x0a);
        }
        if (pending.length > maxProtocolLineBytes) {
          finishReject(new CodexCliError("CODEX_DEVICE_LOGIN_PROTOCOL_TOO_LARGE", "Codex returned an oversized device-login response.", 502));
        }
      });
      child.once("close", (code) => {
        void processing.finally(() => {
          if (!settled) finishReject(new CodexCliError("CODEX_DEVICE_LOGIN_FAILED", code === null ? "Codex device login stopped unexpectedly." : "Codex device login did not complete.", 502));
        });
      });

      send(child, {
        method: "initialize",
        id: 1,
        params: {
          clientInfo: { name: "challenge_my_ai", title: "Challenge My AI", version: "0.1.0" },
          capabilities: { optOutNotificationMethods: [] },
        },
      });
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (onAbort) input.signal?.removeEventListener("abort", onAbort);
    await stopCodexChild(child);
    await rm(root, { recursive: true, force: true });
  }
}
