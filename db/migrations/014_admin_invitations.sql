-- LOCAL CANDIDATE ONLY. No hosted migration, owner selection, grant, credential or send is authorized.
-- Frozen reviewed migration 013, integrated at e6cb852:
-- SHA256 d3aa841580ad4293edc3434f5e25579549b5e7412ede63969ae0cb35a2904171.
-- Lifecycle compatibility is tested on this frozen baseline; hosted rollout remains separate.
DO $admin_management$
DECLARE
 v_major integer:=pg_catalog.current_setting('server_version_num')::integer/10000;
 v_owner oid:='dental_function_owner'::regrole;v_backend oid:='dental_backend'::regrole;
 v_runtime oid:='dental_runtime'::regrole;v_postgres oid:='postgres'::regrole;v_schema oid:='dental'::regnamespace;
 v_memberships jsonb;v_memberships_after jsonb;v_defaults jsonb;v_defaults_after jsonb;
 v_roles jsonb;v_roles_after jsonb;v_role_settings jsonb;v_role_settings_after jsonb;
 v_normalized_memberships jsonb;
 v_expected_memberships jsonb:='[
  {"role":"dental_backend","member":"dental_runtime","grantor":"postgres","admin":false,"inherit":true,"set":false},
  {"role":"dental_backend","member":"postgres","grantor":"supabase_admin","admin":true,"inherit":false,"set":false},
  {"role":"dental_function_owner","member":"postgres","grantor":"supabase_admin","admin":true,"inherit":false,"set":false},
  {"role":"dental_runtime","member":"postgres","grantor":"supabase_admin","admin":true,"inherit":false,"set":false}
 ]'::jsonb;
 v_function record;v_table record;v_grantee record;v_role text;v_new oid;
 v_fingerprint jsonb;v_functions jsonb;v_functions_after jsonb;
 v_old_tables oid[];v_catalog jsonb;v_catalog_after jsonb;
BEGIN
 -- A statement timer must already be running when this DO starts; setting it
 -- inside an executing DO is not a substitute. The whole migration is capped.
 IF (SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name = 'statement_timeout') NOT BETWEEN 1 AND 120000 THEN
  RAISE EXCEPTION 'Admin management require an inherited statement timeout between 1ms and 2min';
 END IF;
 IF CURRENT_USER<>'postgres' OR SESSION_USER<>'postgres' OR v_major<>17
  OR pg_catalog.current_setting('role')<>'none'
  OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
  OR pg_catalog.current_setting('transaction_read_only')<>'off'
  OR pg_catalog.to_regprocedure('dental.decide(uuid,uuid,integer,text,text)') IS NULL
  OR pg_catalog.to_regprocedure('dental.claim_events(uuid,integer)') IS NULL
  OR pg_catalog.to_regprocedure('dental.consume_request_limit(text,text)') IS NULL
  OR pg_catalog.to_regprocedure('dental.claim_restricted_event(uuid,uuid,uuid)') IS NULL
  OR pg_catalog.to_regclass('dental.patient_dispatch_authorizations') IS NULL
  OR pg_catalog.to_regprocedure('dental.claim_patient_event(uuid)') IS NULL
  OR pg_catalog.to_regclass('dental.admin_notification_policy') IS NULL
  OR pg_catalog.to_regprocedure('dental.prepare_restricted_dispatch(uuid,uuid,uuid,text)') IS NULL
  OR pg_catalog.to_regprocedure('dental._fence_restricted_attempt()') IS NULL
  OR pg_catalog.to_regclass('dental.restricted_dispatch_authorizations') IS NULL THEN
  RAISE EXCEPTION 'Admin management require the verified migration 013 managed baseline';
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
  RAISE EXCEPTION 'Unreviewed Admin management private/runtime role attributes or role settings';
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
  RAISE EXCEPTION 'Unreviewed exact Admin management runtime membership baseline';
 END IF;
 IF pg_catalog.pg_has_role(v_runtime,v_owner,'MEMBER')
  OR pg_catalog.has_schema_privilege(v_runtime,v_schema,'CREATE')
  OR NOT pg_catalog.has_schema_privilege(v_runtime,v_schema,'USAGE') THEN
  RAISE EXCEPTION 'Unsafe runtime owner membership or schema access';
 END IF;
 FOR v_table IN SELECT * FROM pg_catalog.pg_class WHERE relnamespace=v_schema AND relkind='r' LOOP
  IF v_table.relowner<>v_postgres OR NOT v_table.relrowsecurity OR NOT v_table.relforcerowsecurity
   OR pg_catalog.has_table_privilege(v_backend,v_table.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
   OR pg_catalog.has_any_column_privilege(v_backend,v_table.oid,'SELECT,INSERT,UPDATE,REFERENCES')
   OR pg_catalog.has_table_privilege(v_runtime,v_table.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
   OR pg_catalog.has_any_column_privilege(v_runtime,v_table.oid,'SELECT,INSERT,UPDATE,REFERENCES') THEN
   RAISE EXCEPTION 'Runtime has unreviewed direct private table or column access';
  END IF;
 END LOOP;
 FOR v_function IN SELECT * FROM pg_catalog.pg_proc WHERE pronamespace=v_schema LOOP
  IF pg_catalog.has_function_privilege(v_runtime,v_function.oid,'EXECUTE') IS DISTINCT FROM pg_catalog.has_function_privilege(v_backend,v_function.oid,'EXECUTE') THEN
   RAISE EXCEPTION 'Runtime function surface differs from inherited backend access';
  END IF;
  IF v_function.proowner<>v_owner OR v_function.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
   OR (pg_catalog.left(v_function.proname::text,1)='_' AND pg_catalog.has_function_privilege(v_backend,v_function.oid,'EXECUTE'))
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

 IF EXISTS(SELECT FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
  WHERE c.relnamespace=v_schema AND t.tgisinternal AND t.tgenabled<>'O') THEN
  RAISE EXCEPTION 'Unreviewed disabled private constraint trigger baseline';END IF;
 -- Refuse unknown function, table, ACL, RLS, constraint, index, trigger, rule or default drift.
 select pg_catalog.jsonb_build_object(
 'functions', (select pg_catalog.md5(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('definition',pg_catalog.pg_get_functiondef(p.oid),'owner',pg_catalog.pg_get_userbyid(p.proowner),
   'acl',p.proacl::text,'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,'cost',p.procost,'rows',p.prorows)
   order by p.oid::regprocedure::text collate "C")::text) from pg_catalog.pg_proc p where p.pronamespace='dental'::regnamespace),
 'tables', (select pg_catalog.md5(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',c.relname,'kind',c.relkind,'owner',pg_catalog.pg_get_userbyid(c.relowner),
  'rls',c.relrowsecurity,'force',c.relforcerowsecurity,'acl',c.relacl::text,'options',c.reloptions,
  'columns',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',a.attname,'type',pg_catalog.format_type(a.atttypid,a.atttypmod),'null',a.attnotnull,
    'acl',a.attacl::text,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid),'generated',a.attgenerated,'identity',a.attidentity)
    order by a.attnum) from pg_catalog.pg_attribute a left join pg_catalog.pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
  'constraints',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',k.conname,'definition',pg_catalog.pg_get_constraintdef(k.oid),'validated',k.convalidated)
    order by k.conname collate "C") from pg_catalog.pg_constraint k where k.conrelid=c.oid),
  'indexes',(select pg_catalog.jsonb_agg(pg_catalog.pg_get_indexdef(i.indexrelid) order by pg_catalog.pg_get_indexdef(i.indexrelid) collate "C") from pg_catalog.pg_index i where i.indrelid=c.oid),
  'policies',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
    'roles',(select pg_catalog.array_agg(pg_catalog.pg_get_userbyid(r) order by pg_catalog.pg_get_userbyid(r) collate "C") from pg_catalog.unnest(p.polroles) r),
    'using',pg_catalog.pg_get_expr(p.polqual,p.polrelid),'check',pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid)) order by p.polname collate "C") from pg_catalog.pg_policy p where p.polrelid=c.oid),
  'triggers',(select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('definition',pg_catalog.pg_get_triggerdef(t.oid),'enabled',t.tgenabled) order by t.tgname collate "C") from pg_catalog.pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal),
  'rules',(select pg_catalog.jsonb_agg(pg_catalog.pg_get_ruledef(r.oid) order by r.rulename collate "C") from pg_catalog.pg_rewrite r where r.ev_class=c.oid)
 ) order by c.relname collate "C")::text) from pg_catalog.pg_class c where c.relnamespace='dental'::regnamespace and c.relkind in('r','v','m','f','p')),
 'defaults',(select pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('role',pg_catalog.pg_get_userbyid(d.defaclrole),'schema',coalesce(n.nspname,''),'type',d.defaclobjtype,'acl',d.defaclacl::text)
  order by pg_catalog.pg_get_userbyid(d.defaclrole) collate "C",coalesce(n.nspname,'') collate "C",d.defaclobjtype),'[]'::jsonb)::text)
  from pg_catalog.pg_default_acl d left join pg_catalog.pg_namespace n on n.oid=d.defaclnamespace where d.defaclrole in('postgres'::regrole,'dental_function_owner'::regrole)),
 'schema',(select pg_catalog.md5(pg_catalog.jsonb_build_object('owner',pg_catalog.pg_get_userbyid(nspowner),'acl',nspacl::text)::text) from pg_catalog.pg_namespace where nspname='dental')
) into v_fingerprint;
 -- Exact synthetic or reviewed hosted public/storage defaults; all other fields
 -- and all-schema raw default-ACL normalization/preservation remain unchanged.
 IF v_fingerprint IS DISTINCT FROM '{"schema":"4ae008106c89761f7c6d1788e7cdf716","tables":"aa1389f8ca59101cad612ab44cb147cb","defaults":"4146858b1996fc4459bbe6f4feaddbc3","functions":"33106746d4c95b00c6d9a2deda5ee1d7"}'::jsonb
  AND v_fingerprint IS DISTINCT FROM '{"schema":"4ae008106c89761f7c6d1788e7cdf716","tables":"aa1389f8ca59101cad612ab44cb147cb","defaults":"4e67d902862ac6ff8df82cf6c6b75a0e","functions":"33106746d4c95b00c6d9a2deda5ee1d7"}'::jsonb THEN
  RAISE EXCEPTION 'Unreviewed or already-updated admin management baseline 013';
 END IF;
 SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid) INTO v_functions FROM pg_catalog.pg_proc p WHERE p.pronamespace=v_schema;
 SELECT pg_catalog.array_agg(oid) INTO v_old_tables FROM pg_catalog.pg_class WHERE relnamespace=v_schema;
 SELECT pg_catalog.jsonb_build_object(
  'tables',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c) ORDER BY c.oid) FROM pg_catalog.pg_class c WHERE c.oid=ANY(v_old_tables)),
  'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.attrelid,a.attnum) FROM pg_catalog.pg_attribute a WHERE a.attrelid=ANY(v_old_tables)),
  'policies',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid) FROM pg_catalog.pg_policy p WHERE p.polrelid=ANY(v_old_tables)),
  'triggers',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_trigger t WHERE t.tgrelid=ANY(v_old_tables))
 ) INTO v_catalog;
 GRANT dental_function_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
 GRANT CREATE ON SCHEMA dental TO dental_function_owner;

 -- Shared schemas count UTF-16 code units: supplementary code points count twice.
 CREATE TABLE dental.admin_invitations(
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  request_id uuid NOT NULL,
  token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
  label text NOT NULL CHECK((pg_catalog.char_length(label)+pg_catalog.char_length(pg_catalog.regexp_replace(label,U&'[\0001-\FFFF]','','g'))) BETWEEN 1 AND 120 AND label=pg_catalog.btrim(label,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')),
  reason text CHECK((pg_catalog.char_length(reason)+pg_catalog.char_length(pg_catalog.regexp_replace(reason,U&'[\0001-\FFFF]','','g'))) BETWEEN 1 AND 500 AND reason=pg_catalog.btrim(reason,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')),
  issuer_account_id uuid NOT NULL REFERENCES dental.accounts(id),
  issuer_grant_id uuid NOT NULL REFERENCES dental.admin_grants(id),
  created_at timestamptz NOT NULL DEFAULT dental.clock_now() CHECK(pg_catalog.isfinite(created_at)),
  expires_at timestamptz NOT NULL CHECK(pg_catalog.isfinite(expires_at) AND expires_at=created_at+interval '24 hours'),
  state text NOT NULL DEFAULT 'issued' CHECK(state IN('issued','claimed','approved','rejected','cancelled','locked')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  failed_verification_count integer NOT NULL DEFAULT 0 CHECK(failed_verification_count BETWEEN 0 AND 5),
  claimant_account_id uuid REFERENCES dental.accounts(id),
  claimed_at timestamptz CHECK(pg_catalog.isfinite(claimed_at) AND claimed_at>=created_at AND claimed_at<expires_at),
  claim_reference text UNIQUE CHECK(claim_reference ~ '^I-[0-9a-f]{32}$'),
  verification_code text CHECK(verification_code ~ '^[0-9]{8}$'),
  approved_by uuid REFERENCES dental.accounts(id),
  approved_grant_id uuid UNIQUE REFERENCES dental.admin_grants(id),
  closed_by uuid REFERENCES dental.accounts(id),
  closed_at timestamptz CHECK(pg_catalog.isfinite(closed_at) AND closed_at>=created_at),
  UNIQUE(issuer_account_id,request_id),
  CHECK((claimant_account_id IS NULL AND claimed_at IS NULL AND claim_reference IS NULL) OR
        (claimant_account_id IS NOT NULL AND claimed_at IS NOT NULL AND claim_reference IS NOT NULL)),
  CHECK(state NOT IN('claimed','approved','locked') OR claimant_account_id IS NOT NULL),
  CHECK(state<>'issued' OR claimant_account_id IS NULL),
  -- Claimed codes may be erased by bounded cleanup after expiry/invalidation.
  CHECK(verification_code IS NULL OR state='claimed'),
  CHECK((state='approved')=(approved_by IS NOT NULL AND approved_grant_id IS NOT NULL)),
  CHECK(state='approved' OR (approved_by IS NULL AND approved_grant_id IS NULL)),
  CHECK((state IN('approved','rejected','cancelled','locked'))=(closed_at IS NOT NULL)),
  CHECK(state<>'locked' OR failed_verification_count=5),
  CHECK(failed_verification_count<5 OR state='locked')
 );
 CREATE INDEX admin_invitations_pending ON dental.admin_invitations(created_at DESC,id DESC) WHERE state IN('issued','claimed');
 CREATE INDEX admin_invitations_claimant ON dental.admin_invitations(claimant_account_id,created_at DESC,id DESC) WHERE claimant_account_id IS NOT NULL;
 CREATE INDEX admin_invitations_issue_limit ON dental.admin_invitations(issuer_account_id,created_at);
 CREATE INDEX admin_invitations_code_cleanup ON dental.admin_invitations(expires_at,id) WHERE state='claimed' AND verification_code IS NOT NULL;
 CREATE INDEX admin_invitations_issuer_grant ON dental.admin_invitations(issuer_grant_id);
 CREATE INDEX admin_invitations_approved_by ON dental.admin_invitations(approved_by) WHERE approved_by IS NOT NULL;
 CREATE INDEX admin_invitations_closed_by ON dental.admin_invitations(closed_by) WHERE closed_by IS NOT NULL;
 CREATE TABLE dental.admin_management_owner(
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  account_id uuid NOT NULL REFERENCES dental.accounts(id),
  designated_by uuid NOT NULL REFERENCES dental.accounts(id),
  designated_at timestamptz NOT NULL CHECK(pg_catalog.isfinite(designated_at)),
  reason text NOT NULL CHECK((pg_catalog.char_length(reason)+pg_catalog.char_length(pg_catalog.regexp_replace(reason,U&'[\0001-\FFFF]','','g'))) BETWEEN 1 AND 500 AND reason=pg_catalog.btrim(reason,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'))
 );
 CREATE TABLE dental.admin_management_audit(
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  action text NOT NULL CHECK(action ~ '^[a-z][a-z0-9_]{0,79}$'),
  actor_account_id uuid NOT NULL REFERENCES dental.accounts(id),
  target_account_id uuid REFERENCES dental.accounts(id),
  invitation_id uuid REFERENCES dental.admin_invitations(id),
  grant_id uuid REFERENCES dental.admin_grants(id),
  result text NOT NULL CHECK(result IN('success','forbidden','not_found','duplicate','version_conflict','rate_limited','invalid_transition')),
  reason text CHECK((pg_catalog.char_length(reason)+pg_catalog.char_length(pg_catalog.regexp_replace(reason,U&'[\0001-\FFFF]','','g'))) BETWEEN 1 AND 500 AND reason=pg_catalog.btrim(reason,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')),
  occurred_at timestamptz NOT NULL DEFAULT dental.clock_now() CHECK(pg_catalog.isfinite(occurred_at))
 );
 CREATE INDEX admin_management_audit_page ON dental.admin_management_audit(occurred_at DESC,id DESC);
 CREATE INDEX admin_management_audit_actor ON dental.admin_management_audit(actor_account_id);
 CREATE INDEX admin_management_audit_target ON dental.admin_management_audit(target_account_id) WHERE target_account_id IS NOT NULL;
 CREATE INDEX admin_management_audit_invitation ON dental.admin_management_audit(invitation_id) WHERE invitation_id IS NOT NULL;
 CREATE INDEX admin_management_audit_grant ON dental.admin_management_audit(grant_id) WHERE grant_id IS NOT NULL;
 FOREACH v_new IN ARRAY ARRAY['dental.admin_invitations'::regclass::oid,'dental.admin_management_owner'::regclass::oid,'dental.admin_management_audit'::regclass::oid] LOOP
  EXECUTE pg_catalog.format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY',v_new::regclass);
  EXECUTE pg_catalog.format('ALTER TABLE %s FORCE ROW LEVEL SECURITY',v_new::regclass);
  EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %s FROM PUBLIC',v_new::regclass);
  FOR v_grantee IN SELECT DISTINCT r.rolname FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
   JOIN pg_catalog.pg_roles r ON r.oid=a.grantee WHERE c.oid=v_new AND a.grantee<>c.relowner LOOP
   EXECUTE pg_catalog.format('REVOKE ALL ON TABLE %s FROM %I',v_new::regclass,v_grantee.rolname);
  END LOOP;
  EXECUTE pg_catalog.format('GRANT SELECT ON TABLE %s TO dental_function_owner',v_new::regclass);
  EXECUTE pg_catalog.format('CREATE POLICY management_read ON %s FOR SELECT TO dental_function_owner USING(true)',v_new::regclass);
 END LOOP;
 -- Backend has EXECUTE only. Function owner receives only lifecycle columns;
 -- immutable request/token/issuer fields cannot be updated by these functions.
 GRANT INSERT(request_id,token_hash,label,reason,issuer_account_id,issuer_grant_id,created_at,expires_at)
  ON dental.admin_invitations TO dental_function_owner;
 GRANT UPDATE(state,version,failed_verification_count,claimant_account_id,claimed_at,claim_reference,
  verification_code,approved_by,approved_grant_id,closed_by,closed_at) ON dental.admin_invitations TO dental_function_owner;
 CREATE POLICY management_invitation_insert ON dental.admin_invitations FOR INSERT TO dental_function_owner WITH CHECK(true);
 CREATE POLICY management_invitation_update ON dental.admin_invitations FOR UPDATE TO dental_function_owner USING(true) WITH CHECK(true);
 GRANT INSERT ON dental.admin_management_owner,dental.admin_management_audit TO dental_function_owner;
 GRANT UPDATE(account_id,designated_by,designated_at,reason) ON dental.admin_management_owner TO dental_function_owner;
 CREATE POLICY management_owner_insert ON dental.admin_management_owner FOR INSERT TO dental_function_owner WITH CHECK(true);
 CREATE POLICY management_owner_update ON dental.admin_management_owner FOR UPDATE TO dental_function_owner USING(true) WITH CHECK(true);
 CREATE POLICY management_audit_insert ON dental.admin_management_audit FOR INSERT TO dental_function_owner WITH CHECK(true);
 SET LOCAL ROLE dental_function_owner;
 EXECUTE $definitions$
CREATE FUNCTION dental._admin_management_timestamp(p_at timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $body$
 SELECT pg_catalog.to_char(p_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$body$;
CREATE FUNCTION dental._admin_management_cursor(p_at timestamptz,p_id uuid) RETURNS text
LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path='' AS $body$
 SELECT pg_catalog.rtrim(pg_catalog.translate(pg_catalog.replace(pg_catalog.encode(pg_catalog.convert_to(
  '{"occurredAt":'||pg_catalog.to_json(dental._admin_management_timestamp(p_at))::text||',"id":'||pg_catalog.to_json(p_id)::text||'}','UTF8'),'base64'),E'\n',''),'+/','-_'),'=')
$body$;
CREATE FUNCTION dental._admin_management_parse_cursor(p_cursor text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $body$
DECLARE v_text text;v_json jsonb;v_at timestamptz;v_id uuid;v_canonical text;
BEGIN
 IF p_cursor IS NULL THEN RETURN NULL;END IF;
 IF pg_catalog.char_length(p_cursor) NOT BETWEEN 1 AND 256 OR p_cursor !~ '^[A-Za-z0-9_-]+$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';END IF;
 BEGIN
  v_text:=pg_catalog.convert_from(pg_catalog.decode(pg_catalog.translate(p_cursor,'-_','+/')||pg_catalog.repeat('=',(4-pg_catalog.length(p_cursor)%4)%4),'base64'),'UTF8');
  v_json:=v_text::jsonb;
  IF pg_catalog.jsonb_typeof(v_json)<>'object' OR pg_catalog.jsonb_typeof(v_json->'occurredAt') IS DISTINCT FROM 'string'
   OR pg_catalog.jsonb_typeof(v_json->'id') IS DISTINCT FROM 'string'
   OR pg_catalog.char_length(v_json->>'occurredAt')>35
   OR (v_json->>'occurredAt') !~ '^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$'
   OR (v_json->>'id') !~ '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$' THEN RAISE EXCEPTION 'invalid';END IF;
  v_at:=(v_json->>'occurredAt')::timestamptz;v_id:=(v_json->>'id')::uuid;
  v_canonical:='{"occurredAt":'||pg_catalog.to_json(v_json->>'occurredAt')::text||',"id":'||pg_catalog.to_json(v_json->>'id')::text||'}';
  IF NOT pg_catalog.isfinite(v_at) OR v_text<>v_canonical OR p_cursor<>pg_catalog.rtrim(pg_catalog.translate(pg_catalog.replace(pg_catalog.encode(pg_catalog.convert_to(v_canonical,'UTF8'),'base64'),E'\n',''),'+/','-_'),'=') THEN RAISE EXCEPTION 'invalid';END IF;
 EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';END;
 RETURN v_json;
END;
$body$;
CREATE FUNCTION dental._admin_management_is_owner(p_actor uuid) RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path='' AS $body$
 SELECT dental.is_admin(p_actor) AND EXISTS(SELECT FROM dental.admin_management_owner WHERE singleton AND account_id=p_actor)
$body$;
CREATE FUNCTION dental._admin_management_effective_state(p_invitation dental.admin_invitations) RETURNS text
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path='' AS $body$
 SELECT CASE WHEN p_invitation.state NOT IN('issued','claimed') THEN p_invitation.state
  WHEN NOT EXISTS(SELECT FROM dental.admin_grants WHERE id=p_invitation.issuer_grant_id AND account_id=p_invitation.issuer_account_id AND revoked_at IS NULL) THEN 'invalidated'
  WHEN dental.clock_now()>=p_invitation.expires_at THEN 'expired' ELSE p_invitation.state END
$body$;
CREATE FUNCTION dental._admin_management_invitation_summary(p_invitation dental.admin_invitations,p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $body$
DECLARE v_state text:=dental._admin_management_effective_state(p_invitation);
BEGIN
 RETURN pg_catalog.jsonb_build_object('id',p_invitation.id,'label',p_invitation.label,'reason',p_invitation.reason,
  'state',v_state,'version',p_invitation.version,'expiresAt',dental._admin_management_timestamp(p_invitation.expires_at),
  'createdAt',dental._admin_management_timestamp(p_invitation.created_at),'claimedAt',dental._admin_management_timestamp(p_invitation.claimed_at),
  'claimReference',p_invitation.claim_reference,'canClose',COALESCE(p_invitation.state IN('issued','claimed') AND dental.is_admin(p_actor)
   AND (dental._admin_management_is_owner(p_actor) OR (v_state IN('issued','claimed') AND p_invitation.issuer_account_id=p_actor)),false));
END;
$body$;
CREATE FUNCTION dental.set_admin_management_owner(p_operator uuid,p_account uuid,p_reason text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $body$
DECLARE v_account uuid;v_old uuid;v_now timestamptz;
 v_reason text:=pg_catalog.btrim(p_reason,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
BEGIN
 IF SESSION_USER<>'postgres' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN';END IF;
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE';END IF;
 IF p_operator IS NULL OR p_account IS NULL OR v_reason IS NULL OR (pg_catalog.char_length(v_reason)+pg_catalog.char_length(pg_catalog.regexp_replace(v_reason,U&'[\0001-\FFFF]','','g'))) NOT BETWEEN 1 AND 500 THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dental.admin-membership',0));
 SELECT account_id INTO v_old FROM dental.admin_management_owner WHERE singleton;
 FOR v_account IN SELECT DISTINCT account FROM pg_catalog.unnest(ARRAY[p_operator,p_account,v_old]) account WHERE account IS NOT NULL ORDER BY account LOOP
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dental.admin:'||v_account::text,0));END LOOP;
 IF NOT EXISTS(SELECT FROM dental.accounts WHERE id=p_operator) OR NOT EXISTS(SELECT FROM dental.accounts WHERE id=p_account) THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='NOT_FOUND';END IF;
 IF NOT dental.is_admin(p_account) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN';END IF;
 IF v_old=p_account THEN RETURN true;END IF;
 v_now:=dental.clock_now();
 INSERT INTO dental.admin_management_owner(singleton,account_id,designated_by,designated_at,reason) VALUES(true,p_account,p_operator,v_now,v_reason)
 ON CONFLICT(singleton) DO UPDATE SET account_id=EXCLUDED.account_id,designated_by=EXCLUDED.designated_by,designated_at=EXCLUDED.designated_at,reason=EXCLUDED.reason;
 INSERT INTO dental.admin_management_audit(action,actor_account_id,target_account_id,result,reason,occurred_at)
 VALUES(CASE WHEN v_old IS NULL THEN 'owner_designated' ELSE 'owner_transferred' END,p_operator,p_account,'success',v_reason,v_now);
 RETURN true;
END;
$body$;
CREATE FUNCTION dental.admin_management_capabilities(p_actor uuid) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $body$
BEGIN
 IF NOT dental.is_admin(p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN';END IF;
 RETURN pg_catalog.jsonb_build_object('canRevokeAdmins',dental._admin_management_is_owner(p_actor));
END;
$body$;
CREATE FUNCTION dental.admin_management_roster(p_actor uuid,p_cursor text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $body$
DECLARE v_pair jsonb;v_items jsonb;v_next text;v_owner boolean;v_count bigint;
BEGIN
 IF NOT dental.is_admin(p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN';END IF;
 v_pair:=dental._admin_management_parse_cursor(p_cursor);v_owner:=dental._admin_management_is_owner(p_actor);
 SELECT pg_catalog.count(*) INTO v_count FROM dental.admin_grants WHERE revoked_at IS NULL;
 WITH rows AS MATERIALIZED(SELECT g.*,EXISTS(SELECT FROM dental.admin_management_owner o WHERE o.singleton AND o.account_id=g.account_id) AS protected
  FROM dental.admin_grants g WHERE revoked_at IS NULL AND (v_pair IS NULL OR (g.granted_at,g.id)<((v_pair->>'occurredAt')::timestamptz,(v_pair->>'id')::uuid))
  ORDER BY granted_at DESC,id DESC LIMIT 51), page AS(SELECT * FROM rows ORDER BY granted_at DESC,id DESC LIMIT 50)
 SELECT COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('grantId',p.id,'reference','A-'||pg_catalog.replace(p.account_id::text,'-',''),
  'label',(SELECT i.label FROM dental.admin_invitations i WHERE i.approved_grant_id=p.id AND i.state='approved'),
  'grantedAt',dental._admin_management_timestamp(p.granted_at),'protectedOwner',p.protected,
  'canRevoke',v_owner AND NOT p.protected AND p.account_id<>p_actor AND v_count>1) ORDER BY p.granted_at DESC,p.id DESC) FROM page p),'[]'::jsonb),
  CASE WHEN (SELECT pg_catalog.count(*) FROM rows)>50 THEN (SELECT dental._admin_management_cursor(granted_at,id) FROM page ORDER BY granted_at,id LIMIT 1) ELSE NULL END
 INTO v_items,v_next;
 RETURN pg_catalog.jsonb_build_object('items',v_items,'nextCursor',v_next);
END;
$body$;
CREATE FUNCTION dental.admin_management_invitations(p_actor uuid,p_cursor text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $body$
DECLARE v_pair jsonb;v_items jsonb;v_next text;
BEGIN
 IF NOT dental.is_admin(p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN';END IF;
 v_pair:=dental._admin_management_parse_cursor(p_cursor);
 WITH rows AS MATERIALIZED(SELECT i.* FROM dental.admin_invitations i WHERE state IN('issued','claimed')
  AND (v_pair IS NULL OR (i.created_at,i.id)<((v_pair->>'occurredAt')::timestamptz,(v_pair->>'id')::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51),
 page AS(SELECT * FROM rows ORDER BY created_at DESC,id DESC LIMIT 50)
 SELECT COALESCE((SELECT pg_catalog.jsonb_agg(dental._admin_management_invitation_summary(p::dental.admin_invitations,p_actor) ORDER BY p.created_at DESC,p.id DESC) FROM page p),'[]'::jsonb),
  CASE WHEN (SELECT pg_catalog.count(*) FROM rows)>50 THEN (SELECT dental._admin_management_cursor(created_at,id) FROM page ORDER BY created_at,id LIMIT 1) ELSE NULL END
 INTO v_items,v_next;
 RETURN pg_catalog.jsonb_build_object('items',v_items,'nextCursor',v_next);
END;
$body$;
CREATE FUNCTION dental.admin_management_history(p_actor uuid,p_cursor text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $body$
DECLARE v_pair jsonb;v_items jsonb;v_next text;
BEGIN
 IF NOT dental.is_admin(p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN';END IF;
 v_pair:=dental._admin_management_parse_cursor(p_cursor);
 WITH rows AS MATERIALIZED(SELECT a.* FROM dental.admin_management_audit a
  WHERE v_pair IS NULL OR (a.occurred_at,a.id)<((v_pair->>'occurredAt')::timestamptz,(v_pair->>'id')::uuid) ORDER BY occurred_at DESC,id DESC LIMIT 51),
 page AS(SELECT * FROM rows ORDER BY occurred_at DESC,id DESC LIMIT 50)
 SELECT COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('id',p.id,'action',p.action,
  'actorReference','A-'||pg_catalog.replace(p.actor_account_id::text,'-',''),
  'targetReference',CASE WHEN p.target_account_id IS NULL THEN NULL ELSE 'A-'||pg_catalog.replace(p.target_account_id::text,'-','') END,
  'invitationId',p.invitation_id,'grantId',p.grant_id,'reason',p.reason,'occurredAt',dental._admin_management_timestamp(p.occurred_at))
  ORDER BY p.occurred_at DESC,p.id DESC) FROM page p),'[]'::jsonb),
  CASE WHEN (SELECT pg_catalog.count(*) FROM rows)>50 THEN (SELECT dental._admin_management_cursor(occurred_at,id) FROM page ORDER BY occurred_at,id LIMIT 1) ELSE NULL END
 INTO v_items,v_next;
 RETURN pg_catalog.jsonb_build_object('items',v_items,'nextCursor',v_next);
END;
$body$;
CREATE FUNCTION dental.admin_invitation_own_claims(p_actor uuid,p_cursor text) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $body$
DECLARE v_pair jsonb;v_items jsonb;v_next text;
BEGIN
 IF p_actor IS NULL OR NOT EXISTS(SELECT FROM dental.accounts WHERE id=p_actor) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='FORBIDDEN';END IF;
 v_pair:=dental._admin_management_parse_cursor(p_cursor);
 WITH rows AS MATERIALIZED(SELECT i.* FROM dental.admin_invitations i WHERE claimant_account_id=p_actor
  AND (v_pair IS NULL OR (i.created_at,i.id)<((v_pair->>'occurredAt')::timestamptz,(v_pair->>'id')::uuid)) ORDER BY created_at DESC,id DESC LIMIT 51),
 page AS(SELECT * FROM rows ORDER BY created_at DESC,id DESC LIMIT 50)
 SELECT COALESCE((SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
  'invitation',dental._admin_management_invitation_summary(p::dental.admin_invitations,NULL),
  'verificationCode',CASE WHEN dental._admin_management_effective_state(p::dental.admin_invitations)='claimed' THEN p.verification_code ELSE NULL END)
  ORDER BY p.created_at DESC,p.id DESC) FROM page p),'[]'::jsonb),
  CASE WHEN (SELECT pg_catalog.count(*) FROM rows)>50 THEN (SELECT dental._admin_management_cursor(created_at,id) FROM page ORDER BY created_at,id LIMIT 1) ELSE NULL END
 INTO v_items,v_next;
 RETURN pg_catalog.jsonb_build_object('items',v_items,'nextCursor',v_next);
END;
$body$;
-- Private validation/locking/retention helpers are never backend entry points.
CREATE FUNCTION dental._admin_management_input(p_kind text,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path='' AS $body$
DECLARE v_keys text[];v_expected text[];v_key text;v_text text;v_result jsonb:=p_input;
BEGIN
 IF pg_catalog.jsonb_typeof(p_input) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';END IF;
 v_expected:=CASE p_kind WHEN 'create' THEN ARRAY['label','reason','requestId','tokenHash']
  WHEN 'claim' THEN ARRAY['tokenHash','verificationCode']
  WHEN 'approve' THEN ARRAY['invitationId','verificationCode','version']
  WHEN 'close' THEN ARRAY['action','invitationId','reason','version']
  WHEN 'revoke' THEN ARRAY['grantId','reason'] END;
 SELECT pg_catalog.array_agg(k ORDER BY k COLLATE "C") INTO v_keys FROM pg_catalog.jsonb_object_keys(p_input) k;
 IF v_expected IS NULL OR v_keys IS DISTINCT FROM v_expected THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';END IF;
 FOREACH v_key IN ARRAY v_keys LOOP
  IF v_key='version' THEN
   IF pg_catalog.jsonb_typeof(p_input->v_key) IS DISTINCT FROM 'number'
    OR (p_input->>v_key)::numeric NOT BETWEEN 1 AND 2147483647
    OR (p_input->>v_key)::numeric<>pg_catalog.trunc((p_input->>v_key)::numeric) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';END IF;
   CONTINUE;
  END IF;
  IF p_kind='create' AND v_key='reason' AND p_input->v_key='null'::jsonb THEN CONTINUE;END IF;
  IF pg_catalog.jsonb_typeof(p_input->v_key) IS DISTINCT FROM 'string' THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';END IF;
  v_text:=p_input->>v_key;
  IF v_key IN('requestId','invitationId','grantId') AND v_text !~ '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$'
   OR v_key='tokenHash' AND v_text !~ '^[0-9a-f]{64}$'
   OR v_key='verificationCode' AND v_text !~ '^[0-9]{8}$'
   OR v_key='action' AND v_text NOT IN('cancel','reject') THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';END IF;
  IF v_key IN('label','reason') THEN
   v_text:=pg_catalog.btrim(v_text,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF');
   IF (pg_catalog.char_length(v_text)+pg_catalog.char_length(pg_catalog.regexp_replace(v_text,U&'[\0001-\FFFF]','','g')))
    NOT BETWEEN 1 AND (CASE WHEN v_key='label' THEN 120 ELSE 500 END) THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';END IF;
   v_result:=pg_catalog.jsonb_set(v_result,ARRAY[v_key],pg_catalog.to_jsonb(v_text));
  END IF;
 END LOOP;
 RETURN v_result;
END;
$body$;
CREATE FUNCTION dental._admin_management_membership() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $body$
BEGIN
 -- Read-committed statements after waits must see committed operator changes.
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE';END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dental.admin-membership',0));
END;
$body$;
CREATE FUNCTION dental._admin_management_accounts(p_accounts uuid[]) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $body$
DECLARE v_account uuid;
BEGIN
 FOR v_account IN SELECT DISTINCT account FROM pg_catalog.unnest(p_accounts) account WHERE account IS NOT NULL ORDER BY account LOOP
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dental.admin:'||v_account::text,0));
 END LOOP;
END;
$body$;
CREATE FUNCTION dental._admin_management_erase_codes() RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path='' AS $body$
BEGIN
 -- Opportunistic, bounded retention only. Call after membership/account fencing,
 -- never acquire another account lock after these row locks. Read projections
 -- suppress invalid codes immediately even if no further mutation ever arrives.
 WITH expired AS MATERIALIZED(
  SELECT i.id FROM dental.admin_invitations i WHERE i.state='claimed' AND i.verification_code IS NOT NULL
   AND (i.expires_at<=dental.clock_now() OR NOT EXISTS(SELECT FROM dental.admin_grants g
    WHERE g.id=i.issuer_grant_id AND g.account_id=i.issuer_account_id AND g.revoked_at IS NULL))
   ORDER BY i.expires_at,i.id LIMIT 50 FOR UPDATE OF i SKIP LOCKED
 ) UPDATE dental.admin_invitations i SET verification_code=NULL FROM expired e WHERE i.id=e.id;
END;
$body$;
CREATE FUNCTION dental.admin_management_create(p_actor uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $body$
DECLARE v_input jsonb:=dental._admin_management_input('create',p_input);v_invitation dental.admin_invitations;
 v_grant uuid;v_now timestamptz;
BEGIN
 IF p_actor IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';END IF;
 PERFORM dental._admin_management_membership();
 PERFORM dental._admin_management_accounts(ARRAY[p_actor]);
 SELECT id INTO v_grant FROM dental.admin_grants WHERE account_id=p_actor AND revoked_at IS NULL;
 IF v_grant IS NULL THEN RETURN pg_catalog.jsonb_build_object('ok',false,'code','FORBIDDEN');END IF;
 PERFORM dental._admin_management_erase_codes();
 SELECT * INTO v_invitation FROM dental.admin_invitations WHERE issuer_account_id=p_actor AND request_id=(v_input->>'requestId')::uuid FOR UPDATE;
 IF FOUND THEN
  -- Persist the material fields themselves; never replace the immutable hash.
  IF v_invitation.token_hash IS DISTINCT FROM v_input->>'tokenHash' OR v_invitation.label IS DISTINCT FROM v_input->>'label'
   OR v_invitation.reason IS DISTINCT FROM v_input->>'reason' THEN
   RETURN pg_catalog.jsonb_build_object('ok',false,'code','DUPLICATE');END IF;
  RETURN pg_catalog.jsonb_build_object('ok',true,'value',pg_catalog.jsonb_build_object('invitation',dental._admin_management_invitation_summary(v_invitation,p_actor),'created',false));
 END IF;
 v_now:=dental.clock_now();
 IF (SELECT pg_catalog.count(*) FROM dental.admin_invitations WHERE issuer_account_id=p_actor AND created_at>v_now-interval '24 hours')>=20 THEN
  RETURN pg_catalog.jsonb_build_object('ok',false,'code','RATE_LIMITED');END IF;
 IF EXISTS(SELECT FROM dental.admin_invitations WHERE token_hash=v_input->>'tokenHash') THEN
  RETURN pg_catalog.jsonb_build_object('ok',false,'code','DUPLICATE');END IF;
 INSERT INTO dental.admin_invitations(request_id,token_hash,label,reason,issuer_account_id,issuer_grant_id,created_at,expires_at)
 VALUES((v_input->>'requestId')::uuid,v_input->>'tokenHash',v_input->>'label',v_input->>'reason',p_actor,v_grant,v_now,v_now+interval '24 hours') RETURNING * INTO v_invitation;
 INSERT INTO dental.admin_management_audit(action,actor_account_id,invitation_id,grant_id,result,reason,occurred_at)
 VALUES('invitation_created',p_actor,v_invitation.id,v_grant,'success',v_invitation.reason,v_now);
 RETURN pg_catalog.jsonb_build_object('ok',true,'value',pg_catalog.jsonb_build_object('invitation',dental._admin_management_invitation_summary(v_invitation,p_actor),'created',true));
END;
$body$;
CREATE FUNCTION dental.admin_invitation_claim(p_actor uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $body$
DECLARE v_input jsonb:=dental._admin_management_input('claim',p_input);v_invitation dental.admin_invitations;v_now timestamptz;v_summary jsonb;
BEGIN
 IF p_actor IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';END IF;
 PERFORM dental._admin_management_membership();
 -- Membership fencing makes invitation binding stable before deriving the keys.
 SELECT * INTO v_invitation FROM dental.admin_invitations WHERE token_hash=v_input->>'tokenHash';
 PERFORM dental._admin_management_accounts(ARRAY[p_actor,v_invitation.issuer_account_id,v_invitation.claimant_account_id]);
 IF NOT EXISTS(SELECT FROM dental.accounts WHERE id=p_actor) THEN RETURN pg_catalog.jsonb_build_object('ok',false,'code','NOT_FOUND');END IF;
 PERFORM dental._admin_management_erase_codes();
 SELECT * INTO v_invitation FROM dental.admin_invitations WHERE token_hash=v_input->>'tokenHash' FOR UPDATE;
 IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('ok',false,'code','NOT_FOUND');END IF;
 IF v_invitation.claimant_account_id IS NOT NULL AND v_invitation.claimant_account_id<>p_actor THEN
  RETURN pg_catalog.jsonb_build_object('ok',false,'code','NOT_FOUND');END IF;
 -- Terminal history is safe for its exact claimant, with no secret or mutation.
 IF v_invitation.state IN('approved','rejected','cancelled','locked') AND v_invitation.claimant_account_id=p_actor THEN
  RETURN pg_catalog.jsonb_build_object('ok',true,'value',pg_catalog.jsonb_build_object('invitation',dental._admin_management_invitation_summary(v_invitation,NULL),'verificationCode',NULL));END IF;
 IF dental._admin_management_effective_state(v_invitation) NOT IN('issued','claimed') THEN
  RETURN pg_catalog.jsonb_build_object('ok',false,'code','NOT_FOUND');END IF;
 IF v_invitation.state='issued' THEN
  IF v_invitation.version=2147483647 THEN RETURN pg_catalog.jsonb_build_object('ok',false,'code','INVALID_TRANSITION');END IF;
  v_now:=dental.clock_now();
  -- Sample again after every possible row/account wait, not at function entry.
  IF v_now>=v_invitation.expires_at THEN RETURN pg_catalog.jsonb_build_object('ok',false,'code','NOT_FOUND');END IF;
  UPDATE dental.admin_invitations SET state='claimed',version=version+1,claimant_account_id=p_actor,claimed_at=v_now,
   claim_reference='I-'||pg_catalog.replace(id::text,'-',''),verification_code=v_input->>'verificationCode'
   WHERE id=v_invitation.id RETURNING * INTO v_invitation;
  INSERT INTO dental.admin_management_audit(action,actor_account_id,target_account_id,invitation_id,result,occurred_at)
   VALUES('invitation_claimed',p_actor,p_actor,v_invitation.id,'success',v_now);
 END IF;
 -- Audit insertion can wait beyond expiry after the claim update. Use one
 -- final projection for both the displayed state and permission to reveal code.
 v_summary:=dental._admin_management_invitation_summary(v_invitation,NULL);
 RETURN pg_catalog.jsonb_build_object('ok',true,'value',pg_catalog.jsonb_build_object('invitation',v_summary,
  'verificationCode',CASE WHEN v_summary->>'state'='claimed' THEN v_invitation.verification_code ELSE NULL END));
END;
$body$;
CREATE FUNCTION dental.admin_management_approve(p_actor uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $body$
DECLARE v_input jsonb:=dental._admin_management_input('approve',p_input);v_invitation dental.admin_invitations;
 v_grant uuid;v_now timestamptz;v_version integer:=(v_input->>'version')::numeric::integer;
BEGIN
 IF p_actor IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';END IF;
 PERFORM dental._admin_management_membership();
 SELECT * INTO v_invitation FROM dental.admin_invitations WHERE id=(v_input->>'invitationId')::uuid;
 PERFORM dental._admin_management_accounts(ARRAY[p_actor,v_invitation.issuer_account_id,v_invitation.claimant_account_id]);
 IF NOT dental.is_admin(p_actor) THEN RETURN pg_catalog.jsonb_build_object('ok',false,'code','FORBIDDEN');END IF;
 PERFORM dental._admin_management_erase_codes();
 SELECT * INTO v_invitation FROM dental.admin_invitations WHERE id=(v_input->>'invitationId')::uuid FOR UPDATE;
 IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('ok',false,'code','NOT_FOUND');END IF;
 IF v_invitation.state='approved' AND v_invitation.approved_by=p_actor AND v_version=v_invitation.version-1 THEN
  -- Return historical outcome only. Never look up or recreate a current grant.
  RETURN pg_catalog.jsonb_build_object('ok',true,'value',dental._admin_management_invitation_summary(v_invitation,p_actor));END IF;
 IF v_invitation.state NOT IN('issued','claimed') THEN RETURN pg_catalog.jsonb_build_object('ok',false,'code','INVALID_TRANSITION','version',v_invitation.version);END IF;
 IF dental._admin_management_effective_state(v_invitation) NOT IN('issued','claimed') THEN RETURN pg_catalog.jsonb_build_object('ok',false,'code','NOT_FOUND');END IF;
 IF v_version<>v_invitation.version THEN RETURN pg_catalog.jsonb_build_object('ok',false,'code','VERSION_CONFLICT','version',v_invitation.version);END IF;
 IF v_invitation.state<>'claimed' OR v_invitation.verification_code IS NULL OR v_invitation.version=2147483647 THEN
  RETURN pg_catalog.jsonb_build_object('ok',false,'code','INVALID_TRANSITION','version',v_invitation.version);END IF;
 v_now:=dental.clock_now();
 IF v_now>=v_invitation.expires_at THEN RETURN pg_catalog.jsonb_build_object('ok',false,'code','NOT_FOUND');END IF;
 IF v_invitation.verification_code<>v_input->>'verificationCode' THEN
  UPDATE dental.admin_invitations SET failed_verification_count=failed_verification_count+1,version=version+1,
   state=CASE WHEN failed_verification_count=4 THEN 'locked' ELSE state END,
   verification_code=CASE WHEN failed_verification_count=4 THEN NULL ELSE verification_code END,
   closed_by=CASE WHEN failed_verification_count=4 THEN p_actor ELSE closed_by END,
   closed_at=CASE WHEN failed_verification_count=4 THEN v_now ELSE closed_at END
   WHERE id=v_invitation.id RETURNING * INTO v_invitation;
  INSERT INTO dental.admin_management_audit(action,actor_account_id,target_account_id,invitation_id,result,occurred_at)
   VALUES('invitation_verification_failed',p_actor,v_invitation.claimant_account_id,v_invitation.id,'invalid_transition',v_now);
  -- A value, not an exception: HTTP 409 must not roll back the durable count.
  RETURN pg_catalog.jsonb_build_object('ok',false,'code','INVALID_TRANSITION','version',v_invitation.version,'attemptsRemaining',5-v_invitation.failed_verification_count);
 END IF;
 IF dental.is_admin(v_invitation.claimant_account_id) THEN RETURN pg_catalog.jsonb_build_object('ok',false,'code','DUPLICATE');END IF;
 INSERT INTO dental.admin_grants(account_id,granted_by,granted_at) VALUES(v_invitation.claimant_account_id,p_actor,v_now) RETURNING id INTO v_grant;
 UPDATE dental.admin_invitations SET state='approved',version=version+1,verification_code=NULL,approved_by=p_actor,
  approved_grant_id=v_grant,closed_by=p_actor,closed_at=v_now WHERE id=v_invitation.id RETURNING * INTO v_invitation;
 INSERT INTO dental.admin_management_audit(action,actor_account_id,target_account_id,invitation_id,grant_id,result,occurred_at)
  VALUES('invitation_approved',p_actor,v_invitation.claimant_account_id,v_invitation.id,v_grant,'success',v_now);
 RETURN pg_catalog.jsonb_build_object('ok',true,'value',dental._admin_management_invitation_summary(v_invitation,p_actor));
END;
$body$;
CREATE FUNCTION dental.admin_management_close(p_actor uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $body$
DECLARE v_input jsonb:=dental._admin_management_input('close',p_input);v_invitation dental.admin_invitations;
 v_state text;v_owner boolean;v_now timestamptz;v_version integer:=(v_input->>'version')::numeric::integer;
BEGIN
 IF p_actor IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';END IF;
 PERFORM dental._admin_management_membership();
 SELECT * INTO v_invitation FROM dental.admin_invitations WHERE id=(v_input->>'invitationId')::uuid;
 PERFORM dental._admin_management_accounts(ARRAY[p_actor,v_invitation.issuer_account_id,v_invitation.claimant_account_id]);
 IF NOT dental.is_admin(p_actor) THEN RETURN pg_catalog.jsonb_build_object('ok',false,'code','FORBIDDEN');END IF;
 v_owner:=dental._admin_management_is_owner(p_actor);
 PERFORM dental._admin_management_erase_codes();
 SELECT * INTO v_invitation FROM dental.admin_invitations WHERE id=(v_input->>'invitationId')::uuid FOR UPDATE;
 IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('ok',false,'code','NOT_FOUND');END IF;
 IF NOT v_owner AND NOT(v_invitation.issuer_account_id=p_actor AND EXISTS(SELECT FROM dental.admin_grants
   WHERE id=v_invitation.issuer_grant_id AND account_id=p_actor AND revoked_at IS NULL)) THEN
  RETURN pg_catalog.jsonb_build_object('ok',false,'code','FORBIDDEN');END IF;
 v_state:=CASE WHEN v_input->>'action'='cancel' THEN 'cancelled' ELSE 'rejected' END;
 IF v_invitation.state=v_state AND v_invitation.closed_by=p_actor AND v_version=v_invitation.version-1 THEN
  RETURN pg_catalog.jsonb_build_object('ok',true,'value',dental._admin_management_invitation_summary(v_invitation,p_actor));END IF;
 IF v_invitation.state NOT IN('issued','claimed') THEN RETURN pg_catalog.jsonb_build_object('ok',false,'code','INVALID_TRANSITION','version',v_invitation.version);END IF;
 IF NOT v_owner AND dental._admin_management_effective_state(v_invitation) NOT IN('issued','claimed') THEN
  RETURN pg_catalog.jsonb_build_object('ok',false,'code','NOT_FOUND');END IF;
 IF v_version<>v_invitation.version THEN RETURN pg_catalog.jsonb_build_object('ok',false,'code','VERSION_CONFLICT','version',v_invitation.version);END IF;
 IF v_invitation.version=2147483647 THEN RETURN pg_catalog.jsonb_build_object('ok',false,'code','INVALID_TRANSITION','version',v_invitation.version);END IF;
 v_now:=dental.clock_now();
 UPDATE dental.admin_invitations SET state=v_state,version=version+1,verification_code=NULL,closed_by=p_actor,closed_at=v_now
  WHERE id=v_invitation.id RETURNING * INTO v_invitation;
 INSERT INTO dental.admin_management_audit(action,actor_account_id,target_account_id,invitation_id,result,reason,occurred_at)
  VALUES('invitation_'||v_state,p_actor,v_invitation.claimant_account_id,v_invitation.id,'success',v_input->>'reason',v_now);
 RETURN pg_catalog.jsonb_build_object('ok',true,'value',dental._admin_management_invitation_summary(v_invitation,p_actor));
END;
$body$;
CREATE FUNCTION dental.admin_management_revoke(p_actor uuid,p_input jsonb) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $body$
DECLARE v_input jsonb:=dental._admin_management_input('revoke',p_input);v_grant dental.admin_grants;v_now timestamptz;
BEGIN
 IF p_actor IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION';END IF;
 PERFORM dental._admin_management_membership();
 SELECT * INTO v_grant FROM dental.admin_grants WHERE id=(v_input->>'grantId')::uuid;
 PERFORM dental._admin_management_accounts(ARRAY[p_actor,v_grant.account_id]);
 IF NOT dental._admin_management_is_owner(p_actor) THEN RETURN pg_catalog.jsonb_build_object('ok',false,'code','FORBIDDEN');END IF;
 PERFORM dental._admin_management_erase_codes();
 SELECT * INTO v_grant FROM dental.admin_grants WHERE id=(v_input->>'grantId')::uuid FOR UPDATE;
 IF NOT FOUND THEN RETURN pg_catalog.jsonb_build_object('ok',false,'code','NOT_FOUND');END IF;
 IF v_grant.account_id=p_actor OR EXISTS(SELECT FROM dental.admin_management_owner WHERE singleton AND account_id=v_grant.account_id) THEN
  RETURN pg_catalog.jsonb_build_object('ok',false,'code','FORBIDDEN');END IF;
 IF v_grant.revoked_at IS NOT NULL THEN RETURN pg_catalog.jsonb_build_object('ok',true,'value',pg_catalog.jsonb_build_object('revoked',false));END IF;
 IF (SELECT pg_catalog.count(*) FROM dental.admin_grants WHERE revoked_at IS NULL)<=1 THEN
  RETURN pg_catalog.jsonb_build_object('ok',false,'code','INVALID_TRANSITION');END IF;
 v_now:=dental.clock_now();
 UPDATE dental.admin_grants SET revoked_at=v_now,revoked_by=p_actor WHERE id=v_grant.id;
 INSERT INTO dental.admin_management_audit(action,actor_account_id,target_account_id,grant_id,result,reason,occurred_at)
  VALUES('admin_revoked',p_actor,v_grant.account_id,v_grant.id,'success',v_input->>'reason',v_now);
 RETURN pg_catalog.jsonb_build_object('ok',true,'value',pg_catalog.jsonb_build_object('revoked',true));
END;
$body$;
REVOKE ALL ON FUNCTION dental._admin_management_input(text,jsonb),dental._admin_management_membership(),
 dental._admin_management_accounts(uuid[]),dental._admin_management_erase_codes(),dental.admin_management_create(uuid,jsonb),
 dental.admin_invitation_claim(uuid,jsonb),dental.admin_management_approve(uuid,jsonb),dental.admin_management_close(uuid,jsonb),
 dental.admin_management_revoke(uuid,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dental.admin_management_create(uuid,jsonb),dental.admin_invitation_claim(uuid,jsonb),
 dental.admin_management_approve(uuid,jsonb),dental.admin_management_close(uuid,jsonb),dental.admin_management_revoke(uuid,jsonb) TO dental_backend;

REVOKE ALL ON FUNCTION dental._admin_management_timestamp(timestamptz),dental._admin_management_cursor(timestamptz,uuid),
 dental._admin_management_parse_cursor(text),dental._admin_management_is_owner(uuid),dental._admin_management_effective_state(dental.admin_invitations),
 dental._admin_management_invitation_summary(dental.admin_invitations,uuid),dental.set_admin_management_owner(uuid,uuid,text),
 dental.admin_management_capabilities(uuid),dental.admin_management_roster(uuid,text),dental.admin_management_invitations(uuid,text),
 dental.admin_management_history(uuid,text),dental.admin_invitation_own_claims(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dental.set_admin_management_owner(uuid,uuid,text) TO postgres;
GRANT EXECUTE ON FUNCTION dental.admin_management_capabilities(uuid),dental.admin_management_roster(uuid,text),
 dental.admin_management_invitations(uuid,text),dental.admin_management_history(uuid,text),dental.admin_invitation_own_claims(uuid,text) TO dental_backend;
$definitions$;
 RESET ROLE;
 REVOKE CREATE ON SCHEMA dental FROM dental_function_owner;
 REVOKE dental_function_owner FROM postgres GRANTED BY postgres;
 SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid) INTO v_functions_after FROM pg_catalog.pg_proc p
  WHERE p.oid IN(SELECT (item->>'oid')::oid FROM pg_catalog.jsonb_array_elements(v_functions) item);
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY roleid,member,grantor),'[]'::jsonb) INTO v_memberships_after
  FROM pg_catalog.pg_auth_members m WHERE m.roleid IN(v_owner,v_backend,v_runtime) OR m.member IN(v_owner,v_backend,v_runtime);
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.oid),'[]'::jsonb) INTO v_defaults_after FROM pg_catalog.pg_default_acl d WHERE d.defaclrole IN(v_postgres,v_owner);
 SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r)-'rolpassword' ORDER BY r.oid) INTO v_roles_after FROM pg_catalog.pg_roles r WHERE r.oid IN(v_owner,v_backend,v_runtime);
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s) ORDER BY s.setdatabase,s.setrole),'[]'::jsonb) INTO v_role_settings_after FROM pg_catalog.pg_db_role_setting s WHERE s.setrole IN(v_owner,v_backend,v_runtime);
 SELECT pg_catalog.jsonb_build_object(
  'tables',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c) ORDER BY c.oid) FROM pg_catalog.pg_class c WHERE c.oid=ANY(v_old_tables)),
  'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.attrelid,a.attnum) FROM pg_catalog.pg_attribute a WHERE a.attrelid=ANY(v_old_tables)),
  'policies',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid) FROM pg_catalog.pg_policy p WHERE p.polrelid=ANY(v_old_tables)),
  'triggers',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_trigger t WHERE t.tgrelid=ANY(v_old_tables)
   AND NOT(t.tgisinternal AND EXISTS(SELECT FROM pg_catalog.pg_constraint c WHERE c.oid=t.tgconstraint AND c.contype='f'
    AND c.conrelid IN('dental.admin_invitations'::regclass,'dental.admin_management_owner'::regclass,'dental.admin_management_audit'::regclass))))
 ) INTO v_catalog_after;
 IF v_functions IS DISTINCT FROM v_functions_after OR v_memberships IS DISTINCT FROM v_memberships_after
  OR v_defaults IS DISTINCT FROM v_defaults_after OR v_roles IS DISTINCT FROM v_roles_after OR v_role_settings IS DISTINCT FROM v_role_settings_after
  OR v_catalog IS DISTINCT FROM v_catalog_after OR CURRENT_USER<>'postgres' OR SESSION_USER<>'postgres' OR pg_catalog.current_setting('role')<>'none' THEN
  RAISE EXCEPTION 'Admin management changed existing catalogs or did not restore temporary authority';END IF;
 FOR v_function IN SELECT * FROM pg_catalog.pg_proc WHERE pronamespace=v_schema LOOP
  IF v_function.proowner<>v_owner OR v_function.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
   OR pg_catalog.has_function_privilege(v_runtime,v_function.oid,'EXECUTE') IS DISTINCT FROM pg_catalog.has_function_privilege(v_backend,v_function.oid,'EXECUTE')
   OR (pg_catalog.left(v_function.proname::text,1)='_' AND pg_catalog.has_function_privilege(v_backend,v_function.oid,'EXECUTE'))
   OR EXISTS(SELECT FROM pg_catalog.aclexplode(COALESCE(v_function.proacl,pg_catalog.acldefault('f',v_owner))) a WHERE a.grantee NOT IN(v_owner,v_backend,v_postgres) OR a.is_grantable) THEN
   RAISE EXCEPTION 'Unsafe admin management function authority';END IF;
 END LOOP;
END;
$admin_management$;
