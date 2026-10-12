import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Appointment, Decision, Intake, Patient, Status } from '../../src/shared/contracts';
import { booking, ReservationFixture } from '../support/reservation-postgres';

let fixture: ReservationFixture;
let adminProjection = false;
let owner: string, admin: string, outsider: string, patient: Patient;
const actors: string[] = [];
const failure = (message: string) => ({ code: 'P0001', message });
const reason = 'Synthetic scheduling review';
const cancel = (appointment: Appointment, actor = owner, version = appointment.version) =>
  fixture.call<Appointment>('select dental.cancel($1,$2,$3) as result', [actor, appointment.id, version]);
const decide = (appointment: Appointment, decision: Decision, actor = admin, version = appointment.version, why: unknown = reason) =>
  fixture.call<Appointment>('select dental.decide($1,$2,$3,$4,$5) as result', [actor, appointment.id, version, decision, why]);
const intake = (date: string, value: Intake, actor = admin, why: unknown = reason) =>
  fixture.call<{ date: string; intake: Intake; unresolved: number }>('select dental.set_intake($1,$2::date,$3,$4) as result', [actor, date, value, why]);
const list = (actor = admin, date: string | null = null, status: Status | null = null) =>
  fixture.call<(Appointment & { notificationAttempts: { kind: string; state: string; attemptCount: number }[] })[]>(
    'select dental.admin_appointments($1,$2::date,$3) as result', [actor, date, status]);
const reserve = (profile = patient, date = '2026-10-09') => fixture.reserve(owner, randomUUID(), booking(profile, date));

beforeAll(async () => {
  fixture = await ReservationFixture.create();
  // The new lane is disabled in these legacy fixtures. Preserve exact response
  // assertions on both reviewed 011 and additive 012, including its empty field.
  adminProjection = (await fixture.control.query("select to_regprocedure('dental._admin_notification_summary(uuid)') is not null as present")).rows[0].present;
  for (const signature of ['cancel(uuid,uuid,integer)', 'decide(uuid,uuid,integer,text,text)', 'set_intake(uuid,date,text,text)', 'admin_appointments(uuid,date,text)', 'set_admin_grant(uuid,uuid,boolean,text)']) {
    const { rows: [{ present }] } = await fixture.control.query('select to_regprocedure($1) is not null as present', [`dental.${signature}`]);
    expect(present, `Separately reviewed Task 7 migration must already be applied: ${signature}`).toBe(true);
  }
});
beforeEach(async () => {
  owner = await fixture.account(); admin = await fixture.account(); outsider = await fixture.account();
  actors.push(owner, admin, outsider);
  patient = await fixture.patient(owner);
  await fixture.control.query('insert into dental.admin_grants(account_id) values($1)', [admin]);
  // Track intake-only and weekend rows so fixture.reset never leaves them behind.
  for (const date of ['2026-10-09', '2026-10-10', '2026-10-12']) await fixture.date(date);
});
afterEach(async () => {
  if (!fixture) return;
  await fixture.control.query('delete from dental.notification_attempts where outbox_id in (select o.id from dental.outbox o join dental.appointments a on a.id=o.appointment_id where a.owner_account_id=any($1::uuid[]))', [actors]);
  await fixture.control.query('delete from dental.outbox where appointment_id in (select id from dental.appointments where owner_account_id=any($1::uuid[]))', [actors]);
  await fixture.control.query('delete from dental.admin_grants where account_id=any($1::uuid[])', [actors]);
  await fixture.reset(); actors.length = 0;
});
afterAll(async () => { await fixture?.close(); });

// These are real, guarded PostgreSQL tests. They never apply migrations and
// cannot use hosted fixtures. Source checks are not substitutes for these runs.
describe('real PostgreSQL reviewed appointment transitions', () => {
  it.each(['approve', 'reject'] as const)('moves pending through %s with audit and a version-bound outbox event', async decision => {
    const appointment = await reserve();
    const result = await decide(appointment, decision);
    expect(result).toMatchObject({ id: appointment.id, status: decision === 'approve' ? 'approved' : 'rejected', version: 2 });
    expect(result.patient).toEqual(appointment.patient);
    expect(result.approvedAt === null).toBe(decision !== 'approve');
    const { rows: events } = await fixture.control.query('select type,appointment_version,state,retry_key from dental.outbox where appointment_id=$1 order by type', [appointment.id]);
    expect(events.map(event => ({ type: event.type, version: event.appointment_version, state: event.state }))).toEqual(decision === 'approve'
      ? [{ type: 'approval', version: 2, state: 'queued' }, { type: 'reminder', version: 2, state: 'queued' }]
      : [{ type: 'rejection', version: 2, state: 'queued' }]);
    expect(new Set(events.map(event => event.retry_key)).size).toBe(events.length);
    const { rows: audits } = await fixture.control.query('select action,actor_account_id,reason from dental.audit_events where appointment_id=$1 and actor_account_id=$2', [appointment.id, admin]);
    expect(audits).toEqual([{ action: decision === 'approve' ? 'appointment_approved' : 'appointment_rejected', actor_account_id: admin, reason }]);
  });

  it('rolls appointment, audit and outbox back together without a provider dependency', async () => {
    const appointment = await reserve();
    const session = await fixture.session();
    try {
      await session.client.query('select dental.decide($1,$2,$3,$4,$5)', [admin, appointment.id, 1, 'approve', reason]);
      await session.client.query('rollback');
    } finally { await fixture.closeSession(session); }
    expect(await fixture.call<Appointment>('select dental.get_appointment($1,$2) as result', [owner, appointment.id])).toEqual(appointment);
    expect((await fixture.control.query('select count(*)::integer as count from dental.outbox where appointment_id=$1', [appointment.id])).rows[0].count).toBe(0);
    expect((await fixture.control.query('select count(*)::integer as count from dental.audit_events where appointment_id=$1 and actor_account_id=$2', [appointment.id, admin])).rows[0].count).toBe(0);
  });

  it.each(['2026-10-08T11:00:00Z', '2026-10-08T16:59:59Z', '2026-10-09T01:29:59.999Z'])('late approval at %s queues confirmation only', async clock => {
    const appointment = await reserve(); await fixture.setClock(clock);
    await decide(appointment, 'approve');
    expect((await fixture.control.query('select type from dental.outbox where appointment_id=$1', [appointment.id])).rows).toEqual([{ type: 'approval' }]);
  });

  it('schedules a pre-cutoff reminder at 18:00 Bangkok with appointment-midnight expiry', async () => {
    await fixture.setClock('2026-10-08T10:59:59.999Z');
    const appointment = await decide(await reserve(), 'approve');
    const { rows: [event] } = await fixture.control.query("select due_at,expires_at from dental.outbox where appointment_id=$1 and type='reminder'", [appointment.id]);
    expect(event.due_at.toISOString()).toBe('2026-10-08T11:00:00.000Z');
    expect(event.expires_at.toISOString()).toBe('2026-10-08T17:00:00.000Z');
  });

  it.each(['2026-10-09T01:30:00Z', '2026-10-12T00:00:00Z'])('refuses stale approval at %s and retains visible pending state', async clock => {
    const appointment = await reserve(); await fixture.setClock(clock);
    await expect(decide(appointment, 'approve')).rejects.toMatchObject(failure('CUTOFF_PASSED'));
    expect(await list(admin, appointment.date, 'pending')).toEqual([{ ...appointment, notificationAttempts: [], ...(adminProjection ? { adminNotificationAttempts: [] } : {}) }]);
  });

  it.each(['complete', 'no_show'] as const)('%s requires approved and waits until exactly 09:30 Bangkok', async decision => {
    const pending = await reserve();
    await expect(decide(pending, decision)).rejects.toMatchObject(failure('INVALID_TRANSITION'));
    const approved = await decide(pending, 'approve');
    await fixture.setClock('2026-10-09T02:29:59.999Z');
    await expect(decide(approved, decision)).rejects.toMatchObject(failure('CUTOFF_PASSED'));
    await fixture.setClock('2026-10-09T02:30:00Z');
    const result = await decide(approved, decision);
    expect(result).toMatchObject({ status: decision === 'complete' ? 'completed' : 'no_show', version: 3 });
    expect(result.approvedAt).toEqual(approved.approvedAt);
    await expect(decide(result, 'approve')).rejects.toMatchObject(failure('INVALID_TRANSITION'));
  });

  it.each(['pending', 'approved'] as const)('cancels %s just before midnight, releases capacity and suppresses leased work', async status => {
    let appointment = await reserve();
    if (status === 'approved') {
      appointment = await decide(appointment, 'approve');
      await fixture.control.query("update dental.outbox set state='leased',lease_owner=$2,lease_until='2026-10-09T00:00:00Z' where appointment_id=$1", [appointment.id, randomUUID()]);
    }
    await fixture.setClock('2026-10-08T16:59:59.999Z');
    const result = await cancel(appointment);
    expect(result).toMatchObject({ id: appointment.id, status: 'cancelled', version: appointment.version + 1 });
    expect(await fixture.count(appointment.date)).toBe(0);
    const { rows: [row] } = await fixture.control.query('select cancelled_at,cancelled_by from dental.appointments where id=$1', [appointment.id]);
    expect(row.cancelled_by).toBe(owner);
    expect(row.cancelled_at.toISOString()).toBe('2026-10-08T16:59:59.999Z');
    expect((await fixture.control.query('select state,lease_owner,lease_until from dental.outbox where appointment_id=$1', [appointment.id])).rows.every(event => event.state === 'suppressed' && event.lease_owner === null && event.lease_until === null)).toBe(true);
  });

  it.each(['pending', 'approved'] as const)('refuses %s self-cancellation at midnight', async status => {
    let appointment = await reserve();
    if (status === 'approved') appointment = await decide(appointment, 'approve');
    await fixture.setClock('2026-10-08T17:00:00Z');
    await expect(cancel(appointment)).rejects.toMatchObject(failure('CUTOFF_PASSED'));
    expect(await fixture.count(appointment.date)).toBe(1);
  });

  it('rejects stale versions and never reopens terminal requests or disguises clinic cancellation as rejection', async () => {
    const pending = await reserve(); const approved = await decide(pending, 'approve');
    await expect(cancel(approved, owner, 1)).rejects.toMatchObject(failure('VERSION_CONFLICT'));
    await expect(decide(approved, 'reject')).rejects.toMatchObject(failure('INVALID_TRANSITION'));
    const cancelled = await cancel(approved);
    await expect(cancel(cancelled)).rejects.toMatchObject(failure('INVALID_TRANSITION'));
    await expect(decide(cancelled, 'approve')).rejects.toMatchObject(failure('INVALID_TRANSITION'));
    expect((await fixture.control.query('select count(*)::integer as count from dental.outbox where appointment_id=$1', [pending.id])).rows[0].count).toBe(2);
  });

  it('hides foreign and missing cancellation targets identically, including from an administrator', async () => {
    const appointment = await reserve();
    for (const actor of [outsider, admin]) for (const id of [appointment.id, randomUUID()]) {
      await expect(cancel({ ...appointment, id }, actor)).rejects.toMatchObject(failure('NOT_FOUND'));
    }
  });

  it('rejects non-admin and immediately revoked admin reads or mutations', async () => {
    const appointment = await reserve();
    for (const actor of [outsider, admin]) {
      if (actor === admin) await fixture.control.query('update dental.admin_grants set revoked_at=clock_timestamp() where account_id=$1', [admin]);
      await expect(list(actor)).rejects.toMatchObject(failure('FORBIDDEN'));
      await expect(decide(appointment, 'approve', actor)).rejects.toMatchObject(failure('FORBIDDEN'));
      await expect(intake(appointment.date, 'paused', actor)).rejects.toMatchObject(failure('FORBIDDEN'));
    }
    for (const action of [() => list(randomUUID()), () => cancel(appointment, randomUUID())]) await expect(action()).rejects.toMatchObject(failure('UNAUTHENTICATED'));
  });

  it.each(['', ' ', '\t\n', null, 'r'.repeat(501)])('rejects invalid audit reasons %j without mutations', async why => {
    const appointment = await reserve();
    await expect(decide(appointment, 'approve', admin, 1, why)).rejects.toMatchObject(failure('VALIDATION'));
    await expect(intake(appointment.date, 'paused', admin, why)).rejects.toMatchObject(failure('VALIDATION'));
    expect(await fixture.count(appointment.date)).toBe(1);
  });

  it('audits every returned appointment, sorts oldest first, and exposes only safe notification summaries', async () => {
    const first = await reserve();
    await fixture.setClock('2026-10-08T05:00:01Z');
    const second = await reserve(await fixture.patient(owner), '2026-10-12');
    const approved = await decide(first, 'approve');
    await fixture.control.query("update dental.outbox set state='failed',attempt_count=6 where appointment_id=$1 and type='approval'", [first.id]);
    const results = await list();
    expect(results.map(row => row.id)).toEqual([first.id, second.id]);
    expect(results[0]).toMatchObject({ ...approved, notificationAttempts: [{ kind: 'approval', state: 'failed', attemptCount: 6 }, { kind: 'reminder', state: 'queued', attemptCount: 0 }] });
    expect(await list(admin, '2026-10-12', 'pending')).toEqual([{ ...second, notificationAttempts: [], ...(adminProjection ? { adminNotificationAttempts: [] } : {}) }]);
    expect(await list(admin, '2026-10-12', 'approved')).toEqual([]);
    const { rows: audit } = await fixture.control.query("select appointment_id,patient_id,reason from dental.audit_events where action='admin_appointments_read' order by appointment_id", []);
    expect(audit).toHaveLength(3);
    expect(audit.every(row => [first.id, second.id].includes(row.appointment_id) && row.patient_id === null && row.reason === null)).toBe(true);
  });

  it('keeps backend direct access and operator grant management denied', async () => {
    await expect(fixture.call('select dental.set_admin_grant($1,$2,true,$3) as result', [admin, outsider, reason])).rejects.toMatchObject({ code: '42501' });
    await expect(fixture.call('select count(*) as result from dental.outbox')).rejects.toMatchObject({ code: '42501' });
    await expect(fixture.call('select count(*) as result from dental.admin_grants')).rejects.toMatchObject({ code: '42501' });
  });

  it('audits empty private searches with safe date/status filters', async () => {
    expect(await list(admin, '2026-10-12', 'pending')).toEqual([]);
    const { rows } = await fixture.control.query("select action,reason,appointment_id,patient_id from dental.audit_events where actor_account_id=$1", [admin]);
    expect(rows).toEqual([{ action: 'admin_appointments_query', reason: 'date=2026-10-12;status=pending', appointment_id: null, patient_id: null }]);
  });

  it('preserves accepted delivery history when cancellation suppresses remaining work', async () => {
    const appointment = await decide(await reserve(), 'approve');
    await fixture.control.query("update dental.outbox set state='accepted',accepted_at='2026-10-08T05:00:00Z',attempt_count=1 where appointment_id=$1 and type='approval'", [appointment.id]);
    await cancel(appointment);
    const { rows } = await fixture.control.query('select type,state,attempt_count,accepted_at from dental.outbox where appointment_id=$1 order by type', [appointment.id]);
    expect(rows[0]).toMatchObject({ type: 'approval', state: 'accepted', attempt_count: 1 });
    expect(rows[0].accepted_at.toISOString()).toBe('2026-10-08T05:00:00.000Z');
    expect(rows[1]).toMatchObject({ type: 'reminder', state: 'suppressed', attempt_count: 0, accepted_at: null });
  });

  it('lets the restricted postgres operator grant and revoke explicitly with actor and reason', async () => {
    await fixture.control.query('set session authorization postgres');
    try {
      for (const granted of [true, false]) {
        const { rows: [{ result }] } = await fixture.control.query('select dental.set_admin_grant($1,$2,$3,$4) as result', [admin, outsider, granted, reason]);
        expect(result).toBe(granted);
      }
    } finally { await fixture.control.query('reset session authorization'); }
    const { rows: [grant] } = await fixture.control.query('select granted_by,revoked_by,revoked_at is not null as revoked from dental.admin_grants where account_id=$1', [outsider]);
    expect(grant).toEqual({ granted_by: admin, revoked_by: admin, revoked: true });
    expect((await fixture.control.query("select action,reason from dental.audit_events where actor_account_id=$1 and action in ('admin_granted','admin_revoked') order by occurred_at,action", [admin])).rows).toEqual([{ action: 'admin_granted', reason }, { action: 'admin_revoked', reason }]);
  });
});
