-- UNEXECUTED migration 010 candidate. Local validation is not permission to apply
-- this to a hosted project. Requires separate exact-project approval.
-- The only persistent change is the existing restricted prepare function body:
-- include its trusted authorization deadline and final database preparation time.
-- Migration 009, durable one-attempt consumption, eligibility checks, payload,
-- ACLs, roles, memberships, policies, triggers and all application rows remain.
-- One atomic DO; inherited statement timeout 1ms..2min, per-lock timeout 3s.
DO $restricted_deadline$
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
 v_prepare oid; v_before text; v_after text; v_source text;
 v_catalog jsonb; v_catalog_after jsonb;
 v_declaration text := 'DECLARE v_auth dental.restricted_dispatch_authorizations; v_result jsonb;';
 v_final_check text := '  IF v_auth.expires_at<=dental.clock_now() THEN RAISE EXCEPTION USING ERRCODE=''RD001'',MESSAGE=''NO_RESTRICTED_DISPATCH''; END IF;';
 v_return text := ' RETURN v_result;';
BEGIN
 -- A statement timer must already be running when this DO starts; setting it
 -- inside an executing DO is not a substitute. The whole migration is capped.
 IF (SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name = 'statement_timeout') NOT BETWEEN 1 AND 120000 THEN
  RAISE EXCEPTION 'Restricted deadline requires an inherited statement timeout between 1ms and 2min';
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
  RAISE EXCEPTION 'Restricted deadline requires the verified migration 009 managed baseline';
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
  RAISE EXCEPTION 'Unreviewed Restricted deadline private/runtime role attributes or role settings';
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
  RAISE EXCEPTION 'Unreviewed exact Restricted deadline runtime membership baseline';
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
  INTO v_defaults FROM pg_catalog.pg_default_acl d WHERE d.defaclrole IN (v_postgres,v_owner);
 v_prepare:='dental.prepare_restricted_dispatch(uuid,uuid,uuid,text)'::pg_catalog.regprocedure::oid;
 SELECT * INTO STRICT v_function FROM pg_catalog.pg_proc WHERE oid=v_prepare;
 IF v_function.proowner<>v_owner OR NOT v_function.prosecdef OR v_function.provolatile<>'v'
  OR v_function.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
  OR v_function.proisstrict OR v_function.proleakproof OR v_function.proparallel<>'u'
  OR v_function.prorettype<>'jsonb'::pg_catalog.regtype OR v_function.proretset
  OR v_function.prokind<>'f' OR v_function.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
  OR NOT pg_catalog.has_function_privilege(v_backend,v_prepare,'EXECUTE')
  OR NOT pg_catalog.has_function_privilege(v_runtime,v_prepare,'EXECUTE')
  OR pg_catalog.has_function_privilege(v_postgres,v_prepare,'EXECUTE')
  OR EXISTS(SELECT FROM pg_catalog.aclexplode(COALESCE(v_function.proacl,pg_catalog.acldefault('f',v_owner))) a
   WHERE a.grantee<>v_owner AND NOT(a.grantee=v_backend AND a.grantor=v_owner AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)) THEN
  RAISE EXCEPTION 'Unreviewed restricted prepare security attributes or execute ACL';
 END IF;
 -- Match the exact original migration 009 body, not merely replace an anchor in
 -- arbitrary deployed code. Already-applied and independently edited code fail.
 IF pg_catalog.md5(v_function.prosrc)<>'023d1601534e259ff1a8e83bc1d7d95c' THEN
  RAISE EXCEPTION 'Unreviewed or already-updated restricted prepare source';
 END IF;
 SELECT * INTO STRICT v_table FROM pg_catalog.pg_class WHERE oid='dental.restricted_dispatch_authorizations'::pg_catalog.regclass;
 IF v_table.relowner<>v_postgres OR NOT v_table.relrowsecurity OR NOT v_table.relforcerowsecurity
  OR pg_catalog.has_table_privilege(v_owner,v_table.oid,'INSERT,DELETE,UPDATE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
  OR pg_catalog.has_column_privilege(v_owner,v_table.oid,'event_id','UPDATE')
  OR pg_catalog.has_column_privilege(v_owner,v_table.oid,'owner_id','UPDATE')
  OR pg_catalog.has_column_privilege(v_owner,v_table.oid,'expires_at','UPDATE')
  OR NOT pg_catalog.has_column_privilege(v_owner,v_table.oid,'consumed_at','UPDATE')
  OR NOT pg_catalog.has_column_privilege(v_owner,v_table.oid,'consumed_by','UPDATE') THEN
  RAISE EXCEPTION 'Unreviewed restricted authorization table security';
 END IF;
 FOREACH v_role IN ARRAY ARRAY['anon','authenticated','authenticator','service_role'] LOOP
  IF pg_catalog.pg_has_role(v_role,v_owner,'MEMBER') OR pg_catalog.pg_has_role(v_role,v_backend,'MEMBER')
   OR pg_catalog.has_schema_privilege(v_role,v_schema,'USAGE,CREATE')
   OR pg_catalog.has_function_privilege(v_role,v_prepare,'EXECUTE')
   OR pg_catalog.has_table_privilege(v_role,v_table.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
   OR pg_catalog.has_any_column_privilege(v_role,v_table.oid,'SELECT,INSERT,UPDATE,REFERENCES') THEN
   RAISE EXCEPTION 'Browser/platform role has a private restricted-dispatch path';
  END IF;
 END LOOP;
 IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc WHERE pronamespace=v_schema)<>34
  OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_class WHERE relnamespace=v_schema AND relkind='r')<>15
  OR NOT EXISTS(SELECT FROM pg_catalog.pg_trigger WHERE tgrelid='dental.notification_attempts'::pg_catalog.regclass
   AND tgname='fence_restricted_attempt' AND tgfoid='dental._fence_restricted_attempt()'::pg_catalog.regprocedure
   AND tgtype=7 AND tgenabled='O' AND NOT tgisinternal)
  OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_policy WHERE polrelid=v_table.oid)<>2 THEN
  RAISE EXCEPTION 'Unreviewed migration 009 function, table, trigger or policy surface';
 END IF;
 SELECT pg_catalog.pg_get_functiondef(v_prepare) INTO v_before;
 v_after:=pg_catalog.replace(v_before,v_declaration,v_declaration||' v_now timestamptz;');
 v_after:=pg_catalog.replace(v_after,v_final_check,'  v_now:=dental.clock_now();'||E'\n'||pg_catalog.replace(v_final_check,'dental.clock_now()','v_now'));
 v_after:=pg_catalog.replace(v_after,v_return,' RETURN v_result||pg_catalog.jsonb_build_object(''authorizationExpiresAt'',v_auth.expires_at,''preparedAt'',v_now);');
 v_source:=pg_catalog.replace(v_function.prosrc,v_declaration,v_declaration||' v_now timestamptz;');
 v_source:=pg_catalog.replace(v_source,v_final_check,'  v_now:=dental.clock_now();'||E'\n'||pg_catalog.replace(v_final_check,'dental.clock_now()','v_now'));
 v_source:=pg_catalog.replace(v_source,v_return,' RETURN v_result||pg_catalog.jsonb_build_object(''authorizationExpiresAt'',v_auth.expires_at,''preparedAt'',v_now);');
 -- Snapshot every pg_proc property, not only its printed definition. The only
 -- allowed catalog delta is prosrc for this exact OID; CREATE OR REPLACE retains
 -- ownership/ACLs and re-emits all existing language/security/config attributes.
 SELECT pg_catalog.jsonb_agg(CASE WHEN p.oid=v_prepare
   THEN pg_catalog.jsonb_set(pg_catalog.to_jsonb(p),'{prosrc}',pg_catalog.to_jsonb(v_source))
   ELSE pg_catalog.to_jsonb(p) END ORDER BY p.oid)
  INTO v_existing_functions FROM pg_catalog.pg_proc p WHERE p.pronamespace=v_schema;
 SELECT pg_catalog.jsonb_build_object(
  'schema',(SELECT pg_catalog.to_jsonb(n) FROM pg_catalog.pg_namespace n WHERE n.oid=v_schema),
  'tables',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('oid',c.oid,'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force',c.relforcerowsecurity) ORDER BY c.oid) FROM pg_catalog.pg_class c WHERE c.relnamespace=v_schema),
  'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.attrelid,a.attnum) FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid WHERE c.relnamespace=v_schema),
  'policies',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid) FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid WHERE c.relnamespace=v_schema),
  'triggers',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=v_schema),
  'constraints',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c) ORDER BY c.oid) FROM pg_catalog.pg_constraint c WHERE c.connamespace=v_schema)
 ) INTO v_catalog;
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 GRANT dental_function_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
 GRANT CREATE ON SCHEMA dental TO dental_function_owner;
 SET LOCAL ROLE dental_function_owner;
 EXECUTE v_after;
 RESET ROLE;
 REVOKE CREATE ON SCHEMA dental FROM dental_function_owner;
 REVOKE dental_function_owner FROM postgres GRANTED BY postgres;
 PERFORM pg_catalog.set_config('lock_timeout',v_original_lock_timeout,true);
 SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid)
  INTO v_existing_functions_after FROM pg_catalog.pg_proc p WHERE p.pronamespace=v_schema;
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY roleid,member,grantor),'[]'::jsonb)
  INTO v_memberships_after FROM pg_catalog.pg_auth_members m
  WHERE m.roleid IN (v_owner,v_backend,v_runtime) OR m.member IN (v_owner,v_backend,v_runtime);
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.oid),'[]'::jsonb)
  INTO v_defaults_after FROM pg_catalog.pg_default_acl d WHERE d.defaclrole IN (v_postgres,v_owner);
 SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r)-'rolpassword' ORDER BY r.oid)
  INTO v_roles_after FROM pg_catalog.pg_roles r WHERE r.oid IN (v_owner,v_backend,v_runtime);
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r) ORDER BY r.setdatabase,r.setrole),'[]'::jsonb)
  INTO v_role_settings_after FROM pg_catalog.pg_db_role_setting r WHERE r.setrole IN (v_owner,v_backend,v_runtime);
 SELECT pg_catalog.jsonb_build_object(
  'schema',(SELECT pg_catalog.to_jsonb(n) FROM pg_catalog.pg_namespace n WHERE n.oid=v_schema),
  'tables',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('oid',c.oid,'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force',c.relforcerowsecurity) ORDER BY c.oid) FROM pg_catalog.pg_class c WHERE c.relnamespace=v_schema),
  'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.attrelid,a.attnum) FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid WHERE c.relnamespace=v_schema),
  'policies',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid) FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid WHERE c.relnamespace=v_schema),
  'triggers',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=v_schema),
  'constraints',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c) ORDER BY c.oid) FROM pg_catalog.pg_constraint c WHERE c.connamespace=v_schema)
 ) INTO v_catalog_after;
 IF v_existing_functions IS DISTINCT FROM v_existing_functions_after
  OR v_catalog IS DISTINCT FROM v_catalog_after
  OR v_memberships IS DISTINCT FROM v_memberships_after OR v_defaults IS DISTINCT FROM v_defaults_after
  OR v_roles IS DISTINCT FROM v_roles_after OR v_role_settings IS DISTINCT FROM v_role_settings_after
  OR pg_catalog.pg_get_functiondef(v_prepare) IS DISTINCT FROM v_after
  OR CURRENT_USER<>'postgres' OR pg_catalog.current_setting('role')<>'none'
  OR pg_catalog.current_setting('lock_timeout') IS DISTINCT FROM v_original_lock_timeout THEN
  RAISE EXCEPTION 'Restricted deadline changed unrelated catalogs or did not restore temporary access/settings';
 END IF;
END;
$restricted_deadline$;
