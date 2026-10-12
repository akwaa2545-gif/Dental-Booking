import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { booking } from '../support/reservation-postgres';
import { CombinedNotificationFixture, COMBINED_END, COMBINED_START } from '../support/combined-notification-postgres';
import { createLineTransport } from '../../src/worker/notifications/line';
import { notificationPayload } from '../../src/worker/notifications/payload';
import type { CombinedPatientEnvelope } from '../../src/worker/notifications/combined-types';

// Complements (does not duplicate) the existing independent-backend-process
// lock/race tests in combined-notification-budget/enrollment/patient-dispatch.
// Every provider operation below uses this test's synthetic fetcher only.
let f: CombinedNotificationFixture;
const origin = 'https://clinic.example';
const quota = (now: string) => ({ type: 'limited', value: 300, totalUsage: 0, observedAt: now });
async function setup(day = '2026-10-09', budgetEnd = COMBINED_END) {
  const operator = await f.account(); await f.policy(operator);
  const admin = await f.admin(), actor = await f.account();
  const provider = 'line:synthetic-combined-final', recipient = 'U' + actor.replaceAll('-', '');
  await f.control.query('update dental.accounts set provider=$2,subject=$3 where id=$1', [actor, provider, recipient]);
  await f.control.query(`insert into dental.line_reachability(provider,subject,reachable,event_at,event_id,updated_at)
    values($1,$2,true,dental.clock_now(),'01J00000000000000000000000',dental.clock_now())`, [provider, recipient]);
  const appointment = await f.base.reserve(actor, randomUUID(), booking(await f.base.patient(actor), day));
  await f.base.call("select dental.decide($1,$2,1,'approve','Synthetic final coverage') as result", [admin.account, appointment.id]);
  await f.operatorCall('select dental.set_admin_notification_budget($1,0,$2,$3,300,0,true,$4) as result',
    [operator, COMBINED_START, budgetEnd, 'Synthetic final coverage']);
  const events = (await f.control.query('select * from dental.outbox where appointment_id=$1 order by due_at', [appointment.id])).rows;
  return { operator, actor, appointment, events };
}
async function claim(worker = randomUUID()) {
  return f.base.call<{ id: string; type: string } | null>('select dental.claim_patient_event($1) as result', [worker]);
}
async function prepare(worker: string, event: string, now: string) {
  return f.base.call<CombinedPatientEnvelope | { state: 'paused_quota' } | null>(
    'select dental.prepare_patient_dispatch($1,$2,$3,$4::jsonb) as result', [worker, event, origin, JSON.stringify(quota(now))]);
}
async function finish(worker: string, event: string, result: unknown) {
  return f.base.call<boolean>('select dental.finish_dispatch($1,$2,$3::jsonb) as result', [worker, event, JSON.stringify(result)]);
}
async function row(id: string) { return (await f.control.query('select * from dental.outbox where id=$1', [id])).rows[0]; }
async function acceptApproval(q: Awaited<ReturnType<typeof setup>>) {
  const worker = randomUUID(), event = await claim(worker); expect(event?.type).toBe('approval');
  expect(await prepare(worker, event!.id, COMBINED_START)).not.toBeNull();
  expect(await finish(worker, event!.id, { kind: 'accepted' })).toBe(true);
  expect(await row(q.events.find(e => e.type === 'approval').id)).toMatchObject({ state: 'accepted' });
}

describe('real PG17 final combined integration gaps', () => {
  beforeAll(async () => { f = await CombinedNotificationFixture.create(); });
  afterEach(async () => {
    if (!f) return;
    await f.control.query('delete from dental.patient_dispatch_authorizations;delete from dental.patient_notification_budget_reservations;delete from dental.admin_notification_budget_reservations;delete from dental.admin_notification_budget');
    await f.control.query("delete from dental.line_reachability where provider='line:synthetic-combined-final'");
    await f.reset();
  });
  afterAll(async () => { await f?.close(); });

  it.each(['2026-10-08T11:00:00.000Z', '2026-10-08T14:00:00.000Z'])('reminderAtBangkokBoundary: due/catch-up %s uses combined authorization', async now => {
    const q = await setup(); await acceptApproval(q);
    await f.base.setClock('2026-10-08T10:59:59.999Z'); expect(await claim()).toBeNull();
    await f.base.setClock(now); const worker = randomUUID(), event = await claim(worker);
    expect(event?.type).toBe('reminder');
    expect(await prepare(worker, event!.id, now)).toMatchObject({ date: '2026-10-09', status: 'approved', payloadVersion: 1 });
    expect(await f.base.call('select dental.revalidate_patient_dispatch($1,$2) as result', [worker, event!.id])).toBe(true);
    expect((await f.control.query('select reserved_units::int as units from dental.admin_notification_budget')).rows[0].units).toBe(2);
  });

  it('reminderAtBangkokBoundary: exact appointment midnight remains suppressed after budget renewal', async () => {
    const q = await setup('2026-10-09', '2026-10-08T17:00:00.000Z'); await acceptApproval(q);
    const reminder = q.events.find(e => e.type === 'reminder');
    await f.base.setClock('2026-10-08T17:00:00.000Z'); expect(await claim()).toBeNull();
    expect(await row(reminder.id)).toMatchObject({ state: 'suppressed', attempt_count: 0 });
    const before = await f.queueDigest();
    await f.operatorCall('select dental.set_admin_notification_budget($1,1,$2,$3,300,0,true,$4) as result',
      [q.operator, '2026-10-08T17:00:00.000Z', COMBINED_END, 'Synthetic expired reminder renewal']);
    expect(await claim()).toBeNull(); expect(await f.queueDigest()).toEqual(before);
  });

  it.each(['accepted', 'unknown'] as const)('quotaEpochEndsDuringHttp: %s retains reservation/carry and never starts old work again', async outcome => {
    const boundary = '2026-10-08T05:00:10.000Z', q = await setup('2026-10-14', boundary);
    const worker = randomUUID(), event = await claim(worker), value = await prepare(worker, event!.id, COMBINED_START) as CombinedPatientEnvelope;
    expect(Date.parse(value.authorizationExpiresAt)).toBe(Date.parse(boundary));
    expect(await f.base.call('select dental.revalidate_patient_dispatch($1,$2) as result', [worker, event!.id])).toBe(true);
    let pushes = 0, wall = Date.parse(COMBINED_START);
    const transport = createLineTransport({ enabled: true, token: 'synthetic-final-only', clock: { wall: () => wall, monotonic: () => wall - Date.parse(COMBINED_START) },
      fetcher: async () => {
        pushes++; await f.base.setClock(boundary); wall = Date.parse(boundary);
        if (outcome === 'unknown') throw new Error('Synthetic ambiguous provider outcome');
        return new Response(null, { status: 200 });
      } });
    const result = await transport.send(value.recipient, notificationPayload(value), value.event.retryKey,
      { deadline: Date.parse(boundary), monotonicDeadline: 10_000, refresh: async () => {
        expect(await f.base.call('select dental.revalidate_patient_dispatch($1,$2) as result', [worker, event!.id])).toBe(true);
        return Date.parse(COMBINED_START);
      } });
    expect(result.kind).toBe(outcome === 'accepted' ? 'accepted' : 'retryable'); expect(pushes).toBe(1);
    expect(await finish(worker, event!.id, result)).toBe(true);
    const original = (await f.control.query('select * from dental.patient_notification_budget_reservations')).rows;
    await f.operatorCall('select dental.set_admin_notification_budget($1,1,$2,$3,300,0,true,$4) as result',
      [q.operator, boundary, COMBINED_END, 'Synthetic in-flight epoch renewal']);
    expect((await f.control.query('select * from dental.patient_notification_budget_reservations')).rows).toEqual(original);
    expect((await f.control.query('select reserved_units::int as reserved,carried_units::int as carried from dental.admin_notification_budget order by version desc limit 1')).rows[0])
      .toEqual({ reserved: 0, carried: 1 });
    if (outcome === 'accepted') {
      expect(await claim()).toBeNull(); expect(await row(event!.id)).toMatchObject({ state: 'accepted', attempt_count: 1 });
    } else {
      await f.base.setClock('2026-10-08T05:01:10.000Z'); const next = randomUUID(); expect((await claim(next))?.id).toBe(event!.id);
      expect(await prepare(next, event!.id, '2026-10-08T05:01:10.000Z')).toEqual({ state: 'paused_quota' });
      expect((await f.control.query('select count(*)::int as n from dental.notification_attempts where outbox_id=$1', [event!.id])).rows[0].n).toBe(1);
    }
    expect(pushes).toBe(1);
  });

  it('renewalNeverRevivesExpiredWork: exact E and a new seven-day policy preserve old enrollments/terminal rows', async () => {
    const q = await setup('2026-10-14'); await acceptApproval(q);
    await f.base.setClock(COMBINED_END); expect(await claim()).toBeNull();
    const enrollments = await f.enrollments();
    await f.policy(q.operator, false, null, null);
    const before = await f.queueDigest();
    const newEnd = '2026-10-22T05:00:00.000Z';
    await f.operatorCall('select dental.set_admin_notification_budget($1,1,$2,$3,300,0,true,$4) as result',
      [q.operator, COMBINED_END, newEnd, 'Synthetic no-revival renewal']);
    await f.policy(q.operator, true, COMBINED_END, newEnd);
    expect(await claim()).toBeNull();
    expect(await f.base.call('select dental.claim_admin_delivery($1) as result', [randomUUID()])).toBeNull();
    expect(await f.enrollments()).toEqual(enrollments); expect(await f.queueDigest()).toEqual(before);
    expect(await row(q.events.find(e => e.type === 'approval').id)).toMatchObject({ state: 'accepted', attempt_count: 1 });
    expect(await row(q.events.find(e => e.type === 'reminder').id)).toMatchObject({ state: 'suppressed', attempt_count: 0 });
  });
});
