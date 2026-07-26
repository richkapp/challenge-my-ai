import { migrateAgentFeedStateV1 } from "@/lib/store/agentFeed";

export const AGENT_FEED_STATE_V1_MIGRATION_ID = "2026-07-15-agent-feed-state-v1" as const;

const EMPTY_AGENT_FEED_STATE_V1 = {
  schemaVersion: 1,
  requestReceipts: [],
  responseCache: [],
  snapshots: [],
  runGrants: [],
  submissionReceipts: [],
} as const;

const EMPTY_AGENT_FEED_STATE_V2 = {
  ...EMPTY_AGENT_FEED_STATE_V1,
  schemaVersion: 2,
  submissionRequestReceipts: [],
} as const;

// Apply only through the reviewed production migration path. Protocol routes never execute this DDL/DML.
export const AGENT_FEED_STATE_V1_SQL = `
UPDATE cmai_state
SET state = jsonb_set(
  state,
  '{agentFeedState}',
  '${JSON.stringify(EMPTY_AGENT_FEED_STATE_V1)}'::jsonb,
  true
), updated_at = now()
WHERE id = 'default'
  AND NOT (state ? 'agentFeedState');
`.trim();

// Safe only before feed traffic. It removes the field only while it is still exactly empty.
export const AGENT_FEED_STATE_V1_ROLLBACK_SQL = `
UPDATE cmai_state
SET state = state - 'agentFeedState', updated_at = now()
WHERE id = 'default'
  AND state->'agentFeedState' = '${JSON.stringify(EMPTY_AGENT_FEED_STATE_V2)}'::jsonb;
`.trim();

export { migrateAgentFeedStateV1 };
