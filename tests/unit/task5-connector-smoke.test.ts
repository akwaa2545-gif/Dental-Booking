import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

// Source safety contracts ONLY: these do not parse or execute PostgreSQL.
const read = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : '';
const sql = read('db/proposals/task5-connector-smoke.sql');
const verify = read('db/proposals/task5-verify-state.sql');
const tables = ['accounts', 'sessions', 'patients', 'appointments', 'clinic_dates', 'admin_grants', 'audit_events', 'outbox', 'notification_attempts', 'submission_keys', 'oauth_pending'];
const createInvalid = ['provider_null', 'provider_invalid', 'provider_overlong', 'subject_null', 'subject_empty', 'subject_control', 'subject_overlong', 'token_raw', 'token_null', 'csrf_raw', 'csrf_null', 'expiry_past', 'expiry_null', 'expiry_infinite', 'expiry_overlong'];
const oauthInvalid = ['state_raw', 'state_null', 'binding_raw', 'binding_null', 'nonce_short', 'nonce_null', 'verifier_short', 'verifier_null', 'path_external', 'path_network', 'path_backslash', 'path_encoded', 'path_space', 'path_null', 'path_overlong', 'expiry_past', 'expiry_null', 'expiry_infinite', 'expiry_overlong'];
const entrypoints = ['create_session', 'resolve_session', 'revoke_session', 'is_admin', 'save_oauth_pending', 'consume_oauth_pending'];
const expected = [
  'session_created_shape', 'session_hashes_persisted', 'session_resolves_exactly',
  'same_provider_subject_reused', 'different_provider_subject_isolated', 'admin_absent_by_default',
  'admin_grant_read_live', 'admin_revocation_read_live', 'session_revoke_immediate',
  'session_revoke_idempotent', 'unknown_session_hidden', 'session_expiry_real_clock',
  'invalid_session_lookup_hidden', 'invalid_session_revoke_noop', 'session_duplicate_hash_atomic',
  ...createInvalid.map(name => `create_invalid_${name}`),
  'oauth_saved_server_held', 'oauth_wrong_binding_preserves', 'oauth_missing_hidden',
  'oauth_duplicate_state_preserves', 'oauth_consume_exact', 'oauth_replay_hidden',
  'oauth_expiry_real_clock', 'oauth_expired_consumed', 'oauth_invalid_lookup_hidden',
  ...oauthInvalid.map(name => `oauth_invalid_${name}`),
  'backend_sessions_read_denied', 'backend_oauth_pending_read_denied',
  'backend_admin_grant_insert_denied', 'backend_session_update_denied',
  'owner_admin_grant_insert_denied', 'owner_session_time_update_denied', 'owner_oauth_update_denied',
  ...['anon', 'authenticated'].flatMap(role => [
    ...['sessions', 'oauth_pending', 'admin_grants'].map(table => `${role}_${table}_read_denied`),
    ...entrypoints.map(name => `${role}_${name}_denied`),
  ]),
  'synthetic_totals',
];

describe('Task 5 connector smoke source safety contract', () => {
  it('uses exactly one rollback-protected invoker DO without DDL, broad catches or sensitive output', () => {
    expect(sql.match(/^DO \$task5_connector_smoke\$/gm)).toHaveLength(1);
    expect(sql.trimEnd()).toMatch(/\$task5_connector_smoke\$;$/);
    expect(sql).toContain("ERRCODE = 'PT995'");
    expect(sql).toContain("EXCEPTION WHEN SQLSTATE 'PT995'");
    expect(sql).toContain("IF NOT v_all_passed OR SQLERRM <> 'Task 5 smoke rollback sentinel' THEN RAISE; END IF");
    expect(sql).not.toMatch(/^\s*(?:COMMIT|ROLLBACK|START TRANSACTION|CREATE|ALTER|DROP)\b/m);
    expect(sql).not.toMatch(/WHEN OTHERS|RAISE (?:NOTICE|LOG|INFO)|PASSWORD|pg_sleep/);
  });
  it('fails closed on managed PG17, active command timeout and quiescent empty eleven-table baseline', () => {
    expect(sql).toContain("WHERE name = 'statement_timeout') NOT BETWEEN 1 AND 120000");
    expect(sql).toContain("current_setting('server_version_num')::integer / 10000 <> 17");
    expect(sql).toContain("current_setting('transaction_isolation') <> 'read committed'");
    expect(sql).toContain("set_config('lock_timeout', '3s', true)");
    expect(sql).not.toMatch(/set_config\('statement_timeout'/);
    const locks = sql.match(/LOCK TABLE ([\s\S]*?)IN SHARE ROW EXCLUSIVE MODE;/)?.[1] ?? '';
    expect(locks.match(/dental\.[a-z_]+/g)?.sort()).toEqual(tables.map(name => `dental.${name}`).sort());
    const guard = sql.indexOf('n.value::bigint <> 0');
    expect(guard).toBeGreaterThan(sql.indexOf('LOCK TABLE dental.accounts'));
    expect(sql.indexOf('GRANT dental_function_owner TO postgres')).toBeGreaterThan(guard);
    expect(sql).toContain("pg_catalog.jsonb_each(v_before -> 'rows')) <> 11");
  });
  it('grants only the two reversible operator SET paths and the one needed helper', () => {
    expect(sql.match(/^\s*GRANT dental_(?:function_owner|backend) TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres;/gm)).toHaveLength(2);
    expect(sql.match(/^\s*GRANT EXECUTE ON FUNCTION .* TO postgres;/gm)?.map(line => line.trim())).toEqual(['GRANT EXECUTE ON FUNCTION dental.clock_now() TO postgres;']);
    expect(sql).toContain("IF NOT pg_catalog.has_function_privilege('postgres', 'dental.clock_now()', 'EXECUTE') THEN");
    expect(sql).not.toMatch(/GRANT .* TO (?:anon|authenticated|service_role)|GRANT .* ON (?:TABLE|SCHEMA)|CREATE(?: OR REPLACE)? FUNCTION/);
  });
  it('pins every ordered named check and invokes all six real entry points', () => {
    const manifest = sql.match(/v_expected_checks constant text\[\] := ARRAY\[([\s\S]*?)\n {2}\];/)?.[1].match(/'[^']+'/g)?.map(value => value.slice(1, -1));
    expect(expected).toHaveLength(84);
    expect(new Set(expected).size).toBe(84);
    expect(manifest).toEqual(expected);
    expect(sql).toContain('v_checks IS DISTINCT FROM v_expected_checks');
    expect(sql).toContain('pg_catalog.cardinality(v_checks) <> 84');
    for (const name of entrypoints) expect(sql).toContain(`dental.${name}(`);
    for (const name of [...createInvalid, ...oauthInvalid]) expect(sql).toContain(`'${name}'`);
  });
  it('tests malformed session lookup against a live control token rather than a revoked one', () => {
    expect(sql).toContain('dental.resolve_session(pg_catalog.upper(v_token3)) IS NOT NULL');
    expect(sql).not.toContain('dental.resolve_session(pg_catalog.upper(v_token1))');
  });
  it('uses real time and expiry fixtures without replacing functions, clock or session authorization', () => {
    expect(sql).toContain("v_now := pg_catalog.clock_timestamp()");
    expect(sql).toContain("SET created_at = v_now - interval '2 hours', expires_at = v_now - interval '1 hour'");
    expect(sql).toContain("SET created_at = v_now - interval '20 minutes', expires_at = v_now - interval '10 minutes'");
    expect(sql).toContain("UPDATE dental.admin_grants SET revoked_at = dental.clock_now()");
    expect(sql).not.toMatch(/SET SESSION AUTHORIZATION|set_config\('dental\.|test_clock|CREATE OR REPLACE/);
    expect(sql).toContain("'SELECT pg_catalog.clock_timestamp()'");
  });
  it('verifies synthetic totals and restores complete security metadata plus every table count', () => {
    for (const key of ['roles', 'memberships', 'schema', 'tables', 'columnAcls', 'functions', 'policies', 'defaults', 'columnDefaults', 'rows']) expect(sql).toContain(`'${key}'`);
    for (const table of tables) expect(sql).toContain(`'${table}', (SELECT pg_catalog.count(*) FROM dental.${table})`);
    expect(sql).toContain("'definition', pg_catalog.pg_get_functiondef(p.oid)");
    expect(sql).toContain('v_before IS DISTINCT FROM v_after');
    expect(sql).toContain('v_original_settings IS DISTINCT FROM v_restored_settings');
    expect(sql).toContain('Smoke rollback left synthetic fixtures behind');
    expect(sql).toContain("'accounts', 2");
    expect(sql).toContain("'sessions', 3");
    expect(sql).toContain("'admin_grants', 1");
    expect(sql).toContain("'oauth_pending', 0");
  });
  it('catches only expected validation, privilege, duplicate or sentinel errors', () => {
    const states = Array.from(sql.matchAll(/EXCEPTION WHEN SQLSTATE '([^']+)'/g), match => match[1]);
    expect(new Set(states)).toEqual(new Set(['P0001', '42501', '23505', 'PT995']));
    expect(sql).toContain("IF SQLERRM <> 'VALIDATION' THEN RAISE; END IF");
    expect(sql).toContain("v_constraint IS DISTINCT FROM 'sessions_token_hash_key'");
    expect(sql).toContain("v_constraint IS DISTINCT FROM 'oauth_pending_pkey'");
  });
  it('provides a read-only pre/post query with ACL, defaults, settings and hashed definitions without row content', () => {
    expect(verify).not.toMatch(/^\s*(?:DO|INSERT|UPDATE|DELETE|GRANT|REVOKE|CREATE|ALTER|DROP)\b/m);
    expect(verify.match(/SELECT pg_catalog.count\(\*\) FROM dental\./g)).toHaveLength(11);
    for (const key of ['roles', 'schema', 'tables', 'columnAcls', 'policies', 'defaults', 'columnDefaults', 'settings', 'definitionSha256', 'operatorExecute', 'canSetOwner', 'name', 'signature']) expect(verify).toContain(`'${key}'`);
    expect(verify).toContain('pg_catalog.pg_get_function_identity_arguments(p.oid)');
    expect(verify).toContain('AS task5_state');
    expect(verify).not.toMatch(/SELECT \* FROM dental|RAISE NOTICE/);
  });
  it('redacts arbitrary role settings from returned evidence while fingerprinting restoration', () => {
    expect(verify).toContain("pg_catalog.to_jsonb(r) - 'rolpassword' - 'rolconfig'");
    expect(verify).toContain("'roleSettingsSha256'");
    expect(verify).toContain("pg_catalog.convert_to(r.rolconfig::text, 'UTF8')");
    expect(sql).toContain("pg_catalog.to_jsonb(r) - 'rolpassword'");
    expect(sql).not.toContain("pg_catalog.to_jsonb(r) - 'rolpassword' - 'rolconfig'");
  });
  it('keeps the separately reviewed migration byte-identical', () => {
    expect(createHash('sha256').update(readFileSync('db/migrations/004_sessions.sql')).digest('hex')).toBe('505dea11ae8a95200afb9e2c21d83176fc88891c583894798fd3c37ffd3f8157');
  });
});
