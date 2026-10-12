-- UNVERIFIED managed-Supabase candidate, Task 3, fragment 2 of 2.
-- Requires fragment 1 in the SAME transaction. Only the assembled bundle may
-- be applied after exact-project security approval. Actor UUIDs must come from
-- future verified server sessions, never client JSON, headers or decoded claims.
DO $fragment_guard$
BEGIN
  IF CURRENT_USER <> 'postgres' OR SESSION_USER <> 'postgres'
    OR pg_catalog.current_setting('dental.migration_bundle', true) IS DISTINCT FROM 'task3-managed-v1'
    OR pg_catalog.current_setting('dental.migration_role_baseline', true) IS NULL
    OR pg_catalog.current_setting('dental.migration_postgres_defaults', true) IS NULL THEN
    RAISE EXCEPTION 'Apply only the complete atomic Task 3 migration bundle';
  END IF;
END;
$fragment_guard$;

SET LOCAL ROLE dental_function_owner;
CREATE FUNCTION dental._normalize_patient_input(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_name text;
  v_phone text;
  v_address text;
  v_age numeric;
  v_whitespace constant text := U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
BEGIN
  IF p_input IS NULL OR pg_catalog.jsonb_typeof(p_input) <> 'object' THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VALIDATION';
  END IF;
  IF NOT (p_input ?& ARRAY['fullName', 'phone', 'age', 'address', 'relationship', 'authorizationAcknowledged'])
    OR EXISTS (
      SELECT FROM pg_catalog.jsonb_object_keys(p_input) AS keys(key)
      WHERE keys.key <> ALL (ARRAY['fullName', 'phone', 'age', 'address', 'relationship', 'authorizationAcknowledged'])
    )
    OR pg_catalog.jsonb_typeof(p_input -> 'fullName') <> 'string'
    OR pg_catalog.jsonb_typeof(p_input -> 'phone') <> 'string'
    OR pg_catalog.jsonb_typeof(p_input -> 'address') <> 'string'
    OR pg_catalog.jsonb_typeof(p_input -> 'relationship') <> 'string'
    OR pg_catalog.jsonb_typeof(p_input -> 'age') <> 'number'
    OR p_input -> 'authorizationAcknowledged' IS DISTINCT FROM 'true'::jsonb
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VALIDATION';
  END IF;
  v_name := pg_catalog.btrim(p_input ->> 'fullName', v_whitespace);
  v_phone := pg_catalog.btrim(p_input ->> 'phone', v_whitespace);
  v_address := pg_catalog.btrim(p_input ->> 'address', v_whitespace);
  v_age := (p_input ->> 'age')::numeric;
  IF pg_catalog.char_length(v_name) NOT BETWEEN 1 AND 120
    OR pg_catalog.char_length(v_phone) NOT BETWEEN 7 AND 30
    OR v_phone !~ ('^\+?[0-9().' || v_whitespace || '-]+$') OR v_phone !~ '[0-9]'
    OR pg_catalog.char_length(v_address) NOT BETWEEN 1 AND 500
    OR v_age NOT BETWEEN 0 AND 150 OR v_age <> pg_catalog.trunc(v_age)
    OR p_input ->> 'relationship' NOT IN ('self', 'parent', 'guardian', 'family')
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VALIDATION';
  END IF;
  RETURN pg_catalog.jsonb_build_object(
    'fullName', v_name, 'phone', v_phone, 'age', v_age::integer,
    'address', v_address, 'relationship', p_input ->> 'relationship',
    'authorizationAcknowledged', true
  );
END;
$$;

CREATE FUNCTION dental._patient_json(p_patient dental.patients)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'id', (p_patient).id, 'fullName', (p_patient).full_name, 'phone', (p_patient).phone,
    'age', (p_patient).age, 'address', (p_patient).address,
    'relationship', (p_patient).relationship,
    'authorizationAcknowledged', (p_patient).authorization_acknowledged,
    'ageCapturedOn', pg_catalog.to_char((p_patient).age_captured_on::timestamp without time zone, 'YYYY-MM-DD'),
    'version', (p_patient).version
  )
$$;

CREATE FUNCTION dental.list_patients(p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_result jsonb;
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (SELECT FROM dental.accounts a WHERE a.id = p_actor) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'UNAUTHENTICATED';
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(dental._patient_json(p) ORDER BY p.created_at, p.id), '[]'::jsonb)
    INTO v_result FROM dental.patients p WHERE p.owner_account_id = p_actor;
  RETURN v_result;
END;
$$;

CREATE FUNCTION dental.create_patient(p_actor uuid, p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_input jsonb;
  v_patient dental.patients%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (SELECT FROM dental.accounts a WHERE a.id = p_actor) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'UNAUTHENTICATED';
  END IF;
  v_input := dental._normalize_patient_input(p_input);
  v_now := dental.clock_now();
  INSERT INTO dental.patients (
    owner_account_id, full_name, phone, age, address, relationship,
    authorization_acknowledged, age_captured_on, created_at, updated_at
  ) VALUES (
    p_actor, v_input ->> 'fullName', v_input ->> 'phone', (v_input ->> 'age')::integer,
    v_input ->> 'address', v_input ->> 'relationship', true,
    (pg_catalog.timezone('Asia/Bangkok', v_now))::date, v_now, v_now
  ) RETURNING * INTO v_patient;
  INSERT INTO dental.audit_events(actor_account_id, action, patient_id, occurred_at)
    VALUES (p_actor, 'patient_created', v_patient.id, v_now);
  RETURN dental._patient_json(v_patient);
END;
$$;

CREATE FUNCTION dental.update_patient(p_actor uuid, p_id uuid, p_version integer, p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_input jsonb;
  v_patient dental.patients%ROWTYPE;
  v_now timestamptz;
BEGIN
  IF p_actor IS NULL OR NOT EXISTS (SELECT FROM dental.accounts a WHERE a.id = p_actor) THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'UNAUTHENTICATED';
  END IF;
  -- Check ownership in the row lookup before validation/version errors, so a
  -- foreign identifier and a missing identifier have the same safe response.
  SELECT p.* INTO v_patient FROM dental.patients p
    WHERE p.id = p_id AND p.owner_account_id = p_actor FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'NOT_FOUND';
  END IF;
  IF p_version IS NULL OR p_version < 1 THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VALIDATION';
  END IF;
  IF v_patient.version <> p_version THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'VERSION_CONFLICT';
  END IF;
  v_input := dental._normalize_patient_input(p_input);
  -- Actual time after the row lock, not transaction-start time.
  v_now := dental.clock_now();
  UPDATE dental.patients AS p SET
    full_name = v_input ->> 'fullName', phone = v_input ->> 'phone',
    age = (v_input ->> 'age')::integer, address = v_input ->> 'address',
    relationship = v_input ->> 'relationship', authorization_acknowledged = true,
    age_captured_on = (pg_catalog.timezone('Asia/Bangkok', v_now))::date,
    version = p.version + 1, updated_at = v_now
    WHERE p.id = p_id AND p.owner_account_id = p_actor RETURNING p.* INTO v_patient;
  INSERT INTO dental.audit_events(actor_account_id, action, patient_id, occurred_at)
    VALUES (p_actor, 'patient_updated', v_patient.id, v_now);
  RETURN dental._patient_json(v_patient);
END;
$$;

CREATE FUNCTION dental._protect_appointment_snapshot()
RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  -- MVP has no account transfer, automatic rescheduling or historical snapshot
  -- rewriting. Later status transitions can update status/version/timestamps.
  IF ROW(NEW.id, NEW.reference, NEW.owner_account_id, NEW.patient_id,
    NEW.patient_version, NEW.patient_snapshot, NEW.age_captured_on, NEW.service,
    NEW.date, NEW.idempotency_key, NEW.created_at)
    IS DISTINCT FROM
    ROW(OLD.id, OLD.reference, OLD.owner_account_id, OLD.patient_id,
    OLD.patient_version, OLD.patient_snapshot, OLD.age_captured_on, OLD.service,
    OLD.date, OLD.idempotency_key, OLD.created_at)
  THEN
    RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'INVALID_TRANSITION';
  END IF;
  RETURN NEW;
END;
$$;

-- Creating the trigger as table owner still requires function EXECUTE; defining
-- and validating the CHECK expression may also require its helper privilege.
GRANT EXECUTE ON FUNCTION dental._protect_appointment_snapshot() TO postgres;
GRANT EXECUTE ON FUNCTION dental._normalize_patient_input(jsonb) TO postgres;
RESET ROLE;
CREATE TRIGGER appointments_preserve_snapshot BEFORE UPDATE ON dental.appointments
  FOR EACH ROW EXECUTE FUNCTION dental._protect_appointment_snapshot();
ALTER TABLE dental.appointments ADD CONSTRAINT appointments_valid_patient_snapshot
  CHECK (dental._normalize_patient_input(patient_snapshot) = patient_snapshot);

SET LOCAL ROLE dental_function_owner;
REVOKE EXECUTE ON FUNCTION dental.clock_now() FROM postgres;
REVOKE EXECUTE ON FUNCTION dental._protect_appointment_snapshot() FROM postgres;
REVOKE EXECUTE ON FUNCTION dental._normalize_patient_input(jsonb) FROM postgres;
-- Remove every actual non-owner function grantee, including direct platform
-- grants. Helpers are owner-only; exactly three entry points are regranted.
DO $function_acl$
DECLARE v_grantee record;
BEGIN
  REVOKE ALL ON ALL FUNCTIONS IN SCHEMA dental FROM PUBLIC;
  FOR v_grantee IN
    SELECT DISTINCT r.rolname FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
    JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
    WHERE n.nspname = 'dental' AND a.grantee <> p.proowner
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA dental FROM %I', v_grantee.rolname);
  END LOOP;
END;
$function_acl$;
GRANT EXECUTE ON FUNCTION dental.list_patients(uuid) TO dental_backend;
GRANT EXECUTE ON FUNCTION dental.create_patient(uuid, jsonb) TO dental_backend;
GRANT EXECUTE ON FUNCTION dental.update_patient(uuid, uuid, integer, jsonb) TO dental_backend;
RESET ROLE;
REVOKE CREATE ON SCHEMA dental FROM dental_function_owner;

DO $membership_cleanup$
BEGIN
  IF pg_catalog.current_setting('server_version_num')::integer / 10000 = 17 THEN
    -- Revoke ONLY our temporary SET-only grant. Never attempt to remove or
    -- change the bootstrap-granted postgres ADMIN baseline on either role.
    EXECUTE 'REVOKE dental_function_owner FROM postgres GRANTED BY postgres';
  ELSE
    REVOKE dental_function_owner FROM postgres;
  END IF;
END;
$membership_cleanup$;

-- All checks raise ordinary exceptions, not disableable ASSERT statements.
-- Any mismatch aborts the assembler's complete atomic DO statement.
DO $final_audit$
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
  v_entry_points oid[] := ARRAY[
    'dental.list_patients(uuid)'::pg_catalog.regprocedure::oid,
    'dental.create_patient(uuid,jsonb)'::pg_catalog.regprocedure::oid,
    'dental.update_patient(uuid,uuid,integer,jsonb)'::pg_catalog.regprocedure::oid
  ];
BEGIN
  IF CURRENT_USER <> 'postgres' OR SESSION_USER <> 'postgres'
    OR pg_catalog.current_setting('dental.migration_bundle', true) IS DISTINCT FROM 'task3-managed-v1' THEN
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
  IF v_memberships IS DISTINCT FROM pg_catalog.current_setting('dental.migration_role_baseline')::jsonb THEN
    RAISE EXCEPTION 'Temporary membership cleanup did not preserve only the approved baseline';
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.oid), '[]'::jsonb)
    INTO v_defaults FROM pg_catalog.pg_default_acl d WHERE d.defaclrole = v_postgres;
  IF v_defaults IS DISTINCT FROM pg_catalog.current_setting('dental.migration_postgres_defaults')::jsonb THEN
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
          OR (v_table.relname = 'patients' AND a.privilege_type IN ('SELECT', 'INSERT'))
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
      AND t.relname = 'patients' AND a.privilege_type = 'UPDATE'
      AND c.attname IN ('full_name', 'phone', 'age', 'address', 'relationship', 'authorization_acknowledged', 'age_captured_on', 'version', 'updated_at')
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
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class t ON t.oid = p.polrelid WHERE t.relnamespace = v_schema) <> 5
    OR EXISTS (
      SELECT FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class t ON t.oid = p.polrelid
      WHERE t.relnamespace = v_schema AND (p.polroles <> ARRAY[v_owner] OR NOT p.polpermissive)
    ) THEN
    RAISE EXCEPTION 'Unexpected private RLS policy audience';
  END IF;
  IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc WHERE pronamespace = v_schema) <> 7 THEN
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
$final_audit$;
-- The enclosing atomic DO finishes only after both fragments and this audit;
-- transaction ownership stays with the supported migration route.
