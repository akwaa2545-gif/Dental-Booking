-- UNEXECUTED Task 7 managed-Supabase candidate. Local source is not approval to
-- apply this migration or expand privileges. Exact-project approval must cover
-- four backend RPCs, one postgres-only admin-grant RPC, column-scoped owner
-- access, six private RLS policies and temporary operator SET membership.
-- Requires Task 3 + Task 4 + Task 5. One atomic statement; no runtime LOGIN,
-- credentials, browser role grants, API exposure, dispatcher or live messages.
-- Operator-only set_admin_grant records the verified operator account supplied
-- by the database operator; no client route accepts role assignments.
DO $task7$
DECLARE
 v_major integer := pg_catalog.current_setting('server_version_num')::integer / 10000;
 v_owner oid := 'dental_function_owner'::pg_catalog.regrole;
 v_backend oid := 'dental_backend'::pg_catalog.regrole;
 v_postgres oid := 'postgres'::pg_catalog.regrole;
 v_schema oid := 'dental'::pg_catalog.regnamespace;
 v_memberships jsonb; v_memberships_after jsonb; v_defaults jsonb; v_defaults_after jsonb;
 v_existing_functions jsonb; v_existing_functions_after jsonb;
 v_function record; v_table record; v_column record; v_role text;
 v_operator_function oid; v_new_policies text[]:=ARRAY['appointments_function_update','outbox_function_read','outbox_function_insert','outbox_function_update','admin_grants_function_insert','admin_grants_function_revoke'];
 v_policies_before jsonb; v_policies_after jsonb;
 v_new_functions oid[];
BEGIN
 IF CURRENT_USER<>'postgres' OR SESSION_USER<>'postgres' OR v_major NOT IN (15,17)
  OR pg_catalog.current_setting('transaction_read_only')<>'off'
  OR pg_catalog.to_regprocedure('dental.is_admin(uuid)') IS NULL
  OR pg_catalog.to_regprocedure('dental.cancel(uuid,uuid,integer)') IS NOT NULL
  OR pg_catalog.to_regprocedure('dental.decide(uuid,uuid,integer,text,text)') IS NOT NULL
  OR pg_catalog.to_regprocedure('dental.set_intake(uuid,date,text,text)') IS NOT NULL
  OR pg_catalog.to_regprocedure('dental.admin_appointments(uuid,date,text)') IS NOT NULL
  OR pg_catalog.to_regprocedure('dental.set_admin_grant(uuid,uuid,boolean,text)') IS NOT NULL THEN
  RAISE EXCEPTION 'Task 7 requires the verified Task 5 managed baseline and unapplied transition migration';
 END IF;
 IF EXISTS(SELECT FROM pg_catalog.pg_roles WHERE oid IN (v_owner,v_backend)
   AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit))
  OR EXISTS(SELECT FROM pg_catalog.pg_auth_members WHERE member IN (v_owner,v_backend)) THEN
  RAISE EXCEPTION 'Unsafe private role attributes or outgoing memberships';
 END IF;
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY roleid,member,grantor),'[]'::jsonb)
  INTO v_memberships FROM pg_catalog.pg_auth_members m WHERE roleid IN (v_owner,v_backend);
 IF (v_major=15 AND pg_catalog.jsonb_array_length(v_memberships)<>0)
  OR (v_major=17 AND (pg_catalog.jsonb_array_length(v_memberships)<>2
   OR (SELECT pg_catalog.count(DISTINCT roleid) FROM pg_catalog.pg_auth_members WHERE roleid IN (v_owner,v_backend))<>2))
  OR EXISTS(SELECT FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles g ON g.oid=m.grantor
   WHERE m.roleid IN (v_owner,v_backend) AND (v_major<>17 OR m.member<>v_postgres OR NOT g.rolsuper
    OR NOT m.admin_option OR pg_catalog.to_jsonb(m)->>'set_option' IS DISTINCT FROM 'false'
    OR pg_catalog.to_jsonb(m)->>'inherit_option' IS DISTINCT FROM 'false')) THEN
  RAISE EXCEPTION 'Unreviewed version-specific membership baseline';
 END IF;
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
 IF pg_catalog.jsonb_array_length(v_existing_functions)<>19 THEN RAISE EXCEPTION 'Unexpected Task 5 function set'; END IF;

 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid),'[]'::jsonb)
  INTO v_policies_before FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class t ON t.oid=p.polrelid WHERE t.relnamespace=v_schema;
 IF EXISTS(SELECT FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class t ON t.oid=p.polrelid
  WHERE t.relnamespace=v_schema AND p.polname=ANY(v_new_policies)) THEN
  RAISE EXCEPTION 'Transition policies already exist; inspect instead of reapplying';
 END IF;
 IF v_major=17 THEN
  EXECUTE 'GRANT dental_function_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres';
 ELSE GRANT dental_function_owner TO postgres; END IF;
 GRANT CREATE ON SCHEMA dental TO dental_function_owner;
 GRANT UPDATE(status,version,updated_at,approved_at,cancelled_at,cancelled_by) ON dental.appointments TO dental_function_owner;
 GRANT UPDATE(intake,reason,changed_by,version,updated_at) ON dental.clinic_dates TO dental_function_owner;
 GRANT SELECT,INSERT ON dental.outbox TO dental_function_owner;
 GRANT UPDATE(state,lease_owner,lease_until,updated_at) ON dental.outbox TO dental_function_owner;
 GRANT INSERT ON dental.admin_grants TO dental_function_owner;
 GRANT UPDATE(revoked_at,revoked_by) ON dental.admin_grants TO dental_function_owner;
 CREATE POLICY appointments_function_update ON dental.appointments FOR UPDATE TO dental_function_owner USING(true) WITH CHECK(true);
 CREATE POLICY outbox_function_read ON dental.outbox FOR SELECT TO dental_function_owner USING(true);
 CREATE POLICY outbox_function_insert ON dental.outbox FOR INSERT TO dental_function_owner WITH CHECK(true);
 CREATE POLICY outbox_function_update ON dental.outbox FOR UPDATE TO dental_function_owner USING(true) WITH CHECK(true);
 CREATE POLICY admin_grants_function_insert ON dental.admin_grants FOR INSERT TO dental_function_owner WITH CHECK(true);
 CREATE POLICY admin_grants_function_revoke ON dental.admin_grants FOR UPDATE TO dental_function_owner USING(true) WITH CHECK(true);

 SET LOCAL ROLE dental_function_owner;
 EXECUTE $definitions$
CREATE FUNCTION dental.cancel(p_actor uuid,p_id uuid,p_version integer)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_date date; v_appointment dental.appointments; v_now timestamptz;
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE'; END IF;
 IF p_actor IS NULL OR NOT EXISTS(SELECT FROM dental.accounts WHERE id=p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAUTHENTICATED'; END IF;
 IF p_id IS NULL OR p_version IS NULL OR p_version<1 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
 -- This unlocked ownership-scoped lookup obtains only the immutable lock key.
 -- Foreign and nonexistent IDs have precisely the same result.
 SELECT date INTO v_date FROM dental.appointments WHERE id=p_id AND owner_account_id=p_actor;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='NOT_FOUND'; END IF;
 PERFORM date FROM dental.clinic_dates WHERE date=v_date FOR UPDATE;
 SELECT * INTO v_appointment FROM dental.appointments WHERE id=p_id AND owner_account_id=p_actor FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='NOT_FOUND'; END IF;
 IF v_appointment.version<>p_version THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VERSION_CONFLICT'; END IF;
 IF v_appointment.status NOT IN ('pending','approved') THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='INVALID_TRANSITION'; END IF;
 PERFORM id FROM dental.outbox WHERE appointment_id=p_id AND state IN ('queued','retry','leased') ORDER BY id FOR UPDATE;
 -- Do not use transaction_timestamp/now: either lock may have crossed midnight.
 v_now:=dental.clock_now();
 IF NOT EXISTS(SELECT FROM dental.accounts WHERE id=p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAUTHENTICATED'; END IF;
 IF v_now>=pg_catalog.timezone('Asia/Bangkok',v_date::timestamp) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CUTOFF_PASSED'; END IF;
 UPDATE dental.appointments SET status='cancelled',version=version+1,updated_at=v_now,cancelled_at=v_now,cancelled_by=p_actor
  WHERE id=p_id RETURNING * INTO v_appointment;
 UPDATE dental.outbox SET state='suppressed',lease_owner=NULL,lease_until=NULL,updated_at=v_now
  WHERE appointment_id=p_id AND state IN ('queued','retry','leased');
 INSERT INTO dental.audit_events(actor_account_id,action,patient_id,appointment_id,clinic_date,occurred_at)
  VALUES(p_actor,'appointment_cancelled',v_appointment.patient_id,p_id,v_date,v_now);
 RETURN dental._appointment_json(v_appointment);
END;
$body$;

CREATE FUNCTION dental.decide(p_actor uuid,p_id uuid,p_version integer,p_decision text,p_reason text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE
 v_date date; v_day dental.clinic_dates; v_appointment dental.appointments;
 v_now timestamptz; v_start timestamptz; v_end timestamptz; v_midnight timestamptz; v_reminder timestamptz; v_status text;
 v_reason text:=pg_catalog.btrim(p_reason,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE'; END IF;
 IF p_actor IS NULL OR NOT EXISTS(SELECT FROM dental.accounts WHERE id=p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAUTHENTICATED'; END IF;
 IF NOT dental.is_admin(p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
 IF p_id IS NULL OR p_version IS NULL OR p_version<1 OR p_decision IS NULL OR p_decision NOT IN ('approve','reject','complete','no_show')
  OR v_reason IS NULL OR pg_catalog.char_length(v_reason) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
 SELECT date INTO v_date FROM dental.appointments WHERE id=p_id;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='NOT_FOUND'; END IF;
 SELECT * INTO STRICT v_day FROM dental.clinic_dates WHERE date=v_date FOR UPDATE;
 SELECT * INTO v_appointment FROM dental.appointments WHERE id=p_id FOR UPDATE;
 -- A revoked caller must not learn current status/version from error selection.
 -- Recheck before semantic errors, then again after possible outbox contention.
 IF NOT EXISTS(SELECT FROM dental.accounts WHERE id=p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAUTHENTICATED'; END IF;
 IF NOT dental.is_admin(p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
 IF v_appointment.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='NOT_FOUND'; END IF;
 IF v_appointment.version<>p_version THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VERSION_CONFLICT'; END IF;
 IF (p_decision IN ('approve','reject') AND v_appointment.status<>'pending')
  OR (p_decision IN ('complete','no_show') AND v_appointment.status<>'approved') THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='INVALID_TRANSITION';
 END IF;
 PERFORM id FROM dental.outbox WHERE appointment_id=p_id AND state IN ('queued','retry','leased') ORDER BY id FOR UPDATE;
 v_now:=dental.clock_now();
 IF NOT EXISTS(SELECT FROM dental.accounts WHERE id=p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAUTHENTICATED'; END IF;
 IF NOT dental.is_admin(p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
 v_start:=pg_catalog.timezone('Asia/Bangkok',v_date+time '08:30');
 v_end:=pg_catalog.timezone('Asia/Bangkok',v_date+time '09:30');
 v_midnight:=pg_catalog.timezone('Asia/Bangkok',v_date::timestamp);
 v_reminder:=pg_catalog.timezone('Asia/Bangkok',(v_date-1)+time '18:00');
 IF p_decision='approve' THEN
  IF v_day.intake<>'open' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='INTAKE_CLOSED'; END IF;
  IF v_now>=v_start THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CUTOFF_PASSED'; END IF;
 ELSIF p_decision IN ('complete','no_show') AND v_now<v_end THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='CUTOFF_PASSED';
 END IF;
 v_status:=CASE p_decision WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' WHEN 'complete' THEN 'completed' ELSE 'no_show' END;
 UPDATE dental.appointments SET status=v_status,version=version+1,updated_at=v_now,
  approved_at=CASE WHEN p_decision='approve' THEN v_now ELSE approved_at END
  WHERE id=p_id RETURNING * INTO v_appointment;
 -- Accepted/failed history is retained; clear obsolete live leases atomically.
 UPDATE dental.outbox SET state='suppressed',lease_owner=NULL,lease_until=NULL,updated_at=v_now
  WHERE appointment_id=p_id AND state IN ('queued','retry','leased');
 IF p_decision='approve' THEN
  INSERT INTO dental.outbox(appointment_id,appointment_version,type,due_at,expires_at,created_at,updated_at)
   VALUES(p_id,v_appointment.version,'approval',v_now,LEAST(v_now+interval '24 hours',v_start),v_now,v_now);
  -- A request still pending at exactly 18:00 gets confirmation only.
  IF v_now<v_reminder THEN
   INSERT INTO dental.outbox(appointment_id,appointment_version,type,due_at,expires_at,created_at,updated_at)
    VALUES(p_id,v_appointment.version,'reminder',v_reminder,v_midnight,v_now,v_now);
  END IF;
 ELSIF p_decision='reject' THEN
  INSERT INTO dental.outbox(appointment_id,appointment_version,type,due_at,expires_at,created_at,updated_at)
   VALUES(p_id,v_appointment.version,'rejection',v_now,v_now+interval '24 hours',v_now,v_now);
 END IF;
 INSERT INTO dental.audit_events(actor_account_id,action,patient_id,appointment_id,clinic_date,reason,occurred_at)
  VALUES(p_actor,'appointment_'||v_status,v_appointment.patient_id,p_id,v_date,v_reason,v_now);
 RETURN dental._appointment_json(v_appointment);
END;
$body$;

CREATE FUNCTION dental.set_intake(p_actor uuid,p_date date,p_intake text,p_reason text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_day dental.clinic_dates; v_unresolved integer; v_now timestamptz;
 v_reason text:=pg_catalog.btrim(p_reason,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE'; END IF;
 IF p_actor IS NULL OR NOT EXISTS(SELECT FROM dental.accounts WHERE id=p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAUTHENTICATED'; END IF;
 IF NOT dental.is_admin(p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
 IF p_date IS NULL OR NOT pg_catalog.isfinite(p_date) OR p_date<date '0001-01-01' OR p_date>date '9999-12-31'
  OR p_intake IS NULL OR p_intake NOT IN ('open','paused','closed')
  OR v_reason IS NULL OR pg_catalog.char_length(v_reason) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
 INSERT INTO dental.clinic_dates(date) VALUES(p_date) ON CONFLICT DO NOTHING;
 SELECT * INTO STRICT v_day FROM dental.clinic_dates WHERE date=p_date FOR UPDATE;
 v_now:=dental.clock_now();
 IF NOT EXISTS(SELECT FROM dental.accounts WHERE id=p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAUTHENTICATED'; END IF;
 IF NOT dental.is_admin(p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
 SELECT pg_catalog.count(*)::integer INTO v_unresolved FROM dental.appointments WHERE date=p_date AND status IN ('pending', 'approved');
 IF p_intake='closed' AND v_unresolved>0 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNRESOLVED_BOOKINGS'; END IF;
 UPDATE dental.clinic_dates SET intake=p_intake,reason=v_reason,changed_by=p_actor,version=version+1,updated_at=v_now WHERE date=p_date;
 INSERT INTO dental.audit_events(actor_account_id,action,clinic_date,reason,occurred_at)
  VALUES(p_actor,'intake_'||p_intake,p_date,v_reason,v_now);
 RETURN pg_catalog.jsonb_build_object('date',p_date::text,'intake',p_intake,'unresolved',v_unresolved);
END;
$body$;

CREATE FUNCTION dental.admin_appointments(p_actor uuid,p_date date,p_status text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_result jsonb; v_dates date[];
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE'; END IF;
 IF p_actor IS NULL OR NOT EXISTS(SELECT FROM dental.accounts WHERE id=p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAUTHENTICATED'; END IF;
 IF NOT dental.is_admin(p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
 IF (p_date IS NOT NULL AND (NOT pg_catalog.isfinite(p_date) OR p_date<date '0001-01-01' OR p_date>date '9999-12-31'))
  OR (p_status IS NOT NULL AND p_status NOT IN ('pending','approved','rejected','cancelled','completed','no_show')) THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
 END IF;
 -- Audit FK checks must follow the same date-first ordering as mutations.
 -- Capture the locked date set, so a later snapshot cannot include an unlocked
 -- date created concurrently. SHARE permits other admin reads, blocks writers.
 SELECT COALESCE(pg_catalog.array_agg(locked.date),'{}'::date[]) INTO v_dates FROM
  (SELECT date FROM dental.clinic_dates WHERE p_date IS NULL OR date=p_date ORDER BY date FOR SHARE) locked;
 IF NOT EXISTS(SELECT FROM dental.accounts WHERE id=p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAUTHENTICATED'; END IF;
 IF NOT dental.is_admin(p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
 SELECT COALESCE(pg_catalog.jsonb_agg(dental._appointment_json(a)||pg_catalog.jsonb_build_object('notificationAttempts',
   (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('kind',o.type,'state',o.state,'attemptCount',o.attempt_count)
    ORDER BY o.created_at,o.type,o.id),'[]'::jsonb) FROM dental.outbox o WHERE o.appointment_id=a.id)) ORDER BY a.created_at,a.id),'[]'::jsonb)
  INTO v_result FROM dental.appointments a WHERE a.date=ANY(v_dates) AND (p_status IS NULL OR a.status=p_status);
 IF NOT EXISTS(SELECT FROM dental.accounts WHERE id=p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAUTHENTICATED'; END IF;
 IF NOT dental.is_admin(p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
 -- Audit the exact returned IDs, not a fresh query whose membership may differ.
 -- Only record identifiers; patient details and notification internals stay out.
 INSERT INTO dental.audit_events(actor_account_id,action,appointment_id,clinic_date)
  SELECT p_actor,'admin_appointments_read',(item->>'id')::uuid,(item->>'date')::date FROM pg_catalog.jsonb_array_elements(v_result) item;
 INSERT INTO dental.audit_events(actor_account_id,action,reason)
  VALUES(p_actor,'admin_appointments_query','date='||COALESCE(p_date::text,'all')||';status='||COALESCE(p_status,'all'));
 RETURN v_result;
END;
$body$;

CREATE FUNCTION dental.set_admin_grant(p_operator uuid,p_account uuid,p_granted boolean,p_reason text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_now timestamptz; v_live boolean;
 v_reason text:=pg_catalog.btrim(p_reason,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
BEGIN
 -- Operator identity comes from a separately authorized database operation.
 -- A backend-supplied role claim or live app-admin grant is never sufficient.
 IF SESSION_USER<>'postgres' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN'; END IF;
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE'; END IF;
 IF p_operator IS NULL OR p_account IS NULL OR p_granted IS NULL OR v_reason IS NULL
  OR pg_catalog.char_length(v_reason) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
 -- The advisory key serializes the absent-live-grant case without granting
 -- UPDATE on account identifiers merely to acquire a row lock.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dental.admin:'||p_account::text,0));
 IF NOT EXISTS(SELECT FROM dental.accounts WHERE id=p_operator) OR NOT EXISTS(SELECT FROM dental.accounts WHERE id=p_account) THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='NOT_FOUND';
 END IF;
 v_now:=dental.clock_now();
 v_live:=dental.is_admin(p_account);
 IF v_live=p_granted THEN RETURN v_live; END IF;
 IF p_granted THEN
  INSERT INTO dental.admin_grants(account_id,granted_by,granted_at) VALUES(p_account,p_operator,v_now);
 ELSE
  UPDATE dental.admin_grants SET revoked_at=v_now,revoked_by=p_operator WHERE account_id=p_account AND revoked_at IS NULL;
 END IF;
 INSERT INTO dental.audit_events(actor_account_id,action,reason,occurred_at)
  VALUES(p_operator,CASE WHEN p_granted THEN 'admin_granted' ELSE 'admin_revoked' END,v_reason,v_now);
 RETURN p_granted;
END;
$body$;

REVOKE ALL ON FUNCTION dental.cancel(uuid,uuid,integer),dental.decide(uuid,uuid,integer,text,text),dental.set_intake(uuid,date,text,text),dental.admin_appointments(uuid,date,text),dental.set_admin_grant(uuid,uuid,boolean,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dental.cancel(uuid,uuid,integer),dental.decide(uuid,uuid,integer,text,text),dental.set_intake(uuid,date,text,text),dental.admin_appointments(uuid,date,text) TO dental_backend;
GRANT EXECUTE ON FUNCTION dental.set_admin_grant(uuid,uuid,boolean,text) TO postgres;
$definitions$;
 RESET ROLE;
 REVOKE CREATE ON SCHEMA dental FROM dental_function_owner;
 IF v_major=17 THEN EXECUTE 'REVOKE dental_function_owner FROM postgres GRANTED BY postgres';
 ELSE REVOKE dental_function_owner FROM postgres; END IF;

 v_new_functions:=ARRAY[
  'dental.cancel(uuid,uuid,integer)'::pg_catalog.regprocedure::oid,
  'dental.decide(uuid,uuid,integer,text,text)'::pg_catalog.regprocedure::oid,
  'dental.set_intake(uuid,date,text,text)'::pg_catalog.regprocedure::oid,
  'dental.admin_appointments(uuid,date,text)'::pg_catalog.regprocedure::oid,
  'dental.set_admin_grant(uuid,uuid,boolean,text)'::pg_catalog.regprocedure::oid];
 v_operator_function:='dental.set_admin_grant(uuid,uuid,boolean,text)'::pg_catalog.regprocedure::oid;
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY roleid,member,grantor),'[]'::jsonb)
  INTO v_memberships_after FROM pg_catalog.pg_auth_members m WHERE roleid IN (v_owner,v_backend);
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.oid),'[]'::jsonb)
  INTO v_defaults_after FROM pg_catalog.pg_default_acl d WHERE d.defaclrole=v_postgres;
 SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('oid',p.oid,'definition',pg_catalog.pg_get_functiondef(p.oid),'acl',p.proacl) ORDER BY p.oid)
  INTO v_existing_functions_after FROM pg_catalog.pg_proc p WHERE p.pronamespace=v_schema AND p.oid<>ALL(v_new_functions);
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid),'[]'::jsonb)
  INTO v_policies_after FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class t ON t.oid=p.polrelid
  WHERE t.relnamespace=v_schema AND p.polname<>ALL(v_new_policies);
 IF v_memberships IS DISTINCT FROM v_memberships_after OR v_defaults IS DISTINCT FROM v_defaults_after
  OR v_existing_functions IS DISTINCT FROM v_existing_functions_after OR v_policies_before IS DISTINCT FROM v_policies_after
  OR pg_catalog.has_schema_privilege(v_owner,v_schema,'CREATE') OR pg_catalog.has_schema_privilege(v_backend,v_schema,'CREATE') THEN
  RAISE EXCEPTION 'Task 7 changed an existing function/default/policy or did not restore temporary access';
 END IF;
 IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc WHERE pronamespace=v_schema)<>24 THEN
  RAISE EXCEPTION 'Unexpected Task 7 function surface';
 END IF;
 FOR v_function IN SELECT * FROM pg_catalog.pg_proc WHERE oid=ANY(v_new_functions) LOOP
  IF v_function.proowner<>v_owner OR NOT v_function.prosecdef
   OR NOT COALESCE(v_function.proconfig @> ARRAY['search_path=""'],false)
   OR pg_catalog.has_function_privilege(v_backend,v_function.oid,'EXECUTE') IS DISTINCT FROM (v_function.oid<>v_operator_function)
   OR pg_catalog.has_function_privilege(v_postgres,v_function.oid,'EXECUTE') IS DISTINCT FROM (v_function.oid=v_operator_function)
   OR EXISTS(SELECT FROM pg_catalog.aclexplode(COALESCE(v_function.proacl,pg_catalog.acldefault('f',v_owner))) a
    WHERE a.grantee<>v_owner AND NOT(a.grantee=CASE WHEN v_function.oid=v_operator_function THEN v_postgres ELSE v_backend END
     AND a.grantor=v_owner AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)) THEN
   RAISE EXCEPTION 'Unsafe new private function ownership, search path or execute ACL';
  END IF;
 END LOOP;
 FOR v_table IN SELECT * FROM pg_catalog.pg_class WHERE relnamespace=v_schema AND relkind='r' LOOP
  IF v_table.relowner<>v_postgres OR NOT v_table.relrowsecurity OR NOT v_table.relforcerowsecurity
   OR pg_catalog.has_table_privilege(v_backend,v_table.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR pg_catalog.has_any_column_privilege(v_backend,v_table.oid,'SELECT,INSERT,UPDATE,REFERENCES') THEN
   RAISE EXCEPTION 'Private table ownership, RLS or backend direct access is unsafe';
  END IF;
 END LOOP;
 -- No mutable snapshots, appointment dates/owners, provider history, admin target
 -- rewriting or broad UPDATE privilege is introduced by these entry points.
 FOR v_table IN SELECT * FROM (VALUES
  ('appointments',ARRAY['status','version','updated_at','approved_at','cancelled_at','cancelled_by']),
  ('clinic_dates',ARRAY['date','intake','reason','changed_by','version','updated_at']),
  ('outbox',ARRAY['state','lease_owner','lease_until','updated_at']),
  ('admin_grants',ARRAY['revoked_at','revoked_by'])
 ) AS expected(name,columns) LOOP
  IF pg_catalog.has_table_privilege(v_owner,pg_catalog.format('dental.%I',v_table.name),'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR NOT pg_catalog.has_table_privilege(v_owner,pg_catalog.format('dental.%I',v_table.name),'SELECT')
   OR NOT pg_catalog.has_table_privilege(v_owner,pg_catalog.format('dental.%I',v_table.name),'INSERT') THEN
   RAISE EXCEPTION 'Transition owner access exceeds the reviewed column surface';
  END IF;
  FOR v_column IN SELECT * FROM pg_catalog.pg_attribute WHERE attrelid=pg_catalog.to_regclass(pg_catalog.format('dental.%I',v_table.name)) AND attnum>0 AND NOT attisdropped LOOP
   IF pg_catalog.has_column_privilege(v_owner,v_column.attrelid,v_column.attname,'UPDATE') IS DISTINCT FROM (v_column.attname=ANY(v_table.columns)) THEN
    RAISE EXCEPTION 'Transition owner access exceeds the reviewed column surface';
   END IF;
  END LOOP;
 END LOOP;
 IF EXISTS(
  WITH expected(table_name,policy_name,command,using_expression,check_expression) AS (VALUES
   ('appointments','appointments_function_update','w','true','true'),
   ('outbox','outbox_function_read','r','true',NULL::text),
   ('outbox','outbox_function_insert','a',NULL::text,'true'),
   ('outbox','outbox_function_update','w','true','true'),
   ('admin_grants','admin_grants_function_insert','a',NULL::text,'true'),
   ('admin_grants','admin_grants_function_revoke','w','true','true')
  ), actual AS (
   SELECT t.relname,p.polname,p.polcmd,p.polroles,p.polpermissive,
    pg_catalog.pg_get_expr(p.polqual,p.polrelid) AS using_expression,
    pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression
   FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class t ON t.oid=p.polrelid
   WHERE t.relnamespace=v_schema AND p.polname=ANY(v_new_policies)
  ) SELECT FROM expected e FULL JOIN actual a ON a.relname=e.table_name AND a.polname=e.policy_name
   WHERE e.table_name IS NULL OR a.relname IS NULL OR a.polcmd::text IS DISTINCT FROM e.command
    OR a.polroles IS DISTINCT FROM ARRAY[v_owner] OR a.polpermissive IS DISTINCT FROM true
    OR a.using_expression IS DISTINCT FROM e.using_expression OR a.check_expression IS DISTINCT FROM e.check_expression
 ) THEN RAISE EXCEPTION 'Unexpected transition RLS policy definition'; END IF;
 FOREACH v_role IN ARRAY ARRAY['anon','authenticated','authenticator','service_role'] LOOP
  IF EXISTS(SELECT FROM pg_catalog.pg_roles WHERE rolname=v_role) THEN
   IF pg_catalog.pg_has_role(v_role,v_owner,'MEMBER') OR pg_catalog.pg_has_role(v_role,v_backend,'MEMBER')
    OR pg_catalog.has_schema_privilege(v_role,v_schema,'USAGE,CREATE')
    OR EXISTS(SELECT FROM pg_catalog.pg_class t WHERE t.relnamespace=v_schema AND t.relkind='r'
     AND (pg_catalog.has_table_privilege(v_role,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR pg_catalog.has_any_column_privilege(v_role,t.oid,'SELECT,INSERT,UPDATE,REFERENCES')))
    OR EXISTS(SELECT FROM pg_catalog.pg_proc p WHERE p.pronamespace=v_schema AND pg_catalog.has_function_privilege(v_role,p.oid,'EXECUTE')) THEN
    RAISE EXCEPTION 'Browser/platform role has a private membership, schema, table or function path';
   END IF;
  END IF;
 END LOOP;
END;
$task7$;
