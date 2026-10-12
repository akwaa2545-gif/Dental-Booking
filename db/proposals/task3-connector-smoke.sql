-- UNEXECUTED / UNVERIFIED. Future user-approved connector smoke test only.
-- Target must be the verified tooth-talk-staging project, YOUR_SUPABASE_PROJECT_REF,
-- selected explicitly in the connector. Project creation/read approval is NOT
-- approval to execute these DML and temporary security-grant tests.
-- One invoker DO, no schema DDL, no new roles, no transaction-control statements.
-- Requires the separately approved Task 3 schema already applied on PG17.
-- Every test mutation, SET-role grant and helper EXECUTE grant occurs inside
-- one exception subtransaction. PT999 deliberately undoes them even on success.
-- Only that private sentinel and specifically expected test failures are caught.
-- No patient data, tokens, rows, or notices are returned. Successful DO completion
-- means all 23 named behavioral checks and the restoration assertions ran.
-- This is single-session evidence, not capacity/concurrency or adapter proof.
-- Rollback semantics: https://www.postgresql.org/docs/17/plpgsql-control-structures.html#PLPGSQL-ERROR-TRAPPING
DO $task3_connector_smoke$
DECLARE
  v_owner oid;
  v_backend oid;
  v_a uuid := pg_catalog.gen_random_uuid();
  v_b uuid := pg_catalog.gen_random_uuid();
  v_missing uuid := pg_catalog.gen_random_uuid();
  v_key uuid := pg_catalog.gen_random_uuid();
  v_appointment uuid;
  v_patient_a jsonb;
  v_patient_b jsonb;
  v_updated jsonb;
  v_list jsonb;
  v_snapshot jsonb;
  v_capture date;
  v_before jsonb;
  v_after jsonb;
  v_before_fingerprint text;
  v_after_fingerprint text;
  v_error_seen boolean;
  v_all_passed boolean := false;
  v_sentinel_seen boolean := false;
  v_role text;
  v_table text;
  v_count bigint;
  v_case record;
  v_checks text[] := ARRAY[]::text[];
  v_expected_checks constant text[] := ARRAY[
    'distinct_profiles', 'account_a_list_only', 'account_b_list_only',
    'foreign_not_found', 'missing_not_found', 'version_increment',
    'stale_version_rejected', 'unknown_fields_rejected',
    'fractional_age_rejected', 'acknowledgement_required', 'empty_name_rejected',
    'unknown_actor_rejected', 'snapshot_survives_profile_update',
    'snapshot_write_rejected', 'backend_insert_denied',
    'anon_patients_read_denied', 'anon_sessions_read_denied',
    'anon_appointments_read_denied', 'anon_function_denied',
    'authenticated_patients_read_denied', 'authenticated_sessions_read_denied',
    'authenticated_appointments_read_denied', 'authenticated_function_denied'
  ];
  v_input constant jsonb := '{"fullName":"Synthetic patient","phone":"0000000000","age":42,"address":"Fictional address","relationship":"self","authorizationAcknowledged":true}'::jsonb;
  -- Compare full metadata as well as fingerprints; hashes alone are not proof.
  -- Counts contain no row values. All ordering is stable across the rollback.
  v_state_sql constant text := $state_query$
    SELECT pg_catalog.jsonb_build_object(
      'roles', (
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'oid', r.oid, 'name', r.rolname, 'login', r.rolcanlogin,
          'superuser', r.rolsuper, 'createRole', r.rolcreaterole,
          'createDatabase', r.rolcreatedb, 'replication', r.rolreplication,
          'bypassRls', r.rolbypassrls, 'inherit', r.rolinherit
        ) ORDER BY r.oid) FROM pg_catalog.pg_roles r
        WHERE r.rolname IN ('postgres', 'dental_function_owner', 'dental_backend')
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
        WHERE c.relnamespace = 'dental'::pg_catalog.regnamespace AND a.attacl IS NOT NULL
      ),
      'functions', (
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'oid', p.oid, 'owner', p.proowner, 'acl', p.proacl,
          'config', p.proconfig, 'definer', p.prosecdef
        ) ORDER BY p.oid) FROM pg_catalog.pg_proc p
        WHERE p.pronamespace = 'dental'::pg_catalog.regnamespace
      ),
      'defaults', (
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.oid), '[]'::jsonb)
        FROM pg_catalog.pg_default_acl d WHERE d.defaclrole IN (
          'postgres'::pg_catalog.regrole, 'dental_function_owner'::pg_catalog.regrole,
          'dental_backend'::pg_catalog.regrole
        )
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
        'submission_keys', (SELECT pg_catalog.count(*) FROM dental.submission_keys)
      )
    )
  $state_query$;
BEGIN
  -- The server timer must already be active at command startup. The observed
  -- connector default is 2min; do not pretend an in-DO SET starts a new timer.
  IF (SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name='statement_timeout') NOT BETWEEN 1 AND 120000 THEN
    RAISE EXCEPTION 'Smoke test requires an inherited statement timeout between 1ms and 2min';
  END IF;
  IF CURRENT_USER <> 'postgres' OR SESSION_USER <> 'postgres'
    OR pg_catalog.current_setting('server_version_num')::integer / 10000 <> 17
    OR pg_catalog.current_setting('transaction_read_only') <> 'off' THEN
    RAISE EXCEPTION 'Smoke test requires the reviewed writable PG17 postgres session';
  END IF;
  IF NOT EXISTS (
    SELECT FROM pg_catalog.pg_roles WHERE rolname = 'postgres'
      AND rolcreaterole AND rolbypassrls AND NOT rolsuper
  ) THEN
    RAISE EXCEPTION 'Smoke test operator capabilities differ from the reviewed probe';
  END IF;
  IF pg_catalog.to_regnamespace('dental') IS NULL
    OR pg_catalog.to_regrole('dental_function_owner') IS NULL
    OR pg_catalog.to_regrole('dental_backend') IS NULL
    OR pg_catalog.to_regprocedure('dental.list_patients(uuid)') IS NULL
    OR pg_catalog.to_regprocedure('dental.create_patient(uuid,jsonb)') IS NULL
    OR pg_catalog.to_regprocedure('dental.update_patient(uuid,uuid,integer,jsonb)') IS NULL
    OR pg_catalog.to_regprocedure('dental.clock_now()') IS NULL
    OR pg_catalog.to_regprocedure('dental._normalize_patient_input(jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Apply and verify the reviewed Task 3 candidate before smoke tests';
  END IF;
  v_owner := 'dental_function_owner'::pg_catalog.regrole;
  v_backend := 'dental_backend'::pg_catalog.regrole;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_auth_members WHERE roleid IN (v_owner, v_backend)) <> 2
    OR EXISTS (
      SELECT FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles g ON g.oid = m.grantor
      WHERE m.roleid IN (v_owner, v_backend) AND (
        m.member <> 'postgres'::pg_catalog.regrole OR NOT m.admin_option OR NOT g.rolsuper
        OR m.set_option OR m.inherit_option
      )
    ) OR EXISTS (SELECT FROM pg_catalog.pg_auth_members WHERE member IN (v_owner, v_backend)) THEN
    RAISE EXCEPTION 'Unexpected dental role baseline; no existing grant will be altered';
  END IF;
  IF pg_catalog.has_table_privilege(v_backend, 'dental.appointments', 'INSERT') THEN
    RAISE EXCEPTION 'Backend INSERT grant is unsafe even if RLS would reject a write';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF pg_catalog.to_regrole(v_role) IS NULL THEN
      RAISE EXCEPTION 'Required browser test role is absent';
    END IF;
    IF NOT pg_catalog.pg_has_role('postgres', v_role, 'SET') THEN
      RAISE EXCEPTION 'Existing operator permission to test browser role is absent';
    END IF;
  END LOOP;
  -- This query also proves that all ten required tables exist and are readable
  -- by the separately approved operator; no RLS disabling or bypass policy.
  EXECUTE v_state_sql INTO v_before;
  v_before_fingerprint := pg_catalog.md5(v_before::text);
  IF EXISTS (SELECT FROM dental.accounts WHERE id IN (v_a, v_b, v_missing))
    OR EXISTS (SELECT FROM dental.patients WHERE id = v_missing) THEN
    RAISE EXCEPTION 'Synthetic identifier collision; stop without changing data';
  END IF;

  BEGIN
    -- All mutations start here. Subtransaction rollback removes them on success
    -- and failure, including new temporary grants and transaction-local settings.
    PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
    GRANT dental_function_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
    GRANT dental_backend TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
    SET LOCAL ROLE dental_function_owner;
    GRANT EXECUTE ON FUNCTION dental.clock_now(), dental._normalize_patient_input(jsonb) TO postgres;
    RESET ROLE;
    INSERT INTO dental.accounts(id, provider, subject) VALUES
      (v_a, 'synthetic-connector-smoke', v_a::text),
      (v_b, 'synthetic-connector-smoke', v_b::text);

    SET LOCAL ROLE dental_backend;
    v_patient_a := dental.create_patient(v_a, v_input);
    v_patient_b := dental.create_patient(v_b, v_input);
    IF v_patient_a ->> 'id' IS NULL OR v_patient_b ->> 'id' IS NULL
      OR v_patient_a ->> 'id' = v_patient_b ->> 'id'
      OR (v_patient_a - ARRAY['id', 'ageCapturedOn', 'version']) IS DISTINCT FROM v_input
      OR (v_patient_b - ARRAY['id', 'ageCapturedOn', 'version']) IS DISTINCT FROM v_input THEN
      RAISE EXCEPTION 'Smoke check failed: distinct_profiles';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'distinct_profiles');
    v_list := dental.list_patients(v_a);
    IF v_list IS DISTINCT FROM pg_catalog.jsonb_build_array(v_patient_a) THEN
      RAISE EXCEPTION 'Smoke check failed: account_a_list_only';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'account_a_list_only');
    v_list := dental.list_patients(v_b);
    IF v_list IS DISTINCT FROM pg_catalog.jsonb_build_array(v_patient_b) THEN
      RAISE EXCEPTION 'Smoke check failed: account_b_list_only';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'account_b_list_only');

    FOR v_case IN SELECT * FROM (VALUES
      (1, 'foreign_not_found'::text, (v_patient_a ->> 'id')::uuid),
      (2, 'missing_not_found'::text, v_missing)
    ) AS cases(position, name, patient_id) ORDER BY position LOOP
      v_error_seen := false;
      BEGIN
        PERFORM dental.update_patient(v_b, v_case.patient_id, 1, v_input);
      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM <> 'NOT_FOUND' THEN RAISE; END IF;
        v_error_seen := true;
      END;
      IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: expected NOT_FOUND'; END IF;
      v_checks := pg_catalog.array_append(v_checks, v_case.name);
    END LOOP;

    v_updated := dental.update_patient(v_a, (v_patient_a ->> 'id')::uuid, 1,
      v_input || '{"age":43}'::jsonb);
    IF v_updated ->> 'version' IS DISTINCT FROM '2' OR v_updated ->> 'age' IS DISTINCT FROM '43' THEN
      RAISE EXCEPTION 'Smoke check failed: version_increment';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'version_increment');
    v_error_seen := false;
    BEGIN
      PERFORM dental.update_patient(v_a, (v_patient_a ->> 'id')::uuid, 1, v_input);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> 'VERSION_CONFLICT' THEN RAISE; END IF;
      v_error_seen := true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: stale_version_rejected'; END IF;
    v_checks := pg_catalog.array_append(v_checks, 'stale_version_rejected');

    FOR v_case IN SELECT * FROM (VALUES
      (1, 'unknown_fields_rejected'::text, v_input || '{"role":"admin"}'::jsonb),
      (2, 'fractional_age_rejected'::text, v_input || '{"age":1.5}'::jsonb),
      (3, 'acknowledgement_required'::text, v_input || '{"authorizationAcknowledged":false}'::jsonb),
      (4, 'empty_name_rejected'::text, v_input || '{"fullName":""}'::jsonb)
    ) AS cases(position, name, payload) ORDER BY position LOOP
      v_error_seen := false;
      BEGIN
        PERFORM dental.create_patient(v_a, v_case.payload);
      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM <> 'VALIDATION' THEN RAISE; END IF;
        v_error_seen := true;
      END;
      IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: expected VALIDATION'; END IF;
      v_checks := pg_catalog.array_append(v_checks, v_case.name);
    END LOOP;
    v_error_seen := false;
    BEGIN
      PERFORM dental.create_patient(v_missing, v_input);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> 'UNAUTHENTICATED' THEN RAISE; END IF;
      v_error_seen := true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: unknown_actor_rejected'; END IF;
    v_checks := pg_catalog.array_append(v_checks, 'unknown_actor_rejected');

    RESET ROLE;
    -- This is a synthetic schema fixture, not the not-yet-implemented reservation
    -- function. Do not interpret it as date-window or three-place capacity proof.
    INSERT INTO dental.clinic_dates(date) VALUES ('2099-01-05') ON CONFLICT DO NOTHING;
    INSERT INTO dental.appointments(
      owner_account_id, patient_id, patient_version, patient_snapshot,
      age_captured_on, service, date, idempotency_key
    ) VALUES (
      v_a, (v_patient_a ->> 'id')::uuid, 2, v_input || '{"age":43}'::jsonb,
      '2026-10-08', 'oral_check', '2099-01-05', v_key
    ) RETURNING id INTO v_appointment;
    SET LOCAL ROLE dental_backend;
    PERFORM dental.update_patient(v_a, (v_patient_a ->> 'id')::uuid, 2,
      v_input || '{"age":44,"address":"Another fictional address"}'::jsonb);
    RESET ROLE;
    SELECT patient_snapshot, age_captured_on INTO v_snapshot, v_capture
      FROM dental.appointments WHERE id = v_appointment;
    IF v_snapshot IS DISTINCT FROM (v_input || '{"age":43}'::jsonb)
      OR v_capture IS DISTINCT FROM DATE '2026-10-08' THEN
      RAISE EXCEPTION 'Smoke check failed: snapshot_survives_profile_update';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'snapshot_survives_profile_update');
    v_error_seen := false;
    BEGIN
      UPDATE dental.appointments SET patient_snapshot = v_input || '{"age":99}'::jsonb
        WHERE id = v_appointment;
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> 'INVALID_TRANSITION' THEN RAISE; END IF;
      v_error_seen := true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: snapshot_write_rejected'; END IF;
    v_checks := pg_catalog.array_append(v_checks, 'snapshot_write_rejected');

    SET LOCAL ROLE dental_backend;
    v_error_seen := false;
    BEGIN
      INSERT INTO dental.appointments DEFAULT VALUES;
    EXCEPTION WHEN SQLSTATE '42501' THEN
      v_error_seen := true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: backend_insert_denied'; END IF;
    v_checks := pg_catalog.array_append(v_checks, 'backend_insert_denied');
    RESET ROLE;

    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      EXECUTE pg_catalog.format('SET LOCAL ROLE %I', v_role);
      FOREACH v_table IN ARRAY ARRAY['patients', 'sessions', 'appointments'] LOOP
        v_error_seen := false;
        BEGIN
          EXECUTE pg_catalog.format('SELECT count(*) FROM dental.%I', v_table) INTO v_count;
        EXCEPTION WHEN SQLSTATE '42501' THEN
          v_error_seen := true;
        END;
        IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: browser private read was allowed'; END IF;
        v_checks := pg_catalog.array_append(v_checks, v_role || '_' || v_table || '_read_denied');
      END LOOP;
      v_error_seen := false;
      BEGIN
        PERFORM dental.list_patients(v_a);
      EXCEPTION WHEN SQLSTATE '42501' THEN
        v_error_seen := true;
      END;
      IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: browser private function was allowed'; END IF;
      v_checks := pg_catalog.array_append(v_checks, v_role || '_function_denied');
      RESET ROLE;
    END LOOP;
    IF v_checks IS DISTINCT FROM v_expected_checks OR pg_catalog.cardinality(v_checks) <> 23
      OR CURRENT_USER <> 'postgres' THEN
      RAISE EXCEPTION 'Smoke checks did not all finish in the expected execution context';
    END IF;
    v_all_passed := true;
    RAISE EXCEPTION USING ERRCODE = 'PT999', MESSAGE = 'Task 3 smoke rollback sentinel';
  EXCEPTION WHEN SQLSTATE 'PT999' THEN
    -- PL/pgSQL variables survive the rollback; persistent state and local role
    -- settings inside the protected block do not. A stray PT999 is not success.
    IF NOT v_all_passed OR SQLERRM <> 'Task 3 smoke rollback sentinel' THEN RAISE; END IF;
    v_sentinel_seen := true;
  END;

  IF NOT v_all_passed OR NOT v_sentinel_seen OR v_checks IS DISTINCT FROM v_expected_checks
    OR CURRENT_USER <> 'postgres' OR SESSION_USER <> 'postgres' THEN
    RAISE EXCEPTION 'Smoke rollback did not finish safely';
  END IF;
  EXECUTE v_state_sql INTO v_after;
  v_after_fingerprint := pg_catalog.md5(v_after::text);
  IF v_before IS DISTINCT FROM v_after OR v_before_fingerprint IS DISTINCT FROM v_after_fingerprint THEN
    RAISE EXCEPTION 'Smoke rollback changed memberships, ACLs, role state or table counts';
  END IF;
  IF EXISTS (SELECT FROM dental.accounts WHERE id IN (v_a, v_b))
    OR EXISTS (SELECT FROM dental.patients WHERE owner_account_id IN (v_a, v_b))
    OR EXISTS (SELECT FROM dental.appointments WHERE id = v_appointment)
    OR EXISTS (SELECT FROM dental.audit_events WHERE actor_account_id IN (v_a, v_b)) THEN
    RAISE EXCEPTION 'Smoke rollback left synthetic fixtures behind';
  END IF;
  -- No notices or patient-bearing result rows. Normal DO completion is success.
END;
$task3_connector_smoke$;
