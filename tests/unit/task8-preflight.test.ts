import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Lexical source-regression checks only. These do not parse/execute PostgreSQL,
// prove privileges, preserve live rows, or replace the independent-client gate.
const migrationPath = 'db/migrations/006_notifications.sql';
const sql = readFileSync(migrationPath, 'utf8');
const appliedSql = sql.replace(/EXECUTE \$definitions\$[\s\S]*?\$definitions\$;/, '');

describe('Task 8 staging migration preflight source contract', () => {
  it('requires a bounded timeout already running before acquiring migration locks', () => {
    expect(sql).toContain("WHERE name = 'statement_timeout') NOT BETWEEN 1 AND 120000");
    expect(sql).not.toMatch(/(?:set_config\('statement_timeout'|SET\s+(?:LOCAL\s+)?statement_timeout)/i);
    expect(sql).toContain("set_config('lock_timeout', '3s', true)");
    expect(sql.indexOf("set_config('lock_timeout', '3s', true)")).toBeLessThan(sql.indexOf('ALTER TABLE dental.outbox'));
    expect(sql).toContain("set_config('lock_timeout', v_original_lock_timeout, true)");
    expect(sql).toContain("current_setting('lock_timeout') IS DISTINCT FROM v_original_lock_timeout");
    expect(sql).toContain("current_setting('transaction_isolation')<>'read committed'");
  });

  it('accepts only the reviewed PG17 runtime role attributes and exact four memberships', () => {
    expect(sql).toContain("v_runtime oid := 'dental_runtime'::pg_catalog.regrole");
    expect(sql).toContain('v_major<>17');
    expect(sql).toContain('rolcanlogin IS DISTINCT FROM (oid=v_runtime)');
    expect(sql).toContain('rolinherit IS DISTINCT FROM (oid=v_runtime)');
    expect(sql).toContain('rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls');
    expect(sql).toContain('rolconnlimit<>-1 OR rolvaliduntil IS NOT NULL OR rolconfig IS NOT NULL');
    expect(sql).toContain('pg_catalog.pg_db_role_setting WHERE setrole IN (v_owner,v_backend,v_runtime)');
    expect(sql).toContain("g.rolname='supabase_admin' AND g.rolsuper");
    expect(sql).toContain('v_normalized_memberships IS DISTINCT FROM v_expected_memberships');
    const manifest = sql.match(/v_expected_memberships jsonb := '([\s\S]*?)'::jsonb;/)?.[1];
    expect(manifest).toBeDefined();
    expect(JSON.parse(manifest ?? 'null')).toEqual([
      { role: 'dental_backend', member: 'dental_runtime', grantor: 'postgres', admin: false, inherit: true, set: false },
      { role: 'dental_backend', member: 'postgres', grantor: 'supabase_admin', admin: true, inherit: false, set: false },
      { role: 'dental_function_owner', member: 'postgres', grantor: 'supabase_admin', admin: true, inherit: false, set: false },
      { role: 'dental_runtime', member: 'postgres', grantor: 'supabase_admin', admin: true, inherit: false, set: false },
    ]);
  });

  it('snapshots every incoming and outgoing private/runtime membership and role setting', () => {
    expect(sql.match(/WHERE m\.roleid IN \(v_owner,v_backend,v_runtime\) OR m\.member IN \(v_owner,v_backend,v_runtime\)/g)).toHaveLength(3);
    expect(sql.match(/to_jsonb\(r\)-'rolpassword'/g)).toHaveLength(2);
    expect(sql).toContain('v_roles IS DISTINCT FROM v_roles_after');
    expect(sql).toContain('v_role_settings IS DISTINCT FROM v_role_settings_after');
    expect(sql).toContain('v_memberships IS DISTINCT FROM v_memberships_after');
    expect(sql).toContain('pg_catalog.pg_has_role(v_runtime,v_owner,\'MEMBER\')');
    expect(sql).toContain("pg_catalog.has_schema_privilege(v_runtime,v_schema,'CREATE')");
    expect(sql).toContain("pg_catalog.has_table_privilege(v_runtime,v_table.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')");
    expect(sql).toContain("pg_catalog.has_any_column_privilege(v_runtime,v_table.oid,'SELECT,INSERT,UPDATE,REFERENCES')");
    expect(sql).toContain("pg_catalog.has_function_privilege(v_runtime,v_function.oid,'EXECUTE') IS DISTINCT FROM pg_catalog.has_function_privilege(v_backend,v_function.oid,'EXECUTE')");
  });

  it('rejects PG17 MAINTAIN access for runtime, backend, browser and private function owner', () => {
    for (const line of sql.split('\n').filter(line => line.includes('has_table_privilege') && line.includes('TRIGGER'))) {
      expect(line).toContain('TRIGGER,MAINTAIN');
    }
    expect(sql).toContain("pg_catalog.has_table_privilege(v_owner,v_table.oid,'MAINTAIN')");
    expect(sql).not.toMatch(/GRANT[^;]*\bMAINTAIN\b/i);
    const schemaTest = readFileSync('tests/db/schema.test.ts', 'utf8');
    expect(schemaTest).toContain("has_table_privilege($1,c.oid,'MAINTAIN')");
    expect(schemaTest).toContain("for(const role of['dental_backend','dental_function_owner','dental_runtime'])");
    expect(schemaTest).toContain("has_table_privilege($1,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')");
  });

  it('preserves existing populated staging rows and backfills only immutable outbox date metadata', () => {
    expect(appliedSql).not.toMatch(/\b(?:DELETE\s+FROM|TRUNCATE|INSERT\s+INTO)\s+dental\./i);
    expect(appliedSql.match(/\bUPDATE\s+dental\./g)).toHaveLength(1);
    expect(appliedSql).toContain('UPDATE dental.outbox o SET appointment_date=a.date FROM dental.appointments a');
    expect(appliedSql).toContain('WHERE a.id=o.appointment_id AND o.appointment_date IS NULL;');
    expect(appliedSql).not.toMatch(/all eleven private tables empty|(?:count\(\*\)|count\(1\))[^;]*dental\.(?:accounts|appointments|admin_grants)[^;]*(?:<>|!=)\s*0/i);
    expect(appliedSql).not.toMatch(/(?:UPDATE|DELETE|TRUNCATE|INSERT)[^;]*dental\.(?:accounts|patients|appointments|admin_grants)\s+(?:SET|VALUES)/i);
  });

  it('rejects unreviewed outbox trigger and rule side effects before its only data write', () => {
    expect(sql).toContain("pg_catalog.pg_trigger WHERE tgrelid='dental.outbox'::pg_catalog.regclass AND NOT tgisinternal");
    expect(sql).toContain("pg_catalog.pg_rewrite WHERE ev_class='dental.outbox'::pg_catalog.regclass");
    const lock = sql.indexOf('LOCK TABLE dental.outbox IN ACCESS EXCLUSIVE MODE;');
    const guard = sql.indexOf('Unreviewed outbox trigger or rewrite rule');
    expect(lock).toBeGreaterThan(sql.indexOf("set_config('lock_timeout', '3s', true)"));
    expect(guard).toBeGreaterThan(lock);
    expect(guard).toBeLessThan(sql.indexOf('UPDATE dental.outbox o'));
  });

  it('grants date backfill access only temporarily to the existing private owner under RLS', () => {
    const grant = sql.indexOf('GRANT UPDATE(appointment_date) ON dental.outbox TO dental_function_owner');
    const backfill = sql.indexOf('UPDATE dental.outbox o SET appointment_date=a.date');
    const revoke = sql.indexOf('REVOKE UPDATE(appointment_date) ON dental.outbox FROM dental_function_owner');
    expect(grant).toBeGreaterThan(0);
    expect(backfill).toBeGreaterThan(grant);
    expect(revoke).toBeGreaterThan(backfill);
    expect(sql.slice(grant, backfill)).toContain('SET LOCAL ROLE dental_function_owner');
    expect(sql.slice(backfill, revoke)).toContain('RESET ROLE');
    expect(sql).toContain('ALTER TABLE dental.outbox ALTER COLUMN appointment_date SET NOT NULL');
    expect(sql).not.toMatch(/(?:DISABLE|NO FORCE) ROW LEVEL SECURITY|SET\s+(?:LOCAL\s+)?row_security\s*=\s*off/i);
  });

  it('does not create or reconfigure runtime credentials or apply business transitions', () => {
    expect(appliedSql).not.toMatch(/\b(?:CREATE|ALTER|DROP)\s+ROLE\b|\bPASSWORD\b|GRANT[^;]*TO dental_runtime|REVOKE[^;]*FROM dental_runtime/i);
    expect(appliedSql).not.toMatch(/(?:PERFORM|SELECT)\s+dental\.(?:decide|cancel|set_admin_grant|claim_events|prepare_dispatch|finish_dispatch|record_line_reachability)\(/i);
    expect(sql.match(/CREATE FUNCTION dental\./g)).toHaveLength(6);
    expect(sql.match(/CREATE POLICY /g)).toHaveLength(8);
    expect(sql).toContain('v_existing_functions IS DISTINCT FROM v_existing_functions_after');
    expect(sql).toContain('v_memberships IS DISTINCT FROM v_memberships_after');
    expect(sql).toContain('v_defaults IS DISTINCT FROM v_defaults_after');
  });

});
