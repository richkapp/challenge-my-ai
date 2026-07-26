import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function repoFile(path: string) {
  return readFileSync(join(process.cwd(), path), "utf8");
}

describe("launch verification suite wiring", () => {
  it("exposes repeatable local CI and launch smoke commands", () => {
    const pkg = JSON.parse(repoFile("package.json")) as { scripts: Record<string, string> };

    expect(pkg.scripts["verify:ci"]).toContain("bun run lint");
    expect(pkg.scripts["verify:ci"]).toContain("bun run typecheck");
    expect(pkg.scripts["verify:ci"]).toContain("bun run test");
    expect(pkg.scripts["verify:ci"]).toContain("bun run build");
    expect(pkg.scripts["verify:ci"]).toContain("env -u DATABASE_URL");

    expect(pkg.scripts["verify:launch:local"]).toContain("smoke:live-challenge-loop");
    expect(pkg.scripts["verify:launch:local"]).toContain("smoke:agent-home-run");
    expect(pkg.scripts["verify:launch:local"]).toContain("smoke:local-http-challenge-loop");
    expect(pkg.scripts["verify:launch:preflight"]).toContain("CMAI_SMOKE_PREFLIGHT_ONLY=1");
  });

  it("keeps GitHub CI non-mutating while allowing manual read-only preflight", () => {
    const workflow = repoFile(".github/workflows/launch-verification.yml");

    expect(workflow).toContain("bun run verify:ci");
    expect(workflow).toContain("bun run verify:launch:local");
    expect(workflow).toContain("workflow_dispatch");
    expect(workflow).toContain("CMAI_SMOKE_PREFLIGHT_ONLY: \"1\"");
    expect(workflow).toContain("smoke:production-challenge-loop");
    expect(workflow).not.toContain("CMAI_SMOKE_ALLOW_MUTATION");
    expect(workflow).not.toContain("CMAI_SMOKE_REQUIRE_TRUSTED_RUN: \"1\"");
  });

  it("runs local HTTP smoke against preview/local start without inherited production database", () => {
    const script = repoFile("scripts/smoke-local-http-challenge-loop.mjs");

    expect(script).toContain("delete env.DATABASE_URL");
    expect(script).toContain('env.CMAI_RUNTIME_ENV = "preview"');
    expect(script).toContain('env.CMAI_AUTH_MODE = "local"');
    expect(script).toContain('env.CMAI_STORE_DRIVER = "local"');
    expect(script).toContain("scripts/smoke-production-challenge-loop.ts");
    expect(script).toContain("/api/system/health");
  });
});
