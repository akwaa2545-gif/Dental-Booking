import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => existsSync(path) ? readFileSync(path, 'utf8') : '';
const sql = read('db/proposals/task8-connector-smoke.sql');
const verify = read('db/proposals/task8-verify-state.sql');

// These are source contracts, not PostgreSQL execution or safety proof.
// Removing a gate, widening a grant, or omitting rollback evidence must fail here.
describe('Task 8 unexecuted connector smoke source gates', () => {
  it('uses an exact sentinel and compares complete pre/post state', () => {
    expect(sql).toContain('DO $task8_connector_smoke$');
    expect(sql).toContain("ERRCODE = 'PT998'");
    expect(sql).toContain("EXCEPTION WHEN SQLSTATE 'PT998'");
    expect(sql).toContain('v_before IS DISTINCT FROM v_after');
    expect(sql).toContain('v_checks IS DISTINCT FROM v_expected_checks');
    expect(sql).not.toMatch(/WHEN OTHERS|RAISE NOTICE|CREATE OR REPLACE|\bCOMMIT\s*;/i);
  });
  it('retains locks outside fixture rollback with an inherited deadline', () => {
    expect(sql).toContain('NOT BETWEEN 1 AND 120000');
    expect(sql).toContain("set_config('lock_timeout', '3s', true)");
    expect(sql).toContain('IN SHARE ROW EXCLUSIVE MODE');
    expect(sql.indexOf('LOCK TABLE')).toBeLessThan(sql.indexOf('-- BEGIN SYNTHETIC SUBTRANSACTION'));
    expect(sql.indexOf('LOCK TABLE')).toBeLessThan(sql.indexOf('Unexpected private trigger or rewrite rule'));
    expect(sql.indexOf('LOCK TABLE')).toBeLessThan(sql.indexOf('Require independently verified Task 8 table/function/ownership/RLS surface'));
    expect(sql).toContain("v_guard_deadline := pg_catalog.clock_timestamp() + interval '3 minutes'");
    expect(sql).not.toMatch(/set_config\('statement_timeout'|pg_sleep|ALTER\s+(?:ROLE|SYSTEM)|CREATE\s+ROLE/i);
  });
  it('fails closed before grants or fixtures if global claims might touch existing events', () => {
    expect(sql).toContain("o.state IN ('queued','retry') AND o.due_at <= v_guard_deadline");
    expect(sql).toContain("o.state = 'leased' AND o.lease_until <= v_guard_deadline");
    expect(sql).toContain('Dedicated disposable clone required: existing outbox may become claimable');
    expect(sql.indexOf('Dedicated disposable clone required')).toBeLessThan(sql.indexOf('GRANT dental_backend'));
    expect(sql.indexOf('Dedicated disposable clone required')).toBeLessThan(sql.indexOf('INSERT INTO dental.accounts'));
    expect(sql).toContain("IF pg_catalog.clock_timestamp() >= v_guard_deadline THEN");
    expect(sql).not.toMatch(/all (?:eleven|thirteen).*empty|requires? .*tables? empty|\b(?:DELETE\s+FROM|TRUNCATE\s+(?:TABLE\s+)?dental\.)/i);
  });
  it('requires exact restricted runtime membership and only one temporary operator grant', () => {
    expect(sql).toContain("v_runtime := 'dental_runtime'::pg_catalog.regrole");
    expect(sql).toContain('m.member = v_runtime AND m.roleid = v_backend');
    expect(sql).toContain('m.member IN (v_owner, v_backend, v_runtime)) <> 4');
    expect(sql).toContain("m.grantor = 'supabase_admin'::pg_catalog.regrole");
    expect(sql).toContain('AND m.admin_option AND NOT m.inherit_option AND NOT m.set_option) <> 3');
    expect(sql).toContain('NOT m.admin_option AND m.inherit_option AND NOT m.set_option');
    expect(sql.match(/GRANT dental_\w+ TO postgres/g)).toHaveLength(1);
    expect(sql).toContain('GRANT dental_backend TO postgres WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY postgres');
    expect(sql).not.toMatch(/GRANT EXECUTE|GRANT .*TO dental_runtime|SET (?:LOCAL )?ROLE dental_runtime/i);
  });
  it('rejects PostgreSQL 17 MAINTAIN for runtime/backend and browser/platform roles', () => {
    expect(sql.match(/'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'/g) ?? []).toHaveLength(2);
    expect(sql).not.toContain("'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'");
  });
  it('uses random synthetic namespaces and two checked unused future weekdays', () => {
    expect(sql).toContain("'line:synthetic-task8-' ||");
    expect(sql).toContain("'U' || pg_catalog.replace(v_actor::text");
    expect(sql).toContain('FOR v_offset IN 7..60 LOOP');
    for (const table of ['clinic_dates', 'appointments', 'outbox']) {
      expect(sql).toContain(`NOT EXISTS (SELECT FROM dental.${table}`);
    }
    expect(sql).toContain('pg_catalog.cardinality(v_dates) <> 2');
    expect(sql).toContain('Synthetic Task8');
    expect(sql).toContain("pg_catalog.btrim(p.prosrc) = 'SELECT pg_catalog.clock_timestamp()'");
  });
  it('covers all notification RPCs without a provider call or real recipient', () => {
    for (const name of ['claim_events', 'prepare_dispatch', 'finish_dispatch', 'record_line_reachability']) expect(sql).toContain(`dental.${name}(`);
    for (const check of ['accepted_local_only', 'cancelled_claim_suppressed', 'unreachable_fails_closed', 'retry_backoff', 'duplicate_prepare_denied', 'reachability_ordering']) expect(sql).toContain(`'${check}'`);
    expect(sql).toContain('https://task8.invalid');
    expect(sql).not.toMatch(/api\.line\.me|net\.http|http_post|cron\.schedule|CREATE\s+EXTENSION/i);
  });
  it('keeps read-only verification identical to the internal canonical state query', () => {
    const embedded = sql.split('$state_query$')[1]?.trim();
    const external = verify.slice(verify.indexOf('SELECT ')).replace(/;\s*$/, '').trim();
    expect(embedded).toBeTruthy();
    expect(external).toBe(embedded);
    for (const key of ['rowDigests', 'memberships', 'roleSettingNames', 'definitionSha256', 'triggers', 'constraints', 'indexes']) expect(verify).toContain(`'${key}'`);
    expect(verify).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|GRANT|SET LOCAL|DO \$)\b/);
    expect(verify).toContain("'line_reachability'");
    expect(verify).toContain("'line_webhook_events'");
  });
  it('hashes only allowlisted application metadata and never secrets or identity/patient content', () => {
    expect(verify).not.toMatch(/rolconfig::text|setconfig::text|token_hash|csrf_hash|state_hash|binding_hash|nonce|code_verifier|patient_snapshot|full_name|phone|address|dispatch_recipient|provider_request_id/);
    expect(verify).not.toMatch(/FROM dental\.\w+ t\)/);
    expect(verify).toContain('configIsNull');
    expect(verify).toContain('SELECT id, created_at FROM dental.accounts');
    expect(verify).toContain('SELECT reachable, event_at, updated_at FROM dental.line_reachability');
    expect(sql).toContain("WHERE state IN ('queued','retry','leased')");
    expect(sql).toContain('pre-existing nonterminal outbox work');
  });
});
