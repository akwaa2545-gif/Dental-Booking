-- UNEXECUTED Restricted dispatch candidate, local validation only. This is not permission
-- to apply SQL or alter any hosted project. Explicit exact-project approval is
-- still required for one private table, two RLS policies, two backend RPCs, one attempt trigger and its owner-only helper,
-- least-privilege grants and temporary operator membership.
-- Requires the exact reviewed PG17 Task 10 runtime baseline. Historical held
-- experimental 007 is deliberately NOT included or superseded by this file.
-- Existing claim receives only the exact restricted-event exclusion. Other
-- business functions, policies, role attributes, default ACLs and memberships
-- are preserved. No credential, LOGIN or public access is added.
DO $restricted$
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
 v_grantee record; v_backend_functions oid[]; v_new_policies text[]:=ARRAY['restricted_dispatch_read','restricted_dispatch_update'];
 v_policies_before jsonb; v_policies_after jsonb;
 v_new_functions oid[];
 v_claim_before text; v_claim_after text;
 v_claim_anchor text := '   AND NOT EXISTS(SELECT FROM dental.notification_attempts a WHERE a.outbox_id=o.id AND a.worker_id=p_worker)';
 v_claim_guard text := '   AND NOT EXISTS(SELECT FROM dental.restricted_dispatch_authorizations r WHERE r.event_id=o.id)';
BEGIN
 -- A statement timer must already be running when this DO starts; setting it
 -- inside an executing DO is not a substitute. The whole migration is capped.
 IF (SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name = 'statement_timeout') NOT BETWEEN 1 AND 120000 THEN
  RAISE EXCEPTION 'Restricted dispatch requires an inherited statement timeout between 1ms and 2min';
 END IF;
 IF CURRENT_USER<>'postgres' OR SESSION_USER<>'postgres' OR v_major<>17
  OR pg_catalog.current_setting('role')<>'none'
  OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
  OR pg_catalog.current_setting('transaction_read_only')<>'off'
  OR pg_catalog.to_regprocedure('dental.decide(uuid,uuid,integer,text,text)') IS NULL
  OR pg_catalog.to_regprocedure('dental.claim_events(uuid,integer)') IS NULL
  OR pg_catalog.to_regprocedure('dental.consume_request_limit(text,text)') IS NULL
  OR pg_catalog.to_regprocedure('dental.claim_restricted_event(uuid,uuid,uuid)') IS NOT NULL
  OR pg_catalog.to_regclass('dental.restricted_dispatch_authorizations') IS NOT NULL THEN
  RAISE EXCEPTION 'Restricted dispatch requires the verified Task 10 managed baseline and unapplied restricted-dispatch migration';
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
  RAISE EXCEPTION 'Unreviewed Restricted dispatch private/runtime role attributes or role settings';
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
  RAISE EXCEPTION 'Unreviewed exact Restricted dispatch runtime membership baseline';
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
 IF pg_catalog.jsonb_array_length(v_existing_functions)<>31 THEN RAISE EXCEPTION 'Unexpected Task 10 function set'; END IF;

 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid),'[]'::jsonb)
  INTO v_policies_before FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class t ON t.oid=p.polrelid WHERE t.relnamespace=v_schema;
 IF EXISTS(SELECT FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class t ON t.oid=p.polrelid
  WHERE t.relnamespace=v_schema AND p.polname=ANY(v_new_policies)) THEN
  RAISE EXCEPTION 'Restricted-dispatch policies already exist; inspect instead of reapplying';
 END IF;
 -- Only one existing function change is allowed: the exact general-claim
 -- exclusion below. Validate the anchor and record its expected catalog form.
 SELECT pg_catalog.pg_get_functiondef('dental.claim_events(uuid,integer)'::pg_catalog.regprocedure) INTO v_claim_before;
 IF pg_catalog.strpos(v_claim_before,v_claim_anchor)=0 OR pg_catalog.strpos(v_claim_before,v_claim_guard)>0 THEN
  RAISE EXCEPTION 'Unreviewed general claim definition';
 END IF;
 v_claim_after:=pg_catalog.replace(v_claim_before,v_claim_anchor,v_claim_guard||E'\n'||v_claim_anchor);
 SELECT pg_catalog.jsonb_agg(CASE WHEN (x->>'oid')::oid='dental.claim_events(uuid,integer)'::pg_catalog.regprocedure::oid
  THEN pg_catalog.jsonb_set(x,'{definition}',pg_catalog.to_jsonb(v_claim_after)) ELSE x END ORDER BY (x->>'oid')::oid)
  INTO v_existing_functions FROM pg_catalog.jsonb_array_elements(v_existing_functions) x;
 -- Bound each catalog/DDL lock wait without resetting the inherited statement timer.
 PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
 -- Freeze the attempt trigger surface before checking it. An unreviewed
 -- BEFORE trigger could rewrite NEW after the fence; fail closed instead.
 LOCK TABLE dental.notification_attempts IN SHARE ROW EXCLUSIVE MODE;
 IF EXISTS(SELECT FROM pg_catalog.pg_trigger WHERE tgrelid='dental.notification_attempts'::pg_catalog.regclass AND NOT tgisinternal)
  OR EXISTS(SELECT FROM pg_catalog.pg_rewrite WHERE ev_class='dental.notification_attempts'::pg_catalog.regclass) THEN
  RAISE EXCEPTION 'Unreviewed notification attempt trigger or rewrite rule';
 END IF;
 GRANT dental_function_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
 GRANT CREATE ON SCHEMA dental TO dental_function_owner;
 CREATE TABLE dental.restricted_dispatch_authorizations(
  event_id uuid PRIMARY KEY REFERENCES dental.outbox(id),
  owner_id uuid NOT NULL REFERENCES dental.accounts(id),
  expires_at timestamptz NOT NULL CHECK(pg_catalog.isfinite(expires_at)),
  consumed_at timestamptz CHECK(consumed_at IS NULL OR pg_catalog.isfinite(consumed_at)),
  consumed_by uuid,
  CHECK((consumed_at IS NULL) = (consumed_by IS NULL))
 );
 -- Only the operator can provision or renew an authorization. No runtime RPC,
 -- table INSERT, expiry update or DELETE permission can create another budget.
 ALTER TABLE dental.restricted_dispatch_authorizations ENABLE ROW LEVEL SECURITY;
 ALTER TABLE dental.restricted_dispatch_authorizations FORCE ROW LEVEL SECURITY;
 REVOKE ALL ON dental.restricted_dispatch_authorizations FROM PUBLIC;
 FOR v_grantee IN SELECT DISTINCT r.rolname FROM pg_catalog.pg_class c
  CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a JOIN pg_catalog.pg_roles r ON r.oid=a.grantee
  WHERE c.oid='dental.restricted_dispatch_authorizations'::pg_catalog.regclass AND a.grantee<>c.relowner
 LOOP EXECUTE pg_catalog.format('REVOKE ALL ON TABLE dental.restricted_dispatch_authorizations FROM %I',v_grantee.rolname); END LOOP;
 GRANT SELECT ON dental.restricted_dispatch_authorizations TO dental_function_owner;
 GRANT UPDATE(consumed_at,consumed_by) ON dental.restricted_dispatch_authorizations TO dental_function_owner;
 CREATE POLICY restricted_dispatch_read ON dental.restricted_dispatch_authorizations FOR SELECT TO dental_function_owner USING(true);
 CREATE POLICY restricted_dispatch_update ON dental.restricted_dispatch_authorizations FOR UPDATE TO dental_function_owner USING(consumed_at IS NULL) WITH CHECK(true);
 SET LOCAL ROLE dental_function_owner;
 EXECUTE v_claim_after;
 EXECUTE $definitions$
CREATE FUNCTION dental.claim_restricted_event(p_worker uuid,p_event uuid,p_owner uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_auth dental.restricted_dispatch_authorizations; v_event dental.outbox; v_now timestamptz;
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE'; END IF;
 IF p_worker IS NULL OR p_event IS NULL OR p_owner IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
 SELECT * INTO v_auth FROM dental.restricted_dispatch_authorizations
  WHERE event_id=p_event AND owner_id=p_owner FOR UPDATE SKIP LOCKED;
 IF NOT FOUND OR v_auth.consumed_at IS NOT NULL OR v_auth.expires_at<=dental.clock_now() THEN RETURN '[]'::jsonb; END IF;
 -- Filter exact event and actual appointment owner BEFORE any queue mutation.
 -- This function never calls general claim, performs recovery, or scans cleanup.
 SELECT o.* INTO v_event FROM dental.outbox o JOIN dental.appointments a ON a.id=o.appointment_id
  WHERE o.id=p_event AND a.owner_account_id=p_owner AND o.attempt_count=0
   AND ((o.state IN ('queued','retry') AND o.due_at<=dental.clock_now())
     OR (o.state='leased' AND o.lease_until<=dental.clock_now()))
  FOR UPDATE OF o SKIP LOCKED;
 IF NOT FOUND THEN RETURN '[]'::jsonb; END IF;
 v_now:=dental.clock_now();
 IF v_auth.expires_at<=v_now OR v_event.expires_at<=v_now OR v_event.due_at>v_now THEN RETURN '[]'::jsonb; END IF;
 UPDATE dental.outbox SET state='leased',lease_owner=p_worker,lease_until=v_now+interval '60 seconds',updated_at=v_now
  WHERE id=p_event RETURNING * INTO v_event;
 RETURN pg_catalog.jsonb_build_array(dental._outbox_event_json(v_event));
END;
$body$;
CREATE FUNCTION dental.prepare_restricted_dispatch(p_worker uuid,p_event uuid,p_owner uuid,p_manage_origin text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_auth dental.restricted_dispatch_authorizations; v_result jsonb;
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE'; END IF;
 IF p_worker IS NULL OR p_event IS NULL OR p_owner IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
 SELECT * INTO v_auth FROM dental.restricted_dispatch_authorizations
  WHERE event_id=p_event AND owner_id=p_owner FOR UPDATE;
 IF NOT FOUND OR v_auth.consumed_at IS NOT NULL OR v_auth.expires_at<=dental.clock_now() THEN RETURN NULL; END IF;
 IF NOT EXISTS(SELECT FROM dental.outbox o JOIN dental.appointments a ON a.id=o.appointment_id
   WHERE o.id=p_event AND a.owner_account_id=p_owner AND o.attempt_count=0) THEN RETURN NULL; END IF;
 -- Subtransaction rollback preserves both budget and prepare writes if the
 -- approval expires during final date/appointment/outbox/reachability waits.
 BEGIN
  UPDATE dental.restricted_dispatch_authorizations SET consumed_at=dental.clock_now(),consumed_by=p_worker WHERE event_id=p_event;
  -- Existing prepare remains unchanged and owns all final business checks and
  -- universal date -> appointment -> outbox -> reachability lock ordering.
  v_result:=dental.prepare_dispatch(p_worker,p_event,p_manage_origin);
  IF v_result IS NULL THEN
   -- RLS forbids updating consumed rows: rollback the spend subtransaction,
   -- including harmless final-check suppression, rather than grant reset access.
   RAISE EXCEPTION USING ERRCODE='RD001',MESSAGE='NO_RESTRICTED_DISPATCH';
  END IF;
  IF v_auth.expires_at<=dental.clock_now() THEN RAISE EXCEPTION USING ERRCODE='RD001',MESSAGE='NO_RESTRICTED_DISPATCH'; END IF;
 EXCEPTION WHEN SQLSTATE 'RD001' THEN RETURN NULL;
 END;
 -- Only return a payload alongside a durable budget spend in this transaction.
 -- Runtime must commit before network I/O; uncertain commits must never send.
 RETURN v_result;
END;
$body$;
CREATE FUNCTION dental._fence_restricted_attempt()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_auth dental.restricted_dispatch_authorizations;
BEGIN
 SELECT * INTO v_auth FROM dental.restricted_dispatch_authorizations WHERE event_id=NEW.outbox_id;
 IF FOUND AND (NEW.attempt_number<>1 OR v_auth.consumed_at IS NULL OR v_auth.consumed_by IS DISTINCT FROM NEW.worker_id) THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='RESTRICTED_DISPATCH_REQUIRED';
 END IF;
 RETURN NEW;
END;
$body$;
REVOKE ALL ON FUNCTION dental._fence_restricted_attempt() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dental._fence_restricted_attempt() TO postgres;
REVOKE ALL ON FUNCTION dental.claim_restricted_event(uuid,uuid,uuid),dental.prepare_restricted_dispatch(uuid,uuid,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dental.claim_restricted_event(uuid,uuid,uuid),dental.prepare_restricted_dispatch(uuid,uuid,uuid,text) TO dental_backend;
$definitions$;
 RESET ROLE;
 CREATE TRIGGER fence_restricted_attempt BEFORE INSERT ON dental.notification_attempts FOR EACH ROW EXECUTE FUNCTION dental._fence_restricted_attempt();
 SET LOCAL ROLE dental_function_owner;
 REVOKE EXECUTE ON FUNCTION dental._fence_restricted_attempt() FROM postgres;
 RESET ROLE;
 REVOKE CREATE ON SCHEMA dental FROM dental_function_owner;
 REVOKE dental_function_owner FROM postgres GRANTED BY postgres;
 PERFORM pg_catalog.set_config('lock_timeout', v_original_lock_timeout, true);
 IF pg_catalog.current_setting('lock_timeout') IS DISTINCT FROM v_original_lock_timeout THEN
  RAISE EXCEPTION 'Restricted dispatch did not restore the inherited lock timeout';
 END IF;
 v_new_functions:=ARRAY['dental.claim_restricted_event(uuid,uuid,uuid)'::pg_catalog.regprocedure::oid,'dental.prepare_restricted_dispatch(uuid,uuid,uuid,text)'::pg_catalog.regprocedure::oid,'dental._fence_restricted_attempt()'::pg_catalog.regprocedure::oid];
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY roleid,member,grantor),'[]'::jsonb)
  INTO v_memberships_after FROM pg_catalog.pg_auth_members m
  WHERE m.roleid IN (v_owner,v_backend,v_runtime) OR m.member IN (v_owner,v_backend,v_runtime);
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.oid),'[]'::jsonb)
  INTO v_defaults_after FROM pg_catalog.pg_default_acl d WHERE d.defaclrole=v_postgres;
 SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('oid',p.oid,'definition',pg_catalog.pg_get_functiondef(p.oid),'acl',p.proacl) ORDER BY p.oid)
  INTO v_existing_functions_after FROM pg_catalog.pg_proc p WHERE p.pronamespace=v_schema AND p.oid<>ALL(v_new_functions);
 SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r)-'rolpassword' ORDER BY r.oid)
  INTO v_roles_after FROM pg_catalog.pg_roles r WHERE r.oid IN (v_owner,v_backend,v_runtime);
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s) ORDER BY s.setdatabase,s.setrole),'[]'::jsonb)
  INTO v_role_settings_after FROM pg_catalog.pg_db_role_setting s WHERE s.setrole IN (v_owner,v_backend,v_runtime);
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid),'[]'::jsonb)
  INTO v_policies_after FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class t ON t.oid=p.polrelid
  WHERE t.relnamespace=v_schema AND NOT p.polname=ANY(v_new_policies);
 IF v_memberships IS DISTINCT FROM v_memberships_after OR v_defaults IS DISTINCT FROM v_defaults_after
  OR v_existing_functions IS DISTINCT FROM v_existing_functions_after OR v_roles IS DISTINCT FROM v_roles_after
  OR v_role_settings IS DISTINCT FROM v_role_settings_after OR v_policies_before IS DISTINCT FROM v_policies_after
  OR pg_catalog.has_schema_privilege(v_owner,v_schema,'CREATE') OR pg_catalog.has_schema_privilege(v_backend,v_schema,'CREATE')
  OR pg_catalog.has_schema_privilege(v_runtime,v_schema,'CREATE') THEN
  RAISE EXCEPTION 'Restricted dispatch changed existing authorization or did not restore temporary access';
 END IF;
 IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc WHERE pronamespace=v_schema)<>34 THEN
  RAISE EXCEPTION 'Unexpected Restricted dispatch function surface';
 END IF;
 FOR v_function IN SELECT * FROM pg_catalog.pg_proc WHERE oid=ANY(v_new_functions) LOOP
 IF v_function.proowner<>v_owner OR NOT v_function.prosecdef
  OR NOT COALESCE(v_function.proconfig @> ARRAY['search_path=""'],false)
  OR pg_catalog.has_function_privilege(v_backend,v_function.oid,'EXECUTE') IS DISTINCT FROM (v_function.proname<>'_fence_restricted_attempt')
  OR pg_catalog.has_function_privilege(v_runtime,v_function.oid,'EXECUTE') IS DISTINCT FROM (v_function.proname<>'_fence_restricted_attempt')
  OR pg_catalog.has_function_privilege(v_postgres,v_function.oid,'EXECUTE')
  OR EXISTS(SELECT FROM pg_catalog.aclexplode(COALESCE(v_function.proacl,pg_catalog.acldefault('f',v_owner))) a
   WHERE a.grantee<>v_owner AND NOT(v_function.proname<>'_fence_restricted_attempt' AND a.grantee=v_backend AND a.grantor=v_owner AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)) THEN
  RAISE EXCEPTION 'Unsafe new restricted-dispatch function ownership, search path or execute ACL';
 END IF;
 END LOOP;
 SELECT * INTO STRICT v_table FROM pg_catalog.pg_class WHERE oid='dental.restricted_dispatch_authorizations'::pg_catalog.regclass;
 IF v_table.relowner<>v_postgres OR NOT v_table.relrowsecurity OR NOT v_table.relforcerowsecurity
  OR pg_catalog.has_table_privilege(v_owner,v_table.oid,'INSERT,DELETE,UPDATE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
  OR pg_catalog.has_column_privilege(v_owner,v_table.oid,'event_id','UPDATE')
  OR pg_catalog.has_column_privilege(v_owner,v_table.oid,'owner_id','UPDATE')
  OR pg_catalog.has_column_privilege(v_owner,v_table.oid,'expires_at','UPDATE')
  OR NOT pg_catalog.has_column_privilege(v_owner,v_table.oid,'consumed_at','UPDATE')
  OR NOT pg_catalog.has_column_privilege(v_owner,v_table.oid,'consumed_by','UPDATE') THEN
  RAISE EXCEPTION 'Unsafe restricted-dispatch table ownership, RLS or owner privilege';
 END IF;
 FOREACH v_role IN ARRAY ARRAY['dental_backend','dental_runtime','anon','authenticated','authenticator','service_role'] LOOP
  IF pg_catalog.has_table_privilege(v_role,v_table.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
   OR pg_catalog.has_any_column_privilege(v_role,v_table.oid,'SELECT,INSERT,UPDATE,REFERENCES') THEN
   RAISE EXCEPTION 'Private authorization has direct runtime or browser access';
  END IF;
 END LOOP;
 FOREACH v_role IN ARRAY ARRAY['anon','authenticated','authenticator','service_role'] LOOP
  IF pg_catalog.pg_has_role(v_role,v_owner,'MEMBER') OR pg_catalog.pg_has_role(v_role,v_backend,'MEMBER')
   OR pg_catalog.has_schema_privilege(v_role,v_schema,'USAGE,CREATE')
   OR EXISTS(SELECT FROM pg_catalog.pg_proc p WHERE p.oid=ANY(v_new_functions) AND pg_catalog.has_function_privilege(v_role,p.oid,'EXECUTE')) THEN
   RAISE EXCEPTION 'Browser/platform role has a private restricted-dispatch path';
  END IF;
 END LOOP;
 IF NOT EXISTS(SELECT FROM pg_catalog.pg_trigger WHERE tgrelid='dental.notification_attempts'::pg_catalog.regclass
  AND tgname='fence_restricted_attempt' AND tgfoid='dental._fence_restricted_attempt()'::pg_catalog.regprocedure
  AND tgtype=7 AND tgenabled='O' AND NOT tgisinternal)
  OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy WHERE polrelid='dental.restricted_dispatch_authorizations'::pg_catalog.regclass)<>2 THEN
  RAISE EXCEPTION 'Unexpected restricted dispatch trigger or policy surface';
 END IF;
END;
$restricted$;
