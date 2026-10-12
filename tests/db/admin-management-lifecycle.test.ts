import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdminManagementFixture } from '../support/admin-management-postgres';
import { audits, claimed, code, createInput, grants, issued, operatorGrant, row, value } from '../support/admin-management-lifecycle';
let f: AdminManagementFixture;
// Each assertion targets a production mutation: missing authority recheck,
// replay creating a second grant, rolled-back failures, or an exposed old code.
describe('real PostgreSQL atomic admin invitation lifecycle', () => {
  beforeEach(async () => { f = await AdminManagementFixture.create(); });
  afterEach(async () => { await f?.close(); });
  it('exposes only narrow backend mutation functions and no operator or direct writes', async () => {
    for (const name of ['admin_management_create', 'admin_invitation_claim', 'admin_management_approve', 'admin_management_close', 'admin_management_revoke']) {
      const signature = `dental.${name}(uuid,jsonb)`;
      expect((await f.control.query('select to_regprocedure($1) is not null as present', [signature])).rows[0].present).toBe(true);
      expect(await f.backendHasExecute(signature)).toBe(true);
      for (const role of ['anon', 'authenticated', 'service_role']) expect((await f.control.query("select has_function_privilege($1,$2,'EXECUTE') as allowed", [role, signature])).rows[0].allowed).toBe(false);
    }
    expect(await f.backendHasExecute('dental.set_admin_grant(uuid,uuid,boolean,text)')).toBe(false);
    expect((await f.control.query("select has_any_column_privilege('dental_backend','dental.admin_invitations','INSERT,UPDATE') as allowed")).rows[0].allowed).toBe(false);
  });
  it('creates exact 24-hour invitations from the current grant and replays only identical material inputs', async () => {
    const issuer = await f.admin(), { input, invitation } = await issued(f, issuer);
    expect(Date.parse(invitation.expiresAt) - Date.parse(invitation.createdAt)).toBe(86_400_000);
    expect(await row(f, invitation.id)).toMatchObject({ issuer_account_id: issuer.account, issuer_grant_id: issuer.grant, token_hash: input.tokenHash, version: 1 });
    expect(value(await f.store.create(issuer.account, input))).toEqual({ invitation, created: false });
    for (const changed of [{ tokenHash: 'a'.repeat(64) }, { label: 'Different' }, { reason: 'Different' }]) expect(await f.store.create(issuer.account, { ...input, ...changed })).toEqual({ ok: false, code: 'DUPLICATE' });
    expect(await audits(f, invitation.id)).toEqual([{ action: 'invitation_created', result: 'success' }]);
    expect(await f.store.create(await f.account(), createInput())).toEqual({ ok: false, code: 'FORBIDDEN' });
  });
  it('binds one claimant and recovers its original leading-zero code without extending expiry', async () => {
    const issuer = await f.admin(), recipient = await f.account(), other = await f.account(), item = await claimed(f, issuer, recipient);
    const repeat = value(await f.store.claim(recipient, { tokenHash: item.input.tokenHash, verificationCode: '99999999' }));
    expect(repeat).toMatchObject({ invitation: item.invitation, verificationCode: code });
    expect(await f.store.claim(other, { tokenHash: item.input.tokenHash, verificationCode: code })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect((await f.store.ownClaims(other, null)).items).toEqual([]);
    expect((await f.store.ownClaims(recipient, null)).items[0]).toEqual(repeat);
    expect((await audits(f, item.invitation.id)).filter(a => a.action === 'invitation_claimed')).toHaveLength(1);
  });
  it('lets any active admin approve exactly once without assigning owner authority', async () => {
    const issuer = await f.admin(), peer = await f.admin(), recipient = await f.account(), item = await claimed(f, issuer, recipient);
    const approved = value(await f.store.approve(peer.account, item.approve));
    expect(approved).toMatchObject({ state: 'approved', version: 3, canClose: false });
    expect(value(await f.store.approve(peer.account, item.approve))).toEqual(approved);
    expect(await f.store.approve(issuer.account, item.approve)).toMatchObject({ ok: false });
    expect(await grants(f, recipient)).toHaveLength(1);
    expect((await grants(f, recipient))[0]).toMatchObject({ granted_by: peer.account, revoked_at: null });
    expect(await row(f, approved.id)).toMatchObject({ approved_by: peer.account, verification_code: null });
    expect(await f.store.capabilities(recipient)).toEqual({ canRevokeAdmins: false });
    expect((await audits(f, approved.id)).filter(a => a.action === 'invitation_approved')).toHaveLength(1);
    expect((await f.store.ownClaims(recipient, null)).items[0].verificationCode).toBeNull();
  });
  it('preserves approved peers after issuer revocation and never regrants on historical replay', async () => {
    const issuer = await f.admin(), peer = await f.admin(), recipient = await f.account(), item = await claimed(f, issuer, recipient);
    value(await f.store.approve(peer.account, item.approve));
    await operatorGrant(f, peer.account, issuer.account, false);
    expect((await grants(f, recipient))[0].revoked_at).toBeNull();
    await operatorGrant(f, peer.account, recipient, false);
    expect(value(await f.store.approve(peer.account, item.approve)).state).toBe('approved');
    expect(await grants(f, recipient)).toHaveLength(1); expect((await grants(f, recipient))[0].revoked_at).not.toBeNull();
  });
  it('persists all five wrong-code attempts across approvers and erases the terminal code', async () => {
    const issuer = await f.admin(), peer = await f.admin(), recipient = await f.account(), item = await claimed(f, issuer, recipient);
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(await f.store.approve(attempt % 2 ? peer.account : issuer.account, { ...item.approve, version: attempt + 1, verificationCode: '99999999' })).toEqual({ ok: false, code: 'INVALID_TRANSITION', version: attempt + 2, attemptsRemaining: 5 - attempt });
      expect(await row(f, item.invitation.id)).toMatchObject({ failed_verification_count: attempt, version: attempt + 2 });
    }
    expect(await row(f, item.invitation.id)).toMatchObject({ state: 'locked', verification_code: null });
    expect(await f.store.approve(peer.account, { ...item.approve, version: 7 })).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
    expect((await audits(f, item.invitation.id)).filter(a => a.result === 'invalid_transition')).toHaveLength(5);
    expect(await grants(f, recipient)).toEqual([]);
  });
  it('does not charge stale-version or unauthorized approval attempts', async () => {
    const issuer = await f.admin(), recipient = await f.account(), item = await claimed(f, issuer, recipient);
    expect(await f.store.approve(issuer.account, { ...item.approve, version: 1, verificationCode: '99999999' })).toEqual({ ok: false, code: 'VERSION_CONFLICT', version: 2 });
    expect(await f.store.approve(recipient, item.approve)).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect((await row(f, item.invitation.id)).failed_verification_count).toBe(0);
  });
  it('rejects an already-granted claimant without renewing its grant', async () => {
    const issuer = await f.admin(), target = await f.admin(), item = await claimed(f, issuer, target.account);
    expect(await f.store.approve(issuer.account, item.approve)).toEqual({ ok: false, code: 'DUPLICATE' });
    expect(await grants(f, target.account)).toHaveLength(1); expect((await grants(f, target.account))[0].id).toBe(target.grant);
    expect((await row(f, item.invitation.id)).state).toBe('claimed');
  });
  it.each(['claim', 'approve'] as const)('invalidates %s after original issuer grant revocation and regrant', async action => {
    const issuer = await f.admin(), peer = await f.admin(), recipient = await f.account(), item = await issued(f, issuer);
    if (action === 'approve') value(await f.store.claim(recipient, { tokenHash: item.input.tokenHash, verificationCode: code }));
    await operatorGrant(f, peer.account, issuer.account, false); await operatorGrant(f, peer.account, issuer.account, true);
    const result = action === 'claim' ? await f.store.claim(recipient, { tokenHash: item.input.tokenHash, verificationCode: code }) : await f.store.approve(peer.account, { invitationId: item.invitation.id, version: 2, verificationCode: code });
    expect(result).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect((await row(f, item.invitation.id)).issuer_grant_id).toBe(issuer.grant);
    expect(await grants(f, recipient)).toEqual([]);
  });
  it('expires at the exact deadline for claim, recovery and approval', async () => {
    const issuer = await f.admin(), recipient = await f.account(), item = await claimed(f, issuer, recipient), second = await issued(f, issuer);
    await f.base.setClock(item.invitation.expiresAt);
    expect(await f.store.claim(recipient, { tokenHash: second.input.tokenHash, verificationCode: code })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await f.store.claim(recipient, { tokenHash: item.input.tokenHash, verificationCode: code })).toEqual({ ok: false, code: 'NOT_FOUND' });
    expect(await f.store.approve(issuer.account, item.approve)).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect((await f.store.ownClaims(recipient, null)).items[0]).toMatchObject({ verificationCode: null, invitation: { state: 'expired' } });
  });
  it.each(['cancel', 'reject'] as const)('restricts %s to the original issuer or owner, erases code and replays safely', async action => {
    const issuer = await f.admin(), peer = await f.admin(), owner = await f.owner(), recipient = await f.account(), item = await claimed(f, issuer, recipient);
    const input = { invitationId: item.invitation.id, version: 2, action, reason: 'Synthetic closure' };
    expect(await f.store.close(peer.account, input)).toEqual({ ok: false, code: 'FORBIDDEN' });
    const actor = action === 'cancel' ? issuer.account : owner.account;
    const closed = value(await f.store.close(actor, input));
    expect(closed.state).toBe(action === 'cancel' ? 'cancelled' : 'rejected');
    expect(value(await f.store.close(actor, input))).toEqual(closed);
    expect((await row(f, closed.id)).verification_code).toBeNull();
    expect(await f.store.approve(peer.account, { ...item.approve, version: 3 })).toMatchObject({ ok: false });
    expect((await audits(f, closed.id)).filter(a => a.action === `invitation_${closed.state}`)).toHaveLength(1);
  });
  it('lets only active owner close expired or invalidated unfinished rows', async () => {
    const issuer = await f.admin(), owner = await f.owner(), recipient = await f.account(), item = await claimed(f, issuer, recipient);
    await operatorGrant(f, owner.account, issuer.account, false); await operatorGrant(f, owner.account, issuer.account, true);
    expect((await f.store.invitations(owner.account, null)).items[0]).toMatchObject({ state: 'invalidated', canClose: true });
    expect((await f.store.invitations(issuer.account, null)).items[0].canClose).toBe(false);
    const close = { invitationId: item.invitation.id, version: 2, action: 'cancel' as const, reason: 'Cleanup invalidated' };
    expect(await f.store.close(issuer.account, close)).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(value(await f.store.close(owner.account, close)).state).toBe('cancelled');
    const expired = await issued(f, issuer); await f.base.setClock(expired.invitation.expiresAt);
    expect((await f.store.invitations(owner.account, null)).items[0].canClose).toBe(true);
    expect(value(await f.store.close(owner.account, { ...close, invitationId: expired.invitation.id, version: 1 })).state).toBe('cancelled');
  });
  it('requires active owner and exact grant for revocation and protects self, owner and last admin', async () => {
    const owner = await f.owner(), peer = await f.admin(), another = await f.admin();
    expect(await f.store.revoke(peer.account, { grantId: another.grant, reason: 'Denied' })).toEqual({ ok: false, code: 'FORBIDDEN' });
    expect(await f.store.revoke(owner.account, { grantId: owner.grant, reason: 'Protected' })).toMatchObject({ ok: false });
    const before = (await grants(f, peer.account))[0];
    expect(value(await f.store.revoke(owner.account, { grantId: peer.grant, reason: 'Synthetic revoke' }))).toEqual({ revoked: true });
    const after = (await grants(f, peer.account))[0]; expect({ ...after, revoked_at: before.revoked_at, revoked_by: before.revoked_by }).toEqual(before);
    await operatorGrant(f, owner.account, peer.account, true);
    expect(value(await f.store.revoke(owner.account, { grantId: peer.grant, reason: 'Stale confirmation' }))).toEqual({ revoked: false });
    expect((await grants(f, peer.account)).filter(g => g.revoked_at === null)).toHaveLength(1);
    await operatorGrant(f, peer.account, owner.account, false);
    expect(await f.store.revoke(owner.account, { grantId: another.grant, reason: 'Stale owner' })).toEqual({ ok: false, code: 'FORBIDDEN' });
  });
  it('protects the sole owner and fails closed without an owner designation', async () => {
    const sole = await f.admin();
    expect(await f.store.revoke(sole.account, { grantId: sole.grant, reason: 'No owner' })).toEqual({ ok: false, code: 'FORBIDDEN' });
    await f.operatorCall('select dental.set_admin_management_owner($1,$1,$2) as result', [sole.account, 'Synthetic sole owner']);
    expect(await f.store.revoke(sole.account, { grantId: sole.grant, reason: 'Last admin' })).toMatchObject({ ok: false });
    expect((await grants(f, sole.account))[0].revoked_at).toBeNull();
  });
  it('bounds new creations to 20 per rolling 24 hours without charging exact replays', async () => {
    const issuer = await f.admin(); const first = await issued(f, issuer);
    for (let i = 1; i < 20; i++) value(await f.store.create(issuer.account, createInput()));
    expect(value(await f.store.create(issuer.account, first.input)).created).toBe(false);
    expect(await f.store.create(issuer.account, createInput())).toEqual({ ok: false, code: 'RATE_LIMITED' });
    await f.base.setClock('2026-10-09T04:59:59.999999Z'); expect(await f.store.create(issuer.account, createInput())).toEqual({ ok: false, code: 'RATE_LIMITED' });
    await f.base.setClock(first.invitation.expiresAt); value(await f.store.create(issuer.account, createInput()));
    expect((await f.control.query('select count(*)::int as n from dental.admin_invitations')).rows[0].n).toBe(21);
  });
  it('erases at most 50 expired pending codes opportunistically per mutation, retaining audit and history', async () => {
    const issuer = await f.admin(), recipient = await f.account();
    for (let i = 0; i < 53; i++) await f.invitation(issuer, recipient, '2026-10-07T05:00:00Z');
    value(await f.store.create(issuer.account, createInput()));
    expect((await f.control.query('select count(*)::int as n from dental.admin_invitations where verification_code is not null')).rows[0].n).toBe(3);
    value(await f.store.create(issuer.account, createInput()));
    expect((await f.control.query('select count(*)::int as n from dental.admin_invitations where verification_code is not null')).rows[0].n).toBe(0);
    expect((await f.control.query('select count(*)::int as n from dental.admin_invitations')).rows[0].n).toBe(55);
  });
  it('rolls state and grants back if the matching audit insert cannot commit', async () => {
    const issuer = await f.admin(), recipient = await f.account(), item = await claimed(f, issuer, recipient);
    await f.control.query("alter table dental.admin_management_audit add constraint synthetic_block_approval check(action<>'invitation_approved') not valid");
    await expect(f.store.approve(issuer.account, item.approve)).rejects.toThrow('UNAVAILABLE');
    expect((await row(f, item.invitation.id)).state).toBe('claimed'); expect(await grants(f, recipient)).toEqual([]);
    await f.control.query('alter table dental.admin_management_audit drop constraint synthetic_block_approval');
    value(await f.store.approve(issuer.account, item.approve));
  });
  it('validates SQL JSON keys, types, trimmed bounds, UUIDs, positive versions and eight-digit strings independently', async () => {
    const actor = (await f.admin()).account;
    const cases: [string, unknown][] = [
      ['create', { ...createInput(), actor }], ['create', { ...createInput(), label: '😀'.repeat(61) }], ['create', { ...createInput(), reason: '' }],
      ['create', { ...createInput(), label: null }], ['create', { ...createInput(), requestId: '12345678-1234-9234-1234-123456789abc' }],
      ['create', { ...createInput(), tokenHash: 'A'.repeat(64) }], ['create', []], ['create', null],
      ['approve', { invitationId: randomUUID(), version: 0, verificationCode: code }], ['approve', { invitationId: randomUUID(), version: 2147483648, verificationCode: code }],
      ['approve', { invitationId: randomUUID(), version: 1.5, verificationCode: code }], ['approve', { invitationId: randomUUID(), version: '2', verificationCode: code }],
      ['approve', { invitationId: randomUUID(), version: 2, verificationCode: 12345678 }], ['approve', { invitationId: randomUUID(), version: 2, verificationCode: '123' }],
      ['close', { invitationId: randomUUID(), version: 1, action: 'approve', reason: 'reason' }], ['revoke', { grantId: randomUUID(), reason: '😀'.repeat(251) }],
    ];
    for (const [name, input] of cases) await expect(f.base.call(`select dental.admin_management_${name}($1,$2::jsonb) as result`, [actor, JSON.stringify(input)])).rejects.toThrow('VALIDATION');
    const normalized = value(await f.base.call<Awaited<ReturnType<typeof f.store.create>>>('select dental.admin_management_create($1,$2::jsonb) as result', [actor, JSON.stringify({ ...createInput(), label: '  Colleague  ', reason: '  Context  ' })]));
    expect(normalized.invitation).toMatchObject({ label: 'Colleague', reason: 'Context' });
  });
});

// The base fixture can own identities independently of .admin(); lifecycle grants
// must not outlive their invitation when the clone is cleaned before its drop.
describe('RPC-created grant teardown', () => {
  it('cleans a lifecycle grant for a base-owned recipient before restoring clock and dropping the clone', async () => {
    const local = await AdminManagementFixture.create();
    const issuer = await local.admin(), recipient = await local.base.account(), item = await claimed(local, issuer, recipient);
    value(await local.store.approve(issuer.account, item.approve));
    const drop = local.database.close; let beforeDrop: unknown;
    local.database.close = async () => {
      const check = await local.database.connect();
      try { beforeDrop = (await check.query(`select (select count(*)::int from dental.admin_grants) as grants,
        (select count(*)::int from dental.accounts) as accounts,
        to_regnamespace('dental_test_reservations')::text as fixture`)).rows[0]; }
      finally { await check.end(); }
      await drop();
    };
    await local.close(); expect(beforeDrop).toEqual({ grants: 0, accounts: 0, fixture: null });
  });
});
