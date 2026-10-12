-- UNEXECUTED candidate; local synthetic validation is not permission for hosted migration, access, configuration or LINE sends.
-- Atomic PG17 baseline 012 extension; policy data stays unchanged, no enablement or backfill.
DO $combined_notifications$
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
 v_catalog jsonb; v_catalog_after jsonb;
 v_old_tables oid[]; v_reserve oid; v_reserve_source text; v_reserve_definition text; v_expected_reserve text;
 v_grantee record;
 v_admin oid;v_admin_source text;v_admin_definition text;v_expected_admin text;
 v_budget oid;v_budget_source text;v_budget_definition text;v_expected_budget text;
 v_policy oid;v_policy_source text;v_policy_definition text;v_expected_policy text;
 v_fingerprint text; v_new oid;
 v_claim_admin oid;v_claim_admin_source text;v_claim_admin_definition text;v_expected_claim_admin text;
 v_prepare_admin oid;v_prepare_admin_source text;v_prepare_admin_definition text;v_expected_prepare_admin text;
 v_revalidate_admin oid;v_revalidate_admin_source text;v_revalidate_admin_definition text;v_expected_revalidate_admin text;
 v_revoked oid[];

BEGIN
 -- A statement timer must already be running when this DO starts; setting it
 -- inside an executing DO is not a substitute. The whole migration is capped.
 IF (SELECT setting::bigint FROM pg_catalog.pg_settings WHERE name = 'statement_timeout') NOT BETWEEN 1 AND 120000 THEN
  RAISE EXCEPTION 'Combined notifications require an inherited statement timeout between 1ms and 2min';
 END IF;
 IF CURRENT_USER<>'postgres' OR SESSION_USER<>'postgres' OR v_major<>17
  OR pg_catalog.current_setting('role')<>'none'
  OR pg_catalog.current_setting('transaction_isolation')<>'read committed'
  OR pg_catalog.current_setting('transaction_read_only')<>'off'
  OR pg_catalog.to_regprocedure('dental.decide(uuid,uuid,integer,text,text)') IS NULL
  OR pg_catalog.to_regprocedure('dental.claim_events(uuid,integer)') IS NULL
  OR pg_catalog.to_regprocedure('dental.consume_request_limit(text,text)') IS NULL
  OR pg_catalog.to_regprocedure('dental.claim_restricted_event(uuid,uuid,uuid)') IS NULL
  OR pg_catalog.to_regclass('dental.admin_notification_policy') IS NULL
  OR pg_catalog.to_regprocedure('dental.prepare_restricted_dispatch(uuid,uuid,uuid,text)') IS NULL
  OR pg_catalog.to_regprocedure('dental._fence_restricted_attempt()') IS NULL
  OR pg_catalog.to_regclass('dental.restricted_dispatch_authorizations') IS NULL THEN
  RAISE EXCEPTION 'Combined notifications require the verified migration 012 managed baseline';
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
  RAISE EXCEPTION 'Unreviewed Combined notifications private/runtime role attributes or role settings';
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
  RAISE EXCEPTION 'Unreviewed exact Combined notifications runtime membership baseline';
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
 -- Pin every installed 012 function body, including the disabled general claim
 -- and restricted authorization fence. Unknown drift must never become a baseline.
 SELECT pg_catalog.md5(pg_catalog.string_agg(p.proname::text||':'||pg_catalog.md5(p.prosrc),E'\n'
  ORDER BY p.proname::text COLLATE "C")) INTO v_fingerprint FROM pg_catalog.pg_proc p WHERE p.pronamespace=v_schema;
 IF v_fingerprint IS DISTINCT FROM 'a41da324ba4132ecc5169c502e9a33cf'
  OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc WHERE pronamespace=v_schema)<>44
  OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_class WHERE relnamespace=v_schema AND relkind='r')<>21
  OR pg_catalog.to_regclass('dental.notification_booking_enrollments') IS NOT NULL
  OR pg_catalog.to_regprocedure('dental.claim_patient_event(uuid)') IS NOT NULL THEN
  RAISE EXCEPTION 'Unreviewed or already-updated combined notification baseline 012';
 END IF;
 v_reserve:='dental.reserve(uuid,uuid,jsonb)'::pg_catalog.regprocedure::oid;
 -- A source-only hash cannot prove the reviewed execution contract. In
 -- particular, reservation writes require its original definer/volatile mode,
 -- while clock_now must remain the trusted volatile invoker clock.
 IF NOT EXISTS(SELECT FROM pg_catalog.pg_proc WHERE oid=v_reserve AND proowner=v_owner AND prosecdef
   AND provolatile='v' AND proconfig=ARRAY['search_path=""']::text[])
  OR NOT EXISTS(SELECT FROM pg_catalog.pg_proc WHERE oid='dental.clock_now()'::pg_catalog.regprocedure
   AND proowner=v_owner AND NOT prosecdef AND provolatile='v' AND proconfig=ARRAY['search_path=""']::text[]) THEN
  RAISE EXCEPTION 'Unreviewed combined reserve or clock execution metadata baseline';
 END IF;
 -- Freeze the enforcement surface before validating it. A preserved snapshot
 -- of an already missing/disabled fence is not a reviewed authorization gate.
 PERFORM pg_catalog.set_config('lock_timeout','3s',true);
 LOCK TABLE dental.notification_attempts IN SHARE ROW EXCLUSIVE MODE;
 IF NOT EXISTS(SELECT FROM pg_catalog.pg_trigger WHERE tgrelid='dental.notification_attempts'::pg_catalog.regclass
   AND tgname='fence_restricted_attempt' AND tgfoid='dental._fence_restricted_attempt()'::pg_catalog.regprocedure
   AND tgtype=7 AND tgenabled='O' AND NOT tgisinternal AND tgnargs=0 AND tgqual IS NULL
   AND tgconstraint=0 AND NOT tgdeferrable AND NOT tginitdeferred)
  OR (SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger
   WHERE tgrelid='dental.notification_attempts'::pg_catalog.regclass AND NOT tgisinternal)<>1
  OR EXISTS(SELECT FROM pg_catalog.pg_rewrite WHERE ev_class='dental.notification_attempts'::pg_catalog.regclass) THEN
  RAISE EXCEPTION 'Unreviewed combined restricted attempt trigger or rule baseline';
 END IF;
 SELECT prosrc,pg_catalog.pg_get_functiondef(oid) INTO v_reserve_source,v_reserve_definition FROM pg_catalog.pg_proc WHERE oid=v_reserve;
 v_expected_reserve:=pg_catalog.replace(v_reserve_source,' PERFORM dental._enqueue_admin_booking(v_appointment);',
  E' PERFORM dental._enroll_notification_booking(v_appointment);\n PERFORM dental._enqueue_admin_booking(v_appointment);');
 IF v_expected_reserve=v_reserve_source THEN RAISE EXCEPTION 'Missing exact reservation enrollment anchor'; END IF;
 -- Declare exact shared-budget/policy and admin-enrollment source deltas plus
 -- four legacy ACL contractions; every unrelated catalog remains pinned.
 v_admin:='dental._reserve_admin_budget(uuid,jsonb)'::pg_catalog.regprocedure;
 v_budget:='dental.set_admin_notification_budget(uuid,integer,timestamptz,timestamptz,integer,integer,boolean,text)'::pg_catalog.regprocedure;
 v_policy:='dental.set_admin_notification_policy(uuid,integer,boolean,timestamptz,timestamptz,text)'::pg_catalog.regprocedure;
 v_claim_admin:='dental.claim_admin_delivery(uuid)'::pg_catalog.regprocedure;
 v_prepare_admin:='dental.prepare_admin_dispatch(uuid,uuid,text,jsonb)'::pg_catalog.regprocedure;
 v_revalidate_admin:='dental.revalidate_admin_dispatch(uuid,uuid)'::pg_catalog.regprocedure;
 v_revoked:=ARRAY['dental.claim_events(uuid,integer)'::regprocedure::oid,'dental.prepare_dispatch(uuid,uuid,text)'::regprocedure::oid,
  'dental.claim_restricted_event(uuid,uuid,uuid)'::regprocedure::oid,'dental.prepare_restricted_dispatch(uuid,uuid,uuid,text)'::regprocedure::oid];
 FOREACH v_new IN ARRAY ARRAY[v_admin,v_budget,v_policy,v_claim_admin,v_prepare_admin,v_revalidate_admin] LOOP
  IF NOT EXISTS(SELECT FROM pg_catalog.pg_proc WHERE oid=v_new AND proowner=v_owner AND prosecdef
    AND provolatile='v' AND proconfig=ARRAY['search_path=""']::text[]
    AND NOT proisstrict AND NOT proleakproof AND proparallel='u' AND prokind='f' AND NOT proretset
    AND prolang=(SELECT oid FROM pg_catalog.pg_language WHERE lanname='plpgsql')
    AND proallargtypes IS NULL AND proargmodes IS NULL
    AND prorettype=CASE WHEN v_new IN(v_admin,v_revalidate_admin) THEN 'boolean'::regtype
      WHEN v_new IN(v_budget,v_policy) THEN 'integer'::regtype ELSE 'jsonb'::regtype END) THEN
   RAISE EXCEPTION 'Unreviewed combined budget, policy or admin execution metadata baseline'; END IF;
 END LOOP;
 SELECT prosrc,pg_catalog.pg_get_functiondef(oid) INTO v_admin_source,v_admin_definition FROM pg_catalog.pg_proc WHERE oid=v_admin;
 SELECT prosrc,pg_catalog.pg_get_functiondef(oid) INTO v_budget_source,v_budget_definition FROM pg_catalog.pg_proc WHERE oid=v_budget;
 SELECT prosrc,pg_catalog.pg_get_functiondef(oid) INTO v_policy_source,v_policy_definition FROM pg_catalog.pg_proc WHERE oid=v_policy;
 v_expected_admin:=$admin_body$
DECLARE v_delivery dental.admin_booking_deliveries;v_now timestamptz;v_expires timestamptz;v_reason text;
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE'; END IF;
 -- Budget precedes delivery; the shared core reacquires only locks held here.
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dental.admin-budget',0));
 PERFORM epoch FROM dental.admin_notification_budget ORDER BY version DESC LIMIT 1 FOR UPDATE;
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
 v_reason:=dental._reserve_notification_budget('admin',p_delivery,p_quota);
 IF v_reason IS NULL THEN RETURN true; END IF;
 UPDATE dental.admin_booking_deliveries SET state='paused_quota',safe_reason=v_reason,due_at=dental.clock_now()+interval '15 minutes',
  lease_owner=NULL,lease_until=NULL,authorization_valid_until=NULL WHERE id=p_delivery;
 RETURN false;
END;
$admin_body$;
 v_expected_budget:=pg_catalog.replace(v_budget_source,
  $old_carry$  SELECT v_budget.carried_units+pg_catalog.count(*) INTO v_carried
  FROM dental.admin_notification_budget_reservations r JOIN dental.admin_booking_deliveries d ON d.id=r.delivery_id
  WHERE r.budget_epoch=v_budget.epoch AND d.first_attempt_at IS NOT NULL
   AND NOT(d.state='accepted' AND d.accepted_at IS NOT NULL AND d.accepted_at<v_budget.verified_until);$old_carry$,
  $carry$  SELECT v_budget.carried_units
   +(SELECT pg_catalog.count(*) FROM dental.admin_notification_budget_reservations r JOIN dental.admin_booking_deliveries d ON d.id=r.delivery_id
     WHERE r.budget_epoch=v_budget.epoch AND d.first_attempt_at IS NOT NULL
      AND NOT(d.state='accepted' AND d.accepted_at IS NOT NULL AND d.accepted_at<v_budget.verified_until))
   +(SELECT pg_catalog.count(*) FROM dental.patient_notification_budget_reservations r JOIN dental.outbox o ON o.id=r.outbox_id
     WHERE r.budget_epoch=v_budget.epoch AND o.first_attempt_at IS NOT NULL
      AND NOT(o.state='accepted' AND o.accepted_at IS NOT NULL AND o.accepted_at<v_budget.verified_until)) INTO v_carried;$carry$);
 v_expected_policy:=pg_catalog.replace(v_policy_source,
  'DECLARE v_policy dental.admin_notification_policy;v_now timestamptz;',
  'DECLARE v_policy dental.admin_notification_policy;v_now timestamptz;v_patient_targets uuid[];');
 v_expected_policy:=pg_catalog.replace(v_expected_policy,
  'OR p_activation_at<v_now OR p_authorized_end_at<=p_activation_at)',
  'OR p_activation_at<v_now OR p_authorized_end_at<>p_activation_at+interval ''7 days'')');
 v_expected_policy:=pg_catalog.replace(v_expected_policy,
  $old_policy$  WHERE state IN ('queued','retry','paused_quota','leased');$old_policy$,
  $new_policy$  WHERE state IN ('queued','retry','paused_quota','leased') AND event_id IN(
   SELECT b.id FROM dental.admin_booking_events b JOIN dental.notification_booking_enrollments e ON e.appointment_id=b.appointment_id
   JOIN dental.appointments a ON a.id=e.appointment_id
   WHERE e.policy_version=v_policy.version AND e.activation_at=v_policy.activation_at AND e.authorized_end_at=v_policy.authorized_end_at
    AND a.created_at>=e.activation_at AND a.created_at<e.authorized_end_at);
 -- Match cancel/decide's ascending-ID prelock without taking date/appointment
 -- locks. Capture precisely the locked set: the later UPDATE must not introduce
 -- newly visible outbox rows through another unordered acquisition pass.
 SELECT COALESCE(pg_catalog.array_agg(q.id ORDER BY q.id),'{}'::uuid[]) INTO v_patient_targets FROM (
  SELECT o.id FROM dental.outbox o
   JOIN dental.notification_booking_enrollments e ON e.appointment_id=o.appointment_id
   JOIN dental.appointments a ON a.id=e.appointment_id
   WHERE o.state IN('queued','retry','leased') AND e.policy_version=v_policy.version
    AND e.activation_at=v_policy.activation_at AND e.authorized_end_at=v_policy.authorized_end_at
    AND a.created_at>=e.activation_at AND a.created_at<e.authorized_end_at
   ORDER BY o.id FOR UPDATE OF o
 ) q;
 -- Only the departing enrollment's locked pending work is suppressed. Legacy
 -- rows, terminal outcomes, attempts, payloads and reservation ledgers stay intact.
 UPDATE dental.outbox SET state='suppressed',lease_owner=NULL,lease_until=NULL,updated_at=v_now
  WHERE id=ANY(v_patient_targets) AND state IN('queued','retry','leased');$new_policy$);
 IF v_expected_budget=v_budget_source OR v_expected_policy=v_policy_source
  OR pg_catalog.strpos(v_expected_policy,$end$p_authorized_end_at<>p_activation_at+interval '7 days'$end$)=0 THEN
  RAISE EXCEPTION 'Missing exact combined budget or policy extension anchor'; END IF;
 -- Exact admin enrollment fences preserve snapshot/grant semantics and lock order.
 SELECT prosrc,pg_catalog.pg_get_functiondef(oid) INTO v_claim_admin_source,v_claim_admin_definition FROM pg_catalog.pg_proc WHERE oid=v_claim_admin;
 SELECT prosrc,pg_catalog.pg_get_functiondef(oid) INTO v_prepare_admin_source,v_prepare_admin_definition FROM pg_catalog.pg_proc WHERE oid=v_prepare_admin;
 SELECT prosrc,pg_catalog.pg_get_functiondef(oid) INTO v_revalidate_admin_source,v_revalidate_admin_definition FROM pg_catalog.pg_proc WHERE oid=v_revalidate_admin;
 v_expected_claim_admin:=pg_catalog.replace(v_claim_admin_source,
  '   WHERE ((d.state',
  $claim_fence$   WHERE EXISTS(SELECT FROM dental.admin_booking_events b JOIN dental.notification_booking_enrollments e ON e.appointment_id=b.appointment_id
    JOIN dental.appointments a ON a.id=e.appointment_id JOIN dental.admin_notification_policy p ON p.singleton
    WHERE b.id=d.event_id AND p.enabled AND dental.clock_now()>=p.activation_at AND dental.clock_now()<p.authorized_end_at
     AND e.policy_version=p.version AND e.activation_at=p.activation_at AND e.authorized_end_at=p.authorized_end_at
     AND a.created_at>=e.activation_at AND a.created_at<e.authorized_end_at)
    AND ((d.state$claim_fence$);
 v_expected_prepare_admin:=pg_catalog.replace(v_prepare_admin_source,
  ' SELECT * INTO STRICT v_policy FROM dental.admin_notification_policy WHERE singleton FOR SHARE;',
  $prepare_fence$ SELECT * INTO STRICT v_policy FROM dental.admin_notification_policy WHERE singleton FOR SHARE;
 IF NOT EXISTS(SELECT FROM dental.admin_booking_deliveries d JOIN dental.admin_booking_events b ON b.id=d.event_id
  JOIN dental.notification_booking_enrollments e ON e.appointment_id=b.appointment_id JOIN dental.appointments a ON a.id=e.appointment_id
  WHERE d.id=p_delivery AND e.policy_version=v_policy.version AND e.activation_at=v_policy.activation_at AND e.authorized_end_at=v_policy.authorized_end_at
   AND a.created_at>=e.activation_at AND a.created_at<e.authorized_end_at) THEN RETURN NULL; END IF;$prepare_fence$);
 v_expected_revalidate_admin:=pg_catalog.replace(v_revalidate_admin_source,
  ' SELECT * INTO STRICT v_policy FROM dental.admin_notification_policy WHERE singleton FOR SHARE;',
  $revalidate_fence$ SELECT * INTO STRICT v_policy FROM dental.admin_notification_policy WHERE singleton FOR SHARE;
 IF NOT EXISTS(SELECT FROM dental.admin_booking_deliveries d JOIN dental.admin_booking_events b ON b.id=d.event_id
  JOIN dental.notification_booking_enrollments e ON e.appointment_id=b.appointment_id JOIN dental.appointments a ON a.id=e.appointment_id
  WHERE d.id=p_delivery AND e.policy_version=v_policy.version AND e.activation_at=v_policy.activation_at AND e.authorized_end_at=v_policy.authorized_end_at
   AND a.created_at>=e.activation_at AND a.created_at<e.authorized_end_at) THEN RETURN false; END IF;$revalidate_fence$);
 IF v_expected_claim_admin=v_claim_admin_source OR v_expected_prepare_admin=v_prepare_admin_source OR v_expected_revalidate_admin=v_revalidate_admin_source THEN
  RAISE EXCEPTION 'Missing exact combined admin enrollment anchors';END IF;
 SELECT pg_catalog.jsonb_agg(CASE WHEN p.oid=ANY(v_revoked) THEN pg_catalog.jsonb_set(pg_catalog.to_jsonb(p),'{proacl}',pg_catalog.to_jsonb(ARRAY(SELECT acl FROM pg_catalog.unnest(p.proacl) acl WHERE acl::text NOT LIKE 'dental_backend=%'))) ELSE CASE
  WHEN p.oid=v_reserve THEN pg_catalog.jsonb_set(pg_catalog.to_jsonb(p),'{prosrc}',pg_catalog.to_jsonb(v_expected_reserve))
  WHEN p.oid=v_admin THEN pg_catalog.jsonb_set(pg_catalog.to_jsonb(p),'{prosrc}',pg_catalog.to_jsonb(v_expected_admin))
  WHEN p.oid=v_budget THEN pg_catalog.jsonb_set(pg_catalog.to_jsonb(p),'{prosrc}',pg_catalog.to_jsonb(v_expected_budget))
  WHEN p.oid=v_policy THEN pg_catalog.jsonb_set(pg_catalog.to_jsonb(p),'{prosrc}',pg_catalog.to_jsonb(v_expected_policy))
  WHEN p.oid=v_claim_admin THEN pg_catalog.jsonb_set(pg_catalog.to_jsonb(p),'{prosrc}',pg_catalog.to_jsonb(v_expected_claim_admin))
  WHEN p.oid=v_prepare_admin THEN pg_catalog.jsonb_set(pg_catalog.to_jsonb(p),'{prosrc}',pg_catalog.to_jsonb(v_expected_prepare_admin))
  WHEN p.oid=v_revalidate_admin THEN pg_catalog.jsonb_set(pg_catalog.to_jsonb(p),'{prosrc}',pg_catalog.to_jsonb(v_expected_revalidate_admin))
  ELSE pg_catalog.to_jsonb(p) END END ORDER BY p.oid) INTO v_existing_functions FROM pg_catalog.pg_proc p WHERE pronamespace=v_schema;
 SELECT pg_catalog.array_agg(oid) INTO v_old_tables FROM pg_catalog.pg_class WHERE relnamespace=v_schema;
 SELECT pg_catalog.jsonb_build_object(
  'tables',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(c) ORDER BY c.oid) FROM pg_catalog.pg_class c WHERE c.oid=ANY(v_old_tables)),
  'columns',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(a) ORDER BY a.attrelid,a.attnum) FROM pg_catalog.pg_attribute a WHERE a.attrelid=ANY(v_old_tables)),
  'policies',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid) FROM pg_catalog.pg_policy p WHERE p.polrelid=ANY(v_old_tables)),
  'triggers',(SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t) ORDER BY t.oid) FROM pg_catalog.pg_trigger t WHERE t.tgrelid=ANY(v_old_tables))
 ) INTO v_catalog;
 GRANT dental_function_owner TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;
 GRANT CREATE ON SCHEMA dental TO dental_function_owner;

 CREATE TABLE dental.notification_booking_enrollments(
  appointment_id uuid PRIMARY KEY REFERENCES dental.appointments(id),
  policy_version integer NOT NULL CHECK(policy_version>0),
  activation_at timestamptz NOT NULL CHECK(pg_catalog.isfinite(activation_at)),
  authorized_end_at timestamptz NOT NULL CHECK(pg_catalog.isfinite(authorized_end_at) AND authorized_end_at>activation_at),
  enrolled_at timestamptz NOT NULL CHECK(pg_catalog.isfinite(enrolled_at) AND enrolled_at>=activation_at AND enrolled_at<authorized_end_at)
 );
 ALTER TABLE dental.notification_booking_enrollments ENABLE ROW LEVEL SECURITY;
 ALTER TABLE dental.notification_booking_enrollments FORCE ROW LEVEL SECURITY;
 REVOKE ALL ON TABLE dental.notification_booking_enrollments FROM PUBLIC;
 FOR v_grantee IN SELECT DISTINCT r.rolname FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
  JOIN pg_catalog.pg_roles r ON r.oid=a.grantee WHERE c.oid='dental.notification_booking_enrollments'::regclass AND a.grantee<>c.relowner LOOP
  EXECUTE pg_catalog.format('REVOKE ALL ON TABLE dental.notification_booking_enrollments FROM %I',v_grantee.rolname);
 END LOOP;
 GRANT SELECT,INSERT ON dental.notification_booking_enrollments TO dental_function_owner;
 CREATE POLICY notification_enrollments_read ON dental.notification_booking_enrollments FOR SELECT TO dental_function_owner USING(true);
 CREATE POLICY notification_enrollments_insert ON dental.notification_booking_enrollments FOR INSERT TO dental_function_owner WITH CHECK(true);
 -- No UPDATE/DELETE/TRUNCATE grant or mutation policy: enrollment cannot change
 -- policy version or be recreated through a runtime entry point.
 CREATE TABLE dental.patient_notification_budget_reservations(
  outbox_id uuid PRIMARY KEY REFERENCES dental.outbox(id),
  budget_epoch uuid NOT NULL REFERENCES dental.admin_notification_budget(epoch),
  units integer NOT NULL DEFAULT 1 CHECK(units=1),
  created_at timestamptz NOT NULL CHECK(pg_catalog.isfinite(created_at))
 );
 ALTER TABLE dental.patient_notification_budget_reservations ENABLE ROW LEVEL SECURITY;
 ALTER TABLE dental.patient_notification_budget_reservations FORCE ROW LEVEL SECURITY;
 REVOKE ALL ON TABLE dental.patient_notification_budget_reservations FROM PUBLIC;
 FOR v_grantee IN SELECT DISTINCT r.rolname FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
  JOIN pg_catalog.pg_roles r ON r.oid=a.grantee WHERE c.oid='dental.patient_notification_budget_reservations'::regclass AND a.grantee<>c.relowner LOOP
  EXECUTE pg_catalog.format('REVOKE ALL ON TABLE dental.patient_notification_budget_reservations FROM %I',v_grantee.rolname);
 END LOOP;
 GRANT SELECT,INSERT ON dental.patient_notification_budget_reservations TO dental_function_owner;
 CREATE POLICY patient_budget_reservations_read ON dental.patient_notification_budget_reservations FOR SELECT TO dental_function_owner USING(true);
 CREATE POLICY patient_budget_reservations_insert ON dental.patient_notification_budget_reservations FOR INSERT TO dental_function_owner WITH CHECK(true);
 -- Mutable per-attempt authorization metadata is separate from all frozen
 -- payload columns and immutable budget reservations. Runtime gets no access.
 CREATE TABLE dental.patient_dispatch_authorizations(
  outbox_id uuid PRIMARY KEY REFERENCES dental.outbox(id),
  worker_id uuid NOT NULL,attempt_number integer NOT NULL CHECK(attempt_number BETWEEN 1 AND 6),
  budget_epoch uuid NOT NULL REFERENCES dental.admin_notification_budget(epoch),
  prepared_at timestamptz NOT NULL CHECK(pg_catalog.isfinite(prepared_at)),
  quota_observed_at timestamptz NOT NULL CHECK(pg_catalog.isfinite(quota_observed_at)),
  quota_limit bigint NOT NULL CHECK(quota_limit BETWEEN 0 AND 9007199254740991),
  authorization_valid_until timestamptz NOT NULL CHECK(pg_catalog.isfinite(authorization_valid_until) AND authorization_valid_until>prepared_at)
 );
 ALTER TABLE dental.patient_dispatch_authorizations ENABLE ROW LEVEL SECURITY;
 ALTER TABLE dental.patient_dispatch_authorizations FORCE ROW LEVEL SECURITY;
 REVOKE ALL ON dental.patient_dispatch_authorizations FROM PUBLIC;
 FOR v_grantee IN SELECT DISTINCT r.rolname FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) a
  JOIN pg_catalog.pg_roles r ON r.oid=a.grantee WHERE c.oid='dental.patient_dispatch_authorizations'::regclass AND a.grantee<>c.relowner LOOP
  EXECUTE pg_catalog.format('REVOKE ALL ON TABLE dental.patient_dispatch_authorizations FROM %I',v_grantee.rolname);END LOOP;
 GRANT SELECT,INSERT,UPDATE ON dental.patient_dispatch_authorizations TO dental_function_owner;
 CREATE POLICY patient_authorizations_read ON dental.patient_dispatch_authorizations FOR SELECT TO dental_function_owner USING(true);
 CREATE POLICY patient_authorizations_insert ON dental.patient_dispatch_authorizations FOR INSERT TO dental_function_owner WITH CHECK(true);
 CREATE POLICY patient_authorizations_update ON dental.patient_dispatch_authorizations FOR UPDATE TO dental_function_owner USING(true) WITH CHECK(true);
 SET LOCAL ROLE dental_function_owner;
 EXECUTE $definitions$
-- One conservative quota parser, high-water update and atomic reserve invariant
-- for both lanes. Callers hold the budget lock before their delivery row lock.
CREATE FUNCTION dental._reserve_notification_budget(p_lane text,p_id uuid,p_quota jsonb)
RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_budget dental.admin_notification_budget;v_now timestamptz;v_existing uuid;
 v_limit numeric;v_usage numeric;v_observed timestamptz;v_ceiling numeric;v_bound numeric;v_reason text;
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE'; END IF;
 IF p_lane IS NULL OR p_lane NOT IN('admin','patient') OR p_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dental.admin-budget',0));
 SELECT * INTO v_budget FROM dental.admin_notification_budget ORDER BY version DESC LIMIT 1 FOR UPDATE;
 v_now:=dental.clock_now();
 IF v_budget.epoch IS NULL OR NOT v_budget.no_overage_verified OR v_now<v_budget.verified_from OR v_now>=v_budget.verified_until THEN RETURN 'budget_expired'; END IF;
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
    OR NOT pg_catalog.isfinite(v_observed) OR v_observed>v_now OR v_now-v_observed>interval '60 seconds' THEN v_reason:='quota_unknown'; END IF;
  END IF;
 EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range THEN v_reason:='quota_unknown';
 END;
 IF v_reason IS NOT NULL THEN RETURN v_reason; END IF;
 UPDATE dental.admin_notification_budget SET usage_high_water=GREATEST(usage_high_water,v_usage::bigint) WHERE epoch=v_budget.epoch RETURNING * INTO v_budget;
 v_ceiling:=LEAST(300,v_budget.free_limit,v_limit);
 v_bound:=GREATEST(v_budget.baseline_usage,v_budget.usage_high_water)+v_budget.reserved_units+v_budget.carried_units;
 IF p_lane='admin' THEN SELECT budget_epoch INTO v_existing FROM dental.admin_notification_budget_reservations WHERE delivery_id=p_id;
 ELSE SELECT budget_epoch INTO v_existing FROM dental.patient_notification_budget_reservations WHERE outbox_id=p_id; END IF;
 IF v_existing IS NOT NULL THEN
  IF v_existing<>v_budget.epoch THEN RETURN 'budget_expired'; END IF;
  IF v_bound<=v_ceiling THEN RETURN NULL; END IF;
  RETURN 'quota_exhausted';
 END IF;
 IF v_bound+1>v_ceiling THEN RETURN 'quota_exhausted'; END IF;
 IF p_lane='admin' THEN INSERT INTO dental.admin_notification_budget_reservations(delivery_id,budget_epoch,created_at) VALUES(p_id,v_budget.epoch,v_now);
 ELSE INSERT INTO dental.patient_notification_budget_reservations(outbox_id,budget_epoch,created_at) VALUES(p_id,v_budget.epoch,v_now); END IF;
 UPDATE dental.admin_notification_budget SET reserved_units=reserved_units+1 WHERE epoch=v_budget.epoch;
 RETURN NULL;
END;
$body$;
CREATE FUNCTION dental._reserve_patient_budget(p_event uuid,p_quota jsonb)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_policy dental.admin_notification_policy;v_event dental.outbox;v_now timestamptz;v_deadline timestamptz;v_reason text;
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE'; END IF;
 SELECT * INTO STRICT v_policy FROM dental.admin_notification_policy WHERE singleton FOR SHARE;
 v_now:=dental.clock_now();
 IF NOT v_policy.enabled OR v_now<v_policy.activation_at OR v_now>=v_policy.authorized_end_at THEN RETURN false; END IF;
 -- Eligibility is filtered before taking budget/outbox locks or mutating rows.
 IF NOT EXISTS(SELECT FROM dental.outbox o JOIN dental.notification_booking_enrollments e ON e.appointment_id=o.appointment_id
  JOIN dental.appointments a ON a.id=e.appointment_id
  WHERE o.id=p_event AND e.policy_version=v_policy.version AND e.activation_at=v_policy.activation_at AND e.authorized_end_at=v_policy.authorized_end_at
   AND a.created_at>=e.activation_at AND a.created_at<e.authorized_end_at) THEN RETURN false; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dental.admin-budget',0));
 PERFORM epoch FROM dental.admin_notification_budget ORDER BY version DESC LIMIT 1 FOR UPDATE;
 SELECT * INTO v_event FROM dental.outbox WHERE id=p_event FOR UPDATE;
 IF NOT FOUND OR v_event.state NOT IN('queued','leased','retry') THEN RETURN false; END IF;
 v_now:=dental.clock_now();
 v_deadline:=LEAST(v_event.expires_at,v_policy.authorized_end_at,v_event.first_attempt_at+interval '24 hours');
 IF v_now>=v_policy.authorized_end_at THEN RETURN false; END IF;
 IF v_now>=v_deadline OR v_event.attempt_count>=6 THEN
  UPDATE dental.outbox SET state=CASE WHEN attempt_count>0 THEN 'failed' ELSE 'suppressed' END,
   failure_category=CASE WHEN attempt_count>0 THEN 'timeout' ELSE failure_category END,lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=p_event;
  RETURN false;
 END IF;
 IF v_event.state IN('queued','retry') AND v_event.due_at>v_now THEN RETURN false; END IF;
 v_reason:=dental._reserve_notification_budget('patient',p_event,p_quota);
 IF v_reason IS NULL THEN RETURN true; END IF;
 -- The existing patient enum and backoff remain unchanged: a quota pause is a
 -- retry at +15m, without an attempt. If no future authorized slot exists it ends.
 v_now:=dental.clock_now();
 UPDATE dental.outbox SET state=CASE WHEN v_now+interval '15 minutes'>=v_deadline THEN 'suppressed' ELSE 'retry' END,
  due_at=CASE WHEN v_now+interval '15 minutes'<v_deadline THEN v_now+interval '15 minutes' ELSE due_at END,
  failure_category='quota',lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=p_event;
 RETURN false;
END;
$body$;
REVOKE ALL ON FUNCTION dental._reserve_notification_budget(text,uuid,jsonb),dental._reserve_patient_budget(uuid,jsonb) FROM PUBLIC;
CREATE FUNCTION dental._enroll_notification_booking(p dental.appointments)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_policy dental.admin_notification_policy;v_now timestamptz;
BEGIN
 -- reserve calls this only after INSERT, before its existing admin enqueue and
 -- before the submission result/audit commit. A replay returns before this hook.
 SELECT * INTO STRICT v_policy FROM dental.admin_notification_policy WHERE singleton FOR SHARE;
 v_now:=dental.clock_now();
 IF NOT v_policy.enabled OR v_now<v_policy.activation_at OR v_now>=v_policy.authorized_end_at
  OR p.created_at<v_policy.activation_at OR p.created_at>=v_policy.authorized_end_at OR p.created_at>v_now THEN RETURN; END IF;
 INSERT INTO dental.notification_booking_enrollments(appointment_id,policy_version,activation_at,authorized_end_at,enrolled_at)
 VALUES(p.id,v_policy.version,v_policy.activation_at,v_policy.authorized_end_at,v_now);
END;
$body$;
CREATE FUNCTION dental.prepare_patient_dispatch(p_worker uuid,p_event uuid,p_manage_origin text,p_quota jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_date date;v_appointment_id uuid;v_appointment dental.appointments;v_event dental.outbox;
 v_policy dental.admin_notification_policy;v_budget dental.admin_notification_budget;
 v_provider text;v_recipient text;v_reachable boolean;v_now timestamptz;v_deadline timestamptz;
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE'; END IF;
 IF p_worker IS NULL OR p_event IS NULL OR p_manage_origin IS NULL OR pg_catalog.char_length(p_manage_origin)>2048
  OR p_manage_origin!~'^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
 SELECT appointment_date,appointment_id INTO v_date,v_appointment_id FROM dental.outbox WHERE id=p_event;
 IF NOT FOUND THEN RETURN NULL; END IF;
 -- Universal patient order: date -> appointment -> policy -> budget -> outbox -> reachability.
 PERFORM date FROM dental.clinic_dates WHERE date=v_date FOR UPDATE;
 SELECT * INTO v_appointment FROM dental.appointments WHERE id=v_appointment_id FOR UPDATE;
 SELECT * INTO STRICT v_policy FROM dental.admin_notification_policy WHERE singleton FOR SHARE;
 v_now:=dental.clock_now();
 -- No touching legacy/outdated queue rows, even if callers fabricate a lease.
 IF NOT v_policy.enabled OR v_now<v_policy.activation_at OR v_now>=v_policy.authorized_end_at
  OR NOT EXISTS(SELECT FROM dental.notification_booking_enrollments e WHERE e.appointment_id=v_appointment_id
   AND e.policy_version=v_policy.version AND e.activation_at=v_policy.activation_at AND e.authorized_end_at=v_policy.authorized_end_at
   AND v_appointment.created_at>=e.activation_at AND v_appointment.created_at<e.authorized_end_at) THEN RETURN NULL; END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dental.admin-budget',0));
 SELECT * INTO v_budget FROM dental.admin_notification_budget ORDER BY version DESC LIMIT 1 FOR UPDATE;
 SELECT * INTO v_event FROM dental.outbox WHERE id=p_event FOR UPDATE;
 v_now:=dental.clock_now();
 IF v_event.state IS DISTINCT FROM 'leased' OR v_event.lease_owner IS DISTINCT FROM p_worker OR v_event.lease_until<=v_now THEN RETURN NULL; END IF;
 IF v_appointment.id IS NULL OR v_appointment.date IS DISTINCT FROM v_event.appointment_date OR v_appointment.version<>v_event.appointment_version
  OR (v_event.type IN('approval','reminder') AND v_appointment.status<>'approved')
  OR (v_event.type='rejection' AND v_appointment.status<>'rejected') OR (v_event.type='cancellation' AND v_appointment.status<>'cancelled')
  OR v_now>=v_event.expires_at OR v_now<v_event.due_at OR v_now>=v_policy.authorized_end_at
  OR (v_event.type='reminder' AND (v_now<pg_catalog.timezone('Asia/Bangkok',(v_date-1)+time '18:00') OR v_now>=pg_catalog.timezone('Asia/Bangkok',v_date::timestamp))) THEN
  UPDATE dental.outbox SET state='suppressed',lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=p_event;RETURN NULL;
 END IF;
 IF v_event.attempt_count>=6 OR (v_event.first_attempt_at IS NOT NULL AND v_now>=v_event.first_attempt_at+interval '24 hours') THEN
  UPDATE dental.outbox SET state='failed',failure_category='timeout',lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=p_event;RETURN NULL;
 END IF;
 IF EXISTS(SELECT FROM dental.notification_attempts WHERE outbox_id=p_event AND worker_id=p_worker)
  OR EXISTS(SELECT FROM dental.notification_attempts WHERE outbox_id=p_event AND attempt_number=v_event.attempt_count AND finished_at IS NULL) THEN RETURN NULL; END IF;
 IF v_event.dispatch_recipient IS NULL THEN SELECT provider,subject INTO v_provider,v_recipient FROM dental.accounts WHERE id=v_appointment.owner_account_id;
 ELSE v_provider:=v_event.dispatch_provider;v_recipient:=v_event.dispatch_recipient;END IF;
 SELECT reachable INTO v_reachable FROM dental.line_reachability WHERE provider=v_provider AND subject=v_recipient FOR SHARE;
 v_now:=dental.clock_now();
 IF v_event.lease_until<=v_now THEN RETURN NULL; END IF;
 IF v_now>=v_event.expires_at OR v_now>=v_policy.authorized_end_at THEN
  UPDATE dental.outbox SET state='suppressed',lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=p_event;RETURN NULL;
 END IF;
 IF v_event.first_attempt_at IS NOT NULL AND v_now>=v_event.first_attempt_at+interval '24 hours' THEN
  UPDATE dental.outbox SET state='failed',failure_category='timeout',lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=p_event;RETURN NULL;
 END IF;
 IF v_reachable IS DISTINCT FROM true OR v_provider!~'^line:[A-Za-z0-9_-]{1,100}$' OR v_recipient!~'^U[0-9a-f]{32}$'
  OR NOT EXISTS(SELECT FROM dental.accounts WHERE id=v_appointment.owner_account_id AND provider=v_provider AND subject=v_recipient) THEN
  UPDATE dental.outbox SET state='failed',failure_category='recipient_unavailable',lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=p_event;RETURN NULL;
 END IF;
 IF v_event.dispatch_manage_url IS NOT NULL AND v_event.dispatch_manage_url<>p_manage_origin||'/appointments' THEN RETURN NULL; END IF;
 -- A late deadline or attempt-lock wait rolls back credit + attempt + frozen
 -- envelope together. Retain only a validated quota high-water observation.
 BEGIN
  IF NOT dental._reserve_patient_budget(p_event,p_quota) THEN
   IF EXISTS(SELECT FROM dental.outbox WHERE id=p_event AND state='retry' AND failure_category='quota') THEN RETURN pg_catalog.jsonb_build_object('state','paused_quota');END IF;
   RETURN NULL;
  END IF;
  SELECT * INTO STRICT v_budget FROM dental.admin_notification_budget ORDER BY version DESC LIMIT 1;
  v_now:=dental.clock_now();
  v_deadline:=LEAST(v_event.lease_until,v_event.expires_at,COALESCE(v_event.first_attempt_at,v_now)+interval '24 hours',v_policy.authorized_end_at,v_budget.verified_until,(p_quota->>'observedAt')::timestamptz+interval '60 seconds');
  IF v_deadline<=v_now THEN RAISE EXCEPTION USING ERRCODE='DP001',MESSAGE='PATIENT_AUTHORIZATION_CLOSED';END IF;
  IF v_event.dispatch_recipient IS NULL THEN
   UPDATE dental.outbox SET dispatch_provider=v_provider,dispatch_recipient=v_recipient,dispatch_reference=v_appointment.reference,
    dispatch_status=v_appointment.status,dispatch_manage_url=p_manage_origin||'/appointments' WHERE id=p_event;
  END IF;
  UPDATE dental.outbox SET attempt_count=attempt_count+1,first_attempt_at=COALESCE(first_attempt_at,v_now),failure_category=NULL,updated_at=v_now WHERE id=p_event RETURNING * INTO v_event;
  INSERT INTO dental.notification_attempts(outbox_id,attempt_number,worker_id,started_at) VALUES(p_event,v_event.attempt_count,p_worker,v_now);
  INSERT INTO dental.patient_dispatch_authorizations(outbox_id,worker_id,attempt_number,budget_epoch,prepared_at,quota_observed_at,quota_limit,authorization_valid_until)
   VALUES(p_event,p_worker,v_event.attempt_count,v_budget.epoch,v_now,(p_quota->>'observedAt')::timestamptz,(p_quota->>'value')::bigint,v_deadline)
   ON CONFLICT(outbox_id) DO UPDATE SET worker_id=EXCLUDED.worker_id,attempt_number=EXCLUDED.attempt_number,budget_epoch=EXCLUDED.budget_epoch,
    prepared_at=EXCLUDED.prepared_at,quota_observed_at=EXCLUDED.quota_observed_at,quota_limit=EXCLUDED.quota_limit,authorization_valid_until=EXCLUDED.authorization_valid_until;
  v_now:=dental.clock_now();
  IF v_deadline<=v_now THEN RAISE EXCEPTION USING ERRCODE='DP001',MESSAGE='PATIENT_AUTHORIZATION_CLOSED';END IF;
  IF NOT EXISTS(SELECT FROM dental.accounts WHERE id=v_appointment.owner_account_id AND provider=v_provider AND subject=v_recipient) THEN RAISE EXCEPTION USING ERRCODE='DP002',MESSAGE='PATIENT_MAPPING_CHANGED';END IF;
  RETURN pg_catalog.jsonb_build_object('event',dental._outbox_event_json(v_event),'provider',v_event.dispatch_provider,'recipient',v_event.dispatch_recipient,
   'date',pg_catalog.to_char(v_event.appointment_date,'YYYY-MM-DD'),'reference',v_event.dispatch_reference,'status',v_event.dispatch_status,
   'manageUrl',v_event.dispatch_manage_url,'payloadVersion',CASE WHEN v_event.type='cancellation' THEN 2 ELSE 1 END,'preparedAt',v_now,'authorizationExpiresAt',v_deadline);
 EXCEPTION WHEN SQLSTATE 'DP001' OR SQLSTATE 'DP002' THEN
  UPDATE dental.admin_notification_budget SET usage_high_water=GREATEST(usage_high_water,(p_quota->>'totalUsage')::bigint) WHERE epoch=v_budget.epoch;
  v_now:=dental.clock_now();
  IF SQLSTATE='DP002' THEN UPDATE dental.outbox SET state='failed',failure_category='recipient_unavailable',lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=p_event;RETURN NULL;END IF;
  IF v_now>=v_event.expires_at OR v_now>=v_policy.authorized_end_at THEN
   UPDATE dental.outbox SET state='suppressed',lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=p_event;RETURN NULL;
  ELSIF v_now>=v_event.first_attempt_at+interval '24 hours' THEN
   UPDATE dental.outbox SET state='failed',failure_category='timeout',lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=p_event;RETURN NULL;
  ELSIF v_event.lease_until<=v_now THEN RETURN NULL;END IF;
  PERFORM dental._reserve_patient_budget(p_event,NULL);
  IF EXISTS(SELECT FROM dental.outbox WHERE id=p_event AND state='retry' AND failure_category='quota') THEN RETURN pg_catalog.jsonb_build_object('state','paused_quota');END IF;
  RETURN NULL;
 END;
END;
$body$;
CREATE FUNCTION dental.revalidate_patient_dispatch(p_worker uuid,p_event uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_date date;v_appointment_id uuid;v_appointment dental.appointments;v_event dental.outbox;v_policy dental.admin_notification_policy;
 v_budget dental.admin_notification_budget;v_auth dental.patient_dispatch_authorizations;v_now timestamptz;v_reachable boolean;
BEGIN
 IF p_worker IS NULL OR p_event IS NULL THEN RETURN false;END IF;
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE';END IF;
 SELECT appointment_date,appointment_id INTO v_date,v_appointment_id FROM dental.outbox WHERE id=p_event;IF NOT FOUND THEN RETURN false;END IF;
 PERFORM date FROM dental.clinic_dates WHERE date=v_date FOR UPDATE;
 SELECT * INTO v_appointment FROM dental.appointments WHERE id=v_appointment_id FOR UPDATE;
 SELECT * INTO STRICT v_policy FROM dental.admin_notification_policy WHERE singleton FOR SHARE;
 v_now:=dental.clock_now();
 IF NOT v_policy.enabled OR v_now<v_policy.activation_at OR v_now>=v_policy.authorized_end_at
  OR NOT EXISTS(SELECT FROM dental.notification_booking_enrollments e WHERE e.appointment_id=v_appointment_id AND e.policy_version=v_policy.version
   AND e.activation_at=v_policy.activation_at AND e.authorized_end_at=v_policy.authorized_end_at AND v_appointment.created_at>=e.activation_at AND v_appointment.created_at<e.authorized_end_at) THEN RETURN false;END IF;
 PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dental.admin-budget',0));
 SELECT * INTO v_budget FROM dental.admin_notification_budget ORDER BY version DESC LIMIT 1 FOR UPDATE;
 SELECT * INTO v_event FROM dental.outbox WHERE id=p_event FOR UPDATE;
 SELECT * INTO v_auth FROM dental.patient_dispatch_authorizations WHERE outbox_id=p_event;
 SELECT reachable INTO v_reachable FROM dental.line_reachability WHERE provider=v_event.dispatch_provider AND subject=v_event.dispatch_recipient FOR SHARE;
 v_now:=dental.clock_now();
 IF v_event.state IS DISTINCT FROM 'leased' OR v_event.lease_owner IS DISTINCT FROM p_worker OR v_event.lease_until<=v_now OR v_event.due_at>v_now
  OR v_auth.worker_id IS DISTINCT FROM p_worker OR v_auth.attempt_number IS DISTINCT FROM v_event.attempt_count
  OR NOT EXISTS(SELECT FROM dental.notification_attempts WHERE outbox_id=p_event AND worker_id=p_worker AND attempt_number=v_event.attempt_count AND finished_at IS NULL) THEN RETURN false;END IF;
 IF v_appointment.id IS NULL OR v_appointment.date IS DISTINCT FROM v_event.appointment_date OR v_appointment.version<>v_event.appointment_version
  OR (v_event.type IN('approval','reminder') AND v_appointment.status<>'approved') OR (v_event.type='rejection' AND v_appointment.status<>'rejected')
  OR (v_event.type='cancellation' AND v_appointment.status<>'cancelled') OR v_now>=v_event.expires_at OR v_now>=v_policy.authorized_end_at
  OR (v_event.type='reminder' AND (v_now<pg_catalog.timezone('Asia/Bangkok',(v_date-1)+time '18:00') OR v_now>=pg_catalog.timezone('Asia/Bangkok',v_date::timestamp))) THEN
  UPDATE dental.outbox SET state='suppressed',lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=p_event;RETURN false;
 END IF;
 IF v_now>=v_event.first_attempt_at+interval '24 hours' THEN UPDATE dental.outbox SET state='failed',failure_category='timeout',lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=p_event;RETURN false;END IF;
 IF v_reachable IS DISTINCT FROM true OR NOT EXISTS(SELECT FROM dental.accounts WHERE id=v_appointment.owner_account_id AND provider=v_event.dispatch_provider AND subject=v_event.dispatch_recipient) THEN
  UPDATE dental.outbox SET state='failed',failure_category='recipient_unavailable',lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=p_event;RETURN false;
 END IF;
 IF v_budget.epoch IS NULL OR NOT v_budget.no_overage_verified OR v_now<v_budget.verified_from OR v_now>=v_budget.verified_until
  OR v_auth.budget_epoch IS DISTINCT FROM v_budget.epoch OR NOT EXISTS(SELECT FROM dental.patient_notification_budget_reservations WHERE outbox_id=p_event AND budget_epoch=v_budget.epoch)
  OR v_auth.quota_observed_at IS NULL OR v_auth.quota_observed_at>v_now OR v_now-v_auth.quota_observed_at>=interval '60 seconds'
  OR v_auth.quota_limit IS NULL OR GREATEST(v_budget.baseline_usage,v_budget.usage_high_water)+v_budget.reserved_units+v_budget.carried_units>LEAST(300,v_budget.free_limit,v_auth.quota_limit) THEN
  PERFORM dental._reserve_patient_budget(p_event,NULL);
  -- Final quota revocation releases the lease, so finish is intentionally fenced.
  -- Close this existing preparation attempt here; otherwise an unfinished prior
  -- attempt would permanently block the next fresh worker after the quota pause.
  UPDATE dental.notification_attempts SET finished_at=v_now,result='retryable',error_category='quota'
   WHERE outbox_id=p_event AND worker_id=p_worker AND attempt_number=v_event.attempt_count AND finished_at IS NULL;
  RETURN false;
 END IF;
 -- Revalidation never extends the original authorization deadline or lease.
 RETURN v_auth.authorization_valid_until IS NOT NULL AND v_now<v_auth.authorization_valid_until;
END;
$body$;
REVOKE ALL ON FUNCTION dental.prepare_patient_dispatch(uuid,uuid,text,jsonb),dental.revalidate_patient_dispatch(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dental.prepare_patient_dispatch(uuid,uuid,text,jsonb),dental.revalidate_patient_dispatch(uuid,uuid) TO dental_backend;
REVOKE EXECUTE ON FUNCTION dental.claim_events(uuid,integer),dental.prepare_dispatch(uuid,uuid,text),dental.claim_restricted_event(uuid,uuid,uuid),dental.prepare_restricted_dispatch(uuid,uuid,uuid,text) FROM dental_backend;

CREATE FUNCTION dental.claim_patient_event(p_worker uuid)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=''
AS $body$
DECLARE v_policy dental.admin_notification_policy;v_event dental.outbox;v_now timestamptz;
 v_retry_at timestamptz;v_delay integer[]:=ARRAY[1,5,15,60,180];v_i integer;
BEGIN
 IF pg_catalog.current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='UNAVAILABLE'; END IF;
 IF p_worker IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='VALIDATION'; END IF;
 -- Policy first. Never acquire date/appointment/grant/budget locks after outbox.
 SELECT * INTO STRICT v_policy FROM dental.admin_notification_policy WHERE singleton;
 v_now:=dental.clock_now();
 IF NOT v_policy.enabled OR v_now<v_policy.activation_at OR v_now>=v_policy.authorized_end_at THEN RETURN NULL; END IF;
 FOR v_i IN 1..100 LOOP
  -- Filter authorization before touching a row. In particular, expired or retrying
  -- legacy rows must remain byte-identical, rather than being cleaned up here.
  SELECT o.* INTO v_event FROM dental.outbox o
   JOIN dental.notification_booking_enrollments e ON e.appointment_id=o.appointment_id
   JOIN dental.appointments a ON a.id=o.appointment_id
   WHERE e.policy_version=v_policy.version AND e.activation_at=v_policy.activation_at AND e.authorized_end_at=v_policy.authorized_end_at
    AND a.created_at>=e.activation_at AND a.created_at<e.authorized_end_at
    AND ((o.state IN('queued','retry') AND o.due_at<=dental.clock_now()) OR (o.state='leased' AND o.lease_until<=dental.clock_now()))
    AND NOT EXISTS(SELECT FROM dental.notification_attempts t WHERE t.outbox_id=o.id AND t.worker_id=p_worker)
   ORDER BY o.due_at,o.id LIMIT 1 FOR UPDATE OF o SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_now:=dental.clock_now();
  IF v_now<v_policy.activation_at OR v_now>=v_policy.authorized_end_at THEN RETURN NULL; END IF;
  IF v_event.state='leased' THEN
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
  ELSIF v_event.due_at>=LEAST(v_event.expires_at,v_policy.authorized_end_at)
   OR (v_event.first_attempt_at IS NOT NULL AND v_event.due_at>=v_event.first_attempt_at+interval '24 hours') THEN
   UPDATE dental.outbox SET state='failed',failure_category='timeout',lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=v_event.id;
  ELSIF v_event.due_at>v_now THEN
   UPDATE dental.outbox SET state='retry',due_at=v_event.due_at,lease_owner=NULL,lease_until=NULL,updated_at=v_now WHERE id=v_event.id;
  ELSE
   UPDATE dental.outbox SET state='leased',due_at=v_event.due_at,lease_owner=p_worker,
    lease_until=LEAST(v_now+interval '60 seconds',v_event.expires_at,v_policy.authorized_end_at,v_event.first_attempt_at+interval '24 hours'),updated_at=v_now
    WHERE id=v_event.id RETURNING * INTO v_event;
   RETURN dental._outbox_event_json(v_event);
  END IF;
 END LOOP;
 RETURN NULL;
END;
$body$;
REVOKE ALL ON FUNCTION dental._enroll_notification_booking(dental.appointments),dental.claim_patient_event(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dental.claim_patient_event(uuid) TO dental_backend;
$definitions$;
 EXECUTE pg_catalog.replace(v_reserve_definition,v_reserve_source,v_expected_reserve);
 EXECUTE pg_catalog.replace(v_admin_definition,v_admin_source,v_expected_admin);
 EXECUTE pg_catalog.replace(v_budget_definition,v_budget_source,v_expected_budget);
 EXECUTE pg_catalog.replace(v_policy_definition,v_policy_source,v_expected_policy);
 EXECUTE pg_catalog.replace(v_claim_admin_definition,v_claim_admin_source,v_expected_claim_admin);
 EXECUTE pg_catalog.replace(v_prepare_admin_definition,v_prepare_admin_source,v_expected_prepare_admin);
 EXECUTE pg_catalog.replace(v_revalidate_admin_definition,v_revalidate_admin_source,v_expected_revalidate_admin);
 RESET ROLE;
 REVOKE CREATE ON SCHEMA dental FROM dental_function_owner;
 REVOKE dental_function_owner FROM postgres GRANTED BY postgres;
 PERFORM pg_catalog.set_config('lock_timeout',v_original_lock_timeout,true);

 SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid) INTO v_existing_functions_after FROM pg_catalog.pg_proc p
  WHERE pronamespace=v_schema AND p.oid IN(SELECT (item->>'oid')::oid FROM pg_catalog.jsonb_array_elements(v_existing_functions) item);
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
   AND NOT(t.tgisinternal AND EXISTS(SELECT FROM pg_catalog.pg_constraint c WHERE c.oid=t.tgconstraint
    AND c.contype='f' AND c.conrelid IN('dental.notification_booking_enrollments'::regclass,'dental.patient_notification_budget_reservations'::regclass,'dental.patient_dispatch_authorizations'::regclass))))
 ) INTO v_catalog_after;
 IF v_existing_functions IS DISTINCT FROM v_existing_functions_after OR v_memberships IS DISTINCT FROM v_memberships_after
  OR v_defaults IS DISTINCT FROM v_defaults_after OR v_catalog IS DISTINCT FROM v_catalog_after
  OR v_roles IS DISTINCT FROM v_roles_after OR v_role_settings IS DISTINCT FROM v_role_settings_after
  OR CURRENT_USER<>'postgres' OR SESSION_USER<>'postgres' OR pg_catalog.current_setting('role')<>'none'
  OR pg_catalog.current_setting('lock_timeout') IS DISTINCT FROM v_original_lock_timeout THEN
  RAISE EXCEPTION 'Combined notifications changed unrelated catalogs or failed to restore temporary access';
 END IF;
 FOREACH v_new IN ARRAY ARRAY['dental.notification_booking_enrollments'::regclass::oid,'dental.patient_notification_budget_reservations'::regclass::oid] LOOP
 IF NOT EXISTS(SELECT FROM pg_catalog.pg_class WHERE oid=v_new AND relowner=v_postgres AND relrowsecurity AND relforcerowsecurity)
  OR NOT pg_catalog.has_table_privilege(v_owner,v_new,'SELECT') OR NOT pg_catalog.has_table_privilege(v_owner,v_new,'INSERT')
  OR pg_catalog.has_table_privilege(v_owner,v_new,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
  OR pg_catalog.has_any_column_privilege(v_owner,v_new,'UPDATE,REFERENCES')
  OR EXISTS(SELECT FROM pg_catalog.aclexplode((SELECT relacl FROM pg_catalog.pg_class WHERE oid=v_new)) a
   WHERE a.grantee NOT IN(v_postgres,v_owner) OR a.is_grantable AND a.grantee<>v_postgres) THEN
  RAISE EXCEPTION 'Unsafe combined enrollment/budget table ownership, RLS or immutable ACL';
 END IF;
 END LOOP;
 FOR v_function IN SELECT * FROM pg_catalog.pg_proc WHERE oid IN('dental._enroll_notification_booking(dental.appointments)'::regprocedure,'dental.claim_patient_event(uuid)'::regprocedure,'dental._reserve_notification_budget(text,uuid,jsonb)'::regprocedure,'dental._reserve_patient_budget(uuid,jsonb)'::regprocedure,'dental.prepare_patient_dispatch(uuid,uuid,text,jsonb)'::regprocedure,'dental.revalidate_patient_dispatch(uuid,uuid)'::regprocedure) LOOP
  IF v_function.proowner<>v_owner OR NOT v_function.prosecdef OR v_function.proconfig IS DISTINCT FROM ARRAY['search_path=""']::text[]
   OR EXISTS(SELECT FROM pg_catalog.aclexplode(COALESCE(v_function.proacl,pg_catalog.acldefault('f',v_owner))) a
    WHERE a.grantee<>v_owner AND NOT(a.grantee=v_backend AND v_function.proname IN('claim_patient_event','prepare_patient_dispatch','revalidate_patient_dispatch') AND a.grantor=v_owner AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)) THEN
   RAISE EXCEPTION 'Unsafe combined notification function ownership, search path or execute ACL';
  END IF;
 END LOOP;
 -- Verify the exact four revocations against inherited and direct access,
 -- and prohibit every alternative private/table execution path after the writes.
 FOREACH v_new IN ARRAY v_revoked LOOP
  IF pg_catalog.has_function_privilege(v_backend,v_new,'EXECUTE') OR pg_catalog.has_function_privilege(v_runtime,v_new,'EXECUTE') THEN
   RAISE EXCEPTION 'Legacy unbudgeted notification runtime access remains';END IF;END LOOP;
 IF NOT EXISTS(SELECT FROM pg_catalog.pg_class WHERE oid='dental.patient_dispatch_authorizations'::regclass
  AND relowner=v_postgres AND relrowsecurity AND relforcerowsecurity)
  OR NOT pg_catalog.has_table_privilege(v_owner,'dental.patient_dispatch_authorizations','SELECT,INSERT,UPDATE')
  OR pg_catalog.has_table_privilege(v_owner,'dental.patient_dispatch_authorizations','DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
  OR EXISTS(SELECT FROM pg_catalog.aclexplode((SELECT relacl FROM pg_catalog.pg_class WHERE oid='dental.patient_dispatch_authorizations'::regclass)) a
   WHERE a.grantee NOT IN(v_postgres,v_owner) OR a.is_grantable AND a.grantee<>v_postgres) THEN
  RAISE EXCEPTION 'Unsafe private patient authorization metadata access';END IF;
 FOR v_function IN SELECT * FROM pg_catalog.pg_proc WHERE pronamespace=v_schema LOOP
  IF pg_catalog.has_function_privilege(v_runtime,v_function.oid,'EXECUTE') IS DISTINCT FROM pg_catalog.has_function_privilege(v_backend,v_function.oid,'EXECUTE')
   OR (pg_catalog.left(v_function.proname::text,1)='_' AND pg_catalog.has_function_privilege(v_backend,v_function.oid,'EXECUTE')) THEN
   RAISE EXCEPTION 'Combined runtime has an alternate execution path';END IF;END LOOP;
END;
$combined_notifications$;
