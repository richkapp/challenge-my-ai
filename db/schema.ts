import { integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const challenges = pgTable("challenges", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  posterId: text("poster_id").notNull(),
  status: text("status").notNull(),
  title: text("title").notNull(),
  category: text("category").notNull(),
  visibility: text("visibility").notNull(),
  reward: integer("reward").notNull(),
  requestedModes: text("requested_modes").notNull(),
  briefJson: text("brief_json").notNull(),
  safetyFlags: text("safety_flags").notNull(),
});

export const contributions = pgTable("contributions", {
  id: text("id").primaryKey(),
  challengeId: text("challenge_id").notNull(),
  contributorId: text("contributor_id").notNull(),
  createdAt: text("created_at").notNull(),
  status: text("status").notNull(),
  externallyGenerated: integer("externally_generated").notNull(),
  cardJson: text("card_json").notNull(),
  communityScore: integer("community_score").notNull().default(0),
});

export const ratings = pgTable("ratings", {
  id: text("id").primaryKey(),
  contributionId: text("contribution_id").notNull(),
  raterId: text("rater_id").notNull(),
  usefulness: integer("usefulness").notNull(),
  novelty: integer("novelty").notNull(),
  correctness: integer("correctness").notNull(),
  safety: integer("safety").notNull(),
  comment: text("comment").notNull(),
  createdAt: text("created_at").notNull(),
});

export const creditEvents = pgTable("credit_events", {
  id: text("id").primaryKey(),
  createdAt: text("created_at").notNull(),
  userId: text("user_id").notNull(),
  challengeId: text("challenge_id"),
  contributionId: text("contribution_id"),
  amount: integer("amount").notNull(),
  reason: text("reason").notNull(),
});

export const jobs = pgTable("jobs", {
  id: text("id").primaryKey(),
  challengeId: text("challenge_id"),
  kind: text("kind").notNull(),
  status: text("status").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  latencyMs: integer("latency_ms"),
  costCents: integer("cost_cents"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const agentHomes = pgTable("agent_homes", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  ownerLabel: text("owner_label").notNull(),
  setupStatus: text("setup_status").notNull(),
  connectionsJson: jsonb("connections_json").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  lastActivityAt: text("last_activity_at"),
});

export const agentConnections = pgTable("agent_connections", {
  id: text("id").primaryKey(),
  agentHomeId: text("agent_home_id").notNull(),
  ownerId: text("owner_id").notNull(),
  displayLabel: text("display_label").notNull(),
  provider: text("provider").notNull(),
  providerLabel: text("provider_label").notNull(),
  connectionKind: text("connection_kind").notNull(),
  status: text("status").notNull(),
  readinessJson: jsonb("readiness_json").notNull(),
  defaultModel: text("default_model").notNull(),
  allowedModels: jsonb("allowed_models").notNull(),
  allowedRequestClasses: jsonb("allowed_request_classes").notNull(),
  metadataVerification: text("metadata_verification").notNull(),
  exactModelMetadata: integer("exact_model_metadata").notNull(),
  sandboxTrustLabel: text("sandbox_trust_label").notNull(),
  setupInstructions: text("setup_instructions").notNull(),
  lastSmokeJson: jsonb("last_smoke_json").notNull(),
  credentialRef: text("credential_ref"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const agentRuns = pgTable("agent_runs", {
  id: text("id").primaryKey(),
  challengeId: text("challenge_id").notNull(),
  contributorId: text("contributor_id").notNull(),
  agentHomeId: text("agent_home_id").notNull(),
  connectionId: text("connection_id").notNull(),
  requestedMode: text("requested_mode").notNull(),
  requestedModel: text("requested_model"),
  requestClass: text("request_class").notNull(),
  status: text("status").notNull(),
  idempotencyKey: text("idempotency_key"),
  jobId: text("job_id"),
  contributionId: text("contribution_id"),
  delegationJson: jsonb("delegation_json"),
  receiptSummaryJson: jsonb("receipt_summary_json"),
  failureJson: jsonb("failure_json"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  queuedAt: text("queued_at").notNull(),
  startedAt: text("started_at"),
  validatingAt: text("validating_at"),
  contributedAt: text("contributed_at"),
  failedAt: text("failed_at"),
});

export const appState = pgTable("cmai_state", {
  id: text("id").primaryKey(),
  state: jsonb("state").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const schemaVersion = 3;
