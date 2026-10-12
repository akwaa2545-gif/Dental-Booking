-- Read-only Task8 migration application PRE/POST; no application content or credentials.
-- Existing 11-table safe metadata projection deliberately omits all new Task8 columns/tables.
-- Compare rowDigests, roles, memberships and prior catalog entries; migration adds approved objects.
SELECT pg_catalog.jsonb_build_object(
      'observedAt', pg_catalog.clock_timestamp(),
      'apiExposureObservation', pg_catalog.jsonb_build_object(
        'sessionSchemaSetting', pg_catalog.current_setting('pgrst.db_schemas',true),
        'databaseRoleSchemaSettings', (SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('role',COALESCE(r.rolname,'ALL'),'database',s.setdatabase,'schemas',pg_catalog.substr(setting,pg_catalog.length('pgrst.db_schemas=')+1))), '[]'::jsonb)
          FROM pg_catalog.pg_db_role_setting s LEFT JOIN pg_catalog.pg_roles r ON r.oid=s.setrole
          CROSS JOIN LATERAL pg_catalog.unnest(s.setconfig) setting WHERE setting LIKE 'pgrst.db_schemas=%'),
        'limitation','SQL-visible values only; service environment/dashboard exposure must also be verified'
      ),
      'task8Objects', pg_catalog.jsonb_build_object(
        'claimRpc',pg_catalog.to_regprocedure('dental.claim_events(uuid,integer)') IS NOT NULL,
        'reachabilityTable',pg_catalog.to_regclass('dental.line_reachability') IS NOT NULL,
        'eventTable',pg_catalog.to_regclass('dental.line_webhook_events') IS NOT NULL,
        'outboxDateColumn',EXISTS(SELECT FROM pg_catalog.pg_attribute WHERE attrelid='dental.outbox'::pg_catalog.regclass AND attname='appointment_date' AND attnum>0 AND NOT attisdropped)
      ),
      'outboxStateCounts', (SELECT COALESCE(pg_catalog.jsonb_object_agg(state,n),'{}'::jsonb) FROM(SELECT state,pg_catalog.count(*) n FROM dental.outbox GROUP BY state) q),
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
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'oid', r.oid, 'name', r.rolname, 'superuser', r.rolsuper, 'inherit', r.rolinherit,
          'createRole', r.rolcreaterole, 'createDatabase', r.rolcreatedb, 'login', r.rolcanlogin,
          'replication', r.rolreplication, 'bypassRls', r.rolbypassrls,
          'connectionLimit', r.rolconnlimit, 'validUntil', r.rolvaliduntil,
          'configIsNull', r.rolconfig IS NULL,
          'roleSettingNames', (SELECT COALESCE(pg_catalog.array_agg(pg_catalog.split_part(setting, '=', 1)
            ORDER BY pg_catalog.split_part(setting, '=', 1)), ARRAY[]::text[]) FROM pg_catalog.unnest(r.rolconfig) setting)
        ) ORDER BY r.oid) FROM pg_catalog.pg_roles r
        WHERE r.rolname IN ('postgres', 'dental_function_owner', 'dental_backend', 'dental_runtime', 'anon', 'authenticated', 'authenticator', 'service_role')
      ),
      'membershipCount', (
        SELECT pg_catalog.count(*) FROM pg_catalog.pg_auth_members m
        WHERE m.roleid IN ('dental_function_owner'::pg_catalog.regrole, 'dental_backend'::pg_catalog.regrole, 'dental_runtime'::pg_catalog.regrole)
          OR m.member IN ('dental_function_owner'::pg_catalog.regrole, 'dental_backend'::pg_catalog.regrole, 'dental_runtime'::pg_catalog.regrole)
      ),
      'memberships', (
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(m) ORDER BY m.roleid, m.member, m.grantor), '[]'::jsonb)
        FROM pg_catalog.pg_auth_members m
        WHERE m.roleid IN ('dental_function_owner'::pg_catalog.regrole, 'dental_backend'::pg_catalog.regrole, 'dental_runtime'::pg_catalog.regrole)
          OR m.member IN ('dental_function_owner'::pg_catalog.regrole, 'dental_backend'::pg_catalog.regrole, 'dental_runtime'::pg_catalog.regrole)
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
          'configSha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.proconfig::text, 'UTF8')), 'hex'), 'definer', p.prosecdef,
          'definitionSha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_functiondef(p.oid), 'UTF8')), 'hex'),
          'runtimeExecute', pg_catalog.has_function_privilege('dental_runtime', p.oid, 'EXECUTE'),
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
          'dental_backend'::pg_catalog.regrole, 'dental_runtime'::pg_catalog.regrole
        )
      ),
      'columnDefaults', (
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'oid', d.oid, 'table', d.adrelid, 'column', d.adnum,
          'expressionSha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_expr(d.adbin, d.adrelid), 'UTF8')), 'hex')
        ) ORDER BY d.oid), '[]'::jsonb)
        FROM pg_catalog.pg_attrdef d JOIN pg_catalog.pg_class c ON c.oid = d.adrelid
        WHERE c.relnamespace = 'dental'::pg_catalog.regnamespace
      ),
      'roleDatabaseSettings', (
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'database', s.setdatabase, 'role', s.setrole,
          'settingNames', (SELECT COALESCE(pg_catalog.array_agg(pg_catalog.split_part(setting, '=', 1)
            ORDER BY pg_catalog.split_part(setting, '=', 1)), ARRAY[]::text[]) FROM pg_catalog.unnest(s.setconfig) setting)
        ) ORDER BY s.setdatabase, s.setrole), '[]'::jsonb) FROM pg_catalog.pg_db_role_setting s
        WHERE s.setrole IN (0, 'postgres'::pg_catalog.regrole, 'dental_function_owner'::pg_catalog.regrole,
          'dental_backend'::pg_catalog.regrole, 'dental_runtime'::pg_catalog.regrole)
      ),
      'triggers', (
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'oid', t.oid, 'table', t.tgrelid, 'enabled', t.tgenabled,
          'definitionSha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_triggerdef(t.oid), 'UTF8')), 'hex')
        ) ORDER BY t.oid), '[]'::jsonb) FROM pg_catalog.pg_trigger t
        JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'dental'::pg_catalog.regnamespace
      ),
      'constraints', (
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'oid', c.oid, 'table', c.conrelid, 'validated', c.convalidated,
          'definitionSha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_constraintdef(c.oid), 'UTF8')), 'hex')
        ) ORDER BY c.oid), '[]'::jsonb) FROM pg_catalog.pg_constraint c WHERE c.connamespace = 'dental'::pg_catalog.regnamespace
      ),
      'indexes', (
        SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'oid', i.indexrelid, 'table', i.indrelid, 'valid', i.indisvalid, 'ready', i.indisready,
          'definitionSha256', pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.pg_get_indexdef(i.indexrelid), 'UTF8')), 'hex')
        ) ORDER BY i.indexrelid), '[]'::jsonb) FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class c ON c.oid = i.indrelid WHERE c.relnamespace = 'dental'::pg_catalog.regnamespace
      ),
      'rowDigests', (
        SELECT pg_catalog.jsonb_object_agg(name, pg_catalog.jsonb_build_object('count', rows, 'sha256', digest)) FROM (
          SELECT 'accounts' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT id, created_at FROM dental.accounts) t) hashed
          UNION ALL
          SELECT 'sessions' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT id, account_id, created_at, expires_at, revoked_at FROM dental.sessions) t) hashed
          UNION ALL
          SELECT 'patients' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT id, owner_account_id, version, created_at, updated_at FROM dental.patients) t) hashed
          UNION ALL
          SELECT 'appointments' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT id, owner_account_id, patient_id, patient_version, date, status, version, created_at, updated_at, approved_at, cancelled_at, cancelled_by FROM dental.appointments) t) hashed
          UNION ALL
          SELECT 'clinic_dates' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT date, intake, changed_by, version, created_at, updated_at FROM dental.clinic_dates) t) hashed
          UNION ALL
          SELECT 'admin_grants' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT id, account_id, granted_at, granted_by, revoked_at, revoked_by FROM dental.admin_grants) t) hashed
          UNION ALL
          SELECT 'audit_events' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT id, actor_account_id, action, patient_id, appointment_id, clinic_date, occurred_at FROM dental.audit_events) t) hashed
          UNION ALL
          SELECT 'outbox' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT id, appointment_id, appointment_version, type, retry_key, due_at, expires_at, state, attempt_count, lease_owner, lease_until, first_attempt_at, accepted_at, created_at, updated_at FROM dental.outbox) t) hashed
          UNION ALL
          SELECT 'notification_attempts' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT id, outbox_id, attempt_number, worker_id, started_at, finished_at, result, error_category FROM dental.notification_attempts) t) hashed
          UNION ALL
          SELECT 'submission_keys' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT owner_account_id, appointment_id, created_at FROM dental.submission_keys) t) hashed
          UNION ALL
          SELECT 'oauth_pending' AS name, pg_catalog.count(*) AS rows,
            pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(COALESCE(pg_catalog.string_agg(row_hash, '' ORDER BY row_hash), ''), 'UTF8')), 'hex') AS digest
          FROM (SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.to_jsonb(t)::text, 'UTF8')), 'hex') AS row_hash FROM (SELECT created_at, expires_at FROM dental.oauth_pending) t) hashed
        ) summaries
      ),
      'schemaAccess', (
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'role', rolname, 'usage', pg_catalog.has_schema_privilege(oid, 'dental', 'USAGE'),
          'create', pg_catalog.has_schema_privilege(oid, 'dental', 'CREATE'),
          'canSetBackend', pg_catalog.pg_has_role(oid, 'dental_backend', 'SET'),
          'canSetOwner', pg_catalog.pg_has_role(oid, 'dental_function_owner', 'SET')
        ) ORDER BY rolname) FROM pg_catalog.pg_roles WHERE rolname IN (
          'postgres', 'dental_function_owner', 'dental_backend', 'dental_runtime', 'anon', 'authenticated', 'authenticator', 'service_role'
        )
      )
    );
