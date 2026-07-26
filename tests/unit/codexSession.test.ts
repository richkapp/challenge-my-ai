import { describe, expect, it } from "vitest";
import {
  CodexSessionImportError,
  codexAuthCachePublicMetadata,
  parseCodexAuthCache,
  parseCodexAuthCacheSecret,
  serializeCodexAuthCache,
} from "@/lib/agent-home/codexSession";

const validAuthCache = {
  auth_mode: "chatgpt",
  tokens: {
    id_token: "codex-id-token-fixture-123456",
    access_token: "codex-access-token-fixture-123456",
    refresh_token: "codex-refresh-token-fixture-123456",
    account_id: "acct_fixture_123456",
  },
  last_refresh: "2026-07-07T00:00:00.000Z",
};

describe("Codex managed ChatGPT auth cache", () => {
  it("validates file-backed ChatGPT auth.json and exposes safe metadata only", () => {
    const parsed = parseCodexAuthCache(validAuthCache);

    expect(parsed).toMatchObject({ auth_mode: "chatgpt", last_refresh: "2026-07-07T00:00:00.000Z" });
    expect(codexAuthCachePublicMetadata(parsed)).toEqual({
      auth_mode: "chatgpt",
      last_refresh: "2026-07-07T00:00:00.000Z",
      account_hint: "…123456",
    });
    expect(JSON.stringify(codexAuthCachePublicMetadata(parsed))).not.toContain("codex-access-token");
    expect(JSON.stringify(codexAuthCachePublicMetadata(parsed))).not.toContain("codex-refresh-token");
    expect(JSON.stringify(codexAuthCachePublicMetadata(parsed))).not.toContain("codex-id-token");
  });

  it("round-trips the complete managed cache for encrypted broker persistence", () => {
    const serialized = serializeCodexAuthCache(validAuthCache);
    const parsed = parseCodexAuthCacheSecret(serialized);

    expect(parsed.tokens).toMatchObject({
      access_token: "codex-access-token-fixture-123456",
      refresh_token: "codex-refresh-token-fixture-123456",
    });
  });

  it("preserves forward-compatible Codex fields while validating the required outer contract", () => {
    const parsed = parseCodexAuthCache({
      ...validAuthCache,
      client_version: "0.144.0",
      tokens: { ...validAuthCache.tokens, future_claim: "kept-for-codex" },
    });

    expect(parsed).toMatchObject({ client_version: "0.144.0" });
    expect(parsed.tokens).toMatchObject({ future_claim: "kept-for-codex" });
  });

  it("rejects API-key mode, missing refresh state, raw tokens, and malformed JSON", () => {
    expect(() => parseCodexAuthCacheSecret("«redacted:sk-…»")).toThrow(CodexSessionImportError);
    expect(() => parseCodexAuthCache({ auth_mode: "api", OPENAI_API_KEY: "«redacted:sk-…»" })).toThrow(CodexSessionImportError);
    expect(() => parseCodexAuthCache({ ...validAuthCache, tokens: { ...validAuthCache.tokens, refresh_token: "" } })).toThrow(CodexSessionImportError);
    expect(() => parseCodexAuthCache({ ...validAuthCache, last_refresh: "not-a-date" })).toThrow(CodexSessionImportError);
    expect(() => parseCodexAuthCacheSecret("not-json")).toThrow(CodexSessionImportError);
  });
});
