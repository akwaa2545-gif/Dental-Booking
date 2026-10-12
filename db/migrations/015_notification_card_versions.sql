-- LOCAL CANDIDATE ONLY. Applies after exact reviewed 014 (SHA256 60bacfc3d46f9dc6e46816440807b31547bb544e26fa9de757182a5b1b216284).
-- Compatibility only: legacy producers/Worker remain safe. New card generation requires separate 016.
DO $notification_cards$
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
 v_oid oid;v_source text;v_changed text;v_definition text;v_name text;v_new_name text;
 v_original_lock_timeout text:=pg_catalog.current_setting('lock_timeout');
BEGIN
 -- A statement timer must already be running when this DO starts; setting it
 -- inside an executing DO is not a substitute. The whole migration is capped.
 IF (SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name = 'statement_timeout') NOT BETWEEN 1 AND 120000 THEN
  RAISE EXCEPTION 'Notification cards require an inherited statement timeout between 1ms and 2min';
 END IF;
 IF CURRENT_USER<>'postgres' OR SESSION_USER<>'postgres' OR v_major<>17
  OR pg_catalog.current_setting('role')<>'none'
  OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
  OR pg_catalog.current_setting('transaction_read_only')<>'off'
  OR pg_catalog.to_regclass('dental.admin_management_owner') IS NULL
  OR pg_catalog.to_regprocedure('dental.admin_management_capabilities(uuid)') IS NULL
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
  RAISE EXCEPTION 'Notification cards require the verified migration 014 managed baseline';
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
  RAISE EXCEPTION 'Unreviewed Notification cards private/runtime role attributes or role settings';
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
  RAISE EXCEPTION 'Unreviewed exact Notification cards runtime membership baseline';
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
 IF v_fingerprint IS DISTINCT FROM '{"schema":"4ae008106c89761f7c6d1788e7cdf716","tables":"ef5b33f72b16f612071b5efba83f0ce6","defaults":"4146858b1996fc4459bbe6f4feaddbc3","functions":"5600e8b53eecf933b01f286e5f480b5a"}'::jsonb
  AND v_fingerprint IS DISTINCT FROM '{"schema":"4ae008106c89761f7c6d1788e7cdf716","tables":"ef5b33f72b16f612071b5efba83f0ce6","defaults":"4e67d902862ac6ff8df82cf6c6b75a0e","functions":"5600e8b53eecf933b01f286e5f480b5a"}'::jsonb THEN
  RAISE EXCEPTION 'Unreviewed or already-updated notification card baseline 014';
 END IF;

 -- All changes are atomic and bounded. Block producers while pinning the schema.
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE dental.outbox,dental.admin_booking_deliveries IN ACCESS EXCLUSIVE MODE;
 SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid) INTO v_functions FROM pg_catalog.pg_proc p WHERE p.pronamespace=v_schema;
 SELECT pg_catalog.array_agg(oid) INTO v_old_tables FROM pg_catalog.pg_class WHERE relnamespace=v_schema AND oid NOT IN('dental.outbox'::regclass,'dental.admin_booking_deliveries'::regclass);
 SELECT pg_catalog.jsonb_build_object(
  'tables',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c) ORDER BY c.oid) FROM pg_catalog.pg_class c WHERE c.oid=ANY(v_old_tables)),
  'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.attrelid,a.attnum) FROM pg_catalog.pg_attribute a WHERE a.attrelid=ANY(v_old_tables)),
  'policies',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid) FROM pg_catalog.pg_policy p WHERE p.polrelid IN(SELECT oid FROM pg_catalog.pg_class WHERE relnamespace=v_schema)),
  'triggers',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_trigger t WHERE t.tgrelid=ANY(v_old_tables))
 ) INTO v_catalog;

 ALTER TABLE dental.outbox ADD COLUMN payload_version integer;
 UPDATE dental.outbox SET payload_version=CASE WHEN type='cancellation' THEN 2 ELSE 1 END;
 ALTER TABLE dental.outbox ADD CONSTRAINT outbox_payload_version_type CHECK(
  (type='approval' AND payload_version IN(1,3)) OR (type IN('rejection','reminder') AND payload_version=1)
  OR (type='cancellation' AND payload_version=2));
 ALTER TABLE dental.admin_booking_deliveries DROP CONSTRAINT admin_booking_deliveries_payload_version_check;
 ALTER TABLE dental.admin_booking_deliveries ADD CONSTRAINT admin_booking_deliveries_payload_version_check CHECK(payload_version IN(1,2));
 -- Preserve admin DEFAULT 1 until separately committed activation016.
 GRANT dental_function_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
 GRANT CREATE ON SCHEMA dental TO dental_function_owner;
 -- Create the private trigger as the existing table owner, revoke its default
 -- PUBLIC permission, then transfer ownership. No lasting operator/helper grant.
 EXECUTE $helper$
CREATE FUNCTION dental._pin_notification_card_version()
RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
BEGIN
 IF NEW.payload_version IS NULL THEN
  NEW.payload_version:=CASE WHEN NEW.type='cancellation' THEN 2 ELSE 1 END;
 END IF;
 RETURN NEW;
END;
$body$;
$helper$;
 REVOKE ALL ON FUNCTION dental._pin_notification_card_version() FROM PUBLIC;
 CREATE TRIGGER pin_notification_card_version BEFORE INSERT ON dental.outbox
  FOR EACH ROW EXECUTE FUNCTION dental._pin_notification_card_version();
 ALTER FUNCTION dental._pin_notification_card_version() OWNER TO dental_function_owner;
 ALTER TABLE dental.outbox ALTER COLUMN payload_version SET NOT NULL;

 FOREACH v_oid IN ARRAY ARRAY['dental.claim_patient_event(uuid)'::regprocedure::oid,
  'dental.claim_admin_delivery(uuid)'::regprocedure::oid,
  'dental.prepare_patient_dispatch(uuid,uuid,text,jsonb)'::regprocedure::oid,
  'dental.prepare_admin_dispatch(uuid,uuid,text,jsonb)'::regprocedure::oid] LOOP
  SELECT prosrc,pg_catalog.pg_get_functiondef(oid),proname INTO STRICT v_source,v_definition,v_name FROM pg_catalog.pg_proc WHERE oid=v_oid;
  v_changed:=v_source;
  v_new_name:=v_name||CASE WHEN v_name IN('claim_patient_event','prepare_patient_dispatch') THEN '_v3' ELSE '_v2' END;
  IF v_name='prepare_admin_dispatch' THEN
   v_changed:=pg_catalog.replace(v_changed,$old$v_account uuid;v_now timestamptz;v_reachable boolean;v_reason text;v_deadline timestamptz;$old$,
    $new$v_account uuid;v_now timestamptz;v_reachable boolean;v_reason text;v_deadline timestamptz;v_identity jsonb:='{}'::jsonb;$new$);
   v_changed:=pg_catalog.replace(v_changed,$old$-- Attempt writes can wait on locks too.$old$,$new$IF v_delivery.payload_version=2 THEN
  SELECT pg_catalog.jsonb_build_object('fullName',a.patient_snapshot->>'fullName','phone',a.patient_snapshot->>'phone')
   INTO STRICT v_identity FROM dental.appointments a WHERE a.id=v_event.appointment_id;
 END IF;
 -- Attempt writes can wait on locks too.$new$);
   v_changed:=pg_catalog.replace(v_changed,$old$'payloadVersion',1,'preparedAt',v_delivery.prepared_at,'authorizationValidUntil',v_deadline);$old$,
    $new$'payloadVersion',v_delivery.payload_version,'preparedAt',v_delivery.prepared_at,'authorizationValidUntil',v_deadline)||v_identity;$new$);
  ELSIF v_name='prepare_patient_dispatch' THEN
   v_changed:=pg_catalog.replace(v_changed,$old$'payloadVersion',CASE WHEN v_event.type='cancellation' THEN 2 ELSE 1 END$old$,$new$'payloadVersion',v_event.payload_version$new$);
   v_changed:=pg_catalog.replace(v_changed,$old$'preparedAt',v_now,'authorizationExpiresAt',v_deadline);$old$,
    $new$'preparedAt',v_now,'authorizationExpiresAt',v_deadline)||CASE WHEN v_event.payload_version=3
    THEN pg_catalog.jsonb_build_object('fullName',v_appointment.patient_snapshot->>'fullName') ELSE '{}'::jsonb END;$new$);
  END IF;
  SET LOCAL ROLE dental_function_owner;
  EXECUTE pg_catalog.replace(pg_catalog.replace(v_definition,v_source,v_changed),'FUNCTION dental.'||v_name||'(','FUNCTION dental.'||v_new_name||'(');
  EXECUTE 'REVOKE ALL ON FUNCTION dental.'||v_new_name||CASE WHEN v_name LIKE 'claim_%' THEN '(uuid)' ELSE '(uuid,uuid,text,jsonb)' END||' FROM PUBLIC';
  EXECUTE 'GRANT EXECUTE ON FUNCTION dental.'||v_new_name||CASE WHEN v_name LIKE 'claim_%' THEN '(uuid)' ELSE '(uuid,uuid,text,jsonb)' END||' TO dental_backend';
  RESET ROLE;
  -- Original names remain a legacy-only protocol, including stale HTTP callers.
  v_changed:=v_source;
  IF v_name='claim_patient_event' THEN
   v_changed:=pg_catalog.replace(v_changed,'WHERE e.policy_version=v_policy.version','WHERE o.payload_version IN(1,2) AND e.policy_version=v_policy.version');
  ELSIF v_name='claim_admin_delivery' THEN
   v_changed:=pg_catalog.replace(v_changed,'WHERE EXISTS(SELECT FROM dental.admin_booking_events b','WHERE d.payload_version=1 AND EXISTS(SELECT FROM dental.admin_booking_events b');
  ELSIF v_name='prepare_patient_dispatch' THEN
   v_changed:=pg_catalog.replace(v_changed,' SELECT appointment_date,appointment_id INTO v_date,v_appointment_id FROM dental.outbox WHERE id=p_event;',
    ' SELECT appointment_date,appointment_id INTO v_date,v_appointment_id FROM dental.outbox WHERE id=p_event AND payload_version IN(1,2);');
  ELSE
   v_changed:=pg_catalog.replace(v_changed,' SELECT account_id INTO v_account FROM dental.admin_booking_deliveries WHERE id=p_delivery;',
    ' SELECT account_id INTO v_account FROM dental.admin_booking_deliveries WHERE id=p_delivery AND payload_version=1;');
  END IF;
  IF v_changed=v_source THEN RAISE EXCEPTION 'Missing exact compatibility source anchor';END IF;
  SELECT pg_catalog.jsonb_agg(CASE WHEN (item->>'oid')::oid=v_oid THEN pg_catalog.jsonb_set(item,'{prosrc}',pg_catalog.to_jsonb(v_changed)) ELSE item END ORDER BY (item->>'oid')::oid)
   INTO v_functions FROM pg_catalog.jsonb_array_elements(v_functions) item;
  SET LOCAL ROLE dental_function_owner;
  EXECUTE pg_catalog.replace(v_definition,v_source,v_changed);
  RESET ROLE;
 END LOOP;
 REVOKE CREATE ON SCHEMA dental FROM dental_function_owner;
 REVOKE dental_function_owner FROM postgres GRANTED BY postgres;
 PERFORM pg_catalog.set_config('lock_timeout',v_original_lock_timeout,true);
 SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid) INTO v_functions_after FROM pg_catalog.pg_proc p WHERE p.pronamespace=v_schema AND p.oid IN(SELECT (item->>'oid')::oid FROM pg_catalog.jsonb_array_elements(v_functions) item);
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY roleid,member,grantor),'[]'::jsonb) INTO v_memberships_after
  FROM pg_catalog.pg_auth_members m WHERE m.roleid IN(v_owner,v_backend,v_runtime) OR m.member IN(v_owner,v_backend,v_runtime);
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.oid),'[]'::jsonb) INTO v_defaults_after FROM pg_catalog.pg_default_acl d WHERE d.defaclrole IN(v_postgres,v_owner);
 SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r)-'rolpassword' ORDER BY r.oid) INTO v_roles_after FROM pg_catalog.pg_roles r WHERE r.oid IN(v_owner,v_backend,v_runtime);
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(s) ORDER BY s.setdatabase,s.setrole),'[]'::jsonb) INTO v_role_settings_after FROM pg_catalog.pg_db_role_setting s WHERE s.setrole IN(v_owner,v_backend,v_runtime);
 SELECT pg_catalog.jsonb_build_object(
  'tables',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c) ORDER BY c.oid) FROM pg_catalog.pg_class c WHERE c.oid=ANY(v_old_tables)),
  'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.attrelid,a.attnum) FROM pg_catalog.pg_attribute a WHERE a.attrelid=ANY(v_old_tables)),
  'policies',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid) FROM pg_catalog.pg_policy p WHERE p.polrelid IN(SELECT oid FROM pg_catalog.pg_class WHERE relnamespace=v_schema)),
  'triggers',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_trigger t WHERE t.tgrelid=ANY(v_old_tables))
 ) INTO v_catalog_after;
 IF v_functions IS DISTINCT FROM v_functions_after OR v_memberships IS DISTINCT FROM v_memberships_after
  OR v_defaults IS DISTINCT FROM v_defaults_after OR v_roles IS DISTINCT FROM v_roles_after OR v_role_settings IS DISTINCT FROM v_role_settings_after
  OR v_catalog IS DISTINCT FROM v_catalog_after OR CURRENT_USER<>'postgres' OR SESSION_USER<>'postgres' OR pg_catalog.current_setting('role')<>'none' THEN
  RAISE EXCEPTION 'Notification card migration changed unrelated catalogs or failed to restore authority';
 END IF;
 -- Exactly four added callable capabilities; private pinning remains owner-only.
 FOR v_function IN SELECT * FROM pg_catalog.pg_proc WHERE oid IN(
  'dental.claim_admin_delivery_v2(uuid)'::regprocedure,'dental.prepare_admin_dispatch_v2(uuid,uuid,text,jsonb)'::regprocedure,
  'dental.claim_patient_event_v3(uuid)'::regprocedure,'dental.prepare_patient_dispatch_v3(uuid,uuid,text,jsonb)'::regprocedure,
  'dental._pin_notification_card_version()'::regprocedure) LOOP
  IF v_function.proowner<>v_owner OR NOT v_function.prosecdef
   OR v_function.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
   OR pg_catalog.has_function_privilege(v_backend,v_function.oid,'EXECUTE') IS DISTINCT FROM (v_function.proname<>'_pin_notification_card_version')
   OR EXISTS(SELECT FROM pg_catalog.aclexplode(COALESCE(v_function.proacl,pg_catalog.acldefault('f',v_owner))) a
    WHERE a.grantor<>v_owner OR a.privilege_type<>'EXECUTE' OR a.is_grantable
     OR NOT(a.grantee=v_owner OR (a.grantee=v_backend AND v_function.proname<>'_pin_notification_card_version'))) THEN
   RAISE EXCEPTION 'Unexpected new notification capability privileges';
  END IF;
 END LOOP;
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
 IF v_fingerprint IS DISTINCT FROM '{"schema":"4ae008106c89761f7c6d1788e7cdf716","tables":"c8f9ee91a2a130dab6a0158552ae1209","defaults":"4146858b1996fc4459bbe6f4feaddbc3","functions":"4e565fc02c7471fd2c738b8e01bcdf08"}'::jsonb
  AND v_fingerprint IS DISTINCT FROM '{"schema":"4ae008106c89761f7c6d1788e7cdf716","tables":"c8f9ee91a2a130dab6a0158552ae1209","defaults":"4e67d902862ac6ff8df82cf6c6b75a0e","functions":"4e565fc02c7471fd2c738b8e01bcdf08"}'::jsonb THEN
  RAISE EXCEPTION 'Unexpected notification card post-migration catalog %',v_fingerprint;
 END IF;
END;
$notification_cards$;
