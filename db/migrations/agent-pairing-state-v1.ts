import { emptyPairingPlatformState } from "@/lib/agent-pairing/storage";

export const AGENT_PAIRING_STATE_V1_MIGRATION_ID = "2026-07-15-agent-pairing-state-v1" as const;

const emptyStateJson = JSON.stringify(emptyPairingPlatformState());

// Apply only through scripts/migrate-agent-protocol-state.ts. Request/read paths never execute this DDL/DML.
export const AGENT_PAIRING_STATE_V1_SQL = `
CREATE TABLE IF NOT EXISTS cmai_agent_pairing_state (
  id text PRIMARY KEY,
  state jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO cmai_agent_pairing_state (id, state, updated_at)
VALUES ('default', '${emptyStateJson}'::jsonb, now())
ON CONFLICT (id) DO NOTHING;
`.trim();

// Safe only before pairing traffic. It refuses to remove non-empty pairing state.
export const AGENT_PAIRING_STATE_V1_ROLLBACK_SQL = `
DO $$
DECLARE
  current_state jsonb;
  state_rows bigint;
BEGIN
  SELECT count(*) INTO state_rows FROM cmai_agent_pairing_state;
  IF state_rows <> 1 THEN
    RAISE EXCEPTION 'refusing to roll back Agent pairing state with unexpected rows';
  END IF;

  SELECT state INTO current_state
  FROM cmai_agent_pairing_state
  WHERE id = 'default'
  FOR UPDATE;

  IF current_state IS DISTINCT FROM '${emptyStateJson}'::jsonb THEN
    RAISE EXCEPTION 'refusing to roll back non-empty Agent pairing state';
  END IF;

  DROP TABLE cmai_agent_pairing_state;
END $$;
`.trim();
