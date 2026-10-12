// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { AdminManagementStore, InvitationSummary } from '../../src/shared/admin-management';
import { fixture, req, origin, session } from '../support/mock-line';
import { DatabaseError } from '../../src/worker/db';

const id = '20000000-0000-4000-8000-000000000001';
const grantId = '30000000-0000-4000-8000-000000000001';
const requestId = '40000000-0000-4000-8000-000000000001';
const otherAccount = '10000000-0000-4000-8000-000000000099';
const token = 'a'.repeat(43), code = '00123456';
const manager = '/api/admin/management';
const summary: InvitationSummary = { id, label: 'Synthetic admin', reason: null, state: 'issued', version: 1, expiresAt: '2026-10-09T00:00:00Z', createdAt: '2026-10-08T00:00:00Z', claimedAt: null, claimReference: null, canClose: true };
const claim = { invitation: { ...summary, state: 'claimed' as const, claimedAt: '2026-10-08T01:00:00Z', claimReference: 'CLAIM-1' }, verificationCode: code };
const headers = { Cookie: '__Host-dental_session=' + 'o'.repeat(43), 'X-CSRF-Token': 'csrf' };
const createBody = { requestId, label: summary.label, reason: null };
function setup() {
  const f = fixture();
  const store: AdminManagementStore = {
    capabilities: vi.fn(async () => ({ canRevokeAdmins: false })),
    roster: vi.fn(async () => ({ items: [{ grantId, reference: 'ADMIN-1', label: null, grantedAt: summary.createdAt, protectedOwner: false, canRevoke: false }], nextCursor: null })),
    invitations: vi.fn(async () => ({ items: [summary], nextCursor: null })),
    history: vi.fn(async () => ({ items: [{ id, action: 'issued', actorReference: 'ADMIN-1', targetReference: null, invitationId: id, grantId: null, reason: null, occurredAt: summary.createdAt }], nextCursor: null })),
    create: vi.fn(async () => ({ ok: true as const, value: { invitation: summary, created: true } })),
    claim: vi.fn(async () => ({ ok: true as const, value: claim })),
    ownClaims: vi.fn(async () => ({ items: [claim], nextCursor: null })),
    approve: vi.fn(async () => ({ ok: true as const, value: { ...summary, state: 'approved' as const } })),
    close: vi.fn(async () => ({ ok: true as const, value: { ...summary, state: 'cancelled' as const } })),
    revoke: vi.fn(async () => ({ ok: false as const, code: 'FORBIDDEN' as const })),
  };
  Object.assign(f.deps, { adminManagement: store });
  vi.mocked(f.deps.db.isAdmin).mockResolvedValue(true);
  return { ...f, store, get: (path: string, h: Record<string, string> = headers) => f.app.fetch(req(path, undefined, h)), post: (path: string, body: unknown, h: Record<string, string> = headers) => f.app.fetch(req(path, body, h)) };
}
async function denied(response: Response, status: number, errorCode: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  const body = await response.json();
  expect(body.error.code).toBe(errorCode);
  expect(body.error.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.stringify(body)).not.toMatch(/PRIVATE_|00123456|verificationCode|tokenHash/);
  return body;
}

describe('verified administrator invitation HTTP boundary', () => {
  it.each(['capabilities', 'roster', 'invitations', 'history'] as const)('reads %s only for the verified actor, with no matching code', async method => {
    const { get, store, deps } = setup();
    const response = await get(`${manager}/${method}`, { ...headers, 'X-Account-Id': otherAccount, 'X-Role': 'owner' });
    expect(response.status).toBe(200);
    expect(deps.db.isAdmin).toHaveBeenCalledWith(session.accountId);
    expect(store[method]).toHaveBeenCalledWith(...(method === 'capabilities' ? [session.accountId] : [session.accountId, null]));
    expect(await response.text()).not.toMatch(/verificationCode|tokenHash|00123456|line:|patient/);
  });
  it('creates a fragment-only bearer link and sends just its hash to the store', async () => {
    const { post, store } = setup();
    const response = await post(`${manager}/invitations`, createBody);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toEqual({ invitation: summary, created: true, invitationUrl: expect.stringMatching(/^https:\/\/dental\.example\/admin-invitation#invite=[A-Za-z0-9_-]{43}$/) });
    expect(store.create).toHaveBeenCalledWith(session.accountId, { ...createBody, tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const input = vi.mocked(store.create).mock.calls[0][1];
    expect(JSON.stringify(input)).not.toContain(body.invitationUrl.split('#invite=')[1]);
  });
  it('recovers replay metadata without manufacturing a link for a discarded token', async () => {
    const { post, store } = setup();
    vi.mocked(store.create).mockResolvedValue({ ok: true, value: { invitation: summary, created: false } });
    const response = await post(`${manager}/invitations`, createBody);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ invitation: summary, created: false });
    vi.mocked(store.create).mockResolvedValue({ ok: false, code: 'DUPLICATE' });
    const conflict = await denied(await post(`${manager}/invitations`, createBody), 409, 'DUPLICATE');
    expect(conflict).not.toHaveProperty('invitationUrl');
  });
  it('never turns a lost creation response into a replacement bearer link on explicit recovery', async () => {
    const { post, store } = setup();
    vi.mocked(store.create).mockRejectedValueOnce(new DatabaseError('UNAVAILABLE')).mockResolvedValueOnce({ ok: true, value: { invitation: summary, created: false } });
    await denied(await post(`${manager}/invitations`, createBody), 503, 'UNAVAILABLE');
    const recovered = await post(`${manager}/invitations`, createBody);
    expect(recovered.status).toBe(200); expect(await recovered.json()).toEqual({ invitation: summary, created: false });
    const calls = vi.mocked(store.create).mock.calls; expect(calls).toHaveLength(2);
    expect(calls[0][1].requestId).toBe(calls[1][1].requestId); expect(calls[0][1].tokenHash).not.toBe(calls[1][1].tokenHash);
  });
  it('lets authenticated nonadmins claim and recover only their own code', async () => {
    const { post, get, deps, store } = setup();
    vi.mocked(deps.db.isAdmin).mockResolvedValue(false);
    expect(await (await post('/api/admin-invitations/claim', { token })).json()).toEqual(claim);
    expect(store.claim).toHaveBeenCalledWith(session.accountId, { tokenHash: expect.stringMatching(/^[0-9a-f]{64}$/), verificationCode: expect.stringMatching(/^[0-9]{8}$/) });
    expect(await (await get('/api/admin-invitations/mine')).json()).toEqual({ items: [claim], nextCursor: null });
    expect(store.ownClaims).toHaveBeenCalledWith(session.accountId, null);
    expect(deps.db.isAdmin).not.toHaveBeenCalled();
  });
  it.each(['NOT_FOUND', 'FORBIDDEN', 'INVALID_TRANSITION', 'VERSION_CONFLICT', 'DUPLICATE'] as const)('hides recipient claim failure %s behind the same 404', async failure => {
    const { post, store } = setup();
    vi.mocked(store.claim).mockResolvedValue({ ok: false, code: failure, version: 9, attemptsRemaining: 2 });
    const body = await denied(await post('/api/admin-invitations/claim', { token }), 404, 'NOT_FOUND');
    expect(Object.keys(body.error).sort()).toEqual(['code', 'correlationId']);
  });
  it('changes the actor on subsequent authenticated requests and never reuses another account claim', async () => {
    const { post, deps, store } = setup();
    expect((await post('/api/admin-invitations/claim', { token })).status).toBe(200);
    vi.mocked(deps.sessions.resolve).mockResolvedValue({ ...session, accountId: otherAccount });
    vi.mocked(store.claim).mockResolvedValue({ ok: false, code: 'NOT_FOUND' });
    await denied(await post('/api/admin-invitations/claim', { token }), 404, 'NOT_FOUND');
    expect(vi.mocked(store.claim).mock.calls.map(args => args[0])).toEqual([session.accountId, otherAccount]);
  });
  it('requires fresh administrator authority for manager routes', async () => {
    const { get, deps, store } = setup();
    vi.mocked(deps.sessions.resolve).mockResolvedValue({ ...session, isAdmin: true });
    vi.mocked(deps.db.isAdmin).mockResolvedValue(false);
    await denied(await get(`${manager}/invitations`), 403, 'FORBIDDEN');
    expect(store.invitations).not.toHaveBeenCalled();
  });
  it('keeps ordinary-admin revoke authority in the SQL store and targets an exact grant', async () => {
    const { post, store } = setup();
    await denied(await post(`${manager}/grants/${grantId}/revoke`, { reason: 'Synthetic removal' }), 403, 'FORBIDDEN');
    expect(store.revoke).toHaveBeenCalledWith(session.accountId, { grantId, reason: 'Synthetic removal' });
    vi.mocked(store.revoke).mockResolvedValue({ ok: true, value: { revoked: true } });
    expect(await (await post(`${manager}/grants/${grantId}/revoke`, { reason: 'Synthetic removal' })).json()).toEqual({ revoked: true });
  });
  it('submits approval and close with exact invitation versions', async () => {
    const { post, store } = setup();
    expect((await post(`${manager}/invitations/${id}/approve`, { version: 1, verificationCode: code })).status).toBe(200);
    expect(store.approve).toHaveBeenCalledWith(session.accountId, { invitationId: id, version: 1, verificationCode: code });
    expect((await post(`${manager}/invitations/${id}/close`, { version: 1, action: 'reject', reason: 'Synthetic reason' })).status).toBe(200);
    expect(store.close).toHaveBeenCalledWith(session.accountId, { invitationId: id, version: 1, action: 'reject', reason: 'Synthetic reason' });
  });
  it('returns wrong-code failures after committed attempts, retaining all five increments', async () => {
    const { post, store } = setup(); let committed = 0;
    vi.mocked(store.approve).mockImplementation(async () => { committed++; return { ok: false, code: 'INVALID_TRANSITION', version: committed + 1, attemptsRemaining: Math.max(0, 5 - committed) }; });
    for (let attempt = 1; attempt <= 5; attempt++) {
      const body = await denied(await post(`${manager}/invitations/${id}/approve`, { version: attempt, verificationCode: '99999999' }), 409, 'INVALID_TRANSITION');
      expect(body.error).toEqual({ code: 'INVALID_TRANSITION', correlationId: expect.any(String), version: attempt + 1, attemptsRemaining: 5 - attempt });
      expect(committed).toBe(attempt);
    }
    expect(store.approve).toHaveBeenCalledTimes(5);
  });
  it.each([undefined, 'expired', 'revoked'])('rejects %s sessions before store access', async state => {
    const { get, deps, store } = setup();
    if (state === 'expired') vi.mocked(deps.sessions.resolve).mockResolvedValue({ ...session, expiresAt: '2026-10-07T00:00:00Z' });
    if (state === 'revoked') vi.mocked(deps.sessions.resolve).mockResolvedValue(null);
    await denied(await get('/api/admin-invitations/mine', state === undefined ? { Cookie: '', 'X-CSRF-Token': 'csrf' } : headers), 401, 'UNAUTHENTICATED');
    expect(store.ownClaims).not.toHaveBeenCalled();
  });
  it.each<Record<string, string>>([{ 'X-CSRF-Token': '' }, { 'X-CSRF-Token': 'wrong' }, { Origin: 'https://evil.example' }])('rejects unsafe mutation headers %j', async extra => {
    const { post, store } = setup();
    await denied(await post('/api/admin-invitations/claim', { token }, { ...headers, ...extra }), 403, 'FORBIDDEN');
    expect(store.claim).not.toHaveBeenCalled();
  });
  it.each([
    [`${manager}/invitations`, { ...createBody, accountId: otherAccount }],
    ['/api/admin-invitations/claim', { token, accountId: otherAccount }],
    [`${manager}/invitations/${id}/approve`, { version: 1, verificationCode: code, actor: otherAccount }],
    [`${manager}/invitations/${id}/close`, { version: 1, action: 'cancel', reason: 'Reason', issuer: otherAccount }],
    [`${manager}/grants/${grantId}/revoke`, { reason: 'Reason', accountId: otherAccount }],
    [`${manager}/invitations/bad-id/approve`, { version: 1, verificationCode: code }],
    [`${manager}/grants/bad-id/revoke`, { reason: 'Reason' }],
  ])('rejects malformed or forged body/identity for %s', async (path, body) => {
    const { post, store } = setup(); await denied(await post(path, body), 400, 'VALIDATION');
    for (const method of ['create', 'claim', 'approve', 'close', 'revoke'] as const) expect(store[method]).not.toHaveBeenCalled();
  });
  it.each([`${manager}/roster?cursor=bad`, `${manager}/invitations?cursor=a&cursor=b`, `${manager}/history?accountId=x`, `${manager}/capabilities?cursor=a`, '/api/admin-invitations/mine?token=x'])('rejects unsafe queries for %s', async path => {
    const { get } = setup(); await denied(await get(path), 400, 'VALIDATION');
  });
  it('passes one validated cursor through every list, but rejects queries on writes', async () => {
    const { get, post, store } = setup();
    const cursor = btoa(JSON.stringify({ occurredAt: summary.createdAt, id })).replaceAll('=', '');
    for (const [path, method] of [[`${manager}/roster`, 'roster'], [`${manager}/invitations`, 'invitations'], [`${manager}/history`, 'history'], ['/api/admin-invitations/mine', 'ownClaims']] as const) {
      expect((await get(`${path}?cursor=${cursor}`)).status).toBe(200);
      expect(store[method]).toHaveBeenCalledWith(session.accountId, cursor);
    }
    await denied(await post('/api/admin-invitations/claim?cursor=' + cursor, { token }), 400, 'VALIDATION');
  });
  it('fails closed for recognized unconfigured routes while leaving unknown routes unknown', async () => {
    const { get, post, deps } = setup(); Object.assign(deps, { adminManagement: undefined });
    await denied(await get(`${manager}/capabilities`), 503, 'UNAVAILABLE');
    await denied(await post('/api/admin-invitations/claim', { token }), 503, 'UNAVAILABLE');
    await denied(await get('/api/admin-invitations/unknown'), 404, 'NOT_FOUND');
    await denied(await get(`${manager}/capabilities/suffix`), 404, 'NOT_FOUND');
  });
  it('rejects oversized bodies and rate-limited writes before any store call', async () => {
    const { post, deps, store } = setup();
    await denied(await post(`${manager}/invitations`, { ...createBody, label: 'x'.repeat(17000) }), 400, 'VALIDATION');
    vi.mocked(deps.requestLimits.store.consume).mockResolvedValue(false);
    await denied(await post('/api/admin-invitations/claim', { token }), 429, 'RATE_LIMITED');
    expect(store.create).not.toHaveBeenCalled(); expect(store.claim).not.toHaveBeenCalled();
  });
  it('rejects a missing Origin before claim access', async () => {
    const { app, store } = setup();
    const response = await app.fetch(new Request(origin + '/api/admin-invitations/claim', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }));
    await denied(response, 403, 'FORBIDDEN'); expect(store.claim).not.toHaveBeenCalled();
  });
  it.each([{ token: 'short' }, { token: 'a'.repeat(44) }, { token: 'a'.repeat(42) + '/' }, { token, verificationCode: code }])('rejects invalid claim shapes %j before token processing', async body => {
    const { post, store } = setup(); await denied(await post('/api/admin-invitations/claim', body), 400, 'VALIDATION'); expect(store.claim).not.toHaveBeenCalled();
  });
  it('rechecks live authority after a successful management request', async () => {
    const { get, deps, store } = setup(); expect((await get(`${manager}/invitations`)).status).toBe(200);
    vi.mocked(deps.db.isAdmin).mockResolvedValue(false); await denied(await get(`${manager}/invitations`), 403, 'FORBIDDEN');
    expect(store.invitations).toHaveBeenCalledOnce(); expect(deps.db.isAdmin).toHaveBeenCalledTimes(2);
  });
  it('redacts all manager projections even when an injected store violates its typed contract', async () => {
    const { get, store } = setup();
    const capability = { canRevokeAdmins: false, verificationCode: code }; vi.mocked(store.capabilities).mockResolvedValue(capability);
    await denied(await get(`${manager}/capabilities`), 503, 'UNAVAILABLE');
    const roster = { items: [{ grantId, reference: 'ADMIN-1', label: null, grantedAt: summary.createdAt, protectedOwner: true, canRevoke: false, tokenHash: 'PRIVATE_HASH' }], nextCursor: null }; vi.mocked(store.roster).mockResolvedValue(roster);
    await denied(await get(`${manager}/roster`), 503, 'UNAVAILABLE');
    const history = { items: [{ id, action: 'issued', actorReference: 'ADMIN-1', targetReference: null, invitationId: id, grantId: null, reason: null, occurredAt: summary.createdAt, providerSubject: 'PRIVATE_SUBJECT' }], nextCursor: null }; vi.mocked(store.history).mockResolvedValue(history);
    await denied(await get(`${manager}/history`), 503, 'UNAVAILABLE');
  });
  it('returns recipient rate limits without stale version or attempt details', async () => {
    const { post, store } = setup(); vi.mocked(store.claim).mockResolvedValue({ ok: false, code: 'RATE_LIMITED', version: 1, attemptsRemaining: 2 });
    const body = await denied(await post('/api/admin-invitations/claim', { token }), 429, 'RATE_LIMITED'); expect(Object.keys(body.error).sort()).toEqual(['code', 'correlationId']);
  });
  it('rejects code/token canaries in manager outputs and hides unexpected failures from logs', async () => {
    const { get, post, store } = setup();
    const leaked = { items: [{ ...summary, verificationCode: code }], nextCursor: null };
    vi.mocked(store.invitations).mockResolvedValue(leaked);
    await denied(await get(`${manager}/invitations`), 503, 'UNAVAILABLE');
    const logs = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      vi.mocked(store.claim).mockRejectedValue(new Error(`PRIVATE_${token}_${code}`));
      await denied(await post('/api/admin-invitations/claim', { token }), 503, 'UNAVAILABLE');
      expect(JSON.stringify(logs.mock.calls)).not.toContain(token); expect(JSON.stringify(logs.mock.calls)).not.toContain(code);
      vi.mocked(store.claim).mockRejectedValue(new DatabaseError('FORBIDDEN'));
      await denied(await post('/api/admin-invitations/claim', { token }), 404, 'NOT_FOUND');
    } finally { logs.mockRestore(); }
  });
});
