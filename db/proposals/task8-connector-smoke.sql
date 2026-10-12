-- UNEXECUTED Task 8 connector smoke; tooth-talk-staging YOUR_SUPABASE_PROJECT_REF.
-- Separate exact-project/hash approval required AFTER reviewed migration 006.
-- One sequential statement. No SQL execution evidence or concurrency proof.
-- Existing accounts/bookings/admins may be present and must remain untouched.
-- No active application outbox row is allowed, even if not yet due: claim_events
-- globally scans work. Refuse and use a separately authorized synthetic-only,
-- schema/role-equivalent disposable database when this protection fails.
-- Inherited <=120s command timeout; each table lock waits <=3s. Writers may block.
-- All fixture writes and one temporary SET membership roll back via PT998.
-- The outer table locks survive the nested rollback until comparison completes.
DO $task8_connector_smoke$
DECLARE
  v_owner oid; v_backend oid; v_runtime oid; v_postgres oid;
  v_role text; v_table text; v_signature text; v_offset integer; v_i integer;
  v_actor uuid := pg_catalog.gen_random_uuid(); v_admin uuid := pg_catalog.gen_random_uuid();
  v_provider text := 'line:synthetic-task8-' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '');
  v_subject text := 'U' || pg_catalog.replace(v_actor::text, '-', '');
  v_admin_subject text := 'U' || pg_catalog.replace(v_admin::text, '-', '');
  v_hook text; v_now timestamptz; v_guard_deadline timestamptz; v_today date; v_date date;
  v_dates date[] := '{}'; v_bookings uuid[] := '{}'; v_patient uuid; v_booking uuid;
  v_boolean boolean; v_duplicate boolean; v_worker uuid; v_event uuid; v_retry uuid; v_result jsonb; v_prepared jsonb;
  v_before jsonb; v_after jsonb; v_settings_before jsonb; v_settings_after jsonb;
  v_lock_timeout text; v_all_passed boolean := false; v_sentinel_seen boolean := false;
  v_checks text[] := '{}';
  v_expected_checks constant text[] := ARRAY[
    'reachability_ordering', 'approval_reminder_enqueue', 'claim_synthetic_only',
    'minimal_frozen_payload', 'duplicate_prepare_denied', 'accepted_local_only',
    'cancelled_claim_suppressed', 'unreachable_fails_closed', 'rejection_local_acceptance',
    'retry_backoff', 'booking_state_unchanged', 'synthetic_scope'
  ];
  v_settings_sql constant text := $settings_query$
    SELECT pg_catalog.jsonb_build_object(
      'currentUser', CURRENT_USER, 'sessionUser', SESSION_USER,
      'role', pg_catalog.current_setting('role'), 'searchPath', pg_catalog.current_setting('search_path'),
      'statementTimeout', pg_catalog.current_setting('statement_timeout'),
      'lockTimeout', pg_catalog.current_setting('lock_timeout'),
      'transactionIsolation', pg_catalog.current_setting('transaction_isolation'),
      'transactionReadOnly', pg_catalog.current_setting('transaction_read_only'))
  $settings_query$;
  v_state_sql constant text := $state_query$
SELECT pg_catalog.jsonb_build_object(
      'settings', (SELECT pg_catalog.jsonb_build_object(
    'currentUser', CURRENT_USER, 'sessionUser', SESSION_USER,
    'role', pg_catalog.current_setting('role'),
    'searchPath', pg_catalog.current_setting('search_path'),
    'statementTimeout', pg_catalog.current_setting('statement_timeout'),
    'lockTimeout', pg_catalog.current_setting('lock_timeout'),
    'transactionIsolation', pg_catalog.current_setting('transaction_isolation'),
    'transactionReadOnly', pg_catalog.current_setting('transaction_read_only')
  )),
      'serverVersion', pg_catalog.current_setting('server_version_num'),
      'roles', (
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'oid', r.oid, 'name', r.rolname, 'superuser', r.rolsuper, 'inherit', r.rolinherit,
          'createRole', r.rolcreaterole, 'createDatabase', r.rolcreatedb, 'login', r.rolcanlogin,
          'replication', r.rolreplication, 'bypassRls', r.rolbypassrls,
          'connectionLimit', r.rolconnlimit, 'validUntil', r.rolvaliduntil,
          'configIsNull', r.rolconfig IS NULL,
          'roleSettingNames', (SELECT COALESCE(pg_catalog.array_agg(pg_catalog.split_part(setting, '=', 1)
            ORDER BY pg_catalog.split_part(setting, '=', 1)), ARRAY[]::text[]) FROM pg_catalog.unnest(r.rolconfig) setting)
        ) ORDER BY r.oid) FROM pg_catalog.pg_roles r
        WHERE r.rolname IN ('postgres', 'dental_function_owner', 'dental_backend', 'dental_runtime', 'anon', 'authenticated', 'authenticator', 'service_role')
      ),
      'membershipCount', (
        SELECT pg_catalog.count(*) FROM pg_catalog.pg_auth_members m
        WHERE m.roleid IN ('dental_function_owner'::pg_catalog.regrole, 'dental_backend'::pg_catalog.regrole, 'dental_runtime'::pg_catalog.regrole)
          OR m.member IN ('dental_function_owner'::pg_catalog.regrole, 'dental_backend'::pg_catalog.regrole, 'dental_runtime'::pg_catalog.regrole)
      ),
      'memberships', (
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY m.roleid, m.member, m.grantor), '[]'::jsonb)
        FROM pg_catalog.pg_auth_members m
        WHERE m.roleid IN ('dental_function_owner'::pg_catalog.regrole, 'dental_backend'::pg_catalog.regrole, 'dental_runtime'::pg_catalog.regrole)
          OR m.member IN ('dental_function_owner'::pg_catalog.regrole, 'dental_backend'::pg_catalog.regrole, 'dental_runtime'::pg_catalog.regrole)
      ),
      'schema', (
        SELECT pg_catalog.jsonb_build_object('oid', n.oid, 'owner', n.nspowner, 'acl', n.nspacl)
        FROM pg_catalog.pg_namespace n WHERE n.nspname = 'dental'
      ),
      'tables', (
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'oid', c.oid, 'name', c.relname, 'owner', c.relowner, 'acl', c.relacl,
          'rls', c.relrowsecurity, 'forcedRls', c.relforcerowsecurity
        ) ORDER BY c.oid) FROM pg_catalog.pg_class c
        WHERE c.relnamespace = 'dental'::pg_catalog.regnamespace AND c.relkind = 'r'
      ),
      'columnAcls', (
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'table', a.attrelid, 'column', a.attnum, 'acl', a.attacl
        ) ORDER BY a.attrelid, a.attnum), '[]'::jsonb)
        FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        WHERE c.relnamespace = 'dental'::pg_catalog.regnamespace AND a.attnum > 0 AND NOT a.attisdropped
      ),
      'functions', (
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'oid', p.oid, 'name', p.proname, 'signature', pg_catalog.pg_get_function_identity_arguments(p.oid),
          'owner', p.proowner, 'acl', p.proacl,
          'configSha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.proconfig::text, 'UTF8')), 'hex'), 'definer', p.prosecdef,
          'definitionSha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_functiondef(p.oid), 'UTF8')), 'hex'),
          'runtimeExecute', pg_catalog.has_function_privilege('dental_runtime', p.oid, 'EXECUTE'),
          'backendExecute', pg_catalog.has_function_privilege('dental_backend', p.oid, 'EXECUTE'),
          'operatorExecute', pg_catalog.has_function_privilege('postgres', p.oid, 'EXECUTE')
        ) ORDER BY p.oid) FROM pg_catalog.pg_proc p
        WHERE p.pronamespace = 'dental'::pg_catalog.regnamespace
      ),
      'policies', (
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid), '[]'::jsonb)
        FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
        WHERE c.relnamespace = 'dental'::pg_catalog.regnamespace
      ),
      'defaults', (
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.oid), '[]'::jsonb)
        FROM pg_catalog.pg_default_acl d WHERE d.defaclrole IN (
          'postgres'::pg_catalog.regrole, 'dental_function_owner'::pg_catalog.regrole,
          'dental_backend'::pg_catalog.regrole, 'dental_runtime'::pg_catalog.regrole
        )
      ),
      'columnDefaults', (
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'oid', d.oid, 'table', d.adrelid, 'column', d.adnum,
          'expressionSha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_expr(d.adbin, d.adrelid), 'UTF8')), 'hex')
        ) ORDER BY d.oid), '[]'::jsonb)
        FROM pg_catalog.pg_attrdef d JOIN pg_catalog.pg_class c ON c.oid = d.adrelid
        WHERE c.relnamespace = 'dental'::pg_catalog.regnamespace
      ),
      'roleDatabaseSettings', (
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'database', s.setdatabase, 'role', s.setrole,
          'settingNames', (SELECT COALESCE(pg_catalog.array_agg(pg_catalog.split_part(setting, '=', 1)
            ORDER BY pg_catalog.split_part(setting, '=', 1)), ARRAY[]::text[]) FROM pg_catalog.unnest(s.setconfig) setting)
        ) ORDER BY s.setdatabase, s.setrole), '[]'::jsonb) FROM pg_catalog.pg_db_role_setting s
        WHERE s.setrole IN (0, 'postgres'::pg_catalog.regrole, 'dental_function_owner'::pg_catalog.regrole,
          'dental_backend'::pg_catalog.regrole, 'dental_runtime'::pg_catalog.regrole)
      ),
      'triggers', (
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'oid', t.oid, 'table', t.tgrelid, 'enabled', t.tgenabled,
          'definitionSha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_triggerdef(t.oid), 'UTF8')), 'hex')
        ) ORDER BY t.oid), '[]'::jsonb) FROM pg_catalog.pg_trigger t
        JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'dental'::pg_catalog.regnamespace
      ),
      'constraints', (
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'oid', c.oid, 'table', c.conrelid, 'validated', c.convalidated,
          'definitionSha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_constraintdef(c.oid), 'UTF8')), 'hex')
        ) ORDER BY c.oid), '[]'::jsonb) FROM pg_catalog.pg_constraint c WHERE c.connamespace = 'dental'::pg_catalog.regnamespace
      ),
      'indexes', (
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'oid', i.indexrelid, 'table', i.indrelid, 'valid', i.indisvalid, 'ready', i.indisready,
          'definitionSha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_indexdef(i.indexrelid), 'UTF8')), 'hex')
        ) ORDER BY i.indexrelid), '[]'::jsonb) FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'dental'::pg_catalog.regnamespace
      ),
      'rowDigests', (
        SELECT pg_catalog.jsonb_object_agg(name, pg_catalog.jsonb_build_object('count', rows, 'sha256', digest)) FROM (
          SELECT 'accounts' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT id, created_at FROM dental.accounts) t) hashed
          UNION ALL
          SELECT 'sessions' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT id, account_id, created_at, expires_at, revoked_at FROM dental.sessions) t) hashed
          UNION ALL
          SELECT 'patients' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT id, owner_account_id, version, created_at, updated_at FROM dental.patients) t) hashed
          UNION ALL
          SELECT 'appointments' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT id, owner_account_id, patient_id, patient_version, date, status, version, created_at, updated_at, approved_at, cancelled_at, cancelled_by FROM dental.appointments) t) hashed
          UNION ALL
          SELECT 'clinic_dates' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT date, intake, changed_by, version, created_at, updated_at FROM dental.clinic_dates) t) hashed
          UNION ALL
          SELECT 'admin_grants' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT id, account_id, granted_at, granted_by, revoked_at, revoked_by FROM dental.admin_grants) t) hashed
          UNION ALL
          SELECT 'audit_events' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT id, actor_account_id, action, patient_id, appointment_id, clinic_date, occurred_at FROM dental.audit_events) t) hashed
          UNION ALL
          SELECT 'outbox' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT id, appointment_id, appointment_version, appointment_date, type, due_at, expires_at, state, attempt_count, lease_owner, lease_until, first_attempt_at, accepted_at, created_at, updated_at, failure_category FROM dental.outbox) t) hashed
          UNION ALL
          SELECT 'notification_attempts' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT id, outbox_id, attempt_number, worker_id, started_at, finished_at, result, error_category FROM dental.notification_attempts) t) hashed
          UNION ALL
          SELECT 'submission_keys' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT owner_account_id, appointment_id, created_at FROM dental.submission_keys) t) hashed
          UNION ALL
          SELECT 'oauth_pending' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT created_at, expires_at FROM dental.oauth_pending) t) hashed
          UNION ALL
          SELECT 'line_reachability' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT reachable, event_at, updated_at FROM dental.line_reachability) t) hashed
          UNION ALL
          SELECT 'line_webhook_events' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT event_at, reachable, recorded_at FROM dental.line_webhook_events) t) hashed
        ) summaries
      ),
      'schemaAccess', (
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'role', rolname, 'usage', pg_catalog.has_schema_privilege(oid, 'dental', 'USAGE'),
          'create', pg_catalog.has_schema_privilege(oid, 'dental', 'CREATE'),
          'canSetBackend', pg_catalog.pg_has_role(oid, 'dental_backend', 'SET'),
          'canSetOwner', pg_catalog.pg_has_role(oid, 'dental_function_owner', 'SET')
        ) ORDER BY rolname) FROM pg_catalog.pg_roles WHERE rolname IN (
          'postgres', 'dental_function_owner', 'dental_backend', 'dental_runtime', 'anon', 'authenticated', 'authenticator', 'service_role'
        )
      )
    )
  $state_query$;
BEGIN
  IF (SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name = 'statement_timeout') NOT BETWEEN 1 AND 120000 THEN
    RAISE EXCEPTION 'Require an inherited statement timeout between 1ms and 120 seconds';
  END IF;
  v_guard_deadline := pg_catalog.clock_timestamp() + interval '3 minutes';
  IF CURRENT_USER <> 'postgres' OR SESSION_USER <> 'postgres'
    OR pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
    OR pg_catalog.current_setting('transaction_read_only') <> 'off'
    OR pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Require the reviewed writable READ COMMITTED PostgreSQL 17 postgres session';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'postgres'
      AND rolcreaterole AND rolbypassrls AND NOT rolsuper)
    OR pg_catalog.to_regnamespace('dental') IS NULL
    OR pg_catalog.to_regrole('dental_function_owner') IS NULL
    OR pg_catalog.to_regrole('dental_backend') IS NULL
    OR pg_catalog.to_regrole('dental_runtime') IS NULL THEN
    RAISE EXCEPTION 'Reviewed operator, private schema or existing restricted runtime is absent';
  END IF;
  v_owner := 'dental_function_owner'::pg_catalog.regrole;
  v_backend := 'dental_backend'::pg_catalog.regrole;
  v_runtime := 'dental_runtime'::pg_catalog.regrole;
  v_postgres := 'postgres'::pg_catalog.regrole;
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE oid IN (v_owner, v_backend)
      AND (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolconfig IS NOT NULL))
    OR NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE oid = v_runtime AND rolcanlogin AND rolinherit
      AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
      AND rolconnlimit = -1 AND rolvaliduntil IS NULL AND rolconfig IS NULL)
    OR EXISTS (SELECT FROM pg_catalog.pg_db_role_setting WHERE setrole IN (v_owner, v_backend, v_runtime)) THEN
    RAISE EXCEPTION 'Runtime or private role attributes/settings differ from the reviewed baseline';
  END IF;
  -- Three exact bootstrap creator-admin grants plus one runtime inheritance grant.
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_auth_members m
      WHERE m.roleid IN (v_owner, v_backend, v_runtime) OR m.member IN (v_owner, v_backend, v_runtime)) <> 4
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_auth_members m
      WHERE m.roleid IN (v_owner, v_backend, v_runtime) AND m.member = v_postgres
        AND m.grantor = 'supabase_admin'::pg_catalog.regrole
        AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option) <> 3
    OR NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'supabase_admin' AND rolsuper)
    OR NOT EXISTS (SELECT FROM pg_catalog.pg_auth_members m
      WHERE m.member = v_runtime AND m.roleid = v_backend AND m.grantor = v_postgres
        AND NOT m.admin_option AND m.inherit_option AND NOT m.set_option) THEN
    RAISE EXCEPTION 'Exact four reviewed creator/runtime memberships required; no existing grant may change';
  END IF;
  EXECUTE v_settings_sql INTO v_settings_before;
  v_lock_timeout := pg_catalog.current_setting('lock_timeout');
  PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
  -- Outer locks prevent external writes through BOTH snapshots and rollback.
  -- No global data changes or empty-table prerequisite: populated data is allowed.
  LOCK TABLE dental.accounts, dental.sessions, dental.patients, dental.clinic_dates,
    dental.appointments, dental.submission_keys, dental.admin_grants, dental.audit_events,
    dental.outbox, dental.notification_attempts, dental.oauth_pending,
    dental.line_reachability, dental.line_webhook_events IN SHARE ROW EXCLUSIVE MODE;
  -- Recheck shape/trigger/rule/ACL gates after locks to close table-DDL races.
  IF (SELECT pg_catalog.array_agg(c.relname::text ORDER BY c.relname) FROM pg_catalog.pg_class c
      WHERE c.relnamespace = 'dental'::pg_catalog.regnamespace AND c.relkind = 'r')
    IS DISTINCT FROM ARRAY['accounts','admin_grants','appointments','audit_events','clinic_dates',
      'line_reachability','line_webhook_events','notification_attempts','oauth_pending','outbox','patients','sessions','submission_keys']::text[]
    OR EXISTS (SELECT FROM pg_catalog.pg_class WHERE relnamespace = 'dental'::pg_catalog.regnamespace AND relkind NOT IN ('r','i'))
    OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc WHERE pronamespace = 'dental'::pg_catalog.regnamespace) <> 30
    OR EXISTS (SELECT FROM pg_catalog.pg_proc WHERE pronamespace = 'dental'::pg_catalog.regnamespace
      AND (proowner <> v_owner OR proconfig IS DISTINCT FROM ARRAY['search_path=""']))
    OR EXISTS (SELECT FROM pg_catalog.pg_class WHERE relnamespace = 'dental'::pg_catalog.regnamespace AND relkind = 'r'
      AND (relowner <> v_postgres OR NOT relrowsecurity OR NOT relforcerowsecurity)) THEN
    RAISE EXCEPTION 'Require independently verified Task 8 table/function/ownership/RLS surface';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE p.oid = pg_catalog.to_regprocedure('dental.clock_now()') AND l.lanname = 'sql'
      AND NOT p.prosecdef AND p.provolatile = 'v'
      AND pg_catalog.btrim(p.prosrc) = 'SELECT pg_catalog.clock_timestamp()') THEN
    RAISE EXCEPTION 'Unmodified real database clock required';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
      WHERE c.relnamespace = 'dental'::pg_catalog.regnamespace AND NOT t.tgisinternal) <> 2
    OR NOT EXISTS (SELECT FROM pg_catalog.pg_trigger WHERE tgrelid = 'dental.appointments'::pg_catalog.regclass
      AND tgname = 'appointments_preserve_snapshot' AND tgenabled = 'O'
      AND tgfoid = 'dental._protect_appointment_snapshot()'::pg_catalog.regprocedure)
    OR NOT EXISTS (SELECT FROM pg_catalog.pg_trigger WHERE tgrelid = 'dental.outbox'::pg_catalog.regclass
      AND tgname = 'outbox_capture_appointment_date' AND tgenabled = 'O'
      AND tgfoid = 'dental._capture_outbox_date()'::pg_catalog.regprocedure)
    OR EXISTS (SELECT FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid = r.ev_class
      WHERE c.relnamespace = 'dental'::pg_catalog.regnamespace) THEN
    RAISE EXCEPTION 'Unexpected private trigger or rewrite rule; require separate review';
  END IF;
  FOREACH v_signature IN ARRAY ARRAY[
    'dental.claim_events(uuid,integer)', 'dental.prepare_dispatch(uuid,uuid,text)',
    'dental.finish_dispatch(uuid,uuid,jsonb)', 'dental.record_line_reachability(text,text,text,timestamptz,boolean)',
    'dental.create_patient(uuid,jsonb)', 'dental.reserve(uuid,uuid,jsonb)',
    'dental.decide(uuid,uuid,integer,text,text)', 'dental.cancel(uuid,uuid,integer)'
  ] LOOP
    IF pg_catalog.to_regprocedure(v_signature) IS NULL
      OR NOT pg_catalog.has_function_privilege(v_backend, v_signature, 'EXECUTE')
      OR NOT pg_catalog.has_function_privilege(v_runtime, v_signature, 'EXECUTE')
      OR pg_catalog.has_function_privilege(v_postgres, v_signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'Required private RPC runtime/operator ACL differs';
    END IF;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['dental_backend','dental_runtime'] LOOP
    FOREACH v_table IN ARRAY ARRAY['accounts','sessions','patients','clinic_dates','appointments',
      'submission_keys','admin_grants','audit_events','outbox','notification_attempts','oauth_pending',
      'line_reachability','line_webhook_events'] LOOP
      IF pg_catalog.has_table_privilege(v_role, 'dental.' || v_table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        OR pg_catalog.has_any_column_privilege(v_role, 'dental.' || v_table, 'SELECT,INSERT,UPDATE,REFERENCES') THEN
        RAISE EXCEPTION 'Runtime/backend direct table access is unsafe';
      END IF;
    END LOOP;
  END LOOP;
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated','authenticator','service_role'] LOOP
    IF pg_catalog.to_regrole(v_role) IS NOT NULL AND (
      pg_catalog.pg_has_role(v_role, v_owner, 'MEMBER') OR pg_catalog.pg_has_role(v_role, v_backend, 'MEMBER')
      OR pg_catalog.pg_has_role(v_role, v_runtime, 'MEMBER')
      OR pg_catalog.has_schema_privilege(v_role, 'dental', 'USAGE,CREATE')
      OR EXISTS (SELECT FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'dental'::pg_catalog.regnamespace
        AND pg_catalog.has_function_privilege(v_role, p.oid, 'EXECUTE'))
      OR EXISTS (SELECT FROM pg_catalog.pg_class c WHERE c.relnamespace = 'dental'::pg_catalog.regnamespace AND c.relkind = 'r'
        AND (pg_catalog.has_table_privilege(v_role, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
          OR pg_catalog.has_any_column_privilege(v_role, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')))
    ) THEN RAISE EXCEPTION 'Browser/platform role has unexpected private access'; END IF;
  END LOOP;

  EXECUTE v_state_sql INTO v_before;
  IF EXISTS (SELECT FROM dental.outbox o
    WHERE (o.state IN ('queued','retry') AND o.due_at <= v_guard_deadline)
       OR (o.state = 'leased' AND o.lease_until <= v_guard_deadline)) THEN
    RAISE EXCEPTION 'Dedicated disposable clone required: existing outbox may become claimable';
  END IF;
  -- Stronger than the deadline guard: even far-future active events are rejected.
  -- claim_events cannot touch a pre-existing row when all such rows are terminal.
  IF EXISTS (SELECT FROM dental.outbox WHERE state IN ('queued','retry','leased')) THEN
    RAISE EXCEPTION 'Dedicated disposable clone required: pre-existing nonterminal outbox work';
  END IF;
  IF EXISTS (SELECT FROM dental.accounts WHERE id IN (v_actor, v_admin) OR provider = v_provider)
    OR EXISTS (SELECT FROM dental.line_reachability WHERE provider = v_provider)
    OR EXISTS (SELECT FROM dental.line_webhook_events WHERE provider = v_provider) THEN
    RAISE EXCEPTION 'Synthetic namespace collision; stop without touching existing data';
  END IF;
  v_now := pg_catalog.clock_timestamp();
  v_today := pg_catalog.timezone('Asia/Bangkok', v_now)::date;
  FOR v_offset IN 7..60 LOOP
    v_date := v_today + v_offset;
    IF extract(isodow FROM v_date) <= 5
      AND NOT EXISTS (SELECT FROM dental.clinic_dates WHERE date = v_date)
      AND NOT EXISTS (SELECT FROM dental.appointments WHERE date = v_date)
      AND NOT EXISTS (SELECT FROM dental.outbox WHERE appointment_date = v_date) THEN
      v_dates := pg_catalog.array_append(v_dates, v_date);
      EXIT WHEN pg_catalog.cardinality(v_dates) = 2;
    END IF;
  END LOOP;
  IF pg_catalog.cardinality(v_dates) <> 2 THEN
    RAISE EXCEPTION 'No two safely unused future weekdays; use a synthetic-only disposable database';
  END IF;

  -- BEGIN SYNTHETIC SUBTRANSACTION
  BEGIN
    GRANT dental_backend TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
    INSERT INTO dental.accounts(id, provider, subject, created_at) VALUES
      (v_actor, v_provider, v_subject, v_now), (v_admin, v_provider, v_admin_subject, v_now);
    INSERT INTO dental.admin_grants(account_id, granted_at, granted_by) VALUES (v_admin, v_now, v_actor);
    SET LOCAL ROLE dental_backend;
    v_hook := '01' || pg_catalog.upper(pg_catalog.substr(pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 24));
    v_boolean := dental.record_line_reachability(v_provider, v_subject, v_hook, v_now, true);
    v_duplicate := dental.record_line_reachability(v_provider, v_subject, v_hook, v_now, true);
    IF v_boolean IS DISTINCT FROM true OR v_duplicate IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'Smoke failed: webhook deduplication';
    END IF;
    PERFORM dental.record_line_reachability(v_provider, v_subject,
      '01' || pg_catalog.upper(pg_catalog.substr(pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 24)), v_now - interval '1 second', false);
    RESET ROLE;
    IF (SELECT reachable FROM dental.line_reachability WHERE provider = v_provider AND subject = v_subject) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'Smoke failed: reachability ordering';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'reachability_ordering');

    -- Five sequential synthetic cases. Only one immediately due new event exists
    -- per iteration. The final retry is not claimed again; no clock manipulation.
    FOR v_i IN 1..5 LOOP
      v_date := CASE WHEN v_i <= 3 THEN v_dates[1] ELSE v_dates[2] END;
      SET LOCAL ROLE dental_backend;
      v_result := dental.create_patient(v_actor, pg_catalog.jsonb_build_object(
        'fullName', 'Synthetic Task8 ' || v_i, 'phone', '0000000000', 'age', 42,
        'address', 'Fictional Task8 address', 'relationship', 'self', 'authorizationAcknowledged', true));
      v_patient := (v_result ->> 'id')::uuid;
      v_result := dental.reserve(v_actor, pg_catalog.gen_random_uuid(), pg_catalog.jsonb_build_object(
        'patientId', v_patient, 'patientVersion', 1, 'service', 'oral_check', 'date', v_date::text,
        'ageConfirmed', 42, 'authorizationAcknowledged', true));
      v_booking := (v_result ->> 'id')::uuid;
      v_bookings := pg_catalog.array_append(v_bookings, v_booking);
      v_result := dental.decide(v_admin, v_booking, 1,
        CASE WHEN v_i = 4 THEN 'reject' ELSE 'approve' END, 'Synthetic Task8 review');
      IF (v_result ->> 'version')::integer IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'Smoke failed: synthetic decision version';
      END IF;
      RESET ROLE;
      IF v_i = 1 THEN
        IF (SELECT pg_catalog.count(*) FROM dental.outbox WHERE appointment_id = v_booking AND state = 'queued') <> 2
          OR (SELECT pg_catalog.count(*) FROM dental.outbox WHERE appointment_id = v_booking AND type = 'reminder'
            AND due_at = pg_catalog.timezone('Asia/Bangkok', (v_date - 1) + time '18:00')
            AND expires_at = pg_catalog.timezone('Asia/Bangkok', v_date::timestamp)) <> 1 THEN
          RAISE EXCEPTION 'Smoke failed: approval reminder enqueue';
        END IF;
        v_checks := pg_catalog.array_append(v_checks, 'approval_reminder_enqueue');
      END IF;
      IF v_i = 3 OR v_i = 4 THEN
        SET LOCAL ROLE dental_backend;
        PERFORM dental.record_line_reachability(v_provider, v_subject,
          '01' || pg_catalog.upper(pg_catalog.substr(pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 24)),
          pg_catalog.clock_timestamp(), v_i = 4);
        RESET ROLE;
      END IF;
      IF pg_catalog.clock_timestamp() >= v_guard_deadline THEN
        RAISE EXCEPTION 'Smoke deadline reached before global claim';
      END IF;
      v_worker := pg_catalog.gen_random_uuid();
      SET LOCAL ROLE dental_backend;
      v_result := dental.claim_events(v_worker, 1);
      IF pg_catalog.jsonb_array_length(v_result) IS DISTINCT FROM 1
        OR (v_result -> 0 ->> 'appointmentId')::uuid IS DISTINCT FROM v_booking THEN
        RAISE EXCEPTION 'Smoke failed: global claim was not exactly the current synthetic booking';
      END IF;
      v_event := (v_result -> 0 ->> 'id')::uuid;
      v_retry := (v_result -> 0 ->> 'retryKey')::uuid;
      IF v_retry IS NULL OR v_event IS NULL THEN RAISE EXCEPTION 'Smoke failed: durable event identity'; END IF;
      IF v_i = 1 THEN v_checks := pg_catalog.array_append(v_checks, 'claim_synthetic_only'); END IF;
      IF v_i = 2 THEN
        PERFORM dental.cancel(v_actor, v_booking, 2);
      END IF;
      v_prepared := dental.prepare_dispatch(v_worker, v_event, 'https://task8.invalid');
      IF v_i IN (2, 3) THEN
        IF v_prepared IS NOT NULL THEN RAISE EXCEPTION 'Smoke failed: ineligible dispatch was prepared'; END IF;
        RESET ROLE;
        IF (SELECT state FROM dental.outbox WHERE id = v_event AND appointment_id = v_booking)
            IS DISTINCT FROM CASE WHEN v_i = 2 THEN 'suppressed' ELSE 'failed' END
          OR (SELECT attempt_count FROM dental.outbox WHERE id = v_event AND appointment_id = v_booking) IS DISTINCT FROM 0
          OR EXISTS (SELECT FROM dental.notification_attempts WHERE outbox_id = v_event) THEN
          RAISE EXCEPTION 'Smoke failed: ineligible claim consumed attempt';
        END IF;
        IF v_i = 3 AND (SELECT failure_category FROM dental.outbox WHERE id = v_event AND appointment_id = v_booking)
          IS DISTINCT FROM 'recipient_unavailable' THEN RAISE EXCEPTION 'Smoke failed: unreachable category'; END IF;
        v_checks := pg_catalog.array_append(v_checks, CASE WHEN v_i = 2 THEN 'cancelled_claim_suppressed' ELSE 'unreachable_fails_closed' END);
      ELSE
        IF v_prepared IS NULL OR v_prepared ->> 'recipient' IS DISTINCT FROM v_subject
          OR v_prepared ->> 'date' IS DISTINCT FROM v_date::text
          OR v_prepared ->> 'manageUrl' IS DISTINCT FROM 'https://task8.invalid/appointments'
          OR (v_prepared ->> 'payloadVersion')::integer IS DISTINCT FROM 1
          OR (v_prepared -> 'event' ->> 'retryKey')::uuid IS DISTINCT FROM v_retry
          OR v_prepared ->> 'status' IS DISTINCT FROM CASE WHEN v_i = 4 THEN 'rejected' ELSE 'approved' END
          OR (SELECT pg_catalog.array_agg(k ORDER BY k) FROM pg_catalog.jsonb_object_keys(v_prepared) AS keys(k))
            IS DISTINCT FROM ARRAY['date','event','manageUrl','payloadVersion','recipient','reference','status']::text[] THEN
          RAISE EXCEPTION 'Smoke failed: minimal frozen synthetic payload';
        END IF;
        IF v_i = 1 THEN v_checks := pg_catalog.array_append(v_checks, 'minimal_frozen_payload'); END IF;
        IF dental.prepare_dispatch(v_worker, v_event, 'https://task8.invalid') IS NOT NULL THEN
          RAISE EXCEPTION 'Smoke failed: duplicate prepare authorized a second attempt';
        END IF;
        IF v_i = 1 THEN v_checks := pg_catalog.array_append(v_checks, 'duplicate_prepare_denied'); END IF;
        v_boolean := dental.finish_dispatch(v_worker, v_event,
            CASE WHEN v_i = 5 THEN '{"kind":"retryable","category":"server_error"}'::jsonb
            ELSE '{"kind":"accepted","requestId":"synthetic-task8-local-only"}'::jsonb END);
        v_duplicate := dental.finish_dispatch(v_worker, v_event, '{"kind":"accepted"}'::jsonb);
        IF v_boolean IS DISTINCT FROM true OR v_duplicate IS DISTINCT FROM false THEN
          RAISE EXCEPTION 'Smoke failed: local completion or duplicate fencing';
        END IF;
        RESET ROLE;
        IF v_i = 5 THEN
          IF NOT EXISTS (SELECT FROM dental.outbox o JOIN dental.notification_attempts a ON a.outbox_id = o.id
            WHERE o.id = v_event AND o.appointment_id = v_booking AND o.state = 'retry'
              AND o.attempt_count = 1 AND o.failure_category = 'server_error'
              AND o.due_at = a.finished_at + interval '1 minute'
              AND a.attempt_number = 1 AND a.worker_id = v_worker AND a.result = 'retryable'
              AND o.retry_key = v_retry AND o.dispatch_recipient = v_subject) THEN
            RAISE EXCEPTION 'Smoke failed: first retry backoff and stable frozen dispatch';
          END IF;
          v_checks := pg_catalog.array_append(v_checks, 'retry_backoff');
        ELSE
          IF NOT EXISTS (SELECT FROM dental.outbox o JOIN dental.notification_attempts a ON a.outbox_id = o.id
            WHERE o.id = v_event AND o.appointment_id = v_booking AND o.state = 'accepted'
              AND o.accepted_at IS NOT NULL AND o.attempt_count = 1 AND o.lease_owner IS NULL
              AND a.worker_id = v_worker AND a.result = 'accepted'
              AND a.provider_request_id = 'synthetic-task8-local-only') THEN
            RAISE EXCEPTION 'Smoke failed: local acceptance persistence';
          END IF;
          v_checks := pg_catalog.array_append(v_checks, CASE WHEN v_i = 1 THEN 'accepted_local_only' ELSE 'rejection_local_acceptance' END);
        END IF;
      END IF;
    END LOOP;
    IF (SELECT pg_catalog.array_agg(status ORDER BY n) FROM pg_catalog.unnest(v_bookings) WITH ORDINALITY ids(id,n)
        JOIN dental.appointments a ON a.id = ids.id AND a.owner_account_id = v_actor)
      IS DISTINCT FROM ARRAY['approved','cancelled','approved','rejected','approved']::text[] THEN
      RAISE EXCEPTION 'Smoke failed: notification outcome changed booking state';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'booking_state_unchanged');
    IF (SELECT pg_catalog.count(*) FROM dental.accounts WHERE provider = v_provider) <> 2
      OR (SELECT pg_catalog.count(*) FROM dental.patients WHERE owner_account_id = v_actor) <> 5
      OR (SELECT pg_catalog.count(*) FROM dental.appointments WHERE owner_account_id = v_actor) <> 5
      OR (SELECT pg_catalog.count(*) FROM dental.outbox WHERE appointment_id = ANY(v_bookings)) <> 9
      OR (SELECT pg_catalog.count(*) FROM dental.notification_attempts WHERE outbox_id IN
        (SELECT id FROM dental.outbox WHERE appointment_id = ANY(v_bookings))) <> 3
      OR (SELECT pg_catalog.count(*) FROM dental.admin_grants WHERE account_id = v_admin) <> 1 THEN
      RAISE EXCEPTION 'Smoke failed: synthetic scope totals';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'synthetic_scope');
    IF v_checks IS DISTINCT FROM v_expected_checks OR pg_catalog.cardinality(v_checks) <> 12 OR CURRENT_USER <> 'postgres' THEN
      RAISE EXCEPTION 'Incomplete connector smoke manifest';
    END IF;
    v_all_passed := true;
    RAISE EXCEPTION USING ERRCODE = 'PT998', MESSAGE = 'Task 8 smoke rollback sentinel';
  EXCEPTION WHEN SQLSTATE 'PT998' THEN
    IF NOT v_all_passed OR SQLERRM <> 'Task 8 smoke rollback sentinel' THEN RAISE; END IF;
    v_sentinel_seen := true;
  END;
  -- Still under outer locks. Compare safe metadata, counts, ACLs and definitions.
  EXECUTE v_state_sql INTO v_after;
  IF NOT v_all_passed OR NOT v_sentinel_seen OR v_checks IS DISTINCT FROM v_expected_checks
    OR v_before IS DISTINCT FROM v_after OR CURRENT_USER <> 'postgres' OR SESSION_USER <> 'postgres' THEN
    RAISE EXCEPTION 'Smoke rollback failed exact safe-metadata/catalog/count equality';
  END IF;
  IF EXISTS (SELECT FROM dental.accounts WHERE id IN (v_actor, v_admin) OR provider = v_provider)
    OR EXISTS (SELECT FROM dental.line_reachability WHERE provider = v_provider)
    OR EXISTS (SELECT FROM dental.line_webhook_events WHERE provider = v_provider) THEN
    RAISE EXCEPTION 'Synthetic fixture survived rollback';
  END IF;
  PERFORM pg_catalog.set_config('lock_timeout', v_lock_timeout, true);
  EXECUTE v_settings_sql INTO v_settings_after;
  IF v_settings_before IS DISTINCT FROM v_settings_after THEN RAISE EXCEPTION 'Execution settings were not restored'; END IF;
  -- Normal completion and separate exact read-only PRE/POST equality required.
  -- This does not replace the 144 independent-connection DB cases, still unrun.
END;
$task8_connector_smoke$;
