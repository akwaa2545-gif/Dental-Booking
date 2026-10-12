import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const path = 'db/migrations/011_clinic_cancellation.sql';
const sql = existsSync(path) ? readFileSync(path, 'utf8') : '';

describe('bounded clinic-cancellation migration source contract', () => {
  it('is one guarded migration, preserving all original migrations and refusing unreviewed function bodies', () => {
    expect(sql).toContain('DO $clinic_cancellation$');
    expect(sql.trim()).toMatch(/END;\s*\$clinic_cancellation\$;$/);
    expect(sql).toContain('2c835949065d3f189a4004deb88fef1e');
    expect(sql).toContain('e2369f5b77d1a763ba037b7d62b50fb4');
    expect(sql).toContain('5610ec20ad01acf0f86244471daeeec3');
    expect(sql).toContain('v_existing_functions IS DISTINCT FROM v_existing_functions_after');
    expect(sql).toContain('v_catalog IS DISTINCT FROM v_catalog_after');
    expect(sql).not.toMatch(/CREATE ROLE|PASSWORD|DISABLE ROW LEVEL SECURITY|GRANT[^;]*TO (?:anon|authenticated|service_role)/);
  });
  it('has inherited execution and lock bounds and restores every temporary privilege', () => {
    expect(sql).toContain('NOT BETWEEN 1 AND 120000');
    expect(sql).toContain("pg_catalog.set_config('lock_timeout','3s',true)");
    expect(sql).toContain('LOCK TABLE dental.outbox IN ACCESS EXCLUSIVE MODE');
    expect(sql).toContain('v_memberships IS DISTINCT FROM v_memberships_after');
    expect(sql).toContain('v_defaults IS DISTINCT FROM v_defaults_after');
    expect(sql).toContain('v_roles IS DISTINCT FROM v_roles_after');
    expect(sql).toContain('REVOKE CREATE ON SCHEMA dental FROM dental_function_owner');
    expect(sql).toContain('REVOKE dental_function_owner FROM postgres GRANTED BY postgres');
  });
  it('extends only the decision/prepare functions and two reviewed check constraints', () => {
    expect(sql).toContain('outbox_type_check');
    expect(sql).toContain('outbox_frozen_envelope');
    expect(sql).toContain('v_decide_after');
    expect(sql).toContain('v_prepare_after');
    expect(sql).not.toContain('CREATE FUNCTION');
    expect(sql).not.toMatch(/UPDATE dental\.(?:accounts|patients|appointments|admin_grants) SET/);
    expect(sql).not.toContain("'payloadVersion'',2"); // Old dispatch keeps its V1 selection; only cancellation selects V2.
  });
});
