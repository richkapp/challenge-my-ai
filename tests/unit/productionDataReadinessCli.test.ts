import { describe, expect, it } from "vitest";
import { runProductionDataReadinessCli } from "../../scripts/check-production-data-readiness";

describe("production data readiness CLI", () => {
  it("prints markdown dry-run output without executing backup or leaking secret-shaped values", () => {
    const result = runProductionDataReadinessCli(["--markdown"], {
      env: {
        NODE_ENV: "production",
        CMAI_RUNTIME_ENV: "production",
        DATABASE_URL: "postgresql://user:password@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
        SUPABASE_SERVICE_ROLE_KEY: "service_role_secret_should_not_print",
        RAILWAY_API_TOKEN: "railway_secret_should_not_print",
      },
      vercelProjectPath: "/tmp/definitely-missing-cmai-vercel-project.json",
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("production data readiness");
    expect(result.output).toContain("supabase db dump --db-url \"$DATABASE_URL\"");
    expect(result.output).toContain("Dry-run only");
    expect(result.output).not.toContain("user:password");
    expect(result.output).not.toContain("service_role_secret_should_not_print");
    expect(result.output).not.toContain("railway_secret_should_not_print");
  });

  it("can return redacted JSON and non-zero status for blocked production checks", () => {
    const result = runProductionDataReadinessCli(["--json", "--fail-on-blocked"], {
      env: {
        NODE_ENV: "production",
        CMAI_RUNTIME_ENV: "production",
        DATABASE_URL: "postgresql://user:password@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
        RAILWAY_API_TOKEN: "railway_secret_should_not_print",
      },
      vercelProjectPath: "/tmp/definitely-missing-cmai-vercel-project.json",
    });
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.output);
    expect(parsed.status).toBe("blocked");
    expect(parsed.schema.databaseUrlKind).toBe("supabase_pooler");
    expect(result.output).toContain("RAILWAY_API_TOKEN");
    expect(result.output).toContain("railwayDurableAuthConfigured");
    expect(result.output).toContain("RAILWAY_API_TOKEN is proof-only");
    expect(result.output).not.toContain("[redacted-railway-token] is proof-only");
    expect(result.output).not.toContain("user:password");
    expect(result.output).not.toContain("railway_secret_should_not_print");
  });
});
