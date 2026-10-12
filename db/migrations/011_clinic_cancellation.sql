-- UNEXECUTED migration 011 candidate. Local validation does not authorize hosted
-- application, message dispatch, credentials, schedules or permission changes.
-- Extends existing admin decide with approved → cancelled, reason in audit only,
-- suppression of obsolete work and one 24-hour cancellation event. Patient cancel,
-- finish_dispatch and restricted synthetic dispatch remain unchanged. A send that
-- already crossed final preparation may finish; its provider result is retained.
-- Existing notification types retain frozen V1; cancellation alone selects V2.
-- Only two function bodies and two outbox check constraints change. No new RPC,
-- tables, columns, policies or permanent privileges. PG17 baseline 010 required.
-- One atomic DO; inherited statement timeout 1ms..2min, per-lock timeout 3s.
DO $clinic_cancellation$
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

BEGIN
 -- A statement timer must already be running when this DO starts; setting it
 -- inside an executing DO is not a substitute. The whole migration is capped.
 IF (SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name = 'statement_timeout') NOT BETWEEN 1 AND 120000 THEN
  RAISE EXCEPTION 'Clinic cancellation requires an inherited statement timeout between 1ms and 2min';
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
  RAISE EXCEPTION 'Clinic cancellation requires the verified migration 010 managed baseline';
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
  RAISE EXCEPTION 'Unreviewed Clinic cancellation private/runtime role attributes or role settings';
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
  RAISE EXCEPTION 'Unreviewed exact Clinic cancellation runtime membership baseline';
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
 -- Pin the exact reviewed implementations. An already-applied or independently
 -- edited deployment must be inspected instead of accepting anchor-only patches.
 v_decide:='dental.decide(uuid,uuid,integer,text,text)'::pg_catalog.regprocedure::oid;
 v_prepare:='dental.prepare_dispatch(uuid,uuid,text)'::pg_catalog.regprocedure::oid;
 IF (SELECT pg_catalog.md5(prosrc) FROM pg_catalog.pg_proc WHERE oid=v_decide) IS DISTINCT FROM '2c835949065d3f189a4004deb88fef1e'
  OR (SELECT pg_catalog.md5(prosrc) FROM pg_catalog.pg_proc WHERE oid=v_prepare) IS DISTINCT FROM 'e2369f5b77d1a763ba037b7d62b50fb4'
  OR (SELECT pg_catalog.md5(prosrc) FROM pg_catalog.pg_proc WHERE oid='dental.prepare_restricted_dispatch(uuid,uuid,uuid,text)'::pg_catalog.regprocedure) IS DISTINCT FROM '5610ec20ad01acf0f86244471daeeec3'
  OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc WHERE pronamespace=v_schema)<>34
  OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_class WHERE relnamespace=v_schema AND relkind='r')<>15 THEN
  RAISE EXCEPTION 'Unreviewed or already-updated clinic cancellation baseline';
 END IF;
 FOR v_function IN SELECT * FROM pg_catalog.pg_proc WHERE oid IN (v_decide,v_prepare) LOOP
  IF v_function.proowner<>v_owner OR NOT v_function.prosecdef OR v_function.provolatile<>'v'
   OR v_function.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
   OR v_function.proisstrict OR v_function.proleakproof OR v_function.proparallel<>'u'
   OR v_function.prorettype<>'jsonb'::pg_catalog.regtype OR v_function.proretset
   OR v_function.prokind<>'f' OR v_function.prolang<>(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
   OR NOT pg_catalog.has_function_privilege(v_backend,v_function.oid,'EXECUTE')
   OR pg_catalog.has_function_privilege(v_postgres,v_function.oid,'EXECUTE')
   OR EXISTS(SELECT FROM pg_catalog.aclexplode(COALESCE(v_function.proacl,pg_catalog.acldefault('f',v_owner))) a
    WHERE a.grantee<>v_owner AND NOT(a.grantee=v_backend AND a.grantor=v_owner AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)) THEN
   RAISE EXCEPTION 'Unreviewed decision/dispatch security attributes or execute ACL';
  END IF;
 END LOOP;
 FOREACH v_role IN ARRAY ARRAY['anon','authenticated','authenticator','service_role'] LOOP
  IF pg_catalog.pg_has_role(v_role,v_owner,'MEMBER') OR pg_catalog.pg_has_role(v_role,v_backend,'MEMBER')
   OR pg_catalog.has_schema_privilege(v_role,v_schema,'USAGE,CREATE') THEN
   RAISE EXCEPTION 'Browser/platform role has a private clinic-cancellation path';
  END IF;
 END LOOP;
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE dental.outbox IN ACCESS EXCLUSIVE MODE;
 SELECT pg_catalog.pg_get_constraintdef(oid) INTO v_type_before FROM pg_catalog.pg_constraint
  WHERE conrelid='dental.outbox'::pg_catalog.regclass AND conname='outbox_type_check' AND contype='c' AND convalidated;
 SELECT pg_catalog.pg_get_constraintdef(oid) INTO v_envelope_before FROM pg_catalog.pg_constraint
  WHERE conrelid='dental.outbox'::pg_catalog.regclass AND conname='outbox_frozen_v1' AND contype='c' AND convalidated;
 IF pg_catalog.md5(v_type_before) IS DISTINCT FROM 'bcedfe9b8926949da71ba2733511128c'
  OR pg_catalog.md5(v_envelope_before) IS DISTINCT FROM 'ac47104b3d6899f152f47c01abdfab82'
  OR EXISTS(SELECT FROM pg_catalog.pg_constraint WHERE conrelid='dental.outbox'::pg_catalog.regclass AND conname='outbox_frozen_envelope') THEN
  RAISE EXCEPTION 'Unreviewed or already-updated outbox type/envelope constraints';
 END IF;
 SELECT pg_catalog.pg_get_functiondef(v_decide),prosrc INTO v_decide_before,v_decide_source FROM pg_catalog.pg_proc WHERE oid=v_decide;
 SELECT pg_catalog.pg_get_functiondef(v_prepare),prosrc INTO v_prepare_before,v_prepare_source FROM pg_catalog.pg_proc WHERE oid=v_prepare;
 -- Retain date → appointment → live outbox locks, fresh time, live admin
 -- rechecks, optimistic versioning and all existing patient/approval cutoffs.
 v_decide_source:=pg_catalog.replace(v_decide_source,$old$p_decision NOT IN ('approve','reject','complete','no_show')$old$,$new$p_decision NOT IN ('approve','reject','complete','no_show','cancel')$new$);
 v_decide_source:=pg_catalog.replace(v_decide_source,$old$p_decision IN ('complete','no_show') AND v_appointment.status<>'approved'$old$,$new$p_decision IN ('complete','no_show','cancel') AND v_appointment.status<>'approved'$new$);
 v_decide_source:=pg_catalog.replace(v_decide_source,$old$WHEN 'complete' THEN 'completed' ELSE 'no_show' END$old$,$new$WHEN 'complete' THEN 'completed' WHEN 'cancel' THEN 'cancelled' ELSE 'no_show' END$new$);
 v_decide_source:=pg_catalog.replace(v_decide_source,$old$approved_at=CASE WHEN p_decision='approve' THEN v_now ELSE approved_at END$old$,$new$approved_at=CASE WHEN p_decision='approve' THEN v_now ELSE approved_at END,
  cancelled_at=CASE WHEN p_decision='cancel' THEN v_now ELSE cancelled_at END,
  cancelled_by=CASE WHEN p_decision='cancel' THEN p_actor ELSE cancelled_by END$new$);
 v_decide_source:=pg_catalog.replace(v_decide_source,$old$ELSIF p_decision='reject' THEN$old$,$new$ELSIF p_decision IN ('reject','cancel') THEN$new$);
 v_decide_source:=pg_catalog.replace(v_decide_source,$old$VALUES(p_id,v_appointment.version,'rejection',v_now,v_now+interval '24 hours',v_now,v_now);$old$,$new$VALUES(p_id,v_appointment.version,CASE p_decision WHEN 'reject' THEN 'rejection' ELSE 'cancellation' END,v_now,v_now+interval '24 hours',v_now,v_now);$new$);
 -- V1 stays frozen; immutable event type selects the new cancellation-only V2.
 v_prepare_source:=pg_catalog.replace(v_prepare_source,$old$OR (v_event.type='rejection' AND v_appointment.status<>'rejected')$old$,$new$OR (v_event.type='rejection' AND v_appointment.status<>'rejected')
  OR (v_event.type='cancellation' AND v_appointment.status<>'cancelled')$new$);
 v_prepare_source:=pg_catalog.replace(v_prepare_source,$old$'manageUrl',v_event.dispatch_manage_url,'payloadVersion',1$old$,$new$'manageUrl',v_event.dispatch_manage_url,'payloadVersion',CASE WHEN v_event.type='cancellation' THEN 2 ELSE 1 END$new$);
 v_decide_after:=pg_catalog.replace(v_decide_before,(SELECT prosrc FROM pg_catalog.pg_proc WHERE oid=v_decide),v_decide_source);
 v_prepare_after:=pg_catalog.replace(v_prepare_before,(SELECT prosrc FROM pg_catalog.pg_proc WHERE oid=v_prepare),v_prepare_source);
 v_type_after:=pg_catalog.replace(v_type_before,$old$ARRAY['approval'::text, 'rejection'::text, 'reminder'::text]$old$,$new$ARRAY['approval'::text, 'rejection'::text, 'reminder'::text, 'cancellation'::text]$new$);
 v_envelope_after:=pg_catalog.replace(v_envelope_before,$old$(dispatch_status = ANY (ARRAY['approved'::text, 'rejected'::text]))$old$,$new$(((type <> 'cancellation'::text) AND (dispatch_status = ANY (ARRAY['approved'::text, 'rejected'::text]))) OR ((type = 'cancellation'::text) AND (dispatch_status = 'cancelled'::text)))$new$);
 SELECT pg_catalog.jsonb_agg(CASE WHEN p.oid=v_decide
   THEN pg_catalog.jsonb_set(pg_catalog.to_jsonb(p),'{prosrc}',pg_catalog.to_jsonb(v_decide_source))
   WHEN p.oid=v_prepare THEN pg_catalog.jsonb_set(pg_catalog.to_jsonb(p),'{prosrc}',pg_catalog.to_jsonb(v_prepare_source))
   ELSE pg_catalog.to_jsonb(p) END ORDER BY p.oid)
  INTO v_existing_functions FROM pg_catalog.pg_proc p WHERE p.pronamespace=v_schema;
 SELECT pg_catalog.jsonb_build_object(
  'schema',(SELECT pg_catalog.to_jsonb(n) FROM pg_catalog.pg_namespace n WHERE n.oid=v_schema),
  'tables',(SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('oid',c.oid,'owner',c.relowner,'acl',c.relacl,'rls',c.relrowsecurity,'force',c.relforcerowsecurity) ORDER BY c.oid) FROM pg_catalog.pg_class c WHERE c.relnamespace=v_schema),
  'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.attrelid,a.attnum) FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid WHERE c.relnamespace=v_schema),
  'policies',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid) FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid WHERE c.relnamespace=v_schema),
  'triggers',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace=v_schema),
  'constraints',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c) ORDER BY c.oid) FROM pg_catalog.pg_constraint c WHERE c.connamespace=v_schema AND NOT(c.conrelid='dental.outbox'::pg_catalog.regclass AND c.conname IN ('outbox_type_check','outbox_frozen_v1','outbox_frozen_envelope')))
 ) INTO v_catalog;
 ALTER TABLE dental.outbox DROP CONSTRAINT outbox_type_check, DROP CONSTRAINT outbox_frozen_v1;
 EXECUTE 'ALTER TABLE dental.outbox ADD CONSTRAINT outbox_type_check '||v_type_after;
 EXECUTE 'ALTER TABLE dental.outbox ADD CONSTRAINT outbox_frozen_envelope '||v_envelope_after;
 GRANT dental_function_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
 GRANT CREATE ON SCHEMA dental TO dental_function_owner;
 SET LOCAL ROLE dental_function_owner;
 EXECUTE v_decide_after;
 EXECUTE v_prepare_after;
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
  'constraints',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c) ORDER BY c.oid) FROM pg_catalog.pg_constraint c WHERE c.connamespace=v_schema AND NOT(c.conrelid='dental.outbox'::pg_catalog.regclass AND c.conname IN ('outbox_type_check','outbox_frozen_v1','outbox_frozen_envelope')))
 ) INTO v_catalog_after;
 IF v_existing_functions IS DISTINCT FROM v_existing_functions_after
  OR v_catalog IS DISTINCT FROM v_catalog_after
  OR v_memberships IS DISTINCT FROM v_memberships_after OR v_defaults IS DISTINCT FROM v_defaults_after
  OR v_roles IS DISTINCT FROM v_roles_after OR v_role_settings IS DISTINCT FROM v_role_settings_after
  OR pg_catalog.pg_get_functiondef(v_decide) IS DISTINCT FROM v_decide_after
  OR pg_catalog.pg_get_functiondef(v_prepare) IS DISTINCT FROM v_prepare_after
  OR (SELECT pg_catalog.pg_get_constraintdef(oid) FROM pg_catalog.pg_constraint WHERE conrelid='dental.outbox'::pg_catalog.regclass AND conname='outbox_type_check' AND convalidated) IS DISTINCT FROM v_type_after
  OR (SELECT pg_catalog.pg_get_constraintdef(oid) FROM pg_catalog.pg_constraint WHERE conrelid='dental.outbox'::pg_catalog.regclass AND conname='outbox_frozen_envelope' AND convalidated) IS DISTINCT FROM v_envelope_after
  OR CURRENT_USER<>'postgres' OR pg_catalog.current_setting('role')<>'none'
  OR pg_catalog.current_setting('lock_timeout') IS DISTINCT FROM v_original_lock_timeout THEN
  RAISE EXCEPTION 'Clinic cancellation changed unrelated catalogs or did not restore temporary access/settings';
 END IF;
END;
$clinic_cancellation$;
