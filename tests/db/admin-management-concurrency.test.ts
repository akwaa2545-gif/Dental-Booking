import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownClaimSchema, type ManagementResult } from '../../src/shared/admin-management';
import { AdminManagementFixture } from '../support/admin-management-postgres';
import { audits, claimed, code, createInput, grants, issued, operatorGrant, row, value } from '../support/admin-management-lifecycle';
import { booking } from '../support/reservation-postgres';
let f: AdminManagementFixture;
const rpc = async (client: pg.Client, name: string, actor: string, input: unknown): Promise<ManagementResult<unknown>> =>
  (await client.query(`select dental.${name}($1,$2::jsonb) as result`, [actor, JSON.stringify(input)])).rows[0].result;
async function serialized(first: (client: pg.Client) => Promise<unknown>, second: (client: pg.Client) => Promise<unknown>) {
  const a = await f.base.session(), b = await f.base.session(); let pending: Promise<unknown> | undefined;
  try {
    expect(a.pid).not.toBe(b.pid); const winner = await first(a.client);
    pending = second(b.client); void pending.catch(() => {}); await f.base.waitForLockWaiters([b.pid], a.pid);
    await a.client.query('commit'); const loser = await pending; await b.client.query('commit'); return [winner, loser];
  } finally { await a.client.query('rollback'); await pending?.catch(() => {}); await f.base.closeSession(a); await f.base.closeSession(b); }
}
async function operatorFirst(target: string, mutate: (client: pg.Client) => Promise<void>, request: (client: pg.Client) => Promise<unknown>, whileWaiting?: () => Promise<void>) {
  const operator = await f.database.connect(), backend = await f.base.session(); let pending: Promise<unknown> | undefined;
  try {
    await operator.query('set session authorization postgres; begin');
    await operator.query("select pg_advisory_xact_lock(hashtextextended('dental.admin:'||$1::text,0))", [target]);
    const pid = (await operator.query('select pg_backend_pid() as pid')).rows[0].pid;
    pending = request(backend.client); void pending.catch(() => {}); await f.base.waitForLockWaiters([backend.pid], pid);
    await mutate(operator); await whileWaiting?.(); await operator.query('commit');
    const result = await pending; await backend.client.query('commit'); return result;
  } finally { await operator.query('rollback'); await pending?.catch(() => {}); await operator.end(); await f.base.closeSession(backend); }
}
// Every ordering is established by server-observed waits on independent clients.
describe('real PostgreSQL admin membership concurrency', () => {
  beforeEach(async () => { f = await AdminManagementFixture.create(); });
  afterEach(async () => { await f?.close(); });
  it('suppresses the code when a claim crosses expiry during its post-write audit wait', async () => {
    const issuer = await f.admin(), recipient = await f.account(), item = await issued(f, issuer);
    const blocker = await f.database.connect(), requester = await f.base.session(); let pending: Promise<ManagementResult<unknown>> | undefined;
    try {
      await blocker.query('begin; lock dental.admin_management_audit in share mode');
      const pid = (await blocker.query('select pg_backend_pid() as pid')).rows[0].pid;
      pending = rpc(requester.client, 'admin_invitation_claim', recipient, { tokenHash: item.input.tokenHash, verificationCode: code }); void pending.catch(() => {});
      // This audit-table barrier is reached after the claim update and its last
      // eligibility check. A pre-account-lock expiry test cannot cover it.
      await f.base.waitForLockWaiters([requester.pid], pid);
      await f.base.setClock(item.invitation.expiresAt); await blocker.query('commit');
      const result = await pending; await requester.client.query('commit');
      const own = value(result);
      expect(ownClaimSchema.safeParse(own).success).toBe(true);
      expect(own).toMatchObject({ invitation: { state: 'expired', version: 2 }, verificationCode: null });
      expect(await row(f, item.invitation.id)).toMatchObject({ state: 'claimed', claimant_account_id: recipient });
      expect((await audits(f, item.invitation.id)).filter(a => a.action === 'invitation_claimed')).toHaveLength(1);
      expect((await f.store.ownClaims(recipient, null)).items[0]).toEqual(own);
      expect(await f.store.claim(recipient, { tokenHash: item.input.tokenHash, verificationCode: code })).toEqual({ ok: false, code: 'NOT_FOUND' });
      expect(await grants(f, recipient)).toEqual([]);
    } finally { await blocker.query('rollback'); await pending?.catch(() => {}); await blocker.end(); await f.base.closeSession(requester); }
  });
  it('binds only the winning claimant under concurrent acceptance', async () => {
    const issuer = await f.admin(), a = await f.account(), b = await f.account(), item = await issued(f, issuer);
    const results = await serialized(c => rpc(c, 'admin_invitation_claim', a, { tokenHash: item.input.tokenHash, verificationCode: code }), c => rpc(c, 'admin_invitation_claim', b, { tokenHash: item.input.tokenHash, verificationCode: '11111111' }));
    expect(results[0]).toMatchObject({ ok: true }); expect(results[1]).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect((await row(f, item.invitation.id)).claimant_account_id).toBe(a);
    expect((await audits(f, item.invitation.id)).filter(audit => audit.action === 'invitation_claimed')).toHaveLength(1);
  });
  it('inserts one grant and approval audit under two distinct approvers', async () => {
    const issuer = await f.admin(), peer = await f.admin(), recipient = await f.account(), item = await claimed(f, issuer, recipient);
    const results = await serialized(c => rpc(c, 'admin_management_approve', issuer.account, item.approve), c => rpc(c, 'admin_management_approve', peer.account, item.approve));
    expect(results[0]).toMatchObject({ ok: true }); expect(results[1]).toMatchObject({ ok: false });
    expect(await grants(f, recipient)).toHaveLength(1); expect((await audits(f, item.invitation.id)).filter(a => a.action === 'invitation_approved')).toHaveLength(1);
  });
  it.each(['claim', 'approve'] as const)('rechecks original issuer after operator revocation races with %s', async action => {
    const issuer = await f.admin(), peer = await f.admin(), recipient = await f.account(), item = action === 'claim' ? await issued(f, issuer) : await claimed(f, issuer, recipient);
    const result = await operatorFirst(issuer.account, async c => { await c.query('select dental.set_admin_grant($1,$2,false,$3)', [peer.account, issuer.account, 'Synthetic racing revoke']); },
      c => action === 'claim' ? rpc(c, 'admin_invitation_claim', recipient, { tokenHash: item.input.tokenHash, verificationCode: code }) : rpc(c, 'admin_management_approve', peer.account, { invitationId: item.invitation.id, version: 2, verificationCode: code }));
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND' }); expect(await grants(f, recipient)).toEqual([]);
  });
  it('rejects approval when operator grants its bound recipient while it waits', async () => {
    const issuer = await f.admin(), recipient = await f.account(), item = await claimed(f, issuer, recipient);
    const result = await operatorFirst(recipient, async c => { await c.query('select dental.set_admin_grant($1,$2,true,$3)', [issuer.account, recipient, 'Synthetic competing grant']); }, c => rpc(c, 'admin_management_approve', issuer.account, item.approve));
    expect(result).toEqual({ ok: false, code: 'DUPLICATE' }); expect(await grants(f, recipient)).toHaveLength(1);
    expect((await audits(f, item.invitation.id)).some(a => a.action === 'invitation_approved')).toBe(false);
  });
  it('rechecks approver authority after waiting, even if its session was formerly an admin', async () => {
    const issuer = await f.admin(), peer = await f.admin(), recipient = await f.account(), item = await claimed(f, issuer, recipient);
    const result = await operatorFirst(peer.account, async c => { await c.query('select dental.set_admin_grant($1,$2,false,$3)', [issuer.account, peer.account, 'Synthetic stale approver']); }, c => rpc(c, 'admin_management_approve', peer.account, item.approve));
    expect(result).toEqual({ ok: false, code: 'FORBIDDEN' }); expect(await grants(f, recipient)).toEqual([]);
  });
  it('uses the post-wait database clock at the exact expiry boundary', async () => {
    const issuer = await f.admin(), recipient = await f.account(), item = await claimed(f, issuer, recipient);
    const result = await operatorFirst(issuer.account, async () => {}, c => rpc(c, 'admin_management_approve', issuer.account, item.approve), () => f.base.setClock(item.invitation.expiresAt));
    expect(result).toEqual({ ok: false, code: 'NOT_FOUND' }); expect(await grants(f, recipient)).toEqual([]);
  });
  it('serializes creation at the durable twentieth slot and exact replay consumes none', async () => {
    const issuer = await f.admin(); for (let n = 0; n < 19; n++) await issued(f, issuer);
    const input = createInput(); const results = await serialized(c => rpc(c, 'admin_management_create', issuer.account, input), c => rpc(c, 'admin_management_create', issuer.account, createInput()));
    expect(results[0]).toMatchObject({ ok: true }); expect(results[1]).toEqual({ ok: false, code: 'RATE_LIMITED' });
    expect(value(await f.store.create(issuer.account, input)).created).toBe(false);
    expect((await f.control.query('select count(*)::int as n from dental.admin_invitations')).rows[0].n).toBe(20);
  });
  it('does not charge two stale concurrent verification submissions twice', async () => {
    const issuer = await f.admin(), peer = await f.admin(), recipient = await f.account(), item = await claimed(f, issuer, recipient);
    const input = { ...item.approve, verificationCode: '99999999' };
    const results = await serialized(c => rpc(c, 'admin_management_approve', issuer.account, input), c => rpc(c, 'admin_management_approve', peer.account, input));
    expect(results).toEqual([{ ok: false, code: 'INVALID_TRANSITION', version: 3, attemptsRemaining: 4 }, { ok: false, code: 'VERSION_CONFLICT', version: 3 }]);
    expect((await row(f, item.invitation.id)).failed_verification_count).toBe(1);
  });
  it('serializes concurrent revocation and keeps the protected owner active', async () => {
    const owner = await f.owner(), target = await f.admin(); const input = { grantId: target.grant, reason: 'Synthetic revoke' };
    expect(await serialized(c => rpc(c, 'admin_management_revoke', owner.account, input), c => rpc(c, 'admin_management_revoke', owner.account, input))).toEqual([{ ok: true, value: { revoked: true } }, { ok: true, value: { revoked: false } }]);
    expect((await grants(f, owner.account))[0].revoked_at).toBeNull();
    expect((await f.control.query("select count(*)::int as n from dental.admin_management_audit where action='admin_revoked'")).rows[0].n).toBe(1);
  });
  it('never applies a stale exact-grant revoke to an operator replacement grant', async () => {
    const owner = await f.owner(), target = await f.admin();
    const result = await operatorFirst(target.account, async c => {
      await c.query('select dental.set_admin_grant($1,$2,false,$3)', [owner.account, target.account, 'Synthetic old grant']);
      await c.query('select dental.set_admin_grant($1,$2,true,$3)', [owner.account, target.account, 'Synthetic replacement']);
    }, c => rpc(c, 'admin_management_revoke', owner.account, { grantId: target.grant, reason: 'Stale selection' }));
    expect(result).toEqual({ ok: true, value: { revoked: false } }); expect((await grants(f, target.account)).filter(g => g.revoked_at === null)).toHaveLength(1);
  });
  it('holds issuer and recipient account fences until approval commits before an operator revoke', async () => {
    const issuer = await f.admin(), recipient = await f.account(), item = await claimed(f, issuer, recipient), management = await f.base.session(), operator = await f.database.connect(); let pending: Promise<unknown> | undefined;
    try {
      value(await rpc(management.client, 'admin_management_approve', issuer.account, item.approve));
      await operator.query('set session authorization postgres; begin'); const pid = (await operator.query('select pg_backend_pid() as pid')).rows[0].pid;
      pending = operator.query('select dental.set_admin_grant($1,$2,false,$3)', [issuer.account, issuer.account, 'Synthetic post-approval revoke']); void pending.catch(() => {});
      await f.base.waitForLockWaiters([pid], management.pid); await management.client.query('commit'); await pending; await operator.query('commit');
      expect((await grants(f, recipient))[0].revoked_at).toBeNull();
    } finally { await management.client.query('rollback'); await pending?.catch(() => {}); await f.base.closeSession(management); await operator.end(); }
  });
  it.each(['revoke-first', 'prepare-first'] as const)('preserves frozen notification eligibility with %s and never revives old deliveries', async order => {
    const owner = await f.owner(), target = await f.admin(), patient = await f.account(), provider = 'line:synthetic-admin', subject = `U${target.account.replaceAll('-', '')}`;
    await f.control.query('update dental.accounts set provider=$2,subject=$3 where id=$1', [target.account, provider, subject]);
    await f.control.query("insert into dental.line_reachability(provider,subject,reachable,event_at,event_id,updated_at) values($1,$2,true,dental.clock_now(),'01J00000000000000000000000',dental.clock_now())", [provider, subject]);
    await f.operatorCall('select dental.set_admin_notification_policy($1,1,true,$2,$3,$4) as result', [owner.account, '2026-10-08T05:00:00Z', '2026-10-15T05:00:00Z', 'Synthetic concurrency policy']);
    await f.operatorCall('select dental.set_admin_notification_budget($1,0,$2,$3,300,0,true,$4) as result', [owner.account, '2026-10-08T05:00:00Z', '2026-10-09T05:00:00Z', 'Synthetic concurrency budget']);
    try {
      await f.base.reserve(patient, randomUUID(), booking(await f.base.patient(patient)));
      const worker = randomUUID(), delivery = await f.base.call<{ id: string }>('select dental.claim_admin_delivery($1) as result', [worker]); expect(delivery).not.toBeNull();
      const revoke = (c: pg.Client) => rpc(c, 'admin_management_revoke', owner.account, { grantId: target.grant, reason: 'Synthetic fence revoke' });
      const prepare = async (c: pg.Client) => (await c.query('select dental.prepare_admin_dispatch($1,$2,$3,$4::jsonb) as result', [worker, delivery.id, 'https://tooth-talk-staging.tooth-talk-staging-f7ff4a96.workers.dev', JSON.stringify({ type: 'limited', value: 300, totalUsage: 0, observedAt: '2026-10-08T05:00:00Z' })])).rows[0].result;
      const results = await serialized(order === 'revoke-first' ? revoke : prepare, order === 'revoke-first' ? prepare : revoke);
      if (order === 'revoke-first') expect(results).toEqual([{ ok: true, value: { revoked: true } }, null]);
      else { expect(results[0]).toHaveProperty('delivery'); expect(results[1]).toEqual({ ok: true, value: { revoked: true } }); }
      await operatorGrant(f, owner.account, target.account, true);
      expect(await f.base.call('select dental.revalidate_admin_dispatch($1,$2) as result', [worker, delivery.id])).toBe(false);
      expect(await f.base.call('select dental.claim_admin_delivery($1) as result', [randomUUID()])).toBeNull();
      expect((await f.control.query('select grant_id from dental.admin_booking_deliveries where id=$1', [delivery.id])).rows[0].grant_id).toBe(target.grant);
    } finally {
      // Only this clone's synthetic notification rows; base fixture still owns booking cleanup.
      for (const table of ['patient_dispatch_authorizations', 'patient_notification_budget_reservations', 'admin_notification_budget_reservations', 'admin_notification_attempts', 'admin_booking_deliveries', 'admin_booking_events', 'notification_booking_enrollments', 'notification_attempts', 'outbox', 'admin_notification_budget']) await f.control.query(`delete from dental.${table}`);
      await f.control.query('delete from dental.line_reachability where provider=$1 and subject=$2', [provider, subject]);
      await f.control.query('update dental.admin_notification_policy set enabled=false,version=1,activation_at=null,authorized_end_at=null');
    }
  });
});
