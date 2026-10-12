import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source-contract regression checks only; these do not parse or execute SQL.
// Actual time, rollback, authorization and races are covered by tests/db.
const path = 'db/migrations/005_transitions.sql';
const sql = existsSync(path) ? readFileSync(path, 'utf8') : '';
const body = (name: string) => sql.split(`CREATE FUNCTION dental.${name}(`)[1]?.split('$body$;')[0] ?? '';

describe('Task 7 transition migration source contract', () => {
  it('is a guarded atomic candidate preserving prior functions, memberships and defaults', () => {
    expect(sql).toContain('DO $task7$');
    expect(sql.trim()).toMatch(/END;\s*\$task7\$;$/);
    expect(sql).toContain('Unreviewed version-specific membership baseline');
    expect(sql).toContain('v_existing_functions IS DISTINCT FROM v_existing_functions_after');
    expect(sql).toContain('v_memberships IS DISTINCT FROM v_memberships_after');
    expect(sql).toContain('v_defaults IS DISTINCT FROM v_defaults_after');
    expect(sql).toContain('REVOKE CREATE ON SCHEMA dental FROM dental_function_owner');
    expect(sql).not.toMatch(/CREATE ROLE|PASSWORD|DISABLE ROW LEVEL SECURITY|GRANT[^;]*TO (?:anon|authenticated|service_role)/);
  });

  it.each(['cancel', 'decide'])('%s locks date before appointment before outbox and reads the clock after waits', name => {
    const text = body(name);
    const date = text.indexOf('FROM dental.clinic_dates');
    const dateLock = text.indexOf('FOR UPDATE;', date);
    const appointmentLock = text.indexOf('FOR UPDATE;', dateLock + 1);
    const outboxLock = text.indexOf('FOR UPDATE;', appointmentLock + 1);
    const clock = text.lastIndexOf('v_now:=dental.clock_now()');
    expect(date).toBeGreaterThan(0);
    expect(dateLock).toBeGreaterThan(date);
    expect(appointmentLock).toBeGreaterThan(dateLock);
    expect(outboxLock).toBeGreaterThan(appointmentLock);
    expect(clock).toBeGreaterThan(outboxLock);
    expect(text).toContain("current_setting('transaction_isolation')<>'read committed'");
    expect(text).toContain("MESSAGE='VERSION_CONFLICT'");
    expect(text).toContain('INSERT INTO dental.audit_events');
    expect(text).toContain("state IN ('queued','retry','leased')");
  });

  it('rechecks live administration after mutation locks and gates clinic closure on active bookings', () => {
    for (const name of ['decide', 'set_intake']) {
      const text = body(name);
      expect(text.lastIndexOf('dental.is_admin(p_actor)')).toBeGreaterThan(text.lastIndexOf('FOR UPDATE;'));
    }
    expect(body('set_intake')).toContain("status IN ('pending', 'approved')");
    expect(body('set_intake')).toContain("MESSAGE='UNRESOLVED_BOOKINGS'");
    expect(body('set_intake')).not.toContain('UPDATE dental.appointments');
    expect(body('decide')).toContain("time '08:30'");
    expect(body('decide')).toContain("time '09:30'");
    const decision = body('decide');
    const lockedDecision = decision.slice(decision.indexOf('FROM dental.clinic_dates'));
    expect(lockedDecision.indexOf('dental.is_admin(p_actor)')).toBeGreaterThan(lockedDecision.indexOf('FOR UPDATE;'));
    expect(lockedDecision.indexOf('dental.is_admin(p_actor)')).toBeLessThan(lockedDecision.indexOf('v_appointment.version<>p_version'));
  });

  it('creates transactional version-bound approval/rejection events and pre-cutoff reminders', () => {
    const text = body('decide');
    expect(text).toContain('INSERT INTO dental.outbox(appointment_id,appointment_version,type,due_at,expires_at');
    expect(text).toContain("time '18:00'");
    expect(text).toContain('IF v_now<v_reminder THEN');
    expect(text).toContain("'reminder',v_reminder,v_midnight");
    expect(text).toContain("'approval'");
    expect(text).toContain("'rejection'");
  });

  it('returns a scoped, oldest-first admin view and audits access without notification identifiers', () => {
    const text = body('admin_appointments');
    expect(text).toContain('dental.is_admin(p_actor)');
    expect(text).toContain('ORDER BY a.created_at,a.id');
    expect(text).toContain("'notificationAttempts'");
    expect(text).toContain("'kind',o.type,'state',o.state,'attemptCount',o.attempt_count");
    expect(text).toContain("'admin_appointments_read'");
    expect(text).toContain("'admin_appointments_query'");
    expect(text).toContain('ORDER BY date FOR SHARE');
    expect(text.indexOf('FOR SHARE')).toBeLessThan(text.indexOf('dental._appointment_json(a)'));
    expect(text).toContain('a.date=ANY(v_dates)');
    expect(text).not.toMatch(/provider_request_id|retry_key|patient_snapshot|phone|full_name/);
  });

  it('keeps four backend entry points and one operator-only entry point and column-scoped updates with explicit RLS', () => {
    expect(sql.match(/CREATE FUNCTION dental\./g)).toHaveLength(5);
    expect(sql).toContain('GRANT UPDATE(status,version,updated_at,approved_at,cancelled_at,cancelled_by) ON dental.appointments');
    expect(sql).toContain('CREATE POLICY appointments_function_update');
    expect(sql).toContain('CREATE POLICY outbox_function_update');
    expect(sql).toContain('Unsafe new private function ownership, search path or execute ACL');
    expect(sql).toContain('Transition owner access exceeds the reviewed column surface');
    expect(sql).toContain('GRANT EXECUTE ON FUNCTION dental.set_admin_grant(uuid,uuid,boolean,text) TO postgres');
    expect(body('set_admin_grant')).toContain("SESSION_USER<>'postgres'");
    expect(sql).toContain('GRANT UPDATE(revoked_at,revoked_by) ON dental.admin_grants TO dental_function_owner');
  });
});
