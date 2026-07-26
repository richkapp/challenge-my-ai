#!/usr/bin/env bash
set -euo pipefail

IFS= read -r suffix < /proc/sys/kernel/random/uuid
suffix="${suffix//-/}"
database="cmai_agent_feed_proof_${suffix}"
role="cmai_proof_${suffix}"
password="proof_${suffix}_local"
owner_token="cmai-proof-owner-${suffix}"
role_attempted=0
database_attempted=0
role_created=0
database_created=0
cleaned=0
deferred_signal=""

admin_psql() {
  sudo -n -u postgres psql -v ON_ERROR_STOP=1 "$@"
}

validate_failure_test_config() {
  if [[ "${CMAI_AGENT_FEED_PROOF_FAILURE_TEST_MODE:-}" != "1" ]]; then
    return
  fi
  case "${CMAI_AGENT_FEED_PROOF_TEST_SIGNAL:-TERM}" in
    HUP|INT|TERM) ;;
    *)
      printf 'Disposable PostgreSQL failure test refused unsupported signal %s.\n' "${CMAI_AGENT_FEED_PROOF_TEST_SIGNAL:-}" >&2
      CMAI_AGENT_FEED_PROOF_FAILURE_TEST_MODE=0
      exit 2
      ;;
  esac
}

send_test_signal() {
  local point="$1"
  if [[ "${CMAI_AGENT_FEED_PROOF_FAILURE_TEST_MODE:-}" != "1" || "${CMAI_AGENT_FEED_PROOF_TEST_SIGNAL_POINT:-}" != "$point" ]]; then
    return
  fi
  case "${CMAI_AGENT_FEED_PROOF_TEST_SIGNAL:-TERM}" in
    HUP|INT|TERM) kill -s "${CMAI_AGENT_FEED_PROOF_TEST_SIGNAL:-TERM}" "$$" ;;
    *) return 2 ;;
  esac
}

cleanup() {
  if (( cleaned )); then return; fi
  cleaned=1
  send_test_signal cleanup || true

  local db_count db_owned role_count role_owned
  db_count="$(admin_psql -d postgres -Atqc "SELECT count(*) FROM pg_database WHERE datname = '${database}';")"
  db_owned="$(admin_psql -d postgres -Atqc "SELECT count(*) FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = '${database}' AND r.rolname = '${role}' AND shobj_description(r.oid, 'pg_authid') = '${owner_token}';")"
  if (( database_attempted )) && [[ "$db_count" == "1" ]]; then
    if [[ "$db_owned" != "1" ]]; then
      printf 'Disposable PostgreSQL cleanup refused an unowned database.\n' >&2
      return 1
    fi
    admin_psql -d postgres -Atqc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid();" >/dev/null
    admin_psql -d postgres -Atqc "DROP DATABASE \"${database}\";"
  fi

  role_count="$(admin_psql -d postgres -Atqc "SELECT count(*) FROM pg_roles WHERE rolname = '${role}';")"
  role_owned="$(admin_psql -d postgres -Atqc "SELECT count(*) FROM pg_roles WHERE rolname = '${role}' AND shobj_description(oid, 'pg_authid') = '${owner_token}';")"
  if (( role_attempted )) && [[ "$role_count" == "1" ]]; then
    if [[ "$role_owned" != "1" ]]; then
      printf 'Disposable PostgreSQL cleanup refused an unowned role.\n' >&2
      return 1
    fi
    admin_psql -d postgres -Atqc "DROP ROLE \"${role}\";"
  fi

  db_count="$(admin_psql -d postgres -Atqc "SELECT count(*) FROM pg_database WHERE datname = '${database}';")"
  role_count="$(admin_psql -d postgres -Atqc "SELECT count(*) FROM pg_roles WHERE rolname = '${role}';")"
  if [[ "$db_count" != "0" || "$role_count" != "0" ]]; then
    printf 'Disposable PostgreSQL cleanup failed: database=%s role=%s\n' "$db_count" "$role_count" >&2
    return 1
  fi
  printf 'Disposable PostgreSQL cleanup verified: database=0 role=0\n'
}

defer_signal() {
  deferred_signal="$1"
}

exit_if_signal_deferred() {
  case "$deferred_signal" in
    HUP) exit 129 ;;
    INT) exit 130 ;;
    TERM) exit 143 ;;
  esac
}

on_exit() {
  local status=$?
  trap - EXIT
  trap '' HUP INT TERM
  cleanup || status=1
  exit "$status"
}
trap on_exit EXIT
trap 'defer_signal HUP' HUP
trap 'defer_signal INT' INT
trap 'defer_signal TERM' TERM
validate_failure_test_config

send_test_signal before-role
exit_if_signal_deferred
if [[ "$(admin_psql -d postgres -Atqc "SELECT count(*) FROM pg_roles WHERE rolname = '${role}';")" != "0" ]]; then
  printf 'Disposable PostgreSQL role name already exists; refusing.\n' >&2
  exit 1
fi
role_attempted=1
admin_psql -d postgres -Atqc "CREATE ROLE \"${role}\" LOGIN PASSWORD '${password}'; COMMENT ON ROLE \"${role}\" IS '${owner_token}';"
if [[ "${CMAI_AGENT_FEED_PROOF_FAILURE_TEST_MODE:-}" == "1" && "${CMAI_AGENT_FEED_PROOF_TEST_CLIENT_ERROR_AFTER_CREATE:-}" == "role" ]]; then false; fi
send_test_signal after-role-create
role_created=1
exit_if_signal_deferred

if [[ "$(admin_psql -d postgres -Atqc "SELECT count(*) FROM pg_database WHERE datname = '${database}';")" != "0" ]]; then
  printf 'Disposable PostgreSQL database name already exists; refusing.\n' >&2
  exit 1
fi
database_attempted=1
admin_psql -d postgres -Atqc "CREATE DATABASE \"${database}\" OWNER \"${role}\";"
if [[ "${CMAI_AGENT_FEED_PROOF_FAILURE_TEST_MODE:-}" == "1" && "${CMAI_AGENT_FEED_PROOF_TEST_CLIENT_ERROR_AFTER_CREATE:-}" == "database" ]]; then false; fi
send_test_signal after-database-create
database_created=1
exit_if_signal_deferred
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
send_test_signal after-boundary
if [[ "${CMAI_AGENT_FEED_PROOF_FAILURE_TEST_MODE:-}" == "1" && "${CMAI_AGENT_FEED_PROOF_TEST_EXIT_AFTER_BOUNDARY:-}" == "1" ]]; then exit 42; fi

if (( !role_created || !database_created )); then
  printf 'Disposable PostgreSQL ownership publication incomplete.\n' >&2
  exit 1
fi

database_url="postgresql://"
database_url+="$role"
database_url+=":"
database_url+="$password"
database_url+="@127.0.0.1:5432/"
database_url+="$database"
DATABASE_URL="$database_url" CMAI_PROOF_ROLE="$role" CMAI_PROOF_DATABASE="$database" \
  bun -e 'import postgres from "postgres"; const sql = postgres(process.env.DATABASE_URL); const [row] = await sql`SELECT current_user, current_database()`; if (row.current_user !== process.env.CMAI_PROOF_ROLE || row.current_database !== process.env.CMAI_PROOF_DATABASE) throw new Error("Disposable PostgreSQL preflight identity mismatch."); await sql.end();'

DATABASE_URL="$database_url" \
CMAI_AGENT_FEED_PROOF_ALLOW_RESET=1 \
NODE_ENV=test \
CMAI_RUNTIME_ENV=test \
bun scripts/prove-agent-feed-postgres.ts
