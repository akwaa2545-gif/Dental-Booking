-- UNEXECUTED Task 4 managed-Supabase candidate. Separate action-time approval
-- required for precise grants/policies/functions and temporary operator SET role.
-- One atomic statement; do not reapply Task 3 or apply individual inner fragments.
DO $task4$
DECLARE
  v_major integer := pg_catalog.current_setting('server_version_num')::integer / 10000;
  v_before jsonb;
  v_after jsonb;
  v_defaults jsonb;
  v_membership_count bigint;
  v_membership_role_count bigint;
BEGIN
  IF CURRENT_USER <> 'postgres' OR SESSION_USER <> 'postgres' OR v_major NOT IN (15,17)
    OR pg_catalog.current_setting('transaction_read_only') <> 'off'
    OR pg_catalog.to_regprocedure('dental.reserve(uuid,uuid,jsonb)') IS NOT NULL
    OR pg_catalog.to_regprocedure('dental.update_patient(uuid,uuid,integer,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Task 4 requires verified Task 3 managed baseline and unapplied reservation migration';
  END IF;
  PERFORM pg_catalog.set_config('dental.migration_bundle','task4-managed-v1',true);
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.oid), '[]'::jsonb)
    INTO v_defaults FROM pg_catalog.pg_default_acl d WHERE d.defaclrole = 'postgres'::pg_catalog.regrole;
  PERFORM pg_catalog.set_config('dental.task4_postgres_defaults', v_defaults::text, true);
  -- A known owner-only default baseline prevents newly created helper exposure.
  IF NOT EXISTS (
    SELECT FROM pg_catalog.pg_default_acl d
    WHERE d.defaclrole = 'dental_function_owner'::pg_catalog.regrole
      AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f'
  ) OR EXISTS (
    SELECT FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
    WHERE d.defaclrole = 'dental_function_owner'::pg_catalog.regrole
      AND a.grantee <> 'dental_function_owner'::pg_catalog.regrole
  ) THEN
    RAISE EXCEPTION 'Function-owner default privileges are unsafe';
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY roleid,member,grantor),'[]'::jsonb)
    INTO v_before FROM pg_catalog.pg_auth_members m
    WHERE roleid IN ('dental_function_owner'::regrole,'dental_backend'::regrole);
  PERFORM pg_catalog.set_config('dental.task4_memberships',v_before::text,true);
  SELECT pg_catalog.count(*), pg_catalog.count(DISTINCT roleid)
    INTO v_membership_count, v_membership_role_count FROM pg_catalog.pg_auth_members
    WHERE roleid IN ('dental_function_owner'::regrole,'dental_backend'::regrole);
  IF (v_major = 17 AND (v_membership_count <> 2 OR v_membership_role_count <> 2))
    OR (v_major = 15 AND v_membership_count <> 0) THEN
    RAISE EXCEPTION 'Unreviewed version-specific membership baseline';
  END IF;
  IF EXISTS(SELECT FROM pg_catalog.pg_roles WHERE rolname IN ('dental_function_owner','dental_backend')
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit))
    OR EXISTS(SELECT FROM pg_catalog.pg_auth_members WHERE member IN ('dental_function_owner'::regrole,'dental_backend'::regrole))
    OR EXISTS(SELECT FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles g ON g.oid=m.grantor
      WHERE m.roleid IN ('dental_function_owner'::regrole,'dental_backend'::regrole)
      AND (v_major<>17 OR m.member<>'postgres'::regrole OR NOT g.rolsuper OR NOT m.admin_option
        OR pg_catalog.to_jsonb(m)->>'set_option'<>'false' OR pg_catalog.to_jsonb(m)->>'inherit_option'<>'false')) THEN
    RAISE EXCEPTION 'Unreviewed role membership or attributes';
  END IF;
  IF v_major=17 THEN
    EXECUTE 'GRANT dental_function_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres';
  ELSE
    GRANT dental_function_owner TO postgres;
  END IF;
  GRANT CREATE ON SCHEMA dental TO dental_function_owner;
  GRANT SELECT, INSERT ON dental.clinic_dates, dental.appointments, dental.submission_keys TO dental_function_owner;
  GRANT UPDATE (date) ON dental.clinic_dates TO dental_function_owner;
  GRANT UPDATE (appointment_id,result) ON dental.submission_keys TO dental_function_owner;
  CREATE POLICY dates_function_read ON dental.clinic_dates FOR SELECT TO dental_function_owner USING (true);
  CREATE POLICY dates_function_insert ON dental.clinic_dates FOR INSERT TO dental_function_owner WITH CHECK (true);
  CREATE POLICY dates_function_lock ON dental.clinic_dates FOR UPDATE TO dental_function_owner USING (true) WITH CHECK (true);
  CREATE POLICY appointments_function_read ON dental.appointments FOR SELECT TO dental_function_owner USING (true);
  CREATE POLICY appointments_function_insert ON dental.appointments FOR INSERT TO dental_function_owner WITH CHECK (true);
  CREATE POLICY submissions_function_read ON dental.submission_keys FOR SELECT TO dental_function_owner USING (true);
  CREATE POLICY submissions_function_insert ON dental.submission_keys FOR INSERT TO dental_function_owner WITH CHECK (true);
  CREATE POLICY submissions_function_update ON dental.submission_keys FOR UPDATE TO dental_function_owner USING (true) WITH CHECK (true);
  SET LOCAL ROLE dental_function_owner;
  EXECUTE $definitions$
CREATE FUNCTION dental._appointment_json(p dental.appointments)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
AS $body$
 SELECT pg_catalog.jsonb_build_object('id',(p).id,'reference',(p).reference,'patientId',(p).patient_id,
 'patient',(p).patient_snapshot,'service',(p).service,'date',pg_catalog.to_char((p).date,'YYYY-MM-DD'),
 'status',(p).status,'version',(p).version,'createdAt',(p).created_at,'approvedAt',(p).approved_at,
 'cancelBefore',pg_catalog.timezone('Asia/Bangkok',(p).date::timestamp))
$body$;
CREATE FUNCTION dental.availability(p_from date,p_to date)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_today date := pg_catalog.timezone('Asia/Bangkok',dental.clock_now())::date; v_result jsonb;
BEGIN
 IF p_from IS NULL OR p_to IS NULL OR NOT pg_catalog.isfinite(p_from) OR NOT pg_catalog.isfinite(p_to)
   OR p_from<date '0001-01-01' OR p_to>date '9999-12-31' OR p_to<p_from OR p_to-p_from>91 THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
 END IF;
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('date',pg_catalog.to_char(d.day,'YYYY-MM-DD'),'state',
 CASE WHEN d.day<=v_today OR d.day>v_today+90 OR EXTRACT(ISODOW FROM d.day)>5 THEN 'ineligible'
 WHEN c.intake='closed' THEN 'closed' WHEN c.intake='paused' THEN 'paused'
 WHEN (SELECT pg_catalog.count(*) FROM dental.appointments a WHERE a.date=d.day AND a.status IN ('pending','approved'))>=3 THEN 'full'
 ELSE 'available' END) ORDER BY d.day),'[]'::jsonb) INTO v_result
 FROM (SELECT p_from+i AS day FROM pg_catalog.generate_series(0,p_to-p_from) i) d
 LEFT JOIN dental.clinic_dates c ON c.date=d.day;
 RETURN v_result;
END;
$body$;
CREATE FUNCTION dental.reserve(p_actor uuid,p_key uuid,p_input jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_patient_id uuid; v_date date; v_version numeric; v_age numeric; v_hash text;
 v_key dental.submission_keys; v_day dental.clinic_dates; v_patient dental.patients;
 v_appointment dental.appointments; v_now timestamptz; v_today date; v_result jsonb;
BEGIN
 -- A stale REPEATABLE READ snapshot must never perform a capacity count.
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE';
 END IF;
 IF p_actor IS NULL OR NOT EXISTS(SELECT FROM dental.accounts WHERE id=p_actor) THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAUTHENTICATED';
 END IF;
 IF p_key IS NULL OR p_input IS NULL OR pg_catalog.jsonb_typeof(p_input)<>'object' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
 END IF;
 IF NOT(p_input ?& ARRAY['patientId','patientVersion','service','date','ageConfirmed','authorizationAcknowledged'])
  OR EXISTS(SELECT FROM pg_catalog.jsonb_object_keys(p_input) k WHERE k<>ALL(ARRAY['patientId','patientVersion','service','date','ageConfirmed','authorizationAcknowledged']))
  OR pg_catalog.jsonb_typeof(p_input->'patientId')<>'string'
  OR pg_catalog.jsonb_typeof(p_input->'date')<>'string'
  OR pg_catalog.jsonb_typeof(p_input->'service')<>'string'
  OR pg_catalog.jsonb_typeof(p_input->'patientVersion')<>'number'
  OR pg_catalog.jsonb_typeof(p_input->'ageConfirmed')<>'number'
  OR p_input->'authorizationAcknowledged' IS DISTINCT FROM 'true'::jsonb
  OR p_input->>'service' NOT IN ('oral_check','scaling','filling') THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
 END IF;
 BEGIN
  IF p_input->>'patientId' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
   OR p_input->>'date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
  END IF;
  v_patient_id:=(p_input->>'patientId')::uuid; v_date:=(p_input->>'date')::date;
  v_version:=(p_input->>'patientVersion')::numeric; v_age:=(p_input->>'ageConfirmed')::numeric;
 EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
 END;
 IF v_date<date '0001-01-01' OR v_date>date '9999-12-31'
  OR v_version<1 OR v_version>2147483647 OR v_version<>pg_catalog.trunc(v_version)
  OR v_age<0 OR v_age>150 OR v_age<>pg_catalog.trunc(v_age) THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
 END IF;
 v_hash:=pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_input::text,'UTF8')),'hex');
 -- Unique key insertion waits for a competing transaction before any date lock.
 INSERT INTO dental.submission_keys(owner_account_id,key,payload_hash) VALUES(p_actor,p_key,v_hash) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT v_key FROM dental.submission_keys WHERE owner_account_id=p_actor AND key=p_key FOR UPDATE;
 IF v_key.payload_hash<>v_hash THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='IDEMPOTENCY_CONFLICT'; END IF;
 IF v_key.result IS NOT NULL THEN RETURN v_key.result; END IF;
 INSERT INTO dental.clinic_dates(date) VALUES(v_date) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT v_day FROM dental.clinic_dates WHERE date=v_date FOR UPDATE;
 v_now:=dental.clock_now(); v_today:=pg_catalog.timezone('Asia/Bangkok',v_now)::date;
 IF v_date<=v_today OR v_date>v_today+90 OR EXTRACT(ISODOW FROM v_date)>5 THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='INELIGIBLE_DATE';
 END IF;
 IF v_day.intake<>'open' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='INTAKE_CLOSED'; END IF;
 -- SHARE prevents a concurrent profile edit between version validation/snapshot.
 SELECT * INTO v_patient FROM dental.patients WHERE id=v_patient_id AND owner_account_id=p_actor FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='NOT_FOUND'; END IF;
 -- Profile locking may also wait across midnight; recheck after every wait.
 v_now:=dental.clock_now(); v_today:=pg_catalog.timezone('Asia/Bangkok',v_now)::date;
 IF v_date<=v_today OR v_date>v_today+90 OR EXTRACT(ISODOW FROM v_date)>5 THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='INELIGIBLE_DATE';
 END IF;
 IF v_patient.version<>v_version OR v_patient.age<>v_age THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VERSION_CONFLICT';
 END IF;
 IF EXISTS(SELECT FROM dental.appointments WHERE patient_id=v_patient_id AND date=v_date AND status IN ('pending', 'approved')) THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='DUPLICATE';
 END IF;
 IF (SELECT pg_catalog.count(*) FROM dental.appointments WHERE date=v_date AND status IN ('pending', 'approved'))>=3 THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FULL';
 END IF;
 INSERT INTO dental.appointments(owner_account_id,patient_id,patient_version,patient_snapshot,age_captured_on,service,date,idempotency_key,created_at,updated_at)
 VALUES(p_actor,v_patient_id,v_patient.version,dental._patient_json(v_patient)-ARRAY['id','version','ageCapturedOn'],v_today,p_input->>'service',v_date,p_key,v_now,v_now)
 RETURNING * INTO v_appointment;
 v_result:=dental._appointment_json(v_appointment);
 INSERT INTO dental.audit_events(actor_account_id,action,patient_id,appointment_id,clinic_date)
 VALUES(p_actor,'appointment_reserved',v_patient_id,v_appointment.id,v_date);
 UPDATE dental.submission_keys SET appointment_id=v_appointment.id,result=v_result WHERE owner_account_id=p_actor AND key=p_key;
 RETURN v_result;
END;
$body$;
CREATE FUNCTION dental.submission(p_actor uuid,p_key uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
BEGIN
 IF p_actor IS NULL OR NOT EXISTS(SELECT FROM dental.accounts WHERE id=p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAUTHENTICATED'; END IF;
 RETURN (SELECT result FROM dental.submission_keys WHERE owner_account_id=p_actor AND key=p_key);
END;
$body$;
CREATE FUNCTION dental.list_appointments(p_actor uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
BEGIN
 IF p_actor IS NULL OR NOT EXISTS(SELECT FROM dental.accounts WHERE id=p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAUTHENTICATED'; END IF;
 RETURN (SELECT COALESCE(pg_catalog.jsonb_agg(dental._appointment_json(a) ORDER BY a.created_at DESC,a.id),'[]'::jsonb) FROM dental.appointments a WHERE a.owner_account_id=p_actor);
END;
$body$;
CREATE FUNCTION dental.get_appointment(p_actor uuid,p_id uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_result jsonb;
BEGIN
 IF p_actor IS NULL OR NOT EXISTS(SELECT FROM dental.accounts WHERE id=p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAUTHENTICATED'; END IF;
 SELECT dental._appointment_json(a) INTO v_result FROM dental.appointments a WHERE a.owner_account_id=p_actor AND a.id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='NOT_FOUND'; END IF;
 RETURN v_result;
END;
$body$;
REVOKE ALL ON FUNCTION dental._appointment_json(dental.appointments),dental.availability(date,date),dental.reserve(uuid,uuid,jsonb),dental.submission(uuid,uuid),dental.list_appointments(uuid),dental.get_appointment(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dental.availability(date,date),dental.reserve(uuid,uuid,jsonb),dental.submission(uuid,uuid),dental.list_appointments(uuid),dental.get_appointment(uuid,uuid) TO dental_backend;
$definitions$;
  RESET ROLE;
  REVOKE CREATE ON SCHEMA dental FROM dental_function_owner;
  IF v_major=17 THEN EXECUTE 'REVOKE dental_function_owner FROM postgres GRANTED BY postgres';
  ELSE REVOKE dental_function_owner FROM postgres; END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY roleid,member,grantor),'[]'::jsonb)
    INTO v_after FROM pg_catalog.pg_auth_members m
    WHERE roleid IN ('dental_function_owner'::regrole,'dental_backend'::regrole);
  IF v_before IS DISTINCT FROM v_after OR pg_catalog.has_schema_privilege('dental_function_owner','dental','CREATE') THEN
    RAISE EXCEPTION 'Temporary migration access was not cleaned up';
  END IF;
  -- Exact combined Task 3 + Task 4 surface; any failure rolls back this entire DO.
DO $task4_final_audit$
DECLARE
  v_postgres oid := 'postgres'::pg_catalog.regrole;
  v_owner oid := 'dental_function_owner'::pg_catalog.regrole;
  v_backend oid := 'dental_backend'::pg_catalog.regrole;
  v_schema oid := 'dental'::pg_catalog.regnamespace;
  v_memberships jsonb;
  v_defaults jsonb;
  v_role text;
  v_column text;
  v_table record;
  v_function record;
  v_required record;
  v_entry_points oid[] := ARRAY[
    'dental.list_patients(uuid)'::pg_catalog.regprocedure::oid,
    'dental.create_patient(uuid,jsonb)'::pg_catalog.regprocedure::oid,
    'dental.update_patient(uuid,uuid,integer,jsonb)'::pg_catalog.regprocedure::oid,
    'dental.availability(date,date)'::pg_catalog.regprocedure::oid,
    'dental.reserve(uuid,uuid,jsonb)'::pg_catalog.regprocedure::oid,
    'dental.submission(uuid,uuid)'::pg_catalog.regprocedure::oid,
    'dental.list_appointments(uuid)'::pg_catalog.regprocedure::oid,
    'dental.get_appointment(uuid,uuid)'::pg_catalog.regprocedure::oid
  ];
BEGIN
  IF CURRENT_USER <> 'postgres' OR SESSION_USER <> 'postgres'
    OR pg_catalog.current_setting('dental.migration_bundle', true) IS DISTINCT FROM 'task4-managed-v1' THEN
    RAISE EXCEPTION 'Unexpected migration execution context';
  END IF;
  IF EXISTS (
    SELECT FROM pg_catalog.pg_roles WHERE oid IN (v_owner, v_backend) AND
      (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit)
  ) OR EXISTS (SELECT FROM pg_catalog.pg_auth_members WHERE member IN (v_owner, v_backend)) THEN
    RAISE EXCEPTION 'Dental role attributes or outgoing memberships are unsafe';
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY m.roleid, m.member, m.grantor), '[]'::jsonb)
    INTO v_memberships FROM pg_catalog.pg_auth_members m WHERE m.roleid IN (v_owner, v_backend);
  IF v_memberships IS DISTINCT FROM pg_catalog.current_setting('dental.task4_memberships')::jsonb THEN
    RAISE EXCEPTION 'Temporary membership cleanup did not preserve only the approved baseline';
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.oid), '[]'::jsonb)
    INTO v_defaults FROM pg_catalog.pg_default_acl d WHERE d.defaclrole = v_postgres;
  IF v_defaults IS DISTINCT FROM pg_catalog.current_setting('dental.task4_postgres_defaults')::jsonb THEN
    RAISE EXCEPTION 'Postgres default privileges changed unexpectedly';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE oid = v_schema AND nspowner = v_postgres)
    OR NOT pg_catalog.has_schema_privilege(v_owner, v_schema, 'USAGE')
    OR NOT pg_catalog.has_schema_privilege(v_backend, v_schema, 'USAGE')
    OR pg_catalog.has_schema_privilege(v_owner, v_schema, 'CREATE')
    OR pg_catalog.has_schema_privilege(v_backend, v_schema, 'CREATE') THEN
    RAISE EXCEPTION 'Private schema ownership or privileges are incorrect';
  END IF;
  IF EXISTS (
    SELECT FROM pg_catalog.pg_namespace n
    CROSS JOIN LATERAL pg_catalog.aclexplode(COALESCE(n.nspacl, pg_catalog.acldefault('n', n.nspowner))) a
    WHERE n.oid = v_schema AND a.grantee <> v_postgres
      AND NOT (a.grantee IN (v_owner, v_backend) AND a.privilege_type = 'USAGE' AND NOT a.is_grantable)
  ) THEN
    RAISE EXCEPTION 'Unexpected private schema ACL';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_class WHERE relnamespace = v_schema AND relkind = 'r') <> 10 THEN
    RAISE EXCEPTION 'Private table set is incomplete';
  END IF;
  FOR v_table IN SELECT * FROM pg_catalog.pg_class WHERE relnamespace = v_schema AND relkind = 'r' LOOP
    IF v_table.relowner <> v_postgres OR NOT v_table.relrowsecurity OR NOT v_table.relforcerowsecurity THEN
      RAISE EXCEPTION 'Private table ownership or forced RLS is incorrect';
    END IF;
    IF pg_catalog.has_table_privilege(v_backend, v_table.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      OR pg_catalog.has_any_column_privilege(v_backend, v_table.oid, 'SELECT, INSERT, UPDATE, REFERENCES') THEN
      RAISE EXCEPTION 'Backend has direct private table or column access';
    END IF;
    IF EXISTS (
      SELECT FROM pg_catalog.aclexplode(COALESCE(v_table.relacl, pg_catalog.acldefault('r', v_postgres))) a
      WHERE a.grantee <> v_postgres AND NOT (
        a.grantee = v_owner AND a.grantor = v_postgres AND NOT a.is_grantable AND (
          (v_table.relname = 'accounts' AND a.privilege_type = 'SELECT')
          OR (v_table.relname IN ('patients', 'clinic_dates', 'appointments', 'submission_keys') AND a.privilege_type IN ('SELECT', 'INSERT'))
          OR (v_table.relname = 'audit_events' AND a.privilege_type = 'INSERT')
        )
      )
    ) THEN
      RAISE EXCEPTION 'Unexpected private table ACL';
    END IF;
  END LOOP;
  IF EXISTS (
    SELECT FROM pg_catalog.pg_attribute c
    JOIN pg_catalog.pg_class t ON t.oid = c.attrelid
    CROSS JOIN LATERAL pg_catalog.aclexplode(c.attacl) a
    WHERE t.relnamespace = v_schema AND NOT (
      a.grantee = v_owner AND a.grantor = v_postgres AND NOT a.is_grantable
      AND a.privilege_type = 'UPDATE' AND (
        (t.relname = 'patients' AND c.attname IN ('full_name', 'phone', 'age', 'address', 'relationship', 'authorization_acknowledged', 'age_captured_on', 'version', 'updated_at'))
        OR (t.relname = 'clinic_dates' AND c.attname = 'date')
        OR (t.relname = 'submission_keys' AND c.attname IN ('appointment_id', 'result'))
      )
    )
  ) THEN
    RAISE EXCEPTION 'Unexpected private column ACL';
  END IF;
  IF NOT pg_catalog.has_table_privilege(v_owner, 'dental.accounts', 'SELECT')
    OR NOT pg_catalog.has_table_privilege(v_owner, 'dental.patients', 'SELECT')
    OR NOT pg_catalog.has_table_privilege(v_owner, 'dental.patients', 'INSERT')
    OR NOT pg_catalog.has_table_privilege(v_owner, 'dental.audit_events', 'INSERT') THEN
    RAISE EXCEPTION 'Required function-owner table privileges are missing';
  END IF;
  FOREACH v_column IN ARRAY ARRAY['full_name', 'phone', 'age', 'address', 'relationship', 'authorization_acknowledged', 'age_captured_on', 'version', 'updated_at'] LOOP
    IF NOT pg_catalog.has_column_privilege(v_owner, 'dental.patients', v_column, 'UPDATE') THEN
      RAISE EXCEPTION 'Required function-owner column privilege is missing';
    END IF;
  END LOOP;
  FOR v_required IN SELECT * FROM (VALUES
    ('clinic_dates', 'SELECT'), ('clinic_dates', 'INSERT'),
    ('appointments', 'SELECT'), ('appointments', 'INSERT'),
    ('submission_keys', 'SELECT'), ('submission_keys', 'INSERT')
  ) AS expected(table_name, privilege_name) LOOP
    IF NOT pg_catalog.has_table_privilege(v_owner, pg_catalog.format('dental.%I', v_required.table_name), v_required.privilege_name) THEN
      RAISE EXCEPTION 'Required reservation table privilege is missing';
    END IF;
  END LOOP;
  FOR v_required IN SELECT * FROM (VALUES
    ('clinic_dates', 'date'), ('submission_keys', 'appointment_id'), ('submission_keys', 'result')
  ) AS expected(table_name, column_name) LOOP
    IF NOT pg_catalog.has_column_privilege(v_owner, pg_catalog.format('dental.%I', v_required.table_name), v_required.column_name, 'UPDATE') THEN
      RAISE EXCEPTION 'Required reservation column privilege is missing';
    END IF;
  END LOOP;
  IF EXISTS (
    WITH expected(table_name, policy_name, command, using_expression, check_expression) AS (VALUES
      ('accounts', 'accounts_function_read', 'r', 'true', NULL::text),
      ('patients', 'patients_function_read', 'r', 'true', NULL::text),
      ('patients', 'patients_function_insert', 'a', NULL::text, 'true'),
      ('patients', 'patients_function_update', 'w', 'true', 'true'),
      ('audit_events', 'audit_function_insert', 'a', NULL::text, 'true'),
      ('clinic_dates', 'dates_function_read', 'r', 'true', NULL::text),
      ('clinic_dates', 'dates_function_insert', 'a', NULL::text, 'true'),
      ('clinic_dates', 'dates_function_lock', 'w', 'true', 'true'),
      ('appointments', 'appointments_function_read', 'r', 'true', NULL::text),
      ('appointments', 'appointments_function_insert', 'a', NULL::text, 'true'),
      ('submission_keys', 'submissions_function_read', 'r', 'true', NULL::text),
      ('submission_keys', 'submissions_function_insert', 'a', NULL::text, 'true'),
      ('submission_keys', 'submissions_function_update', 'w', 'true', 'true')
    ), actual AS (
      SELECT t.relname, p.polname, p.polcmd, p.polroles, p.polpermissive,
        pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS using_expression,
        pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS check_expression
      FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class t ON t.oid = p.polrelid
      WHERE t.relnamespace = v_schema
    )
    SELECT FROM expected e FULL JOIN actual a ON a.relname = e.table_name AND a.polname = e.policy_name
    WHERE a.relname IS NULL OR e.table_name IS NULL
      OR a.polcmd::text IS DISTINCT FROM e.command OR a.polroles IS DISTINCT FROM ARRAY[v_owner]
      OR a.polpermissive IS DISTINCT FROM true
      OR a.using_expression IS DISTINCT FROM e.using_expression
      OR a.check_expression IS DISTINCT FROM e.check_expression
  ) THEN
    RAISE EXCEPTION 'Unexpected private RLS policy definition';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc WHERE pronamespace = v_schema) <> 13 THEN
    RAISE EXCEPTION 'Private function set is incomplete';
  END IF;
  FOR v_function IN SELECT * FROM pg_catalog.pg_proc WHERE pronamespace = v_schema LOOP
    IF v_function.proowner <> v_owner OR NOT COALESCE(v_function.proconfig @> ARRAY['search_path=""'], false)
      OR v_function.prosecdef IS DISTINCT FROM (v_function.oid = ANY(v_entry_points)) THEN
      RAISE EXCEPTION 'Private function ownership, search path or security mode is incorrect';
    END IF;
    IF pg_catalog.has_function_privilege(v_backend, v_function.oid, 'EXECUTE') IS DISTINCT FROM (v_function.oid = ANY(v_entry_points))
      OR pg_catalog.has_function_privilege(v_postgres, v_function.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'Private function execution exceeds the reviewed surface';
    END IF;
    IF EXISTS (
      SELECT FROM pg_catalog.aclexplode(COALESCE(v_function.proacl, pg_catalog.acldefault('f', v_owner))) a
      WHERE a.grantee <> v_owner AND NOT (
        a.grantee = v_backend AND a.grantor = v_owner AND a.privilege_type = 'EXECUTE'
        AND NOT a.is_grantable AND v_function.oid = ANY(v_entry_points)
      )
    ) THEN
      RAISE EXCEPTION 'Unexpected private function ACL';
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT FROM pg_catalog.pg_default_acl d WHERE d.defaclrole = v_owner AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f'
  ) OR EXISTS (
    SELECT FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
    WHERE d.defaclrole = v_owner AND a.grantee <> v_owner
  ) THEN
    RAISE EXCEPTION 'Function-owner default privileges are unsafe';
  END IF;
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated', 'authenticator', 'service_role'] LOOP
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = v_role) THEN
      IF pg_catalog.pg_has_role(v_role, 'dental_backend', 'MEMBER')
        OR pg_catalog.pg_has_role(v_role, 'dental_function_owner', 'MEMBER')
        OR pg_catalog.has_schema_privilege(v_role, v_schema, 'USAGE, CREATE') THEN
        RAISE EXCEPTION 'Browser/platform role has a private schema or membership path';
      END IF;
      IF EXISTS (
        SELECT FROM pg_catalog.pg_class t WHERE t.relnamespace = v_schema AND t.relkind = 'r'
          AND (pg_catalog.has_table_privilege(v_role, t.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
            OR pg_catalog.has_any_column_privilege(v_role, t.oid, 'SELECT, INSERT, UPDATE, REFERENCES'))
      ) OR EXISTS (
        SELECT FROM pg_catalog.pg_proc p WHERE p.pronamespace = v_schema
          AND pg_catalog.has_function_privilege(v_role, p.oid, 'EXECUTE')
      ) THEN
        RAISE EXCEPTION 'Browser/platform role has private table or function access';
      END IF;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT FROM pg_catalog.pg_trigger
    WHERE tgrelid = 'dental.appointments'::pg_catalog.regclass
      AND tgname = 'appointments_preserve_snapshot' AND tgenabled = 'O'
      AND tgfoid = 'dental._protect_appointment_snapshot()'::pg_catalog.regprocedure
  ) OR NOT EXISTS (
    SELECT FROM pg_catalog.pg_constraint WHERE conrelid = 'dental.appointments'::pg_catalog.regclass
      AND conname = 'appointments_valid_patient_snapshot' AND convalidated
  ) THEN
    RAISE EXCEPTION 'Appointment snapshot protections are incomplete';
  END IF;
END;
$task4_final_audit$;
-- The enclosing atomic DO finishes only after the definitions and this audit;
-- transaction ownership stays with the supported migration route.
END;
$task4$;
