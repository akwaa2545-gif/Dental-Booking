import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminManagementFixture } from '../support/admin-management-postgres';
import { claimed, grants, row, value } from '../support/admin-management-lifecycle';
import { fixture as httpFixture, req, session } from '../support/mock-line';
import { createDatabase } from '../../src/worker/db';
import { createAdminManagementStore } from '../../src/worker/admin-management/db';
import { createRequestLimitStore } from '../../src/worker/security';
import { booking } from '../support/reservation-postgres';

const origin = 'https://tooth-talk-staging.tooth-talk-staging-f7ff4a96.workers.dev';
const quota = { type: 'limited', value: 300, totalUsage: 0, observedAt: '2026-10-08T05:00:00Z' };
const headers = { Cookie: '__Host-dental_session=' + 'o'.repeat(43), 'X-CSRF-Token': 'csrf', 'X-Role': 'owner', 'X-Can-Revoke-Admins': 'true' };
let f: AdminManagementFixture;
function http(actor: string) {
  const h = httpFixture(), port = { query: async (sql: string, values: unknown[]) => ({ rows: [{ result: await f.base.call(sql, values) }] }) };
  h.deps.adminManagement = f.store; h.deps.db = createDatabase(port); h.deps.requestLimits.store = createRequestLimitStore(port);
  // Stale privileged browser metadata deliberately never supplies authority.
  h.deps.sessions.resolve = async () => ({ ...session, accountId: actor, isAdmin: true });
  return { ...h, revoke: (grantId: string) => h.app.fetch(req(`/api/admin/management/grants/${grantId}/revoke`, { reason: 'Synthetic owner revocation' }, headers)) };
}
async function notificationQueue() {
  const owner = await f.owner(), target = await f.admin(), patient = await f.account();
  for (const [account, provider] of [[target.account, 'line:synthetic-fence-admin'], [patient, 'line:synthetic-fence-patient']]) {
    const subject = 'U' + account.replaceAll('-', '');
    await f.control.query('update dental.accounts set provider=$2,subject=$3 where id=$1', [account, provider, subject]);
    await f.control.query("insert into dental.line_reachability(provider,subject,reachable,event_at,event_id,updated_at) values($1,$2,true,dental.clock_now(),'01J00000000000000000000000',dental.clock_now())", [provider, subject]);
  }
  await f.operatorCall('select dental.set_admin_notification_policy($1,1,true,$2,$3,$4) as result', [owner.account, quota.observedAt, '2026-10-15T05:00:00Z', 'Synthetic fence policy']);
  await f.operatorCall('select dental.set_admin_notification_budget($1,0,$2,$3,300,0,true,$4) as result', [owner.account, quota.observedAt, '2026-10-15T05:00:00Z', 'Synthetic fence budget']);
  const appointment = await f.base.reserve(patient, randomUUID(), booking(await f.base.patient(patient), '2026-10-14'));
  await f.base.call("select dental.decide($1,$2,1,'approve','Synthetic approval') as result", [owner.account, appointment.id]);
  const worker = randomUUID();
  const delivery = await f.base.call<{ id: string }>('select dental.claim_admin_delivery($1) as result', [worker]);
  expect(delivery).not.toBeNull();
  return { owner, target, patient, worker, delivery };
}

// These regressions catch live-role bypass, account-only issuer/revalidation
// checks, stale grant targeting, or loss of the shared notification account fence.
describe('real PG17 invitation authority and frozen combined notification compatibility', () => {
  beforeEach(async () => { f = await AdminManagementFixture.create(); });
  afterEach(async () => {
    if (!f) return;
    // Own synthetic clone only; close owned sessions before deleting its dependent rows.
    await f.base.closeSessions();
    for (const table of ['patient_dispatch_authorizations', 'patient_notification_budget_reservations', 'admin_notification_budget_reservations', 'admin_notification_attempts', 'admin_booking_deliveries', 'admin_booking_events', 'notification_booking_enrollments', 'notification_attempts', 'outbox', 'admin_notification_budget']) await f.control.query(`delete from dental.${table}`);
    await f.control.query("delete from dental.line_reachability where provider in ('line:synthetic-fence-admin','line:synthetic-fence-patient')");
    await f.close();
  });

  it('ordinary peers cannot revoke through forged flags, and stale approver sessions fail against real SQL', async () => {
    const owner = await f.owner(), issuer = await f.admin(), peer = await f.admin(), recipient = await f.account();
    const h = http(peer.account), item = await claimed(f, issuer, recipient);
    expect((await h.revoke(issuer.grant)).status).toBe(403);
    expect((await grants(f, issuer.account))[0].revoked_at).toBeNull();
    expect((await http(owner.account).revoke(peer.grant)).status).toBe(200);
    const response = await h.app.fetch(req(`/api/admin/management/invitations/${item.invitation.id}/approve`, { version: item.invitation.version, verificationCode: item.approve.verificationCode }, headers));
    expect(response.status).toBe(403); expect(await grants(f, recipient)).toEqual([]);
    expect(await row(f, item.invitation.id)).toMatchObject({ state: 'claimed', version: 2 });
  });

  it('a newly approved issuer grant never revives its original pending invitations or cascades approved peers', async () => {
    const owner = await f.owner(), issuer = await f.admin(), pendingRecipient = await f.account(), approvedPeer = await f.account();
    const pending = await claimed(f, issuer, pendingRecipient), approved = await claimed(f, issuer, approvedPeer);
    value(await f.store.approve(owner.account, approved.approve));
    expect((await http(owner.account).revoke(issuer.grant)).status).toBe(200);
    const replacement = await claimed(f, owner, issuer.account); value(await f.store.approve(owner.account, replacement.approve));
    const active = (await grants(f, issuer.account)).filter(grant => grant.revoked_at === null);
    expect(active).toHaveLength(1); expect(active[0].id).not.toBe(issuer.grant);
    expect((await f.store.ownClaims(pendingRecipient, null)).items[0]).toMatchObject({ invitation: { state: 'invalidated' }, verificationCode: null });
    expect(await f.store.approve(owner.account, pending.approve)).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect((await grants(f, approvedPeer)).filter(grant => grant.revoked_at === null)).toHaveLength(1);
    expect((await http(owner.account).revoke(issuer.grant)).status).toBe(200);
    expect((await grants(f, issuer.account)).filter(grant => grant.revoked_at === null).map(grant => grant.id)).toEqual([active[0].id]);
  });

  for (const order of ['prepare-first', 'revoke-first'] as const) {
    it(`serializes ${order} with HTTP owner revoke, keeps the patient lane eligible, and never revives the old delivery`, async () => {
      const q = await notificationQueue(), h = http(q.owner.account), prepare = await f.base.session(), revoke = await f.base.session();
      let announce!: () => void; const called = new Promise<void>(resolve => { announce = resolve; });
      h.deps.adminManagement = createAdminManagementStore({ query: async (sql, values) => { announce(); return revoke.client.query(sql, values); } });
      let pendingPrepare: Promise<{ rows: { result: unknown }[] }> | undefined, pendingRevoke: Promise<Response> | undefined;
      try {
        const runPrepare = () => prepare.client.query('select dental.prepare_admin_dispatch($1,$2,$3,$4::jsonb) as result', [q.worker, q.delivery.id, origin, JSON.stringify(quota)]);
        if (order === 'prepare-first') {
          expect((await runPrepare()).rows[0].result).toHaveProperty('delivery');
          pendingRevoke = h.revoke(q.target.grant); void pendingRevoke.catch(() => {}); await called;
          await f.base.waitForLockWaiters([revoke.pid], prepare.pid);
          await prepare.client.query('commit'); expect((await pendingRevoke).status).toBe(200); await revoke.client.query('commit');
        } else {
          expect((await h.revoke(q.target.grant)).status).toBe(200);
          pendingPrepare = runPrepare(); void pendingPrepare.catch(() => {});
          await f.base.waitForLockWaiters([prepare.pid], revoke.pid);
          await revoke.client.query('commit'); expect((await pendingPrepare).rows[0].result).toBeNull(); await prepare.client.query('commit');
        }
        // Management grants/revocations do not acquire or invalidate patient lane locks.
        const patientWorker = randomUUID(), event = await f.base.call<{ id: string }>('select dental.claim_patient_event($1) as result', [patientWorker]);
        expect(event).not.toBeNull();
        const patient = await f.base.call('select dental.prepare_patient_dispatch($1,$2,$3,$4::jsonb) as result', [patientWorker, event.id, origin, JSON.stringify(quota)]);
        expect(patient).toMatchObject({ status: 'approved', payloadVersion: 1 });
        expect(await f.base.call('select dental.revalidate_patient_dispatch($1,$2) as result', [patientWorker, event.id])).toBe(true);
        // Regrant through the invitation path itself, rather than bypassing it with an operator.
        const invitation = await claimed(f, q.owner, q.target.account); value(await f.store.approve(q.owner.account, invitation.approve));
        expect(await f.base.call('select dental.revalidate_admin_dispatch($1,$2) as result', [q.worker, q.delivery.id])).toBe(false);
        expect(await f.base.call('select dental.claim_admin_delivery($1) as result', [randomUUID()])).toBeNull();
        expect((await f.control.query('select grant_id from dental.admin_booking_deliveries where id=$1', [q.delivery.id])).rows[0].grant_id).toBe(q.target.grant);
        expect((await grants(f, q.target.account)).filter(grant => grant.revoked_at === null)[0].id).not.toBe(q.target.grant);
      } finally {
        await prepare.client.query('rollback'); await revoke.client.query('rollback');
        await pendingPrepare?.catch(() => {}); await pendingRevoke?.catch(() => {});
        await f.base.closeSession(prepare); await f.base.closeSession(revoke);
      }
    });
  }
});
