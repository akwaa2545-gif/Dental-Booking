-- UNEXECUTED Task 8 managed-Supabase candidate. Source review is not permission
-- to apply SQL, create persistent access, configure schedules or send messages.
-- Separate exact-project approval must cover two private tables, columns, eight
-- RLS policies, four backend RPCs, two owner-only helpers, the INSERT trigger
-- and temporary operator membership. One atomic statement, requires Tasks 3-7.
-- This revision targets only the reviewed PG17 staging runtime-role baseline.
-- Existing accounts, bookings and app-admin rows are preserved; no empty-table
-- assumption or synthetic business transition is permitted by this migration.
-- Existing Task 7 decisions/cancellation remain unchanged. Its strict <18:00
-- approval boundary intentionally preserves the established product behavior.
-- Prepared V1 payload inputs and recipient are immutable across all retries.
-- Retain the immutable V1 renderer in the Worker when adding future templates.
DO $task8$
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
 v_function record; v_table record; v_column record; v_role text;
 v_grantee record; v_backend_functions oid[]; v_new_policies text[]:=ARRAY['reachability_function_read','reachability_function_insert','reachability_function_update','webhook_events_function_read','webhook_events_function_insert','attempts_function_read','attempts_function_insert','attempts_function_update'];
 v_policies_before jsonb; v_policies_after jsonb;
 v_new_functions oid[];
BEGIN
 -- A statement timer must already be running when this DO starts; setting it
 -- inside an executing DO is not a substitute. The whole migration is capped.
 IF (SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name = 'statement_timeout') NOT BETWEEN 1 AND 120000 THEN
  RAISE EXCEPTION 'Task 8 requires an inherited statement timeout between 1ms and 2min';
 END IF;
 IF CURRENT_USER<>'postgres' OR SESSION_USER<>'postgres' OR v_major<>17
  OR pg_catalog.current_setting('role')<>'none'
  OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
  OR pg_catalog.current_setting('transaction_read_only')<>'off'
  OR pg_catalog.to_regprocedure('dental.decide(uuid,uuid,integer,text,text)') IS NULL
  OR pg_catalog.to_regprocedure('dental.claim_events(uuid,integer)') IS NOT NULL
  OR pg_catalog.to_regclass('dental.line_reachability') IS NOT NULL
  OR pg_catalog.to_regclass('dental.line_webhook_events') IS NOT NULL THEN
  RAISE EXCEPTION 'Task 8 requires the verified Task 7 managed baseline and unapplied notification migration';
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
  RAISE EXCEPTION 'Unreviewed Task 8 private/runtime role attributes or role settings';
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
  RAISE EXCEPTION 'Unreviewed exact Task 8 runtime membership baseline';
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
  INTO v_defaults FROM pg_catalog.pg_default_acl d WHERE d.defaclrole=v_postgres;
 SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('oid',p.oid,'definition',pg_catalog.pg_get_functiondef(p.oid),'acl',p.proacl) ORDER BY p.oid)
  INTO v_existing_functions FROM pg_catalog.pg_proc p WHERE p.pronamespace=v_schema;
 IF pg_catalog.jsonb_array_length(v_existing_functions)<>24 THEN RAISE EXCEPTION 'Unexpected Task 7 function set'; END IF;

 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid),'[]'::jsonb)
  INTO v_policies_before FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class t ON t.oid=p.polrelid WHERE t.relnamespace=v_schema;
 IF EXISTS(SELECT FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class t ON t.oid=p.polrelid
  WHERE t.relnamespace=v_schema AND p.polname=ANY(v_new_policies)) THEN
  RAISE EXCEPTION 'Notification policies already exist; inspect instead of reapplying';
 END IF;
 -- Take the same ACCESS EXCLUSIVE outbox lock needed by ALTER TABLE before
 -- checking trigger/rule side effects, so concurrent DDL cannot change the guard.
 -- Abort a lock wait after three seconds; the inherited timer caps total work.
 PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
 LOCK TABLE dental.outbox IN ACCESS EXCLUSIVE MODE;
 -- The metadata-only backfill must not invoke an unreviewed business trigger
 -- or rewrite rule. Existing foreign-key/internal constraint triggers remain.
 IF EXISTS(SELECT FROM pg_catalog.pg_trigger WHERE tgrelid='dental.outbox'::pg_catalog.regclass AND NOT tgisinternal)
  OR EXISTS(SELECT FROM pg_catalog.pg_rewrite WHERE ev_class='dental.outbox'::pg_catalog.regclass) THEN
  RAISE EXCEPTION 'Unreviewed outbox trigger or rewrite rule';
 END IF;
 GRANT dental_function_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
 GRANT CREATE ON SCHEMA dental TO dental_function_owner;

 ALTER TABLE dental.outbox
  ADD COLUMN appointment_date date,
  ADD COLUMN dispatch_provider text,
  ADD COLUMN dispatch_recipient text,
  ADD COLUMN dispatch_reference text,
  ADD COLUMN dispatch_status text,
  ADD COLUMN dispatch_manage_url text,
  ADD COLUMN failure_category text CHECK(failure_category IS NULL OR failure_category IN ('timeout','transport','server_error','quota','rate_limited','recipient_unavailable','invalid_request','unauthorized','forbidden','unknown')),
  ADD CONSTRAINT outbox_frozen_v1 CHECK(
   (dispatch_provider IS NULL AND dispatch_recipient IS NULL AND dispatch_reference IS NULL AND dispatch_status IS NULL AND dispatch_manage_url IS NULL)
   OR (dispatch_provider IS NOT NULL AND dispatch_provider~'^line:[A-Za-z0-9_-]{1,100}$'
    AND dispatch_recipient IS NOT NULL AND dispatch_recipient~'^U[0-9a-f]{32}$'
    AND dispatch_reference IS NOT NULL AND pg_catalog.char_length(dispatch_reference) BETWEEN 1 AND 80
    AND dispatch_status IS NOT NULL AND dispatch_status IN ('approved','rejected')
    AND dispatch_manage_url IS NOT NULL AND pg_catalog.char_length(dispatch_manage_url) BETWEEN 1 AND 2080));
 -- Appointment dates are immutable through every existing runtime RPC. Capture
 -- the date for legacy rows once, using the owner policy rather than bypassing RLS.
 GRANT UPDATE(appointment_date) ON dental.outbox TO dental_function_owner;
 SET LOCAL ROLE dental_function_owner;
 UPDATE dental.outbox o SET appointment_date=a.date FROM dental.appointments a
  WHERE a.id=o.appointment_id AND o.appointment_date IS NULL;
 RESET ROLE;
 REVOKE UPDATE(appointment_date) ON dental.outbox FROM dental_function_owner;
 ALTER TABLE dental.outbox ALTER COLUMN appointment_date SET NOT NULL;

 CREATE TABLE dental.line_reachability(
  provider text NOT NULL CHECK(provider~'^line:[A-Za-z0-9_-]{1,100}$'),
  subject text NOT NULL CHECK(subject~'^U[0-9a-f]{32}$'),
  reachable boolean NOT NULL,
  event_at timestamptz NOT NULL CHECK(pg_catalog.isfinite(event_at)),
  event_id text NOT NULL CHECK(event_id~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(provider,subject)
 );
 -- Retain only validated event identity/order facts. Never persist webhook bodies,
 -- tokens, profiles, display names or appointment/patient details here.
 CREATE TABLE dental.line_webhook_events(
  provider text NOT NULL CHECK(provider~'^line:[A-Za-z0-9_-]{1,100}$'),
  event_id text NOT NULL CHECK(event_id~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$'),
  subject text NOT NULL CHECK(subject~'^U[0-9a-f]{32}$'),
  event_at timestamptz NOT NULL CHECK(pg_catalog.isfinite(event_at)),
  reachable boolean NOT NULL,
  recorded_at timestamptz NOT NULL,
  PRIMARY KEY(provider,event_id)
 );
 ALTER TABLE dental.line_reachability ENABLE ROW LEVEL SECURITY;
 ALTER TABLE dental.line_reachability FORCE ROW LEVEL SECURITY;
 ALTER TABLE dental.line_webhook_events ENABLE ROW LEVEL SECURITY;
 ALTER TABLE dental.line_webhook_events FORCE ROW LEVEL SECURITY;
 REVOKE ALL ON dental.line_reachability,dental.line_webhook_events FROM PUBLIC;
 FOR v_grantee IN SELECT DISTINCT c.relname,r.rolname FROM pg_catalog.pg_class c
  CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a JOIN pg_catalog.pg_roles r ON r.oid=a.grantee
  WHERE c.oid IN ('dental.line_reachability'::pg_catalog.regclass,'dental.line_webhook_events'::pg_catalog.regclass) AND a.grantee<>c.relowner
 LOOP EXECUTE pg_catalog.format('REVOKE ALL ON TABLE dental.%I FROM %I',v_grantee.relname,v_grantee.rolname); END LOOP;
 GRANT SELECT,INSERT ON dental.line_reachability,dental.line_webhook_events,dental.notification_attempts TO dental_function_owner;
 GRANT UPDATE(reachable,event_at,event_id,updated_at) ON dental.line_reachability TO dental_function_owner;
 GRANT UPDATE(finished_at,result,provider_request_id,error_category) ON dental.notification_attempts TO dental_function_owner;
 GRANT UPDATE(due_at,attempt_count,first_attempt_at,accepted_at,dispatch_provider,dispatch_recipient,dispatch_reference,dispatch_status,dispatch_manage_url,failure_category) ON dental.outbox TO dental_function_owner;
 CREATE POLICY reachability_function_read ON dental.line_reachability FOR SELECT TO dental_function_owner USING(true);
 CREATE POLICY reachability_function_insert ON dental.line_reachability FOR INSERT TO dental_function_owner WITH CHECK(true);
 CREATE POLICY reachability_function_update ON dental.line_reachability FOR UPDATE TO dental_function_owner USING(true) WITH CHECK(true);
 CREATE POLICY webhook_events_function_read ON dental.line_webhook_events FOR SELECT TO dental_function_owner USING(true);
 CREATE POLICY webhook_events_function_insert ON dental.line_webhook_events FOR INSERT TO dental_function_owner WITH CHECK(true);
 CREATE POLICY attempts_function_read ON dental.notification_attempts FOR SELECT TO dental_function_owner USING(true);
 CREATE POLICY attempts_function_insert ON dental.notification_attempts FOR INSERT TO dental_function_owner WITH CHECK(true);
 CREATE POLICY attempts_function_update ON dental.notification_attempts FOR UPDATE TO dental_function_owner USING(true) WITH CHECK(true);

 SET LOCAL ROLE dental_function_owner;
 EXECUTE $definitions$
CREATE FUNCTION dental._outbox_event_json(p dental.outbox)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path=''
AS $body$
 SELECT pg_catalog.jsonb_build_object('id',(p).id,'appointmentId',(p).appointment_id,
  'appointmentVersion',(p).appointment_version,'type',(p).type,'retryKey',(p).retry_key,
  'dueAt',(p).due_at,'expiresAt',(p).expires_at)
$body$;

CREATE FUNCTION dental._capture_outbox_date()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
BEGIN
 -- Task 7 already holds date -> appointment before INSERT. No network or new
 -- event is produced by this trigger, and caller input cannot choose this date.
 SELECT a.date INTO STRICT NEW.appointment_date FROM dental.appointments a WHERE a.id=NEW.appointment_id;
 RETURN NEW;
END;
$body$;

CREATE FUNCTION dental.record_line_reachability(p_provider text,p_subject text,p_event_id text,p_event_at timestamptz,p_reachable boolean)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_now timestamptz:=dental.clock_now(); v_inserted integer;
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE'; END IF;
 IF p_provider IS NULL OR p_provider!~'^line:[A-Za-z0-9_-]{1,100}$'
  OR p_subject IS NULL OR p_subject!~'^U[0-9a-f]{32}$'
  OR p_event_id IS NULL OR p_event_id!~'^[0-7][0-9A-HJKMNP-TV-Z]{25}$'
  OR p_event_at IS NULL OR NOT pg_catalog.isfinite(p_event_at) OR p_event_at>v_now+interval '5 minutes'
  OR p_reachable IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
 INSERT INTO dental.line_webhook_events(provider,event_id,subject,event_at,reachable,recorded_at)
  VALUES(p_provider,p_event_id,p_subject,p_event_at,p_reachable,v_now) ON CONFLICT(provider,event_id) DO NOTHING;
 GET DIAGNOSTICS v_inserted=ROW_COUNT;
 IF v_inserted=0 THEN RETURN false; END IF;
 INSERT INTO dental.line_reachability(provider,subject,reachable,event_at,event_id,updated_at)
  VALUES(p_provider,p_subject,p_reachable,p_event_at,p_event_id,v_now)
  ON CONFLICT(provider,subject) DO UPDATE SET reachable=EXCLUDED.reachable,event_at=EXCLUDED.event_at,event_id=EXCLUDED.event_id,updated_at=EXCLUDED.updated_at
  WHERE EXCLUDED.event_at>dental.line_reachability.event_at
   OR (EXCLUDED.event_at=dental.line_reachability.event_at AND NOT EXCLUDED.reachable AND dental.line_reachability.reachable);
 RETURN true;
END;
$body$;

CREATE FUNCTION dental.claim_events(p_worker uuid,p_limit integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_event dental.outbox; v_now timestamptz; v_result jsonb:='[]'::jsonb;
 v_retry_at timestamptz; v_delay integer[]:=ARRAY[1,5,15,60,180];
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE'; END IF;
 IF p_worker IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
 -- Claim-only transactions lock outbox rows and never later acquire date or
 -- appointment locks. Preparation is a separate committed transaction.
 FOR v_event IN SELECT o.* FROM dental.outbox o
  WHERE ((o.state IN ('queued','retry') AND o.due_at<=dental.clock_now())
   OR (o.state='leased' AND o.lease_until<=dental.clock_now()))
   AND NOT EXISTS(SELECT FROM dental.notification_attempts a WHERE a.outbox_id=o.id AND a.worker_id=p_worker)
  ORDER BY o.due_at,o.id LIMIT p_limit FOR UPDATE SKIP LOCKED
 LOOP
  v_now:=dental.clock_now();
  IF v_event.state='leased' THEN
   -- A crash after LINE acceptance is an uncertain timeout. Finalize the old
   -- attempt, retain its key/payload and start backoff at lease expiry.
   UPDATE dental.notification_attempts SET finished_at=v_now,result='retryable',error_category='timeout'
    WHERE outbox_id=v_event.id AND attempt_number=v_event.attempt_count AND finished_at IS NULL;
   IF FOUND AND v_event.attempt_count<6 THEN
    v_retry_at:=v_event.lease_until+v_delay[v_event.attempt_count]*interval '1 minute';
    v_event.due_at:=v_retry_at;
   END IF;
  END IF;
  IF v_event.attempt_count>=6 OR (v_event.first_attempt_at IS NOT NULL AND v_now>=v_event.first_attempt_at+interval '24 hours') THEN
   UPDATE dental.outbox SET state='failed',failure_category='timeout',lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=v_event.id;
  ELSIF v_now>=v_event.expires_at THEN
   UPDATE dental.outbox SET state='suppressed',lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=v_event.id;
  ELSIF v_event.due_at>=v_event.expires_at OR (v_event.first_attempt_at IS NOT NULL AND v_event.due_at>=v_event.first_attempt_at+interval '24 hours') THEN
   UPDATE dental.outbox SET state='failed',failure_category='timeout',lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=v_event.id;
  ELSIF v_event.due_at>v_now THEN
   UPDATE dental.outbox SET state='retry',due_at=v_event.due_at,lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=v_event.id;
  ELSE
   UPDATE dental.outbox SET state='leased',due_at=v_event.due_at,lease_owner=p_worker,lease_until=v_now+interval '60 seconds',updated_at=v_now
    WHERE id=v_event.id RETURNING * INTO v_event;
   v_result:=v_result||pg_catalog.jsonb_build_array(dental._outbox_event_json(v_event));
  END IF;
 END LOOP;
 RETURN v_result;
END;
$body$;

CREATE FUNCTION dental.prepare_dispatch(p_worker uuid,p_event uuid,p_manage_origin text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_date date; v_appointment_id uuid; v_appointment dental.appointments;
 v_event dental.outbox; v_provider text; v_recipient text; v_reachable boolean; v_now timestamptz;
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE'; END IF;
 IF p_worker IS NULL OR p_event IS NULL OR p_manage_origin IS NULL OR pg_catalog.char_length(p_manage_origin)>2048
  OR p_manage_origin!~'^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
 -- Read only immutable event lock keys, then acquire the universal order.
 SELECT appointment_date,appointment_id INTO v_date,v_appointment_id FROM dental.outbox WHERE id=p_event;
 IF NOT FOUND THEN RETURN NULL; END IF;
 PERFORM date FROM dental.clinic_dates WHERE date=v_date FOR UPDATE;
 SELECT * INTO v_appointment FROM dental.appointments WHERE id=v_appointment_id FOR UPDATE;
 SELECT * INTO v_event FROM dental.outbox WHERE id=p_event FOR UPDATE;
 v_now:=dental.clock_now();
 IF v_event.state IS DISTINCT FROM 'leased' OR v_event.lease_owner IS DISTINCT FROM p_worker OR v_event.lease_until<=v_now THEN RETURN NULL; END IF;
 IF v_appointment.id IS NULL OR v_appointment.date IS DISTINCT FROM v_event.appointment_date
  OR v_appointment.version<>v_event.appointment_version
  OR (v_event.type IN ('approval','reminder') AND v_appointment.status<>'approved')
  OR (v_event.type='rejection' AND v_appointment.status<>'rejected')
  OR v_now>=v_event.expires_at OR v_now<v_event.due_at
  OR (v_event.type='reminder' AND (v_now<pg_catalog.timezone('Asia/Bangkok',(v_date-1)+time '18:00')
   OR v_now>=pg_catalog.timezone('Asia/Bangkok',v_date::timestamp))) THEN
  UPDATE dental.outbox SET state='suppressed',lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=p_event;
  RETURN NULL;
 END IF;
 IF v_event.attempt_count>=6 OR (v_event.first_attempt_at IS NOT NULL AND v_now>=v_event.first_attempt_at+interval '24 hours') THEN
  UPDATE dental.outbox SET state='failed',failure_category='timeout',lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=p_event;
  RETURN NULL;
 END IF;
 -- A fresh worker UUID is mandatory for each attempted send of this event.
 -- This also fences late callbacks if a caller accidentally reuses an old UUID.
 IF EXISTS(SELECT FROM dental.notification_attempts WHERE outbox_id=p_event AND worker_id=p_worker) THEN RETURN NULL; END IF;
 -- Repeated prepare with the same claim must never authorize two HTTP calls.
 IF EXISTS(SELECT FROM dental.notification_attempts WHERE outbox_id=p_event AND attempt_number=v_event.attempt_count AND finished_at IS NULL) THEN RETURN NULL; END IF;
 IF v_event.dispatch_recipient IS NULL THEN
  SELECT provider,subject INTO v_provider,v_recipient FROM dental.accounts WHERE id=v_appointment.owner_account_id;
 ELSE
  v_provider:=v_event.dispatch_provider; v_recipient:=v_event.dispatch_recipient;
 END IF;
 SELECT reachable INTO v_reachable FROM dental.line_reachability WHERE provider=v_provider AND subject=v_recipient FOR SHARE;
 -- Reachability might itself have waited; time must be fresh after every lock.
 v_now:=dental.clock_now();
 IF v_event.lease_until<=v_now THEN RETURN NULL; END IF;
 IF v_now>=v_event.expires_at THEN
  UPDATE dental.outbox SET state='suppressed',lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=p_event; RETURN NULL;
 END IF;
 IF v_event.first_attempt_at IS NOT NULL AND v_now>=v_event.first_attempt_at+interval '24 hours' THEN
  UPDATE dental.outbox SET state='failed',failure_category='timeout',lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=p_event; RETURN NULL;
 END IF;
 IF v_reachable IS DISTINCT FROM true THEN
  UPDATE dental.outbox SET state='failed',failure_category='recipient_unavailable',lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=p_event;
  RETURN NULL;
 END IF;
 IF v_event.dispatch_recipient IS NULL THEN
  UPDATE dental.outbox SET dispatch_provider=v_provider,dispatch_recipient=v_recipient,dispatch_reference=v_appointment.reference,
   dispatch_status=v_appointment.status,dispatch_manage_url=p_manage_origin||'/appointments' WHERE id=p_event;
 END IF;
 UPDATE dental.outbox SET attempt_count=attempt_count+1,first_attempt_at=COALESCE(first_attempt_at,v_now),failure_category=NULL,
  lease_until=v_now+interval '60 seconds',updated_at=v_now WHERE id=p_event RETURNING * INTO v_event;
 INSERT INTO dental.notification_attempts(outbox_id,attempt_number,worker_id,started_at)
  VALUES(p_event,v_event.attempt_count,p_worker,v_now);
 RETURN pg_catalog.jsonb_build_object('event',dental._outbox_event_json(v_event),'recipient',v_event.dispatch_recipient,
  'date',pg_catalog.to_char(v_event.appointment_date,'YYYY-MM-DD'),'reference',v_event.dispatch_reference,'status',v_event.dispatch_status,
  'manageUrl',v_event.dispatch_manage_url,'payloadVersion',1);
END;
$body$;

CREATE FUNCTION dental.finish_dispatch(p_worker uuid,p_event uuid,p_result jsonb)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_event dental.outbox; v_attempt dental.notification_attempts; v_now timestamptz;
 v_kind text; v_category text; v_request text; v_next timestamptz; v_delay integer[]:=ARRAY[1,5,15,60,180];
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE'; END IF;
 IF p_worker IS NULL OR p_event IS NULL OR p_result IS NULL OR pg_catalog.jsonb_typeof(p_result)<>'object'
  OR p_result->>'kind' IS NULL OR p_result->>'kind' NOT IN ('accepted','retryable','permanent') THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
 v_kind:=p_result->>'kind';
 v_request:=CASE WHEN pg_catalog.jsonb_typeof(p_result->'requestId')='string' AND p_result->>'requestId'~'^[A-Za-z0-9_-]{1,128}$' THEN p_result->>'requestId' ELSE NULL END;
 v_category:=CASE WHEN v_kind='accepted' THEN NULL WHEN p_result->>'category' IN ('timeout','transport','server_error','quota','rate_limited','recipient_unavailable','invalid_request','unauthorized','forbidden','unknown') THEN p_result->>'category' ELSE 'unknown' END;
 -- Finish only locks outbox -> attempt and never seeks date/appointment locks.
 SELECT * INTO v_event FROM dental.outbox WHERE id=p_event FOR UPDATE;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO v_attempt FROM dental.notification_attempts WHERE outbox_id=p_event AND attempt_number=v_event.attempt_count FOR UPDATE;
 v_now:=dental.clock_now();
 IF v_attempt.id IS NULL OR v_attempt.worker_id IS DISTINCT FROM p_worker OR v_attempt.finished_at IS NOT NULL THEN RETURN false; END IF;
 IF v_event.state='suppressed' THEN
  -- Cancellation after send started cannot recall it. Keep the actual safe
  -- attempt outcome without undoing cancellation or resurrecting the event.
  UPDATE dental.notification_attempts SET finished_at=v_now,result=v_kind,provider_request_id=v_request,error_category=v_category WHERE id=v_attempt.id;
  RETURN true;
 END IF;
 IF v_event.state<>'leased' OR v_event.lease_owner IS DISTINCT FROM p_worker OR v_event.lease_until<=v_now THEN RETURN false; END IF;
 UPDATE dental.notification_attempts SET finished_at=v_now,result=v_kind,provider_request_id=v_request,error_category=v_category WHERE id=v_attempt.id;
 IF v_kind='accepted' THEN
  UPDATE dental.outbox SET state='accepted',accepted_at=v_now,failure_category=NULL,lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=p_event;
 ELSE
  v_next:=v_now+v_delay[v_event.attempt_count]*interval '1 minute';
  -- Quota/rate-limit reports require operational review even if a caller wrongly
  -- labels them transient. No tight loop and no booking-state side effect.
  IF v_kind='permanent' OR v_category IN ('quota','rate_limited') OR v_event.attempt_count>=6
   OR v_next>=v_event.expires_at OR v_next>=v_event.first_attempt_at+interval '24 hours' THEN
   UPDATE dental.outbox SET state='failed',failure_category=v_category,lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=p_event;
  ELSE
   UPDATE dental.outbox SET state='retry',due_at=v_next,failure_category=v_category,lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=p_event;
  END IF;
 END IF;
 RETURN true;
END;
$body$;

REVOKE ALL ON FUNCTION dental._outbox_event_json(dental.outbox),dental._capture_outbox_date(),dental.claim_events(uuid,integer),dental.prepare_dispatch(uuid,uuid,text),dental.finish_dispatch(uuid,uuid,jsonb),dental.record_line_reachability(text,text,text,timestamptz,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dental.claim_events(uuid,integer),dental.prepare_dispatch(uuid,uuid,text),dental.finish_dispatch(uuid,uuid,jsonb),dental.record_line_reachability(text,text,text,timestamptz,boolean) TO dental_backend;
-- Temporary operator execute is needed only to create its trigger; no lasting
-- postgres execution permission or runtime TRIGGER table privilege is added.
GRANT EXECUTE ON FUNCTION dental._capture_outbox_date() TO postgres;
$definitions$;
 RESET ROLE;
 CREATE TRIGGER outbox_capture_appointment_date BEFORE INSERT ON dental.outbox FOR EACH ROW EXECUTE FUNCTION dental._capture_outbox_date();
 SET LOCAL ROLE dental_function_owner;
 REVOKE EXECUTE ON FUNCTION dental._capture_outbox_date() FROM postgres;
 RESET ROLE;
 REVOKE CREATE ON SCHEMA dental FROM dental_function_owner;
 REVOKE dental_function_owner FROM postgres GRANTED BY postgres;

 v_backend_functions:=ARRAY['dental.claim_events(uuid,integer)'::pg_catalog.regprocedure::oid,'dental.prepare_dispatch(uuid,uuid,text)'::pg_catalog.regprocedure::oid,
  'dental.finish_dispatch(uuid,uuid,jsonb)'::pg_catalog.regprocedure::oid,'dental.record_line_reachability(text,text,text,timestamptz,boolean)'::pg_catalog.regprocedure::oid];
 v_new_functions:=v_backend_functions||ARRAY['dental._outbox_event_json(dental.outbox)'::pg_catalog.regprocedure::oid,'dental._capture_outbox_date()'::pg_catalog.regprocedure::oid];
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY roleid,member,grantor),'[]'::jsonb)
  INTO v_memberships_after FROM pg_catalog.pg_auth_members m
  WHERE m.roleid IN (v_owner,v_backend,v_runtime) OR m.member IN (v_owner,v_backend,v_runtime);
 SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r)-'rolpassword' ORDER BY r.oid)
  INTO v_roles_after FROM pg_catalog.pg_roles r WHERE r.oid IN (v_owner,v_backend,v_runtime);
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s) ORDER BY s.setdatabase,s.setrole),'[]'::jsonb)
  INTO v_role_settings_after FROM pg_catalog.pg_db_role_setting s WHERE s.setrole IN (v_owner,v_backend,v_runtime);
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.oid),'[]'::jsonb)
  INTO v_defaults_after FROM pg_catalog.pg_default_acl d WHERE d.defaclrole=v_postgres;
 SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('oid',p.oid,'definition',pg_catalog.pg_get_functiondef(p.oid),'acl',p.proacl) ORDER BY p.oid)
  INTO v_existing_functions_after FROM pg_catalog.pg_proc p WHERE p.pronamespace=v_schema AND p.oid<>ALL(v_new_functions);
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid),'[]'::jsonb)
  INTO v_policies_after FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class t ON t.oid=p.polrelid WHERE t.relnamespace=v_schema AND p.polname<>ALL(v_new_policies);
 IF v_memberships IS DISTINCT FROM v_memberships_after OR v_defaults IS DISTINCT FROM v_defaults_after
  OR v_roles IS DISTINCT FROM v_roles_after OR v_role_settings IS DISTINCT FROM v_role_settings_after
  OR v_existing_functions IS DISTINCT FROM v_existing_functions_after OR v_policies_before IS DISTINCT FROM v_policies_after
  OR pg_catalog.has_schema_privilege(v_owner,v_schema,'CREATE') OR pg_catalog.has_schema_privilege(v_backend,v_schema,'CREATE')
  OR pg_catalog.has_schema_privilege(v_runtime,v_schema,'CREATE') OR pg_catalog.pg_has_role(v_runtime,v_owner,'MEMBER') THEN
  RAISE EXCEPTION 'Task 8 changed an existing function/default/policy or did not restore temporary access';
 END IF;
 IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc WHERE pronamespace=v_schema)<>30 THEN RAISE EXCEPTION 'Unexpected Task 8 function surface'; END IF;
 FOR v_function IN SELECT * FROM pg_catalog.pg_proc WHERE oid=ANY(v_new_functions) LOOP
  IF v_function.proowner<>v_owner OR v_function.prosecdef IS DISTINCT FROM (v_function.proname<>'_outbox_event_json')
   OR NOT COALESCE(v_function.proconfig @> ARRAY['search_path=""'],false)
   OR pg_catalog.has_function_privilege(v_backend,v_function.oid,'EXECUTE') IS DISTINCT FROM (v_function.oid=ANY(v_backend_functions))
   OR pg_catalog.has_function_privilege(v_postgres,v_function.oid,'EXECUTE')
   OR EXISTS(SELECT FROM pg_catalog.aclexplode(COALESCE(v_function.proacl,pg_catalog.acldefault('f',v_owner))) a
    WHERE a.grantee<>v_owner AND NOT(a.grantee=v_backend AND v_function.oid=ANY(v_backend_functions)
     AND a.grantor=v_owner AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)) THEN
   RAISE EXCEPTION 'Unsafe new private notification function ownership, search path or execute ACL';
  END IF;
 END LOOP;
 FOR v_table IN SELECT * FROM pg_catalog.pg_class WHERE relnamespace=v_schema AND relkind='r' LOOP
  IF v_table.relowner<>v_postgres OR NOT v_table.relrowsecurity OR NOT v_table.relforcerowsecurity
   OR pg_catalog.has_table_privilege(v_owner,v_table.oid,'MAINTAIN')
   OR pg_catalog.has_table_privilege(v_backend,v_table.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
   OR pg_catalog.has_any_column_privilege(v_backend,v_table.oid,'SELECT,INSERT,UPDATE,REFERENCES')
   OR pg_catalog.has_table_privilege(v_runtime,v_table.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
   OR pg_catalog.has_any_column_privilege(v_runtime,v_table.oid,'SELECT,INSERT,UPDATE,REFERENCES') THEN
   RAISE EXCEPTION 'Private notification table ownership, RLS or backend direct access is unsafe';
  END IF;
 END LOOP;
 FOR v_table IN SELECT * FROM (VALUES
  ('outbox',ARRAY['state','lease_owner','lease_until','updated_at','due_at','attempt_count','first_attempt_at','accepted_at','dispatch_provider','dispatch_recipient','dispatch_reference','dispatch_status','dispatch_manage_url','failure_category']),
  ('notification_attempts',ARRAY['finished_at','result','provider_request_id','error_category']),
  ('line_reachability',ARRAY['reachable','event_at','event_id','updated_at']),
  ('line_webhook_events',ARRAY[]::text[])
 ) AS expected(name,columns) LOOP
  IF pg_catalog.has_table_privilege(v_owner,pg_catalog.format('dental.%I',v_table.name),'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
   OR NOT pg_catalog.has_table_privilege(v_owner,pg_catalog.format('dental.%I',v_table.name),'SELECT')
   OR NOT pg_catalog.has_table_privilege(v_owner,pg_catalog.format('dental.%I',v_table.name),'INSERT') THEN
   RAISE EXCEPTION 'Notification owner access exceeds the reviewed column surface';
  END IF;
  FOR v_column IN SELECT * FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass(pg_catalog.format('dental.%I',v_table.name)) AND attnum>0 AND NOT attisdropped LOOP
   IF pg_catalog.has_column_privilege(v_owner,v_column.attrelid,v_column.attname,'UPDATE') IS DISTINCT FROM (v_column.attname=ANY(v_table.columns)) THEN
    RAISE EXCEPTION 'Notification owner access exceeds the reviewed column surface';
   END IF;
  END LOOP;
 END LOOP;
 IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class t ON t.oid=p.polrelid
   WHERE t.relnamespace=v_schema AND p.polname=ANY(v_new_policies))<>8
  OR EXISTS(SELECT FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class t ON t.oid=p.polrelid
   WHERE t.relnamespace=v_schema AND p.polname=ANY(v_new_policies) AND (p.polroles IS DISTINCT FROM ARRAY[v_owner]
    OR NOT p.polpermissive OR (p.polcmd IN ('r','w') AND pg_catalog.pg_get_expr(p.polqual,p.polrelid) IS DISTINCT FROM 'true')
    OR (p.polcmd IN ('a','w') AND pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid) IS DISTINCT FROM 'true'))) THEN
  RAISE EXCEPTION 'Unexpected notification RLS policy definition';
 END IF;
 FOR v_function IN SELECT * FROM pg_catalog.pg_proc WHERE pronamespace=v_schema LOOP
  IF pg_catalog.has_function_privilege(v_runtime,v_function.oid,'EXECUTE') IS DISTINCT FROM pg_catalog.has_function_privilege(v_backend,v_function.oid,'EXECUTE') THEN
   RAISE EXCEPTION 'Runtime function surface differs from inherited backend access';
  END IF;
 END LOOP;
 FOREACH v_role IN ARRAY ARRAY['anon','authenticated','authenticator','service_role'] LOOP
  IF EXISTS(SELECT FROM pg_catalog.pg_roles WHERE rolname=v_role) THEN
   IF pg_catalog.pg_has_role(v_role,v_owner,'MEMBER') OR pg_catalog.pg_has_role(v_role,v_backend,'MEMBER')
    OR pg_catalog.has_schema_privilege(v_role,v_schema,'USAGE,CREATE')
    OR EXISTS(SELECT FROM pg_catalog.pg_class t WHERE t.relnamespace=v_schema AND t.relkind='r'
     AND (pg_catalog.has_table_privilege(v_role,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
      OR pg_catalog.has_any_column_privilege(v_role,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
    OR EXISTS(SELECT FROM pg_catalog.pg_proc p WHERE p.pronamespace=v_schema AND pg_catalog.has_function_privilege(v_role,p.oid,'EXECUTE')) THEN
    RAISE EXCEPTION 'Browser/platform role has a private notification membership, schema, table or function path';
   END IF;
  END IF;
 END LOOP;
 PERFORM pg_catalog.set_config('lock_timeout', v_original_lock_timeout, true);
 IF pg_catalog.current_setting('lock_timeout') IS DISTINCT FROM v_original_lock_timeout
  OR pg_catalog.current_setting('role')<>'none' OR CURRENT_USER<>'postgres' OR SESSION_USER<>'postgres' THEN
  RAISE EXCEPTION 'Task 8 did not restore the operator session settings';
 END IF;
END;
$task8$;
