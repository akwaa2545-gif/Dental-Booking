-- LOCAL REVIEW PROPOSAL ONLY; no hosted execution is authorized by this file.
-- Recovered verifier: exact baseline alternatives derived from applied migration 014.
-- Frozen 013 SHA256 d3aa841580ad4293edc3434f5e25579549b5e7412ede63969ae0cb35a2904171.
-- Exact 014 SHA256 60bacfc3d46f9dc6e46816440807b31547bb544e26fa9de757182a5b1b216284.
-- Run on a dedicated, already authorized operator read connection, before/after
-- exact 014, while application writes/senders are quiesced by separately approved
-- operational steps. Do not grant SELECT or change roles to make this run.
-- Output: catalog fingerprints, permission booleans, public role/object names,
-- counts and aggregate lifecycle metadata only. No account/grant/invitation IDs,
-- identity subjects, profile/patient rows, bearer material, matching-code values,
-- credentials, free-text labels/reasons, SQL definitions or message bodies.
-- count(*) inspects relation cardinality; fixed aggregate XML queries allow new
-- tables to be absent before 014. No application function is called. A NULL count
-- means absent, not zero. Permission failure means UNVERIFIED, not zero.
-- Counts establish a preservation checkpoint, not byte-for-byte data equality.
-- File SHA256 and runtime hashes must be checked outside PostgreSQL.
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '3s';
WITH scope(name) AS (VALUES ('current'),('preserved013')),
fingerprints AS (SELECT scope.name, pg_catalog.jsonb_build_object(
 'functions', (select pg_catalog.md5(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('definition',pg_catalog.pg_get_functiondef(p.oid),'owner',pg_catalog.pg_get_userbyid(p.proowner),
   'acl',p.proacl::text,'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,'cost',p.procost,'rows',p.prorows)
   order by p.oid::regprocedure::text collate "C")::text) from pg_catalog.pg_proc p where p.pronamespace='dental'::regnamespace
   and (scope.name='current' or p.proname::text not in ('_admin_management_timestamp','_admin_management_cursor','_admin_management_parse_cursor','_admin_management_is_owner','_admin_management_effective_state','_admin_management_invitation_summary','set_admin_management_owner','admin_management_capabilities','admin_management_roster','admin_management_invitations','admin_management_history','admin_invitation_own_claims','_admin_management_input','_admin_management_membership','_admin_management_accounts','_admin_management_erase_codes','admin_management_create','admin_invitation_claim','admin_management_approve','admin_management_close','admin_management_revoke'))),
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
 ) order by c.relname collate "C")::text) from pg_catalog.pg_class c where c.relnamespace='dental'::regnamespace and c.relkind in('r','v','m','f','p')
  and (scope.name='current' or c.relname::text not in ('admin_invitations','admin_management_owner','admin_management_audit'))),
 'defaults',(select pg_catalog.md5(coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('role',pg_catalog.pg_get_userbyid(d.defaclrole),'schema',coalesce(n.nspname,''),'type',d.defaclobjtype,'acl',d.defaclacl::text)
  order by pg_catalog.pg_get_userbyid(d.defaclrole) collate "C",coalesce(n.nspname,'') collate "C",d.defaclobjtype),'[]'::jsonb)::text)
  from pg_catalog.pg_default_acl d left join pg_catalog.pg_namespace n on n.oid=d.defaclnamespace where d.defaclrole in('postgres'::regrole,'dental_function_owner'::regrole)),
 'schema',(select pg_catalog.md5(pg_catalog.jsonb_build_object('owner',pg_catalog.pg_get_userbyid(nspowner),'acl',nspacl::text)::text) from pg_catalog.pg_namespace where nspname='dental')
) AS value FROM scope),
table_counts AS (
 SELECT c.relname::text AS name,
  ((pg_catalog.xpath('/table/row/rows/text()', pg_catalog.query_to_xml(
   pg_catalog.format('SELECT pg_catalog.count(*) AS rows FROM dental.%I',c.relname),false,false,'')))[1]::text)::bigint AS rows
 FROM pg_catalog.pg_class c WHERE c.relnamespace='dental'::regnamespace AND c.relkind='r'
),
new_table_counts AS (
 SELECT name, (SELECT rows FROM table_counts WHERE table_counts.name=n.name) AS rows
 FROM (VALUES ('admin_invitations'),('admin_management_owner'),('admin_management_audit')) n(name)
),
grant_counts AS (
 SELECT pg_catalog.query_to_xml(
  'SELECT pg_catalog.count(*) AS total, pg_catalog.count(*) FILTER (WHERE revoked_at IS NULL) AS active, pg_catalog.count(*) FILTER (WHERE revoked_at IS NOT NULL) AS revoked FROM dental.admin_grants',
  false,false,'') AS value
),
owner_counts AS (
 SELECT CASE WHEN pg_catalog.to_regclass('dental.admin_management_owner') IS NOT NULL THEN
  pg_catalog.query_to_xml('SELECT pg_catalog.count(*) AS designated, pg_catalog.count(*) FILTER (WHERE EXISTS (SELECT FROM dental.admin_grants g WHERE g.account_id=o.account_id AND g.revoked_at IS NULL)) AS active_designated FROM dental.admin_management_owner o',false,false,'')
 END AS value
),
invitation_counts AS (
 SELECT CASE WHEN pg_catalog.to_regclass('dental.admin_invitations') IS NOT NULL THEN
  pg_catalog.query_to_xml('SELECT pg_catalog.count(*) AS total, pg_catalog.count(*) FILTER (WHERE state IN (''issued'',''claimed'')) AS unfinished, pg_catalog.count(*) FILTER (WHERE state IN (''approved'',''rejected'',''cancelled'',''locked'')) AS terminal, pg_catalog.count(*) FILTER (WHERE state=''locked'') AS locked, pg_catalog.count(*) FILTER (WHERE state IN (''issued'',''claimed'') AND expires_at<=CURRENT_TIMESTAMP) AS expired_unfinished, pg_catalog.count(*) FILTER (WHERE expires_at<>created_at+interval ''24 hours'') AS expiry_duration_violations, pg_catalog.count(*) FILTER (WHERE state IN (''issued'',''claimed'') AND NOT EXISTS (SELECT FROM dental.admin_grants g WHERE g.id=i.issuer_grant_id AND g.account_id=i.issuer_account_id AND g.revoked_at IS NULL)) AS invalidated_unfinished, pg_catalog.count(*) FILTER (WHERE state=''approved'') AS approved FROM dental.admin_invitations i',false,false,'')
 END AS value
),
notification_counts AS (
 SELECT CASE WHEN pg_catalog.to_regclass('dental.admin_notification_policy') IS NOT NULL THEN
  pg_catalog.query_to_xml('SELECT pg_catalog.count(*) AS rows, pg_catalog.count(*) FILTER (WHERE enabled) AS enabled, pg_catalog.min(version) AS min_version, pg_catalog.max(version) AS max_version FROM dental.admin_notification_policy',false,false,'')
 END AS value
),
memberships AS (
 SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
  'role',r.rolname,'member',u.rolname,'grantor',g.rolname,
  'admin',m.admin_option,'inherit',m.inherit_option,'set',m.set_option)
  ORDER BY r.rolname COLLATE "C",u.rolname COLLATE "C",g.rolname COLLATE "C"),'[]'::jsonb) AS value
 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.roleid
 JOIN pg_catalog.pg_roles u ON u.oid=m.member JOIN pg_catalog.pg_roles g ON g.oid=m.grantor
 WHERE m.roleid IN ('dental_function_owner'::regrole,'dental_backend'::regrole,'dental_runtime'::regrole)
  OR m.member IN ('dental_function_owner'::regrole,'dental_backend'::regrole,'dental_runtime'::regrole)
)
SELECT pg_catalog.jsonb_build_object(
 'proposal', 'admin-invitations-verify-v1',
 'readContext', pg_catalog.jsonb_build_object(
  'serverVersionNum', pg_catalog.current_setting('server_version_num'),
  'operatorIsPostgres', CURRENT_USER='postgres' AND SESSION_USER='postgres',
  'noActiveRole', pg_catalog.current_setting('role')='none',
  'transactionReadOnly', pg_catalog.current_setting('transaction_read_only')='on',
  'snapshotIsolation',pg_catalog.current_setting('transaction_isolation'),
  'privateSchemaNotInSessionDataApiList',NOT EXISTS (SELECT FROM pg_catalog.regexp_split_to_table(COALESCE(pg_catalog.current_setting('pgrst.db_schemas',true),''),',') s(name) WHERE pg_catalog.btrim(s.name,' "')='dental')),
 'catalogFingerprints', (SELECT pg_catalog.jsonb_object_agg(name,value) FROM fingerprints),
 'current013MatchesReviewed', (SELECT value FROM fingerprints WHERE name='current') IN (
  '{"schema":"4ae008106c89761f7c6d1788e7cdf716","tables":"aa1389f8ca59101cad612ab44cb147cb","defaults":"4146858b1996fc4459bbe6f4feaddbc3","functions":"33106746d4c95b00c6d9a2deda5ee1d7"}'::jsonb,
  '{"schema":"4ae008106c89761f7c6d1788e7cdf716","tables":"aa1389f8ca59101cad612ab44cb147cb","defaults":"4e67d902862ac6ff8df82cf6c6b75a0e","functions":"33106746d4c95b00c6d9a2deda5ee1d7"}'::jsonb),
 'current014MatchesReviewed', (SELECT value FROM fingerprints WHERE name='current') IN (
  '{"schema":"4ae008106c89761f7c6d1788e7cdf716","tables":"ef5b33f72b16f612071b5efba83f0ce6","defaults":"4146858b1996fc4459bbe6f4feaddbc3","functions":"5600e8b53eecf933b01f286e5f480b5a"}'::jsonb,
  '{"schema":"4ae008106c89761f7c6d1788e7cdf716","tables":"ef5b33f72b16f612071b5efba83f0ce6","defaults":"4e67d902862ac6ff8df82cf6c6b75a0e","functions":"5600e8b53eecf933b01f286e5f480b5a"}'::jsonb),
 'preserved013MatchesReviewed', (SELECT value FROM fingerprints WHERE name='preserved013') IN (
  '{"schema":"4ae008106c89761f7c6d1788e7cdf716","tables":"aa1389f8ca59101cad612ab44cb147cb","defaults":"4146858b1996fc4459bbe6f4feaddbc3","functions":"33106746d4c95b00c6d9a2deda5ee1d7"}'::jsonb,
  '{"schema":"4ae008106c89761f7c6d1788e7cdf716","tables":"aa1389f8ca59101cad612ab44cb147cb","defaults":"4e67d902862ac6ff8df82cf6c6b75a0e","functions":"33106746d4c95b00c6d9a2deda5ee1d7"}'::jsonb),
 'objectCounts',pg_catalog.jsonb_build_object(
  'functions',(SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc WHERE pronamespace='dental'::regnamespace),
  'tables',(SELECT pg_catalog.count(*) FROM table_counts),
  'newFunctions',(SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc WHERE pronamespace='dental'::regnamespace AND proname::text IN ('_admin_management_timestamp','_admin_management_cursor','_admin_management_parse_cursor','_admin_management_is_owner','_admin_management_effective_state','_admin_management_invitation_summary','set_admin_management_owner','admin_management_capabilities','admin_management_roster','admin_management_invitations','admin_management_history','admin_invitation_own_claims','_admin_management_input','_admin_management_membership','_admin_management_accounts','_admin_management_erase_codes','admin_management_create','admin_invitation_claim','admin_management_approve','admin_management_close','admin_management_revoke')),
  'newTables',(SELECT pg_catalog.count(*) FROM new_table_counts WHERE rows IS NOT NULL)),
 'memberships', (SELECT value FROM memberships),
 'runtimeRoles', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
  'name',r.rolname,'superuser',r.rolsuper,'inherit',r.rolinherit,'createRole',r.rolcreaterole,
  'createDatabase',r.rolcreatedb,'login',r.rolcanlogin,'replication',r.rolreplication,
  'bypassRls',r.rolbypassrls,'connectionLimit',r.rolconnlimit,
  'validUntilIsNull',r.rolvaliduntil IS NULL,'configIsNull',r.rolconfig IS NULL,
  'databaseRoleSettingCount',(SELECT pg_catalog.count(*) FROM pg_catalog.pg_db_role_setting WHERE setrole=r.oid))
  ORDER BY r.rolname COLLATE "C") FROM pg_catalog.pg_roles r
  WHERE r.rolname IN ('postgres','supabase_admin','dental_function_owner','dental_backend','dental_runtime')),
 'schemaAccess', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
  'role',r.rolname,'usage',pg_catalog.has_schema_privilege(r.oid,'dental','USAGE'),
  'create',pg_catalog.has_schema_privilege(r.oid,'dental','CREATE'),
  'ownerMember',pg_catalog.pg_has_role(r.oid,'dental_function_owner','MEMBER'),
  'backendMember',pg_catalog.pg_has_role(r.oid,'dental_backend','MEMBER')) ORDER BY r.rolname COLLATE "C")
  FROM pg_catalog.pg_roles r WHERE r.rolname IN ('dental_function_owner','dental_backend','dental_runtime','anon','authenticated','authenticator','service_role')),
 'tableSecurity', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
  'name',c.relname,'owner',pg_catalog.pg_get_userbyid(c.relowner),'rls',c.relrowsecurity,'forcedRls',c.relforcerowsecurity,
  'forbiddenRoleAccessCount',(SELECT pg_catalog.count(*) FROM pg_catalog.pg_roles r
   WHERE r.rolname IN ('dental_backend','dental_runtime','anon','authenticated','authenticator','service_role')
   AND (pg_catalog.has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
    OR pg_catalog.has_any_column_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,REFERENCES'))),
  'publicTableAclCount',(SELECT pg_catalog.count(*) FROM pg_catalog.aclexplode(COALESCE(c.relacl,pg_catalog.acldefault('r',c.relowner))) a WHERE a.grantee=0),
  'publicColumnAclCount',(SELECT pg_catalog.count(*) FROM pg_catalog.pg_attribute a CROSS JOIN LATERAL pg_catalog.aclexplode(a.attacl) x WHERE a.attrelid=c.oid AND x.grantee=0),
  'disabledInternalTriggerCount',(SELECT pg_catalog.count(*) FROM pg_catalog.pg_trigger WHERE tgrelid=c.oid AND tgisinternal AND tgenabled<>'O'))
  ORDER BY c.relname COLLATE "C") FROM pg_catalog.pg_class c WHERE c.relnamespace='dental'::regnamespace AND c.relkind='r'),
 'functionSecurity', (SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
  'signature',p.oid::regprocedure::text,'owner',pg_catalog.pg_get_userbyid(p.proowner),
  'sourceMd5',pg_catalog.md5(p.prosrc),'definitionMd5',pg_catalog.md5(pg_catalog.pg_get_functiondef(p.oid)),
  'securityDefiner',p.prosecdef,'volatility',p.provolatile,'emptySearchPath',p.proconfig=ARRAY['search_path=""']::text[],
  'backendExecute',pg_catalog.has_function_privilege('dental_backend',p.oid,'EXECUTE'),
  'runtimeExecute',pg_catalog.has_function_privilege('dental_runtime',p.oid,'EXECUTE'),
  'operatorExecute',pg_catalog.has_function_privilege('postgres',p.oid,'EXECUTE'),
  'forbiddenApiRoleExecuteCount',(SELECT pg_catalog.count(*) FROM pg_catalog.pg_roles r
   WHERE r.rolname IN ('anon','authenticated','authenticator','service_role') AND pg_catalog.has_function_privilege(r.oid,p.oid,'EXECUTE')),
  'publicOrGrantableAclCount',(SELECT pg_catalog.count(*) FROM pg_catalog.aclexplode(COALESCE(p.proacl,pg_catalog.acldefault('f',p.proowner))) a WHERE a.grantee=0 OR a.is_grantable))
  ORDER BY p.oid::regprocedure::text COLLATE "C") FROM pg_catalog.pg_proc p WHERE p.pronamespace='dental'::regnamespace),
 'allPrivateTableRowCounts',(SELECT pg_catalog.jsonb_object_agg(name,rows) FROM table_counts),
 'newTableRowCounts',(SELECT pg_catalog.jsonb_object_agg(name,rows) FROM new_table_counts),
 'grantCounts',(SELECT pg_catalog.jsonb_build_object(
  'total',(pg_catalog.xpath('/table/row/total/text()',value))[1]::text::bigint,
  'active',(pg_catalog.xpath('/table/row/active/text()',value))[1]::text::bigint,
  'revoked',(pg_catalog.xpath('/table/row/revoked/text()',value))[1]::text::bigint) FROM grant_counts),
 'ownerStatus',(SELECT pg_catalog.jsonb_build_object(
  'designatedCount',(pg_catalog.xpath('/table/row/designated/text()',value))[1]::text::bigint,
  'activeDesignatedCount',(pg_catalog.xpath('/table/row/active_designated/text()',value))[1]::text::bigint) FROM owner_counts),
 'invitationCounts',(SELECT pg_catalog.jsonb_build_object(
  'total',(pg_catalog.xpath('/table/row/total/text()',value))[1]::text::bigint,
  'unfinished',(pg_catalog.xpath('/table/row/unfinished/text()',value))[1]::text::bigint,
  'terminal',(pg_catalog.xpath('/table/row/terminal/text()',value))[1]::text::bigint,
  'locked',(pg_catalog.xpath('/table/row/locked/text()',value))[1]::text::bigint,
  'approved',(pg_catalog.xpath('/table/row/approved/text()',value))[1]::text::bigint,
  'expiredUnfinished',(pg_catalog.xpath('/table/row/expired_unfinished/text()',value))[1]::text::bigint,
  'invalidatedUnfinished',(pg_catalog.xpath('/table/row/invalidated_unfinished/text()',value))[1]::text::bigint,
  'expiryDurationViolations',(pg_catalog.xpath('/table/row/expiry_duration_violations/text()',value))[1]::text::bigint) FROM invitation_counts),
 'notificationPolicyCounts',(SELECT pg_catalog.jsonb_build_object(
  'rows',(pg_catalog.xpath('/table/row/rows/text()',value))[1]::text::bigint,
  'enabled',(pg_catalog.xpath('/table/row/enabled/text()',value))[1]::text::bigint,
  'minVersion',(pg_catalog.xpath('/table/row/min_version/text()',value))[1]::text::integer,
  'maxVersion',(pg_catalog.xpath('/table/row/max_version/text()',value))[1]::text::integer) FROM notification_counts)
) AS verification;
ROLLBACK;
