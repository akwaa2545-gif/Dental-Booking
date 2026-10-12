import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

// Source guards only. The separate disposable PG17 harness exercises contention,
// autocommit rollback, and restoration inside the caller's transaction.
const sql=readFileSync('db/migrations/008_request_limits.sql','utf8');
const applied=sql.replace(/EXECUTE \$definitions\$[\s\S]*?\$definitions\$;/,'');

describe('Task 10 migration lock safety source contract',()=>{
 it('bounds lock waits before the first temporary grant without resetting the active statement timer',()=>{
  const bound="PERFORM pg_catalog.set_config('lock_timeout', '3s', true);";
  expect(sql).toContain(bound);
  expect(sql.indexOf(bound)).toBeLessThan(sql.indexOf('GRANT dental_function_owner TO postgres'));
  expect(sql).toContain("WHERE name = 'statement_timeout') NOT BETWEEN 1 AND 120000");
  expect(sql).not.toMatch(/(?:set_config\('statement_timeout'|SET\s+(?:LOCAL\s+)?statement_timeout)/i);
 });
 it('restores and verifies the inherited lock timeout after the last temporary revoke',()=>{
  const restore="PERFORM pg_catalog.set_config('lock_timeout', v_original_lock_timeout, true);";
  expect(sql).toContain("v_original_lock_timeout text := pg_catalog.current_setting('lock_timeout')");
  expect(sql).toContain(restore);
  expect(sql.indexOf(restore)).toBeGreaterThan(sql.indexOf('REVOKE dental_function_owner FROM postgres GRANTED BY postgres;'));
  expect(sql.indexOf(restore)).toBeLessThan(sql.indexOf('INTO v_memberships_after'));
  expect(sql).toContain("current_setting('lock_timeout') IS DISTINCT FROM v_original_lock_timeout");
 });
 it('remains one standalone atomic DO without assuming a surrounding transaction',()=>{
  expect(applied.match(/^DO \$task10\$/gm)).toHaveLength(1);
  expect(applied.trim()).toMatch(/\$task10\$;$/);
  expect(applied).not.toMatch(/^\s*(?:BEGIN|COMMIT|ROLLBACK|START TRANSACTION)\s*;/gmi);
  expect(applied).toContain('v_normalized_memberships IS DISTINCT FROM v_expected_memberships');
  expect(applied).toContain('v_memberships IS DISTINCT FROM v_memberships_after');
  expect(applied).toContain('v_defaults IS DISTINCT FROM v_defaults_after');
 });
});
