import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Appointment } from '../../src/shared/contracts';
import { booking, type ReservationOutcome } from '../support/reservation-postgres';
import { AdminNotificationFixture, FIXTURE_END, FIXTURE_NOW, localAdminConnection } from '../support/admin-notification-postgres';

let fixture: AdminNotificationFixture;
async function requester() {
  const actor = await fixture.account();
  return { actor, input: booking(await fixture.base.patient(actor)) };
}
async function activate() { const operator = await fixture.account(); await fixture.policy(operator); return operator; }

// Regression targets: enqueue outside the booking transaction; a replay calling
// enqueue again; a join taken before the defined post-insert snapshot; mutable
// grant/account destinations; and an accidentally shared patient outbox.
describe('real PostgreSQL atomic admin recipient snapshot', () => {
  beforeAll(async () => { fixture = await AdminNotificationFixture.create(); });
  afterEach(async () => { await fixture?.reset(); });
  afterAll(async () => { await fixture?.close(); });

  it('installs an isolated policy that starts disabled and version one', async () => {
    const { rows: [{ installed }] } = await fixture.control.query("select to_regclass('dental.admin_notification_policy') is not null as installed");
    expect(installed, 'Migration 012 must install the disabled admin notification lane.').toBe(true);
    const { rows } = await fixture.control.query('select enabled,version,activation_at,authorized_end_at from dental.admin_notification_policy');
    expect(rows).toEqual([{ enabled: false, version: 1, activation_at: null, authorized_end_at: null }]);
  });

  it('creates the booking but no event or delivery while the policy is disabled', async () => {
    await fixture.admin(); const { actor, input } = await requester();
    await fixture.base.reserve(actor, randomUUID(), input);
    expect(await fixture.counts()).toEqual({ appointments: 1, keys: 1, events: 0, deliveries: 0, patient_outbox: 0, patient_attempts: 0 });
  });

  it('snapshots three active grants into one event and three frozen, unattempted deliveries', async () => {
    await activate(); const recipients = [await fixture.admin(), await fixture.admin(), await fixture.admin()];
    const { actor, input } = await requester();
    const appointment = await fixture.base.reserve(actor, randomUUID(), input);
    expect(await fixture.counts()).toEqual({ appointments: 1, keys: 1, events: 1, deliveries: 3, patient_outbox: 0, patient_attempts: 0 });
    const deliveries = await fixture.deliveries();
    expect(new Set(deliveries.map(row => row.retry_key)).size).toBe(3);
    for (const recipient of recipients) {
      expect(deliveries.find(row => row.grant_id === recipient.grant)).toMatchObject({ account_id: recipient.account,
        frozen_provider: recipient.provider, frozen_recipient: recipient.recipient, state: 'queued', safe_reason: null,
        attempt_count: 0, lease_owner: null, lease_until: null });
    }
    const { rows: [event] } = await fixture.control.query('select appointment_id,created_at,expires_at from dental.admin_booking_events');
    expect(event).toEqual({ appointment_id: appointment.id, created_at: new Date(FIXTURE_NOW), expires_at: new Date(FIXTURE_END) });
  });

  it('replays the original response and stable event, delivery and retry identifiers', async () => {
    await activate(); await fixture.admin();
    const { actor, input } = await requester(), key = randomUUID();
    const appointment = await fixture.base.reserve(actor, key, input);
    const before = await fixture.deliveries();
    await fixture.base.setClock('2026-10-08T06:00:00Z');
    expect(await fixture.base.reserve(actor, key, input)).toEqual(appointment);
    expect(await fixture.deliveries()).toEqual(before);
    expect(await fixture.counts()).toMatchObject({ appointments: 1, keys: 1, events: 1, deliveries: 1 });
  });

  it('serializes concurrent same-key retries into one event and three deliveries', async () => {
    await activate(); await fixture.admin(); await fixture.admin(); await fixture.admin();
    const { actor, input } = await requester(), key = randomUUID(); await fixture.base.date(input.date);
    const sessions = await Promise.all([fixture.session(), fixture.session()]);
    const locker = await fixture.base.lockDate(input.date);
    const first = fixture.base.attempt(sessions[0], actor, key, input);
    let second: Promise<ReservationOutcome> | undefined;
    try {
      await fixture.base.waitForLockWaiters([sessions[0].pid]);
      second = fixture.base.attempt(sessions[1], actor, key, input);
      await fixture.base.waitForLockWaiters([sessions[1].pid], sessions[0].pid);
    } finally { await fixture.base.unlock(locker); }
    const results = await Promise.all([first, second]);
    try {
      expect(sessions[0].pid).not.toBe(sessions[1].pid);
      expect(results[0]?.kind).toBe('created'); expect(results[1]).toEqual(results[0]);
      expect(await fixture.counts()).toMatchObject({ appointments: 1, keys: 1, events: 1, deliveries: 3 });
    } finally { await Promise.all(sessions.map(session => fixture.closeSession(session))); }
  });

  it('rolls back the appointment, submission result, event and every delivery together', async () => {
    await activate(); await fixture.admin(); const { actor, input } = await requester();
    const session = await fixture.session();
    try {
      const { rows: [created] } = await session.client.query('select dental.reserve($1,$2,$3::jsonb) as result', [actor, randomUUID(), input]);
      expect(created.result.status).toBe('pending');
      await session.client.query('rollback');
      expect(await fixture.counts()).toEqual({ appointments: 0, keys: 0, events: 0, deliveries: 0, patient_outbox: 0, patient_attempts: 0 });
    } finally { await fixture.closeSession(session); }
  });

  it('rolls back the booking when the recipient insert fails, rather than silently losing its event', async () => {
    await activate(); await fixture.admin(); const { actor, input } = await requester();
    await fixture.control.query(`create function dental_test_reservations.reject_admin_delivery() returns trigger language plpgsql as $$
      begin raise exception 'SYNTHETIC_ENQUEUE_FAILURE'; end; $$;
      create trigger synthetic_admin_enqueue_failure before insert on dental.admin_booking_deliveries for each row execute function dental_test_reservations.reject_admin_delivery()`);
    try {
      await expect(fixture.base.reserve(actor, randomUUID(), input)).rejects.toThrow('SYNTHETIC_ENQUEUE_FAILURE');
      expect(await fixture.counts()).toEqual({ appointments: 0, keys: 0, events: 0, deliveries: 0, patient_outbox: 0, patient_attempts: 0 });
    } finally { await fixture.control.query('drop trigger synthetic_admin_enqueue_failure on dental.admin_booking_deliveries; drop function dental_test_reservations.reject_admin_delivery()'); }
  });

  it('never backfills disabled-period appointments when enabled or when an old key is replayed', async () => {
    const recipient = await fixture.admin(); const { actor, input } = await requester(), key = randomUUID();
    const old = await fixture.base.reserve(actor, key, input); await activate();
    expect(await fixture.base.reserve(actor, key, input)).toEqual(old);
    expect(await fixture.counts()).toMatchObject({ events: 0, deliveries: 0 });
    await fixture.base.reserve(actor, randomUUID(), { ...input, date: '2026-10-12' });
    expect((await fixture.deliveries()).map(row => row.grant_id)).toEqual([recipient.grant]);
  });

  it('creates events only inside the approved activation window, with a 24-hour booking expiry', async () => {
    const operator = await fixture.account(); await fixture.admin();
    await fixture.policy(operator, true, '2026-10-08T06:00:00Z', FIXTURE_END);
    const { actor, input } = await requester(); await fixture.base.reserve(actor, randomUUID(), input);
    expect(await fixture.counts()).toMatchObject({ events: 0 });
    await fixture.base.setClock('2026-10-08T06:00:00Z');
    const active = await fixture.base.reserve(actor, randomUUID(), { ...input, date: '2026-10-12' });
    await fixture.base.setClock(FIXTURE_END);
    await fixture.base.reserve(actor, randomUUID(), { ...input, date: '2026-10-13' });
    const { rows } = await fixture.control.query('select appointment_id,expires_at-created_at as duration from dental.admin_booking_events');
    expect(rows).toEqual([{ appointment_id: active.id, duration: { days: 1 } }]);
  });

  it('records unmapped, negatively reachable and unknown recipients as terminal suppressed rows', async () => {
    await activate();
    const unmapped = await fixture.admin({ mapped: false }), blocked = await fixture.admin({ reachable: false }), unknown = await fixture.admin({ reachable: null });
    const { actor, input } = await requester(); await fixture.base.reserve(actor, randomUUID(), input);
    const rows = await fixture.deliveries(); expect(rows).toHaveLength(3);
    expect(rows.find(row => row.grant_id === unmapped.grant)).toMatchObject({ state: 'suppressed', safe_reason: 'mapping_unavailable' });
    for (const recipient of [blocked, unknown]) expect(rows.find(row => row.grant_id === recipient.grant)).toMatchObject({ state: 'suppressed', safe_reason: 'recipient_unavailable' });
    expect(rows.every(row => row.attempt_count === 0)).toBe(true);
  });

  it('queues only one delivery for the same LINE destination across distinct mapped providers', async () => {
    await activate(); const shared = 'U11111111111111111111111111111111';
    await fixture.admin({ provider: 'line:synthetic-a', recipient: shared });
    await fixture.admin({ provider: 'line:synthetic-b', recipient: shared });
    const { actor, input } = await requester(); await fixture.base.reserve(actor, randomUUID(), input);
    const rows = await fixture.deliveries(); expect(rows).toHaveLength(2);
    expect(rows.filter(row => row.state === 'queued')).toHaveLength(1);
    expect(rows.filter(row => row.state === 'suppressed')).toMatchObject([{ safe_reason: 'duplicate_recipient' }]);
  });

  it('does not let an unmapped same-subject account suppress a verified reachable recipient', async () => {
    await activate(); const shared = 'U22222222222222222222222222222222';
    const unmapped = await fixture.admin({ mapped: false });
    await fixture.control.query('update dental.accounts set subject=$2 where id=$1', [unmapped.account, shared]);
    const mapped = await fixture.admin({ recipient: shared });
    // A deterministic low grant UUID makes the ineligible identity sort first.
    await fixture.control.query("update dental.admin_grants set id='00000000-0000-4000-8000-000000000001' where id=$1", [unmapped.grant]);
    const { actor, input } = await requester(); await fixture.base.reserve(actor, randomUUID(), input);
    const rows = await fixture.deliveries();
    expect(rows.find(row => row.grant_id === mapped.grant)).toMatchObject({ state: 'queued', frozen_recipient: shared });
    expect(rows.find(row => row.account_id === unmapped.account)).toMatchObject({ state: 'suppressed', safe_reason: 'mapping_unavailable' });
  });

  it('ranks a reachable destination ahead of an earlier negatively reachable same-subject identity', async () => {
    await activate(); const shared = 'U33333333333333333333333333333333';
    const blocked = await fixture.admin({ provider: 'line:synthetic-blocked', recipient: shared, reachable: false });
    const mapped = await fixture.admin({ provider: 'line:synthetic-reachable', recipient: shared });
    await fixture.control.query("update dental.admin_grants set id='00000000-0000-4000-8000-000000000001' where id=$1", [blocked.grant]);
    const { actor, input } = await requester(); await fixture.base.reserve(actor, randomUUID(), input);
    const rows = await fixture.deliveries();
    expect(rows.find(row => row.grant_id === mapped.grant)).toMatchObject({ state: 'queued', frozen_recipient: shared });
    expect(rows.find(row => row.account_id === blocked.account)).toMatchObject({ state: 'suppressed', safe_reason: 'recipient_unavailable' });
  });

  it('does not add late grants or revive a previously suppressed mapping on replay', async () => {
    await activate(); const original = await fixture.admin({ mapped: false });
    const { actor, input } = await requester(), key = randomUUID(); await fixture.base.reserve(actor, key, input);
    const before = await fixture.deliveries(); await fixture.admin();
    await fixture.control.query('update dental.accounts set provider=$2,subject=$3 where id=$1', [original.account, original.provider, original.recipient]);
    await fixture.base.reserve(actor, key, input);
    expect(await fixture.deliveries()).toEqual(before);
  });

  it('observes a grant and revoke committed while the booking waits before its recipient snapshot', async () => {
    const operator = await activate(), revoked = await fixture.admin();
    const { actor, input } = await requester(); await fixture.base.date(input.date);
    const session = await fixture.session(), locker = await fixture.base.lockDate(input.date);
    const pending = fixture.base.attempt(session, actor, randomUUID(), input);
    let late: Awaited<ReturnType<typeof fixture.admin>> | undefined;
    try {
      await fixture.base.waitForLockWaiters([session.pid]);
      late = await fixture.admin(); await fixture.revoke(operator, revoked);
    } finally { await fixture.base.unlock(locker); }
    try {
      expect((await pending).kind).toBe('created');
      expect((await fixture.deliveries()).map(row => row.grant_id)).toEqual([late!.grant]);
    } finally { await fixture.closeSession(session); }
  });

  it('does not hold grant locks while an already snapshotted booking transaction remains open', async () => {
    const operator = await activate(), recipient = await fixture.admin();
    const { actor, input } = await requester(); const session = await fixture.session();
    try {
      await session.client.query('select dental.reserve($1,$2,$3::jsonb) as result', [actor, randomUUID(), input]);
      await fixture.revoke(operator, recipient);
      await session.client.query('commit');
      expect((await fixture.deliveries()).map(row => row.grant_id)).toEqual([recipient.grant]);
      const { rows: [{ revoked }] } = await fixture.control.query('select revoked_at is not null as revoked from dental.admin_grants where id=$1', [recipient.grant]);
      expect(revoked).toBe(true);
    } finally { await fixture.closeSession(session); }
  });

  it('ignores uncommitted grants and uncommitted revocations at the recipient statement snapshot', async () => {
    await activate(); const active = await fixture.admin(), pendingGrant = await fixture.admin();
    await fixture.control.query('delete from dental.admin_grants where id=$1', [pendingGrant.grant]);
    const change = await localAdminConnection();
    try {
      await change.query('begin');
      await change.query('insert into dental.admin_grants(id,account_id) values($1,$2)', [pendingGrant.grant, pendingGrant.account]);
      await change.query('update dental.admin_grants set revoked_at=dental.clock_now() where id=$1', [active.grant]);
      const { actor, input } = await requester(); await fixture.base.reserve(actor, randomUUID(), input);
      expect((await fixture.deliveries()).map(row => row.grant_id)).toEqual([active.grant]);
    } finally { await change.query('rollback'); await change.end(); }
  });

  it('does not change a statement snapshot when grants and revocations commit after recipient SELECT starts', async () => {
    const operator = await activate(), original = await fixture.admin();
    const { actor, input } = await requester();
    await fixture.control.query(`create function dental_test_reservations.pause_admin_delivery() returns trigger language plpgsql as $$
      begin perform pg_catalog.pg_advisory_xact_lock(884012); return new; end; $$;
      create trigger synthetic_admin_snapshot_pause before insert on dental.admin_booking_deliveries for each row execute function dental_test_reservations.pause_admin_delivery()`);
    const gate = await localAdminConnection(), session = await fixture.session();
    let pending: Promise<ReservationOutcome> | undefined;
    try {
      await gate.query('begin; select pg_advisory_xact_lock(884012)');
      const { rows: [{ pid }] } = await gate.query('select pg_backend_pid() as pid');
      pending = fixture.base.attempt(session, actor, randomUUID(), input);
      await fixture.base.waitForLockWaiters([session.pid], pid);
      await fixture.admin(); await fixture.revoke(operator, original);
      await gate.query('commit');
      expect((await pending).kind).toBe('created');
      expect((await fixture.deliveries()).map(row => row.grant_id)).toEqual([original.grant]);
    } finally {
      await gate.query('rollback'); await gate.end();
      await pending; await fixture.closeSession(session);
      await fixture.control.query('drop trigger synthetic_admin_snapshot_pause on dental.admin_booking_deliveries; drop function dental_test_reservations.pause_admin_delivery()');
    }
  });

  it('suppresses the prior activation window permanently across disable and re-enable', async () => {
    const operator = await activate(); await fixture.admin();
    const { actor, input } = await requester(), key = randomUUID(); await fixture.base.reserve(actor, key, input);
    const original = (await fixture.deliveries())[0];
    await fixture.policy(operator, false, null, null);
    expect((await fixture.deliveries())[0]).toMatchObject({ id: original.id, retry_key: original.retry_key, state: 'suppressed', safe_reason: 'policy_disabled' });
    await fixture.base.setClock('2026-10-08T06:00:00Z');
    await fixture.policy(operator, true, '2026-10-08T06:00:00Z', FIXTURE_END);
    await fixture.base.reserve(actor, key, input);
    expect((await fixture.deliveries())[0]).toMatchObject({ id: original.id, state: 'suppressed', safe_reason: 'policy_disabled' });
    await fixture.base.reserve(actor, randomUUID(), { ...input, date: '2026-10-12' });
    expect((await fixture.deliveries()).filter(row => row.state === 'queued')).toHaveLength(1);
  });

  it('rejects a stale policy version without changing the policy, deliveries or audit records', async () => {
    const operator = await activate(); await fixture.admin();
    const { actor, input } = await requester(); await fixture.base.reserve(actor, randomUUID(), input);
    const before = {
      policy: (await fixture.control.query('select to_jsonb(p) as row from dental.admin_notification_policy p')).rows,
      deliveries: await fixture.deliveries(),
      audit: (await fixture.control.query('select to_jsonb(a) as row from dental.audit_events a order by id')).rows,
    };
    await expect(fixture.operatorCall('select dental.set_admin_notification_policy($1,1,false,null,null,$2) as result', [operator, 'Synthetic stale version']))
      .rejects.toMatchObject({ code: 'P0001', message: 'VERSION_CONFLICT' });
    expect({
      policy: (await fixture.control.query('select to_jsonb(p) as row from dental.admin_notification_policy p')).rows,
      deliveries: await fixture.deliveries(),
      audit: (await fixture.control.query('select to_jsonb(a) as row from dental.audit_events a order by id')).rows,
    }).toEqual(before);
  });

  it('keeps the original grant snapshot after revoke/regrant and grants only future bookings to the new grant', async () => {
    const operator = await activate(), recipient = await fixture.admin();
    const { actor, input } = await requester(), key = randomUUID(); await fixture.base.reserve(actor, key, input);
    const original = await fixture.deliveries(); await fixture.revoke(operator, recipient);
    await fixture.operatorCall('select dental.set_admin_grant($1,$2,true,$3) as result', [operator, recipient.account, 'Synthetic regrant']);
    const { rows: [{ id: newGrant }] } = await fixture.control.query('select id from dental.admin_grants where account_id=$1 and revoked_at is null', [recipient.account]);
    expect(newGrant).not.toBe(recipient.grant);
    await fixture.base.reserve(actor, key, input); expect(await fixture.deliveries()).toEqual(original);
    await fixture.base.reserve(actor, randomUUID(), { ...input, date: '2026-10-12' });
    expect((await fixture.deliveries()).map(row => row.grant_id).sort()).toEqual([recipient.grant, newGrant].sort());
  });

  it('preserves patient outbox rows and attempts byte-for-byte during a new admin notification booking', async () => {
    const operator = await activate(), recipient = await fixture.admin(); const { actor, input } = await requester();
    const old = await fixture.base.reserve(actor, randomUUID(), input);
    await fixture.base.call<Appointment>('select dental.decide($1,$2,1,$3,$4) as result', [recipient.account, old.id, 'approve', 'Synthetic patient queue preservation']);
    const patientSnapshot = async () => ({
      outbox: (await fixture.control.query('select to_jsonb(o) as row from dental.outbox o order by id')).rows,
      attempts: (await fixture.control.query('select to_jsonb(a) as row from dental.notification_attempts a order by id')).rows,
    });
    const before = await patientSnapshot(); expect(before.outbox.length).toBeGreaterThan(0);
    await fixture.base.reserve(actor, randomUUID(), { ...input, date: '2026-10-12' });
    expect(await patientSnapshot()).toEqual(before);
    await fixture.policy(operator, false, null, null);
  });
});
