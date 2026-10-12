-- UNEXECUTED / UNVERIFIED Task 4 single-session connector smoke candidate.
-- Only the verified tooth-talk-staging project YOUR_SUPABASE_PROJECT_REF; require
-- separate action-time approval of the exact file hash and temporary grants.
-- Apply and independently verify approved 003_reservations.sql FIRST.
-- One invoker DO, using the proven Task 3 sentinel rollback shape: no schema DDL,
-- no transaction-control statements, no credentials, no clock replacement.
-- Requires an empty, quiescent dental schema on managed PG17. Table locks block
-- concurrent application writes for this bounded test; they do NOT prove races.
-- All fixture writes, operator SET memberships and exact helper grants live in
-- one exception subtransaction. PT994 deliberately undoes them even on success.
-- Only the private sentinel and specifically expected failures are caught.
-- A normal DO completion means all named assertions AND restoration checks ran.
-- No patient-bearing rows, JSON results, UUIDs or notices are emitted.
DO $task4_connector_smoke$
DECLARE
  v_owner oid;
  v_backend oid;
  v_a uuid := pg_catalog.gen_random_uuid();
  v_b uuid := pg_catalog.gen_random_uuid();
  v_missing uuid := pg_catalog.gen_random_uuid();
  v_key1 uuid := pg_catalog.gen_random_uuid();
  v_key2 uuid := pg_catalog.gen_random_uuid();
  v_key3 uuid := pg_catalog.gen_random_uuid();
  v_rejected_key uuid := pg_catalog.gen_random_uuid();
  v_cancelled_key uuid := pg_catalog.gen_random_uuid();
  v_failed_keys uuid[] := ARRAY[]::uuid[];
  v_case_key uuid;
  v_patient1 jsonb;
  v_patient2 jsonb;
  v_patient3 jsonb;
  v_patient4 jsonb;
  v_updated jsonb;
  v_input1 jsonb;
  v_input2 jsonb;
  v_input3 jsonb;
  v_input4 jsonb;
  v_result1 jsonb;
  v_result2 jsonb;
  v_result3 jsonb;
  v_result_other jsonb;
  v_rejected_result jsonb;
  v_cancelled_result jsonb;
  v_result jsonb;
  v_list jsonb;
  v_today date;
  v_day1 date;
  v_day2 date;
  v_weekend date;
  v_snapshot jsonb;
  v_capture date;
  v_before jsonb;
  v_after jsonb;
  v_original_lock_timeout text := pg_catalog.current_setting('lock_timeout');
  v_before_fingerprint text;
  v_after_fingerprint text;
  v_error_seen boolean;
  v_all_passed boolean := false;
  v_sentinel_seen boolean := false;
  v_role text;
  v_table text;
  v_intake text;
  v_count bigint;
  v_case record;
  v_checks text[] := ARRAY[]::text[];
  v_expected_checks constant text[] := ARRAY[
    'availability_initial', 'availability_shape',
    'today_ineligible', 'beyond_window_ineligible', 'weekend_ineligible',
    'foreign_patient_not_found', 'missing_patient_not_found',
    'unknown_actor_rejected', 'stale_patient_rejected', 'mismatched_age_rejected',
    'paused_intake_rejected', 'closed_intake_rejected',
    'first_pending_snapshot', 'mixed_service_three_pending',
    'approved_consumes_capacity', 'fourth_full', 'duplicate_active_patient',
    'idempotency_replay_original', 'idempotency_conflict_service',
    'idempotency_conflict_date', 'submission_owned', 'submission_foreign_hidden',
    'submission_missing_hidden', 'appointments_owned', 'appointment_owned',
    'appointment_foreign_not_found', 'appointment_missing_not_found',
    'same_key_scoped_per_account', 'snapshot_survives_profile_update',
    'snapshot_write_rejected', 'rejected_releases_capacity',
    'rejected_patient_rebooks', 'cancelled_releases_capacity',
    'cancelled_patient_rebooks', 'failed_requests_leave_no_keys', 'synthetic_totals',
    'backend_appointments_read_denied', 'backend_appointments_insert_denied',
    'anon_appointments_read_denied', 'anon_submission_keys_read_denied',
    'anon_reserve_denied', 'authenticated_appointments_read_denied',
    'authenticated_submission_keys_read_denied', 'authenticated_reserve_denied'
  ];
  v_patient_input constant jsonb := '{"fullName":"Synthetic Task 4 patient","phone":"0000000000","age":42,"address":"Fictional test address","relationship":"self","authorizationAcknowledged":true}'::jsonb;
  -- Full metadata equality is authoritative; the fingerprint is secondary.
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
    RAISE EXCEPTION 'Apply and verify the reviewed Task 3 and Task 4 candidates first';
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
    ('dental.create_patient(uuid,jsonb)'), ('dental.update_patient(uuid,uuid,integer,jsonb)'),
    ('dental.availability(date,date)'), ('dental.reserve(uuid,uuid,jsonb)'),
    ('dental.submission(uuid,uuid)'), ('dental.list_appointments(uuid)'),
    ('dental.get_appointment(uuid,uuid)'), ('dental.clock_now()'),
    ('dental._normalize_patient_input(jsonb)')
  ) AS required(signature) LOOP
    IF pg_catalog.to_regprocedure(v_case.signature) IS NULL THEN
      RAISE EXCEPTION 'Required reviewed Task 4 function is absent';
    END IF;
  END LOOP;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc WHERE pronamespace = 'dental'::pg_catalog.regnamespace) <> 13
    OR EXISTS (SELECT FROM pg_catalog.pg_proc WHERE pronamespace = 'dental'::pg_catalog.regnamespace
      AND (proowner <> v_owner OR proconfig IS DISTINCT FROM ARRAY['search_path=""']))
    OR EXISTS (SELECT FROM pg_catalog.pg_class WHERE relnamespace = 'dental'::pg_catalog.regnamespace AND relkind = 'r'
      AND (relowner <> 'postgres'::pg_catalog.regrole OR NOT relrowsecurity OR NOT relforcerowsecurity)) THEN
    RAISE EXCEPTION 'Task 4 ownership, private function surface or RLS baseline differs';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF pg_catalog.to_regrole(v_role) IS NULL OR NOT pg_catalog.pg_has_role('postgres', v_role, 'SET') THEN
      RAISE EXCEPTION 'Existing operator permission to test browser role is absent';
    END IF;
  END LOOP;
  FOREACH v_table IN ARRAY ARRAY['accounts', 'sessions', 'patients', 'appointments', 'clinic_dates',
    'admin_grants', 'audit_events', 'outbox', 'notification_attempts', 'submission_keys'] LOOP
    IF pg_catalog.has_table_privilege(v_backend, 'dental.' || v_table, 'SELECT,INSERT,UPDATE,DELETE') THEN
      RAISE EXCEPTION 'Backend direct table grant is unsafe even if RLS would reject access';
    END IF;
  END LOOP;

  BEGIN
    -- The inherited statement timer bounds the whole DO; each lock wait is <=3s.
    -- Locks and all mutations below are undone together by the sentinel.
    PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
    LOCK TABLE dental.accounts, dental.sessions, dental.patients, dental.clinic_dates,
      dental.appointments, dental.submission_keys, dental.admin_grants,
      dental.audit_events, dental.outbox, dental.notification_attempts
      IN SHARE ROW EXCLUSIVE MODE;
    EXECUTE v_state_sql INTO v_before;
    v_before_fingerprint := pg_catalog.md5(v_before::text);
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_each(v_before -> 'rows')) <> 10
      OR EXISTS (SELECT FROM pg_catalog.jsonb_each_text(v_before -> 'rows') n WHERE n.value::bigint <> 0) THEN
      RAISE EXCEPTION 'Smoke test requires all ten dental tables empty; no existing application data may be touched';
    END IF;
    -- PG17 administrator baseline stays unchanged: these additional grants use
    -- postgres as grantor and are visible only inside this test transaction.
    GRANT dental_function_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
    GRANT dental_backend TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
    SET LOCAL ROLE dental_function_owner;
    -- Table defaults and the appointment CHECK require these helpers for the
    -- operator fixtures. No other helper, table, schema or runtime grant is made.
    IF NOT pg_catalog.has_function_privilege('postgres', 'dental.clock_now()', 'EXECUTE') THEN
      GRANT EXECUTE ON FUNCTION dental.clock_now() TO postgres;
    END IF;
    IF NOT pg_catalog.has_function_privilege('postgres', 'dental._normalize_patient_input(jsonb)', 'EXECUTE') THEN
      GRANT EXECUTE ON FUNCTION dental._normalize_patient_input(jsonb) TO postgres;
    END IF;
    RESET ROLE;
    v_today := pg_catalog.timezone('Asia/Bangkok', dental.clock_now())::date;
    -- Use comfortable +7..+20 dates, avoiding a midnight boundary and +90 edge.
    SELECT d INTO v_day1 FROM (
      SELECT v_today + i AS d FROM pg_catalog.generate_series(7, 20) i
    ) days WHERE EXTRACT(ISODOW FROM d) <= 5 ORDER BY d LIMIT 1;
    SELECT d INTO v_day2 FROM (
      SELECT v_day1 + i AS d FROM pg_catalog.generate_series(1, 7) i
    ) days WHERE EXTRACT(ISODOW FROM d) <= 5 ORDER BY d LIMIT 1;
    SELECT d INTO v_weekend FROM (
      SELECT v_today + i AS d FROM pg_catalog.generate_series(7, 20) i
    ) days WHERE EXTRACT(ISODOW FROM d) > 5 ORDER BY d LIMIT 1;
    IF v_day1 IS NULL OR v_day2 IS NULL OR v_weekend IS NULL
      OR v_day1 <= v_today OR v_day2 > v_today + 90 THEN
      RAISE EXCEPTION 'No safe future test dates';
    END IF;
    INSERT INTO dental.accounts(id, provider, subject) VALUES
      (v_a, 'synthetic-task4-connector-smoke', v_a::text),
      (v_b, 'synthetic-task4-connector-smoke', v_b::text);
    SET LOCAL ROLE dental_backend;
    v_patient1 := dental.create_patient(v_a, v_patient_input);
    v_patient2 := dental.create_patient(v_a, v_patient_input);
    v_patient3 := dental.create_patient(v_b, v_patient_input);
    v_patient4 := dental.create_patient(v_a, v_patient_input);
    v_input1 := pg_catalog.jsonb_build_object('patientId', v_patient1 ->> 'id', 'patientVersion', 1,
      'service', 'oral_check', 'date', pg_catalog.to_char(v_day1, 'YYYY-MM-DD'), 'ageConfirmed', 42, 'authorizationAcknowledged', true);
    v_input2 := v_input1 || pg_catalog.jsonb_build_object('patientId', v_patient2 ->> 'id', 'service', 'scaling');
    v_input3 := v_input1 || pg_catalog.jsonb_build_object('patientId', v_patient3 ->> 'id', 'service', 'filling');
    v_input4 := v_input1 || pg_catalog.jsonb_build_object('patientId', v_patient4 ->> 'id');

    v_result := dental.availability(v_day1, v_day1);
    IF v_result IS DISTINCT FROM pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('date', pg_catalog.to_char(v_day1, 'YYYY-MM-DD'), 'state', 'available')) THEN
      RAISE EXCEPTION 'Smoke check failed: availability_initial';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'availability_initial');
    v_list := dental.availability(v_day1, v_day2);
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'date', pg_catalog.to_char(v_day1 + i, 'YYYY-MM-DD'),
      'state', CASE WHEN EXTRACT(ISODOW FROM v_day1 + i) > 5 THEN 'ineligible' ELSE 'available' END
    ) ORDER BY i) INTO v_result FROM pg_catalog.generate_series(0, v_day2 - v_day1) i;
    -- Exact, null-safe equality checks array length/order and date/state only.
    IF v_list IS DISTINCT FROM v_result THEN
      RAISE EXCEPTION 'Smoke check failed: availability_shape';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'availability_shape');
    FOR v_case IN SELECT * FROM (VALUES
      (1, 'today_ineligible'::text, v_today),
      (2, 'beyond_window_ineligible'::text, v_today + 91),
      (3, 'weekend_ineligible'::text, v_weekend)
    ) cases(position, name, day) ORDER BY position LOOP
      IF dental.availability(v_case.day, v_case.day) IS DISTINCT FROM
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('date', pg_catalog.to_char(v_case.day, 'YYYY-MM-DD'), 'state', 'ineligible')) THEN
        RAISE EXCEPTION 'Smoke check failed: %', v_case.name;
      END IF;
      v_case_key := pg_catalog.gen_random_uuid();
      v_failed_keys := pg_catalog.array_append(v_failed_keys, v_case_key);
      v_error_seen := false;
      BEGIN
        PERFORM dental.reserve(v_a, v_case_key, v_input1 || pg_catalog.jsonb_build_object('date', pg_catalog.to_char(v_case.day, 'YYYY-MM-DD')));
      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM <> 'INELIGIBLE_DATE' THEN RAISE; END IF;
        v_error_seen := true;
      END;
      IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: %', v_case.name; END IF;
      v_checks := pg_catalog.array_append(v_checks, v_case.name);
    END LOOP;

    FOR v_case IN SELECT * FROM (VALUES
      (1, 'foreign_patient_not_found'::text, v_b, v_input1, 'NOT_FOUND'::text),
      (2, 'missing_patient_not_found'::text, v_b, v_input1 || pg_catalog.jsonb_build_object('patientId', v_missing::text), 'NOT_FOUND'),
      (3, 'unknown_actor_rejected'::text, v_missing, v_input1, 'UNAUTHENTICATED'),
      (4, 'stale_patient_rejected'::text, v_a, v_input1 || '{"patientVersion":2}'::jsonb, 'VERSION_CONFLICT'),
      (5, 'mismatched_age_rejected'::text, v_a, v_input1 || '{"ageConfirmed":43}'::jsonb, 'VERSION_CONFLICT')
    ) cases(position, name, actor, input, error) ORDER BY position LOOP
      v_case_key := pg_catalog.gen_random_uuid();
      v_failed_keys := pg_catalog.array_append(v_failed_keys, v_case_key);
      v_error_seen := false;
      BEGIN
        PERFORM dental.reserve(v_case.actor, v_case_key, v_case.input);
      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM <> v_case.error THEN RAISE; END IF;
        v_error_seen := true;
      END;
      IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: %', v_case.name; END IF;
      v_checks := pg_catalog.array_append(v_checks, v_case.name);
    END LOOP;

    FOREACH v_intake IN ARRAY ARRAY['paused', 'closed'] LOOP
      RESET ROLE;
      INSERT INTO dental.clinic_dates(date, intake) VALUES(v_day2, v_intake)
        ON CONFLICT (date) DO UPDATE SET intake = EXCLUDED.intake;
      SET LOCAL ROLE dental_backend;
      IF dental.availability(v_day2, v_day2) IS DISTINCT FROM
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('date', pg_catalog.to_char(v_day2, 'YYYY-MM-DD'), 'state', v_intake)) THEN
        RAISE EXCEPTION 'Smoke check failed: intake availability';
      END IF;
      v_case_key := pg_catalog.gen_random_uuid();
      v_failed_keys := pg_catalog.array_append(v_failed_keys, v_case_key);
      v_error_seen := false;
      BEGIN
        PERFORM dental.reserve(v_a, v_case_key, v_input1 || pg_catalog.jsonb_build_object('date', pg_catalog.to_char(v_day2, 'YYYY-MM-DD')));
      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM <> 'INTAKE_CLOSED' THEN RAISE; END IF;
        v_error_seen := true;
      END;
      IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: intake booking'; END IF;
      v_checks := pg_catalog.array_append(v_checks, v_intake || '_intake_rejected');
    END LOOP;
    RESET ROLE;
    UPDATE dental.clinic_dates SET intake = 'open' WHERE date = v_day2;
    SET LOCAL ROLE dental_backend;

    v_result1 := dental.reserve(v_a, v_key1, v_input1);
    IF v_result1 ->> 'id' IS NULL OR v_result1 ->> 'reference' IS NULL
      OR v_result1 ->> 'patientId' IS DISTINCT FROM v_patient1 ->> 'id'
      OR v_result1 -> 'patient' IS DISTINCT FROM v_patient_input
      OR v_result1 ->> 'date' IS DISTINCT FROM pg_catalog.to_char(v_day1, 'YYYY-MM-DD')
      OR v_result1 ->> 'service' IS DISTINCT FROM 'oral_check'
      OR v_result1 ->> 'status' IS DISTINCT FROM 'pending'
      OR v_result1 -> 'version' IS DISTINCT FROM '1'::jsonb
      OR v_result1 -> 'approvedAt' IS DISTINCT FROM 'null'::jsonb THEN
      RAISE EXCEPTION 'Smoke check failed: first_pending_snapshot';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'first_pending_snapshot');
    v_result2 := dental.reserve(v_a, v_key2, v_input2);
    v_result3 := dental.reserve(v_b, v_key3, v_input3);
    RESET ROLE;
    IF (SELECT pg_catalog.count(*) FROM dental.appointments WHERE date = v_day1 AND status = 'pending') <> 3
      OR (SELECT pg_catalog.count(DISTINCT service) FROM dental.appointments WHERE date = v_day1) <> 3
      OR (SELECT pg_catalog.count(DISTINCT patient_id) FROM dental.appointments WHERE date = v_day1) <> 3 THEN
      RAISE EXCEPTION 'Smoke check failed: mixed_service_three_pending';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'mixed_service_three_pending');
    -- Synthetic operator status fixtures only. Task 7 approval/rejection/
    -- cancellation workflows are absent and are NOT exercised by these UPDATEs.
    UPDATE dental.appointments SET status = 'approved', version = version + 1,
      approved_at = dental.clock_now(), updated_at = dental.clock_now()
      WHERE id = (v_result1 ->> 'id')::uuid AND owner_account_id = v_a;
    IF (SELECT pg_catalog.count(*) FROM dental.appointments WHERE date = v_day1 AND status = 'approved') <> 1
      OR (SELECT pg_catalog.count(*) FROM dental.appointments WHERE date = v_day1 AND status = 'pending') <> 2 THEN
      RAISE EXCEPTION 'Synthetic approved fixture was not established';
    END IF;
    SET LOCAL ROLE dental_backend;
    IF dental.availability(v_day1, v_day1) IS DISTINCT FROM
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('date', pg_catalog.to_char(v_day1, 'YYYY-MM-DD'), 'state', 'full')) THEN
      RAISE EXCEPTION 'Smoke check failed: approved_consumes_capacity';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'approved_consumes_capacity');
    FOR v_case IN SELECT * FROM (VALUES
      (1, 'fourth_full'::text, v_input4, 'FULL'::text),
      (2, 'duplicate_active_patient'::text, v_input1 || '{"service":"filling"}'::jsonb, 'DUPLICATE')
    ) cases(position, name, input, error) ORDER BY position LOOP
      v_case_key := pg_catalog.gen_random_uuid();
      v_failed_keys := pg_catalog.array_append(v_failed_keys, v_case_key);
      v_error_seen := false;
      BEGIN
        PERFORM dental.reserve(v_a, v_case_key, v_case.input);
      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM <> v_case.error THEN RAISE; END IF;
        v_error_seen := true;
      END;
      IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: %', v_case.name; END IF;
      v_checks := pg_catalog.array_append(v_checks, v_case.name);
    END LOOP;
    -- Original persisted response stays pending even after the operator fixture
    -- changes the actual appointment to approved. Replay must create no new row.
    IF dental.reserve(v_a, v_key1, v_input1) IS DISTINCT FROM v_result1 THEN
      RAISE EXCEPTION 'Smoke check failed: idempotency_replay_original';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'idempotency_replay_original');
    FOR v_case IN SELECT * FROM (VALUES
      (1, 'idempotency_conflict_service'::text, v_input1 || '{"service":"filling"}'::jsonb),
      (2, 'idempotency_conflict_date'::text, v_input1 || pg_catalog.jsonb_build_object('date', pg_catalog.to_char(v_day2, 'YYYY-MM-DD')))
    ) cases(position, name, input) ORDER BY position LOOP
      v_error_seen := false;
      BEGIN
        PERFORM dental.reserve(v_a, v_key1, v_case.input);
      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM <> 'IDEMPOTENCY_CONFLICT' THEN RAISE; END IF;
        v_error_seen := true;
      END;
      IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: %', v_case.name; END IF;
      v_checks := pg_catalog.array_append(v_checks, v_case.name);
    END LOOP;
    IF dental.submission(v_a, v_key1) IS DISTINCT FROM v_result1 THEN
      RAISE EXCEPTION 'Smoke check failed: submission_owned';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'submission_owned');
    IF dental.submission(v_b, v_key1) IS NOT NULL THEN
      RAISE EXCEPTION 'Smoke check failed: submission_foreign_hidden';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'submission_foreign_hidden');
    IF dental.submission(v_a, v_missing) IS NOT NULL THEN
      RAISE EXCEPTION 'Smoke check failed: submission_missing_hidden';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'submission_missing_hidden');
    v_list := dental.list_appointments(v_a);
    IF pg_catalog.jsonb_typeof(v_list) IS DISTINCT FROM 'array'
      OR pg_catalog.jsonb_array_length(v_list) IS DISTINCT FROM 2
      OR (SELECT pg_catalog.count(DISTINCT item ->> 'id') FROM pg_catalog.jsonb_array_elements(v_list) e(item)) <> 2
      OR EXISTS (SELECT FROM pg_catalog.jsonb_array_elements(v_list) e(item)
        WHERE item ->> 'id' IS NULL OR item ->> 'id' NOT IN (v_result1 ->> 'id', v_result2 ->> 'id'))
      OR dental.list_appointments(v_b) IS DISTINCT FROM pg_catalog.jsonb_build_array(v_result3) THEN
      RAISE EXCEPTION 'Smoke check failed: appointments_owned';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'appointments_owned');
    v_result := dental.get_appointment(v_a, (v_result1 ->> 'id')::uuid);
    IF v_result ->> 'id' IS DISTINCT FROM v_result1 ->> 'id'
      OR v_result ->> 'status' IS DISTINCT FROM 'approved'
      OR v_result -> 'version' IS DISTINCT FROM '2'::jsonb THEN
      RAISE EXCEPTION 'Smoke check failed: appointment_owned';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'appointment_owned');
    FOR v_case IN SELECT * FROM (VALUES
      (1, 'appointment_foreign_not_found'::text, (v_result1 ->> 'id')::uuid),
      (2, 'appointment_missing_not_found'::text, v_missing)
    ) cases(position, name, id) ORDER BY position LOOP
      v_error_seen := false;
      BEGIN
        PERFORM dental.get_appointment(v_b, v_case.id);
      EXCEPTION WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM <> 'NOT_FOUND' THEN RAISE; END IF;
        v_error_seen := true;
      END;
      IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: %', v_case.name; END IF;
      v_checks := pg_catalog.array_append(v_checks, v_case.name);
    END LOOP;
    v_result_other := dental.reserve(v_b, v_key1, v_input3 || pg_catalog.jsonb_build_object('date', pg_catalog.to_char(v_day2, 'YYYY-MM-DD')));
    IF v_result_other ->> 'id' IS NULL OR v_result_other ->> 'id' = v_result1 ->> 'id'
      OR dental.submission(v_a, v_key1) IS DISTINCT FROM v_result1
      OR dental.submission(v_b, v_key1) IS DISTINCT FROM v_result_other THEN
      RAISE EXCEPTION 'Smoke check failed: same_key_scoped_per_account';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'same_key_scoped_per_account');

    v_updated := dental.update_patient(v_a, (v_patient1 ->> 'id')::uuid, 1,
      v_patient_input || '{"age":43,"address":"Updated fictional test address"}'::jsonb);
    RESET ROLE;
    SELECT patient_snapshot, age_captured_on INTO v_snapshot, v_capture
      FROM dental.appointments WHERE id = (v_result1 ->> 'id')::uuid;
    IF v_updated -> 'version' IS DISTINCT FROM '2'::jsonb
      OR v_snapshot IS DISTINCT FROM v_patient_input OR v_capture IS DISTINCT FROM v_today
      OR (SELECT patient_version FROM dental.appointments WHERE id = (v_result1 ->> 'id')::uuid) <> 1 THEN
      RAISE EXCEPTION 'Smoke check failed: snapshot_survives_profile_update';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'snapshot_survives_profile_update');
    v_error_seen := false;
    BEGIN
      UPDATE dental.appointments SET patient_snapshot = v_patient_input || '{"age":99}'::jsonb
        WHERE id = (v_result1 ->> 'id')::uuid;
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> 'INVALID_TRANSITION' THEN RAISE; END IF;
      v_error_seen := true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: snapshot_write_rejected'; END IF;
    v_checks := pg_catalog.array_append(v_checks, 'snapshot_write_rejected');

    UPDATE dental.appointments SET status = 'rejected', version = version + 1, updated_at = dental.clock_now()
      WHERE id = (v_result2 ->> 'id')::uuid AND owner_account_id = v_a;
    SET LOCAL ROLE dental_backend;
    IF dental.availability(v_day1, v_day1) IS DISTINCT FROM
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('date', pg_catalog.to_char(v_day1, 'YYYY-MM-DD'), 'state', 'available')) THEN
      RAISE EXCEPTION 'Smoke check failed: rejected_releases_capacity';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'rejected_releases_capacity');
    v_rejected_result := dental.reserve(v_a, v_rejected_key, v_input2);
    IF v_rejected_result ->> 'id' IS NULL OR v_rejected_result ->> 'id' = v_result2 ->> 'id'
      OR v_rejected_result ->> 'status' IS DISTINCT FROM 'pending'
      OR dental.availability(v_day1, v_day1) IS DISTINCT FROM
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('date', pg_catalog.to_char(v_day1, 'YYYY-MM-DD'), 'state', 'full')) THEN
      RAISE EXCEPTION 'Smoke check failed: rejected_patient_rebooks';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'rejected_patient_rebooks');
    RESET ROLE;
    UPDATE dental.appointments SET status = 'cancelled', version = version + 1,
      cancelled_at = dental.clock_now(), cancelled_by = v_a, updated_at = dental.clock_now()
      WHERE id = (v_result1 ->> 'id')::uuid AND owner_account_id = v_a;
    SET LOCAL ROLE dental_backend;
    IF dental.availability(v_day1, v_day1) IS DISTINCT FROM
      pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('date', pg_catalog.to_char(v_day1, 'YYYY-MM-DD'), 'state', 'available')) THEN
      RAISE EXCEPTION 'Smoke check failed: cancelled_releases_capacity';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'cancelled_releases_capacity');
    v_cancelled_result := dental.reserve(v_a, v_cancelled_key, v_input1 || '{"patientVersion":2,"ageConfirmed":43}'::jsonb);
    IF v_cancelled_result ->> 'id' IS NULL OR v_cancelled_result ->> 'id' = v_result1 ->> 'id'
      OR v_cancelled_result -> 'patient' IS DISTINCT FROM
        (v_patient_input || '{"age":43,"address":"Updated fictional test address"}'::jsonb)
      OR dental.reserve(v_a, v_key1, v_input1) IS DISTINCT FROM v_result1
      OR dental.availability(v_day1, v_day1) IS DISTINCT FROM
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('date', pg_catalog.to_char(v_day1, 'YYYY-MM-DD'), 'state', 'full')) THEN
      RAISE EXCEPTION 'Smoke check failed: cancelled_patient_rebooks';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'cancelled_patient_rebooks');
    RESET ROLE;
    IF EXISTS (SELECT FROM dental.submission_keys WHERE key = ANY(v_failed_keys))
      OR EXISTS (SELECT FROM dental.appointments WHERE idempotency_key = ANY(v_failed_keys)) THEN
      RAISE EXCEPTION 'Smoke check failed: failed_requests_leave_no_keys';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'failed_requests_leave_no_keys');
    IF (SELECT pg_catalog.count(*) FROM dental.accounts) <> 2
      OR (SELECT pg_catalog.count(*) FROM dental.patients) <> 4
      OR (SELECT pg_catalog.count(*) FROM dental.clinic_dates) <> 2
      OR (SELECT pg_catalog.count(*) FROM dental.appointments) <> 6
      OR (SELECT pg_catalog.count(*) FROM dental.submission_keys) <> 6
      OR (SELECT pg_catalog.count(*) FROM dental.audit_events) <> 11
      OR (SELECT pg_catalog.count(*) FROM dental.audit_events WHERE action = 'appointment_reserved') <> 6
      OR (SELECT pg_catalog.count(*) FROM dental.appointments WHERE date = v_day1 AND status IN ('pending', 'approved')) <> 3
      OR (SELECT pg_catalog.count(*) FROM dental.appointments WHERE date = v_day1 AND status IN ('rejected', 'cancelled')) <> 2
      OR EXISTS (SELECT FROM dental.sessions) OR EXISTS (SELECT FROM dental.admin_grants)
      OR EXISTS (SELECT FROM dental.outbox) OR EXISTS (SELECT FROM dental.notification_attempts) THEN
      RAISE EXCEPTION 'Smoke check failed: synthetic_totals';
    END IF;
    v_checks := pg_catalog.array_append(v_checks, 'synthetic_totals');

    SET LOCAL ROLE dental_backend;
    v_error_seen := false;
    BEGIN
      SELECT pg_catalog.count(*) INTO v_count FROM dental.appointments;
    EXCEPTION WHEN SQLSTATE '42501' THEN v_error_seen := true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: backend_appointments_read_denied'; END IF;
    v_checks := pg_catalog.array_append(v_checks, 'backend_appointments_read_denied');
    v_error_seen := false;
    BEGIN
      INSERT INTO dental.appointments DEFAULT VALUES;
    EXCEPTION WHEN SQLSTATE '42501' THEN v_error_seen := true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: backend_appointments_insert_denied'; END IF;
    v_checks := pg_catalog.array_append(v_checks, 'backend_appointments_insert_denied');
    RESET ROLE;
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      EXECUTE pg_catalog.format('SET LOCAL ROLE %I', v_role);
      FOREACH v_table IN ARRAY ARRAY['appointments', 'submission_keys'] LOOP
        v_error_seen := false;
        BEGIN
          EXECUTE pg_catalog.format('SELECT count(*) FROM dental.%I', v_table) INTO v_count;
        EXCEPTION WHEN SQLSTATE '42501' THEN v_error_seen := true;
        END;
        IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: browser private read was allowed'; END IF;
        v_checks := pg_catalog.array_append(v_checks, v_role || '_' || v_table || '_read_denied');
      END LOOP;
      v_error_seen := false;
      BEGIN
        PERFORM dental.reserve(v_a, pg_catalog.gen_random_uuid(), v_input4);
      EXCEPTION WHEN SQLSTATE '42501' THEN v_error_seen := true;
      END;
      IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: browser reserve was allowed'; END IF;
      v_checks := pg_catalog.array_append(v_checks, v_role || '_reserve_denied');
      RESET ROLE;
    END LOOP;
    -- A boundary crossing makes date assertions inconclusive, never a pass.
    IF pg_catalog.timezone('Asia/Bangkok', dental.clock_now())::date IS DISTINCT FROM v_today THEN
      RAISE EXCEPTION 'Bangkok date changed during smoke; rerun only after verification and within approval';
    END IF;
    IF v_checks IS DISTINCT FROM v_expected_checks OR pg_catalog.cardinality(v_checks) <> 44
      OR CURRENT_USER <> 'postgres' THEN
      RAISE EXCEPTION 'Smoke checks did not all finish in the expected execution context';
    END IF;
    v_all_passed := true;
    RAISE EXCEPTION USING ERRCODE = 'PT994', MESSAGE = 'Task 4 smoke rollback sentinel';
  EXCEPTION WHEN SQLSTATE 'PT994' THEN
    -- PL/pgSQL variables survive; all database changes, settings and acquired
    -- locks inside this protected block roll back before the checks below.
    IF NOT v_all_passed OR SQLERRM <> 'Task 4 smoke rollback sentinel' THEN RAISE; END IF;
    v_sentinel_seen := true;
  END;

  IF NOT v_all_passed OR NOT v_sentinel_seen OR v_checks IS DISTINCT FROM v_expected_checks
    OR CURRENT_USER <> 'postgres' OR SESSION_USER <> 'postgres'
    OR pg_catalog.current_setting('lock_timeout') IS DISTINCT FROM v_original_lock_timeout THEN
    RAISE EXCEPTION 'Smoke rollback did not finish safely';
  END IF;
  EXECUTE v_state_sql INTO v_after;
  v_after_fingerprint := pg_catalog.md5(v_after::text);
  IF v_before IS DISTINCT FROM v_after OR v_before_fingerprint IS DISTINCT FROM v_after_fingerprint THEN
    RAISE EXCEPTION 'Smoke rollback changed roles, memberships, ACLs, policies, functions or table counts';
  END IF;
  IF EXISTS (SELECT FROM dental.accounts WHERE id IN (v_a, v_b))
    OR EXISTS (SELECT FROM dental.patients WHERE owner_account_id IN (v_a, v_b))
    OR EXISTS (SELECT FROM dental.appointments WHERE owner_account_id IN (v_a, v_b))
    OR EXISTS (SELECT FROM dental.submission_keys WHERE owner_account_id IN (v_a, v_b))
    OR EXISTS (SELECT FROM dental.audit_events WHERE actor_account_id IN (v_a, v_b)) THEN
    RAISE EXCEPTION 'Smoke rollback left synthetic fixtures behind';
  END IF;
  -- No notices or patient-bearing rows. Normal DO completion is success.
END;
$task4_connector_smoke$;
