// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { AdminManagementStore, InvitationSummary } from '../../src/shared/admin-management';
import { DatabaseError, type QueryPort } from '../../src/worker/db';
import { createAdminManagementStore as adapter } from '../../src/worker/admin-management/db';
const actor = '10000000-0000-4000-8000-000000000001', id = '20000000-0000-4000-8000-000000000001';
const summary: InvitationSummary = { id, label: 'Synthetic', reason: null, state: 'issued', version: 1, expiresAt: '2026-10-09T00:00:00Z', createdAt: '2026-10-08T00:00:00Z', claimedAt: null, claimReference: null, canClose: true };
const claim = { invitation: { ...summary, state: 'claimed' as const }, verificationCode: '00001234' };
const cursor = btoa(JSON.stringify({ occurredAt: summary.createdAt, id })).replaceAll('=', '');
const createInput = { requestId: id, tokenHash: 'a'.repeat(64), label: "Synthetic'); DROP TABLE dental.accounts; --", reason: null };
const claimInput = { tokenHash: 'a'.repeat(64), verificationCode: '00001234' };
const approveInput = { invitationId: id, version: 1, verificationCode: '00001234' };
const closeInput = { invitationId: id, version: 1, action: 'cancel' as const, reason: 'Synthetic reason' };
const revokeInput = { grantId: id, reason: 'Synthetic reason' };
function recording(result: unknown) {
  const calls: { text: string; values: unknown[] }[] = [];
  const port: QueryPort = { async query(text, values) { calls.push({ text, values }); return { rows: [{ result }] }; } };
  return { port, calls };
}
const reads = [
  ['roster', 'dental.admin_management_roster', { items: [{ grantId: id, reference: 'ADMIN-1', label: null, grantedAt: summary.createdAt, protectedOwner: true, canRevoke: false }], nextCursor: cursor }],
  ['invitations', 'dental.admin_management_invitations', { items: [summary], nextCursor: null }],
  ['history', 'dental.admin_management_history', { items: [{ id, action: 'issued', actorReference: 'ADMIN-1', targetReference: null, invitationId: id, grantId: null, reason: null, occurredAt: summary.createdAt }], nextCursor: null }],
  ['ownClaims', 'dental.admin_invitation_own_claims', { items: [claim], nextCursor: null }],
] as const;
const writes = [
  ['create', 'dental.admin_management_create', createInput, { ok: true, value: { invitation: summary, created: true } }],
  ['claim', 'dental.admin_invitation_claim', claimInput, { ok: true, value: claim }],
  ['approve', 'dental.admin_management_approve', approveInput, { ok: true, value: summary }],
  ['close', 'dental.admin_management_close', closeInput, { ok: true, value: summary }],
  ['revoke', 'dental.admin_management_revoke', revokeInput, { ok: true, value: { revoked: true } }],
] as const;
// The switch preserves each method's exact input type, without weakening the port.
function write(store: AdminManagementStore, name: typeof writes[number][0], actorId = actor, extra: Record<string, unknown> = {}) {
  switch (name) {
    case 'create': return store.create(actorId, { ...createInput, ...extra });
    case 'claim': return store.claim(actorId, { ...claimInput, ...extra });
    case 'approve': return store.approve(actorId, { ...approveInput, ...extra });
    case 'close': return store.close(actorId, { ...closeInput, ...extra });
    case 'revoke': return store.revoke(actorId, { ...revokeInput, ...extra });
  }
}
describe('contract-first administrator management SQL adapter', () => {
  it('reads the owner capability with a parameterized verified actor', async () => {
    const { port, calls } = recording({ canRevokeAdmins: false });
    expect(await adapter(port).capabilities(actor)).toEqual({ canRevokeAdmins: false });
    expect(calls).toEqual([{ text: 'select dental.admin_management_capabilities($1::uuid) as result', values: [actor] }]);
  });
  it.each(reads)('validates the %s page and parameterizes its timestamp/UUID cursor', async (name, sql, result) => {
    const { port, calls } = recording(result);
    expect(await adapter(port)[name](actor, cursor)).toEqual(result);
    expect(calls).toEqual([{ text: `select ${sql}($1::uuid, $2::text) as result`, values: [actor, cursor] }]);
  });
  it.each(writes)('calls %s exactly once with one validated jsonb parameter', async (name, sql, input, result) => {
    const { port, calls } = recording(result); expect(await write(adapter(port), name)).toEqual(result);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toBe(`select ${sql}($1::uuid, $2::jsonb) as result`);
    expect(calls[0].values[0]).toBe(actor); expect(calls[0].values).toHaveLength(2);
    expect(JSON.parse(calls[0].values[1] as string)).toEqual(input);
  });
  it.each(['NOT_FOUND', 'FORBIDDEN', 'DUPLICATE', 'VERSION_CONFLICT', 'RATE_LIMITED', 'INVALID_TRANSITION'] as const)('returns %s business failures without a rollback or retry', async code => {
    const value = { ok: false, code, version: 4, attemptsRemaining: 2 }, { port, calls } = recording(value);
    expect(await adapter(port).approve(actor, approveInput)).toEqual(value); expect(calls).toHaveLength(1);
    expect(calls[0].text).not.toMatch(/BEGIN|ROLLBACK|COMMIT/);
  });
  it.each(reads)('rejects malformed actor/cursor for %s without calling SQL', async name => {
    const { port, calls } = recording(null), store = adapter(port);
    for (const args of [['bad', null], [actor, 'sql;DROP TABLE'], [actor, '']] as const) await expect(store[name](args[0], args[1])).rejects.toEqual(new DatabaseError('VALIDATION'));
    expect(calls).toEqual([]);
  });
  it.each(writes)('rejects forged input and malformed actor for %s without calling SQL', async name => {
    const { port, calls } = recording(null), store = adapter(port);
    await expect(write(store, name, 'bad')).rejects.toEqual(new DatabaseError('VALIDATION'));
    await expect(write(store, name, actor, { accountId: actor })).rejects.toEqual(new DatabaseError('VALIDATION'));
    expect(calls).toEqual([]);
  });
  it.each([
    { items: [{ ...summary, verificationCode: '00001234' }], nextCursor: null },
    { items: [{ ...summary, providerSubject: 'PRIVATE_PROVIDER' }], nextCursor: null },
    { items: [summary], nextCursor: 'SQL_INJECTION' },
    { items: Array.from({ length: 51 }, () => summary), nextCursor: null },
    { items: [{ ...summary, state: 'unknown' }], nextCursor: null },
    null,
  ])('fails closed on malformed or leaking list output', async output => {
    const { port } = recording(output); await expect(adapter(port).invitations(actor, null)).rejects.toEqual(new DatabaseError('UNAVAILABLE'));
  });
  it('validates result envelopes, booleans, and own-code state', async () => {
    for (const result of [{ canRevokeAdmins: false, tokenHash: 'PRIVATE_HASH' }, { canRevokeAdmins: 'true' }]) {
      const { port } = recording(result); await expect(adapter(port).capabilities(actor)).rejects.toEqual(new DatabaseError('UNAVAILABLE'));
    }
    const { port } = recording({ ok: false, code: 'INVALID_TRANSITION', attemptsRemaining: 6, diagnostic: 'PRIVATE' });
    await expect(adapter(port).approve(actor, approveInput)).rejects.toEqual(new DatabaseError('UNAVAILABLE'));
    const own = recording({ items: [{ invitation: summary, verificationCode: '00001234' }], nextCursor: null });
    await expect(adapter(own.port).ownClaims(actor, null)).rejects.toEqual(new DatabaseError('UNAVAILABLE'));
  });
  it.each(['VALIDATION', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'VERSION_CONFLICT', 'DUPLICATE', 'RATE_LIMITED', 'IDEMPOTENCY_CONFLICT', 'FULL', 'INELIGIBLE_DATE', 'INTAKE_CLOSED', 'CUTOFF_PASSED', 'UNRESOLVED_BOOKINGS', 'INVALID_TRANSITION'] as const)('maps only explicit P0001 %s errors to safe existing errors', async code => {
    const port: QueryPort = { async query() { throw { code: 'P0001', message: code, detail: 'PRIVATE_SQL' }; } };
    await expect(adapter(port).capabilities(actor)).rejects.toEqual(new DatabaseError(code));
  });
  it.each([{ code: '08006', message: 'FORBIDDEN' }, { code: 'P0001', message: 'PRIVATE_SQL' }, new Error('PRIVATE_CREDENTIAL')])('redacts unknown SQL errors', async failure => {
    const port: QueryPort = { async query() { throw failure; } }; await expect(adapter(port).capabilities(actor)).rejects.toEqual(new DatabaseError('UNAVAILABLE'));
  });
  it.each([{ rows: [] }, { rows: [{ result: null }] }, { rows: [{ result: { canRevokeAdmins: false } }, { result: { canRevokeAdmins: true } }] }])('requires exactly one nonnull validated result row', async ({ rows }) => {
    const port: QueryPort = { async query() { return { rows }; } }; await expect(adapter(port).capabilities(actor)).rejects.toEqual(new DatabaseError('UNAVAILABLE'));
  });
});
