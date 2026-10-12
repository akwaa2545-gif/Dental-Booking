-- UNEXECUTED Task 5 managed-Supabase candidate. This file is not deployment
-- permission. Exact-project approval is required for its new private functions,
-- table/policies, least-privilege grants and temporary operator SET membership.
-- One atomic statement. Requires the reviewed Task 3 + Task 4 baseline. No
-- LOGIN role, credential, API schema exposure or browser role grant is created.
DO $task5$
DECLARE
 v_major integer := pg_catalog.current_setting('server_version_num')::integer / 10000;
 v_owner oid := 'dental_function_owner'::pg_catalog.regrole;
 v_backend oid := 'dental_backend'::pg_catalog.regrole;
 v_postgres oid := 'postgres'::pg_catalog.regrole;
 v_schema oid := 'dental'::pg_catalog.regnamespace;
 v_memberships jsonb; v_memberships_after jsonb; v_defaults jsonb; v_defaults_after jsonb;
 v_existing_functions jsonb; v_existing_functions_after jsonb;
 v_function record; v_table record; v_grantee record; v_role text;
 v_new_functions oid[];
BEGIN
 IF CURRENT_USER<>'postgres' OR SESSION_USER<>'postgres' OR v_major NOT IN (15,17)
  OR pg_catalog.current_setting('transaction_read_only')<>'off'
  OR pg_catalog.to_regprocedure('dental.reserve(uuid,uuid,jsonb)') IS NULL
  OR pg_catalog.to_regprocedure('dental.create_session(text,text,text,text,timestamptz)') IS NOT NULL
  OR pg_catalog.to_regclass('dental.oauth_pending') IS NOT NULL THEN
  RAISE EXCEPTION 'Task 5 requires the verified Task 4 managed baseline and unapplied session migration';
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
 IF pg_catalog.jsonb_array_length(v_existing_functions)<>13 THEN RAISE EXCEPTION 'Unexpected Task 4 function set'; END IF;

 -- Temporary membership is restored byte-for-byte to the approved PG15/17
 -- baseline before this outer statement commits, including PG17 creator ADMIN.
 IF v_major=17 THEN
  EXECUTE 'GRANT dental_function_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres';
 ELSE GRANT dental_function_owner TO postgres; END IF;
 GRANT CREATE ON SCHEMA dental TO dental_function_owner;

 CREATE TABLE dental.oauth_pending(
  state_hash text PRIMARY KEY CHECK(state_hash~'^[0-9a-f]{64}$'),
  binding_hash text NOT NULL CHECK(binding_hash~'^[0-9a-f]{64}$'),
  nonce text NOT NULL CHECK(nonce~'^[A-Za-z0-9_-]{43,128}$'),
  code_verifier text NOT NULL CHECK(code_verifier~'^[A-Za-z0-9._~-]{43,128}$'),
  return_path text NOT NULL CHECK(pg_catalog.char_length(return_path) BETWEEN 1 AND 2048),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK(pg_catalog.isfinite(expires_at) AND expires_at>created_at AND expires_at<=created_at+interval '10 minutes')
 );
 CREATE INDEX oauth_pending_expiry ON dental.oauth_pending(expires_at);
 ALTER TABLE dental.oauth_pending ENABLE ROW LEVEL SECURITY;
 ALTER TABLE dental.oauth_pending FORCE ROW LEVEL SECURITY;
 REVOKE ALL ON TABLE dental.oauth_pending FROM PUBLIC;
 -- Sanitize only this new table, without changing postgres-wide defaults.
 FOR v_grantee IN SELECT DISTINCT r.rolname FROM pg_catalog.pg_class c
  CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a JOIN pg_catalog.pg_roles r ON r.oid=a.grantee
  WHERE c.oid='dental.oauth_pending'::pg_catalog.regclass AND a.grantee<>c.relowner
 LOOP EXECUTE pg_catalog.format('REVOKE ALL ON TABLE dental.oauth_pending FROM %I',v_grantee.rolname); END LOOP;

 GRANT INSERT ON dental.accounts TO dental_function_owner;
 GRANT SELECT,INSERT ON dental.sessions TO dental_function_owner;
 GRANT UPDATE(revoked_at) ON dental.sessions TO dental_function_owner;
 GRANT SELECT ON dental.admin_grants TO dental_function_owner;
 GRANT SELECT,INSERT,DELETE ON dental.oauth_pending TO dental_function_owner;
 CREATE POLICY accounts_function_insert ON dental.accounts FOR INSERT TO dental_function_owner WITH CHECK(true);
 CREATE POLICY sessions_function_read ON dental.sessions FOR SELECT TO dental_function_owner USING(true);
 CREATE POLICY sessions_function_insert ON dental.sessions FOR INSERT TO dental_function_owner WITH CHECK(true);
 CREATE POLICY sessions_function_revoke ON dental.sessions FOR UPDATE TO dental_function_owner USING(true) WITH CHECK(true);
 CREATE POLICY admin_grants_function_read ON dental.admin_grants FOR SELECT TO dental_function_owner USING(true);
 CREATE POLICY oauth_function_read ON dental.oauth_pending FOR SELECT TO dental_function_owner USING(true);
 CREATE POLICY oauth_function_insert ON dental.oauth_pending FOR INSERT TO dental_function_owner WITH CHECK(true);
 CREATE POLICY oauth_function_consume ON dental.oauth_pending FOR DELETE TO dental_function_owner USING(true);

 SET LOCAL ROLE dental_function_owner;
 EXECUTE $definitions$
CREATE FUNCTION dental.is_admin(p_actor uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE';
 END IF;
 RETURN EXISTS(SELECT FROM dental.admin_grants WHERE account_id=p_actor AND revoked_at IS NULL);
END;
$body$;

CREATE FUNCTION dental.create_session(p_provider text,p_subject text,p_token_hash text,p_csrf_hash text,p_expires_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_account uuid; v_now timestamptz:=dental.clock_now();
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE';
 END IF;
 IF p_provider IS NULL OR p_provider!~'^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$'
  OR p_subject IS NULL OR pg_catalog.char_length(p_subject) NOT BETWEEN 1 AND 255 OR p_subject~'[[:cntrl:]]'
  OR p_token_hash IS NULL OR p_token_hash!~'^[0-9a-f]{64}$'
  OR p_csrf_hash IS NULL OR p_csrf_hash!~'^[0-9a-f]{64}$'
  OR p_expires_at IS NULL OR NOT pg_catalog.isfinite(p_expires_at)
  OR p_expires_at<=v_now OR p_expires_at>v_now+interval '2 hours' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
 END IF;
 -- Subject and provider come only from the verified LINE adapter, never from
 -- client claims. Distinct LINE providers cannot accidentally merge accounts.
 INSERT INTO dental.accounts(provider,subject) VALUES(p_provider,p_subject) ON CONFLICT(provider,subject) DO NOTHING;
 SELECT id INTO STRICT v_account FROM dental.accounts WHERE provider=p_provider AND subject=p_subject;
 -- Recheck after waiting for a concurrent first login of this identity.
 v_now:=dental.clock_now();
 IF p_expires_at<=v_now THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAUTHENTICATED'; END IF;
 INSERT INTO dental.sessions(account_id,token_hash,csrf_hash,created_at,expires_at)
  VALUES(v_account,p_token_hash,p_csrf_hash,v_now,p_expires_at);
 RETURN pg_catalog.jsonb_build_object('accountId',v_account,'csrfHash',p_csrf_hash,'expiresAt',p_expires_at,'isAdmin',dental.is_admin(v_account));
END;
$body$;

CREATE FUNCTION dental.resolve_session(p_token_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_session dental.sessions;
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE';
 END IF;
 IF p_token_hash IS NULL OR p_token_hash!~'^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
 SELECT * INTO v_session FROM dental.sessions WHERE token_hash=p_token_hash AND revoked_at IS NULL AND expires_at>dental.clock_now();
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN pg_catalog.jsonb_build_object('accountId',v_session.account_id,'csrfHash',v_session.csrf_hash,'expiresAt',v_session.expires_at,'isAdmin',dental.is_admin(v_session.account_id));
END;
$body$;

CREATE FUNCTION dental.revoke_session(p_token_hash text)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
BEGIN
 IF p_token_hash IS NULL OR p_token_hash!~'^[0-9a-f]{64}$' THEN RETURN; END IF;
 UPDATE dental.sessions SET revoked_at=dental.clock_now() WHERE token_hash=p_token_hash AND revoked_at IS NULL;
END;
$body$;

CREATE FUNCTION dental.save_oauth_pending(p_state_hash text,p_binding_hash text,p_nonce text,p_code_verifier text,p_return_path text,p_expires_at timestamptz)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_now timestamptz:=dental.clock_now();
BEGIN
 IF p_state_hash IS NULL OR p_state_hash!~'^[0-9a-f]{64}$'
  OR p_binding_hash IS NULL OR p_binding_hash!~'^[0-9a-f]{64}$'
  OR p_nonce IS NULL OR p_nonce!~'^[A-Za-z0-9_-]{43,128}$'
  OR p_code_verifier IS NULL OR p_code_verifier!~'^[A-Za-z0-9._~-]{43,128}$'
  OR p_return_path IS NULL OR pg_catalog.char_length(p_return_path) NOT BETWEEN 1 AND 2048
  OR pg_catalog.left(p_return_path,1)<>'/' OR pg_catalog.left(p_return_path,2)='//'
  OR p_return_path~'[[:space:][:cntrl:]]' OR pg_catalog.strpos(p_return_path,pg_catalog.chr(92))>0
  OR p_return_path~*'%(2f|5c|0[0-9a-f]|1[0-9a-f]|7f)'
  OR p_expires_at IS NULL OR NOT pg_catalog.isfinite(p_expires_at)
  OR p_expires_at<=v_now OR p_expires_at>v_now+interval '10 minutes' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';
 END IF;
 -- A duplicate state fails rather than replacing the browser binding or PKCE
 -- verifier. Neither state nor the browser-binding credential is persisted raw.
 INSERT INTO dental.oauth_pending(state_hash,binding_hash,nonce,code_verifier,return_path,created_at,expires_at)
  VALUES(p_state_hash,p_binding_hash,p_nonce,p_code_verifier,p_return_path,v_now,p_expires_at);
END;
$body$;

CREATE FUNCTION dental.consume_oauth_pending(p_state_hash text,p_binding_hash text)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_pending dental.oauth_pending;
BEGIN
 IF p_state_hash IS NULL OR p_state_hash!~'^[0-9a-f]{64}$'
  OR p_binding_hash IS NULL OR p_binding_hash!~'^[0-9a-f]{64}$' THEN RETURN NULL; END IF;
 -- DELETE ... RETURNING is the one atomic consume operation across isolates
 -- and competing callbacks. Check the actual clock AFTER any row-lock wait.
 DELETE FROM dental.oauth_pending WHERE state_hash=p_state_hash AND binding_hash=p_binding_hash RETURNING * INTO v_pending;
 IF NOT FOUND OR v_pending.expires_at<=dental.clock_now() THEN RETURN NULL; END IF;
 RETURN pg_catalog.jsonb_build_object('stateHash',v_pending.state_hash,'bindingHash',v_pending.binding_hash,
  'nonce',v_pending.nonce,'codeVerifier',v_pending.code_verifier,'returnPath',v_pending.return_path,'expiresAt',v_pending.expires_at);
END;
$body$;

REVOKE ALL ON FUNCTION dental.create_session(text,text,text,text,timestamptz),dental.resolve_session(text),dental.revoke_session(text),dental.is_admin(uuid),dental.save_oauth_pending(text,text,text,text,text,timestamptz),dental.consume_oauth_pending(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dental.create_session(text,text,text,text,timestamptz),dental.resolve_session(text),dental.revoke_session(text),dental.is_admin(uuid),dental.save_oauth_pending(text,text,text,text,text,timestamptz),dental.consume_oauth_pending(text,text) TO dental_backend;
$definitions$;
 RESET ROLE;
 REVOKE CREATE ON SCHEMA dental FROM dental_function_owner;
 IF v_major=17 THEN EXECUTE 'REVOKE dental_function_owner FROM postgres GRANTED BY postgres';
 ELSE REVOKE dental_function_owner FROM postgres; END IF;

 v_new_functions:=ARRAY[
  'dental.create_session(text,text,text,text,timestamptz)'::pg_catalog.regprocedure::oid,
  'dental.resolve_session(text)'::pg_catalog.regprocedure::oid,
  'dental.revoke_session(text)'::pg_catalog.regprocedure::oid,
  'dental.is_admin(uuid)'::pg_catalog.regprocedure::oid,
  'dental.save_oauth_pending(text,text,text,text,text,timestamptz)'::pg_catalog.regprocedure::oid,
  'dental.consume_oauth_pending(text,text)'::pg_catalog.regprocedure::oid];
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY roleid,member,grantor),'[]'::jsonb)
  INTO v_memberships_after FROM pg_catalog.pg_auth_members m WHERE roleid IN (v_owner,v_backend);
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.oid),'[]'::jsonb)
  INTO v_defaults_after FROM pg_catalog.pg_default_acl d WHERE d.defaclrole=v_postgres;
 SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('oid',p.oid,'definition',pg_catalog.pg_get_functiondef(p.oid),'acl',p.proacl) ORDER BY p.oid)
  INTO v_existing_functions_after FROM pg_catalog.pg_proc p WHERE p.pronamespace=v_schema AND p.oid<>ALL(v_new_functions);
 IF v_memberships IS DISTINCT FROM v_memberships_after OR v_defaults IS DISTINCT FROM v_defaults_after
  OR v_existing_functions IS DISTINCT FROM v_existing_functions_after
  OR pg_catalog.has_schema_privilege(v_owner,v_schema,'CREATE') OR pg_catalog.has_schema_privilege(v_backend,v_schema,'CREATE') THEN
  RAISE EXCEPTION 'Task 5 changed an existing function/default or did not restore temporary access';
 END IF;
 IF (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc WHERE pronamespace=v_schema)<>19 THEN
  RAISE EXCEPTION 'Unexpected Task 5 function surface';
 END IF;
 FOR v_function IN SELECT * FROM pg_catalog.pg_proc WHERE oid=ANY(v_new_functions) LOOP
  IF v_function.proowner<>v_owner OR NOT v_function.prosecdef
   OR NOT COALESCE(v_function.proconfig @> ARRAY['search_path=""'],false)
   OR NOT pg_catalog.has_function_privilege(v_backend,v_function.oid,'EXECUTE')
   OR pg_catalog.has_function_privilege(v_postgres,v_function.oid,'EXECUTE')
   OR EXISTS(SELECT FROM pg_catalog.aclexplode(COALESCE(v_function.proacl,pg_catalog.acldefault('f',v_owner))) a
    WHERE a.grantee<>v_owner AND NOT(a.grantee=v_backend AND a.grantor=v_owner AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)) THEN
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
 IF pg_catalog.has_table_privilege(v_owner,'dental.sessions','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR NOT pg_catalog.has_column_privilege(v_owner,'dental.sessions','revoked_at','UPDATE')
  OR EXISTS(SELECT FROM pg_catalog.pg_attribute a WHERE a.attrelid='dental.sessions'::pg_catalog.regclass
   AND a.attnum>0 AND NOT a.attisdropped AND a.attname<>'revoked_at'
   AND pg_catalog.has_column_privilege(v_owner,a.attrelid,a.attname,'UPDATE'))
  OR pg_catalog.has_table_privilege(v_owner,'dental.admin_grants','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  OR pg_catalog.has_table_privilege(v_owner,'dental.oauth_pending','UPDATE,TRUNCATE,REFERENCES,TRIGGER') THEN
  RAISE EXCEPTION 'Session owner access exceeds the reviewed credential surface';
 END IF;
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
 -- The six entry points trust only the restricted backend. They do not grant
 -- admin roles, verify provider claims themselves, or expose a public RPC API.
END;
$task5$;
