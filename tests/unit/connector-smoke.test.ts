import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-contract regression checks only; these do not parse or execute SQL.
const sql = readFileSync('db/proposals/task4-connector-smoke.sql', 'utf8');
const verify = readFileSync('db/proposals/task4-verify-state.sql', 'utf8');
const expected = sql.match(/v_expected_checks constant text\[\] := ARRAY\[([\s\S]*?)\n {2}\];/)?.[1].match(/'[^']+'/g) ?? [];

describe('Task 4 connector smoke source safety contract', () => {
  it('uses one invoker DO with rollback sentinel and no outer transaction control or DDL', () => {
    expect(sql.match(/^DO \$task4_connector_smoke\$/gm)).toHaveLength(1);
    expect(sql.trimEnd()).toMatch(/\$task4_connector_smoke\$;$/);
    expect(sql).not.toMatch(/^\s*(?:COMMIT|ROLLBACK|START TRANSACTION|CREATE|ALTER|DROP)\b/m);
    expect(sql).toContain("ERRCODE = 'PT994'");
    expect(sql).toContain("EXCEPTION WHEN SQLSTATE 'PT994'");
    expect(sql).not.toMatch(/EXCEPTION WHEN OTHERS|RAISE NOTICE|RAISE LOG/);
  });
  it('requires an inherited command timer and bounds lock waits', () => {
    expect(sql).toContain("WHERE name = 'statement_timeout') NOT BETWEEN 1 AND 120000");
    expect(sql).toContain("set_config('lock_timeout', '3s', true)");
    expect(sql).not.toMatch(/set_config\('statement_timeout'/);
    expect(sql).toContain("current_setting('lock_timeout') IS DISTINCT FROM v_original_lock_timeout");
  });
  it('locks and refuses nonempty application data before any privilege or fixture write', () => {
    const lock = sql.indexOf('LOCK TABLE dental.accounts');
    const empty = sql.indexOf('n.value::bigint <> 0');
    const grant = sql.indexOf('GRANT dental_function_owner TO postgres');
    expect(lock).toBeGreaterThan(0);
    expect(empty).toBeGreaterThan(lock);
    expect(grant).toBeGreaterThan(empty);
    expect(sql).toContain('IN SHARE ROW EXCLUSIVE MODE');
    expect(sql).toContain("pg_catalog.jsonb_each(v_before -> 'rows')) <> 10");
  });
  it('contains exactly 44 unique named checks and verifies the ordered completed set', () => {
    expect(expected).toHaveLength(44);
    expect(new Set(expected).size).toBe(44);
    expect(sql).toContain('v_checks IS DISTINCT FROM v_expected_checks');
    expect(sql).toContain('pg_catalog.cardinality(v_checks) <> 44');
  });
  it('restores grants, functions, policies, rows and execution context without replacing the clock', () => {
    expect(sql).toContain("'definition', pg_catalog.pg_get_functiondef(p.oid)");
    expect(sql).toContain('pg_catalog.pg_policy');
    expect(sql).toContain('v_before IS DISTINCT FROM v_after');
    expect(sql).toContain('Smoke rollback left synthetic fixtures behind');
    expect(sql).not.toMatch(/CREATE(?: OR REPLACE)? FUNCTION|CREATE ROLE|PASSWORD/);
    expect(sql).toContain("WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres");
  });
  it('provides a separate read-only verification query covering every table', () => {
    expect(verify).not.toMatch(/^\s*(?:DO|INSERT|UPDATE|DELETE|GRANT|REVOKE|CREATE|ALTER|DROP)\b/m);
    expect(verify.match(/SELECT pg_catalog.count\(\*\) FROM dental\./g)).toHaveLength(10);
    expect(verify).toContain("'definitionSha256'");
    expect(verify).toContain("'operatorExecute'");
    expect(verify).toContain("'canSetOwner'");
  });
});
