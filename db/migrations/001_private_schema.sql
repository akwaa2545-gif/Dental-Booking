-- UNVERIFIED managed-Supabase candidate, Task 3, fragment 1 of 2.
-- Never apply separately. The reviewed assembler executes both fragments in ONE
-- invoker DO statement with dental.migration_bundle='task3-managed-v1'. The marker
-- is a misuse guard, not authorization or proof of atomicity. Exceptions propagate
-- through the atomic statement. No transaction control belongs in these fragments.
-- No LOGIN roles, passwords or runtime grants.

DO $preflight$
DECLARE
  v_major integer := pg_catalog.current_setting('server_version_num')::integer / 10000;
  v_operator pg_catalog.pg_roles%ROWTYPE;
  v_defaults jsonb;
BEGIN
  IF pg_catalog.current_setting('dental.migration_bundle', true) IS DISTINCT FROM 'task3-managed-v1' THEN
    RAISE EXCEPTION 'Apply only the complete atomic Task 3 migration bundle';
  END IF;
  IF CURRENT_USER <> 'postgres' OR SESSION_USER <> 'postgres' THEN
    RAISE EXCEPTION 'Managed migration requires current and session role postgres';
  END IF;
  SELECT * INTO v_operator FROM pg_catalog.pg_roles WHERE rolname = CURRENT_USER;
  IF NOT v_operator.rolcreaterole OR v_operator.rolsuper THEN
    RAISE EXCEPTION 'Managed migration requires non-superuser postgres with CREATEROLE';
  END IF;
  IF pg_catalog.current_setting('transaction_read_only') <> 'off'
    OR NOT pg_catalog.has_database_privilege(CURRENT_USER, pg_catalog.current_database(), 'CREATE') THEN
    RAISE EXCEPTION 'Managed migration requires a writable database and schema CREATE capability';
  END IF;
  IF v_major NOT IN (15, 17) THEN
    RAISE EXCEPTION 'PostgreSQL version needs compatibility review before this migration';
  END IF;
  IF v_major = 17 AND pg_catalog.current_setting('createrole_self_grant', true) IS DISTINCT FROM '' THEN
    RAISE EXCEPTION 'Nonempty createrole_self_grant requires separate review';
  END IF;
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname IN ('dental_function_owner', 'dental_backend'))
    OR EXISTS (SELECT FROM pg_catalog.pg_namespace WHERE nspname = 'dental') THEN
    RAISE EXCEPTION 'Dental roles or schema already exist; inspect instead of reusing them';
  END IF;
  -- A null session setting cannot prove the project's exposed-schema setting.
  -- The actual API configuration must also be verified outside this migration.
  IF EXISTS (
    SELECT FROM pg_catalog.regexp_split_to_table(
      COALESCE(pg_catalog.current_setting('pgrst.db_schemas', true), ''), ','
    ) AS s(name) WHERE pg_catalog.btrim(s.name, ' "') = 'dental'
  ) THEN
    RAISE EXCEPTION 'Dental must not be an API-exposed schema';
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.oid), '[]'::jsonb)
    INTO v_defaults FROM pg_catalog.pg_default_acl d WHERE d.defaclrole = v_operator.oid;
  PERFORM pg_catalog.set_config('dental.migration_postgres_defaults', v_defaults::text, true);
END;
$preflight$;

CREATE ROLE dental_function_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
CREATE ROLE dental_backend NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;

DO $roles$
DECLARE
  v_major integer := pg_catalog.current_setting('server_version_num')::integer / 10000;
  v_postgres oid := 'postgres'::pg_catalog.regrole;
  v_role_oids oid[] := ARRAY['dental_function_owner'::pg_catalog.regrole::oid, 'dental_backend'::pg_catalog.regrole::oid];
  v_baseline jsonb;
BEGIN
  IF EXISTS (SELECT FROM pg_catalog.pg_auth_members WHERE member = ANY(v_role_oids)) THEN
    RAISE EXCEPTION 'New dental roles must not belong to other roles';
  END IF;
  IF v_major = 15 THEN
    IF EXISTS (SELECT FROM pg_catalog.pg_auth_members WHERE roleid = ANY(v_role_oids)) THEN
      RAISE EXCEPTION 'Unexpected PostgreSQL 15 creator membership';
    END IF;
  ELSE
    -- PostgreSQL 17 automatically creates a bootstrap-superuser-granted ADMIN
    -- baseline for the non-superuser creator. It must survive our own cleanup.
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_auth_members WHERE roleid = ANY(v_role_oids)) <> 2
      OR EXISTS (
        SELECT FROM pg_catalog.pg_auth_members m
        JOIN pg_catalog.pg_roles g ON g.oid = m.grantor
        WHERE m.roleid = ANY(v_role_oids) AND (
          m.member <> v_postgres OR NOT m.admin_option OR NOT g.rolsuper
          OR pg_catalog.to_jsonb(m) ->> 'inherit_option' IS DISTINCT FROM 'false'
          OR pg_catalog.to_jsonb(m) ->> 'set_option' IS DISTINCT FROM 'false'
        )
      ) THEN
      RAISE EXCEPTION 'Unexpected PostgreSQL 17 creator-admin baseline';
    END IF;
  END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY m.roleid, m.member, m.grantor), '[]'::jsonb)
    INTO v_baseline FROM pg_catalog.pg_auth_members m WHERE m.roleid = ANY(v_role_oids);
  PERFORM pg_catalog.set_config('dental.migration_role_baseline', v_baseline::text, true);
  IF v_major = 17 THEN
    EXECUTE 'GRANT dental_function_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres';
  ELSE
    -- PG15 has no per-membership SET/INHERIT options. This entirely new grant is
    -- temporary, without ADMIN OPTION, and is revoked before the outer commit.
    GRANT dental_function_owner TO postgres;
  END IF;
END;
$roles$;

CREATE SCHEMA dental AUTHORIZATION postgres;
-- Sanitize this new schema's actual ACL, including unexpected default grantees,
-- without altering postgres's defaults for any current or future schema.
DO $schema_acl$
DECLARE v_grantee record;
BEGIN
  REVOKE ALL ON SCHEMA dental FROM PUBLIC;
  FOR v_grantee IN
    SELECT DISTINCT r.rolname FROM pg_catalog.pg_namespace n
    CROSS JOIN LATERAL pg_catalog.aclexplode(n.nspacl) a
    JOIN pg_catalog.pg_roles r ON r.oid = a.grantee
    WHERE n.nspname = 'dental' AND a.grantee <> n.nspowner
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON SCHEMA dental FROM %I', v_grantee.rolname);
  END LOOP;
END;
$schema_acl$;
GRANT USAGE ON SCHEMA dental TO dental_function_owner, dental_backend;
GRANT CREATE ON SCHEMA dental TO dental_function_owner;

SET LOCAL ROLE dental_function_owner;
-- Only this NEW role's global defaults change. Per-schema REVOKE alone cannot
-- subtract PostgreSQL's global PUBLIC function EXECUTE default.
ALTER DEFAULT PRIVILEGES FOR ROLE dental_function_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE FUNCTION dental.clock_now()
RETURNS timestamptz
LANGUAGE sql VOLATILE SECURITY INVOKER
SET search_path = ''
AS $$ SELECT pg_catalog.clock_timestamp() $$;
-- Temporary operator access for defining/evaluating private default expressions.
GRANT EXECUTE ON FUNCTION dental.clock_now() TO postgres;
RESET ROLE;

CREATE TABLE dental.accounts (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  provider text NOT NULL CHECK (pg_catalog.char_length(provider) BETWEEN 1 AND 120),
  subject text NOT NULL CHECK (pg_catalog.char_length(subject) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT dental.clock_now(),
  CONSTRAINT accounts_verified_identity UNIQUE (provider, subject)
);
CREATE TABLE dental.sessions (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES dental.accounts(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  csrf_hash text NOT NULL CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT dental.clock_now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  CHECK (expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX sessions_account ON dental.sessions(account_id);
CREATE INDEX sessions_active_expiry ON dental.sessions(expires_at) WHERE revoked_at IS NULL;

CREATE TABLE dental.patients (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  owner_account_id uuid NOT NULL REFERENCES dental.accounts(id),
  full_name text NOT NULL CHECK (pg_catalog.char_length(full_name) BETWEEN 1 AND 120),
  phone text NOT NULL CHECK (
    pg_catalog.char_length(phone) BETWEEN 7 AND 30 AND phone ~ '[0-9]'
    AND phone ~ ('^\+?[0-9().' || U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF' || '-]+$')
  ),
  age integer NOT NULL CHECK (age BETWEEN 0 AND 150),
  address text NOT NULL CHECK (pg_catalog.char_length(address) BETWEEN 1 AND 500),
  relationship text NOT NULL CHECK (relationship IN ('self', 'parent', 'guardian', 'family')),
  authorization_acknowledged boolean NOT NULL CHECK (authorization_acknowledged),
  age_captured_on date NOT NULL DEFAULT (pg_catalog.timezone('Asia/Bangkok', dental.clock_now()))::date,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT dental.clock_now(),
  updated_at timestamptz NOT NULL DEFAULT dental.clock_now(),
  CONSTRAINT patients_id_owner UNIQUE (id, owner_account_id)
);
CREATE INDEX patients_owner ON dental.patients(owner_account_id, created_at, id);

CREATE TABLE dental.clinic_dates (
  date date PRIMARY KEY,
  intake text NOT NULL DEFAULT 'open' CHECK (intake IN ('open', 'paused', 'closed')),
  reason text CHECK (reason IS NULL OR pg_catalog.char_length(reason) BETWEEN 1 AND 500),
  changed_by uuid REFERENCES dental.accounts(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT dental.clock_now(),
  updated_at timestamptz NOT NULL DEFAULT dental.clock_now()
);
CREATE INDEX clinic_dates_changed_by ON dental.clinic_dates(changed_by) WHERE changed_by IS NOT NULL;

CREATE TABLE dental.appointments (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  reference text NOT NULL UNIQUE DEFAULT ('D-' || pg_catalog.replace(pg_catalog.gen_random_uuid()::text, '-', '')),
  owner_account_id uuid NOT NULL REFERENCES dental.accounts(id),
  patient_id uuid NOT NULL,
  patient_version integer NOT NULL CHECK (patient_version > 0),
  patient_snapshot jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(patient_snapshot) = 'object'),
  age_captured_on date NOT NULL,
  service text NOT NULL CHECK (service IN ('oral_check', 'scaling', 'filling')),
  date date NOT NULL REFERENCES dental.clinic_dates(date),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'completed', 'no_show')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT dental.clock_now(),
  updated_at timestamptz NOT NULL DEFAULT dental.clock_now(),
  approved_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES dental.accounts(id),
  CONSTRAINT appointments_owned_patient FOREIGN KEY (patient_id, owner_account_id) REFERENCES dental.patients(id, owner_account_id),
  CONSTRAINT appointments_id_owner UNIQUE (id, owner_account_id),
  CONSTRAINT appointments_submission_unique UNIQUE (owner_account_id, idempotency_key),
  CHECK (pg_catalog.char_length(reference) BETWEEN 1 AND 80),
  CHECK (status NOT IN ('approved', 'completed', 'no_show') OR approved_at IS NOT NULL),
  CHECK (status NOT IN ('pending', 'rejected') OR approved_at IS NULL),
  CHECK ((cancelled_at IS NULL) = (cancelled_by IS NULL))
);
CREATE UNIQUE INDEX appointments_one_active_patient_date ON dental.appointments(patient_id, date) WHERE status IN ('pending', 'approved');
CREATE INDEX appointments_active_date ON dental.appointments(date) WHERE status IN ('pending', 'approved');
CREATE INDEX appointments_owner ON dental.appointments(owner_account_id, created_at DESC, id);
CREATE INDEX appointments_patient_owner ON dental.appointments(patient_id, owner_account_id);
CREATE INDEX appointments_date_status ON dental.appointments(date, status, created_at);
CREATE INDEX appointments_cancelled_by ON dental.appointments(cancelled_by) WHERE cancelled_by IS NOT NULL;

-- Task 4 must serialize account/key before the date lock, atomically persisting
-- the original response. These records alone do not implement reservations.
CREATE TABLE dental.submission_keys (
  owner_account_id uuid NOT NULL REFERENCES dental.accounts(id),
  key uuid NOT NULL,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  appointment_id uuid,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT dental.clock_now(),
  PRIMARY KEY (owner_account_id, key),
  FOREIGN KEY (appointment_id, owner_account_id) REFERENCES dental.appointments(id, owner_account_id),
  CHECK ((appointment_id IS NULL) = (result IS NULL)),
  CHECK (result IS NULL OR pg_catalog.jsonb_typeof(result) = 'object')
);
CREATE INDEX submission_keys_appointment ON dental.submission_keys(appointment_id) WHERE appointment_id IS NOT NULL;

CREATE TABLE dental.admin_grants (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES dental.accounts(id),
  granted_at timestamptz NOT NULL DEFAULT dental.clock_now(),
  granted_by uuid REFERENCES dental.accounts(id),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES dental.accounts(id),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at),
  CHECK (revoked_at IS NOT NULL OR revoked_by IS NULL)
);
CREATE UNIQUE INDEX admin_grants_one_live_grant ON dental.admin_grants(account_id) WHERE revoked_at IS NULL;
CREATE INDEX admin_grants_account ON dental.admin_grants(account_id);
CREATE INDEX admin_grants_granted_by ON dental.admin_grants(granted_by) WHERE granted_by IS NOT NULL;
CREATE INDEX admin_grants_revoked_by ON dental.admin_grants(revoked_by) WHERE revoked_by IS NOT NULL;

-- Scoped actions only: no request bodies, raw tokens or copies of patient data.
CREATE TABLE dental.audit_events (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  actor_account_id uuid NOT NULL REFERENCES dental.accounts(id),
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]{0,79}$'),
  patient_id uuid REFERENCES dental.patients(id),
  appointment_id uuid REFERENCES dental.appointments(id),
  clinic_date date REFERENCES dental.clinic_dates(date),
  reason text CHECK (reason IS NULL OR pg_catalog.char_length(reason) BETWEEN 1 AND 500),
  occurred_at timestamptz NOT NULL DEFAULT dental.clock_now()
);
CREATE INDEX audit_events_actor ON dental.audit_events(actor_account_id, occurred_at);
CREATE INDEX audit_events_patient ON dental.audit_events(patient_id) WHERE patient_id IS NOT NULL;
CREATE INDEX audit_events_appointment ON dental.audit_events(appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX audit_events_date ON dental.audit_events(clinic_date) WHERE clinic_date IS NOT NULL;

-- No arbitrary notification payload. Task 8 builds a minimal card only after
-- checking current eligibility under date -> appointment -> outbox locks.
CREATE TABLE dental.outbox (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES dental.appointments(id),
  appointment_version integer NOT NULL CHECK (appointment_version > 0),
  type text NOT NULL CHECK (type IN ('approval', 'rejection', 'reminder')),
  retry_key uuid NOT NULL UNIQUE DEFAULT pg_catalog.gen_random_uuid(),
  due_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'leased', 'retry', 'accepted', 'suppressed', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 6),
  lease_owner uuid,
  lease_until timestamptz,
  first_attempt_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT dental.clock_now(),
  updated_at timestamptz NOT NULL DEFAULT dental.clock_now(),
  UNIQUE (appointment_id, appointment_version, type),
  CHECK (expires_at > due_at),
  CHECK ((state = 'leased') = (lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL)),
  CHECK (accepted_at IS NULL OR state = 'accepted')
);
CREATE INDEX outbox_due ON dental.outbox(due_at, id) WHERE state IN ('queued', 'retry');
CREATE INDEX outbox_expired_lease ON dental.outbox(lease_until, id) WHERE state = 'leased';
CREATE TABLE dental.notification_attempts (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  outbox_id uuid NOT NULL REFERENCES dental.outbox(id),
  attempt_number integer NOT NULL CHECK (attempt_number BETWEEN 1 AND 6),
  worker_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT dental.clock_now(),
  finished_at timestamptz,
  result text CHECK (result IN ('accepted', 'retryable', 'permanent')),
  provider_request_id text CHECK (provider_request_id IS NULL OR pg_catalog.char_length(provider_request_id) BETWEEN 1 AND 128),
  error_category text CHECK (error_category IS NULL OR error_category IN ('timeout', 'transport', 'server_error', 'quota', 'rate_limited', 'recipient_unavailable', 'invalid_request', 'unauthorized', 'forbidden', 'unknown')),
  UNIQUE (outbox_id, attempt_number),
  CHECK (finished_at IS NULL OR finished_at >= started_at),
  CHECK ((finished_at IS NULL) = (result IS NULL))
);

-- Sanitize actual new table ACLs, not postgres-wide defaults. No browser role
-- is authorized through RLS, including platform roles that bypass RLS itself.
DO $table_security$
DECLARE
  v_table record;
  v_grantee record;
BEGIN
  FOR v_table IN SELECT c.oid, c.relname, c.relowner, c.relacl
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'dental' AND c.relkind = 'r'
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE dental.%I ENABLE ROW LEVEL SECURITY', v_table.relname);
    EXECUTE pg_catalog.format('ALTER TABLE dental.%I FORCE ROW LEVEL SECURITY', v_table.relname);
    EXECUTE pg_catalog.format('REVOKE ALL ON TABLE dental.%I FROM PUBLIC', v_table.relname);
    FOR v_grantee IN SELECT DISTINCT r.rolname FROM pg_catalog.aclexplode(v_table.relacl) a
      JOIN pg_catalog.pg_roles r ON r.oid = a.grantee WHERE a.grantee <> v_table.relowner
    LOOP
      EXECUTE pg_catalog.format('REVOKE ALL ON TABLE dental.%I FROM %I', v_table.relname, v_grantee.rolname);
    END LOOP;
  END LOOP;
END;
$table_security$;
GRANT SELECT ON dental.accounts TO dental_function_owner;
GRANT SELECT, INSERT ON dental.patients TO dental_function_owner;
GRANT UPDATE (full_name, phone, age, address, relationship, authorization_acknowledged, age_captured_on, version, updated_at) ON dental.patients TO dental_function_owner;
GRANT INSERT ON dental.audit_events TO dental_function_owner;
CREATE POLICY accounts_function_read ON dental.accounts FOR SELECT TO dental_function_owner USING (true);
CREATE POLICY patients_function_read ON dental.patients FOR SELECT TO dental_function_owner USING (true);
CREATE POLICY patients_function_insert ON dental.patients FOR INSERT TO dental_function_owner WITH CHECK (true);
CREATE POLICY patients_function_update ON dental.patients FOR UPDATE TO dental_function_owner USING (true) WITH CHECK (true);
CREATE POLICY audit_function_insert ON dental.audit_events FOR INSERT TO dental_function_owner WITH CHECK (true);
-- Fragment 2 immediately follows in the SAME transaction and revokes the
-- temporary schema CREATE, helper EXECUTE and operator SET-role privileges.
