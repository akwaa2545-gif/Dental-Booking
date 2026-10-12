-- READ-ONLY. Run via execute_sql only on the verified tooth-talk-staging project.
-- One result row avoids reliance on connector multi-result-set support.
-- No passwords, tokens, filesystem reads, role grants, settings changes or DDL.
SELECT pg_catalog.jsonb_build_object(
  'operator', pg_catalog.jsonb_build_object(
    'effectiveRole', current_user, 'sessionRole', session_user,
    'database', current_database(), 'version', current_setting('server_version'),
    'versionNumber', current_setting('server_version_num'),
    'connectionId', pg_backend_pid(),
    'canCreateSchema', has_database_privilege(current_user, current_database(), 'CREATE'),
    'transactionReadOnly', current_setting('transaction_read_only'),
    'createRoleSelfGrant', current_setting('createrole_self_grant', true),
    'sessionExposedSchemas', current_setting('pgrst.db_schemas', true)
  ),
  'roles', (SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM (
    SELECT rolname, rolcanlogin, rolsuper, rolcreaterole, rolcreatedb,
           rolinherit, rolreplication, rolbypassrls
    FROM pg_catalog.pg_roles
    WHERE rolname IN (current_user, session_user, 'postgres', 'anon',
      'authenticated', 'authenticator', 'service_role',
      'dental_function_owner', 'dental_backend')
    ORDER BY rolname
  ) r),
  -- Full membership graph is intentional: inspect indirect and outgoing paths.
  'memberships', (SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM (
    SELECT parent.rolname AS granted_role, member.rolname AS member_role,
           grantor.rolname AS grantor, m.admin_option,
           to_jsonb(m)->'inherit_option' AS inherit_option,
           to_jsonb(m)->'set_option' AS set_option
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles parent ON parent.oid=m.roleid
    JOIN pg_catalog.pg_roles member ON member.oid=m.member
    JOIN pg_catalog.pg_roles grantor ON grantor.oid=m.grantor
    ORDER BY parent.rolname, member.rolname, grantor.rolname
  ) r),
  'schema', (SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM (
    SELECT n.nspname AS schema_name, r.rolname AS owner,
           n.nspacl::text AS explicit_acl
    FROM pg_catalog.pg_namespace n
    JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner
    WHERE n.nspname='dental'
  ) r),
  'defaults', (SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) FROM (
    SELECT r.rolname AS creator, n.nspname AS schema_name,
           d.defaclobjtype AS object_type, d.defaclacl::text AS defaults
    FROM pg_catalog.pg_default_acl d
    JOIN pg_catalog.pg_roles r ON r.oid=d.defaclrole
    LEFT JOIN pg_catalog.pg_namespace n ON n.oid=d.defaclnamespace
    WHERE r.rolname IN ('postgres','dental_function_owner')
    ORDER BY r.rolname, n.nspname, d.defaclobjtype
  ) r)
) AS capability_probe;
