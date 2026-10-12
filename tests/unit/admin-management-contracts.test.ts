import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as adminManagement from '../../src/shared/admin-management';

const contracts: Record<string, unknown> = adminManagement;

function contract<T>(name: string): T {
  expect(contracts[name], `Missing administrator-management contract: ${name}`).toBeDefined();
  return contracts[name] as T;
}
function schema(name: string): z.ZodType { return contract<z.ZodType>(name); }
const parseCursor = (value: string | null) => contract<(cursor: string | null) => unknown>('parseManagementCursor')(value);
const page = () => contract<(item: z.ZodType) => z.ZodType>('pageSchema')(schema('invitationSummarySchema'));
const result = () => contract<(value: z.ZodType) => z.ZodType>('managementResultSchema')(schema('createdInvitationSchema'));

const id = '00000000-0000-4000-8000-000000000001';
const grantId = '00000000-0000-4000-8000-000000000002';
const createdAt = '2026-10-10T12:00:00.123456+00:00';
const expiresAt = '2026-10-11T12:00:00.123456+00:00';
const code = '00001234';
const hash = 'a'.repeat(64);
const summary = {
  id, label: 'Synthetic colleague', reason: null, state: 'issued', version: 1,
  expiresAt, createdAt, claimedAt: null, claimReference: null, canClose: true,
};
const claimed = { ...summary, state: 'claimed', claimedAt: createdAt, claimReference: 'I-opaque' };
const roster = { grantId, reference: 'A-opaque', label: null, grantedAt: createdAt, protectedOwner: false, canRevoke: false };
const audit = { id, action: 'invitation_created', actorReference: 'A-opaque', targetReference: null, invitationId: id, grantId: null, reason: null, occurredAt: createdAt };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
const cursorPair = { occurredAt: createdAt, id };
const cursor = encode(cursorPair);

// These assertions fail if a contract strips private fields, accepts unbounded
// data, widens authority-bearing requests, or changes canonical pagination.
describe('administrator-management DTO contracts', () => {
  it('accepts the exact nonsecret invitation summary shape', () => {
    expect(schema('invitationSummarySchema').parse(summary)).toEqual(summary);
  });
  it.each(['issued', 'claimed', 'approved', 'rejected', 'cancelled', 'locked', 'expired', 'invalidated'])('accepts invitation state %s', state => {
    expect(schema('invitationStateSchema').parse(state)).toBe(state);
    expect(schema('invitationSummarySchema').parse({ ...summary, state })).toEqual({ ...summary, state });
  });
  it.each(['pending', '', 'ISSUED', null, 1])('rejects undefined invitation state %s', state => {
    expect(schema('invitationStateSchema').safeParse(state).success).toBe(false);
  });
  it.each([0, -1, 1.5, 2147483648, NaN, Infinity, '1', null])('rejects invalid invitation version %s', version => {
    expect(schema('invitationSummarySchema').safeParse({ ...summary, version }).success).toBe(false);
  });
  it('accepts positive 32-bit version endpoints', () => {
    for (const version of [1, 2147483647]) expect(schema('invitationSummarySchema').parse({ ...summary, version })).toEqual({ ...summary, version });
  });
  it.each([
    { id: 'not-a-uuid' }, { label: '' }, { label: ' ' }, { label: 'ก'.repeat(121) },
    { reason: '' }, { reason: ' ' }, { reason: 'ก'.repeat(501) },
    { createdAt: '2026-02-30T12:00:00Z' }, { createdAt: '2026-10-10T12:00:00Z\n' }, { expiresAt: '2026-10-11' },
    { claimedAt: 'invalid' }, { claimReference: '' }, { claimReference: 'A'.repeat(81) },
    { claimReference: 'A\nprivate' }, { canClose: 'true' },
  ])('rejects malformed summary field %j', override => {
    expect(schema('invitationSummarySchema').safeParse({ ...summary, ...override }).success).toBe(false);
  });
  it('trims human fields and accepts exact label/reason bounds', () => {
    expect(schema('invitationSummarySchema').parse({ ...summary, label: '  colleague  ', reason: '  review  ' })).toEqual({ ...summary, label: 'colleague', reason: 'review' });
    expect(schema('invitationSummarySchema').safeParse({ ...summary, label: 'ก'.repeat(120), reason: 'ก'.repeat(500) }).success).toBe(true);
  });
  it.each(['provider', 'subject', 'providerSubject', 'accountId', 'patient', 'verificationCode', 'tokenHash', 'unexpected'])('rejects private/unknown summary field %s', field => {
    expect(schema('invitationSummarySchema').safeParse({ ...summary, [field]: 'private' }).success).toBe(false);
  });
  it('accepts eight-digit claimant code with leading zeros without numeric coercion', () => {
    expect(schema('ownClaimSchema').parse({ invitation: claimed, verificationCode: code })).toEqual({ invitation: claimed, verificationCode: code });
  });
  it.each(['1234567', '123456789', '12ab5678', ' 00001234', '00001234 ', '00001234\n', 1234, '１２３４５６７８'])('rejects malformed claimant code %s', verificationCode => {
    expect(schema('ownClaimSchema').safeParse({ invitation: claimed, verificationCode }).success).toBe(false);
  });
  it.each(['issued', 'approved', 'rejected', 'cancelled', 'locked', 'expired', 'invalidated'])('rejects a disclosed code outside pending state %s', state => {
    expect(schema('ownClaimSchema').safeParse({ invitation: { ...claimed, state }, verificationCode: code }).success).toBe(false);
    expect(schema('ownClaimSchema').safeParse({ invitation: { ...claimed, state }, verificationCode: null }).success).toBe(true);
  });
  it('accepts an absent code and rejects unknown/nested own-claim fields', () => {
    expect(schema('ownClaimSchema').parse({ invitation: claimed, verificationCode: null })).toEqual({ invitation: claimed, verificationCode: null });
    expect(schema('ownClaimSchema').safeParse({ invitation: claimed, verificationCode: code, subject: 'private' }).success).toBe(false);
    expect(schema('ownClaimSchema').safeParse({ invitation: { ...claimed, verificationCode: code }, verificationCode: code }).success).toBe(false);
  });
  it('accepts only the safe roster shape with a nullable legacy label', () => {
    expect(schema('adminRosterEntrySchema').parse(roster)).toEqual(roster);
    expect(schema('adminRosterEntrySchema').safeParse({ ...roster, label: 'Colleague' }).success).toBe(true);
  });
  it.each(['subject', 'provider', 'accountId', 'patient', 'verificationCode'])('rejects private roster field %s', field => {
    expect(schema('adminRosterEntrySchema').safeParse({ ...roster, [field]: 'private' }).success).toBe(false);
  });
  it.each([{ reference: '' }, { reference: 'a'.repeat(81) }, { reference: 'A\u0000secret' }, { reference: 'A\u007fsecret' }, { label: ' ' }, { label: 'a'.repeat(121) }, { grantId: 'invalid' }, { grantedAt: 'invalid' }, { protectedOwner: 1 }, { canRevoke: 0 }])('rejects invalid roster value %j', override => {
    expect(schema('adminRosterEntrySchema').safeParse({ ...roster, ...override }).success).toBe(false);
  });
  it('accepts generic bounded opaque application references', () => {
    expect(schema('adminRosterEntrySchema').safeParse({ ...roster, reference: 'อ้างอิง: 01' }).success).toBe(true);
    expect(schema('adminRosterEntrySchema').safeParse({ ...roster, reference: 'A'.repeat(80) }).success).toBe(true);
  });
  it('rejects raw LINE subjects in application-reference positions', () => {
    const subject = 'U' + 'a'.repeat(32);
    expect(schema('adminRosterEntrySchema').safeParse({ ...roster, reference: subject }).success).toBe(false);
    expect(schema('invitationSummarySchema').safeParse({ ...summary, claimReference: subject }).success).toBe(false);
    expect(schema('managementAuditEntrySchema').safeParse({ ...audit, actorReference: subject }).success).toBe(false);
    expect(schema('managementAuditEntrySchema').safeParse({ ...audit, targetReference: subject }).success).toBe(false);
  });
  it('accepts exact structured management audit fields', () => {
    expect(schema('managementAuditEntrySchema').parse(audit)).toEqual(audit);
    expect(schema('managementAuditEntrySchema').safeParse({ ...audit, targetReference: 'A-target', grantId, reason: 'Reviewed' }).success).toBe(true);
  });
  it.each([{ action: '' }, { action: 'Approve' }, { action: 'a'.repeat(81) }, { action: 'approve; delete' }, { action: 'approve\n' }, { actorReference: '' }, { targetReference: 'a'.repeat(81) }, { targetReference: 'A\nsecret' }, { reason: '' }, { reason: 'a'.repeat(501) }, { invitationId: 'invalid' }, { grantId: 'invalid' }, { occurredAt: '2026-02-30T12:00:00Z' }])('rejects malformed audit value %j', override => {
    expect(schema('managementAuditEntrySchema').safeParse({ ...audit, ...override }).success).toBe(false);
  });
  it.each(['provider', 'subject', 'verificationCode', 'token', 'payload', 'patient'])('rejects private audit field %s', field => {
    expect(schema('managementAuditEntrySchema').safeParse({ ...audit, [field]: 'private' }).success).toBe(false);
  });
  it('accepts a strict created/replayed invitation with no raw link', () => {
    for (const created of [true, false]) expect(schema('createdInvitationSchema').parse({ invitation: summary, created })).toEqual({ invitation: summary, created });
    expect(schema('createdInvitationSchema').safeParse({ invitation: summary, created: true, invitationUrl: 'secret' }).success).toBe(false);
  });
});

describe('administrator-management request contracts', () => {
  const create = { requestId: id, label: 'Colleague', reason: null };
  const approve = { version: 1, verificationCode: code };
  const close = { version: 1, action: 'cancel', reason: 'Requested cancellation' };
  const revoke = { reason: 'Reviewed grant' };
  const requests = [
    ['createInvitationRequestSchema', create],
    ['claimInvitationRequestSchema', { token: 'A'.repeat(43) }],
    ['approveInvitationRequestSchema', approve],
    ['closeInvitationRequestSchema', close],
    ['revokeAdminGrantRequestSchema', revoke],
  ] as const;
  it.each(requests)('accepts exact HTTP request %s', (name, input) => {
    expect(schema(name).parse(input)).toEqual(input);
  });
  it.each(requests)('rejects body-derived identity and role in %s', (name, input) => {
    for (const field of ['actor', 'accountId', 'issuerId', 'claimantId', 'grantId', 'invitationId', 'isAdmin', 'protectedOwner', 'canRevokeAdmins', 'subject']) {
      expect(schema(name).safeParse({ ...input, [field]: id }).success, field).toBe(false);
    }
  });
  it('trims create human fields and allows only nullable create reasons', () => {
    expect(schema('createInvitationRequestSchema').parse({ ...create, label: '  Colleague  ', reason: '  Approved context  ' })).toEqual({ ...create, reason: 'Approved context' });
    expect(schema('createInvitationRequestSchema').safeParse({ requestId: id, label: 'Colleague' }).success).toBe(false);
    expect(schema('createInvitationRequestSchema').safeParse({ ...create, reason: '' }).success).toBe(false);
  });
  it.each([null, '', ' ', 'a'.repeat(501)])('rejects absent/unbounded mutation reason %s', reason => {
    expect(schema('closeInvitationRequestSchema').safeParse({ ...close, reason }).success).toBe(false);
    expect(schema('revokeAdminGrantRequestSchema').safeParse({ ...revoke, reason }).success).toBe(false);
  });
  it.each(['approve', 'revoke', 'reject ', null])('rejects unknown close action %s', action => {
    expect(schema('closeInvitationRequestSchema').safeParse({ ...close, action }).success).toBe(false);
  });
  it('accepts reject with a reason', () => {
    expect(schema('closeInvitationRequestSchema').safeParse({ ...close, action: 'reject' }).success).toBe(true);
  });
  it.each([0, -1, 1.1, 2147483648, Infinity, '1'])('rejects invalid request version %s', version => {
    expect(schema('approveInvitationRequestSchema').safeParse({ ...approve, version }).success).toBe(false);
    expect(schema('closeInvitationRequestSchema').safeParse({ ...close, version }).success).toBe(false);
  });
  it.each(['', 'A'.repeat(42), 'A'.repeat(44), 'A'.repeat(42) + '=', 'A'.repeat(42) + '+', ' A'.repeat(22), 'A'.repeat(43) + '\n'])('rejects malformed bearer token %s', token => {
    expect(schema('claimInvitationRequestSchema').safeParse({ token }).success).toBe(false);
  });
  it('validates exact store inputs separately from HTTP path/body fields', () => {
    for (const [name, input] of [
      ['createInvitationInputSchema', { ...create, tokenHash: hash }],
      ['claimInvitationInputSchema', { tokenHash: hash, verificationCode: code }],
      ['approveInvitationInputSchema', { ...approve, invitationId: id }],
      ['closeInvitationInputSchema', { ...close, invitationId: id }],
      ['revokeAdminGrantInputSchema', { ...revoke, grantId }],
    ] as const) {
      expect(schema(name).parse(input)).toEqual(input);
      expect(schema(name).safeParse({ ...input, actor: id }).success).toBe(false);
    }
  });
  it.each(['', 'a'.repeat(63), 'a'.repeat(65), 'G'.repeat(64), 'A'.repeat(64), 'a'.repeat(64) + '\n'])('rejects malformed SHA-256 token hash %s', tokenHash => {
    expect(schema('createInvitationInputSchema').safeParse({ ...create, tokenHash }).success).toBe(false);
    expect(schema('claimInvitationInputSchema').safeParse({ tokenHash, verificationCode: code }).success).toBe(false);
  });
  it('keeps store claim and approval codes string-valued with leading zeros', () => {
    expect(schema('claimInvitationInputSchema').parse({ tokenHash: hash, verificationCode: '00000000' })).toEqual({ tokenHash: hash, verificationCode: '00000000' });
    expect(schema('approveInvitationInputSchema').safeParse({ invitationId: id, version: 1, verificationCode: 12345678 }).success).toBe(false);
  });
});

describe('canonical administrator-management cursor and pages', () => {
  it('parses no cursor and a validated timestamp/UUID pair without losing microseconds', () => {
    expect(parseCursor(null)).toBeNull();
    expect(parseCursor(cursor)).toEqual(cursorPair);
    expect(schema('managementCursorSchema').parse(cursor)).toBe(cursor);
  });
  it.each(['', 'not-a-cursor', '+/', cursor + '=', cursor + ' ', 'A'.repeat(257), encode('string'), encode([]), encode({ occurredAt: '2026-02-30T12:00:00Z', id }), encode({ occurredAt: createdAt, id: 'invalid' }), encode({ occurredAt: createdAt, id, sql: 'drop table' }), encode({ id, occurredAt: createdAt })])('rejects invalid/noncanonical cursor %s', value => {
    expect(() => parseCursor(value)).toThrow();
    expect(schema('managementCursorSchema').safeParse(value).success).toBe(false);
  });
  it('rejects semantically valid JSON with noncanonical whitespace or duplicate keys', () => {
    const parse = contract<(cursor: string | null) => unknown>('parseManagementCursor');
    for (const json of [`{ "occurredAt":"${createdAt}","id":"${id}"}`, `{"occurredAt":"${createdAt}","id":"${id}","id":"${id}"}`]) {
      expect(() => parse(Buffer.from(json).toString('base64url'))).toThrow();
    }
  });
  it('accepts ISO UTC/offset timestamps and rejects unbounded precision', () => {
    for (const occurredAt of ['2026-10-10T12:00:00Z', '2026-10-10T12:00:00.000Z', '2026-10-10T19:00:00.123456+07:00']) {
      expect(parseCursor(encode({ occurredAt, id }))).toEqual({ occurredAt, id });
    }
    expect(() => parseCursor(encode({ occurredAt: '2026-10-10T12:00:00.' + '1'.repeat(40) + 'Z', id }))).toThrow();
  });
  it('uses fixed page size 50 and accepts an empty page', () => {
    expect(contract<number>('MANAGEMENT_PAGE_SIZE')).toBe(50);
    expect(page().parse({ items: [], nextCursor: null })).toEqual({ items: [], nextCursor: null });
    expect(page().safeParse({ items: Array(50).fill(summary), nextCursor: cursor }).success).toBe(true);
    expect(page().safeParse({ items: Array(51).fill(summary), nextCursor: cursor }).success).toBe(false);
  });
  it('rejects malformed cursors, unknown page fields and private nested DTO fields', () => {
    expect(page().safeParse({ items: [summary], nextCursor: 'arbitrary-sql' }).success).toBe(false);
    expect(page().safeParse({ items: [summary], nextCursor: null, total: 1 }).success).toBe(false);
    expect(page().safeParse({ items: [{ ...summary, verificationCode: code }], nextCursor: null }).success).toBe(false);
  });
});

describe('strict durable business results and capabilities', () => {
  it('accepts successful typed result and all bounded failure codes', () => {
    expect(result().parse({ ok: true, value: { invitation: summary, created: true } })).toEqual({ ok: true, value: { invitation: summary, created: true } });
    for (const code of ['NOT_FOUND', 'FORBIDDEN', 'DUPLICATE', 'VERSION_CONFLICT', 'RATE_LIMITED', 'INVALID_TRANSITION']) {
      expect(result().parse({ ok: false, code, version: 2147483647, attemptsRemaining: 0 })).toEqual({ ok: false, code, version: 2147483647, attemptsRemaining: 0 });
    }
    expect(result().safeParse({ ok: false, code: 'RATE_LIMITED', attemptsRemaining: 5 }).success).toBe(true);
  });
  it.each([{ ok: false, code: 'UNAVAILABLE' }, { ok: false, code: 'RATE_LIMITED', attemptsRemaining: -1 }, { ok: false, code: 'RATE_LIMITED', attemptsRemaining: 6 }, { ok: false, code: 'RATE_LIMITED', attemptsRemaining: 1.1 }, { ok: false, code: 'VERSION_CONFLICT', version: 0 }, { ok: false, code: 'VERSION_CONFLICT', version: 2147483648 }, { ok: false, code: 'FORBIDDEN', detail: 'private' }, { ok: false, code: 'NOT_FOUND', value: null }, { ok: true, value: { invitation: summary, created: true }, code: 'FORBIDDEN' }, { ok: 'true', value: { invitation: summary, created: true } }])('rejects unsafe result %j', value => {
    expect(result().safeParse(value).success).toBe(false);
  });
  it('validates only the owner-specific capability and exact revoke result', () => {
    expect(schema('adminManagementCapabilitiesSchema').parse({ canRevokeAdmins: false })).toEqual({ canRevokeAdmins: false });
    expect(schema('adminManagementCapabilitiesSchema').safeParse({ canRevokeAdmins: true, isAdmin: true }).success).toBe(false);
    expect(schema('revokedAdminGrantSchema').parse({ revoked: true })).toEqual({ revoked: true });
    expect(schema('revokedAdminGrantSchema').safeParse({ revoked: true, grantId }).success).toBe(false);
  });
});
