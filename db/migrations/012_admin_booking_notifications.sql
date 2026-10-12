-- UNEXECUTED candidate; local synthetic validation is not permission for hosted migration, access, configuration or LINE sends.
-- Atomic PG17 baseline 011 extension; disabled by default, no historical backfill.
DO $admin_booking$
DECLARE
 v_major integer := pg_catalog.current_setting('server_version_num')::integer / 10000;
 v_owner oid := 'dental_function_owner'::pg_catalog.regrole;
 v_backend oid := 'dental_backend'::pg_catalog.regrole;
 v_runtime oid := 'dental_runtime'::pg_catalog.regrole;
 v_postgres oid := 'postgres'::pg_catalog.regrole;
 v_schema oid := 'dental'::pg_catalog.regnamespace;
 v_memberships jsonb; v_memberships_after jsonb; v_defaults jsonb; v_defaults_after jsonb;
 v_existing_functions jsonb; v_existing_functions_after jsonb;
 v_roles jsonb; v_roles_after jsonb; v_role_settings jsonb; v_role_settings_after jsonb;
 v_normalized_memberships jsonb;
 v_expected_memberships jsonb := '[
  {"role":"dental_backend","member":"dental_runtime","grantor":"postgres","admin":false,"inherit":true,"set":false},
  {"role":"dental_backend","member":"postgres","grantor":"supabase_admin","admin":true,"inherit":false,"set":false},
  {"role":"dental_function_owner","member":"postgres","grantor":"supabase_admin","admin":true,"inherit":false,"set":false},
  {"role":"dental_runtime","member":"postgres","grantor":"supabase_admin","admin":true,"inherit":false,"set":false}
 ]'::jsonb;
 v_original_lock_timeout text := pg_catalog.current_setting('lock_timeout');
 v_function record; v_table record; v_role text;
 v_prepare oid; v_decide oid;
 v_decide_before text; v_decide_after text; v_decide_source text;
 v_prepare_before text; v_prepare_after text; v_prepare_source text;
 v_type_before text; v_envelope_before text;
 v_type_after text; v_envelope_after text;
 v_catalog jsonb; v_catalog_after jsonb;
 v_old_tables oid[]; v_reserve oid; v_reserve_source text; v_reserve_definition text; v_expected_reserve text;
 v_object text; v_grantee record;
 v_admin_read oid; v_admin_source text; v_admin_definition text; v_expected_admin text;

BEGIN
 -- A statement timer must already be running when this DO starts; setting it
 -- inside an executing DO is not a substitute. The whole migration is capped.
 IF (SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name = 'statement_timeout') NOT BETWEEN 1 AND 120000 THEN
  RAISE EXCEPTION 'Admin booking requires an inherited statement timeout between 1ms and 2min';
 END IF;
 IF CURRENT_USER<>'postgres' OR SESSION_USER<>'postgres' OR v_major<>17
  OR pg_catalog.current_setting('role')<>'none'
  OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
  OR pg_catalog.current_setting('transaction_read_only')<>'off'
  OR pg_catalog.to_regprocedure('dental.decide(uuid,uuid,integer,text,text)') IS NULL
  OR pg_catalog.to_regprocedure('dental.claim_events(uuid,integer)') IS NULL
  OR pg_catalog.to_regprocedure('dental.consume_request_limit(text,text)') IS NULL
  OR pg_catalog.to_regprocedure('dental.claim_restricted_event(uuid,uuid,uuid)') IS NULL
  OR pg_catalog.to_regprocedure('dental.prepare_restricted_dispatch(uuid,uuid,uuid,text)') IS NULL
  OR pg_catalog.to_regprocedure('dental._fence_restricted_attempt()') IS NULL
  OR pg_catalog.to_regclass('dental.restricted_dispatch_authorizations') IS NULL THEN
  RAISE EXCEPTION 'Admin booking requires the verified migration 010 managed baseline';
 END IF;
 -- No alternate/absent runtime path: this candidate is bound to the reviewed
 -- non-superuser operator and restricted LOGIN that already exists in staging.
 IF NOT EXISTS(SELECT FROM pg_catalog.pg_roles WHERE oid=v_postgres AND rolcreaterole AND rolbypassrls AND NOT rolsuper)
  OR NOT EXISTS(SELECT FROM pg_catalog.pg_roles g WHERE g.rolname='supabase_admin' AND g.rolsuper)
  OR EXISTS(SELECT FROM pg_catalog.pg_roles WHERE oid IN (v_owner,v_backend,v_runtime)
   AND (rolcanlogin IS DISTINCT FROM (oid=v_runtime) OR rolinherit IS DISTINCT FROM (oid=v_runtime)
    OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
    OR rolconnlimit<>-1 OR rolvaliduntil IS NOT NULL OR rolconfig IS NOT NULL))
  OR EXISTS(SELECT FROM pg_catalog.pg_db_role_setting WHERE setrole IN (v_owner,v_backend,v_runtime)) THEN
  RAISE EXCEPTION 'Unreviewed Admin booking private/runtime role attributes or role settings';
 END IF;
 SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r)-'rolpassword' ORDER BY r.oid)
  INTO v_roles FROM pg_catalog.pg_roles r WHERE r.oid IN (v_owner,v_backend,v_runtime);
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s) ORDER BY s.setdatabase,s.setrole),'[]'::jsonb)
  INTO v_role_settings FROM pg_catalog.pg_db_role_setting s WHERE s.setrole IN (v_owner,v_backend,v_runtime);
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY roleid,member,grantor),'[]'::jsonb)
  INTO v_memberships FROM pg_catalog.pg_auth_members m
  WHERE m.roleid IN (v_owner,v_backend,v_runtime) OR m.member IN (v_owner,v_backend,v_runtime);
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
   'role',r.rolname,'member',u.rolname,'grantor',g.rolname,
   'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option)
   ORDER BY r.rolname COLLATE "C",u.rolname COLLATE "C",g.rolname COLLATE "C"),'[]'::jsonb)
  INTO v_normalized_memberships FROM pg_catalog.pg_auth_members m
  JOIN pg_catalog.pg_roles r ON r.oid=m.roleid JOIN pg_catalog.pg_roles u ON u.oid=m.member
  JOIN pg_catalog.pg_roles g ON g.oid=m.grantor
  WHERE m.roleid IN (v_owner,v_backend,v_runtime) OR m.member IN (v_owner,v_backend,v_runtime);
 IF v_normalized_memberships IS DISTINCT FROM v_expected_memberships THEN
  RAISE EXCEPTION 'Unreviewed exact Admin booking runtime membership baseline';
 END IF;
 IF pg_catalog.pg_has_role(v_runtime,v_owner,'MEMBER')
  OR pg_catalog.has_schema_privilege(v_runtime,v_schema,'CREATE')
  OR NOT pg_catalog.has_schema_privilege(v_runtime,v_schema,'USAGE') THEN
  RAISE EXCEPTION 'Unsafe runtime owner membership or schema access';
 END IF;
 FOR v_table IN SELECT * FROM pg_catalog.pg_class WHERE relnamespace=v_schema AND relkind='r' LOOP
  IF pg_catalog.has_table_privilege(v_runtime,v_table.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
   OR pg_catalog.has_any_column_privilege(v_runtime,v_table.oid,'SELECT,INSERT,UPDATE,REFERENCES') THEN
   RAISE EXCEPTION 'Runtime has unreviewed direct private table or column access';
  END IF;
 END LOOP;
 FOR v_function IN SELECT * FROM pg_catalog.pg_proc WHERE pronamespace=v_schema LOOP
  IF pg_catalog.has_function_privilege(v_runtime,v_function.oid,'EXECUTE') IS DISTINCT FROM pg_catalog.has_function_privilege(v_backend,v_function.oid,'EXECUTE') THEN
   RAISE EXCEPTION 'Runtime function surface differs from inherited backend access';
  END IF;
  IF v_function.proowner<>v_owner OR v_function.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
   OR EXISTS(SELECT FROM pg_catalog.aclexplode(COALESCE(v_function.proacl,pg_catalog.acldefault('f',v_owner))) a
    WHERE a.grantee NOT IN(v_owner,v_backend,v_postgres) OR a.privilege_type<>'EXECUTE' OR a.is_grantable) THEN
   RAISE EXCEPTION 'Unreviewed private function owner, search path or execute privilege';
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT FROM pg_catalog.pg_default_acl WHERE defaclrole=v_owner AND defaclnamespace=0 AND defaclobjtype='f')
  OR EXISTS(SELECT FROM pg_catalog.pg_default_acl d CROSS JOIN LATERAL pg_catalog.aclexplode(d.defaclacl) a
   WHERE d.defaclrole=v_owner AND a.grantee<>v_owner) THEN
  RAISE EXCEPTION 'Function-owner default privileges are unsafe';
 END IF;
 IF NOT EXISTS(SELECT FROM pg_catalog.pg_namespace WHERE oid=v_schema AND nspowner=v_postgres)
  OR pg_catalog.has_schema_privilege(v_owner,v_schema,'CREATE')
  OR pg_catalog.has_schema_privilege(v_backend,v_schema,'CREATE')
  OR NOT pg_catalog.has_schema_privilege(v_owner,v_schema,'USAGE')
  OR NOT pg_catalog.has_schema_privilege(v_backend,v_schema,'USAGE') THEN
  RAISE EXCEPTION 'Unexpected private schema ownership or runtime access';
 END IF;
 IF EXISTS(SELECT FROM pg_catalog.regexp_split_to_table(COALESCE(pg_catalog.current_setting('pgrst.db_schemas',true),''),',') s(name)
  WHERE pg_catalog.btrim(s.name,' "')='dental') THEN
  RAISE EXCEPTION 'Dental must not be API-exposed; also verify the platform API configuration separately';
 END IF;
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.oid),'[]'::jsonb)
  INTO v_defaults FROM pg_catalog.pg_default_acl d WHERE d.defaclrole IN (v_postgres,v_owner);
 -- API-facing roles must have no latent private path, even without schema USAGE.
 FOREACH v_role IN ARRAY ARRAY['anon','authenticated','authenticator','service_role'] LOOP
  IF pg_catalog.pg_has_role(v_role,v_owner,'MEMBER') OR pg_catalog.pg_has_role(v_role,v_backend,'MEMBER')
   OR pg_catalog.has_schema_privilege(v_role,v_schema,'USAGE,CREATE') THEN
   RAISE EXCEPTION 'Unreviewed API-role private schema access or membership';
  END IF;
  FOR v_table IN SELECT * FROM pg_catalog.pg_class WHERE relnamespace=v_schema AND relkind='r' LOOP
   IF pg_catalog.has_table_privilege(v_role,v_table.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    OR pg_catalog.has_any_column_privilege(v_role,v_table.oid,'SELECT,INSERT,UPDATE,REFERENCES') THEN
    RAISE EXCEPTION 'Unreviewed API-role private table or column privileges';
   END IF;
  END LOOP;
 END LOOP;
 -- Baseline 011, with exact reserve body and no already-created admin lane.
 v_reserve:='dental.reserve(uuid,uuid,jsonb)'::pg_catalog.regprocedure::oid;
 IF (SELECT pg_catalog.md5(prosrc) FROM pg_catalog.pg_proc WHERE oid=v_reserve) IS DISTINCT FROM '0980f366b7b87c2028dcf98db3b98a2b'
  OR (SELECT pg_catalog.md5(prosrc) FROM pg_catalog.pg_proc WHERE oid='dental.admin_appointments(uuid,date,text)'::pg_catalog.regprocedure) IS DISTINCT FROM 'eeea88c90f1064df6148ef4c56c0204e'
  OR (SELECT pg_catalog.md5(prosrc) FROM pg_catalog.pg_proc WHERE oid='dental.set_admin_grant(uuid,uuid,boolean,text)'::pg_catalog.regprocedure) IS DISTINCT FROM '45e6fcf15880a2a53fa37b1cd699afba'
  OR pg_catalog.to_regclass('dental.admin_booking_events') IS NOT NULL
  OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc WHERE pronamespace=v_schema)<>34
  OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_class WHERE relnamespace=v_schema AND relkind='r')<>15
  OR NOT EXISTS(SELECT FROM pg_catalog.pg_constraint WHERE conrelid='dental.outbox'::regclass AND conname='outbox_frozen_envelope' AND convalidated)
  OR NOT EXISTS(SELECT FROM pg_catalog.pg_proc WHERE oid=v_reserve AND proowner=v_owner AND prosecdef
    AND proconfig=ARRAY['search_path=""']::text[] AND provolatile='v') THEN
  RAISE EXCEPTION 'Unreviewed or already-updated admin booking baseline 011';
 END IF;
 SELECT pg_catalog.array_agg(oid) INTO v_old_tables FROM pg_catalog.pg_class WHERE relnamespace=v_schema;
 SELECT pg_catalog.jsonb_build_object(
  'tables',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c) ORDER BY c.oid) FROM pg_catalog.pg_class c WHERE c.oid=ANY(v_old_tables)),
  'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.attrelid,a.attnum) FROM pg_catalog.pg_attribute a WHERE a.attrelid=ANY(v_old_tables)),
  'policies',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid) FROM pg_catalog.pg_policy p WHERE p.polrelid=ANY(v_old_tables)),
  'triggers',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_trigger t WHERE t.tgrelid=ANY(v_old_tables))
 ) INTO v_catalog;
 SELECT prosrc,pg_catalog.pg_get_functiondef(oid) INTO v_reserve_source,v_reserve_definition FROM pg_catalog.pg_proc WHERE oid=v_reserve;
 v_expected_reserve:=pg_catalog.replace(v_reserve_source,' v_result:=dental._appointment_json(v_appointment);',
  E' PERFORM dental._enqueue_admin_booking(v_appointment);\n v_result:=dental._appointment_json(v_appointment);');
 IF v_expected_reserve=v_reserve_source THEN RAISE EXCEPTION 'Missing exact reservation enqueue anchor'; END IF;
 v_admin_read:='dental.admin_appointments(uuid,date,text)'::pg_catalog.regprocedure::oid;
 SELECT prosrc,pg_catalog.pg_get_functiondef(oid) INTO v_admin_source,v_admin_definition FROM pg_catalog.pg_proc WHERE oid=v_admin_read;
 v_expected_admin:=pg_catalog.replace(v_admin_source,'dental._appointment_json(a)||pg_catalog.jsonb_build_object',
  'dental._appointment_json(a)||pg_catalog.jsonb_build_object(''adminNotificationAttempts'',dental._admin_notification_summary(a.id))||pg_catalog.jsonb_build_object');
 IF v_expected_admin=v_admin_source THEN RAISE EXCEPTION 'Missing exact admin projection anchor'; END IF;
 SELECT pg_catalog.jsonb_agg(CASE WHEN p.oid=v_reserve THEN pg_catalog.jsonb_set(pg_catalog.to_jsonb(p),'{prosrc}',pg_catalog.to_jsonb(v_expected_reserve))
  WHEN p.oid=v_admin_read THEN pg_catalog.jsonb_set(pg_catalog.to_jsonb(p),'{prosrc}',pg_catalog.to_jsonb(v_expected_admin)) ELSE pg_catalog.to_jsonb(p) END ORDER BY p.oid)
 INTO v_existing_functions FROM pg_catalog.pg_proc p WHERE pronamespace=v_schema;
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 GRANT dental_function_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
 GRANT CREATE ON SCHEMA dental TO dental_function_owner;

 CREATE TABLE dental.admin_notification_policy(
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), enabled boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK(version>0), activation_at timestamptz, authorized_end_at timestamptz,
  CHECK(NOT enabled OR (activation_at IS NOT NULL AND authorized_end_at IS NOT NULL)),
  CHECK(activation_at IS NULL OR pg_catalog.isfinite(activation_at)),
  CHECK(authorized_end_at IS NULL OR (pg_catalog.isfinite(authorized_end_at) AND authorized_end_at>activation_at))
 );
 INSERT INTO dental.admin_notification_policy(singleton) VALUES(true);
 CREATE TABLE dental.admin_booking_events(
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(), appointment_id uuid NOT NULL UNIQUE REFERENCES dental.appointments(id),
  created_at timestamptz NOT NULL CHECK(pg_catalog.isfinite(created_at)), expires_at timestamptz NOT NULL,
  reference text NOT NULL CHECK(reference~'^[-A-Za-z0-9]{1,80}$'), requested_date date NOT NULL,
  CHECK(expires_at=created_at+interval '24 hours'), CHECK(pg_catalog.isfinite(requested_date))
 );
 CREATE TABLE dental.admin_booking_deliveries(
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),event_id uuid NOT NULL REFERENCES dental.admin_booking_events(id),
  grant_id uuid NOT NULL REFERENCES dental.admin_grants(id),account_id uuid NOT NULL REFERENCES dental.accounts(id),
  recipient_index integer NOT NULL CHECK(recipient_index>0), frozen_provider text, frozen_recipient text,
  retry_key uuid NOT NULL UNIQUE DEFAULT pg_catalog.gen_random_uuid(),
  state text NOT NULL CHECK(state IN ('queued','leased','retry','paused_quota','accepted','suppressed','failed')),
  safe_reason text CHECK(safe_reason IN ('mapping_unavailable','recipient_unavailable','duplicate_recipient','policy_disabled','expired','grant_revoked','mapping_changed','quota_unknown','quota_exhausted','budget_expired','invalid_request','unknown','timeout','transport','server_error','rate_limited','unauthorized','forbidden')),
  created_at timestamptz NOT NULL CHECK(pg_catalog.isfinite(created_at)), due_at timestamptz NOT NULL CHECK(pg_catalog.isfinite(due_at)),
  lease_owner uuid,lease_until timestamptz,attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 6),
  first_attempt_at timestamptz,accepted_at timestamptz,payload_version integer NOT NULL DEFAULT 1 CHECK(payload_version=1),
  manage_url text CHECK(manage_url='https://tooth-talk-staging.tooth-talk-staging-f7ff4a96.workers.dev/admin'),
  authorization_valid_until timestamptz,prepared_at timestamptz,quota_observed_at timestamptz,quota_limit bigint CHECK(quota_limit BETWEEN 0 AND 9007199254740991),
  UNIQUE(event_id,grant_id),UNIQUE(event_id,recipient_index),
  CHECK((state='leased')=(lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
  CHECK((lease_owner IS NULL)=(lease_until IS NULL)),
  CHECK(lease_until IS NULL OR pg_catalog.isfinite(lease_until)),
  CHECK((frozen_provider IS NULL)=(frozen_recipient IS NULL)),
  CHECK(frozen_provider IS NULL OR frozen_provider~'^line:[A-Za-z0-9_-]{1,100}$'),
  CHECK(frozen_recipient IS NULL OR frozen_recipient~'^U[0-9a-f]{32}$'),
  CHECK(state='suppressed' OR (frozen_provider IS NOT NULL AND frozen_recipient IS NOT NULL)),
  CHECK((attempt_count=0)=(first_attempt_at IS NULL))
 );
 CREATE INDEX admin_deliveries_due ON dental.admin_booking_deliveries(due_at,created_at,event_id,grant_id,id) WHERE state IN ('queued','retry','paused_quota','leased');
 CREATE TABLE dental.admin_notification_attempts(
  delivery_id uuid NOT NULL REFERENCES dental.admin_booking_deliveries(id),attempt_number integer NOT NULL CHECK(attempt_number BETWEEN 1 AND 6),
  worker_id uuid NOT NULL, result text CHECK(result IN ('accepted','retryable','permanent','unknown')),
  started_at timestamptz NOT NULL,finished_at timestamptz,safe_error text,provider_request_id text CHECK(provider_request_id~'^[A-Za-z0-9_-]{1,128}$'),
  PRIMARY KEY(delivery_id,attempt_number),UNIQUE(delivery_id,worker_id)
 );
 CREATE TABLE dental.admin_notification_budget(
  epoch uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),version integer NOT NULL UNIQUE CHECK(version>0),
  verified_from timestamptz NOT NULL CHECK(pg_catalog.isfinite(verified_from)),
  verified_until timestamptz NOT NULL CHECK(pg_catalog.isfinite(verified_until) AND verified_until>verified_from),
  free_limit integer NOT NULL CHECK(free_limit BETWEEN 1 AND 300),baseline_usage bigint NOT NULL CHECK(baseline_usage BETWEEN 0 AND free_limit),
  usage_high_water bigint NOT NULL CHECK(usage_high_water>=baseline_usage),reserved_units bigint NOT NULL DEFAULT 0 CHECK(reserved_units>=0),
  carried_units bigint NOT NULL DEFAULT 0 CHECK(carried_units>=0),
  no_overage_verified boolean NOT NULL CHECK(no_overage_verified)
 );
 CREATE TABLE dental.admin_notification_budget_reservations(
  delivery_id uuid PRIMARY KEY REFERENCES dental.admin_booking_deliveries(id),budget_epoch uuid NOT NULL REFERENCES dental.admin_notification_budget(epoch),
  units integer NOT NULL DEFAULT 1 CHECK(units=1),created_at timestamptz NOT NULL CHECK(pg_catalog.isfinite(created_at))
 );
 FOREACH v_object IN ARRAY ARRAY['admin_notification_policy','admin_booking_events','admin_booking_deliveries','admin_notification_attempts','admin_notification_budget','admin_notification_budget_reservations'] LOOP
  EXECUTE pg_catalog.format('ALTER TABLE dental.%I ENABLE ROW LEVEL SECURITY',v_object);
  EXECUTE pg_catalog.format('ALTER TABLE dental.%I FORCE ROW LEVEL SECURITY',v_object);
  EXECUTE pg_catalog.format('REVOKE ALL ON TABLE dental.%I FROM PUBLIC',v_object);
  FOR v_grantee IN SELECT DISTINCT r.rolname FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a JOIN pg_catalog.pg_roles r ON r.oid=a.grantee
   WHERE c.oid=pg_catalog.to_regclass('dental.'||v_object) AND a.grantee<>c.relowner LOOP
   EXECUTE pg_catalog.format('REVOKE ALL ON TABLE dental.%I FROM %I',v_object,v_grantee.rolname);
  END LOOP;
  EXECUTE pg_catalog.format('GRANT SELECT ON TABLE dental.%I TO dental_function_owner',v_object);
  EXECUTE pg_catalog.format('CREATE POLICY %I ON dental.%I FOR SELECT TO dental_function_owner USING(true)',v_object||'_read',v_object);
 END LOOP;
 GRANT INSERT ON dental.admin_booking_events,dental.admin_booking_deliveries,dental.admin_notification_attempts TO dental_function_owner;
 GRANT UPDATE(enabled,version,activation_at,authorized_end_at) ON dental.admin_notification_policy TO dental_function_owner;
 GRANT UPDATE(state,safe_reason,due_at,lease_owner,lease_until,attempt_count,first_attempt_at,accepted_at,manage_url,authorization_valid_until,prepared_at,quota_observed_at,quota_limit) ON dental.admin_booking_deliveries TO dental_function_owner;
 GRANT UPDATE(result,finished_at,safe_error,provider_request_id) ON dental.admin_notification_attempts TO dental_function_owner;
 CREATE POLICY admin_policy_update ON dental.admin_notification_policy FOR UPDATE TO dental_function_owner USING(true) WITH CHECK(true);
 CREATE POLICY admin_events_insert ON dental.admin_booking_events FOR INSERT TO dental_function_owner WITH CHECK(true);
 CREATE POLICY admin_deliveries_insert ON dental.admin_booking_deliveries FOR INSERT TO dental_function_owner WITH CHECK(true);
 CREATE POLICY admin_deliveries_update ON dental.admin_booking_deliveries FOR UPDATE TO dental_function_owner USING(true) WITH CHECK(true);
 CREATE POLICY admin_attempts_insert ON dental.admin_notification_attempts FOR INSERT TO dental_function_owner WITH CHECK(true);
 CREATE POLICY admin_attempts_update ON dental.admin_notification_attempts FOR UPDATE TO dental_function_owner USING(true) WITH CHECK(true);
 GRANT INSERT ON dental.admin_notification_budget,dental.admin_notification_budget_reservations TO dental_function_owner;
 GRANT UPDATE(usage_high_water,reserved_units) ON dental.admin_notification_budget TO dental_function_owner;
 CREATE POLICY admin_budget_insert ON dental.admin_notification_budget FOR INSERT TO dental_function_owner WITH CHECK(true);
 CREATE POLICY admin_budget_update ON dental.admin_notification_budget FOR UPDATE TO dental_function_owner USING(true) WITH CHECK(true);
 CREATE POLICY admin_budget_reservation_insert ON dental.admin_notification_budget_reservations FOR INSERT TO dental_function_owner WITH CHECK(true);
 SET LOCAL ROLE dental_function_owner;
 EXECUTE $definitions$
-- Read-only, ungranted helper. The existing admin query retains all live
-- authorization checks and audit behavior around this additive safe projection.
CREATE FUNCTION dental._admin_notification_summary(p_appointment uuid)
RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
 WITH observed AS MATERIALIZED (SELECT dental.clock_now() AS now), summaries AS (
  SELECT d.recipient_index,d.attempt_count,d.state,d.safe_reason,
   CASE WHEN d.state IN('queued','leased','retry','paused_quota') THEN
    CASE WHEN o.now>=e.expires_at OR o.now>=d.first_attempt_at+interval '24 hours' THEN 'expired'
     WHEN NOT p.enabled OR e.created_at<p.activation_at OR e.created_at>=p.authorized_end_at OR o.now<p.activation_at OR o.now>=p.authorized_end_at THEN 'policy_disabled'
     WHEN g.id IS NULL OR g.revoked_at IS NOT NULL THEN 'grant_revoked' END
   END AS effective_reason
  FROM dental.admin_booking_events e JOIN dental.admin_booking_deliveries d ON d.event_id=e.id
  CROSS JOIN dental.admin_notification_policy p CROSS JOIN observed o
  LEFT JOIN dental.admin_grants g ON g.id=d.grant_id AND g.account_id=d.account_id
  WHERE e.appointment_id=p_appointment AND p.singleton
 )
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
  'recipientLabel','แอดมิน '||recipient_index::text,
  'state',CASE WHEN effective_reason='expired' AND attempt_count>0 THEN 'failed' WHEN effective_reason IS NOT NULL THEN 'suppressed' ELSE state END,
  'attemptCount',attempt_count,
  'safeReason',CASE WHEN effective_reason='expired' AND attempt_count>0 THEN 'unknown' WHEN effective_reason IS NOT NULL THEN effective_reason
   WHEN safe_reason IN('mapping_unavailable','recipient_unavailable','duplicate_recipient','policy_disabled','expired','grant_revoked','mapping_changed','quota_unknown','quota_exhausted','budget_expired','invalid_request','unknown','timeout','transport','server_error','rate_limited','unauthorized','forbidden') THEN safe_reason
   WHEN safe_reason IS NOT NULL THEN 'unknown' ELSE NULL END
 ) ORDER BY recipient_index),'[]'::jsonb) FROM summaries;
$body$;
REVOKE ALL ON FUNCTION dental._admin_notification_summary(uuid) FROM PUBLIC;
CREATE FUNCTION dental._admin_delivery_json(p dental.admin_booking_deliveries)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
AS $body$
 SELECT pg_catalog.jsonb_build_object('id',p.id,'eventId',p.event_id,'appointmentId',e.appointment_id,'grantId',p.grant_id,
  'retryKey',p.retry_key,'createdAt',p.created_at,'dueAt',p.due_at,'expiresAt',e.expires_at)
 FROM dental.admin_booking_events e WHERE e.id=p.event_id
$body$;
CREATE FUNCTION dental.claim_admin_delivery(p_worker uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_delivery dental.admin_booking_deliveries;v_event dental.admin_booking_events;v_now timestamptz;v_i integer;
BEGIN
 IF p_worker IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE'; END IF;
 v_now:=dental.clock_now();
 IF NOT EXISTS(SELECT FROM dental.admin_notification_policy WHERE singleton AND enabled AND v_now>=activation_at AND v_now<authorized_end_at) THEN RETURN NULL; END IF;
 -- One eligible claim, with bounded stale-row cleanup. Never acquire an appointment,
 -- date, grant, policy or budget lock after the delivery lock in this transaction.
 FOR v_i IN 1..100 LOOP
  SELECT * INTO v_delivery FROM dental.admin_booking_deliveries d
   WHERE ((d.state IN('queued','retry','paused_quota') AND d.due_at<=dental.clock_now())
    OR (d.state='leased' AND d.lease_until<=dental.clock_now()))
    AND NOT EXISTS(SELECT FROM dental.admin_notification_attempts a WHERE a.delivery_id=d.id AND a.worker_id=p_worker)
   ORDER BY d.created_at,d.event_id,d.grant_id,d.id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO STRICT v_event FROM dental.admin_booking_events WHERE id=v_delivery.event_id;
  v_now:=dental.clock_now();
  IF v_now>=v_event.expires_at OR v_delivery.attempt_count>=6
   OR (v_delivery.first_attempt_at IS NOT NULL AND v_now>=v_delivery.first_attempt_at+interval '24 hours') THEN
   UPDATE dental.admin_booking_deliveries SET state=CASE WHEN attempt_count>0 THEN 'failed' ELSE 'suppressed' END,
    safe_reason=CASE WHEN attempt_count>0 THEN 'unknown' ELSE 'expired' END,lease_owner=NULL,lease_until=NULL,authorization_valid_until=NULL WHERE id=v_delivery.id;
  ELSE
   UPDATE dental.admin_booking_deliveries SET state='leased',lease_owner=p_worker,lease_until=v_now+interval '60 seconds',authorization_valid_until=NULL
    WHERE id=v_delivery.id RETURNING * INTO v_delivery;
   RETURN dental._admin_delivery_json(v_delivery);
  END IF;
 END LOOP;
 RETURN NULL;
END;
$body$;
CREATE FUNCTION dental.prepare_admin_dispatch(p_worker uuid,p_delivery uuid,p_origin text,p_quota jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_delivery dental.admin_booking_deliveries;v_event dental.admin_booking_events;
 v_policy dental.admin_notification_policy;v_budget dental.admin_notification_budget;
 v_account uuid;v_now timestamptz;v_reachable boolean;v_reason text;v_deadline timestamptz;
BEGIN
 IF p_worker IS NULL OR p_delivery IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE'; END IF;
 SELECT account_id INTO v_account FROM dental.admin_booking_deliveries WHERE id=p_delivery;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dental.admin:'||v_account::text,0));
 SELECT * INTO STRICT v_policy FROM dental.admin_notification_policy WHERE singleton FOR SHARE;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dental.admin-budget',0));
 SELECT * INTO v_budget FROM dental.admin_notification_budget ORDER BY version DESC LIMIT 1 FOR UPDATE;
 SELECT * INTO STRICT v_delivery FROM dental.admin_booking_deliveries WHERE id=p_delivery FOR UPDATE;
 SELECT * INTO STRICT v_event FROM dental.admin_booking_events WHERE id=v_delivery.event_id;
 v_now:=dental.clock_now();
 IF v_delivery.state<>'leased' OR v_delivery.lease_owner IS DISTINCT FROM p_worker OR v_delivery.lease_until<=v_now THEN RETURN NULL; END IF;
 IF EXISTS(SELECT FROM dental.admin_notification_attempts WHERE delivery_id=p_delivery AND worker_id=p_worker) THEN RETURN NULL; END IF;
 IF v_now>=v_event.expires_at OR v_delivery.attempt_count>=6
  OR (v_delivery.first_attempt_at IS NOT NULL AND v_now>=v_delivery.first_attempt_at+interval '24 hours') THEN v_reason:='expired';
 ELSIF NOT v_policy.enabled OR v_event.created_at<v_policy.activation_at OR v_event.created_at>=v_policy.authorized_end_at OR v_now<v_policy.activation_at OR v_now>=v_policy.authorized_end_at THEN v_reason:='policy_disabled';
 ELSIF NOT EXISTS(SELECT FROM dental.admin_grants WHERE id=v_delivery.grant_id AND account_id=v_account AND revoked_at IS NULL) THEN v_reason:='grant_revoked';
 ELSIF NOT EXISTS(SELECT FROM dental.accounts WHERE id=v_account AND provider=v_delivery.frozen_provider AND subject=v_delivery.frozen_recipient) THEN v_reason:='mapping_changed';
 ELSIF p_origin IS DISTINCT FROM 'https://tooth-talk-staging.tooth-talk-staging-f7ff4a96.workers.dev'
  OR (v_delivery.manage_url IS NOT NULL AND v_delivery.manage_url<>p_origin||'/admin') THEN v_reason:='invalid_request';
 END IF;
 IF v_reason IS NULL THEN
  SELECT reachable INTO v_reachable FROM dental.line_reachability WHERE provider=v_delivery.frozen_provider AND subject=v_delivery.frozen_recipient FOR SHARE;
  v_now:=dental.clock_now();
  IF NOT EXISTS(SELECT FROM dental.accounts WHERE id=v_account AND provider=v_delivery.frozen_provider AND subject=v_delivery.frozen_recipient) THEN v_reason:='mapping_changed';
  ELSIF v_reachable IS NOT TRUE THEN v_reason:='recipient_unavailable';
  ELSIF v_now>=v_event.expires_at THEN v_reason:='expired';
  ELSIF v_now>=v_policy.authorized_end_at THEN v_reason:='policy_disabled';
  ELSIF v_delivery.lease_until<=v_now OR v_delivery.due_at>v_now THEN RETURN NULL;
  END IF;
 END IF;
 IF v_reason IS NOT NULL THEN
  UPDATE dental.admin_booking_deliveries SET state=CASE WHEN v_reason='expired' AND attempt_count>0 THEN 'failed' ELSE 'suppressed' END,
   safe_reason=CASE WHEN v_reason='expired' AND attempt_count>0 THEN 'unknown' ELSE v_reason END,lease_owner=NULL,lease_until=NULL,authorization_valid_until=NULL WHERE id=p_delivery;
  RETURN NULL;
 END IF;
 -- Reentrant budget/delivery locks retain the declared order. Reservation and the
 -- attempt below commit in this one RPC transaction, before any HTTP can start.
 -- A narrow subtransaction also prevents a credit-only commit if wall time
 -- crosses the final deadline after the reservation but before its attempt.
 BEGIN
 IF NOT dental._reserve_admin_budget(p_delivery,p_quota) THEN
  IF EXISTS(SELECT FROM dental.admin_booking_deliveries WHERE id=p_delivery AND state='paused_quota') THEN RETURN pg_catalog.jsonb_build_object('state','paused_quota'); END IF;
  RETURN NULL;
 END IF;
 SELECT * INTO STRICT v_budget FROM dental.admin_notification_budget ORDER BY version DESC LIMIT 1;
 v_now:=dental.clock_now();
 v_deadline:=LEAST(v_delivery.lease_until,v_event.expires_at,COALESCE(v_delivery.first_attempt_at,v_now)+interval '24 hours',
  v_policy.authorized_end_at,v_budget.verified_until,(p_quota->>'observedAt')::timestamptz+interval '60 seconds');
 IF v_deadline<=v_now THEN RAISE EXCEPTION USING ERRCODE='DA001',MESSAGE='ADMIN_AUTHORIZATION_CLOSED'; END IF;
 UPDATE dental.admin_notification_attempts SET result='unknown',finished_at=v_now,safe_error='unknown'
  WHERE delivery_id=p_delivery AND finished_at IS NULL;
 INSERT INTO dental.admin_notification_attempts(delivery_id,attempt_number,worker_id,started_at)
 VALUES(p_delivery,v_delivery.attempt_count+1,p_worker,v_now);
 UPDATE dental.admin_booking_deliveries SET attempt_count=attempt_count+1,first_attempt_at=COALESCE(first_attempt_at,v_now),
  manage_url=COALESCE(manage_url,p_origin||'/admin'),prepared_at=v_now,quota_observed_at=(p_quota->>'observedAt')::timestamptz,
  quota_limit=(p_quota->>'value')::bigint,authorization_valid_until=v_deadline,safe_reason=NULL WHERE id=p_delivery RETURNING * INTO v_delivery;
 -- Attempt writes can wait on locks too. Fence after the final write, while the
 -- subtransaction can still undo a new credit and attempt as a single unit.
 v_now:=dental.clock_now();
 IF NOT EXISTS(SELECT FROM dental.accounts WHERE id=v_account AND provider=v_delivery.frozen_provider AND subject=v_delivery.frozen_recipient) THEN
  RAISE EXCEPTION USING ERRCODE='DA002',MESSAGE='ADMIN_MAPPING_CHANGED';
 END IF;
 IF v_deadline<=v_now THEN RAISE EXCEPTION USING ERRCODE='DA001',MESSAGE='ADMIN_AUTHORIZATION_CLOSED'; END IF;
 RETURN pg_catalog.jsonb_build_object('delivery',dental._admin_delivery_json(v_delivery),'provider',v_delivery.frozen_provider,
  'recipient',v_delivery.frozen_recipient,'reference',v_event.reference,'date',v_event.requested_date::text,
  'manageUrl',v_delivery.manage_url,'payloadVersion',1,'preparedAt',v_delivery.prepared_at,'authorizationValidUntil',v_deadline);
 EXCEPTION WHEN SQLSTATE 'DA001' OR SQLSTATE 'DA002' THEN
  -- Reservation/attempt writes above rolled back together. Retain a validated
  -- usage high-water observation, but never retain a new recipient-only credit.
  UPDATE dental.admin_notification_budget SET usage_high_water=GREATEST(usage_high_water,(p_quota->>'totalUsage')::bigint) WHERE epoch=v_budget.epoch;
  v_now:=dental.clock_now();
  IF SQLSTATE='DA002' THEN
   UPDATE dental.admin_booking_deliveries SET state='suppressed',safe_reason='mapping_changed',lease_owner=NULL,lease_until=NULL,authorization_valid_until=NULL WHERE id=p_delivery;
   RETURN NULL;
  ELSIF v_now>=v_event.expires_at OR v_now>=v_delivery.first_attempt_at+interval '24 hours' THEN
   UPDATE dental.admin_booking_deliveries SET state=CASE WHEN attempt_count>0 THEN 'failed' ELSE 'suppressed' END,
    safe_reason=CASE WHEN attempt_count>0 THEN 'unknown' ELSE 'expired' END,lease_owner=NULL,lease_until=NULL,authorization_valid_until=NULL WHERE id=p_delivery;
   RETURN NULL;
  ELSIF v_now>=v_policy.authorized_end_at THEN
   UPDATE dental.admin_booking_deliveries SET state='suppressed',safe_reason='policy_disabled',lease_owner=NULL,lease_until=NULL,authorization_valid_until=NULL WHERE id=p_delivery;
   RETURN NULL;
  ELSIF v_delivery.lease_until<=v_now THEN RETURN NULL;
  END IF;
  UPDATE dental.admin_booking_deliveries SET state='paused_quota',safe_reason=CASE WHEN v_now>=v_budget.verified_until THEN 'budget_expired' ELSE 'quota_unknown' END,
   due_at=v_now+interval '15 minutes',lease_owner=NULL,lease_until=NULL,authorization_valid_until=NULL WHERE id=p_delivery;
  RETURN pg_catalog.jsonb_build_object('state','paused_quota');
 END;
END;
$body$;
CREATE FUNCTION dental.revalidate_admin_dispatch(p_worker uuid,p_delivery uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_delivery dental.admin_booking_deliveries;v_event dental.admin_booking_events;v_policy dental.admin_notification_policy;
 v_budget dental.admin_notification_budget;v_account uuid;v_now timestamptz;v_reachable boolean;v_reason text;
BEGIN
 IF p_worker IS NULL OR p_delivery IS NULL THEN RETURN false; END IF;
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE'; END IF;
 SELECT account_id INTO v_account FROM dental.admin_booking_deliveries WHERE id=p_delivery;
 IF NOT FOUND THEN RETURN false; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dental.admin:'||v_account::text,0));
 SELECT * INTO STRICT v_policy FROM dental.admin_notification_policy WHERE singleton FOR SHARE;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dental.admin-budget',0));
 SELECT * INTO v_budget FROM dental.admin_notification_budget ORDER BY version DESC LIMIT 1 FOR UPDATE;
 SELECT * INTO STRICT v_delivery FROM dental.admin_booking_deliveries WHERE id=p_delivery FOR UPDATE;
 SELECT * INTO STRICT v_event FROM dental.admin_booking_events WHERE id=v_delivery.event_id;
 SELECT reachable INTO v_reachable FROM dental.line_reachability WHERE provider=v_delivery.frozen_provider AND subject=v_delivery.frozen_recipient FOR SHARE;
 v_now:=dental.clock_now();
 IF v_delivery.state<>'leased' OR v_delivery.lease_owner IS DISTINCT FROM p_worker OR v_delivery.lease_until<=v_now
  OR v_delivery.due_at>v_now OR NOT EXISTS(SELECT FROM dental.admin_notification_attempts WHERE delivery_id=p_delivery
   AND worker_id=p_worker AND attempt_number=v_delivery.attempt_count AND finished_at IS NULL) THEN RETURN false; END IF;
 IF v_now>=v_event.expires_at OR v_now>=v_delivery.first_attempt_at+interval '24 hours' THEN v_reason:='expired';
 ELSIF NOT v_policy.enabled OR v_event.created_at<v_policy.activation_at OR v_event.created_at>=v_policy.authorized_end_at OR v_now<v_policy.activation_at OR v_now>=v_policy.authorized_end_at THEN v_reason:='policy_disabled';
 ELSIF NOT EXISTS(SELECT FROM dental.admin_grants WHERE id=v_delivery.grant_id AND account_id=v_account AND revoked_at IS NULL) THEN v_reason:='grant_revoked';
 ELSIF NOT EXISTS(SELECT FROM dental.accounts WHERE id=v_account AND provider=v_delivery.frozen_provider AND subject=v_delivery.frozen_recipient) THEN v_reason:='mapping_changed';
 ELSIF v_reachable IS NOT TRUE THEN v_reason:='recipient_unavailable';
 ELSIF v_budget.epoch IS NULL OR NOT v_budget.no_overage_verified OR v_now<v_budget.verified_from OR v_now>=v_budget.verified_until
  OR NOT EXISTS(SELECT FROM dental.admin_notification_budget_reservations WHERE delivery_id=p_delivery AND budget_epoch=v_budget.epoch) THEN v_reason:='budget_expired';
 ELSIF v_delivery.quota_observed_at IS NULL OR v_delivery.quota_observed_at>v_now OR v_now-v_delivery.quota_observed_at>interval '60 seconds' THEN v_reason:='quota_unknown';
 ELSIF v_delivery.quota_limit IS NULL OR GREATEST(v_budget.baseline_usage,v_budget.usage_high_water)+v_budget.reserved_units+v_budget.carried_units>LEAST(300,v_budget.free_limit,v_delivery.quota_limit) THEN v_reason:='quota_exhausted';
 END IF;
 IF v_reason IS NOT NULL THEN
  UPDATE dental.admin_booking_deliveries SET state=CASE WHEN v_reason IN('quota_unknown','quota_exhausted','budget_expired') THEN 'paused_quota' WHEN v_reason='expired' THEN 'failed' ELSE 'suppressed' END,
   safe_reason=CASE WHEN v_reason='expired' THEN 'unknown' ELSE v_reason END,
   due_at=CASE WHEN v_reason IN('quota_unknown','quota_exhausted','budget_expired') THEN v_now+interval '15 minutes' ELSE due_at END,
   lease_owner=NULL,lease_until=NULL,authorization_valid_until=NULL WHERE id=p_delivery;
  RETURN false;
 END IF;
 -- No deadline or lease extension at this final authority check.
 RETURN v_delivery.authorization_valid_until IS NOT NULL AND v_now<v_delivery.authorization_valid_until;
END;
$body$;
CREATE FUNCTION dental.finish_admin_dispatch(p_worker uuid,p_delivery uuid,p_result jsonb)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_delivery dental.admin_booking_deliveries;v_attempt dental.admin_notification_attempts;v_expires timestamptz;
 v_kind text;v_category text;v_request text;v_now timestamptz;v_next timestamptz;
BEGIN
 IF p_worker IS NULL OR p_delivery IS NULL OR p_result IS NULL OR pg_catalog.jsonb_typeof(p_result)<>'object'
  OR pg_catalog.jsonb_typeof(p_result->'kind') IS DISTINCT FROM 'string' OR p_result->>'kind' NOT IN('accepted','retryable','permanent')
  OR EXISTS(SELECT FROM pg_catalog.jsonb_object_keys(p_result) k WHERE k<>ALL(ARRAY['kind','category','requestId'])) THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE'; END IF;
 v_kind:=p_result->>'kind';v_category:=p_result->>'category';v_request:=p_result->>'requestId';
 IF (p_result?'category' AND (pg_catalog.jsonb_typeof(p_result->'category')<>'string' OR v_category NOT IN('timeout','transport','server_error','quota','rate_limited','recipient_unavailable','invalid_request','unauthorized','forbidden','unknown')))
  OR (p_result?'requestId' AND (pg_catalog.jsonb_typeof(p_result->'requestId')<>'string' OR v_request!~'^[A-Za-z0-9_-]{1,128}$')) THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
 IF v_kind<>'accepted' THEN v_category:=COALESCE(v_category,'unknown'); END IF;
 IF v_kind='retryable' AND v_category NOT IN('timeout','transport','server_error') THEN v_kind:='permanent'; END IF;
 IF v_category='quota' THEN v_category:='quota_exhausted'; END IF;
 SELECT * INTO v_delivery FROM dental.admin_booking_deliveries WHERE id=p_delivery FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO v_attempt FROM dental.admin_notification_attempts WHERE delivery_id=p_delivery AND worker_id=p_worker;
 IF NOT FOUND OR v_attempt.attempt_number<>v_delivery.attempt_count OR v_attempt.finished_at IS NOT NULL
  OR (v_delivery.lease_owner IS NOT NULL AND v_delivery.lease_owner<>p_worker) THEN RETURN false; END IF;
 v_now:=dental.clock_now();
 UPDATE dental.admin_notification_attempts SET result=v_kind,finished_at=v_now,safe_error=v_category,provider_request_id=v_request
  WHERE delivery_id=p_delivery AND attempt_number=v_attempt.attempt_number;
 IF v_kind='accepted' THEN
  -- Accepted is a historical provider fact, even when expiry/revocation/disable
  -- occurred after initiation. Never turn this into another dispatch opportunity.
  UPDATE dental.admin_booking_deliveries SET state='accepted',accepted_at=v_now,safe_reason=NULL,
   lease_owner=NULL,lease_until=NULL,authorization_valid_until=NULL WHERE id=p_delivery;
  RETURN true;
 END IF;
 IF v_delivery.state<>'leased' OR v_delivery.lease_owner IS DISTINCT FROM p_worker THEN RETURN true; END IF;
 SELECT expires_at INTO STRICT v_expires FROM dental.admin_booking_events WHERE id=v_delivery.event_id;
 v_next:=v_now+pg_catalog.make_interval(mins=>pg_catalog.power(2,v_delivery.attempt_count-1)::integer);
 IF v_kind='retryable' AND v_delivery.attempt_count<6 AND v_next<v_expires AND v_next<v_delivery.first_attempt_at+interval '24 hours' THEN
  UPDATE dental.admin_booking_deliveries SET state='retry',due_at=v_next,safe_reason=v_category,lease_owner=NULL,lease_until=NULL,authorization_valid_until=NULL WHERE id=p_delivery;
 ELSE
  UPDATE dental.admin_booking_deliveries SET state='failed',safe_reason=CASE WHEN v_kind='retryable' OR v_now>=v_expires THEN 'unknown' ELSE v_category END,
   lease_owner=NULL,lease_until=NULL,authorization_valid_until=NULL WHERE id=p_delivery;
 END IF;
 RETURN true;
END;
$body$;
REVOKE ALL ON FUNCTION dental._admin_delivery_json(dental.admin_booking_deliveries),dental.claim_admin_delivery(uuid),dental.prepare_admin_dispatch(uuid,uuid,text,jsonb),dental.revalidate_admin_dispatch(uuid,uuid),dental.finish_admin_dispatch(uuid,uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dental.claim_admin_delivery(uuid),dental.prepare_admin_dispatch(uuid,uuid,text,jsonb),dental.revalidate_admin_dispatch(uuid,uuid),dental.finish_admin_dispatch(uuid,uuid,jsonb) TO dental_backend;
CREATE FUNCTION dental.set_admin_notification_budget(p_operator uuid,p_expected_version integer,p_verified_from timestamptz,p_verified_until timestamptz,p_free_limit integer,p_baseline_usage integer,p_no_overage_verified boolean,p_reason text)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_budget dental.admin_notification_budget;v_now timestamptz;v_version integer;v_carried bigint:=0;
BEGIN
 IF SESSION_USER<>'postgres' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dental.admin-budget',0));
 SELECT * INTO v_budget FROM dental.admin_notification_budget ORDER BY version DESC LIMIT 1 FOR UPDATE;
 v_now:=dental.clock_now();v_version:=COALESCE(v_budget.version,0);
 IF p_expected_version IS NULL OR p_expected_version<>v_version THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VERSION_CONFLICT'; END IF;
 IF p_operator IS NULL OR NOT EXISTS(SELECT FROM dental.accounts WHERE id=p_operator)
  OR p_verified_from IS NULL OR p_verified_until IS NULL OR NOT pg_catalog.isfinite(p_verified_from) OR NOT pg_catalog.isfinite(p_verified_until)
  OR p_verified_from<v_now OR p_verified_until<=p_verified_from OR p_free_limit IS NULL OR p_free_limit NOT BETWEEN 1 AND 300
  OR p_baseline_usage IS NULL OR p_baseline_usage NOT BETWEEN 0 AND p_free_limit OR p_no_overage_verified IS NOT TRUE
  OR p_reason IS NULL OR pg_catalog.char_length(pg_catalog.btrim(p_reason)) NOT BETWEEN 1 AND 500
  OR (v_budget.epoch IS NOT NULL AND (v_now<v_budget.verified_until OR p_verified_from<v_budget.verified_until)) THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
 -- Renewal holds the same key as prepare, so all old reservations/attempts are
 -- committed before this snapshot. A provider may accept an old in-flight HTTP
 -- after the boundary; estimated consumption cannot safely release that credit.
 IF v_budget.epoch IS NOT NULL THEN
  SELECT v_budget.carried_units+pg_catalog.count(*) INTO v_carried
  FROM dental.admin_notification_budget_reservations r JOIN dental.admin_booking_deliveries d ON d.id=r.delivery_id
  WHERE r.budget_epoch=v_budget.epoch AND d.first_attempt_at IS NOT NULL
   AND NOT(d.state='accepted' AND d.accepted_at IS NOT NULL AND d.accepted_at<v_budget.verified_until);
 END IF;
 INSERT INTO dental.admin_notification_budget(version,verified_from,verified_until,free_limit,baseline_usage,usage_high_water,carried_units,no_overage_verified)
 VALUES(v_version+1,p_verified_from,p_verified_until,p_free_limit,p_baseline_usage,p_baseline_usage,v_carried,true);
 INSERT INTO dental.audit_events(actor_account_id,action,reason,occurred_at)
 VALUES(p_operator,'admin_notification_budget_verified',pg_catalog.btrim(p_reason),v_now);
 RETURN v_version+1;
END;
$body$;
CREATE FUNCTION dental._reserve_admin_budget(p_delivery uuid,p_quota jsonb)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_budget dental.admin_notification_budget;v_delivery dental.admin_booking_deliveries;
 v_reservation dental.admin_notification_budget_reservations;v_now timestamptz;v_expires timestamptz;
 v_limit numeric;v_usage numeric;v_observed timestamptz;v_ceiling numeric;v_bound numeric;v_reason text;
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE'; END IF;
 -- Also serializes an absent first epoch with operator creation. No delivery lock precedes it.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dental.admin-budget',0));
 SELECT * INTO v_budget FROM dental.admin_notification_budget ORDER BY version DESC LIMIT 1 FOR UPDATE;
 SELECT * INTO v_delivery FROM dental.admin_booking_deliveries WHERE id=p_delivery FOR UPDATE;
 IF NOT FOUND OR v_delivery.state NOT IN('queued','leased','retry','paused_quota') THEN RETURN false; END IF;
 v_now:=dental.clock_now();
 SELECT expires_at INTO STRICT v_expires FROM dental.admin_booking_events WHERE id=v_delivery.event_id;
 IF v_now>=v_expires THEN
  UPDATE dental.admin_booking_deliveries SET state=CASE WHEN attempt_count>0 THEN 'failed' ELSE 'suppressed' END,
   safe_reason=CASE WHEN attempt_count>0 THEN 'unknown' ELSE 'expired' END,lease_owner=NULL,lease_until=NULL,authorization_valid_until=NULL WHERE id=p_delivery;
  RETURN false;
 END IF;
 IF v_delivery.state='paused_quota' AND v_delivery.due_at>v_now THEN RETURN false; END IF;
 IF v_budget.epoch IS NULL OR NOT v_budget.no_overage_verified OR v_now<v_budget.verified_from OR v_now>=v_budget.verified_until THEN
  v_reason:='budget_expired';
 ELSE
  BEGIN
   IF p_quota IS NULL OR pg_catalog.jsonb_typeof(p_quota)<>'object' OR p_quota->>'type' IS DISTINCT FROM 'limited'
    OR pg_catalog.jsonb_typeof(p_quota->'value') IS DISTINCT FROM 'number'
    OR pg_catalog.jsonb_typeof(p_quota->'totalUsage') IS DISTINCT FROM 'number'
    OR pg_catalog.jsonb_typeof(p_quota->'observedAt') IS DISTINCT FROM 'string'
    OR p_quota->>'observedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?Z$' THEN
    v_reason:='quota_unknown';
   ELSE
    v_limit:=(p_quota->>'value')::numeric;v_usage:=(p_quota->>'totalUsage')::numeric;v_observed:=(p_quota->>'observedAt')::timestamptz;
    IF v_limit<0 OR v_limit>9007199254740991 OR v_limit<>pg_catalog.trunc(v_limit)
     OR v_usage<0 OR v_usage>9007199254740991 OR v_usage<>pg_catalog.trunc(v_usage)
     OR NOT pg_catalog.isfinite(v_observed) OR v_observed>v_now OR v_now-v_observed>interval '60 seconds' THEN
     v_reason:='quota_unknown';
    END IF;
   END IF;
  EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range THEN
   v_reason:='quota_unknown';
  END;
 END IF;
 IF v_reason IS NULL THEN
  UPDATE dental.admin_notification_budget SET usage_high_water=GREATEST(usage_high_water,v_usage::bigint) WHERE epoch=v_budget.epoch RETURNING * INTO v_budget;
  v_ceiling:=LEAST(300,v_budget.free_limit,v_limit);v_bound:=GREATEST(v_budget.baseline_usage,v_budget.usage_high_water)+v_budget.reserved_units+v_budget.carried_units;
  SELECT * INTO v_reservation FROM dental.admin_notification_budget_reservations WHERE delivery_id=p_delivery;
  IF FOUND THEN
   IF v_reservation.budget_epoch<>v_budget.epoch THEN v_reason:='budget_expired';
   ELSIF v_bound<=v_ceiling THEN RETURN true;
   ELSE v_reason:='quota_exhausted'; END IF;
  ELSIF v_bound+1<=v_ceiling THEN
   INSERT INTO dental.admin_notification_budget_reservations(delivery_id,budget_epoch,created_at) VALUES(p_delivery,v_budget.epoch,v_now);
   UPDATE dental.admin_notification_budget SET reserved_units=reserved_units+1 WHERE epoch=v_budget.epoch;
   RETURN true;
  ELSE v_reason:='quota_exhausted'; END IF;
 END IF;
 -- Pauses are durable, including unknown observations; a fresh tick cannot retry early.
 UPDATE dental.admin_booking_deliveries SET state='paused_quota',safe_reason=v_reason,due_at=v_now+interval '15 minutes',
  lease_owner=NULL,lease_until=NULL,authorization_valid_until=NULL WHERE id=p_delivery;
 RETURN false;
END;
$body$;
REVOKE ALL ON FUNCTION dental.set_admin_notification_budget(uuid,integer,timestamptz,timestamptz,integer,integer,boolean,text),dental._reserve_admin_budget(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dental.set_admin_notification_budget(uuid,integer,timestamptz,timestamptz,integer,integer,boolean,text) TO postgres;
CREATE FUNCTION dental.set_admin_notification_policy(p_operator uuid,p_expected_version integer,p_enabled boolean,p_activation_at timestamptz,p_authorized_end_at timestamptz,p_reason text)
RETURNS integer LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_policy dental.admin_notification_policy;v_now timestamptz;
BEGIN
 IF SESSION_USER<>'postgres' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE'; END IF;
 SELECT * INTO STRICT v_policy FROM dental.admin_notification_policy WHERE singleton FOR UPDATE;
 v_now:=dental.clock_now();
 IF p_operator IS NULL OR NOT EXISTS(SELECT FROM dental.accounts WHERE id=p_operator) OR p_enabled IS NULL
  OR p_expected_version IS NULL OR p_reason IS NULL OR pg_catalog.char_length(pg_catalog.btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
 IF v_policy.version<>p_expected_version THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VERSION_CONFLICT'; END IF;
 IF p_enabled AND (p_activation_at IS NULL OR p_authorized_end_at IS NULL OR NOT pg_catalog.isfinite(p_activation_at)
  OR NOT pg_catalog.isfinite(p_authorized_end_at) OR p_activation_at<v_now OR p_authorized_end_at<=p_activation_at) THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
 -- A new activation boundary cannot resurrect pending rows from the previous window.
 UPDATE dental.admin_booking_deliveries SET state='suppressed',safe_reason='policy_disabled',lease_owner=NULL,lease_until=NULL,authorization_valid_until=NULL
  WHERE state IN ('queued','retry','paused_quota','leased');
 UPDATE dental.admin_notification_policy SET enabled=p_enabled,version=version+1,
  activation_at=CASE WHEN p_enabled THEN p_activation_at ELSE NULL END,
  authorized_end_at=CASE WHEN p_enabled THEN p_authorized_end_at ELSE NULL END WHERE singleton;
 INSERT INTO dental.audit_events(actor_account_id,action,reason,occurred_at)
 VALUES(p_operator,'admin_notification_policy_changed',pg_catalog.btrim(p_reason),v_now);
 RETURN v_policy.version+1;
END;
$body$;
CREATE FUNCTION dental._enqueue_admin_booking(p dental.appointments)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_policy dental.admin_notification_policy;v_event uuid;v_now timestamptz;
BEGIN
 SELECT * INTO STRICT v_policy FROM dental.admin_notification_policy WHERE singleton FOR SHARE;
 v_now:=dental.clock_now();
 IF NOT v_policy.enabled OR p.created_at<v_policy.activation_at OR p.created_at>=v_policy.authorized_end_at
  OR v_now>=v_policy.authorized_end_at OR v_now>=p.created_at+interval '24 hours' THEN RETURN; END IF;
 INSERT INTO dental.admin_booking_events(appointment_id,created_at,expires_at,reference,requested_date)
 VALUES(p.id,p.created_at,p.created_at+interval '24 hours',p.reference,p.date) RETURNING id INTO v_event;
 -- Exactly one statement snapshot, no grant row locks and no caller-supplied recipient.
 INSERT INTO dental.admin_booking_deliveries(event_id,grant_id,account_id,recipient_index,frozen_provider,frozen_recipient,state,safe_reason,created_at,due_at)
 SELECT v_event,id,account_id,recipient_index,
  CASE WHEN mapped THEN provider ELSE NULL END,CASE WHEN mapped THEN subject ELSE NULL END,
  CASE WHEN mapped AND reachable AND identity_index=1 THEN 'queued' ELSE 'suppressed' END,
  CASE WHEN NOT mapped THEN 'mapping_unavailable' WHEN reachable IS NOT TRUE THEN 'recipient_unavailable' WHEN identity_index>1 THEN 'duplicate_recipient' ELSE NULL END,
  p.created_at,p.created_at
 FROM (SELECT g.id,g.account_id,a.provider,a.subject,r.reachable,
   a.provider~'^line:[A-Za-z0-9_-]{1,100}$' AND a.subject~'^U[0-9a-f]{32}$' AS mapped,
   pg_catalog.row_number() OVER(ORDER BY g.granted_at,g.id)::integer AS recipient_index,
   pg_catalog.row_number() OVER(PARTITION BY a.subject ORDER BY
    CASE WHEN a.provider~'^line:[A-Za-z0-9_-]{1,100}$' AND a.subject~'^U[0-9a-f]{32}$' AND r.reachable IS TRUE THEN 0 ELSE 1 END,g.granted_at,g.id) AS identity_index
  FROM dental.admin_grants g JOIN dental.accounts a ON a.id=g.account_id
  LEFT JOIN dental.line_reachability r ON r.provider=a.provider AND r.subject=a.subject
  WHERE g.revoked_at IS NULL) snapshot;
END;
$body$;
REVOKE ALL ON FUNCTION dental.set_admin_notification_policy(uuid,integer,boolean,timestamptz,timestamptz,text),dental._enqueue_admin_booking(dental.appointments) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dental.set_admin_notification_policy(uuid,integer,boolean,timestamptz,timestamptz,text) TO postgres;
$definitions$;
 EXECUTE pg_catalog.replace(v_reserve_definition,v_reserve_source,v_expected_reserve);
 EXECUTE pg_catalog.replace(v_admin_definition,v_admin_source,v_expected_admin);
 RESET ROLE;
 REVOKE CREATE ON SCHEMA dental FROM dental_function_owner;
 REVOKE dental_function_owner FROM postgres GRANTED BY postgres;
 PERFORM pg_catalog.set_config('lock_timeout',v_original_lock_timeout,true);

 SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid) INTO v_existing_functions_after FROM pg_catalog.pg_proc p
 WHERE pronamespace=v_schema AND p.oid IN (SELECT (item->>'oid')::oid FROM pg_catalog.jsonb_array_elements(v_existing_functions) item);
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY roleid,member,grantor),'[]'::jsonb) INTO v_memberships_after FROM pg_catalog.pg_auth_members m WHERE m.roleid IN(v_owner,v_backend,v_runtime) OR m.member IN(v_owner,v_backend,v_runtime);
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.oid),'[]'::jsonb) INTO v_defaults_after FROM pg_catalog.pg_default_acl d WHERE d.defaclrole IN(v_postgres,v_owner);
 SELECT pg_catalog.jsonb_build_object(
  'tables',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c) ORDER BY c.oid) FROM pg_catalog.pg_class c WHERE c.oid=ANY(v_old_tables)),
  'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.attrelid,a.attnum) FROM pg_catalog.pg_attribute a WHERE a.attrelid=ANY(v_old_tables)),
  'policies',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid) FROM pg_catalog.pg_policy p WHERE p.polrelid=ANY(v_old_tables)),
  'triggers',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_trigger t WHERE t.tgrelid=ANY(v_old_tables)
   AND NOT(t.tgisinternal AND EXISTS(SELECT FROM pg_catalog.pg_constraint c WHERE c.oid=t.tgconstraint
    AND c.contype='f' AND c.conrelid IN ('dental.admin_booking_events'::regclass,'dental.admin_booking_deliveries'::regclass,'dental.admin_notification_attempts'::regclass))))
 ) INTO v_catalog_after;
 IF v_existing_functions IS DISTINCT FROM v_existing_functions_after OR v_memberships IS DISTINCT FROM v_memberships_after
 OR v_defaults IS DISTINCT FROM v_defaults_after OR v_catalog IS DISTINCT FROM v_catalog_after
 OR CURRENT_USER<>'postgres' OR pg_catalog.current_setting('role')<>'none' THEN
  RAISE EXCEPTION 'Admin booking migration changed unrelated catalogs or failed to restore access' USING DETAIL=pg_catalog.jsonb_build_object('functions',v_existing_functions IS DISTINCT FROM v_existing_functions_after,'memberships',v_memberships IS DISTINCT FROM v_memberships_after,'defaults',v_defaults IS DISTINCT FROM v_defaults_after,'tables',v_catalog->'tables' IS DISTINCT FROM v_catalog_after->'tables','columns',v_catalog->'columns' IS DISTINCT FROM v_catalog_after->'columns','policies',v_catalog->'policies' IS DISTINCT FROM v_catalog_after->'policies','triggers',v_catalog->'triggers' IS DISTINCT FROM v_catalog_after->'triggers')::text; END IF;
END;
$admin_booking$;
