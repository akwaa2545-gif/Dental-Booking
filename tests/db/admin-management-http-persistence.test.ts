import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixture as httpFixture, req, session } from '../support/mock-line';
import { createRequestLimitStore } from '../../src/worker/security';
import { createAdminManagementStore } from '../../src/worker/admin-management/db';
import { hashInvitationToken } from '../../src/worker/admin-management/tokens';
import { ownClaimSchema } from '../../src/shared/admin-management';
import { createDatabase } from '../../src/worker/db';
import { AdminManagementFixture } from '../support/admin-management-postgres';
import { audits, claimed, code, createInput, row, value } from '../support/admin-management-lifecycle';
let f: AdminManagementFixture;
describe('real PostgreSQL management HTTP persistence', () => {
  beforeEach(async () => { f = await AdminManagementFixture.create(); });
  afterEach(async () => { await f?.close(); });
  it('returns a valid expired HTTP claim when the deadline passes during the post-write audit wait', async () => {
    const issuer = await f.admin(), recipient = await f.account(), token = 'b'.repeat(43), h = httpFixture();
    const created = value(await f.store.create(issuer.account, { ...createInput(), tokenHash: await hashInvitationToken(token) }));
    const blocker = await f.database.connect(); let pending: Promise<Response> | undefined;
    let announce!: (pid: number) => void;
    const requestStarted = new Promise<number>(resolve => { announce = resolve; });
    h.deps.adminManagement = createAdminManagementStore({ query: async (sql, values) => {
      const request = await f.base.session(); announce(request.pid);
      try { const result = await request.client.query(sql, values); await request.client.query('commit'); return result; }
      finally { await f.base.closeSession(request); }
    } });
    h.deps.requestLimits.store = createRequestLimitStore({ query: async (sql, values) => ({ rows: [{ result: await f.base.call(sql, values) }] }) });
    h.deps.sessions.resolve = async () => ({ ...session, accountId: recipient });
    try {
      await blocker.query('begin; lock dental.admin_management_audit in share mode');
      const pid = (await blocker.query('select pg_backend_pid() as pid')).rows[0].pid;
      pending = h.app.fetch(req('/api/admin-invitations/claim', { token }, { Cookie: '__Host-dental_session=' + 'o'.repeat(43), 'X-CSRF-Token': 'csrf' })); void pending.catch(() => {});
      await f.base.waitForLockWaiters([await requestStarted], pid);
      await f.base.setClock(created.invitation.expiresAt); await blocker.query('commit');
      const response = await pending, body: unknown = await response.json();
      expect(response.status).toBe(200);
      expect(ownClaimSchema.safeParse(body).success).toBe(true);
      expect(body).toMatchObject({ invitation: { state: 'expired', version: 2 }, verificationCode: null });
      expect(await row(f, created.invitation.id)).toMatchObject({ state: 'claimed', claimant_account_id: recipient });
      expect((await audits(f, created.invitation.id)).filter(a => a.action === 'invitation_claimed')).toHaveLength(1);
      expect((await f.store.ownClaims(recipient, null)).items[0]).toEqual(body);
    } finally { await blocker.query('rollback'); await pending?.catch(() => {}); await blocker.end(); }
  });
  it('commits real failed-code counters and audit before all five HTTP 409 responses', async () => {
    const issuer = await f.admin(), recipient = await f.account(), item = await claimed(f, issuer, recipient), h = httpFixture();
    h.deps.adminManagement = f.store;
    h.deps.requestLimits.store = createRequestLimitStore({ query: async (sql, values) => ({ rows: [{ result: await f.base.call(sql, values) }] }) });
    h.deps.db = createDatabase({ query: async (sql, values) => ({ rows: [{ result: await f.base.call(sql, values) }] }) });
    h.deps.sessions.resolve = async () => ({ ...session, accountId: issuer.account });
    const headers = { Cookie: '__Host-dental_session=' + 'o'.repeat(43), 'X-CSRF-Token': 'csrf' };
    for (let attempt = 1; attempt <= 5; attempt++) {
      const response = await h.app.fetch(req(`/api/admin/management/invitations/${item.invitation.id}/approve`, { version: attempt + 1, verificationCode: '99999999' }, headers));
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: { code: 'INVALID_TRANSITION', correlationId: expect.any(String), version: attempt + 2, attemptsRemaining: 5 - attempt } });
      // Separate independent control connection proves the SQL statement committed.
      expect(await row(f, item.invitation.id)).toMatchObject({ failed_verification_count: attempt, version: attempt + 2 });
      expect((await audits(f, item.invitation.id)).filter(a => a.result === 'invalid_transition')).toHaveLength(attempt);
    }
    expect(await row(f, item.invitation.id)).toMatchObject({ state: 'locked', verification_code: null });
  });
  it('never returns a replacement link when HTTP create repeats a request ID with a newly generated token', async () => {
    const issuer = await f.admin(), h = httpFixture(); h.deps.adminManagement = f.store;
    h.deps.requestLimits.store = createRequestLimitStore({ query: async (sql, values) => ({ rows: [{ result: await f.base.call(sql, values) }] }) });
    h.deps.db = createDatabase({ query: async (sql, values) => ({ rows: [{ result: await f.base.call(sql, values) }] }) });
    h.deps.sessions.resolve = async () => ({ ...session, accountId: issuer.account });
    const headers = { Cookie: '__Host-dental_session=' + 'o'.repeat(43), 'X-CSRF-Token': 'csrf' };
    const request = { requestId: createInput().requestId, label: 'Synthetic uncertain create', reason: null };
    const first = await h.app.fetch(req('/api/admin/management/invitations', request, headers));
    expect(first.status).toBe(201); expect(await first.json()).toHaveProperty('invitationUrl');
    const retry = await h.app.fetch(req('/api/admin/management/invitations', request, headers));
    expect(retry.status).toBe(409); expect(await retry.json()).toEqual({ error: { code: 'DUPLICATE', correlationId: expect.any(String) } });
    expect((await f.store.invitations(issuer.account, null)).items).toHaveLength(1);
    expect((await f.control.query("select count(*)::int as n from dental.admin_management_audit where action='invitation_created'")).rows[0].n).toBe(1);
  });
  it('uses verified session identity, rejects forged body identity, and genericizes cross-account claim failures', async () => {
    const issuer = await f.admin(), recipient = await f.account(), h = httpFixture(); h.deps.adminManagement = f.store;
    h.deps.requestLimits.store = createRequestLimitStore({ query: async (sql, values) => ({ rows: [{ result: await f.base.call(sql, values) }] }) });
    h.deps.db = createDatabase({ query: async (sql, values) => ({ rows: [{ result: await f.base.call(sql, values) }] }) });
    h.deps.sessions.resolve = async () => ({ ...session, accountId: recipient, isAdmin: true });
    const headers = { Cookie: '__Host-dental_session=' + 'o'.repeat(43), 'X-CSRF-Token': 'csrf', 'X-Account-Id': issuer.account, 'X-Role': 'owner' };
    const response = await h.app.fetch(req('/api/admin/management/invitations', { requestId: createInput().requestId, label: 'Synthetic', reason: null }, headers));
    expect(response.status).toBe(403);
    const token = 'a'.repeat(43);
    expect((await h.app.fetch(req('/api/admin-invitations/claim', { token, accountId: issuer.account }, headers))).status).toBe(400);
    value(await f.store.create(issuer.account, { ...createInput(), tokenHash: await hashInvitationToken(token) }));
    value(await f.store.claim(issuer.account, { tokenHash: await hashInvitationToken(token), verificationCode: code }));
    const unavailable = await h.app.fetch(req('/api/admin-invitations/claim', { token }, headers));
    expect(unavailable.status).toBe(404); expect(await unavailable.json()).toEqual({ error: { code: 'NOT_FOUND', correlationId: expect.any(String) } });
  });
});
