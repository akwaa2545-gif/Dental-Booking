-- UNEXECUTED Task 7 sequential connector smoke; exact project YOUR_SUPABASE_PROJECT_REF.
-- Requires separately approved/applied 005 and a separate exact-hash smoke approval.
-- Actual clock; synthetic past fixtures only, no fake clock. Single session is NOT concurrency proof.
-- Two temporary postgres SET memberships, eleven quiescent empty table locks, all sentinel-rolled back.
-- No helper EXECUTE grants, DDL, real admin assignment, credentials, provider or messaging calls.
DO $task7_connector_smoke$
DECLARE
 v_owner oid;v_backend oid;v_case record;v_role text;v_table text;
 v_actor uuid:=pg_catalog.gen_random_uuid();v_admin uuid:=pg_catalog.gen_random_uuid();v_other uuid:=pg_catalog.gen_random_uuid();v_unknown uuid:=pg_catalog.gen_random_uuid();
 v_subject text:='synthetic-task7-'||pg_catalog.gen_random_uuid()::text;
 v_now timestamptz;v_today date;v_date date;v_past date;v_weekend date;v_past_id uuid;
 v_patients uuid[]:='{}';v_bookings uuid[]:='{}';v_past_bookings uuid[]:='{}';
 v_result jsonb;v_input jsonb;
 v_patient_input jsonb:='{"fullName":"Synthetic Task7","phone":"0000000000","age":42,"address":"Fictional address","relationship":"self","authorizationAcknowledged":true}';
 v_error_seen boolean;v_all_passed boolean:=false;v_sentinel_seen boolean:=false;
 v_before jsonb;v_after jsonb;v_before_fingerprint text;v_after_fingerprint text;
 v_original_settings jsonb;v_restored_settings jsonb;v_checks text[]:='{}';
 v_expected_checks constant text[]:=ARRAY[
  'three_pending_reserve_capacity',
  'pending_approved_version',
  'approval_reminder_outbox',
  'stale_version',
  'approved_cannot_reject',
  'attendance_too_early',
  'non_admin_denied',
  'foreign_cancel_hidden',
  'missing_cancel_hidden',
  'invalid_reason',
  'pending_rejected_version',
  'rejection_releases_capacity',
  'replacement_reserves',
  'pause_reports_three',
  'paused_reservation_denied',
  'paused_approval_denied',
  'close_blocks_active',
  'pause_preserves_statuses',
  'approved_self_cancel',
  'cancel_suppresses_leases',
  'pending_self_cancel',
  'cancel_terminal_denied',
  'close_after_resolution',
  'explicit_weekday_reopen',
  'weekend_stays_closed',
  'weekend_reservation_denied',
  'admin_filtered_four_rows',
  'admin_read_scoped_audit',
  'past_approval_cutoff',
  'past_cancel_cutoff',
  'past_complete',
  'past_no_show',
  'backend_direct_read',
  'backend_role_grant',
  'anon_read_denied',
  'anon_cancel_denied',
  'anon_decide_denied',
  'anon_intake_denied',
  'anon_list_denied',
  'anon_grant_denied',
  'authenticated_read_denied',
  'authenticated_cancel_denied',
  'authenticated_decide_denied',
  'authenticated_intake_denied',
  'authenticated_list_denied',
  'authenticated_grant_denied',
  'revoked_admin_read_denied',
  'revoked_admin_write_denied',
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
    RAISE EXCEPTION 'Apply and verify the reviewed Task 7 migration first';
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
    ('dental.cancel(uuid,uuid,integer)'), ('dental.decide(uuid,uuid,integer,text,text)'),
    ('dental.set_intake(uuid,date,text,text)'), ('dental.admin_appointments(uuid,date,text)')
  ) AS required(signature) LOOP
    IF pg_catalog.to_regprocedure(v_case.signature) IS NULL
      OR NOT pg_catalog.has_function_privilege(v_backend,v_case.signature,'EXECUTE')
      OR pg_catalog.has_function_privilege('postgres',v_case.signature,'EXECUTE') THEN
      RAISE EXCEPTION 'Apply and independently verify Task 7 first';
    END IF;
  END LOOP;
  IF pg_catalog.to_regprocedure('dental.set_admin_grant(uuid,uuid,boolean,text)') IS NULL
    OR pg_catalog.has_function_privilege(v_backend,'dental.set_admin_grant(uuid,uuid,boolean,text)','EXECUTE')
    OR NOT pg_catalog.has_function_privilege('postgres','dental.set_admin_grant(uuid,uuid,boolean,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Operator-only role boundary differs';
  END IF;
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
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc WHERE pronamespace = 'dental'::pg_catalog.regnamespace) <> 24
    OR EXISTS (SELECT FROM pg_catalog.pg_proc WHERE pronamespace = 'dental'::pg_catalog.regnamespace
      AND (proowner <> v_owner OR proconfig IS DISTINCT FROM ARRAY['search_path=""']))
    OR EXISTS (SELECT FROM pg_catalog.pg_class WHERE relnamespace = 'dental'::pg_catalog.regnamespace AND relkind = 'r'
      AND (relowner <> 'postgres'::pg_catalog.regrole OR NOT relrowsecurity OR NOT relforcerowsecurity)) THEN
    RAISE EXCEPTION 'Task 7 ownership, private function surface or RLS baseline differs';
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
    v_now:=pg_catalog.clock_timestamp();v_today:=pg_catalog.timezone('Asia/Bangkok',v_now)::date;
    v_date:=v_today+7;WHILE extract(isodow FROM v_date)>5 LOOP v_date:=v_date+1;END LOOP;
    v_past:=v_today-7;WHILE extract(isodow FROM v_past)>5 LOOP v_past:=v_past-1;END LOOP;
    v_weekend:=v_date;WHILE extract(isodow FROM v_weekend)<>6 LOOP v_weekend:=v_weekend+1;END LOOP;
    INSERT INTO dental.accounts(id,provider,subject,created_at) VALUES
      (v_actor,'line:synthetic-task7',v_subject||'-owner',v_now),
      (v_admin,'line:synthetic-task7',v_subject||'-admin',v_now),
      (v_other,'line:synthetic-task7',v_subject||'-other',v_now);
    INSERT INTO dental.admin_grants(account_id,granted_at,granted_by) VALUES(v_admin,v_now,v_actor);
    SET LOCAL ROLE dental_backend;
    FOR i IN 1..3 LOOP
      v_result:=dental.create_patient(v_actor,v_patient_input||pg_catalog.jsonb_build_object('fullName','Synthetic Task7 '||i));
      v_patients:=pg_catalog.array_append(v_patients,(v_result->>'id')::uuid);
      v_input:=pg_catalog.jsonb_build_object('patientId',v_patients[i],'patientVersion',1,'service','oral_check','date',v_date::text,'ageConfirmed',42,'authorizationAcknowledged',true);
      v_result:=dental.reserve(v_actor,pg_catalog.gen_random_uuid(),v_input);
      v_bookings:=pg_catalog.array_append(v_bookings,(v_result->>'id')::uuid);
    END LOOP;
    RESET ROLE;
    IF ((SELECT count(*) FROM dental.appointments WHERE date=v_date AND status='pending')=3) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Smoke check failed: three_pending_reserve_capacity'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'three_pending_reserve_capacity');
    SET LOCAL ROLE dental_backend;v_result:=dental.decide(v_admin,v_bookings[1],1,'approve','Synthetic review');
    IF (v_result->>'status'='approved' AND (v_result->>'version')::int=2 AND v_result->>'approvedAt' IS NOT NULL) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Smoke check failed: pending_approved_version'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'pending_approved_version');
    RESET ROLE;
    IF ((SELECT count(*) FROM dental.outbox WHERE appointment_id=v_bookings[1] AND appointment_version=2 AND state='queued')=2 AND (SELECT count(*) FROM dental.outbox WHERE appointment_id=v_bookings[1] AND type='reminder' AND due_at=pg_catalog.timezone('Asia/Bangkok',(v_date-1)+time '18:00') AND expires_at=pg_catalog.timezone('Asia/Bangkok',v_date::timestamp))=1) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Smoke check failed: approval_reminder_outbox'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'approval_reminder_outbox');
    SET LOCAL ROLE dental_backend;
    v_error_seen:=false;
    BEGIN PERFORM dental.decide(v_admin,v_bookings[1],1,'reject','Synthetic review');
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> 'VERSION_CONFLICT' THEN RAISE; END IF;
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: stale_version'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'stale_version');
    v_error_seen:=false;
    BEGIN PERFORM dental.decide(v_admin,v_bookings[1],2,'reject','Synthetic review');
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> 'INVALID_TRANSITION' THEN RAISE; END IF;
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: approved_cannot_reject'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'approved_cannot_reject');
    v_error_seen:=false;
    BEGIN PERFORM dental.decide(v_admin,v_bookings[1],2,'complete','Synthetic review');
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> 'CUTOFF_PASSED' THEN RAISE; END IF;
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: attendance_too_early'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'attendance_too_early');
    v_error_seen:=false;
    BEGIN PERFORM dental.admin_appointments(v_other,NULL,NULL);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> 'FORBIDDEN' THEN RAISE; END IF;
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: non_admin_denied'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'non_admin_denied');
    v_error_seen:=false;
    BEGIN PERFORM dental.cancel(v_other,v_bookings[1],2);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> 'NOT_FOUND' THEN RAISE; END IF;
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: foreign_cancel_hidden'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'foreign_cancel_hidden');
    v_error_seen:=false;
    BEGIN PERFORM dental.cancel(v_other,v_unknown,2);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> 'NOT_FOUND' THEN RAISE; END IF;
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: missing_cancel_hidden'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'missing_cancel_hidden');
    v_error_seen:=false;
    BEGIN PERFORM dental.decide(v_admin,v_bookings[2],1,'reject',E' \n\t');
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> 'VALIDATION' THEN RAISE; END IF;
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: invalid_reason'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'invalid_reason');
    v_result:=dental.decide(v_admin,v_bookings[2],1,'reject','Synthetic rejection');
    IF (v_result->>'status'='rejected' AND (v_result->>'version')::int=2) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Smoke check failed: pending_rejected_version'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'pending_rejected_version');
    RESET ROLE;
    IF ((SELECT count(*) FROM dental.appointments WHERE date=v_date AND status IN('pending','approved'))=2) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Smoke check failed: rejection_releases_capacity'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'rejection_releases_capacity');
    SET LOCAL ROLE dental_backend;v_input:=pg_catalog.jsonb_build_object('patientId',v_patients[2],'patientVersion',1,'service','filling','date',v_date::text,'ageConfirmed',42,'authorizationAcknowledged',true);v_result:=dental.reserve(v_actor,pg_catalog.gen_random_uuid(),v_input);v_bookings:=pg_catalog.array_append(v_bookings,(v_result->>'id')::uuid);
    IF (v_result->>'status'='pending') IS DISTINCT FROM true THEN RAISE EXCEPTION 'Smoke check failed: replacement_reserves'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'replacement_reserves');
    v_result:=dental.set_intake(v_admin,v_date,'paused','Synthetic absence');
    IF (v_result->>'intake'='paused' AND (v_result->>'unresolved')::int=3) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Smoke check failed: pause_reports_three'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'pause_reports_three');
    v_error_seen:=false;
    BEGIN PERFORM dental.reserve(v_actor,pg_catalog.gen_random_uuid(),v_input);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> 'INTAKE_CLOSED' THEN RAISE; END IF;
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: paused_reservation_denied'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'paused_reservation_denied');
    v_error_seen:=false;
    BEGIN PERFORM dental.decide(v_admin,v_bookings[3],1,'approve','Synthetic review');
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> 'INTAKE_CLOSED' THEN RAISE; END IF;
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: paused_approval_denied'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'paused_approval_denied');
    v_error_seen:=false;
    BEGIN PERFORM dental.set_intake(v_admin,v_date,'closed','Synthetic absence');
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> 'UNRESOLVED_BOOKINGS' THEN RAISE; END IF;
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: close_blocks_active'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'close_blocks_active');
    RESET ROLE;
    IF ((SELECT count(*) FROM dental.appointments WHERE date=v_date AND status IN('pending','approved'))=3) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Smoke check failed: pause_preserves_statuses'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'pause_preserves_statuses');
    UPDATE dental.outbox SET state='leased',lease_owner=v_unknown,lease_until=pg_catalog.clock_timestamp()+interval '5 minutes' WHERE appointment_id=v_bookings[1];
    SET LOCAL ROLE dental_backend;v_result:=dental.cancel(v_actor,v_bookings[1],2);
    IF (v_result->>'status'='cancelled' AND (v_result->>'version')::int=3) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Smoke check failed: approved_self_cancel'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'approved_self_cancel');
    RESET ROLE;
    IF ((SELECT count(*) FROM dental.outbox WHERE appointment_id=v_bookings[1] AND state='suppressed' AND lease_owner IS NULL AND lease_until IS NULL)=2) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Smoke check failed: cancel_suppresses_leases'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'cancel_suppresses_leases');
    SET LOCAL ROLE dental_backend;v_result:=dental.cancel(v_actor,v_bookings[4],1);
    IF (v_result->>'status'='cancelled' AND (v_result->>'version')::int=2) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Smoke check failed: pending_self_cancel'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'pending_self_cancel');
    v_error_seen:=false;
    BEGIN PERFORM dental.cancel(v_actor,v_bookings[4],2);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> 'INVALID_TRANSITION' THEN RAISE; END IF;
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: cancel_terminal_denied'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'cancel_terminal_denied');
    PERFORM dental.decide(v_admin,v_bookings[3],1,'reject','Synthetic resolution');v_result:=dental.set_intake(v_admin,v_date,'closed','Synthetic resolved absence');
    IF (v_result->>'intake'='closed' AND (v_result->>'unresolved')::int=0) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Smoke check failed: close_after_resolution'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'close_after_resolution');
    v_result:=dental.set_intake(v_admin,v_date,'open','Synthetic reopen');
    IF (v_result->>'intake'='open') IS DISTINCT FROM true THEN RAISE EXCEPTION 'Smoke check failed: explicit_weekday_reopen'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'explicit_weekday_reopen');
    PERFORM dental.set_intake(v_admin,v_weekend,'open','Synthetic weekend safety');v_result:=dental.availability(v_weekend,v_weekend);
    IF (v_result->0->>'state'='ineligible') IS DISTINCT FROM true THEN RAISE EXCEPTION 'Smoke check failed: weekend_stays_closed'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'weekend_stays_closed');
    v_error_seen:=false;
    BEGIN PERFORM dental.reserve(v_actor,pg_catalog.gen_random_uuid(),v_input||pg_catalog.jsonb_build_object('date',v_weekend::text));
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> 'INELIGIBLE_DATE' THEN RAISE; END IF;
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: weekend_reservation_denied'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'weekend_reservation_denied');
    v_result:=dental.admin_appointments(v_admin,v_date,NULL);
    IF (pg_catalog.jsonb_array_length(v_result)=4 AND NOT EXISTS(SELECT FROM pg_catalog.jsonb_array_elements(v_result) x WHERE x->>'date'<>v_date::text OR NOT x?'notificationAttempts')) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Smoke check failed: admin_filtered_four_rows'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'admin_filtered_four_rows');
    RESET ROLE;
    IF ((SELECT count(*) FROM dental.audit_events WHERE action='admin_appointments_read')=4 AND (SELECT count(*) FROM dental.audit_events WHERE action='admin_appointments_query')=1) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Smoke check failed: admin_read_scoped_audit'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'admin_read_scoped_audit');
    SET LOCAL ROLE dental_function_owner;
    INSERT INTO dental.clinic_dates(date) VALUES(v_past);
    FOR i IN 1..3 LOOP
      INSERT INTO dental.appointments(owner_account_id,patient_id,patient_version,patient_snapshot,age_captured_on,service,date,status,approved_at,idempotency_key,created_at,updated_at)
      VALUES(v_actor,v_patients[i],1,v_patient_input||pg_catalog.jsonb_build_object('fullName','Synthetic Task7 '||i),v_today,'oral_check',v_past,
        CASE WHEN i=1 THEN 'pending' ELSE 'approved' END,
        CASE WHEN i=1 THEN NULL ELSE pg_catalog.timezone('Asia/Bangkok',(v_past-1)+time '10:00') END,
        pg_catalog.gen_random_uuid(),pg_catalog.timezone('Asia/Bangkok',(v_past-1)+time '09:00'),pg_catalog.timezone('Asia/Bangkok',(v_past-1)+time '10:00'))
      RETURNING id INTO v_past_id;
      v_past_bookings:=pg_catalog.array_append(v_past_bookings,v_past_id);
    END LOOP;
    RESET ROLE;SET LOCAL ROLE dental_backend;
    v_error_seen:=false;
    BEGIN PERFORM dental.decide(v_admin,v_past_bookings[1],1,'approve','Synthetic past request');
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> 'CUTOFF_PASSED' THEN RAISE; END IF;
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: past_approval_cutoff'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'past_approval_cutoff');
    v_error_seen:=false;
    BEGIN PERFORM dental.cancel(v_actor,v_past_bookings[2],1);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> 'CUTOFF_PASSED' THEN RAISE; END IF;
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: past_cancel_cutoff'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'past_cancel_cutoff');
    v_result:=dental.decide(v_admin,v_past_bookings[2],1,'complete','Synthetic attendance');
    IF (v_result->>'status'='completed' AND (v_result->>'version')::int=2) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Smoke check failed: past_complete'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'past_complete');
    v_result:=dental.decide(v_admin,v_past_bookings[3],1,'no_show','Synthetic absence');
    IF (v_result->>'status'='no_show' AND (v_result->>'version')::int=2) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Smoke check failed: past_no_show'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'past_no_show');
    v_error_seen:=false;
    BEGIN PERFORM 1 FROM dental.appointments;
    EXCEPTION WHEN SQLSTATE '42501' THEN
      
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: backend_direct_read'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'backend_direct_read');
    v_error_seen:=false;
    BEGIN PERFORM dental.set_admin_grant(v_admin,v_other,true,'Synthetic forbidden');
    EXCEPTION WHEN SQLSTATE '42501' THEN
      
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: backend_role_grant'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'backend_role_grant');
    RESET ROLE;
    SET LOCAL ROLE anon;
    v_error_seen:=false;
    BEGIN PERFORM 1 FROM dental.appointments;
    EXCEPTION WHEN SQLSTATE '42501' THEN
      
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: anon_read_denied'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'anon_read_denied');
    v_error_seen:=false;
    BEGIN PERFORM dental.cancel(v_actor,v_bookings[1],3);
    EXCEPTION WHEN SQLSTATE '42501' THEN
      
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: anon_cancel_denied'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'anon_cancel_denied');
    v_error_seen:=false;
    BEGIN PERFORM dental.decide(v_admin,v_bookings[1],3,'reject','Synthetic forbidden');
    EXCEPTION WHEN SQLSTATE '42501' THEN
      
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: anon_decide_denied'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'anon_decide_denied');
    v_error_seen:=false;
    BEGIN PERFORM dental.set_intake(v_admin,v_date,'open','Synthetic forbidden');
    EXCEPTION WHEN SQLSTATE '42501' THEN
      
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: anon_intake_denied'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'anon_intake_denied');
    v_error_seen:=false;
    BEGIN PERFORM dental.admin_appointments(v_admin,NULL,NULL);
    EXCEPTION WHEN SQLSTATE '42501' THEN
      
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: anon_list_denied'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'anon_list_denied');
    v_error_seen:=false;
    BEGIN PERFORM dental.set_admin_grant(v_admin,v_other,true,'Synthetic forbidden');
    EXCEPTION WHEN SQLSTATE '42501' THEN
      
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: anon_grant_denied'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'anon_grant_denied');
    RESET ROLE;
    SET LOCAL ROLE authenticated;
    v_error_seen:=false;
    BEGIN PERFORM 1 FROM dental.appointments;
    EXCEPTION WHEN SQLSTATE '42501' THEN
      
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: authenticated_read_denied'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'authenticated_read_denied');
    v_error_seen:=false;
    BEGIN PERFORM dental.cancel(v_actor,v_bookings[1],3);
    EXCEPTION WHEN SQLSTATE '42501' THEN
      
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: authenticated_cancel_denied'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'authenticated_cancel_denied');
    v_error_seen:=false;
    BEGIN PERFORM dental.decide(v_admin,v_bookings[1],3,'reject','Synthetic forbidden');
    EXCEPTION WHEN SQLSTATE '42501' THEN
      
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: authenticated_decide_denied'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'authenticated_decide_denied');
    v_error_seen:=false;
    BEGIN PERFORM dental.set_intake(v_admin,v_date,'open','Synthetic forbidden');
    EXCEPTION WHEN SQLSTATE '42501' THEN
      
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: authenticated_intake_denied'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'authenticated_intake_denied');
    v_error_seen:=false;
    BEGIN PERFORM dental.admin_appointments(v_admin,NULL,NULL);
    EXCEPTION WHEN SQLSTATE '42501' THEN
      
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: authenticated_list_denied'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'authenticated_list_denied');
    v_error_seen:=false;
    BEGIN PERFORM dental.set_admin_grant(v_admin,v_other,true,'Synthetic forbidden');
    EXCEPTION WHEN SQLSTATE '42501' THEN
      
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: authenticated_grant_denied'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'authenticated_grant_denied');
    RESET ROLE;
    UPDATE dental.admin_grants SET revoked_at=pg_catalog.clock_timestamp(),revoked_by=v_actor WHERE account_id=v_admin;SET LOCAL ROLE dental_backend;
    v_error_seen:=false;
    BEGIN PERFORM dental.admin_appointments(v_admin,NULL,NULL);
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> 'FORBIDDEN' THEN RAISE; END IF;
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: revoked_admin_read_denied'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'revoked_admin_read_denied');
    v_error_seen:=false;
    BEGIN PERFORM dental.set_intake(v_admin,v_date,'open','Synthetic forbidden');
    EXCEPTION WHEN SQLSTATE 'P0001' THEN
      IF SQLERRM <> 'FORBIDDEN' THEN RAISE; END IF;
      v_error_seen:=true;
    END;
    IF NOT v_error_seen THEN RAISE EXCEPTION 'Smoke check failed: revoked_admin_write_denied'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'revoked_admin_write_denied');
    RESET ROLE;EXECUTE v_state_sql INTO v_after;
    IF (v_after->'rows'=pg_catalog.jsonb_build_object('accounts',3,'patients',3,'appointments',7,'clinic_dates',3,'admin_grants',1,'audit_events',23,'outbox',4,'submission_keys',4,'sessions',0,'oauth_pending',0,'notification_attempts',0) AND (SELECT count(*) FROM dental.admin_grants WHERE revoked_at IS NOT NULL)=1 AND (SELECT count(*) FROM dental.outbox WHERE state='suppressed')=2 AND (SELECT count(*) FROM dental.outbox WHERE state='queued' AND type='rejection')=2) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Smoke check failed: synthetic_totals'; END IF;
    v_checks:=pg_catalog.array_append(v_checks,'synthetic_totals');
    IF v_checks IS DISTINCT FROM v_expected_checks OR pg_catalog.cardinality(v_checks)<>49 OR CURRENT_USER<>'postgres' THEN RAISE EXCEPTION 'Incomplete smoke manifest';END IF;
    v_all_passed:=true;
    RAISE EXCEPTION USING ERRCODE = 'PT997', MESSAGE = 'Task 7 smoke rollback sentinel';
  EXCEPTION WHEN SQLSTATE 'PT997' THEN
    IF NOT v_all_passed OR SQLERRM<>'Task 7 smoke rollback sentinel' THEN RAISE;END IF;
    v_sentinel_seen:=true;
  END;
  EXECUTE v_settings_sql INTO v_restored_settings;
  IF NOT v_all_passed OR NOT v_sentinel_seen OR v_checks IS DISTINCT FROM v_expected_checks
    OR v_original_settings IS DISTINCT FROM v_restored_settings OR CURRENT_USER<>'postgres' OR SESSION_USER<>'postgres' THEN
    RAISE EXCEPTION 'Smoke rollback did not restore execution context';END IF;
  EXECUTE v_state_sql INTO v_after;v_after_fingerprint:=pg_catalog.md5(v_after::text);
  IF v_before IS DISTINCT FROM v_after OR v_before_fingerprint IS DISTINCT FROM v_after_fingerprint THEN
    RAISE EXCEPTION 'Smoke rollback changed private security metadata or row counts';END IF;
  IF EXISTS(SELECT FROM dental.accounts WHERE id IN(v_actor,v_admin,v_other)) THEN RAISE EXCEPTION 'Synthetic fixtures survived rollback';END IF;
  -- Normal completion plus separate exact read-only PRE/POST equality is required.
END;
$task7_connector_smoke$;
