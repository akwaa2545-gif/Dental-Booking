import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AdminAppointment, AdminNotificationSummary, Appointment } from '../../src/shared/contracts';
import { booking } from '../support/reservation-postgres';
import { AdminNotificationFixture, FIXTURE_END, localAdminConnection } from '../support/admin-notification-postgres';

const listSql = 'select dental.admin_appointments($1,$2::date,$3::text) as result';
const reasonAllowlist = ['mapping_unavailable', 'recipient_unavailable', 'duplicate_recipient', 'policy_disabled', 'expired', 'grant_revoked', 'mapping_changed', 'quota_unknown', 'quota_exhausted', 'budget_expired', 'invalid_request', 'unknown', 'timeout', 'transport', 'server_error', 'rate_limited', 'unauthorized', 'forbidden'];
let fixture: AdminNotificationFixture;

async function queued(count = 1) {
  const operator = await fixture.account(); await fixture.policy(operator);
  const admins = [];
  for (let index = 0; index < count; index++) admins.push(await fixture.admin());
  const owner = await fixture.account(), key = randomUUID();
  const patient = await fixture.base.patient(owner), input = booking(patient);
  const appointment = await fixture.base.reserve(owner, key, input);
  const deliveries = (await fixture.control.query('select * from dental.admin_booking_deliveries order by recipient_index')).rows;
  return { operator, admins, owner, key, input, appointment, deliveries };
}
async function list(actor: string, date: string | null = null, status: string | null = null) {
  return fixture.base.call<AdminAppointment[]>(listSql, [actor, date, status]);
}
async function setDelivery(id: string, state: AdminNotificationSummary['state'], count: number, reason: string | null = null) {
  await fixture.control.query(`update dental.admin_booking_deliveries set state=$2,attempt_count=$3,safe_reason=$4,
    first_attempt_at=case when $3::integer>0 then dental.clock_now() else null end,
    lease_owner=case when $2='leased' then $5::uuid else null end,
    lease_until=case when $2='leased' then dental.clock_now()+interval '60 seconds' else null end,
    accepted_at=case when $2='accepted' then dental.clock_now() else null end where id=$1`, [id, state, count, reason, randomUUID()]);
}
function safeShape(summary: AdminNotificationSummary) {
  expect(Object.keys(summary).sort()).toEqual(['attemptCount', 'recipientLabel', 'safeReason', 'state']);
  expect(summary.recipientLabel).toMatch(/^แอดมิน [1-9][0-9]*$/);
  if (summary.safeReason !== null) expect(reasonAllowlist).toContain(summary.safeReason);
}

// These exercise installed PostgreSQL functions as dental_backend. Regressions
// include omitted fan-out, mutable recipient labels, raw internal serialization,
// stale effective states, changed patient projections, and revoked-reader leaks.
describe('real PostgreSQL safe admin notification status projection', () => {
  beforeAll(async () => { fixture = await AdminNotificationFixture.create(); });
  afterEach(async () => { await fixture?.reset(); });
  afterAll(async () => { await fixture?.close(); });

  it('returns all seven stored states as an ordered exact four-field projection', async () => {
    const { admins, appointment, deliveries } = await queued(7);
    const states: [AdminNotificationSummary['state'], number, string | null][] = [
      ['queued', 0, null], ['leased', 1, null], ['retry', 2, 'timeout'], ['paused_quota', 0, 'quota_unknown'],
      ['accepted', 1, null], ['suppressed', 0, 'mapping_unavailable'], ['failed', 6, 'unknown'],
    ];
    for (let index = 0; index < states.length; index++) await setDelivery(deliveries[index].id, ...states[index]);
    const result = await list(admins[0].account);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ ...appointment, notificationAttempts: [] });
    expect(result[0].adminNotificationAttempts).toEqual([
      { recipientLabel: 'แอดมิน 1', state: 'queued', attemptCount: 0, safeReason: null },
      { recipientLabel: 'แอดมิน 2', state: 'leased', attemptCount: 1, safeReason: null },
      { recipientLabel: 'แอดมิน 3', state: 'retry', attemptCount: 2, safeReason: 'timeout' },
      { recipientLabel: 'แอดมิน 4', state: 'paused_quota', attemptCount: 0, safeReason: 'quota_unknown' },
      { recipientLabel: 'แอดมิน 5', state: 'accepted', attemptCount: 1, safeReason: null },
      { recipientLabel: 'แอดมิน 6', state: 'suppressed', attemptCount: 0, safeReason: 'mapping_unavailable' },
      { recipientLabel: 'แอดมิน 7', state: 'failed', attemptCount: 6, safeReason: 'unknown' },
    ]);
    result[0].adminNotificationAttempts!.forEach(safeShape);
  });

  it('keeps labels tied to immutable snapshot positions after revocation and later grants', async () => {
    const { operator, admins, deliveries } = await queued(3);
    const first = deliveries[0], original = admins.find(admin => admin.grant === first.grant_id)!;
    await fixture.revoke(operator, original);
    await fixture.admin();
    const reader = admins.find(admin => admin.grant !== first.grant_id)!;
    expect((await list(reader.account))[0].adminNotificationAttempts).toEqual([
      { recipientLabel: 'แอดมิน 1', state: 'suppressed', attemptCount: 0, safeReason: 'grant_revoked' },
      { recipientLabel: 'แอดมิน 2', state: 'queued', attemptCount: 0, safeReason: null },
      { recipientLabel: 'แอดมิน 3', state: 'queued', attemptCount: 0, safeReason: null },
    ]);
  });

  it.each(['queued', 'leased', 'retry', 'paused_quota'] as const)('derives expired %s as suppressed before any attempt without mutating the delivery', async state => {
    const { admins, deliveries: [delivery] } = await queued(); await setDelivery(delivery.id, state, 0);
    await fixture.base.setClock(FIXTURE_END);
    expect((await list(admins[0].account))[0].adminNotificationAttempts).toEqual([
      { recipientLabel: 'แอดมิน 1', state: 'suppressed', attemptCount: 0, safeReason: 'expired' },
    ]);
    expect((await fixture.deliveries())[0]).toMatchObject({ state, safe_reason: null, attempt_count: 0 });
  });

  it.each(['queued', 'leased', 'retry', 'paused_quota'] as const)('derives expired attempted %s as failed unknown without claiming nondelivery', async state => {
    const { admins, deliveries: [delivery] } = await queued(); await setDelivery(delivery.id, state, 2, 'timeout');
    await fixture.base.setClock(FIXTURE_END);
    expect((await list(admins[0].account))[0].adminNotificationAttempts).toEqual([
      { recipientLabel: 'แอดมิน 1', state: 'failed', attemptCount: 2, safeReason: 'unknown' },
    ]);
    expect((await fixture.deliveries())[0]).toMatchObject({ state, safe_reason: 'timeout', attempt_count: 2 });
  });

  it.each(['disabled', 'window-ended', 'future-activation', 'event-before-activation'] as const)('shows effective policy suppression when policy is %s', async change => {
    const { admins, deliveries: [delivery] } = await queued(); await setDelivery(delivery.id, 'retry', 1, 'timeout');
    // Synthetic control edits intentionally leave the stored delivery untouched,
    // reproducing a stale row before scheduler cleanup rather than testing it.
    if (change === 'disabled') await fixture.control.query('update dental.admin_notification_policy set enabled=false');
    if (change === 'window-ended') {
      await fixture.control.query("update dental.admin_notification_policy set authorized_end_at='2026-10-08T06:00:00Z'");
      await fixture.base.setClock('2026-10-08T06:00:00Z');
    }
    if (change === 'future-activation' || change === 'event-before-activation') {
      await fixture.control.query("update dental.admin_notification_policy set activation_at='2026-10-08T06:00:00Z'");
      if (change === 'event-before-activation') await fixture.base.setClock('2026-10-08T07:00:00Z');
    }
    expect((await list(admins[0].account))[0].adminNotificationAttempts).toEqual([
      { recipientLabel: 'แอดมิน 1', state: 'suppressed', attemptCount: 1, safeReason: 'policy_disabled' },
    ]);
    expect((await fixture.deliveries())[0]).toMatchObject({ state: 'retry', safe_reason: 'timeout' });
  });

  it('does not revive the original snapshot grant when the same account is regranted', async () => {
    const { operator, admins: [admin] } = await queued();
    await fixture.revoke(operator, admin);
    await fixture.operatorCall('select dental.set_admin_grant($1,$2,true,$3) as result', [operator, admin.account, 'Synthetic replacement access']);
    expect((await list(admin.account))[0].adminNotificationAttempts).toEqual([
      { recipientLabel: 'แอดมิน 1', state: 'suppressed', attemptCount: 0, safeReason: 'grant_revoked' },
    ]);
  });

  it('retains all terminal historical results after expiry, policy disable and recipient revocation', async () => {
    const { operator, admins, deliveries } = await queued(3);
    await setDelivery(deliveries[0].id, 'accepted', 1);
    await setDelivery(deliveries[1].id, 'suppressed', 0, 'mapping_unavailable');
    await setDelivery(deliveries[2].id, 'failed', 1, 'forbidden');
    for (const admin of admins) await fixture.revoke(operator, admin);
    const reader = await fixture.admin();
    await fixture.control.query('update dental.admin_notification_policy set enabled=false');
    await fixture.base.setClock(FIXTURE_END);
    expect((await list(reader.account))[0].adminNotificationAttempts).toEqual([
      { recipientLabel: 'แอดมิน 1', state: 'accepted', attemptCount: 1, safeReason: null },
      { recipientLabel: 'แอดมิน 2', state: 'suppressed', attemptCount: 0, safeReason: 'mapping_unavailable' },
      { recipientLabel: 'แอดมิน 3', state: 'failed', attemptCount: 1, safeReason: 'forbidden' },
    ]);
  });

  it('does not leak frozen identity, retry keys or raw attempt diagnostics in status', async () => {
    const { admins: [admin], deliveries: [delivery] } = await queued();
    await setDelivery(delivery.id, 'failed', 1, 'unknown');
    const worker = randomUUID();
    await fixture.control.query(`insert into dental.admin_notification_attempts(delivery_id,attempt_number,worker_id,result,started_at,finished_at,safe_error,provider_request_id)
      values($1,1,$2,'unknown',dental.clock_now(),dental.clock_now(),$3,'PRIVATE_PROVIDER_REQUEST_CANARY')`,
    [delivery.id, worker, 'Bearer PRIVATE_TOKEN_CANARY raw provider body with private recipient']);
    const result = await list(admin.account), summary = result[0].adminNotificationAttempts;
    expect(summary).toEqual([{ recipientLabel: 'แอดมิน 1', state: 'failed', attemptCount: 1, safeReason: 'unknown' }]);
    summary!.forEach(safeShape);
    const response = JSON.stringify(result);
    for (const privateValue of [admin.account, admin.grant, admin.provider, admin.recipient, delivery.id, delivery.event_id, delivery.retry_key, worker,
      'PRIVATE_TOKEN_CANARY', 'PRIVATE_PROVIDER_REQUEST_CANARY', 'raw provider body']) expect(response).not.toContain(privateValue);
  });

  it('sanitizes an unknown future reason even if a synthetic legacy row bypasses the current CHECK', async () => {
    const { admins: [admin], deliveries: [delivery] } = await queued();
    await setDelivery(delivery.id, 'failed', 1, 'unknown');
    const { rows: constraints } = await fixture.control.query(`select conname from pg_constraint
      where conrelid='dental.admin_booking_deliveries'::regclass and contype='c' and pg_get_constraintdef(oid) like '%safe_reason%'`);
    expect(constraints).toHaveLength(1);
    const quoted = '"' + String(constraints[0].conname).replaceAll('"', '""') + '"';
    await fixture.control.query('begin');
    try {
      await fixture.control.query(`alter table dental.admin_booking_deliveries drop constraint ${quoted}`);
      await fixture.control.query("update dental.admin_booking_deliveries set safe_reason='PRIVATE_FUTURE_REASON_CANARY' where id=$1", [delivery.id]);
      await fixture.control.query('set local role dental_backend');
      const { rows: [{ result }] } = await fixture.control.query(listSql, [admin.account, null, null]);
      expect(result[0].adminNotificationAttempts).toEqual([{ recipientLabel: 'แอดมิน 1', state: 'failed', attemptCount: 1, safeReason: 'unknown' }]);
      expect(JSON.stringify(result)).not.toContain('PRIVATE_FUTURE_REASON_CANARY');
    } finally { await fixture.control.query('rollback'); }
  });

  it.each(reasonAllowlist)('permits only the documented safe reason %s', async reason => {
    const { admins: [admin], deliveries: [delivery] } = await queued();
    await setDelivery(delivery.id, 'failed', 1, reason);
    expect((await list(admin.account))[0].adminNotificationAttempts).toEqual([
      { recipientLabel: 'แอดมิน 1', state: 'failed', attemptCount: 1, safeReason: reason },
    ]);
  });

  it('does not grant direct backend execution of the private summary helper', async () => {
    const { appointment } = await queued();
    await expect(fixture.base.call('select dental._admin_notification_summary($1) as result', [appointment.id]))
      .rejects.toMatchObject({ code: '42501' });
    const { rows: [{ backend, runtime, publicExecute, config }] } = await fixture.control.query(`
      select has_function_privilege('dental_backend',p.oid,'EXECUTE') as backend,
        has_function_privilege('dental_runtime',p.oid,'EXECUTE') as runtime,
        exists(select from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE') as "publicExecute",
        p.proconfig as config
      from pg_proc p where p.oid='dental._admin_notification_summary(uuid)'::regprocedure`);
    expect({ backend, runtime, publicExecute, config }).toEqual({ backend: false, runtime: false, publicExecute: false, config: ['search_path=""'] });
  });

  it('preserves the patient representation for reserve, idempotent replay, submission, list and detail', async () => {
    const { admins: [admin], owner, key, input, appointment } = await queued();
    const patient = await fixture.base.call<Appointment>('select dental.get_appointment($1,$2) as result', [owner, appointment.id]);
    const submission = await fixture.base.call<Appointment>('select dental.submission($1,$2) as result', [owner, key]);
    const appointments = await fixture.base.call<Appointment[]>('select dental.list_appointments($1) as result', [owner]);
    const replay = await fixture.base.reserve(owner, key, input);
    for (const item of [appointment, patient, submission, ...appointments, replay]) {
      expect(item).toEqual(appointment);
      expect(item).not.toHaveProperty('adminNotificationAttempts');
      expect(item).not.toHaveProperty('notificationAttempts');
    }
    const [projected] = await list(admin.account);
    expect(projected.adminNotificationAttempts).toHaveLength(1);
    const { notificationAttempts, adminNotificationAttempts, ...oldAppointment } = projected;
    expect(notificationAttempts).toEqual([]); expect(adminNotificationAttempts).toHaveLength(1); expect(oldAppointment).toEqual(appointment);
  });

  it('returns an empty additive summary for pre-feature bookings without creating deliveries', async () => {
    const owner = await fixture.account(), key = randomUUID();
    const appointment = await fixture.base.reserve(owner, key, booking(await fixture.base.patient(owner)));
    const admin = await fixture.admin();
    expect(await list(admin.account)).toEqual([{ ...appointment, notificationAttempts: [], adminNotificationAttempts: [] }]);
    expect(await fixture.deliveries()).toEqual([]);
  });

  it('retains admin date/status filtering and keeps summaries scoped to each appointment', async () => {
    const { admins: [admin], appointment } = await queued();
    const owner = await fixture.account();
    const second = await fixture.base.reserve(owner, randomUUID(), booking(await fixture.base.patient(owner), '2026-10-16'));
    expect((await list(admin.account, appointment.date, 'pending')).map(item => item.id)).toEqual([appointment.id]);
    expect((await list(admin.account, second.date, 'pending')).map(item => item.id)).toEqual([second.id]);
    expect(await list(admin.account, appointment.date, 'approved')).toEqual([]);
    for (const item of await list(admin.account)) expect(item.adminNotificationAttempts).toEqual([
      { recipientLabel: 'แอดมิน 1', state: 'queued', attemptCount: 0, safeReason: null },
    ]);
  });

  it('rejects absent accounts, ordinary patients and revoked app admins at the SQL boundary', async () => {
    const { operator, admins: [admin], owner } = await queued();
    await expect(list(randomUUID())).rejects.toMatchObject({ code: 'P0001', message: 'UNAUTHENTICATED' });
    await expect(list(owner)).rejects.toMatchObject({ code: 'P0001', message: 'FORBIDDEN' });
    await fixture.revoke(operator, admin);
    await expect(list(admin.account)).rejects.toMatchObject({ code: 'P0001', message: 'FORBIDDEN' });
  });

  it('rechecks reader authority after the date lock wait before returning private status', async () => {
    const { operator, admins: [admin], appointment } = await queued();
    const holder = await fixture.base.lockDate(appointment.date), reader = await fixture.session();
    const pending = reader.client.query(listSql, [admin.account, null, null]).then(result => ({ result }), error => ({ error }));
    try {
      await fixture.base.waitForLockWaiters([reader.pid]);
      await fixture.revoke(operator, admin);
      await fixture.base.unlock(holder);
      expect(await pending).toMatchObject({ error: { code: 'P0001', message: 'FORBIDDEN' } });
    } finally { await fixture.closeSession(reader); }
  });

  it('rechecks reader authority after the summary query waits and discards the private result', async () => {
    const { operator, admins: [admin] } = await queued();
    const holder = await localAdminConnection(), reader = await fixture.session();
    let pending: Promise<{ result?: unknown; error?: unknown }> | undefined;
    try {
      await holder.query('begin; lock table dental.admin_booking_deliveries in access exclusive mode');
      const { rows: [{ pid }] } = await holder.query('select pg_backend_pid() as pid');
      pending = reader.client.query(listSql, [admin.account, null, null]).then(result => ({ result }), error => ({ error }));
      await fixture.base.waitForLockWaiters([reader.pid], pid);
      // The query has passed its pre-read authorization but cannot finish the
      // new status projection. A fresh post-query check must reject this reader.
      await fixture.revoke(operator, admin);
      await holder.query('commit');
      expect(await pending).toMatchObject({ error: { code: 'P0001', message: 'FORBIDDEN' } });
      expect((await fixture.control.query("select count(*)::integer as count from dental.audit_events where action='admin_appointments_read'")).rows[0].count).toBe(0);
    } finally {
      await holder.query('rollback'); await pending;
      await fixture.closeSession(reader); await holder.end();
    }
  });
});
