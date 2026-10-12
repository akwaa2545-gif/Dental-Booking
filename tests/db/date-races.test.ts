import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Appointment } from '../../src/shared/contracts';
import { booking, ReservationFixture, type BackendSession } from '../support/reservation-postgres';

let fixture: ReservationFixture, owner: string, admin: string;
const actors: string[] = [];
const date = '2026-10-09', reason = 'Synthetic day-off review';
type Outcome = { ok: true; result: unknown } | { ok: false; code: string; sqlState: string };
const failure = (message: string) => ({ code: 'P0001', message });
const decide = (appointment: Appointment, decision: string) => fixture.call<Appointment>('select dental.decide($1,$2,$3,$4,$5) as result', [admin, appointment.id, appointment.version, decision, reason]);
const setIntake = (intake: string, day = date) => fixture.call<{ date: string; intake: string; unresolved: number }>('select dental.set_intake($1,$2::date,$3,$4) as result', [admin, day, intake, reason]);
const reserve = async () => fixture.reserve(owner, randomUUID(), booking(await fixture.patient(owner), date));

beforeAll(async () => { fixture = await ReservationFixture.create(); });
beforeEach(async () => {
  owner = await fixture.account(); admin = await fixture.account(); actors.push(owner, admin);
  await fixture.control.query('insert into dental.admin_grants(account_id) values($1)', [admin]);
  await fixture.date(date); await fixture.date('2026-10-10');
});
afterEach(async () => {
  if (!fixture) return;
  await fixture.control.query('delete from dental.notification_attempts where outbox_id in (select o.id from dental.outbox o join dental.appointments a on a.id=o.appointment_id where a.owner_account_id=any($1::uuid[]))', [actors]);
  await fixture.control.query('delete from dental.outbox where appointment_id in (select id from dental.appointments where owner_account_id=any($1::uuid[]))', [actors]);
  await fixture.control.query('delete from dental.admin_grants where account_id=any($1::uuid[])', [actors]);
  await fixture.reset(); actors.length = 0;
});
afterAll(async () => { await fixture?.close(); });

async function attempt(session: BackendSession, sql: string, values: unknown[]): Promise<Outcome> {
  try {
    const { rows: [{ result }] } = await session.client.query(sql, values);
    await session.client.query('commit');
    return { ok: true, result };
  } catch (error) {
    await session.client.query('rollback');
    if (error instanceof Error && 'code' in error) return { ok: false, code: error.message, sqlState: String(error.code) };
    throw error;
  } finally { await fixture.closeSession(session); }
}

// Each race uses independent pg.Client connections and waits for observed server
// lock contention, rather than relying on sleeping or one pooled connection.
describe('real PostgreSQL date serialization and cutoff races', () => {
  it.each([
    { action: 'cancel', before: '2026-10-08T16:59:59.999Z', after: '2026-10-08T17:00:00Z', status: 'approved' },
    { action: 'approve', before: '2026-10-09T01:29:59.999Z', after: '2026-10-09T01:30:00Z', status: 'pending' },
  ])('$action waiting on a date lock rechecks its Bangkok cutoff', async ({ action, before, after, status }) => {
    let appointment = await reserve();
    if (status === 'approved') appointment = await decide(appointment, 'approve');
    await fixture.setClock(before);
    const locker = await fixture.lockDate(date), session = await fixture.session();
    const pending = action === 'cancel'
      ? attempt(session, 'select dental.cancel($1,$2,$3) as result', [owner, appointment.id, appointment.version])
      : attempt(session, 'select dental.decide($1,$2,$3,$4,$5) as result', [admin, appointment.id, appointment.version, action, reason]);
    try { await fixture.waitForLockWaiters([session.pid]); await fixture.setClock(after); }
    finally { await fixture.unlock(locker); }
    expect(await pending).toEqual({ ok: false, code: 'CUTOFF_PASSED', sqlState: 'P0001' });
    expect(await fixture.call<Appointment>('select dental.get_appointment($1,$2) as result', [owner, appointment.id])).toMatchObject({ status, version: appointment.version });
  });

  it('completion waiting on a date lock uses the new 09:30 time after release', async () => {
    const appointment = await decide(await reserve(), 'approve');
    await fixture.setClock('2026-10-09T02:29:59.999Z');
    const locker = await fixture.lockDate(date), session = await fixture.session();
    const pending = attempt(session, 'select dental.decide($1,$2,$3,$4,$5) as result', [admin, appointment.id, appointment.version, 'complete', reason]);
    try { await fixture.waitForLockWaiters([session.pid]); await fixture.setClock('2026-10-09T02:30:00Z'); }
    finally { await fixture.unlock(locker); }
    expect(await pending).toMatchObject({ ok: true, result: { status: 'completed', version: 3 } });
  });

  it('cancel waiting for an outbox row also rechecks midnight after that later lock', async () => {
    const appointment = await decide(await reserve(), 'approve');
    await fixture.setClock('2026-10-08T16:59:59.999Z');
    const locker = await fixture.session();
    await locker.client.query('reset role');
    await locker.client.query('select id from dental.outbox where appointment_id=$1 order by id for update', [appointment.id]);
    const session = await fixture.session();
    const pending = attempt(session, 'select dental.cancel($1,$2,$3) as result', [owner, appointment.id, appointment.version]);
    try { await fixture.waitForLockWaiters([session.pid], locker.pid); await fixture.setClock('2026-10-08T17:00:00Z'); }
    finally { await fixture.closeSession(locker); }
    expect(await pending).toEqual({ ok: false, code: 'CUTOFF_PASSED', sqlState: 'P0001' });
    expect((await fixture.control.query('select distinct state from dental.outbox where appointment_id=$1', [appointment.id])).rows).toEqual([{ state: 'queued' }]);
  });

  it('conflicting approve, reject and self-cancel change one expected version exactly once', async () => {
    const appointment = await reserve();
    const locker = await fixture.lockDate(date);
    const sessions = await Promise.all([fixture.session(), fixture.session(), fixture.session()]);
    expect(new Set(sessions.map(session => session.pid)).size).toBe(3);
    const attempts = [
      attempt(sessions[0], 'select dental.decide($1,$2,1,$3,$4) as result', [admin, appointment.id, 'approve', reason]),
      attempt(sessions[1], 'select dental.decide($1,$2,1,$3,$4) as result', [admin, appointment.id, 'reject', reason]),
      attempt(sessions[2], 'select dental.cancel($1,$2,1) as result', [owner, appointment.id]),
    ];
    try { await fixture.waitForLockWaiters(sessions.map(session => session.pid)); }
    finally { await fixture.unlock(locker); }
    const results = await Promise.all(attempts);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.filter(result => !result.ok)).toEqual(Array(2).fill({ ok: false, code: 'VERSION_CONFLICT', sqlState: 'P0001' }));
    expect(await fixture.call<Appointment>('select dental.get_appointment($1,$2) as result', [owner, appointment.id])).toMatchObject({ version: 2 });
    expect((await fixture.control.query("select count(*)::integer as count from dental.audit_events where appointment_id=$1 and action<>'appointment_reserved'", [appointment.id])).rows[0].count).toBe(1);
    expect((await fixture.control.query('select count(*)::integer as count from (select appointment_id,appointment_version,type from dental.outbox group by 1,2,3 having count(*)>1) duplicate', [])).rows[0].count).toBe(0);
  });

  it.each(['cancel', 'reject'])('%s racing a new reservation releases capacity atomically', async action => {
    const appointment = await reserve(); await reserve(); await reserve();
    const patient = await fixture.patient(owner), locker = await fixture.lockDate(date);
    const sessions = await Promise.all([fixture.session(), fixture.session()]);
    const release = action === 'cancel'
      ? attempt(sessions[0], 'select dental.cancel($1,$2,1) as result', [owner, appointment.id])
      : attempt(sessions[0], 'select dental.decide($1,$2,1,$3,$4) as result', [admin, appointment.id, 'reject', reason]);
    const create = attempt(sessions[1], 'select dental.reserve($1,$2,$3::jsonb) as result', [owner, randomUUID(), booking(patient, date)]);
    try { await fixture.waitForLockWaiters(sessions.map(session => session.pid)); }
    finally { await fixture.unlock(locker); }
    expect(await release).toMatchObject({ ok: true });
    const outcome = await create;
    if (!outcome.ok) expect(outcome).toEqual({ ok: false, code: 'FULL', sqlState: 'P0001' });
    expect(await fixture.count(date)).toBe(outcome.ok ? 3 : 2);
  });

  it('pause racing reservation either lists the earlier booking as unresolved or refuses intake', async () => {
    const patient = await fixture.patient(owner), locker = await fixture.lockDate(date);
    const sessions = await Promise.all([fixture.session(), fixture.session()]);
    const pause = attempt(sessions[0], 'select dental.set_intake($1,$2::date,$3,$4) as result', [admin, date, 'paused', reason]);
    const create = attempt(sessions[1], 'select dental.reserve($1,$2,$3::jsonb) as result', [owner, randomUUID(), booking(patient, date)]);
    try { await fixture.waitForLockWaiters(sessions.map(session => session.pid)); }
    finally { await fixture.unlock(locker); }
    const result = await create;
    expect(await pause).toEqual({ ok: true, result: { date, intake: 'paused', unresolved: result.ok ? 1 : 0 } });
    if (!result.ok) expect(result).toEqual({ ok: false, code: 'INTAKE_CLOSED', sqlState: 'P0001' });
    const unresolved = await fixture.call<Appointment[]>('select dental.admin_appointments($1,$2::date,$3) as result', [admin, date, 'pending']);
    expect(unresolved).toHaveLength(result.ok ? 1 : 0);
  });

  it('paused dates refuse approval but allow explicit rejection and owner cancellation before closure', async () => {
    const pending = await reserve(), approved = await decide(await reserve(), 'approve');
    expect(await setIntake('paused')).toEqual({ date, intake: 'paused', unresolved: 2 });
    await expect(decide(pending, 'approve')).rejects.toMatchObject(failure('INTAKE_CLOSED'));
    await expect(setIntake('closed')).rejects.toMatchObject(failure('UNRESOLVED_BOOKINGS'));
    await decide(pending, 'reject');
    await expect(setIntake('closed')).rejects.toMatchObject(failure('UNRESOLVED_BOOKINGS'));
    await fixture.call('select dental.cancel($1,$2,$3) as result', [owner, approved.id, approved.version]);
    expect(await setIntake('closed')).toEqual({ date, intake: 'closed', unresolved: 0 });
    expect((await fixture.control.query('select status from dental.appointments order by id')).rows.map(row => row.status).sort()).toEqual(['cancelled', 'rejected']);
  });

  it('closing an open date with active bookings never silently pauses or changes statuses', async () => {
    const appointment = await reserve();
    await expect(setIntake('closed')).rejects.toMatchObject(failure('UNRESOLVED_BOOKINGS'));
    expect((await fixture.control.query('select intake from dental.clinic_dates where date=$1::date', [date])).rows[0].intake).toBe('open');
    expect(await fixture.call<Appointment>('select dental.get_appointment($1,$2) as result', [owner, appointment.id])).toEqual(appointment);
  });

  it('explicit weekend reopening still cannot enable weekend booking', async () => {
    const weekend = '2026-10-10'; await setIntake('closed', weekend); await setIntake('open', weekend);
    expect(await fixture.availability(weekend, weekend)).toEqual([{ date: weekend, state: 'ineligible' }]);
    const patient = await fixture.patient(owner);
    await expect(fixture.reserve(owner, randomUUID(), booking(patient, weekend))).rejects.toMatchObject(failure('INELIGIBLE_DATE'));
  });

  it.each(['decide', 'set_intake'])('%s rechecks revocation committed while waiting for a date lock', async action => {
    const appointment = await reserve(), locker = await fixture.lockDate(date), session = await fixture.session();
    const pending = action === 'decide'
      ? attempt(session, 'select dental.decide($1,$2,1,$3,$4) as result', [admin, appointment.id, 'approve', reason])
      : attempt(session, 'select dental.set_intake($1,$2::date,$3,$4) as result', [admin, date, 'paused', reason]);
    try {
      await fixture.waitForLockWaiters([session.pid]);
      await fixture.control.query('update dental.admin_grants set revoked_at=clock_timestamp() where account_id=$1', [admin]);
    } finally { await fixture.unlock(locker); }
    expect(await pending).toEqual({ ok: false, code: 'FORBIDDEN', sqlState: 'P0001' });
    expect((await fixture.control.query('select intake from dental.clinic_dates where date=$1::date', [date])).rows[0].intake).toBe('open');
    expect(await fixture.call<Appointment>('select dental.get_appointment($1,$2) as result', [owner, appointment.id])).toEqual(appointment);
  });

  it('revocation during the date wait hides a concurrent version or status change', async () => {
    const appointment = await reserve(), locker = await fixture.lockDate(date), session = await fixture.session();
    const pending = attempt(session, 'select dental.decide($1,$2,1,$3,$4) as result', [admin, appointment.id, 'reject', reason]);
    try {
      await fixture.waitForLockWaiters([session.pid]);
      await locker.query("update dental.appointments set status='approved',version=2,approved_at='2026-10-08T05:00:00Z' where id=$1", [appointment.id]);
      await fixture.control.query('update dental.admin_grants set revoked_at=clock_timestamp() where account_id=$1', [admin]);
    } finally { await fixture.unlock(locker, 'commit'); }
    expect(await pending).toEqual({ ok: false, code: 'FORBIDDEN', sqlState: 'P0001' });
  });
});
