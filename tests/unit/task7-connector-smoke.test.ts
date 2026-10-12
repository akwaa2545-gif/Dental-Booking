import{existsSync,readFileSync}from'node:fs';
import{createHash}from'node:crypto';
import{describe,it,expect}from'vitest';
const read=(p:string)=>existsSync(p)?readFileSync(p,'utf8'):'';
const sql=read('db/proposals/task7-connector-smoke.sql');
const verify=read('db/proposals/task7-verify-state.sql');
describe('Task7 unexecuted connector source contracts',()=>{
 it('expects the existing backend weekend label',()=>expect(sql).toContain("v_result->0->>'state'='ineligible'"));
 it('keeps the reviewed migration immutable',()=>expect(createHash('sha256').update(read('db/migrations/005_transitions.sql')).digest('hex')).toBe('c4754ceb84c9e6a37642aae93629d1839b187b130dfc36a01063e456ee949589'));
 it('uses one sentinel rollback statement without broad catches or output',()=>{expect(sql).toContain('DO $task7_connector_smoke$');expect(sql).toContain("ERRCODE = 'PT997'");expect(sql).toContain("EXCEPTION WHEN SQLSTATE 'PT997'");expect(sql).toContain('v_before IS DISTINCT FROM v_after');expect(sql).not.toMatch(/WHEN OTHERS|RAISE NOTICE|CREATE OR REPLACE|DROP TABLE/i);});
 it('caps existing timeout, locks empty tables and grants only two temporary memberships',()=>{expect(sql).toContain('NOT BETWEEN 1 AND 120000');expect(sql).toContain("set_config('lock_timeout', '3s', true)");expect(sql).toContain('IN SHARE ROW EXCLUSIVE MODE');expect(sql).toContain('all eleven private tables empty');expect(sql.match(/GRANT dental_\w+ TO postgres/g)).toHaveLength(2);expect(sql).not.toMatch(/GRANT EXECUTE|CREATE ROLE|ALTER ROLE|set_config\('statement_timeout'/i);});
 it('checks real-clock future/past data and all four endpoints with exact manifest',()=>{expect(sql).toContain('pg_catalog.clock_timestamp()');expect(sql).toContain('v_today+7');expect(sql).toContain('v_today-7');for(const n of ['cancel','decide','set_intake','admin_appointments'])expect(sql).toContain(`dental.${n}(`);expect(sql).toContain('v_checks IS DISTINCT FROM v_expected_checks');expect(sql).toContain('synthetic_totals');});
 it('preserves complete independent read-only evidence without role settings values',()=>{expect(verify).toContain('roleSettingsSha256');expect(verify).toContain('definitionSha256');for(const k of ['rows','policies','columnAcls','defaults','memberships','settings'])expect(verify).toContain(`'${k}'`);expect(verify).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|GRANT|SET LOCAL|DO \$)\b/);});
});
