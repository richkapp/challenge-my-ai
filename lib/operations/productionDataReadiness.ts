import { schemaVersion } from "@/db/schema";
import { env, authMode, isProductionLike, postgresConfigured, productionConfigIssues, railwaySandboxAuthMode, railwaySandboxDurableAuthIssues, runtimeMode, storeDriver, supabaseConfigured, trustedAgentRunReadiness, type RuntimeEnv } from "@/lib/config/env";

export type ReadinessStatus = "local_only" | "blocked" | "configured_needs_drill";
export type Presence = "present" | "missing";

export const durableStateCollections = [
  "challenges",
  "contributions",
  "ratings",
  "communityVotes",
  "creditEvents",
  "synthesisBriefs",
  "jobs",
  "moderationEvents",
  "agentProfiles",
  "agentWatches",
  "agentActivity",
  "agentHomes",
  "agentConnections",
  "agentCredentialVault",
  "runtimeSecrets",
  "modelProxyGrants",
  "agentRuns",
] as const;

export type DurableStateCollection = (typeof durableStateCollections)[number];

export const productionDataBackupSurfaces: Array<{
  surface: string;
  collections: DurableStateCollection[];
  rollbackConcern: string;
}> = [
  {
    surface: "challenge network",
    collections: ["challenges", "contributions", "ratings", "communityVotes", "synthesisBriefs"],
    rollbackConcern: "public threads, decision artifacts, contribution order, poster ratings, and community trust signals",
  },
  {
    surface: "credit and reputation economy",
    collections: ["creditEvents"],
    rollbackConcern: "credit balances, usefulness rewards, reversals, moderation adjustments, and idempotency keys",
  },
  {
    surface: "trusted Agent lane",
    collections: ["agentHomes", "agentConnections", "agentCredentialVault", "runtimeSecrets", "modelProxyGrants", "agentRuns", "jobs"],
    rollbackConcern: "Agent Home readiness, broker-side credential references, Railway OAuth refresh-token rotation state, one-run grants, receipts, job status, and run lifecycle",
  },
  {
    surface: "moderation and support",
    collections: ["moderationEvents"],
    rollbackConcern: "report/audit rows, suppression/restore actions, smoke cleanup, and rollback justification",
  },
  {
    surface: "agent-native activity",
    collections: ["agentProfiles", "agentWatches", "agentActivity"],
    rollbackConcern: "agent feed/watch/submission history and owner-visible audit trails",
  },
];

export const productionDataRunbookCommands = [
  {
    id: "backup_roles",
    label: "Dump roles before schema/data backup",
    command: 'supabase db dump --db-url "$DATABASE_URL" -f "$BACKUP_DIR/roles.sql" --role-only',
    destructive: false,
  },
  {
    id: "backup_schema",
    label: "Dump schema before mutation or deploy",
    command: 'supabase db dump --db-url "$DATABASE_URL" -f "$BACKUP_DIR/schema.sql"',
    destructive: false,
  },
  {
    id: "backup_data",
    label: "Dump app data using COPY format",
    command: 'supabase db dump --db-url "$DATABASE_URL" -f "$BACKUP_DIR/data.sql" --use-copy --data-only',
    destructive: false,
  },
  {
    id: "backup_migration_history",
    label: "Preserve Supabase migration history when present",
    command: 'supabase db dump --db-url "$DATABASE_URL" -f "$BACKUP_DIR/history_schema.sql" --schema supabase_migrations && supabase db dump --db-url "$DATABASE_URL" -f "$BACKUP_DIR/history_data.sql" --use-copy --data-only --schema supabase_migrations',
    destructive: false,
  },
  {
    id: "restore_drill",
    label: "Restore only into a disposable restore database first",
    command: 'psql --single-transaction --variable ON_ERROR_STOP=1 --file "$BACKUP_DIR/roles.sql" --file "$BACKUP_DIR/schema.sql" --command "SET session_replication_role = replica" --file "$BACKUP_DIR/data.sql" --dbname "$RESTORE_DATABASE_URL"',
    destructive: true,
  },
  {
    id: "post_restore_health",
    label: "Verify app health against the restore target before any cutover",
    command: 'CMAI_RUNTIME_ENV=production CMAI_AUTH_MODE=supabase CMAI_STORE_DRIVER=postgres DATABASE_URL="$RESTORE_DATABASE_URL" bun run smoke:auth -- "$RESTORE_APP_URL"',
    destructive: false,
  },
  {
    id: "vercel_rollback_placeholder",
    label: "Rollback app code only after data compatibility is checked",
    command: 'vercel rollback "$VERCEL_DEPLOYMENT_URL" --yes  # placeholder; requires explicit production approval',
    destructive: true,
  },
] as const;

type EnvRequirement = {
  key: string;
  present: Presence;
  purpose: string;
  secret: boolean;
};

type ProductionDataReadinessOptions = {
  vercelProjectLinked?: boolean;
};

function present(value: unknown): Presence {
  return value ? "present" : "missing";
}

function databaseUrlKind(runtime: RuntimeEnv) {
  if (!runtime.DATABASE_URL) return "missing";
  try {
    const hostname = new URL(runtime.DATABASE_URL).hostname;
    if (hostname.includes("pooler.supabase.com")) return "supabase_pooler";
    if (hostname.startsWith("db.") && hostname.endsWith(".supabase.co")) return "supabase_direct_ipv6_risk";
    if (["localhost", "127.0.0.1"].includes(hostname)) return "local_database";
    return "configured_external";
  } catch {
    return "unparseable";
  }
}

function envRequirement(key: string, value: unknown, purpose: string, secret = true): EnvRequirement {
  return { key, present: present(value), purpose, secret };
}

function uncoveredBackupCollections() {
  const covered = new Set<DurableStateCollection>();
  for (const surface of productionDataBackupSurfaces) {
    for (const collection of surface.collections) covered.add(collection);
  }
  return durableStateCollections.filter((collection) => !covered.has(collection));
}

export function productionDataReadiness(runtime: RuntimeEnv = env, options: ProductionDataReadinessOptions = {}) {
  const productionLike = isProductionLike(runtime);
  const baseIssues = productionConfigIssues(runtime);
  const railwayDurableAuth = railwaySandboxDurableAuthIssues(runtime);
  const trustedAgentRun = trustedAgentRunReadiness(runtime);
  const uncoveredCollections = uncoveredBackupCollections();
  const runtimeVercelLinked = ["1", "true", "yes"].includes((runtime.CMAI_VERCEL_PROJECT_LINKED || "").toLowerCase());
  const runtimeVercelMissing = ["0", "false", "no"].includes((runtime.CMAI_VERCEL_PROJECT_LINKED || "").toLowerCase());
  const vercelProject = options.vercelProjectLinked === undefined ? runtimeVercelLinked ? "linked" : runtimeVercelMissing ? "missing" : "unknown" : options.vercelProjectLinked ? "linked" : "missing";
  const configIssues = [
    ...baseIssues,
    ...(productionLike && vercelProject !== "linked" ? ["CMAI_VERCEL_PROJECT_LINKED=1 or .vercel/project.json is required for production deploy/rollback targeting"] : []),
    ...trustedAgentRun.configIssues,
    ...(uncoveredCollections.length ? [`Backup surface map is missing: ${uncoveredCollections.join(", ")}`] : []),
  ];
  const status: ReadinessStatus = productionLike ? (configIssues.length ? "blocked" : "configured_needs_drill") : "local_only";

  return {
    status,
    ok: !productionLike || configIssues.length === 0,
    productionLike,
    runtimeMode: runtimeMode(runtime),
    authMode: authMode(runtime),
    storeDriver: storeDriver(runtime),
    schema: {
      adapter: "jsonb_state_snapshot",
      table: "cmai_state",
      rowId: "default",
      schemaVersion,
      relationalDefinitionsPresent: true,
      migrationPosture: "jsonb_state_snapshot_now_relational_tables_future",
      databaseUrlKind: databaseUrlKind(runtime),
    },
    providers: {
      supabaseAuthConfigured: supabaseConfigured(runtime),
      postgresConfigured: postgresConfigured(runtime),
      vercelProject,
      railwaySandbox: {
        token: present(runtime.RAILWAY_API_TOKEN),
        oauthRefreshToken: present(runtime.RAILWAY_OAUTH_REFRESH_TOKEN),
        oauthClientId: present(runtime.RAILWAY_OAUTH_CLIENT_ID),
        environmentId: present(runtime.RAILWAY_ENVIRONMENT_ID),
        checkpoint: runtime.RAILWAY_SANDBOX_CHECKPOINT ? "custom" : "default_approved",
        authMode: railwaySandboxAuthMode(runtime),
        durableAuthStatus: railwayDurableAuth.length === 0 ? "configured" : "blocked_until_durable_auth",
      },
    },
    requiredEnv: [
      envRequirement("CMAI_RUNTIME_ENV", runtime.CMAI_RUNTIME_ENV, "must be explicitly production for production launch checks", false),
      envRequirement("CMAI_AUTH_MODE", authMode(runtime), "must resolve to supabase in production", false),
      envRequirement("CMAI_STORE_DRIVER", storeDriver(runtime), "must resolve to postgres in production", false),
      envRequirement("DATABASE_URL", runtime.DATABASE_URL, "Supabase Postgres shared-pooler connection"),
      envRequirement("NEXT_PUBLIC_SUPABASE_URL", runtime.NEXT_PUBLIC_SUPABASE_URL, "Supabase Auth public URL", false),
      envRequirement("NEXT_PUBLIC_SUPABASE_ANON_KEY", runtime.NEXT_PUBLIC_SUPABASE_ANON_KEY, "Supabase Auth browser key"),
      envRequirement("SUPABASE_SERVICE_ROLE_KEY", runtime.SUPABASE_SERVICE_ROLE_KEY, "server-confirmed signup/admin auth"),
      envRequirement("CMAI_AGENT_API_SECRET", runtime.CMAI_AGENT_API_SECRET, "signed Agent API requests"),
      envRequirement("CMAI_VERCEL_PROJECT_LINKED", runtime.CMAI_VERCEL_PROJECT_LINKED, "non-secret confirmation that production deploy/rollback targets the linked Vercel project", false),
      envRequirement("CMAI_RECEIPT_SIGNING_KEY_ID", runtime.CMAI_RECEIPT_SIGNING_KEY_ID, "trusted-run receipt key id", false),
      envRequirement("CMAI_RECEIPT_SIGNING_SECRET", runtime.CMAI_RECEIPT_SIGNING_SECRET, "trusted-run receipt signing"),
      envRequirement("CMAI_AGENT_BROKER_VAULT_MODE", runtime.CMAI_AGENT_BROKER_VAULT_MODE, "broker credential vault mode", false),
      envRequirement("CMAI_AGENT_BROKER_VAULT_URL", runtime.CMAI_AGENT_BROKER_VAULT_URL, "external broker vault URL"),
      envRequirement("CMAI_AGENT_BROKER_VAULT_SECRET", runtime.CMAI_AGENT_BROKER_VAULT_SECRET, "broker vault sealing secret"),
      envRequirement("CMAI_MODEL_PROXY_URL", runtime.CMAI_MODEL_PROXY_URL, "broker-side model proxy"),
      envRequirement("CMAI_MODEL_PROXY_GRANT_STORE", runtime.CMAI_MODEL_PROXY_GRANT_STORE, "durable grant store mode", false),
      envRequirement("RAILWAY_API_TOKEN", runtime.RAILWAY_API_TOKEN, "proof-only Railway Sandbox API access when RAILWAY_SANDBOX_AUTH_MODE=api_token"),
      envRequirement("RAILWAY_ENVIRONMENT_ID", runtime.RAILWAY_ENVIRONMENT_ID, "Railway Sandbox environment"),
      envRequirement("RAILWAY_SANDBOX_AUTH_MODE", railwaySandboxAuthMode(runtime), "api_token proof-only or oauth_refresh durable Railway access", false),
      envRequirement("RAILWAY_OAUTH_REFRESH_TOKEN", runtime.RAILWAY_OAUTH_REFRESH_TOKEN, "bootstrap token for broker-side Railway OAuth refresh"),
      envRequirement("RAILWAY_OAUTH_CLIENT_ID", runtime.RAILWAY_OAUTH_CLIENT_ID, "Railway OAuth app/client id for refresh-token exchange", false),
    ],
    backup: {
      stateCollections: durableStateCollections,
      surfaces: productionDataBackupSurfaces,
      uncoveredCollections,
      strategy: "Supabase dashboard/PITR when enabled plus logical supabase db dump before deploy/migration; restore drills must target disposable databases before cutover",
      commands: productionDataRunbookCommands.map(({ id, label, command, destructive }) => ({ id, label, command, destructive, dryRunOnly: true })),
    },
    issues: configIssues,
    trustedAgentRun,
    notes: [
      "Current production store is cmai_state JSONB snapshot; full relational table definitions are present but not the active migration target for this card.",
      "RAILWAY_SANDBOX_AUTH_MODE=oauth_refresh uses Railway OAuth refresh tokens and persists rotated refresh tokens in runtimeSecrets; api_token mode remains proof-only for launch.",
      "Runbook commands are placeholders for an approved operator shell; this module never executes backup, restore, rollback, deploy, or external-service calls.",
    ],
  };
}

export type ProductionDataReadiness = ReturnType<typeof productionDataReadiness>;

export function renderProductionDataReadinessMarkdown(readiness: ProductionDataReadiness) {
  const lines = [
    "# Challenge My AI production data readiness",
    "",
    `Status: ${readiness.status}`,
    `Runtime: ${readiness.runtimeMode}`,
    `Store: ${readiness.storeDriver}`,
    `Schema: ${readiness.schema.table} v${readiness.schema.schemaVersion} (${readiness.schema.adapter})`,
    "",
    "## Issues",
    ...(readiness.issues.length ? readiness.issues.map((issue) => `- ${issue}`) : ["- none for this local/dry-run context"]),
    "",
    "## Required environment",
    ...readiness.requiredEnv.map((item) => `- ${item.key}: ${item.present} — ${item.purpose}`),
    "",
    "## Backup surfaces",
    ...readiness.backup.surfaces.map((surface) => `- ${surface.surface}: ${surface.collections.join(", ")} — ${surface.rollbackConcern}`),
    "",
    "## Dry-run commands",
    ...readiness.backup.commands.map((step) => `- ${step.id}: ${step.command}`),
    "",
    "Dry-run only. Do not execute backup, restore, rollback, deploy, credential, billing, or production-data actions without explicit current approval.",
  ];
  return lines.join("\n");
}
