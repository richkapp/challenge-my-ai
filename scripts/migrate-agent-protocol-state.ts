import postgres from "postgres";
import {
  AGENT_PROTOCOL_STATE_MIGRATION_CONFIRMATION,
  AGENT_PROTOCOL_STATE_ROLLBACK_CONFIRMATION,
  applyAgentProtocolStateV1,
  rollbackAgentProtocolStateV1,
} from "@/db/migrations/agent-protocol-state-v1";

const databaseUrl = process.env.DATABASE_URL?.trim() || "";
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const action = process.env.CMAI_AGENT_PROTOCOL_MIGRATION_ACTION === "rollback" ? "rollback" : "apply";
const expectedConfirmation = action === "rollback"
  ? AGENT_PROTOCOL_STATE_ROLLBACK_CONFIRMATION
  : AGENT_PROTOCOL_STATE_MIGRATION_CONFIRMATION;
if (process.env.CMAI_AGENT_PROTOCOL_MIGRATION_CONFIRM !== expectedConfirmation) {
  throw new Error(`Set CMAI_AGENT_PROTOCOL_MIGRATION_CONFIRM=${expectedConfirmation} to ${action} the reviewed migration.`);
}

const client = postgres(databaseUrl, { max: 1, prepare: false });
try {
  const changed = action === "rollback"
    ? await rollbackAgentProtocolStateV1(client)
    : await applyAgentProtocolStateV1(client);
  console.log(JSON.stringify({
    migration: "cmai_agent_protocol_state_v1",
    action,
    changed,
    alreadyApplied: action === "apply" && changed.length === 0,
  }));
} finally {
  await client.end({ timeout: 1 });
}
