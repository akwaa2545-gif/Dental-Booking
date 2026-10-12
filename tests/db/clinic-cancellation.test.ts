import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Appointment } from '../../src/shared/contracts';
import { booking, ReservationFixture, type BackendSession } from '../support/reservation-postgres';

type Event = { id: string; appointmentId: string; appointmentVersion: number; type: string; retryKey: string; dueAt: string; expiresAt: string };
type Prepared = { event: Event; recipient: string; date: string; reference: string; status: string; manageUrl: string; payloadVersion: number };
type Outcome = { ok: true; result: Appointment } | { ok: false; code: string; sqlState: string };
const day = '2026-10-09', provider = 'line:1234567890', origin = 'https://clinic.example';
const reason = 'Synthetic clinic emergency';
const actors: string[] = [];
let fixture: ReservationFixture, owner: string, admin: string, outsider: string;
const subjectOf = (id: string) => `U${id.replaceAll('-', '')}`;
const failure = (message: string) => ({ code: 'P0001', message });
const reserve = async () => fixture.reserve(owner, randomUUID(), booking(await fixture.patient(owner), day));
const decide = (appointment: Appointment, decision = 'cancel', actor = admin, why: unknown = reason) => fixture.call<Appointment>(
  'select dental.decide($1,$2,$3,$4,$5) as result', [actor, appointment.id, appointment.version, decision, why]);
const approve = async () => decide(await reserve(), 'approve');
const patientCancel = (appointment: Appointment, actor = owner) => fixture.call<Appointment>(
  'select dental.cancel($1,$2,$3) as result', [actor, appointment.id, appointment.version]);
const claim = (worker: string) => fixture.call<Event[]>('select dental.claim_events($1,10) as result', [worker]);
const prepare = (worker: string, event: Event, manageOrigin = origin) => fixture.call<Prepared | null>(
  'select dental.prepare_dispatch($1,$2,$3) as result', [worker, event.id, manageOrigin]);
const finish = (worker: string, event: Event, result: unknown) => fixture.call<boolean>(
  'select dental.finish_dispatch($1,$2,$3::jsonb) as result', [worker, event.id, result]);
const events = async (id: string) => (await fixture.control.query('select * from dental.outbox where appointment_id=$1 order by type', [id])).rows;
const current = (appointment: Appointment) => fixture.call<Appointment>('select dental.get_appointment($1,$2) as result', [owner, appointment.id]);
async function attempt(session: BackendSession, appointment: Appointment): Promise<Outcome> {
  try {
    const { rows: [{ result }] } = await session.client.query('select dental.decide($1,$2,$3,$4,$5) as result', [admin, appointment.id, appointment.version, 'cancel', reason]);
    await session.client.query('commit'); return { ok: true, result };
  } catch (error) {
    await session.client.query('rollback');
    if (error instanceof Error && 'code' in error) return { ok: false, code: error.message, sqlState: String(error.code) };
    throw error;
  }
}

// Real independent PG clients against a separately provisioned disposable local
// cluster. These tests never apply a migration or contact a messaging provider.
describe('clinic-approved appointment cancellation in PostgreSQL', () => {
  beforeAll(async () => { fixture = await ReservationFixture.create(); });
  beforeEach(async () => {
    owner = await fixture.account(); admin = await fixture.account(); outsider = await fixture.account();
    actors.push(owner, admin, outsider);
    await fixture.control.query('insert into dental.admin_grants(account_id) values($1)', [admin]);
    await fixture.control.query('update dental.accounts set provider=$2,subject=$3 where id=$1', [owner, provider, subjectOf(owner)]);
    await fixture.call('select dental.record_line_reachability($1,$2,$3,$4::timestamptz,true) as result',
      [provider, subjectOf(owner), `01${randomUUID().replaceAll('-', '').slice(0, 24).toUpperCase()}`, '2026-10-08T04:59:59Z']);
  });
  afterEach(async () => {
    if (!fixture) return;
    await fixture.control.query('delete from dental.notification_attempts where outbox_id in (select o.id from dental.outbox o join dental.appointments a on a.id=o.appointment_id where a.owner_account_id=any($1::uuid[]))', [actors]);
    await fixture.control.query('delete from dental.outbox where appointment_id in (select id from dental.appointments where owner_account_id=any($1::uuid[]))', [actors]);
    await fixture.control.query('delete from dental.line_webhook_events where subject=any($1::text[])', [actors.map(subjectOf)]);
    await fixture.control.query('delete from dental.line_reachability where subject=any($1::text[])', [actors.map(subjectOf)]);
    await fixture.control.query('delete from dental.admin_grants where account_id=any($1::uuid[])', [actors]);
    await fixture.reset(); actors.length = 0;
  });
  afterAll(async () => { await fixture?.close(); });

  it('atomically records clinic cancellation, releases capacity, and queues one 24-hour version-bound notice', async () => {
    const appointment = await approve();
    const cancelled = await decide(appointment, 'cancel', admin, `  ${reason}  `);
    expect(cancelled).toMatchObject({ id: appointment.id, status: 'cancelled', version: 3, approvedAt: appointment.approvedAt });
    expect(await fixture.count(day)).toBe(0);
    const { rows: [row] } = await fixture.control.query('select cancelled_by,cancelled_at from dental.appointments where id=$1', [appointment.id]);
    expect(row.cancelled_by).toBe(admin);
    expect(row.cancelled_at.toISOString()).toBe('2026-10-08T05:00:00.000Z');
    expect((await fixture.control.query("select action,actor_account_id,reason from dental.audit_events where appointment_id=$1 and action='appointment_cancelled'", [appointment.id])).rows)
      .toEqual([{ action: 'appointment_cancelled', actor_account_id: admin, reason }]);
    const rows = await events(appointment.id);
    expect(rows.map(row => ({ type: row.type, version: row.appointment_version, state: row.state }))).toEqual([
      { type: 'approval', version: 2, state: 'suppressed' }, { type: 'cancellation', version: 3, state: 'queued' }, { type: 'reminder', version: 2, state: 'suppressed' },
    ]);
    expect(rows[1].due_at.toISOString()).toBe('2026-10-08T05:00:00.000Z');
    expect(rows[1].expires_at.toISOString()).toBe('2026-10-09T05:00:00.000Z');
    expect(new Set(rows.map(row => row.retry_key)).size).toBe(3);
    const next = await reserve(); expect(next.status).toBe('pending');
  });

  it.each(['2026-10-08T17:00:00Z', '2026-10-09T02:31:00Z'])('permits clinic emergency cancellation at %s while patient cutoff stays enforced', async now => {
    const appointment = await approve(); await fixture.setClock(now);
    await expect(patientCancel(appointment)).rejects.toMatchObject(failure('CUTOFF_PASSED'));
    expect(await decide(appointment)).toMatchObject({ status: 'cancelled', version: 3 });
    expect((await events(appointment.id)).find(row => row.type === 'cancellation').expires_at.getTime()).toBe(Date.parse(now) + 86_400_000);
  });

  it.each(['pending', 'rejected', 'cancelled', 'completed', 'no_show'])('refuses clinic cancellation from %s', async status => {
    let appointment = await reserve();
    if (status === 'rejected') appointment = await decide(appointment, 'reject');
    if (['cancelled', 'completed', 'no_show'].includes(status)) {
      appointment = await decide(appointment, 'approve');
      if (status === 'cancelled') appointment = await patientCancel(appointment);
      else { await fixture.setClock('2026-10-09T02:30:00Z'); appointment = await decide(appointment, status === 'completed' ? 'complete' : 'no_show'); }
    }
    await expect(decide(appointment)).rejects.toMatchObject(failure('INVALID_TRANSITION'));
    expect((await events(appointment.id)).filter(row => row.type === 'cancellation')).toHaveLength(0);
  });

  it.each(['', ' ', '\t\n\u2000', null, 'x'.repeat(501)])('requires a nonempty bounded clinic audit reason: %j', async why => {
    const appointment = await approve();
    await expect(decide(appointment, 'cancel', admin, why)).rejects.toMatchObject(failure('VALIDATION'));
    expect(await current(appointment)).toEqual(appointment);
  });

  it('enforces live admin authorization and preserves patient ownership semantics', async () => {
    const appointment = await approve();
    for (const actor of [owner, outsider]) await expect(decide(appointment, 'cancel', actor)).rejects.toMatchObject(failure('FORBIDDEN'));
    await expect(patientCancel(appointment, admin)).rejects.toMatchObject(failure('NOT_FOUND'));
    await expect(decide({ ...appointment, id: randomUUID() })).rejects.toMatchObject(failure('NOT_FOUND'));
    await fixture.control.query('update dental.admin_grants set revoked_at=clock_timestamp() where account_id=$1', [admin]);
    await expect(decide(appointment)).rejects.toMatchObject(failure('FORBIDDEN'));
    expect(await current(appointment)).toEqual(appointment);
  });

  it('rolls cancellation, audit, suppression and fresh event back together', async () => {
    const appointment = await approve(), before = await events(appointment.id), session = await fixture.session();
    try {
      await session.client.query('select dental.decide($1,$2,$3,$4,$5)', [admin, appointment.id, appointment.version, 'cancel', reason]);
      await session.client.query('rollback');
    } finally { await fixture.closeSession(session); }
    expect(await current(appointment)).toEqual(appointment); expect(await events(appointment.id)).toEqual(before);
    expect((await fixture.control.query("select id from dental.audit_events where appointment_id=$1 and action='appointment_cancelled'", [appointment.id])).rows).toEqual([]);
  });

  it('serializes duplicate clinic requests to one transition and one notification', async () => {
    const appointment = await approve(), locker = await fixture.lockDate(day);
    const sessions = await Promise.all([fixture.session(), fixture.session()]);
    const pending = sessions.map(session => attempt(session, appointment));
    try { await fixture.waitForLockWaiters(sessions.map(session => session.pid)); }
    finally { await fixture.unlock(locker); }
    try {
      const results = await Promise.all(pending);
      expect(results.filter(result => result.ok)).toHaveLength(1);
      expect(results.filter(result => !result.ok)).toEqual([{ ok: false, code: 'VERSION_CONFLICT', sqlState: 'P0001' }]);
    } finally { await Promise.all(sessions.map(session => fixture.closeSession(session))); }
    await expect(decide(appointment)).rejects.toMatchObject(failure('VERSION_CONFLICT'));
    expect((await events(appointment.id)).filter(row => row.type === 'cancellation')).toHaveLength(1);
  });

  it.each(['date', 'outbox'])('rechecks revoked admin after waiting for the %s lock', async locked => {
    const appointment = await approve(), locker = await fixture.lockDate(day), session = await fixture.session();
    if (locked === 'outbox') {
      await locker.query('rollback; begin');
      await locker.query('select id from dental.outbox where appointment_id=$1 for update', [appointment.id]);
    }
    const pending = attempt(session, appointment);
    try {
      await fixture.waitForLockWaiters([session.pid]);
      await fixture.control.query('update dental.admin_grants set revoked_at=clock_timestamp() where account_id=$1', [admin]);
    } finally { await fixture.unlock(locker); }
    try { expect(await pending).toEqual({ ok: false, code: 'FORBIDDEN', sqlState: 'P0001' }); }
    finally { await fixture.closeSession(session); }
    expect(await current(appointment)).toEqual(appointment);
  });

  it.each(['queued', 'retry', 'leased'])('suppresses obsolete %s work and clears old leases atomically', async state => {
    const appointment = await approve();
    await fixture.control.query("update dental.outbox set state=$2,lease_owner=case when $2='leased' then $3::uuid else null end,lease_until=case when $2='leased' then '2026-10-08T05:01:00Z'::timestamptz else null end where appointment_id=$1", [appointment.id, state, randomUUID()]);
    await decide(appointment);
    const rows = (await events(appointment.id)).filter(row => row.type !== 'cancellation');
    expect(rows.every(row => row.state === 'suppressed' && row.lease_owner === null && row.lease_until === null)).toBe(true);
  });

  it('keeps accepted old history and freezes only minimal V2 cancellation fields for retries', async () => {
    const appointment = await approve(), firstWorker = randomUUID(), [approval] = await claim(firstWorker);
    const old = await prepare(firstWorker, approval); expect(old?.payloadVersion).toBe(1);
    await finish(firstWorker, approval, { kind: 'accepted' });
    await decide(appointment);
    const worker = randomUUID(), [notice] = await claim(worker), first = await prepare(worker, notice);
    expect(first).toMatchObject({ event: { type: 'cancellation', appointmentVersion: 3 }, status: 'cancelled', payloadVersion: 2, date: day, recipient: subjectOf(owner), manageUrl: `${origin}/appointments` });
    expect(JSON.stringify(first)).not.toContain(reason);
    expect(Object.keys(first!).sort()).toEqual(['date', 'event', 'manageUrl', 'payloadVersion', 'recipient', 'reference', 'status']);
    await finish(worker, notice, { kind: 'retryable', category: 'timeout' });
    await fixture.control.query('update dental.accounts set subject=$2 where id=$1', [owner, subjectOf(outsider)]);
    await fixture.setClock('2026-10-08T05:01:00Z');
    const retrier = randomUUID(), [retry] = await claim(retrier), next = await prepare(retrier, retry, 'https://changed.example');
    expect(retry.retryKey).toBe(notice.retryKey); expect(next && { ...next, event: first?.event }).toEqual(first);
    expect((await events(appointment.id)).find(row => row.type === 'approval').state).toBe('accepted');
  });

  it.each(['version', 'status', 'date'])('suppresses stale cancellation %s at the final eligibility check', async changed => {
    const appointment = await decide(await approve()), worker = randomUUID(), [notice] = await claim(worker);
    if (changed === 'version') await fixture.control.query('update dental.appointments set version=version+1 where id=$1', [appointment.id]);
    if (changed === 'status') await fixture.control.query("update dental.appointments set status='approved' where id=$1", [appointment.id]);
    if (changed === 'date') { await fixture.date('2026-10-12'); await fixture.control.query("update dental.outbox set appointment_date='2026-10-12' where id=$1", [notice.id]); }
    expect(await prepare(worker, notice)).toBeNull();
    expect((await events(appointment.id)).find(row => row.type === 'cancellation')).toMatchObject({ state: 'suppressed', attempt_count: 0 });
  });

  it('suppresses cancellation notices at their exact 24-hour expiry', async () => {
    const appointment = await decide(await approve()); await fixture.setClock('2026-10-09T05:00:00Z');
    expect(await claim(randomUUID())).toEqual([]);
    expect((await events(appointment.id)).find(row => row.type === 'cancellation')).toMatchObject({ state: 'suppressed', attempt_count: 0 });
  });

  it.each(['accepted', 'retryable'])('records an already-started old %s callback without reviving the suppressed event', async kind => {
    const appointment = await approve(), worker = randomUUID(), [approval] = await claim(worker);
    await prepare(worker, approval); await decide(appointment);
    expect(await finish(worker, approval, { kind, category: 'timeout', requestId: 'synthetic-in-flight-result' })).toBe(true);
    const rows = await events(appointment.id);
    expect(rows.find(row => row.type === 'approval').state).toBe('suppressed');
    expect(rows.find(row => row.type === 'cancellation').state).toBe('queued');
    expect((await fixture.control.query('select result from dental.notification_attempts where outbox_id=$1', [approval.id])).rows).toEqual([{ result: kind }]);
    expect((await current(appointment)).status).toBe('cancelled');
  });
});
