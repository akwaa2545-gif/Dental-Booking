import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { booking } from '../support/reservation-postgres';
import { CombinedNotificationFixture, COMBINED_END, COMBINED_START, ENROLLMENT_TABLE } from '../support/combined-notification-postgres';

let fixture: CombinedNotificationFixture;
async function requester(date = '2026-10-16') {
  const actor = await fixture.account();
  return { actor, input: booking(await fixture.base.patient(actor), date) };
}
async function activate(start = COMBINED_START, end = COMBINED_END) {
  const operator = await fixture.account(); await fixture.policy(operator, true, start, end); return operator;
}
async function installed() {
  expect((await fixture.control.query('select to_regclass($1) is not null as present', [ENROLLMENT_TABLE])).rows[0].present,
    'Migration 013 must install immutable new-booking enrollments.').toBe(true);
}
const claim = (worker = randomUUID()) => fixture.base.call<Record<string, unknown> | null>('select dental.claim_patient_event($1) as result', [worker]);
async function event(appointment: string, state = 'queued', version = 1) {
  return (await fixture.control.query(`insert into dental.outbox(appointment_id,appointment_version,type,due_at,expires_at,state)
    values($1,$2,'approval',dental.clock_now(),dental.clock_now()+interval '1 day',$3) returning id`, [appointment, version, state])).rows[0].id as string;
}

// Production changes these tests catch: backfill or replay enrollment, enrollment
// outside the reservation transaction, inclusive E, mutable policy reassignment,
// and a claim that scans/mutates unenrolled legacy rows before filtering them.
describe('real PostgreSQL new-booking-only combined enrollment and claim', () => {
  beforeAll(async () => { fixture = await CombinedNotificationFixture.create(); });
  afterEach(async () => { await fixture?.reset(); });
  afterAll(async () => { await fixture?.close(); });

  it('oldBookingHasNoEnrollment', async () => {
    await installed(); const { actor, input } = await requester(), key = randomUUID();
    const old = await fixture.base.reserve(actor, key, input); await event(old.id);
    const before = await fixture.queueDigest(); await fixture.base.setClock('2026-10-08T06:00:00Z');
    await activate('2026-10-08T06:00:00Z', '2026-10-15T06:00:00Z');
    expect(await fixture.base.reserve(actor, key, input)).toEqual(old);
    expect(await fixture.enrollments()).toHaveLength(0); expect(await fixture.queueDigest()).toEqual(before);
  });

  it('preActivationTransactionDoesNotEnroll', async () => {
    await installed(); await activate('2026-10-08T06:00:00Z', '2026-10-15T06:00:00Z');
    const { actor, input } = await requester(), session = await fixture.session();
    try {
      const created = (await session.client.query('select dental.reserve($1,$2,$3::jsonb) as result', [actor, randomUUID(), input])).rows[0].result;
      expect(new Date(created.createdAt).toISOString()).toBe(COMBINED_START);
      await fixture.base.setClock('2026-10-08T06:00:00Z'); await session.client.query('commit');
      expect(await fixture.enrollments()).toHaveLength(0);
    } finally { await fixture.closeSession(session); }
  });

  it('replayDoesNotDuplicate', async () => {
    await installed(); await activate(); await fixture.admin();
    const { actor, input } = await requester(), key = randomUUID();
    const created = await fixture.base.reserve(actor, key, input); const enrollment = await fixture.enrollments();
    const deliveries = await fixture.inner.deliveries();
    await fixture.base.setClock('2026-10-08T06:00:00Z');
    expect(await fixture.base.reserve(actor, key, input)).toEqual(created);
    expect(enrollment).toHaveLength(1); expect(await fixture.enrollments()).toEqual(enrollment);
    expect(await fixture.inner.deliveries()).toEqual(deliveries);
  });

  it('rollbackLeavesNeitherBookingNorEnrollment', async () => {
    await installed(); await activate(); await fixture.admin(); const { actor, input } = await requester(), session = await fixture.session();
    try {
      await session.client.query('select dental.reserve($1,$2,$3::jsonb)', [actor, randomUUID(), input]);
      // Inspect our uncommitted synthetic row as the disposable administrator.
      // The actual backend correctly has no direct enrollment table access.
      await session.client.query('reset role');
      expect((await session.client.query(`select count(*)::integer as count from ${ENROLLMENT_TABLE}`)).rows[0].count).toBe(1);
      await session.client.query('rollback');
      expect(await fixture.enrollments()).toHaveLength(0);
      expect(await fixture.inner.counts()).toMatchObject({ appointments: 0, keys: 0, events: 0, deliveries: 0 });
    } finally { await fixture.closeSession(session); }
  });

  it('exactTIncludedExactEExcluded', async () => {
    await installed(); await activate(); const first = await requester();
    const included = await fixture.base.reserve(first.actor, randomUUID(), first.input);
    expect(await fixture.enrollments()).toMatchObject([{ appointment_id: included.id, policy_version: 2,
      activation_at: new Date(COMBINED_START), authorized_end_at: new Date(COMBINED_END), enrolled_at: new Date(COMBINED_START) }]);
    await fixture.base.setClock(COMBINED_END); const second = await requester('2026-10-19');
    await fixture.base.reserve(second.actor, randomUUID(), second.input);
    expect(await fixture.enrollments()).toHaveLength(1); expect(await claim()).toBeNull();
  });

  it('policyChangeNeverReenrollsOldBooking', async () => {
    await installed(); const operator = await activate(), { actor, input } = await requester(), key = randomUUID();
    const old = await fixture.base.reserve(actor, key, input); const id = await event(old.id); const enrollment = await fixture.enrollments(), before = await fixture.queueDigest();
    await fixture.policy(operator, false, null, null); await fixture.policy(operator);
    expect(await fixture.base.reserve(actor, key, input)).toEqual(old);
    expect(await fixture.enrollments()).toEqual(enrollment); expect(await claim()).toBeNull();
    expect((await fixture.queueDigest()).attempts).toBe(before.attempts);
    expect((await fixture.control.query('select state,lease_owner,lease_until from dental.outbox where id=$1', [id])).rows[0])
      .toEqual({ state: 'suppressed', lease_owner: null, lease_until: null });
  });

  it('claimLeavesLegacyOutboxUntouched', async () => {
    await installed(); const oldOwner = await requester(); const old = await fixture.base.reserve(oldOwner.actor, randomUUID(), oldOwner.input);
    for (const [index, state] of ['queued', 'retry', 'accepted', 'suppressed', 'failed'].entries()) await event(old.id, state, index + 1);
    const before = await fixture.queueDigest(); await activate();
    expect(await claim()).toBeNull(); expect(await fixture.queueDigest()).toEqual(before); expect(await fixture.enrollments()).toHaveLength(0);
  });

  it('claims only a current enrolled event and caps its lease at E', async () => {
    await installed(); await activate(); const { actor, input } = await requester();
    const appointment = await fixture.base.reserve(actor, randomUUID(), input), id = await event(appointment.id);
    await fixture.base.setClock('2026-10-15T04:59:30Z');
    await fixture.control.query("update dental.outbox set expires_at='2026-10-16T05:00:00Z' where id=$1", [id]);
    const result = await claim(); expect(result).toMatchObject({ id, appointmentId: appointment.id, type: 'approval' });
    expect((await fixture.control.query('select state,lease_until from dental.outbox where id=$1', [id])).rows[0])
      .toEqual({ state: 'leased', lease_until: new Date(COMBINED_END) });
    expect(await claim()).toBeNull();
  });

  it('serializes enrollment against operator changes with a policy SHARE lock', async () => {
    await installed(); const operator = await activate(), { actor, input } = await requester(), bookingSession = await fixture.session();
    const operatorSession = await fixture.database.connect();
    try {
      await bookingSession.client.query('select dental.reserve($1,$2,$3::jsonb)', [actor, randomUUID(), input]);
      await operatorSession.query('set session authorization postgres');
      const { rows: [{ pid }] } = await operatorSession.query('select pg_backend_pid() as pid');
      const pending = operatorSession.query('select dental.set_admin_notification_policy($1,2,false,null,null,$2)', [operator, 'Synthetic locked boundary']);
      await fixture.base.waitForLockWaiters([pid], bookingSession.pid);
      await bookingSession.client.query('commit'); await pending;
      expect(await fixture.enrollments()).toMatchObject([{ policy_version: 2 }]); expect(await claim()).toBeNull();
    } finally { await fixture.closeSession(bookingSession); await operatorSession.end(); }
  });
});
