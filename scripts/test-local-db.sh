#!/bin/bash
# Complete local matrix on each suite's reviewed fixture generation.
# No hosted database, existing cluster, real account, provider request or migration deployment.
set -euo pipefail
: "${PG17_BIN:?Set the trusted installed PostgreSQL 17 server directory}"
: "${PG17_CLIENT_BIN:?Set the trusted installed PostgreSQL 17 client directory}"
REPO=$(cd "$(dirname "$0")/.." && pwd)
PORT=${ADMIN_NOTIFICATION_PG_PORT:-55596}
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1024 && PORT <= 65535 ))
export ADMIN_NOTIFICATION_PG_PORT="$PORT"
cd "$REPO"
"$PG17_BIN/initdb" --version | grep 'PostgreSQL) 17\.'
"$PG17_CLIENT_BIN/pg_dump" --version | grep 'PostgreSQL) 17\.'
"$PG17_CLIENT_BIN/pg_restore" --version | grep 'PostgreSQL) 17\.'
mkdir -p artifacts/admin-invitations-pg
ROOT=$(mktemp -d "$REPO/artifacts/admin-invitations-pg/matrix.XXXXXX")
export TMPDIR="$ROOT/tmp"
mkdir -p "$TMPDIR"
DATA=''
cleanup() { if [[ -n "$DATA" ]]; then "$PG17_BIN/pg_ctl" -D "$DATA" -m fast -w stop; fi; }
trap cleanup EXIT
run_fixture() {
  local name=$1 apply012=$2; shift 2
  local fixture="$ROOT/$name"
  mkdir -p "$fixture"
  "$PG17_BIN/initdb" -D "$fixture/data" -U supabase_admin -A trust --no-locale --encoding=UTF8 > "$fixture/initdb.log" 2>&1
  "$PG17_BIN/pg_ctl" -D "$fixture/data" -l "$fixture/server.log" -o "-h 127.0.0.1 -p $PORT -c unix_socket_directories='' -c max_connections=40 -c max_prepared_transactions=10" -w start
  DATA="$fixture/data"
  ADMIN_NOTIFICATION_APPLY_012="$apply012" node scripts/bootstrap-local-db.mjs
  export TEST_DATABASE_URL="postgres://postgres@127.0.0.1:$PORT/dental_test_admin_notifications"
  export TEST_RESERVATION_ADMIN_URL="postgres://dental_test_admin@127.0.0.1:$PORT/dental_test_admin_notifications"
  export ALLOW_DISPOSABLE_SESSION_FIXTURES=true ALLOW_TEST_ROLE_GRANTS=true ALLOW_DISPOSABLE_RESERVATION_FIXTURES=true ALLOW_DISPOSABLE_RESTORE_FIXTURES=true
  export TEST_PG_DUMP="$PG17_CLIENT_BIN/pg_dump" TEST_PG_RESTORE="$PG17_CLIENT_BIN/pg_restore"
  printf 'Fixture %s: npm run test:db --' "$name"; printf ' %q' "$@"; printf '\n'
  npm run test:db -- "$@"
  "$PG17_BIN/pg_ctl" -D "$DATA" -m fast -w stop
  DATA=''
}
if (( $# )); then
  # Explicit focused cases use the current fixture unless the caller deliberately
  # selects the historical fixture, as documented by the corresponding suite.
  run_fixture focused "${ADMIN_NOTIFICATION_APPLY_012:-true}" "$@"
else
  feature=(); legacy=()
  # Enumerate every DB file so later suites cannot silently disappear from the gate.
  for file in tests/db/*.test.ts; do
    case "$file" in
      tests/db/admin-notification-*.test.ts|tests/db/combined-*.test.ts|tests/db/admin-management-*.test.ts|tests/db/notification-card-*.test.ts|tests/db/postcommit-notification-runtime.test.ts) feature+=("$file");;
      *) legacy+=("$file");;
    esac
  done
  printf 'Complete DB matrix: %s current files and %s pristine-011 legacy files\n' "${#feature[@]}" "${#legacy[@]}"
  run_fixture current true "${feature[@]}"
  run_fixture legacy false "${legacy[@]}"
fi
