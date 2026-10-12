// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixture, req, session } from '../support/mock-line';
import { createAdminManagementStore } from '../../src/worker/admin-management/db';
import { hashInvitationToken } from '../../src/worker/admin-management/tokens';

// Obvious local canaries. No real provider identity, bearer or credential is used.
const secret = { token: 'x'.repeat(43), code: '08372615', subject: 'U_SYNTHETIC_PRIVATE_SUBJECT', hash: 'a'.repeat(64) };
const id = '20000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const headers = { Cookie: '__Host-dental_session=' + 'o'.repeat(43), 'X-CSRF-Token': 'csrf' };
const invitation = { id, label: 'Synthetic colleague', reason: null, state: 'claimed', version: 2, expiresAt: '2026-10-09T00:00:00Z', createdAt: '2026-10-08T00:00:00Z', claimedAt: '2026-10-08T00:01:00Z', claimReference: 'I-SYNTHETIC', canClose: false };
function setup(result: unknown) {
  const h = fixture();
  const query = vi.fn(async () => ({ rows: [{ result }] }));
  h.deps.adminManagement = createAdminManagementStore({ query });
  vi.mocked(h.deps.db.isAdmin).mockResolvedValue(true);
  return { ...h, query };
}
async function privateFailure(response: Response, status = 503) {
  expect(response.status).toBe(status);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  const text = await response.text();
  for (const canary of Object.values(secret)) expect(text).not.toContain(canary);
  expect(text).not.toMatch(/tokenHash|verificationCode|providerSubject|line:/);
  return JSON.parse(text);
}
afterEach(() => vi.restoreAllMocks());

describe('invitation privacy across SQL adapter and Worker response boundaries', () => {
  it.each([
    ['capabilities', { canRevokeAdmins: false, providerSubject: secret.subject }],
    ['roster', { items: [{ grantId: id, reference: 'A-SYNTHETIC', label: null, grantedAt: invitation.createdAt, protectedOwner: false, canRevoke: false, tokenHash: secret.hash }], nextCursor: null }],
    ['invitations', { items: [{ ...invitation, verificationCode: secret.code, token: secret.token }], nextCursor: null }],
    ['history', { items: [{ id, action: 'invitation_claimed', actorReference: 'A-SYNTHETIC', targetReference: null, invitationId: id, grantId: null, reason: null, occurredAt: invitation.createdAt, providerSubject: secret.subject }], nextCursor: null }],
  ])('fails closed when SQL %s accidentally returns private columns', async (path, result) => {
    const h = setup(result);
    expect((await privateFailure(await h.app.fetch(req('/api/admin/management/' + path, undefined, headers)))).error.code).toBe('UNAVAILABLE');
  });
  it('redacts thrown query diagnostics containing the body, code, token hash and subject', async () => {
    const h = setup(null), info = vi.spyOn(console, 'info').mockImplementation(() => {}), error = vi.spyOn(console, 'error').mockImplementation(() => {});
    h.query.mockRejectedValue(new Error(JSON.stringify(secret)));
    await privateFailure(await h.app.fetch(req('/api/admin-invitations/claim', { token: secret.token }, headers)));
    const logs = JSON.stringify([info.mock.calls, error.mock.calls]);
    for (const canary of Object.values(secret)) expect(logs).not.toContain(canary);
  });
  it('passes only a domain-separated hash and current cookie actor to SQL; GET never claims', async () => {
    const h = setup({ ok: true, value: { invitation, verificationCode: secret.code } });
    expect((await h.app.fetch(req('/api/admin-invitations/claim', undefined, headers))).status).toBe(404);
    expect(h.query).not.toHaveBeenCalled();
    expect((await h.app.fetch(req('/api/admin-invitations/claim', { token: secret.token }, { ...headers, 'X-Account-Id': other, 'X-Role': 'owner' }))).status).toBe(200);
    const values = (h.query.mock.calls as unknown as [string, unknown[]][])[0][1];
    expect(values[0]).toBe(session.accountId);
    expect(JSON.parse(values[1] as string)).toMatchObject({ tokenHash: await hashInvitationToken(secret.token) });
    expect(JSON.stringify(values)).not.toContain(secret.token);
    expect(JSON.stringify(values)).not.toContain(other);
  });
  it('false server capability cannot be raised by headers or stale browser owner state', async () => {
    const h = setup({ canRevokeAdmins: false });
    const forged = { ...headers, 'X-Role': 'owner', 'X-Can-Revoke-Admins': 'true' };
    expect(await (await h.app.fetch(req('/api/admin/management/capabilities', undefined, forged))).json()).toEqual({ canRevokeAdmins: false });
    h.query.mockResolvedValue({ rows: [{ result: { ok: false, code: 'FORBIDDEN' } }] });
    await privateFailure(await h.app.fetch(req(`/api/admin/management/grants/${id}/revoke`, { reason: 'Synthetic removal' }, forged)), 403);
    vi.mocked(h.deps.db.isAdmin).mockResolvedValue(false);
    const calls = h.query.mock.calls.length;
    await privateFailure(await h.app.fetch(req(`/api/admin/management/invitations/${id}/approve`, { version: 2, verificationCode: secret.code }, forged)), 403);
    expect(h.query).toHaveBeenCalledTimes(calls);
  });
  it('rejects historical or expired own-claim responses if they carry a retained code', async () => {
    for (const state of ['expired', 'invalidated', 'approved', 'locked']) {
      const h = setup({ items: [{ invitation: { ...invitation, state }, verificationCode: secret.code }], nextCursor: null });
      await privateFailure(await h.app.fetch(req('/api/admin-invitations/mine', undefined, headers)));
    }
  });
});
