import {readFileSync,existsSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
// Source-contract checks only. Real PostgreSQL behavior remains in tests/db.
const path='db/migrations/003_reservations.sql';
describe('Task 4 migration source safety contract',()=>{
 it('is one atomic guarded statement with cleanup and no runtime login',()=>{
  expect(existsSync(path), 'reviewed Task 4 migration exists').toBe(true);
  const sql=readFileSync(path,'utf8');
  expect(sql).toMatch(/^--[\s\S]*DO \$task4\$/);
  expect(sql).toContain('task4-managed-v1');
  expect(sql).toContain('dental.task4_memberships');
  expect(sql).toContain('REVOKE CREATE ON SCHEMA dental FROM dental_function_owner');
  expect(sql).not.toMatch(/CREATE ROLE|PASSWORD|BYPASSRLS|DISABLE ROW LEVEL SECURITY/);
 });
 it('keeps explicit final block terminators as a consistent source convention',()=>{
  const sql=readFileSync(path,'utf8');
  // PostgreSQL permits these final semicolons to be omitted; this is style only.
  expect(sql).not.toMatch(/\bEND\s*\n\$(?:body|task4)\$/);
 });
 it('serializes key before date and evaluates real time after date lock',()=>{
  expect(existsSync(path), 'reviewed Task 4 migration exists').toBe(true);
  const sql=readFileSync(path,'utf8');
  const reserve=sql.slice(sql.indexOf('CREATE FUNCTION dental.reserve('));
  const key=reserve.indexOf('INSERT INTO dental.submission_keys');
  const date=reserve.indexOf('INSERT INTO dental.clinic_dates');
  const lock=reserve.indexOf('FOR UPDATE;',date);
  const clock=reserve.indexOf('dental.clock_now()',lock);
  expect(key).toBeGreaterThan(0);expect(date).toBeGreaterThan(key);expect(lock).toBeGreaterThan(date);expect(clock).toBeGreaterThan(lock);
  expect(reserve).toContain("status IN ('pending', 'approved')");
 });
 it('preserves postgres defaults and rejects non-owner function defaults before grants',()=>{
  const sql=readFileSync(path,'utf8');
  expect(sql).toContain("set_config('dental.task4_postgres_defaults'");
  expect(sql).toContain("current_setting('dental.task4_postgres_defaults')::jsonb");
  const grants=sql.indexOf('GRANT CREATE ON SCHEMA');
  expect(sql.slice(0,grants)).toContain('Function-owner default privileges are unsafe');
 });
 it('requires exactly the approved version-specific role membership baseline before grants',()=>{
  const sql=readFileSync(path,'utf8');
  const preflight=sql.slice(0,sql.indexOf('GRANT dental_function_owner TO postgres'));
  expect(preflight).toContain('pg_catalog.count(*), pg_catalog.count(DISTINCT roleid)');
  expect(preflight).toContain('v_major = 17 AND (v_membership_count <> 2 OR v_membership_role_count <> 2)');
  expect(preflight).toContain('v_major = 15 AND v_membership_count <> 0');
  expect(preflight).toContain('Unreviewed version-specific membership baseline');
 });
 it('audits exact combined entry points and prevents helper or grant-option exposure',()=>{
  const sql=readFileSync(path,'utf8');
  const audit=sql.slice(sql.indexOf('DO $task4_final_audit$'));
  expect(audit).toContain('v_entry_points oid[]');
  expect(audit.match(/::pg_catalog\.regprocedure::oid/g)).toHaveLength(8);
  expect(audit).toMatch(/pg_catalog\.count\(\*\).*pg_catalog\.pg_proc.*<> 13/);
  expect(audit).toContain('v_function.prosecdef IS DISTINCT FROM (v_function.oid = ANY(v_entry_points))');
  expect(audit).toContain('AND NOT a.is_grantable AND v_function.oid = ANY(v_entry_points)');
  expect(audit).toContain("pg_catalog.has_function_privilege(v_postgres, v_function.oid, 'EXECUTE')");
 });
 it('audits schema, table/column ACLs, exact policies and immutable snapshot protections',()=>{
  const sql=readFileSync(path,'utf8');
  expect(sql).toContain('Unexpected private schema ACL');
  expect(sql).toContain('Unexpected private table ACL');
  expect(sql).toContain('Unexpected private column ACL');
  expect(sql).toContain("ARRAY['anon', 'authenticated', 'authenticator', 'service_role']");
  expect(sql).toContain('expected(table_name, policy_name, command, using_expression, check_expression)');
  expect(sql).toContain('Unexpected private RLS policy definition');
  expect(sql).toContain('Appointment snapshot protections are incomplete');
 });
});
