#!/usr/bin/env bash
# Requires prior approval for disposable synthetic local fixtures. Never points
# at hosted databases; preserves logs/dumps locally and stops its own server.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${PG17_BIN:?Set PG17_BIN to installed trusted PG17 server binaries}"
: "${TEST_PG_DUMP:?Set TEST_PG_DUMP to installed trusted native PG17 pg_dump}"
: "${TEST_PG_RESTORE:?Set TEST_PG_RESTORE to installed trusted native PG17 pg_restore}"
[ "${ALLOW_DISPOSABLE_MIGRATION_FIXTURES:-}" = true ] || { echo 'Prior disposable fixture approval required'; exit 1; }
export RESTRICTED_TEST_PORT=${RESTRICTED_TEST_PORT:-55459}
[[ "$RESTRICTED_TEST_PORT" =~ ^[0-9]{4,5}$ ]] && (( RESTRICTED_TEST_PORT >= 1024 && RESTRICTED_TEST_PORT <= 65535 )) || exit 1
ROOT=$(mktemp -d /tmp/dental-restricted-pg17-XXXXXX)
"$PG17_BIN/postgres" --version | grep -E 'PostgreSQL\) 17\.'
"$PG17_BIN/initdb" -D "$ROOT/data" -U supabase_admin -A trust --locale=C --encoding=UTF8 > "$ROOT/init.log"
cleanup(){ "$PG17_BIN/pg_ctl" -D "$ROOT/data" -m fast -w stop >> "$ROOT/shutdown.log" 2>&1; }
trap cleanup EXIT
"$PG17_BIN/pg_ctl" -D "$ROOT/data" -l "$ROOT/server.log" -o "-h 127.0.0.1 -p $RESTRICTED_TEST_PORT -c unix_socket_directories='' -c max_connections=40" -w start
export TEST_DATABASE_URL="postgres://postgres@127.0.0.1:$RESTRICTED_TEST_PORT/dental_test_restricted"
export TEST_RESERVATION_ADMIN_URL="postgres://dental_test_admin@127.0.0.1:$RESTRICTED_TEST_PORT/dental_test_restricted"
export ALLOW_DISPOSABLE_RESERVATION_FIXTURES=true ALLOW_DISPOSABLE_SESSION_FIXTURES=true ALLOW_TEST_ROLE_GRANTS=true ALLOW_DISPOSABLE_RESTORE_FIXTURES=true
node scripts/bootstrap-restricted-postgres.mjs
export MIGRATION_009_SHA256=$(sha256sum db/migrations/009_restricted_dispatch.sql | cut -d' ' -f1)
export MIGRATION_SAFETY_REPORT="$ROOT/migration-safety.json"
node scripts/test-restricted-dispatch-migration.mjs
npm run test:db -- --reporter=json --outputFile="$ROOT/database-tests.json"
# The JSON is checked independently of shell pipeline success.
node --input-type=module -e "import {readFileSync} from 'node:fs';const r=JSON.parse(readFileSync(process.argv[1]));console.log(JSON.stringify({passed:r.numPassedTests,failed:r.numFailedTests,pending:r.numPendingTests}));if(!r.success||r.numFailedTests)process.exit(1)" "$ROOT/database-tests.json"
printf 'Local validation evidence: %s\n' "$ROOT"
