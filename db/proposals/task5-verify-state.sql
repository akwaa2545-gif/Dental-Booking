-- Read-only Task 5 PRE/POST smoke evidence, AFTER approved migration 004.
-- Exact target: tooth-talk-staging YOUR_SUPABASE_PROJECT_REF. No identity, hash, nonce,
-- verifier, patient row, function source or credential values are returned.
-- Compare the complete response before/after normal completion OR failure.
SELECT pg_catalog.jsonb_build_object(
      'settings', (SELECT pg_catalog.jsonb_build_object(
    'currentUser', CURRENT_USER, 'sessionUser', SESSION_USER,
    'role', pg_catalog.current_setting('role'),
    'searchPath', pg_catalog.current_setting('search_path'),
    'statementTimeout', pg_catalog.current_setting('statement_timeout'),
    'lockTimeout', pg_catalog.current_setting('lock_timeout'),
    'transactionIsolation', pg_catalog.current_setting('transaction_isolation'),
    'transactionReadOnly', pg_catalog.current_setting('transaction_read_only')
  )),
      'serverVersion', pg_catalog.current_setting('server_version_num'),
      'roles', (
        SELECT pg_catalog.jsonb_agg(((pg_catalog.to_jsonb(r) - 'rolpassword' - 'rolconfig') || pg_catalog.jsonb_build_object(
          'roleSettingsSha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(r.rolconfig::text, 'UTF8')), 'hex')
        )) ORDER BY r.oid) FROM pg_catalog.pg_roles r
        WHERE r.rolname IN ('postgres', 'dental_function_owner', 'dental_backend', 'anon', 'authenticated', 'authenticator', 'service_role')
      ),
      'membershipCount', (
        SELECT pg_catalog.count(*) FROM pg_catalog.pg_auth_members m
        WHERE m.roleid IN ('dental_function_owner'::pg_catalog.regrole, 'dental_backend'::pg_catalog.regrole)
          OR m.member IN ('dental_function_owner'::pg_catalog.regrole, 'dental_backend'::pg_catalog.regrole)
      ),
      'memberships', (
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY m.roleid, m.member, m.grantor), '[]'::jsonb)
        FROM pg_catalog.pg_auth_members m
        WHERE m.roleid IN ('dental_function_owner'::pg_catalog.regrole, 'dental_backend'::pg_catalog.regrole)
          OR m.member IN ('dental_function_owner'::pg_catalog.regrole, 'dental_backend'::pg_catalog.regrole)
      ),
      'schema', (
        SELECT pg_catalog.jsonb_build_object('oid', n.oid, 'owner', n.nspowner, 'acl', n.nspacl)
        FROM pg_catalog.pg_namespace n WHERE n.nspname = 'dental'
      ),
      'tables', (
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'oid', c.oid, 'name', c.relname, 'owner', c.relowner, 'acl', c.relacl,
          'rls', c.relrowsecurity, 'forcedRls', c.relforcerowsecurity
        ) ORDER BY c.oid) FROM pg_catalog.pg_class c
        WHERE c.relnamespace = 'dental'::pg_catalog.regnamespace AND c.relkind = 'r'
      ),
      'columnAcls', (
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'table', a.attrelid, 'column', a.attnum, 'acl', a.attacl
        ) ORDER BY a.attrelid, a.attnum), '[]'::jsonb)
        FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
        WHERE c.relnamespace = 'dental'::pg_catalog.regnamespace AND a.attnum > 0 AND NOT a.attisdropped
      ),
      'functions', (
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'oid', p.oid, 'name', p.proname, 'signature', pg_catalog.pg_get_function_identity_arguments(p.oid),
          'owner', p.proowner, 'acl', p.proacl,
          'config', p.proconfig, 'definer', p.prosecdef,
          'definitionSha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_functiondef(p.oid), 'UTF8')), 'hex'),
          'backendExecute', pg_catalog.has_function_privilege('dental_backend', p.oid, 'EXECUTE'),
          'operatorExecute', pg_catalog.has_function_privilege('postgres', p.oid, 'EXECUTE')
        ) ORDER BY p.oid) FROM pg_catalog.pg_proc p
        WHERE p.pronamespace = 'dental'::pg_catalog.regnamespace
      ),
      'policies', (
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(p) ORDER BY p.oid), '[]'::jsonb)
        FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
        WHERE c.relnamespace = 'dental'::pg_catalog.regnamespace
      ),
      'defaults', (
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(d) ORDER BY d.oid), '[]'::jsonb)
        FROM pg_catalog.pg_default_acl d WHERE d.defaclrole IN (
          'postgres'::pg_catalog.regrole, 'dental_function_owner'::pg_catalog.regrole,
          'dental_backend'::pg_catalog.regrole
        )
      ),
      'columnDefaults', (
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'oid', d.oid, 'table', d.adrelid, 'column', d.adnum,
          'expression', pg_catalog.pg_get_expr(d.adbin, d.adrelid)
        ) ORDER BY d.oid), '[]'::jsonb)
        FROM pg_catalog.pg_attrdef d JOIN pg_catalog.pg_class c ON c.oid = d.adrelid
        WHERE c.relnamespace = 'dental'::pg_catalog.regnamespace
      ),
      'rows', pg_catalog.jsonb_build_object(
        'accounts', (SELECT pg_catalog.count(*) FROM dental.accounts),
        'sessions', (SELECT pg_catalog.count(*) FROM dental.sessions),
        'patients', (SELECT pg_catalog.count(*) FROM dental.patients),
        'appointments', (SELECT pg_catalog.count(*) FROM dental.appointments),
        'clinic_dates', (SELECT pg_catalog.count(*) FROM dental.clinic_dates),
        'admin_grants', (SELECT pg_catalog.count(*) FROM dental.admin_grants),
        'audit_events', (SELECT pg_catalog.count(*) FROM dental.audit_events),
        'outbox', (SELECT pg_catalog.count(*) FROM dental.outbox),
        'notification_attempts', (SELECT pg_catalog.count(*) FROM dental.notification_attempts),
        'submission_keys', (SELECT pg_catalog.count(*) FROM dental.submission_keys),
        'oauth_pending', (SELECT pg_catalog.count(*) FROM dental.oauth_pending)
      ),
      'schemaAccess', (
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'role', rolname, 'usage', pg_catalog.has_schema_privilege(oid, 'dental', 'USAGE'),
          'create', pg_catalog.has_schema_privilege(oid, 'dental', 'CREATE'),
          'canSetBackend', pg_catalog.pg_has_role(oid, 'dental_backend', 'SET'),
          'canSetOwner', pg_catalog.pg_has_role(oid, 'dental_function_owner', 'SET')
        ) ORDER BY rolname) FROM pg_catalog.pg_roles WHERE rolname IN (
          'postgres', 'dental_function_owner', 'dental_backend', 'anon', 'authenticated', 'authenticator', 'service_role'
        )
      )
    ) AS task5_state;
