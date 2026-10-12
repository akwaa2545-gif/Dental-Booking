import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseManagementCursor } from '../../src/shared/admin-management';
import { localAdminConnection } from '../support/admin-notification-postgres';
import { AdminManagementFixture, OWNER_SIGNATURE } from '../support/admin-management-postgres';
let fixture: AdminManagementFixture;
// Mutation targets: ordinary-admin owner escalation, unverified designation,
// unsafe identity/code projections, stale issuer grants, expiry and cursor loss.
describe('real PostgreSQL management authority and safe reads', () => {
  beforeEach(async () => { fixture = await AdminManagementFixture.create(); });
  afterEach(async () => { await fixture?.close(); });
  it('keeps legacy grant and protected-owner setters inaccessible to backend', async () => {
    expect(await fixture.backendHasExecute('dental.set_admin_grant(uuid,uuid,boolean,text)')).toBe(false);
    expect(await fixture.backendHasExecute(OWNER_SIGNATURE)).toBe(false);
    const admin = await fixture.admin();
    await expect(fixture.base.call('select dental.set_admin_management_owner($1,$1,$2) as result', [admin.account, 'Forbidden backend escalation'])).rejects.toThrow(/permission denied/);
  });
  it('keeps peer-addition admins distinct from the explicitly designated active owner', async () => {
    const ordinary = await fixture.admin();
    expect(await fixture.store.capabilities(ordinary.account)).toEqual({ canRevokeAdmins: false });
    const owner = await fixture.owner();
    expect(await fixture.store.capabilities(owner.account)).toEqual({ canRevokeAdmins: true });
    expect(await fixture.store.capabilities(ordinary.account)).toEqual({ canRevokeAdmins: false });
    await fixture.control.query('update dental.admin_grants set revoked_at=dental.clock_now() where id=$1', [owner.grant]);
    await expect(fixture.store.capabilities(owner.account)).rejects.toThrow('FORBIDDEN');
  });
  it('requires existing operator and active target, records exact designation and never implicitly grants', async () => {
    const operator = await fixture.account(), target = await fixture.account();
    await expect(fixture.operatorCall('select dental.set_admin_management_owner($1,$2,$3) as result', [operator, target, 'Synthetic selection'])).rejects.toThrow('FORBIDDEN');
    expect((await fixture.control.query('select count(*)::integer as count from dental.admin_grants')).rows[0].count).toBe(0);
    const admin = await fixture.admin();
    await expect(fixture.operatorCall('select dental.set_admin_management_owner($1,$2,$3) as result', [randomUUID(), admin.account, 'Synthetic selection'])).rejects.toThrow('NOT_FOUND');
    expect(await fixture.operatorCall('select dental.set_admin_management_owner($1,$2,$3) as result', [operator, admin.account, '  Explicit synthetic selection  '])).toBe(true);
    expect((await fixture.control.query('select account_id,designated_by,reason from dental.admin_management_owner')).rows[0]).toEqual({ account_id: admin.account, designated_by: operator, reason: 'Explicit synthetic selection' });
    expect((await fixture.store.history(admin.account, null)).items[0]).toMatchObject({ action: 'owner_designated', targetReference: `A-${admin.account.replaceAll('-', '')}` });
  });
  it('rejects nonadmins and shows grant-version roster with only safe references and owner-only controls', async () => {
    const owner = await fixture.owner(), admin = await fixture.admin(), recipient = await fixture.account();
    for (const read of [fixture.store.capabilities, (actor: string) => fixture.store.roster(actor, null), (actor: string) => fixture.store.invitations(actor, null), (actor: string) => fixture.store.history(actor, null)]) await expect(read(recipient)).rejects.toThrow('FORBIDDEN');
    expect((await fixture.store.roster(admin.account, null)).items.every(row => !row.canRevoke)).toBe(true);
    const roster = (await fixture.store.roster(owner.account, null)).items;
    expect(roster.find(row => row.grantId === owner.grant)).toMatchObject({ protectedOwner: true, canRevoke: false, label: null });
    expect(roster.find(row => row.grantId === admin.grant)).toMatchObject({ protectedOwner: false, canRevoke: true, reference: `A-${admin.account.replaceAll('-', '')}` });
    expect(JSON.stringify(roster)).not.toContain('synthetic-task4');
  });
  it('returns a leading-zero code only to its exact claimant while the original claim is valid', async () => {
    const admin = await fixture.admin(), recipient = await fixture.account(), other = await fixture.account();
    const id = await fixture.invitation(admin, recipient);
    const own = await fixture.store.ownClaims(recipient, null);
    expect(own.items[0]).toMatchObject({ verificationCode: '00123456', invitation: { id, state: 'claimed', canClose: false } });
    expect((await fixture.store.ownClaims(other, null)).items).toEqual([]);
    expect(JSON.stringify(await fixture.store.invitations(admin.account, null))).not.toContain('00123456');
    expect((await fixture.store.invitations(admin.account, null)).items[0]).toMatchObject({ id, canClose: true, claimReference: `I-${id.replaceAll('-', '')}` });
    await fixture.base.setClock('2026-10-09T05:00:00.000001Z');
    expect((await fixture.store.ownClaims(recipient, null)).items[0]).toMatchObject({ verificationCode: null, invitation: { state: 'expired', canClose: false } });
    await fixture.control.query('update dental.admin_invitations set verification_code=null where id=$1', [id]);
  });
  it('does not revive old invitations after issuer revocation and a fresh grant', async () => {
    const issuer = await fixture.admin(), recipient = await fixture.account();
    await fixture.invitation(issuer, recipient);
    await fixture.control.query('update dental.admin_grants set revoked_at=dental.clock_now() where id=$1', [issuer.grant]);
    await fixture.control.query('insert into dental.admin_grants(account_id) values($1)', [issuer.account]);
    expect((await fixture.store.ownClaims(recipient, null)).items[0]).toMatchObject({ verificationCode: null, invitation: { state: 'invalidated', canClose: false } });
  });
  it('enforces labels, optional reasons, positive versions, exact expiry and code format in the table', async () => {
    const issuer = await fixture.admin(); const id = await fixture.invitation(issuer);
    for (const [column, value] of [['label', ' '], ['label', 'x'.repeat(121)], ['label', '😀'.repeat(61)], ['reason', ''], ['reason', 'x'.repeat(501)], ['reason', '😀'.repeat(251)], ['version', 0], ['verification_code', '1234'], ['expires_at', '2026-10-11T05:00:00Z']]) {
      await expect(fixture.control.query(`update dental.admin_invitations set ${column}=$2 where id=$1`, [id, value])).rejects.toThrow(/check constraint/);
    }
  });
  it('lets only issuer or protected owner close a valid invitation and never exposes a terminal code', async () => {
    const issuer = await fixture.admin(), peer = await fixture.admin(), owner = await fixture.owner(), recipient = await fixture.account();
    const id = await fixture.invitation(issuer, recipient);
    expect((await fixture.store.invitations(peer.account, null)).items[0].canClose).toBe(false);
    expect((await fixture.store.invitations(owner.account, null)).items[0].canClose).toBe(true);
    await fixture.control.query("update dental.admin_invitations set state='cancelled',closed_by=$2,closed_at=created_at,verification_code=null where id=$1", [id, issuer.account]);
    expect((await fixture.store.invitations(owner.account, null)).items).toEqual([]);
    expect((await fixture.store.ownClaims(recipient, null)).items[0]).toMatchObject({ invitation: { state: 'cancelled', canClose: false }, verificationCode: null });
  });
  it('paginates roster, invitation and history reads through the real strict adapter', async () => {
    const issuer = await fixture.admin();
    for (let i = 0; i < 50; i++) await fixture.admin();
    for (let i = 0; i < 51; i++) {
      await fixture.invitation(issuer);
      await fixture.control.query("insert into dental.admin_management_audit(action,actor_account_id,result,occurred_at) values('synthetic_read',$1,'success','2026-10-08T05:00:00.000009Z')", [issuer.account]);
    }
    for (const read of [fixture.store.roster, fixture.store.invitations, fixture.store.history]) {
      const first = await read(issuer.account, null);
      expect(first.items).toHaveLength(50); expect(first.nextCursor).not.toBeNull();
      const second = await read(issuer.account, first.nextCursor);
      expect(second.items).toHaveLength(1); expect(second.nextCursor).toBeNull();
      expect(new Set([...first.items, ...second.items].map(item => JSON.stringify(item))).size).toBe(51);
    }
  });
  it('rejects PostgreSQL-permissive timestamps and non-RFC UUID cursors at the SQL boundary', async () => {
    const account = await fixture.account();
    const examples = [
      { occurredAt: '2026-10-08T24:00:00Z', id: randomUUID() },
      { occurredAt: '2026-10-08T23:59:60Z', id: randomUUID() },
      { occurredAt: '2026-10-08T05:00:00Z', id: '12345678-1234-9234-1234-123456789abc' },
    ];
    for (const example of examples) {
      const cursor = Buffer.from(JSON.stringify(example)).toString('base64url');
      expect(() => parseManagementCursor(cursor)).toThrow('Invalid management cursor');
      await expect(fixture.base.call('select dental.admin_invitation_own_claims($1,$2) as result', [account, cursor])).rejects.toThrow('VALIDATION');
    }
  });
  it('rejects overlong UTF-16 owner reasons consistently with the shared DTO', async () => {
    const admin = await fixture.admin();
    await expect(fixture.operatorCall('select dental.set_admin_management_owner($1,$1,$2) as result', [admin.account, '😀'.repeat(251)])).rejects.toThrow('VALIDATION');
  });
  it('transfers only the explicit owner account and rolls back designation if its audit fails', async () => {
    const owner = await fixture.owner(), successor = await fixture.admin();
    const grantsBefore = (await fixture.control.query('select to_jsonb(g) as row from dental.admin_grants g order by id')).rows;
    await fixture.operatorCall('select dental.set_admin_management_owner($1,$2,$3) as result', [owner.account, successor.account, 'Synthetic exact transfer']);
    expect(await fixture.store.capabilities(owner.account)).toEqual({ canRevokeAdmins: false });
    expect(await fixture.store.capabilities(successor.account)).toEqual({ canRevokeAdmins: true });
    const audit = await fixture.store.history(successor.account, null);
    expect(audit.items.find(item => item.action === 'owner_transferred')).toMatchObject({ actorReference: `A-${owner.account.replaceAll('-', '')}`, targetReference: `A-${successor.account.replaceAll('-', '')}` });
    const before = (await fixture.control.query('select to_jsonb(o) as row from dental.admin_management_owner o')).rows;
    await fixture.control.query('revoke insert on dental.admin_management_audit from dental_function_owner');
    await expect(fixture.operatorCall('select dental.set_admin_management_owner($1,$2,$3) as result', [successor.account, owner.account, 'Synthetic rollback test'])).rejects.toThrow('permission denied');
    expect((await fixture.control.query('select to_jsonb(o) as row from dental.admin_management_owner o')).rows).toEqual(before);
    expect((await fixture.control.query('select to_jsonb(g) as row from dental.admin_grants g order by id')).rows).toEqual(grantsBefore);
  });
  it('checks target admin authority after the shared account fence releases', async () => {
    const operator = await fixture.account(), target = await fixture.admin();
    const blocker = await fixture.database.connect(), assigner = await fixture.database.connect();
    try {
      await blocker.query('begin');
      await blocker.query("select pg_advisory_xact_lock(hashtextextended('dental.admin:'||$1::text,0))", [target.account]);
      await assigner.query('set session authorization postgres');
      const pid = (await assigner.query('select pg_backend_pid() as pid')).rows[0].pid as number;
      const outcome = assigner.query('select dental.set_admin_management_owner($1,$2,$3)', [operator, target.account, 'Synthetic revoke race']).then(() => 'assigned', error => (error as Error).message);
      await fixture.base.waitForLockWaiters([pid]);
      await blocker.query('update dental.admin_grants set revoked_at=dental.clock_now() where id=$1', [target.grant]);
      await blocker.query('commit');
      expect(await outcome).toBe('FORBIDDEN');
      expect((await fixture.control.query('select count(*)::integer as count from dental.admin_management_owner')).rows[0].count).toBe(0);
    } finally { await blocker.query('rollback'); await blocker.end(); await assigner.end(); }
  });
  it('paginates 51 tied microsecond rows with canonical cursors and no omissions', async () => {
    const issuer = await fixture.admin(), recipient = await fixture.account();
    const ids = [];
    for (let n = 0; n < 51; n++) ids.push(await fixture.invitation(issuer, recipient));
    const first = await fixture.store.ownClaims(recipient, null);
    expect(first.items).toHaveLength(50);
    expect(parseManagementCursor(first.nextCursor)).toMatchObject({ occurredAt: '2026-10-08T05:00:00.000001Z' });
    const second = await fixture.store.ownClaims(recipient, first.nextCursor);
    expect(second.items).toHaveLength(1); expect(second.nextCursor).toBeNull();
    expect([...first.items, ...second.items].map(row => row.invitation.id).sort()).toEqual(ids.sort());
    for (const cursor of ['bad', Buffer.from('{"id":"'+ids[0]+'","occurredAt":"2026-10-08T05:00:00Z"}').toString('base64url'), Buffer.from('{"occurredAt":"2026-99-99T00:00:00Z","id":"'+ids[0]+'"}').toString('base64url')]) {
      await expect(fixture.base.call('select dental.admin_invitation_own_claims($1,$2) as result', [recipient, cursor])).rejects.toThrow('VALIDATION');
    }
  });
});

describe('management fixture session cleanup', () => {
  it('closes leaked base sessions before new foreign-key cleanup and disposable clone teardown', async () => {
    const local = await AdminManagementFixture.create();
    const owner = await local.owner(), recipient = await local.account();
    await local.invitation(owner, recipient);
    const first = await local.base.session(), second = await local.base.session();
    let closed = false;
    try {
      await local.close(); closed = true;
      await expect(first.client.query('select 1')).rejects.toThrow(/closed|not queryable/i);
      await expect(second.client.query('select 1')).rejects.toThrow(/closed|not queryable/i);
    } finally {
      if (!closed) { await local.base.closeSession(first); await local.base.closeSession(second); await local.close(); }
    }
  });
});

describe('management fixture failed-session cleanup', () => {
  it('restores clock, closes control and drops its clone before reporting an already-ended owned session', async () => {
    const local = await AdminManagementFixture.create();
    const owner = await local.owner(), recipient = await local.account();
    await local.invitation(owner, recipient);
    const ended = await local.base.session(), sibling = await local.base.session();
    await ended.client.end();
    const observer = await localAdminConnection();
    const drop = local.database.close;
    let beforeDrop: { clock: string; fixture: string | null; accounts: number; invitations: number } | undefined;
    // Observe the actual database immediately before the real drop. This wrapper
    // does not substitute database behavior or manufacture the expected state.
    local.database.close = async () => {
      const check = await local.database.connect();
      try {
        beforeDrop = (await check.query(`select pg_get_functiondef('dental.clock_now()'::regprocedure) as clock,
          to_regnamespace('dental_test_reservations')::text as fixture,
          (select count(*)::integer from dental.accounts) as accounts,
          (select count(*)::integer from dental.admin_invitations) as invitations`)).rows[0];
      } finally { await check.end(); }
      await drop();
    };
    try {
      await expect(local.close()).rejects.toThrow('A database session failed to close during fixture cleanup.');
      expect((await observer.query('select exists(select from pg_database where datname=$1) as remaining', [local.database.name])).rows[0].remaining).toBe(false);
      expect(beforeDrop).toMatchObject({ fixture: null, accounts: 0, invitations: 0 });
      expect(beforeDrop?.clock).toContain('pg_catalog.clock_timestamp()');
      await expect(sibling.client.query('select 1')).rejects.toThrow(/closed|not queryable/i);
      await expect(local.control.query('select 1')).rejects.toThrow(/closed|not queryable/i);
    } finally {
      local.database.close = drop;
      if ((await observer.query('select exists(select from pg_database where datname=$1) as remaining', [local.database.name])).rows[0].remaining) await local.close();
      await observer.end();
    }
  });
  it('still refuses cleanup and drop while a genuinely open manually owned session remains', async () => {
    const local = await AdminManagementFixture.create();
    await local.owner();
    const ended = await local.base.session(), sibling = await local.base.session();
    await ended.client.end();
    const manual = await local.database.connect();
    const observer = await localAdminConnection();
    try {
      await expect(local.close()).rejects.toThrow(/Close backend sessions/);
      expect((await observer.query('select exists(select from pg_database where datname=$1) as remaining', [local.database.name])).rows[0].remaining).toBe(true);
      expect((await local.control.query("select to_regnamespace('dental_test_reservations') is not null as fixture")).rows[0].fixture).toBe(true);
      expect((await manual.query('select 1 as value')).rows[0].value).toBe(1);
      await expect(sibling.client.query('select 1')).rejects.toThrow(/closed|not queryable/i);
    } finally {
      await manual.end(); await local.close(); await observer.end();
    }
  });
});
