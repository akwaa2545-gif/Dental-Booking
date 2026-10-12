-- UNEXECUTED / UNVERIFIED Task 5 single-session connector smoke candidate.
-- Exact target: tooth-talk-staging YOUR_SUPABASE_PROJECT_REF. Separate action-time
-- approval must name this file hash, temporary security window and fixtures.
-- Apply and independently verify approved 004_sessions.sql FIRST.
-- One invoker DO; no transaction control, DDL, credentials or clock replacement.
-- All eleven dental tables must be empty and quiescent on managed PG17.
-- All mutations, role memberships, helper grants and locks are sentinel-rolled
-- back. Only explicitly expected failures and the private sentinel are caught.
-- No result rows, hashes, identity/PKCE payloads or notices are emitted.
DO $task5_connector_smoke$
DECLARE
  v_owner oid;
  v_backend oid;
  v_subject text := 'synthetic-task5-' || pg_catalog.gen_random_uuid()::text;
  v_unknown uuid := pg_catalog.gen_random_uuid();
  v_actor uuid;
  v_other_actor uuid;
  v_now timestamptz;
  v_expiry timestamptz;
  v_oauth_expiry timestamptz;
  v_revoked timestamptz;
  v_session1 jsonb;
  v_session2 jsonb;
  v_session3 jsonb;
  v_pending jsonb;
  v_result jsonb;
  v_case record;
  v_role text;
  v_table text;
  v_constraint text;
  v_constraint_schema text;
  v_constraint_table text;
  v_count bigint;
  v_error_seen boolean;
  v_all_passed boolean := false;
  v_sentinel_seen boolean := false;
  v_before jsonb;
  v_after jsonb;
  v_before_fingerprint text;
  v_after_fingerprint text;
  v_original_settings jsonb;
  v_restored_settings jsonb;
  v_checks text[] := ARRAY[]::text[];
  v_token1 constant text := pg_catalog.repeat('a', 64);
  v_token2 constant text := pg_catalog.repeat('b', 64);
  v_token3 constant text := pg_catalog.repeat('d', 64);
  v_csrf constant text := pg_catalog.repeat('c', 64);
  v_state constant text := pg_catalog.repeat('e', 64);
  v_binding constant text := pg_catalog.repeat('f', 64);
  v_expired_state constant text := pg_catalog.repeat('1', 64);
  v_missing_hash constant text := pg_catalog.repeat('9', 64);
  v_nonce constant text := pg_catalog.repeat('N', 43);
  v_verifier constant text := pg_catalog.repeat('V', 43);
  v_expected_checks constant text[] := ARRAY[
    'session_created_shape',
    'session_hashes_persisted',
    'session_resolves_exactly',
    'same_provider_subject_reused',
    'different_provider_subject_isolated',
    'admin_absent_by_default',
    'admin_grant_read_live',
    'admin_revocation_read_live',
    'session_revoke_immediate',
    'session_revoke_idempotent',
    'unknown_session_hidden',
    'session_expiry_real_clock',
    'invalid_session_lookup_hidden',
    'invalid_session_revoke_noop',
    'session_duplicate_hash_atomic',
    'create_invalid_provider_null',
    'create_invalid_provider_invalid',
    'create_invalid_provider_overlong',
    'create_invalid_subject_null',
    'create_invalid_subject_empty',
    'create_invalid_subject_control',
    'create_invalid_subject_overlong',
    'create_invalid_token_raw',
    'create_invalid_token_null',
    'create_invalid_csrf_raw',
    'create_invalid_csrf_null',
    'create_invalid_expiry_past',
    'create_invalid_expiry_null',
    'create_invalid_expiry_infinite',
    'create_invalid_expiry_overlong',
    'oauth_saved_server_held',
    'oauth_wrong_binding_preserves',
    'oauth_missing_hidden',
    'oauth_duplicate_state_preserves',
    'oauth_consume_exact',
    'oauth_replay_hidden',
    'oauth_expiry_real_clock',
    'oauth_expired_consumed',
    'oauth_invalid_lookup_hidden',
    'oauth_invalid_state_raw',
    'oauth_invalid_state_null',
    'oauth_invalid_binding_raw',
    'oauth_invalid_binding_null',
    'oauth_invalid_nonce_short',
    'oauth_invalid_nonce_null',
    'oauth_invalid_verifier_short',
    'oauth_invalid_verifier_null',
    'oauth_invalid_path_external',
    'oauth_invalid_path_network',
    'oauth_invalid_path_backslash',
    'oauth_invalid_path_encoded',
    'oauth_invalid_path_space',
    'oauth_invalid_path_null',
    'oauth_invalid_path_overlong',
    'oauth_invalid_expiry_past',
    'oauth_invalid_expiry_null',
    'oauth_invalid_expiry_infinite',
    'oauth_invalid_expiry_overlong',
    'backend_sessions_read_denied',
    'backend_oauth_pending_read_denied',
    'backend_admin_grant_insert_denied',
    'backend_session_update_denied',
    'owner_admin_grant_insert_denied',
    'owner_session_time_update_denied',
    'owner_oauth_update_denied',
    'anon_sessions_read_denied',
    'anon_oauth_pending_read_denied',
    'anon_admin_grants_read_denied',
    'anon_create_session_denied',
    'anon_resolve_session_denied',
    'anon_revoke_session_denied',
    'anon_is_admin_denied',
    'anon_save_oauth_pending_denied',
    'anon_consume_oauth_pending_denied',
    'authenticated_sessions_read_denied',
    'authenticated_oauth_pending_read_denied',
    'authenticated_admin_grants_read_denied',
    'authenticated_create_session_denied',
    'authenticated_resolve_session_denied',
    'authenticated_revoke_session_denied',
    'authenticated_is_admin_denied',
    'authenticated_save_oauth_pending_denied',
    'authenticated_consume_oauth_pending_denied',
    'synthetic_totals'
  ];
  v_settings_sql constant text := $settings_query$
  SELECT pg_catalog.jsonb_build_object(
    'currentUser', CURRENT_USER, 'sessionUser', SESSION_USER,
    'role', pg_catalog.current_setting('role'),
    'searchPath', pg_catalog.current_setting('search_path'),
    'statementTimeout', pg_catalog.current_setting('statement_timeout'),
    'lockTimeout', pg_catalog.current_setting('lock_timeout'),
    'transactionIsolation', pg_catalog.current_setting('transaction_isolation'),
    'transactionReadOnly', pg_catalog.current_setting('transaction_read_only')
  )
  $settings_query$;
  v_state_sql constant text := $state_query$
    SELECT pg_catalog.jsonb_build_object(
      'roles', (
        SELECT pg_catalog.jsonb_agg((pg_catalog.to_jsonb(r) - 'rolpassword') ORDER BY r.oid) FROM pg_catalog.pg_roles r
        WHERE r.rolname IN ('postgres', 'dental_function_owner', 'dental_backend', 'anon', 'authenticated', 'authenticator', 'service_role')
      ),
      'membershipCount', (
        SELECT pg_catalog.count(*) FROM pg_catalog.pg_auth_members m
        WHERE m.roleid IN ('dental_function_owner'::pg_catalog.regrole, 'dental_backend'::pg_catalog.regrole)
          OR m.member IN ('dental_function_owner'::pg_catalog.regrole, 'dental_backend'::pg_catalog.regrole)
      ),
      'memberships', (
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY m.roleid, m.member, m.grantor), '[]'::jsonb)
        FROM pg_catalog.pg_auth_members m
        WHERE m.roleid IN ('dental_function_owner'::pg_catalog.regrole, 'dental_backend'::pg_catalog.regrole)
          OR m.member IN ('dental_function_owner'::pg_catalog.regrole, 'dental_backend'::pg_catalog.regrole)
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
          'oid', p.oid, 'owner', p.proowner, 'acl', p.proacl,
          'config', p.proconfig, 'definer', p.prosecdef,
          'definition', pg_catalog.pg_get_functiondef(p.oid)
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
          'dental_backend'::pg_catalog.regrole
        )
      ),
      'columnDefaults', (
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'oid', d.oid, 'table', d.adrelid, 'column', d.adnum,
          'expression', pg_catalog.pg_get_expr(d.adbin, d.adrelid)
        ) ORDER BY d.oid), '[]'::jsonb)
        FROM pg_catalog.pg_attrdef d JOIN pg_catalog.pg_class c ON c.oid = d.adrelid
        WHERE c.relnamespace = 'dental'::pg_catalog.regnamespace
      ),
      'rows', pg_catalog.jsonb_build_object(
        'accounts', (SELECT pg_catalog.count(*) FROM dental.accounts),
        'sessions', (SELECT pg_catalog.count(*) FROM dental.sessions),
        'patients', (SELECT pg_catalog.count(*) FROM dental.patients),
        'appointments', (SELECT pg_catalog.count(*) FROM dental.appointments),
        'clinic_dates', (SELECT pg_catalog.count(*) FROM dental.clinic_dates),
        'admin_grants', (SELECT pg_catalog.count(*) FROM dental.admin_grants),
        'audit_events', (SELECT pg_catalog.count(*) FROM dental.audit_events),
        'outbox', (SELECT pg_catalog.count(*) FROM dental.outbox),
        'notification_attempts', (SELECT pg_catalog.count(*) FROM dental.notification_attempts),
        'submission_keys', (SELECT pg_catalog.count(*) FROM dental.submission_keys),
        'oauth_pending', (SELECT pg_catalog.count(*) FROM dental.oauth_pending)
      )
    )
  $state_query$;
BEGIN
  -- Changing statement_timeout within a running DO would not start its timer.
  -- Refuse unless the connector already started this command with a <=2min cap.
  IF (SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name = 'statement_timeout') NOT BETWEEN 1 AND 120000 THEN
    RAISE EXCEPTION 'Smoke test requires an inherited statement timeout between 1ms and 2min';
  END IF;
  IF CURRENT_USER <> 'postgres' OR SESSION_USER <> 'postgres'
    OR pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
    OR pg_catalog.current_setting('transaction_read_only') <> 'off'
    OR pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'Smoke test requires the reviewed writable READ COMMITTED PG17 postgres session';
  END IF;
  IF NOT EXISTS (
    SELECT FROM pg_catalog.pg_roles WHERE rolname = 'postgres'
      AND rolcreaterole AND rolbypassrls AND NOT rolsuper
  ) THEN
    RAISE EXCEPTION 'Smoke test operator capabilities differ from the reviewed probe';
  END IF;
  IF pg_catalog.to_regnamespace('dental') IS NULL
    OR pg_catalog.to_regrole('dental_function_owner') IS NULL
    OR pg_catalog.to_regrole('dental_backend') IS NULL THEN
    RAISE EXCEPTION 'Apply and verify the reviewed Task 5 migration first';
  END IF;
  v_owner := 'dental_function_owner'::pg_catalog.regrole;
  v_backend := 'dental_backend'::pg_catalog.regrole;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_auth_members WHERE roleid IN (v_owner, v_backend)) <> 2
    OR (SELECT pg_catalog.count(DISTINCT roleid) FROM pg_catalog.pg_auth_members WHERE roleid IN (v_owner, v_backend)) <> 2
    OR EXISTS (
      SELECT FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles g ON g.oid = m.grantor
      WHERE m.roleid IN (v_owner, v_backend) AND (
        m.member <> 'postgres'::pg_catalog.regrole OR NOT m.admin_option OR NOT g.rolsuper
        OR m.set_option OR m.inherit_option
      )
    ) OR EXISTS (SELECT FROM pg_catalog.pg_auth_members WHERE member IN (v_owner, v_backend))
    OR EXISTS (SELECT FROM pg_catalog.pg_roles WHERE oid IN (v_owner, v_backend)
      AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit)) THEN
    RAISE EXCEPTION 'Unexpected dental role baseline; no existing grant will be altered';
  END IF;
  FOR v_case IN SELECT * FROM (VALUES
    ('dental.create_session(text,text,text,text,timestamptz)'),
    ('dental.resolve_session(text)'), ('dental.revoke_session(text)'),
    ('dental.is_admin(uuid)'),
    ('dental.save_oauth_pending(text,text,text,text,text,timestamptz)'),
    ('dental.consume_oauth_pending(text,text)')
  ) AS required(signature) LOOP
    IF pg_catalog.to_regprocedure(v_case.signature) IS NULL THEN
      RAISE EXCEPTION 'Required reviewed Task 5 function is absent';
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_proc WHERE oid = pg_catalog.to_regprocedure(v_case.signature)
        AND prosecdef AND proowner = v_owner AND proconfig = ARRAY['search_path=""'])
      OR NOT pg_catalog.has_function_privilege(v_backend, v_case.signature, 'EXECUTE')
      OR pg_catalog.has_function_privilege('postgres', v_case.signature, 'EXECUTE') THEN
      RAISE EXCEPTION 'Task 5 entry-point ownership or effective execute baseline differs';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_language l ON l.oid = p.prolang
    WHERE p.oid = pg_catalog.to_regprocedure('dental.clock_now()')
      AND l.lanname = 'sql' AND NOT p.prosecdef AND p.provolatile = 'v'
      AND pg_catalog.btrim(p.prosrc) = 'SELECT pg_catalog.clock_timestamp()') THEN
    RAISE EXCEPTION 'Real clock helper differs from the reviewed migration';
  END IF;
  IF (SELECT pg_catalog.array_agg(c.relname::text ORDER BY c.relname)
      FROM pg_catalog.pg_class c WHERE c.relnamespace = 'dental'::pg_catalog.regnamespace AND c.relkind = 'r')
    IS DISTINCT FROM ARRAY['accounts', 'admin_grants', 'appointments', 'audit_events', 'clinic_dates',
      'notification_attempts', 'oauth_pending', 'outbox', 'patients', 'sessions', 'submission_keys']::text[] THEN
    RAISE EXCEPTION 'Expected exactly the eleven reviewed private tables';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc WHERE pronamespace = 'dental'::pg_catalog.regnamespace) <> 19
    OR EXISTS (SELECT FROM pg_catalog.pg_proc WHERE pronamespace = 'dental'::pg_catalog.regnamespace
      AND (proowner <> v_owner OR proconfig IS DISTINCT FROM ARRAY['search_path=""']))
    OR EXISTS (SELECT FROM pg_catalog.pg_class WHERE relnamespace = 'dental'::pg_catalog.regnamespace AND relkind = 'r'
      AND (relowner <> 'postgres'::pg_catalog.regrole OR NOT relrowsecurity OR NOT relforcerowsecurity)) THEN
    RAISE EXCEPTION 'Task 5 ownership, private function surface or RLS baseline differs';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF pg_catalog.to_regrole(v_role) IS NULL OR NOT pg_catalog.pg_has_role('postgres', v_role, 'SET') THEN
      RAISE EXCEPTION 'Existing operator permission to test browser role is absent';
    END IF;
  END LOOP;
  FOREACH v_table IN ARRAY ARRAY['accounts', 'sessions', 'patients', 'appointments', 'clinic_dates',
    'admin_grants', 'audit_events', 'outbox', 'notification_attempts', 'submission_keys', 'oauth_pending'] LOOP
    IF pg_catalog.has_table_privilege(v_backend, 'dental.' || v_table, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR pg_catalog.has_any_column_privilege(v_backend, 'dental.' || v_table, 'SELECT,INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Backend direct table grant is unsafe even if RLS would reject access';
    END IF;
  END LOOP;

  -- Platform and browser roles must have no effective private access path.
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'authenticator', 'service_role'] LOOP
    IF pg_catalog.to_regrole(v_role) IS NOT NULL AND (
      pg_catalog.pg_has_role(v_role, v_owner, 'MEMBER') OR pg_catalog.pg_has_role(v_role, v_backend, 'MEMBER')
      OR pg_catalog.has_schema_privilege(v_role, 'dental', 'USAGE,CREATE')
      OR EXISTS (SELECT FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'dental'::pg_catalog.regnamespace
        AND pg_catalog.has_function_privilege(v_role, p.oid, 'EXECUTE'))
      OR EXISTS (SELECT FROM pg_catalog.pg_class c WHERE c.relnamespace = 'dental'::pg_catalog.regnamespace AND c.relkind = 'r'
        AND (pg_catalog.has_table_privilege(v_role, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
          OR pg_catalog.has_any_column_privilege(v_role, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')))
    ) THEN RAISE EXCEPTION 'Browser or platform role has unreviewed private access'; END IF;
  END LOOP;
  EXECUTE v_settings_sql INTO v_original_settings;
  BEGIN
    PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
    LOCK TABLE dental.accounts, dental.sessions, dental.patients, dental.clinic_dates,
      dental.appointments, dental.submission_keys, dental.admin_grants,
      dental.audit_events, dental.outbox, dental.notification_attempts, dental.oauth_pending
      IN SHARE ROW EXCLUSIVE MODE;
    EXECUTE v_state_sql INTO v_before;
    v_before_fingerprint := pg_catalog.md5(v_before::text);
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_each(v_before -> 'rows')) <> 11
      OR EXISTS (SELECT FROM pg_catalog.jsonb_each_text(v_before -> 'rows') n WHERE n.value::bigint <> 0) THEN
      RAISE EXCEPTION 'Smoke requires all eleven private tables empty; no existing application data may be touched';
    END IF;
    GRANT dental_function_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
    GRANT dental_backend TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
    SET LOCAL ROLE dental_function_owner;
    -- Required only for the synthetic operator admin-grant default and expiry
    -- fixture writes. No other helper/schema/table/runtime grant is added.
    IF NOT pg_catalog.has_function_privilege('postgres', 'dental.clock_now()', 'EXECUTE') THEN
      GRANT EXECUTE ON FUNCTION dental.clock_now() TO postgres;
    END IF;
    RESET ROLE;
    v_now := pg_catalog.clock_timestamp();
    v_expiry := v_now + interval '30 minutes';
    v_oauth_expiry := v_now + interval '5 minutes';
    SET LOCAL ROLE dental_backend;
    v_session1 := dental.create_session('line:synthetic-task5-a', v_subject, v_token1, v_csrf, v_expiry);
    v_actor := (v_session1 ->> 'accountId')::uuid;
    IF v_actor IS NULL OR v_session1 IS DISTINCT FROM pg_catalog.jsonb_build_object(
      'accountId', v_actor, 'csrfHash', v_csrf, 'expiresAt', v_expiry, 'isAdmin', false) THEN
      RAISE EXCEPTION 'Smoke check failed: session_created_shape';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'session_created_shape');
    RESET ROLE;
    IF (SELECT pg_catalog.count(*) FROM dental.accounts WHERE id = v_actor
          AND provider = 'line:synthetic-task5-a' AND subject = v_subject) <> 1
      OR (SELECT pg_catalog.count(*) FROM dental.sessions WHERE account_id = v_actor
          AND token_hash = v_token1 AND csrf_hash = v_csrf AND expires_at = v_expiry
          AND created_at >= v_now AND revoked_at IS NULL) <> 1 THEN
      RAISE EXCEPTION 'Smoke check failed: session_hashes_persisted';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'session_hashes_persisted');
    SET LOCAL ROLE dental_backend;
    IF dental.resolve_session(v_token1) IS DISTINCT FROM v_session1 THEN
      RAISE EXCEPTION 'Smoke check failed: session_resolves_exactly';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'session_resolves_exactly');
    v_session2 := dental.create_session('line:synthetic-task5-a', v_subject, v_token2, v_csrf, v_expiry);
    IF v_session2 IS DISTINCT FROM v_session1 THEN
      RAISE EXCEPTION 'Smoke check failed: same_provider_subject_reused';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'same_provider_subject_reused');
    v_session3 := dental.create_session('line:synthetic-task5-b', v_subject, v_token3, v_csrf, v_expiry);
    v_other_actor := (v_session3 ->> 'accountId')::uuid;
    IF v_other_actor IS NULL OR v_other_actor = v_actor
      OR v_session3 IS DISTINCT FROM pg_catalog.jsonb_build_object(
        'accountId', v_other_actor, 'csrfHash', v_csrf, 'expiresAt', v_expiry, 'isAdmin', false)
      OR dental.resolve_session(v_token3) IS DISTINCT FROM v_session3 THEN
      RAISE EXCEPTION 'Smoke check failed: different_provider_subject_isolated';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'different_provider_subject_isolated');
    IF dental.is_admin(v_actor) IS DISTINCT FROM false
      OR dental.is_admin(v_other_actor) IS DISTINCT FROM false
      OR dental.is_admin(v_unknown) IS DISTINCT FROM false OR dental.is_admin(NULL) IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'Smoke check failed: admin_absent_by_default';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'admin_absent_by_default');
    RESET ROLE;
    -- One SYNTHETIC operator fixture only, not an actual app-admin assignment.
    INSERT INTO dental.admin_grants(account_id) VALUES (v_actor);
    SET LOCAL ROLE dental_backend;
    IF dental.is_admin(v_actor) IS DISTINCT FROM true
      OR dental.resolve_session(v_token1) IS DISTINCT FROM (v_session1 || '{"isAdmin":true}'::jsonb)
      OR dental.resolve_session(v_token3) IS DISTINCT FROM v_session3 THEN
      RAISE EXCEPTION 'Smoke check failed: admin_grant_read_live';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'admin_grant_read_live');
    RESET ROLE;
    UPDATE dental.admin_grants SET revoked_at = dental.clock_now() WHERE account_id = v_actor;
    SET LOCAL ROLE dental_backend;
    IF dental.is_admin(v_actor) IS DISTINCT FROM false OR dental.resolve_session(v_token1) IS DISTINCT FROM v_session1 THEN
      RAISE EXCEPTION 'Smoke check failed: admin_revocation_read_live';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'admin_revocation_read_live');
    PERFORM dental.revoke_session(v_token1);
    IF dental.resolve_session(v_token1) IS NOT NULL OR dental.resolve_session(v_token2) IS DISTINCT FROM v_session2 THEN
      RAISE EXCEPTION 'Smoke check failed: session_revoke_immediate';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'session_revoke_immediate');
    RESET ROLE;
    SELECT revoked_at INTO STRICT v_revoked FROM dental.sessions WHERE token_hash = v_token1;
    IF v_revoked IS NULL THEN RAISE EXCEPTION 'Synthetic revocation was not persisted'; END IF;
    SET LOCAL ROLE dental_backend;
    PERFORM dental.revoke_session(v_token1);
    RESET ROLE;
    IF (SELECT revoked_at FROM dental.sessions WHERE token_hash = v_token1) IS DISTINCT FROM v_revoked THEN
      RAISE EXCEPTION 'Smoke check failed: session_revoke_idempotent';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'session_revoke_idempotent');
    SET LOCAL ROLE dental_backend;
    PERFORM dental.revoke_session(v_missing_hash);
    IF dental.resolve_session(v_missing_hash) IS NOT NULL THEN RAISE EXCEPTION 'Smoke check failed: unknown_session_hidden'; END IF;
    v_checks := pg_catalog.array_append(v_checks, 'unknown_session_hidden');
    RESET ROLE;
    v_now := pg_catalog.clock_timestamp();
    UPDATE dental.sessions SET created_at = v_now - interval '2 hours', expires_at = v_now - interval '1 hour'
      WHERE token_hash = v_token2 AND account_id = v_actor;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 1 THEN RAISE EXCEPTION 'Synthetic expired session fixture missing'; END IF;
    SET LOCAL ROLE dental_backend;
    IF dental.resolve_session(v_token2) IS NOT NULL OR dental.resolve_session(v_token3) IS DISTINCT FROM v_session3 THEN
      RAISE EXCEPTION 'Smoke check failed: session_expiry_real_clock';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'session_expiry_real_clock');
    IF dental.resolve_session(NULL) IS NOT NULL OR dental.resolve_session('synthetic-not-a-hash') IS NOT NULL
      OR dental.resolve_session(pg_catalog.upper(v_token3)) IS NOT NULL THEN
      RAISE EXCEPTION 'Smoke check failed: invalid_session_lookup_hidden';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'invalid_session_lookup_hidden');
    PERFORM dental.revoke_session(NULL);
    PERFORM dental.revoke_session('synthetic-not-a-hash');
    PERFORM dental.revoke_session(pg_catalog.upper(v_token3));
    IF dental.resolve_session(v_token3) IS DISTINCT FROM v_session3 THEN
      RAISE EXCEPTION 'Smoke check failed: invalid_session_revoke_noop';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'invalid_session_revoke_noop');
    v_error_seen := false;
    BEGIN
      -- The fresh identity insert must roll back together with a duplicate hash.
      PERFORM dental.create_session('line:synthetic-task5-duplicate', v_subject, v_token3, v_csrf, v_expiry);
    EXCEPTION WHEN SQLSTATE '23505' THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME, v_constraint_schema = SCHEMA_NAME, v_constraint_table = TABLE_NAME;
      IF v_constraint IS DISTINCT FROM 'sessions_token_hash_key' OR v_constraint_schema IS DISTINCT FROM 'dental'
        OR v_constraint_table IS DISTINCT FROM 'sessions' THEN RAISE; END IF;
      v_error_seen := true;
    END;
    RESET ROLE;
    IF NOT v_error_seen OR EXISTS (SELECT FROM dental.accounts WHERE provider = 'line:synthetic-task5-duplicate')
      OR (SELECT pg_catalog.count(*) FROM dental.accounts) <> 2 OR (SELECT pg_catalog.count(*) FROM dental.sessions) <> 3 THEN
      RAISE EXCEPTION 'Smoke check failed: session_duplicate_hash_atomic';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'session_duplicate_hash_atomic');
    SET LOCAL ROLE dental_backend;
    FOR v_case IN SELECT * FROM (VALUES
      (1, 'provider_null'::text, NULL, v_subject, v_missing_hash, v_csrf, v_expiry),
      (2, 'provider_invalid'::text, 'bad provider', v_subject, v_missing_hash, v_csrf, v_expiry),
      (3, 'provider_overlong'::text, pg_catalog.repeat('x', 121), v_subject, v_missing_hash, v_csrf, v_expiry),
      (4, 'subject_null'::text, 'line:synthetic-task5-invalid'::text, NULL, v_missing_hash, v_csrf, v_expiry),
      (5, 'subject_empty'::text, 'line:synthetic-task5-invalid'::text, '', v_missing_hash, v_csrf, v_expiry),
      (6, 'subject_control'::text, 'line:synthetic-task5-invalid'::text, 'synthetic' || pg_catalog.chr(10), v_missing_hash, v_csrf, v_expiry),
      (7, 'subject_overlong'::text, 'line:synthetic-task5-invalid'::text, pg_catalog.repeat('x', 256), v_missing_hash, v_csrf, v_expiry),
      (8, 'token_raw'::text, 'line:synthetic-task5-invalid'::text, v_subject, 'synthetic-not-a-hash', v_csrf, v_expiry),
      (9, 'token_null'::text, 'line:synthetic-task5-invalid'::text, v_subject, NULL, v_csrf, v_expiry),
      (10, 'csrf_raw'::text, 'line:synthetic-task5-invalid'::text, v_subject, v_missing_hash, 'synthetic-not-a-hash', v_expiry),
      (11, 'csrf_null'::text, 'line:synthetic-task5-invalid'::text, v_subject, v_missing_hash, NULL, v_expiry),
      (12, 'expiry_past'::text, 'line:synthetic-task5-invalid'::text, v_subject, v_missing_hash, v_csrf, v_now - interval '1 hour'),
      (13, 'expiry_null'::text, 'line:synthetic-task5-invalid'::text, v_subject, v_missing_hash, v_csrf, NULL),
      (14, 'expiry_infinite'::text, 'line:synthetic-task5-invalid'::text, v_subject, v_missing_hash, v_csrf, 'infinity'::timestamptz),
      (15, 'expiry_overlong'::text, 'line:synthetic-task5-invalid'::text, v_subject, v_missing_hash, v_csrf, v_now + interval '3 hours')
    ) cases(position, name, provider, subject, token_hash, csrf_hash, expiry) ORDER BY position LOOP
      v_error_seen := false;
      BEGIN
        PERFORM dental.create_session(v_case.provider, v_case.subject, v_case.token_hash, v_case.csrf_hash, v_case.expiry);
      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM <> 'VALIDATION' THEN RAISE; END IF;
        v_error_seen := true;
      END;
      IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: create_invalid_%', v_case.name; END IF;
      v_checks := pg_catalog.array_append(v_checks, 'create_invalid_' || v_case.name);
    END LOOP;

    PERFORM dental.save_oauth_pending(v_state, v_binding, v_nonce, v_verifier, '/appointments', v_oauth_expiry);
    RESET ROLE;
    IF (SELECT pg_catalog.count(*) FROM dental.oauth_pending WHERE state_hash = v_state AND binding_hash = v_binding
        AND nonce = v_nonce AND code_verifier = v_verifier AND return_path = '/appointments'
        AND expires_at = v_oauth_expiry AND created_at <= pg_catalog.clock_timestamp()) <> 1 THEN
      RAISE EXCEPTION 'Smoke check failed: oauth_saved_server_held';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'oauth_saved_server_held');
    SET LOCAL ROLE dental_backend;
    IF dental.consume_oauth_pending(v_state, v_missing_hash) IS NOT NULL THEN
      RAISE EXCEPTION 'Smoke check failed: oauth_wrong_binding_preserves';
    END IF;
    RESET ROLE;
    IF (SELECT pg_catalog.count(*) FROM dental.oauth_pending WHERE state_hash = v_state AND binding_hash = v_binding) <> 1 THEN
      RAISE EXCEPTION 'Smoke check failed: oauth_wrong_binding_preserves';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'oauth_wrong_binding_preserves');
    SET LOCAL ROLE dental_backend;
    IF dental.consume_oauth_pending(v_missing_hash, v_binding) IS NOT NULL THEN
      RAISE EXCEPTION 'Smoke check failed: oauth_missing_hidden';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'oauth_missing_hidden');
    v_error_seen := false;
    BEGIN
      PERFORM dental.save_oauth_pending(v_state, v_missing_hash, v_nonce, pg_catalog.repeat('W', 43), '/booking', v_oauth_expiry);
    EXCEPTION WHEN SQLSTATE '23505' THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME, v_constraint_schema = SCHEMA_NAME, v_constraint_table = TABLE_NAME;
      IF v_constraint IS DISTINCT FROM 'oauth_pending_pkey' OR v_constraint_schema IS DISTINCT FROM 'dental'
        OR v_constraint_table IS DISTINCT FROM 'oauth_pending' THEN RAISE; END IF;
      v_error_seen := true;
    END;
    RESET ROLE;
    IF NOT v_error_seen OR (SELECT pg_catalog.count(*) FROM dental.oauth_pending WHERE state_hash = v_state
        AND binding_hash = v_binding AND code_verifier = v_verifier AND return_path = '/appointments') <> 1 THEN
      RAISE EXCEPTION 'Smoke check failed: oauth_duplicate_state_preserves';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'oauth_duplicate_state_preserves');
    SET LOCAL ROLE dental_backend;
    v_pending := dental.consume_oauth_pending(v_state, v_binding);
    IF v_pending IS DISTINCT FROM pg_catalog.jsonb_build_object('stateHash', v_state, 'bindingHash', v_binding,
        'nonce', v_nonce, 'codeVerifier', v_verifier, 'returnPath', '/appointments', 'expiresAt', v_oauth_expiry) THEN
      RAISE EXCEPTION 'Smoke check failed: oauth_consume_exact';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'oauth_consume_exact');
    IF dental.consume_oauth_pending(v_state, v_binding) IS NOT NULL THEN RAISE EXCEPTION 'Smoke check failed: oauth_replay_hidden'; END IF;
    v_checks := pg_catalog.array_append(v_checks, 'oauth_replay_hidden');
    PERFORM dental.save_oauth_pending(v_expired_state, v_binding, v_nonce, v_verifier, '/booking', v_oauth_expiry);
    RESET ROLE;
    v_now := pg_catalog.clock_timestamp();
    UPDATE dental.oauth_pending SET created_at = v_now - interval '20 minutes', expires_at = v_now - interval '10 minutes'
      WHERE state_hash = v_expired_state AND binding_hash = v_binding;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count <> 1 THEN RAISE EXCEPTION 'Synthetic expired OAuth fixture missing'; END IF;
    SET LOCAL ROLE dental_backend;
    IF dental.consume_oauth_pending(v_expired_state, v_binding) IS NOT NULL THEN
      RAISE EXCEPTION 'Smoke check failed: oauth_expiry_real_clock';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'oauth_expiry_real_clock');
    RESET ROLE;
    IF EXISTS (SELECT FROM dental.oauth_pending WHERE state_hash = v_expired_state) THEN
      RAISE EXCEPTION 'Smoke check failed: oauth_expired_consumed';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'oauth_expired_consumed');
    SET LOCAL ROLE dental_backend;
    IF dental.consume_oauth_pending(NULL, v_binding) IS NOT NULL
      OR dental.consume_oauth_pending(v_state, NULL) IS NOT NULL
      OR dental.consume_oauth_pending('synthetic-not-a-hash', v_binding) IS NOT NULL
      OR dental.consume_oauth_pending(v_state, 'synthetic-not-a-hash') IS NOT NULL THEN
      RAISE EXCEPTION 'Smoke check failed: oauth_invalid_lookup_hidden';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'oauth_invalid_lookup_hidden');
    FOR v_case IN SELECT * FROM (VALUES
      (1, 'state_raw'::text, 'synthetic-not-a-hash', v_binding, v_nonce, v_verifier, '/appointments'::text, v_oauth_expiry),
      (2, 'state_null'::text, NULL, v_binding, v_nonce, v_verifier, '/appointments'::text, v_oauth_expiry),
      (3, 'binding_raw'::text, v_missing_hash, 'synthetic-not-a-hash', v_nonce, v_verifier, '/appointments'::text, v_oauth_expiry),
      (4, 'binding_null'::text, v_missing_hash, NULL, v_nonce, v_verifier, '/appointments'::text, v_oauth_expiry),
      (5, 'nonce_short'::text, v_missing_hash, v_binding, 'short', v_verifier, '/appointments'::text, v_oauth_expiry),
      (6, 'nonce_null'::text, v_missing_hash, v_binding, NULL, v_verifier, '/appointments'::text, v_oauth_expiry),
      (7, 'verifier_short'::text, v_missing_hash, v_binding, v_nonce, 'short', '/appointments'::text, v_oauth_expiry),
      (8, 'verifier_null'::text, v_missing_hash, v_binding, v_nonce, NULL, '/appointments'::text, v_oauth_expiry),
      (9, 'path_external'::text, v_missing_hash, v_binding, v_nonce, v_verifier, 'https://invalid.example', v_oauth_expiry),
      (10, 'path_network'::text, v_missing_hash, v_binding, v_nonce, v_verifier, '//invalid.example', v_oauth_expiry),
      (11, 'path_backslash'::text, v_missing_hash, v_binding, v_nonce, v_verifier, '/' || pg_catalog.chr(92) || 'invalid.example', v_oauth_expiry),
      (12, 'path_encoded'::text, v_missing_hash, v_binding, v_nonce, v_verifier, '/%2finvalid.example', v_oauth_expiry),
      (13, 'path_space'::text, v_missing_hash, v_binding, v_nonce, v_verifier, '/synthetic path', v_oauth_expiry),
      (14, 'path_null'::text, v_missing_hash, v_binding, v_nonce, v_verifier, NULL, v_oauth_expiry),
      (15, 'path_overlong'::text, v_missing_hash, v_binding, v_nonce, v_verifier, '/' || pg_catalog.repeat('x', 2048), v_oauth_expiry),
      (16, 'expiry_past'::text, v_missing_hash, v_binding, v_nonce, v_verifier, '/appointments'::text, v_now - interval '1 hour'),
      (17, 'expiry_null'::text, v_missing_hash, v_binding, v_nonce, v_verifier, '/appointments'::text, NULL),
      (18, 'expiry_infinite'::text, v_missing_hash, v_binding, v_nonce, v_verifier, '/appointments'::text, 'infinity'::timestamptz),
      (19, 'expiry_overlong'::text, v_missing_hash, v_binding, v_nonce, v_verifier, '/appointments'::text, v_now + interval '20 minutes')
    ) cases(position, name, state_hash, binding_hash, nonce, verifier, path, expiry) ORDER BY position LOOP
      v_error_seen := false;
      BEGIN
        PERFORM dental.save_oauth_pending(v_case.state_hash, v_case.binding_hash, v_case.nonce, v_case.verifier, v_case.path, v_case.expiry);
      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM <> 'VALIDATION' THEN RAISE; END IF;
        v_error_seen := true;
      END;
      IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: oauth_invalid_%', v_case.name; END IF;
      v_checks := pg_catalog.array_append(v_checks, 'oauth_invalid_' || v_case.name);
    END LOOP;
    v_error_seen := false;
    BEGIN
      SELECT pg_catalog.count(*) INTO v_count FROM dental.sessions;
    EXCEPTION WHEN SQLSTATE '42501' THEN v_error_seen := true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: backend_sessions_read_denied'; END IF;
    v_checks := pg_catalog.array_append(v_checks, 'backend_sessions_read_denied');
    v_error_seen := false;
    BEGIN
      SELECT pg_catalog.count(*) INTO v_count FROM dental.oauth_pending;
    EXCEPTION WHEN SQLSTATE '42501' THEN v_error_seen := true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: backend_oauth_pending_read_denied'; END IF;
    v_checks := pg_catalog.array_append(v_checks, 'backend_oauth_pending_read_denied');
    v_error_seen := false;
    BEGIN
      INSERT INTO dental.admin_grants(account_id) VALUES (v_other_actor);
    EXCEPTION WHEN SQLSTATE '42501' THEN v_error_seen := true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: backend_admin_grant_insert_denied'; END IF;
    v_checks := pg_catalog.array_append(v_checks, 'backend_admin_grant_insert_denied');
    v_error_seen := false;
    BEGIN
      UPDATE dental.sessions SET revoked_at = pg_catalog.clock_timestamp() WHERE token_hash = v_token3;
    EXCEPTION WHEN SQLSTATE '42501' THEN v_error_seen := true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: backend_session_update_denied'; END IF;
    v_checks := pg_catalog.array_append(v_checks, 'backend_session_update_denied');
    RESET ROLE;
    SET LOCAL ROLE dental_function_owner;
    v_error_seen := false;
    BEGIN
      INSERT INTO dental.admin_grants(account_id) VALUES (v_other_actor);
    EXCEPTION WHEN SQLSTATE '42501' THEN v_error_seen := true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: owner_admin_grant_insert_denied'; END IF;
    v_checks := pg_catalog.array_append(v_checks, 'owner_admin_grant_insert_denied');
    v_error_seen := false;
    BEGIN
      UPDATE dental.sessions SET expires_at = v_expiry WHERE token_hash = v_token3;
    EXCEPTION WHEN SQLSTATE '42501' THEN v_error_seen := true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: owner_session_time_update_denied'; END IF;
    v_checks := pg_catalog.array_append(v_checks, 'owner_session_time_update_denied');
    v_error_seen := false;
    BEGIN
      UPDATE dental.oauth_pending SET return_path = '/booking' WHERE state_hash = v_state;
    EXCEPTION WHEN SQLSTATE '42501' THEN v_error_seen := true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: owner_oauth_update_denied'; END IF;
    v_checks := pg_catalog.array_append(v_checks, 'owner_oauth_update_denied');
    RESET ROLE;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      EXECUTE pg_catalog.format('SET LOCAL ROLE %I', v_role);
      FOREACH v_table IN ARRAY ARRAY['sessions', 'oauth_pending', 'admin_grants'] LOOP
        v_error_seen := false;
        BEGIN
          EXECUTE pg_catalog.format('SELECT count(*) FROM dental.%I', v_table) INTO v_count;
        EXCEPTION WHEN SQLSTATE '42501' THEN v_error_seen := true;
        END;
        IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: browser private read allowed'; END IF;
        v_checks := pg_catalog.array_append(v_checks, v_role || '_' || v_table || '_read_denied');
      END LOOP;
      v_error_seen := false;
      BEGIN
        PERFORM dental.create_session('line:synthetic-task5-browser', v_subject, v_missing_hash, v_csrf, v_expiry);
      EXCEPTION WHEN SQLSTATE '42501' THEN v_error_seen := true;
      END;
      IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: browser create_session allowed'; END IF;
      v_checks := pg_catalog.array_append(v_checks, v_role || '_create_session_denied');
      v_error_seen := false;
      BEGIN
        PERFORM dental.resolve_session(v_token3);
      EXCEPTION WHEN SQLSTATE '42501' THEN v_error_seen := true;
      END;
      IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: browser resolve_session allowed'; END IF;
      v_checks := pg_catalog.array_append(v_checks, v_role || '_resolve_session_denied');
      v_error_seen := false;
      BEGIN
        PERFORM dental.revoke_session(v_token3);
      EXCEPTION WHEN SQLSTATE '42501' THEN v_error_seen := true;
      END;
      IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: browser revoke_session allowed'; END IF;
      v_checks := pg_catalog.array_append(v_checks, v_role || '_revoke_session_denied');
      v_error_seen := false;
      BEGIN
        PERFORM dental.is_admin(v_actor);
      EXCEPTION WHEN SQLSTATE '42501' THEN v_error_seen := true;
      END;
      IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: browser is_admin allowed'; END IF;
      v_checks := pg_catalog.array_append(v_checks, v_role || '_is_admin_denied');
      v_error_seen := false;
      BEGIN
        PERFORM dental.save_oauth_pending(v_missing_hash, v_binding, v_nonce, v_verifier, '/appointments', v_oauth_expiry);
      EXCEPTION WHEN SQLSTATE '42501' THEN v_error_seen := true;
      END;
      IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: browser save_oauth_pending allowed'; END IF;
      v_checks := pg_catalog.array_append(v_checks, v_role || '_save_oauth_pending_denied');
      v_error_seen := false;
      BEGIN
        PERFORM dental.consume_oauth_pending(v_state, v_binding);
      EXCEPTION WHEN SQLSTATE '42501' THEN v_error_seen := true;
      END;
      IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: browser consume_oauth_pending allowed'; END IF;
      v_checks := pg_catalog.array_append(v_checks, v_role || '_consume_oauth_pending_denied');
      RESET ROLE;
    END LOOP;
    EXECUTE v_state_sql INTO v_after;
    IF v_after -> 'rows' IS DISTINCT FROM pg_catalog.jsonb_build_object(
      'accounts', 2, 'sessions', 3, 'admin_grants', 1, 'oauth_pending', 0,
      'patients', 0, 'appointments', 0, 'clinic_dates', 0, 'audit_events', 0,
      'outbox', 0, 'notification_attempts', 0, 'submission_keys', 0)
      OR (SELECT pg_catalog.count(*) FROM dental.sessions WHERE revoked_at IS NOT NULL) <> 1
      OR (SELECT pg_catalog.count(*) FROM dental.sessions WHERE token_hash = v_token2 AND revoked_at IS NULL
        AND expires_at < pg_catalog.clock_timestamp()) <> 1
      OR (SELECT pg_catalog.count(*) FROM dental.sessions WHERE token_hash = v_token3 AND revoked_at IS NULL
        AND expires_at > pg_catalog.clock_timestamp()) <> 1
      OR (SELECT pg_catalog.count(*) FROM dental.accounts WHERE subject = v_subject
        AND provider IN ('line:synthetic-task5-a', 'line:synthetic-task5-b')) <> 2
      OR (SELECT pg_catalog.count(*) FROM dental.admin_grants WHERE account_id = v_actor AND revoked_at IS NOT NULL) <> 1 THEN
      RAISE EXCEPTION 'Smoke check failed: synthetic_totals';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'synthetic_totals');
    IF v_checks IS DISTINCT FROM v_expected_checks OR pg_catalog.cardinality(v_checks) <> 84
      OR CURRENT_USER <> 'postgres' THEN
      RAISE EXCEPTION 'Smoke checks did not all finish in the expected execution context';
    END IF;
    v_all_passed := true;
    RAISE EXCEPTION USING ERRCODE = 'PT995', MESSAGE = 'Task 5 smoke rollback sentinel';
  EXCEPTION WHEN SQLSTATE 'PT995' THEN
    -- Variables survive; changes, temporary grants, role/settings and locks roll
    -- back to the block entry before the restoration assertions below.
    IF NOT v_all_passed OR SQLERRM <> 'Task 5 smoke rollback sentinel' THEN RAISE; END IF;
    v_sentinel_seen := true;
  END;
  EXECUTE v_settings_sql INTO v_restored_settings;
  IF NOT v_all_passed OR NOT v_sentinel_seen OR v_checks IS DISTINCT FROM v_expected_checks
    OR CURRENT_USER <> 'postgres' OR SESSION_USER <> 'postgres'
    OR v_original_settings IS DISTINCT FROM v_restored_settings THEN
    RAISE EXCEPTION 'Smoke rollback did not restore the reviewed execution context and settings';
  END IF;
  EXECUTE v_state_sql INTO v_after;
  v_after_fingerprint := pg_catalog.md5(v_after::text);
  IF v_before IS DISTINCT FROM v_after OR v_before_fingerprint IS DISTINCT FROM v_after_fingerprint THEN
    RAISE EXCEPTION 'Smoke rollback changed roles, memberships, ACLs, policies, functions, defaults or table counts';
  END IF;
  IF EXISTS (SELECT FROM dental.accounts WHERE subject = v_subject)
    OR EXISTS (SELECT FROM dental.sessions WHERE token_hash IN (v_token1, v_token2, v_token3, v_missing_hash))
    OR EXISTS (SELECT FROM dental.admin_grants WHERE account_id IN (v_actor, v_other_actor))
    OR EXISTS (SELECT FROM dental.oauth_pending WHERE state_hash IN (v_state, v_expired_state, v_missing_hash)) THEN
    RAISE EXCEPTION 'Smoke rollback left synthetic fixtures behind';
  END IF;
  -- Normal DO completion is success. A separate read-only call is still required.
END;
$task5_connector_smoke$;
