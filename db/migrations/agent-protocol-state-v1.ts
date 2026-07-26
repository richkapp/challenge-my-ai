import postgres from "postgres";
import {
  AGENT_FEED_STATE_V1_MIGRATION_ID,
  AGENT_FEED_STATE_V1_ROLLBACK_SQL,
  AGENT_FEED_STATE_V1_SQL,
} from "@/db/migrations/agent-feed-state-v1";
import { AGENT_FEED_STATE_V2_MIGRATION_ID, migrateAgentFeedStateV2 } from "@/db/migrations/agent-feed-state-v2";
import {
  AGENT_PAIRING_STATE_V1_MIGRATION_ID,
  AGENT_PAIRING_STATE_V1_ROLLBACK_SQL,
  AGENT_PAIRING_STATE_V1_SQL,
} from "@/db/migrations/agent-pairing-state-v1";
import { assertPairingPlatformStateV1 } from "@/lib/agent-pairing/storage";
import { assertAgentProtocolStateCoherence, hasReadyAgentFeedState } from "@/lib/store/agentFeed";

export const AGENT_PROTOCOL_STATE_MIGRATION_CONFIRMATION = [
  AGENT_FEED_STATE_V1_MIGRATION_ID,
  AGENT_PAIRING_STATE_V1_MIGRATION_ID,
  AGENT_FEED_STATE_V2_MIGRATION_ID,
].join(",");
export const AGENT_PROTOCOL_STATE_ROLLBACK_CONFIRMATION = `ROLLBACK:${AGENT_PROTOCOL_STATE_MIGRATION_CONFIRMATION}`;

const migrationIds = [AGENT_FEED_STATE_V1_MIGRATION_ID, AGENT_PAIRING_STATE_V1_MIGRATION_ID, AGENT_FEED_STATE_V2_MIGRATION_ID] as const;

type SqlClient = ReturnType<typeof postgres>;

export async function applyAgentProtocolStateV1(
  client: SqlClient,
  options: { testFailAfterMigrationId?: typeof AGENT_FEED_STATE_V1_MIGRATION_ID | typeof AGENT_FEED_STATE_V2_MIGRATION_ID } = {},
): Promise<string[]> {
  return await client.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtext('cmai-agent-protocol-state-v1'))`;
    await transaction.unsafe(`
      CREATE TABLE IF NOT EXISTS cmai_schema_migrations (
        migration_id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const existing = await transaction`
      SELECT migration_id FROM cmai_schema_migrations
      WHERE migration_id IN (${AGENT_FEED_STATE_V1_MIGRATION_ID}, ${AGENT_PAIRING_STATE_V1_MIGRATION_ID}, ${AGENT_FEED_STATE_V2_MIGRATION_ID})
    `;
    const done = new Set(existing.map((row) => String(row.migration_id)));
    const newlyApplied = migrationIds.filter((migrationId) => !done.has(migrationId));

    if (!done.has(AGENT_PAIRING_STATE_V1_MIGRATION_ID)) {
      await transaction.unsafe(AGENT_PAIRING_STATE_V1_SQL);
    }
    const pairingRows = await transaction`SELECT id, state FROM cmai_agent_pairing_state FOR UPDATE`;
    if (pairingRows.length !== 1 || pairingRows[0]?.id !== "default") {
      throw new Error("Pairing state must contain only the singleton default row before recording migration success.");
    }
    let pairingState = assertPairingPlatformStateV1(pairingRows[0]?.state);

    const stateRows = await transaction`SELECT id FROM cmai_state WHERE id = 'default' FOR UPDATE`;
    if (stateRows.length !== 1) throw new Error("cmai_state/default is missing; apply the base store migration first.");
    if (!done.has(AGENT_FEED_STATE_V1_MIGRATION_ID)) {
      await transaction.unsafe(AGENT_FEED_STATE_V1_SQL);
      if (options.testFailAfterMigrationId === AGENT_FEED_STATE_V1_MIGRATION_ID) {
        throw new Error("Injected migration interruption after Agent feed state.");
      }
    }

    let feedRows = await transaction`SELECT state FROM cmai_state WHERE id = 'default' FOR UPDATE`;
    if (feedRows.length !== 1) throw new Error("cmai_state/default is missing after Agent feed v1 migration.");
    if (!done.has(AGENT_FEED_STATE_V2_MIGRATION_ID)) {
      const migrationClock = await transaction`SELECT now() AS migration_time`;
      const upgraded = migrateAgentFeedStateV2(
        feedRows[0]?.state as Record<string, unknown>,
        pairingState,
        new Date(migrationClock[0]?.migration_time),
      );
      pairingState = upgraded.pairingState;
      await transaction`UPDATE cmai_agent_pairing_state SET state = ${transaction.json(JSON.parse(JSON.stringify(pairingState)))}, updated_at = now() WHERE id = 'default'`;
      await transaction`UPDATE cmai_state SET state = ${transaction.json(JSON.parse(JSON.stringify(upgraded.state)))}, updated_at = now() WHERE id = 'default'`;
      if (options.testFailAfterMigrationId === AGENT_FEED_STATE_V2_MIGRATION_ID) {
        throw new Error("Injected migration interruption after Agent feed state v2.");
      }
      feedRows = await transaction`SELECT state FROM cmai_state WHERE id = 'default' FOR UPDATE`;
    }
    if (feedRows.length !== 1 || !hasReadyAgentFeedState(feedRows[0]?.state)) {
      throw new Error("Agent feed state is missing or incompatible; repair it before recording migration success.");
    }
    assertAgentProtocolStateCoherence(pairingState, feedRows[0]?.state);
    for (const migrationId of newlyApplied) {
      await transaction`INSERT INTO cmai_schema_migrations (migration_id) VALUES (${migrationId})`;
    }
    return [...newlyApplied];
  }) as string[];
}

export async function rollbackAgentProtocolStateV1(client: SqlClient): Promise<string[]> {
  return await client.begin(async (transaction) => {
    await transaction`SELECT pg_advisory_xact_lock(hashtext('cmai-agent-protocol-state-v1'))`;
    const ledgerTable = await transaction`SELECT to_regclass('public.cmai_schema_migrations') AS table_name`;
    if (!ledgerTable[0]?.table_name) throw new Error("Migration ledger is missing; rollback cannot be reconciled safely.");

    const existing = await transaction`
      SELECT migration_id FROM cmai_schema_migrations
      WHERE migration_id IN (${AGENT_FEED_STATE_V1_MIGRATION_ID}, ${AGENT_PAIRING_STATE_V1_MIGRATION_ID}, ${AGENT_FEED_STATE_V2_MIGRATION_ID})
    `;
    const recorded = new Set(existing.map((row) => String(row.migration_id)));
    for (const migrationId of migrationIds) {
      if (!recorded.has(migrationId)) throw new Error(`Migration ${migrationId} is not recorded; rollback refused.`);
    }

    await transaction.unsafe(AGENT_PAIRING_STATE_V1_ROLLBACK_SQL);
    await transaction.unsafe(AGENT_FEED_STATE_V1_ROLLBACK_SQL);
    const feedRows = await transaction`SELECT state FROM cmai_state WHERE id = 'default' FOR UPDATE`;
    if (feedRows.length !== 1 || (feedRows[0]?.state && typeof feedRows[0].state === "object" && "agentFeedState" in feedRows[0].state)) {
      throw new Error("Agent feed rollback refused because state is non-empty or incompatible.");
    }
    const pairingTable = await transaction`SELECT to_regclass('public.cmai_agent_pairing_state') AS table_name`;
    if (pairingTable[0]?.table_name) throw new Error("Pairing rollback did not remove the state table.");

    await transaction`
      DELETE FROM cmai_schema_migrations
      WHERE migration_id IN (${AGENT_FEED_STATE_V1_MIGRATION_ID}, ${AGENT_PAIRING_STATE_V1_MIGRATION_ID}, ${AGENT_FEED_STATE_V2_MIGRATION_ID})
    `;
    return [...migrationIds];
  }) as string[];
}
