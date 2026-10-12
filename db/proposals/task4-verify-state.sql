-- Read-only pre/post smoke evidence for tooth-talk-staging YOUR_SUPABASE_PROJECT_REF.
-- Run in a separate connector call after smoke normal completion OR failure.
-- No patient values, auth subjects, UUIDs, credentials or payloads returned.
SELECT pg_catalog.jsonb_build_object(
  'operator', CURRENT_USER,
  'sessionOperator', SESSION_USER,
  'serverVersion', pg_catalog.current_setting('server_version_num'),
  'statementTimeout', pg_catalog.current_setting('statement_timeout'),
  'tables', (
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', c.relname, 'owner', r.rolname, 'rls', c.relrowsecurity,
      'forcedRls', c.relforcerowsecurity,
      'backendDirect', pg_catalog.has_table_privilege('dental_backend', c.oid, 'SELECT,INSERT,UPDATE,DELETE')
    ) ORDER BY c.relname)
    FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_roles r ON r.oid = c.relowner WHERE n.nspname = 'dental' AND c.relkind = 'r'
  ),
  'functions', (
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'name', p.proname, 'signature', pg_catalog.pg_get_function_identity_arguments(p.oid),
      'owner', r.rolname, 'definer', p.prosecdef, 'settings', p.proconfig,
      'definitionSha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_functiondef(p.oid), 'UTF8')), 'hex'),
      'backendExecute', pg_catalog.has_function_privilege('dental_backend', p.oid, 'EXECUTE'),
      'operatorExecute', pg_catalog.has_function_privilege('postgres', p.oid, 'EXECUTE')
    ) ORDER BY p.proname)
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_catalog.pg_roles r ON r.oid = p.proowner WHERE n.nspname = 'dental'
  ),
  'memberships', (
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'role', parent.rolname, 'member', member.rolname, 'grantor', grantor.rolname,
      'grantorSuper', grantor.rolsuper, 'admin', m.admin_option,
      'set', pg_catalog.to_jsonb(m) -> 'set_option', 'inherit', pg_catalog.to_jsonb(m) -> 'inherit_option'
    ) ORDER BY parent.rolname, member.rolname, grantor.rolname), '[]'::jsonb)
    FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles parent ON parent.oid = m.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = m.member
    JOIN pg_catalog.pg_roles grantor ON grantor.oid = m.grantor
    WHERE parent.rolname IN ('dental_backend', 'dental_function_owner')
      OR member.rolname IN ('dental_backend', 'dental_function_owner')
  ),
  'privateRows', pg_catalog.jsonb_build_object(
    'accounts', (SELECT pg_catalog.count(*) FROM dental.accounts),
    'sessions', (SELECT pg_catalog.count(*) FROM dental.sessions),
    'patients', (SELECT pg_catalog.count(*) FROM dental.patients),
    'appointments', (SELECT pg_catalog.count(*) FROM dental.appointments),
    'clinic_dates', (SELECT pg_catalog.count(*) FROM dental.clinic_dates),
    'admin_grants', (SELECT pg_catalog.count(*) FROM dental.admin_grants),
    'audit_events', (SELECT pg_catalog.count(*) FROM dental.audit_events),
    'outbox', (SELECT pg_catalog.count(*) FROM dental.outbox),
    'notification_attempts', (SELECT pg_catalog.count(*) FROM dental.notification_attempts),
    'submission_keys', (SELECT pg_catalog.count(*) FROM dental.submission_keys)
  ),
  'schemaAccess', (
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
      'role', rolname, 'usage', pg_catalog.has_schema_privilege(oid, 'dental', 'USAGE'),
      'create', pg_catalog.has_schema_privilege(oid, 'dental', 'CREATE'),
      'canSetBackend', pg_catalog.pg_has_role(oid, 'dental_backend', 'SET'),
      'canSetOwner', pg_catalog.pg_has_role(oid, 'dental_function_owner', 'SET')
    ) ORDER BY rolname)
    FROM pg_catalog.pg_roles WHERE rolname IN (
      'postgres', 'dental_function_owner', 'dental_backend', 'anon', 'authenticated', 'authenticator', 'service_role'
    )
  )
) AS task4_state;
