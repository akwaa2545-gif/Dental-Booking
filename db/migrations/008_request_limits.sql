-- UNEXECUTED Task 10 candidate, local validation only. This is not permission
-- to apply SQL or alter any hosted project. Explicit exact-project approval is
-- still required for one private table, four RLS policies, one backend RPC,
-- least-privilege grants and temporary operator membership.
-- Requires the exact reviewed PG17 Task 8 runtime baseline. Historical held
-- experimental 007 is deliberately NOT included or superseded by this file.
-- Existing business functions, policies, role attributes, default ACLs and
-- memberships are preserved. No credential, LOGIN or public access is added.
DO $task10$
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
 v_grantee record; v_backend_functions oid[]; v_new_policies text[]:=ARRAY['request_counters_read','request_counters_insert','request_counters_update','request_counters_delete'];
 v_policies_before jsonb; v_policies_after jsonb;
 v_new_functions oid[];
BEGIN
 -- A statement timer must already be running when this DO starts; setting it
 -- inside an executing DO is not a substitute. The whole migration is capped.
 IF (SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name = 'statement_timeout') NOT BETWEEN 1 AND 120000 THEN
  RAISE EXCEPTION 'Task 10 requires an inherited statement timeout between 1ms and 2min';
 END IF;
 IF CURRENT_USER<>'postgres' OR SESSION_USER<>'postgres' OR v_major<>17
  OR pg_catalog.current_setting('role')<>'none'
  OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
  OR pg_catalog.current_setting('transaction_read_only')<>'off'
  OR pg_catalog.to_regprocedure('dental.decide(uuid,uuid,integer,text,text)') IS NULL
  OR pg_catalog.to_regprocedure('dental.claim_events(uuid,integer)') IS NULL
  OR pg_catalog.to_regprocedure('dental.consume_request_limit(text,text)') IS NOT NULL
  OR pg_catalog.to_regclass('dental.request_counters') IS NOT NULL THEN
  RAISE EXCEPTION 'Task 10 requires the verified Task 8 managed baseline and unapplied request-limit migration';
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
  RAISE EXCEPTION 'Unreviewed Task 10 private/runtime role attributes or role settings';
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
  RAISE EXCEPTION 'Unreviewed exact Task 10 runtime membership baseline';
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
 IF pg_catalog.jsonb_array_length(v_existing_functions)<>30 THEN RAISE EXCEPTION 'Unexpected Task 8 function set'; END IF;

 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid),'[]'::jsonb)
  INTO v_policies_before FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class t ON t.oid=p.polrelid WHERE t.relnamespace=v_schema;
 IF EXISTS(SELECT FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class t ON t.oid=p.polrelid
  WHERE t.relnamespace=v_schema AND p.polname=ANY(v_new_policies)) THEN
  RAISE EXCEPTION 'Request-limit policies already exist; inspect instead of reapplying';
 END IF;
 -- Bound each catalog/DDL lock wait without resetting the inherited statement timer.
 PERFORM pg_catalog.set_config('lock_timeout', '3s', true);
 GRANT dental_function_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
 GRANT CREATE ON SCHEMA dental TO dental_function_owner;
 CREATE TABLE dental.request_counters(
  scope text NOT NULL CHECK(scope IN ('login','mutation')),
  key_hash text NOT NULL CHECK(key_hash~'^[0-9a-f]{64}$'),
  window_started_at timestamptz NOT NULL CHECK(pg_catalog.isfinite(window_started_at)),
  request_count integer NOT NULL CHECK(request_count BETWEEN 1 AND CASE scope WHEN 'login' THEN 10 ELSE 30 END),
  PRIMARY KEY(scope,key_hash)
 );
 CREATE INDEX request_counters_expiry ON dental.request_counters(window_started_at);
 ALTER TABLE dental.request_counters ENABLE ROW LEVEL SECURITY;
 ALTER TABLE dental.request_counters FORCE ROW LEVEL SECURITY;
 REVOKE ALL ON dental.request_counters FROM PUBLIC;
 FOR v_grantee IN SELECT DISTINCT r.rolname FROM pg_catalog.pg_class c
  CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a JOIN pg_catalog.pg_roles r ON r.oid=a.grantee
  WHERE c.oid='dental.request_counters'::pg_catalog.regclass AND a.grantee<>c.relowner
 LOOP EXECUTE pg_catalog.format('REVOKE ALL ON TABLE dental.request_counters FROM %I',v_grantee.rolname); END LOOP;
 GRANT SELECT,INSERT,DELETE ON dental.request_counters TO dental_function_owner;
 GRANT UPDATE(window_started_at,request_count) ON dental.request_counters TO dental_function_owner;
 CREATE POLICY request_counters_read ON dental.request_counters FOR SELECT TO dental_function_owner USING(true);
 CREATE POLICY request_counters_insert ON dental.request_counters FOR INSERT TO dental_function_owner WITH CHECK(true);
 CREATE POLICY request_counters_update ON dental.request_counters FOR UPDATE TO dental_function_owner USING(true) WITH CHECK(true);
 CREATE POLICY request_counters_delete ON dental.request_counters FOR DELETE TO dental_function_owner USING(true);
 SET LOCAL ROLE dental_function_owner;
 EXECUTE $definitions$
CREATE FUNCTION dental.consume_request_limit(p_scope text,p_key_hash text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_counter dental.request_counters; v_now timestamptz; v_limit integer;
 v_inserted boolean:=false; v_allowed boolean;
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE';
 END IF;
 IF p_scope IS NULL OR p_scope NOT IN ('login','mutation') OR p_key_hash IS NULL OR p_key_hash!~'^[0-9a-f]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
 END IF;
 v_limit:=CASE p_scope WHEN 'login' THEN 10 ELSE 30 END;
 -- Acquire the one target before any cleanup locks. A cleaner may remove an
 -- expired row while an INSERT checks conflicts, so DO NOTHING must retry the
 -- locking lookup rather than assuming a later STRICT lookup still finds it.
 LOOP
  SELECT * INTO v_counter FROM dental.request_counters
   WHERE scope=p_scope AND key_hash=p_key_hash FOR UPDATE;
  IF FOUND THEN EXIT; END IF;
  INSERT INTO dental.request_counters(scope,key_hash,window_started_at,request_count)
   VALUES(p_scope,p_key_hash,dental.clock_now(),1)
   ON CONFLICT(scope,key_hash) DO NOTHING RETURNING * INTO v_counter;
  IF FOUND THEN v_inserted:=true; EXIT; END IF;
 END LOOP;
 -- Both paths now own the target row until this RPC's transaction ends. Recheck
 -- time after all target waits, including a competing insertion or deletion.
 v_now:=dental.clock_now();
 IF v_inserted OR v_now>=v_counter.window_started_at+interval '1 minute' THEN
  UPDATE dental.request_counters SET window_started_at=v_now,request_count=1 WHERE scope=p_scope AND key_hash=p_key_hash;
  v_allowed:=true;
 ELSIF v_counter.request_count>=v_limit THEN
  v_allowed:=false;
 ELSE
  UPDATE dental.request_counters SET request_count=request_count+1 WHERE scope=p_scope AND key_hash=p_key_hash;
  v_allowed:=true;
 END IF;
 -- Cleanup is last: no later operation may wait for another request's target.
 -- The expiry index and LIMIT bound work; SKIP LOCKED avoids acquiring a row
 -- owned by another target decision or cleanup. The current target is fresh.
 WITH expired AS (
  SELECT scope,key_hash FROM dental.request_counters
   WHERE window_started_at<v_now-interval '1 day'
   ORDER BY window_started_at,scope,key_hash FOR UPDATE SKIP LOCKED LIMIT 100
 ) DELETE FROM dental.request_counters c USING expired e WHERE c.scope=e.scope AND c.key_hash=e.key_hash;
 RETURN v_allowed;
END;
$body$;
REVOKE ALL ON FUNCTION dental.consume_request_limit(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dental.consume_request_limit(text,text) TO dental_backend;
$definitions$;
 RESET ROLE;
 REVOKE CREATE ON SCHEMA dental FROM dental_function_owner;
 REVOKE dental_function_owner FROM postgres GRANTED BY postgres;
 PERFORM pg_catalog.set_config('lock_timeout', v_original_lock_timeout, true);
 IF pg_catalog.current_setting('lock_timeout') IS DISTINCT FROM v_original_lock_timeout THEN
  RAISE EXCEPTION 'Task 10 did not restore the inherited lock timeout';
 END IF;
 v_new_functions:=ARRAY['dental.consume_request_limit(text,text)'::pg_catalog.regprocedure::oid];
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
  RAISE EXCEPTION 'Task 10 changed existing authorization or did not restore temporary access';
 END IF;
 IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc WHERE pronamespace=v_schema)<>31 THEN
  RAISE EXCEPTION 'Unexpected Task 10 function surface';
 END IF;
 SELECT * INTO STRICT v_function FROM pg_catalog.pg_proc WHERE oid=v_new_functions[1];
 IF v_function.proowner<>v_owner OR NOT v_function.prosecdef
  OR NOT COALESCE(v_function.proconfig @> ARRAY['search_path=""'],false)
  OR NOT pg_catalog.has_function_privilege(v_backend,v_function.oid,'EXECUTE')
  OR NOT pg_catalog.has_function_privilege(v_runtime,v_function.oid,'EXECUTE')
  OR pg_catalog.has_function_privilege(v_postgres,v_function.oid,'EXECUTE')
  OR EXISTS(SELECT FROM pg_catalog.aclexplode(COALESCE(v_function.proacl,pg_catalog.acldefault('f',v_owner))) a
   WHERE a.grantee<>v_owner AND NOT(a.grantee=v_backend AND a.grantor=v_owner AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)) THEN
  RAISE EXCEPTION 'Unsafe new request-limit function ownership, search path or execute ACL';
 END IF;
 SELECT * INTO STRICT v_table FROM pg_catalog.pg_class WHERE oid='dental.request_counters'::pg_catalog.regclass;
 IF v_table.relowner<>v_postgres OR NOT v_table.relrowsecurity OR NOT v_table.relforcerowsecurity
  OR pg_catalog.has_table_privilege(v_owner,v_table.oid,'UPDATE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
  OR pg_catalog.has_column_privilege(v_owner,v_table.oid,'scope','UPDATE')
  OR pg_catalog.has_column_privilege(v_owner,v_table.oid,'key_hash','UPDATE')
  OR NOT pg_catalog.has_column_privilege(v_owner,v_table.oid,'window_started_at','UPDATE')
  OR NOT pg_catalog.has_column_privilege(v_owner,v_table.oid,'request_count','UPDATE') THEN
  RAISE EXCEPTION 'Unsafe request-counter table ownership, RLS or owner privilege';
 END IF;
 FOREACH v_role IN ARRAY ARRAY['dental_backend','dental_runtime','anon','authenticated','authenticator','service_role'] LOOP
  IF pg_catalog.has_table_privilege(v_role,v_table.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
   OR pg_catalog.has_any_column_privilege(v_role,v_table.oid,'SELECT,INSERT,UPDATE,REFERENCES') THEN
   RAISE EXCEPTION 'Private counter has direct runtime or browser access';
  END IF;
 END LOOP;
 FOREACH v_role IN ARRAY ARRAY['anon','authenticated','authenticator','service_role'] LOOP
  IF pg_catalog.pg_has_role(v_role,v_owner,'MEMBER') OR pg_catalog.pg_has_role(v_role,v_backend,'MEMBER')
   OR pg_catalog.has_schema_privilege(v_role,v_schema,'USAGE,CREATE')
   OR pg_catalog.has_function_privilege(v_role,v_function.oid,'EXECUTE') THEN
   RAISE EXCEPTION 'Browser/platform role has a private request-limit path';
  END IF;
 END LOOP;
END;
$task10$;
