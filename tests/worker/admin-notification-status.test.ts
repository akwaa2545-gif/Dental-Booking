// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { AdminAppointment, Appointment } from '../../src/shared/contracts';
import { createDatabase, type QueryPort } from '../../src/worker/db';
import { fixture, origin, session } from '../support/mock-line';

const listSql = 'select dental.admin_appointments($1::uuid, $2::date, $3::text) as result';
const isAdminSql = 'select dental.is_admin($1::uuid) as result';
const cookie = '__Host-dental_session=' + 'o'.repeat(43);
const appointment: Appointment = {
  id: '20000000-0000-4000-8000-000000000001', reference: 'SYNTHETIC-STATUS',
  patientId: '30000000-0000-4000-8000-000000000001',
  patient: { fullName: 'Synthetic Patient', phone: '0000000000', age: 42, address: 'Fictional home', relationship: 'self', authorizationAcknowledged: true },
  service: 'oral_check', date: '2026-10-09', status: 'pending', version: 1,
  createdAt: '2026-10-08T00:00:00Z', approvedAt: null, cancelBefore: '2026-10-08T17:00:00Z',
};
const adminAppointment: AdminAppointment = {
  ...appointment,
  notificationAttempts: [{ kind: 'approval', state: 'queued', attemptCount: 0 }],
  adminNotificationAttempts: [
    { recipientLabel: 'แอดมิน 1', state: 'accepted', attemptCount: 1, safeReason: null },
    { recipientLabel: 'แอดมิน 2', state: 'paused_quota', attemptCount: 0, safeReason: 'quota_exhausted' },
    { recipientLabel: 'แอดมิน 3', state: 'failed', attemptCount: 6, safeReason: 'unknown' },
  ],
};
function request(path = '/api/admin/appointments', headers: Record<string, string> = {}) {
  return new Request(origin + path, { headers: { Cookie: cookie, ...headers } });
}
function application() {
  const f = fixture(), calls: { text: string; values: unknown[] }[] = [];
  const access = { admin: true, listError: null as unknown };
  // The external DB boundary is the only double. Real SQL privacy and live
  // checks are exercised separately by tests/db/admin-notification-status.
  const port: QueryPort = { async query(text, values) {
    calls.push({ text, values });
    if (text === isAdminSql) return { rows: [{ result: access.admin }] };
    if (text === listSql) {
      if (access.listError) throw access.listError;
      return { rows: [{ result: [adminAppointment] }] };
    }
    if (text === 'select dental.list_appointments($1::uuid) as result') return { rows: [{ result: [appointment] }] };
    if (text === 'select dental.get_appointment($1::uuid, $2::uuid) as result'
      || text === 'select dental.submission($1::uuid, $2::uuid) as result') return { rows: [{ result: appointment }] };
    throw new Error(`Unexpected synthetic database operation: ${text}`);
  } };
  f.deps.db = createDatabase(port);
  return { ...f, access, calls };
}
async function denied(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const body = await response.json();
  expect(body).toEqual({ error: { code, correlationId: expect.any(String) } });
  expect(JSON.stringify(body)).not.toMatch(/SYNTHETIC-STATUS|Synthetic Patient|adminNotificationAttempts|PRIVATE_/);
}

describe('admin notification status endpoint isolation', () => {
  it('returns partial per-admin outcomes separately from the existing patient-message status', async () => {
    const { app, calls } = application();
    const response = await app.fetch(request('/api/admin/appointments?date=2026-10-09&status=pending', {
      'X-Account-Id': '10000000-0000-4000-8000-000000000099', 'X-Role': 'admin',
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const [result] = await response.json() as AdminAppointment[];
    expect(result.notificationAttempts).toEqual([{ kind: 'approval', state: 'queued', attemptCount: 0 }]);
    expect(result.adminNotificationAttempts).toEqual([
      { recipientLabel: 'แอดมิน 1', state: 'accepted', attemptCount: 1, safeReason: null },
      { recipientLabel: 'แอดมิน 2', state: 'paused_quota', attemptCount: 0, safeReason: 'quota_exhausted' },
      { recipientLabel: 'แอดมิน 3', state: 'failed', attemptCount: 6, safeReason: 'unknown' },
    ]);
    for (const summary of result.adminNotificationAttempts!) expect(Object.keys(summary).sort()).toEqual(['attemptCount', 'recipientLabel', 'safeReason', 'state']);
    expect(calls).toEqual([
      { text: isAdminSql, values: [session.accountId] },
      { text: listSql, values: [session.accountId, '2026-10-09', 'pending'] },
    ]);
  });

  it.each(['missing', 'expired'] as const)('returns 401 for a %s session without querying privileged status', async state => {
    const { app, deps, calls } = application();
    if (state === 'expired') vi.mocked(deps.sessions.resolve).mockResolvedValue({ ...session, isAdmin: true, expiresAt: '2026-10-07T00:00:00Z' });
    await denied(await app.fetch(request(undefined, state === 'missing' ? { Cookie: '' } : {})), 401, 'UNAUTHENTICATED');
    expect(calls).toEqual([]);
  });

  it.each(['ordinary patient', 'OA console manager', 'cached revoked admin'] as const)('returns 403 for %s without a live app-admin grant', async role => {
    const { app, deps, access, calls } = application(); access.admin = false;
    vi.mocked(deps.sessions.resolve).mockResolvedValue({ ...session, isAdmin: role === 'cached revoked admin' });
    await denied(await app.fetch(request(undefined, { 'X-Role': 'admin', 'X-Line-OA-Role': 'administrator' })), 403, 'FORBIDDEN');
    expect(calls).toEqual([{ text: isAdminSql, values: [session.accountId] }]);
  });

  it('rechecks the live grant on the next request after a previously authorized status read', async () => {
    const { app, access, calls } = application();
    expect((await app.fetch(request())).status).toBe(200);
    access.admin = false;
    await denied(await app.fetch(request()), 403, 'FORBIDDEN');
    expect(calls.filter(call => call.text === listSql)).toHaveLength(1);
    expect(calls.filter(call => call.text === isAdminSql)).toHaveLength(2);
  });

  it('propagates SQL revocation after the initial live check as a redacted 403', async () => {
    const { app, access, calls } = application();
    access.listError = { code: 'P0001', message: 'FORBIDDEN', detail: 'PRIVATE_RECIPIENT_TOKEN_CANARY' };
    await denied(await app.fetch(request()), 403, 'FORBIDDEN');
    expect(calls.map(call => call.text)).toEqual([isAdminSql, listSql]);
  });

  it('redacts unexpected database diagnostics rather than exposing notification internals', async () => {
    const { app, access } = application();
    access.listError = { code: '08006', message: 'PRIVATE_PROVIDER_REQUEST_CANARY', detail: 'PRIVATE_RECIPIENT_TOKEN_CANARY' };
    await denied(await app.fetch(request()), 503, 'UNAVAILABLE');
  });

  it.each([
    ['/api/appointments', 'select dental.list_appointments($1::uuid) as result', [session.accountId]],
    [`/api/appointments/${appointment.id}`, 'select dental.get_appointment($1::uuid, $2::uuid) as result', [session.accountId, appointment.id]],
    ['/api/submissions/40000000-0000-4000-8000-000000000001', 'select dental.submission($1::uuid, $2::uuid) as result', [session.accountId, '40000000-0000-4000-8000-000000000001']],
  ] as const)('keeps %s on its patient-only projection even for a cached admin session', async (path, sql, values) => {
    const { app, deps, calls } = application();
    vi.mocked(deps.sessions.resolve).mockResolvedValue({ ...session, isAdmin: true });
    const response = await app.fetch(request(path)); expect(response.status).toBe(200);
    const body = await response.json();
    for (const item of Array.isArray(body) ? body : [body]) {
      expect(item).toEqual(appointment);
      expect(item).not.toHaveProperty('adminNotificationAttempts');
      expect(item).not.toHaveProperty('notificationAttempts');
    }
    expect(calls).toEqual([{ text: sql, values }]);
  });
});
