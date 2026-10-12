import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoApi } from '../../src/demo/api';
import { createDemoClock } from '../../src/demo/clock';
import { FIXTURE_IDS } from '../../src/demo/fixtures';
import type { Appointment, Availability, Patient } from '../../src/shared/contracts';

const clock = createDemoClock();
let api: ReturnType<typeof createDemoApi>;
const post = (body: unknown, key = crypto.randomUUID()) => ({ method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(body) });
const book = (patientId = FIXTURE_IDS.self, date = '2026-10-14', service = 'oral_check') => api.request<Appointment>('/api/appointments', post({ patientId, patientVersion: 1, service, date, ageConfirmed: patientId === FIXTURE_IDS.self ? 32 : patientId === FIXTURE_IDS.family ? 44 : 65, authorizationAcknowledged: true }));
const decision = (a: Appointment, value = 'approve') => api.request<Appointment>(`/api/admin/appointments/${a.id}/decision`, post({ version: a.version, decision: value, reason: 'เหตุผลสมมติ' }));
const cancel = (a: Appointment) => api.request<Appointment>(`/api/appointments/${a.id}/cancel`, post({ version: a.version }));

beforeEach(() => { clock.reset(); api = createDemoApi({ now: clock.now }); });

describe('tab-local demo contract', () => {
  it('returns pending then approved with generic simulated confirmation', async () => {
    const submitted = await book();
    expect(submitted.status).toBe('pending');
    api.setRole('admin');
    const afterDemoApproval = await decision(submitted);
    expect(afterDemoApproval.status).toBe('approved');
    api.setRole('patient');
    expect((await api.request<Appointment>(`/api/appointments/${submitted.id}`)).status).toBe('approved');
    expect(api.notifications()[0].text).not.toMatch(/คุณยิ้ม|ตรวจสุขภาพ|099|ที่อยู่/);
  });
  it('replays one key once and rejects altered payload', async () => {
    const key = crypto.randomUUID();
    const payload = { patientId: FIXTURE_IDS.self, patientVersion: 1, service: 'filling', date: '2026-10-14', ageConfirmed: 32, authorizationAcknowledged: true };
    const a = await api.request<Appointment>('/api/appointments', post(payload, key));
    expect(await api.request('/api/appointments', post(payload, key))).toEqual(a);
    expect(await api.request(`/api/submissions/${key}`)).toEqual(a);
    await expect(api.request('/api/appointments', post({ ...payload, service: 'scaling' }, key))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('fills shared three places and rejection or cancellation frees a seat', async () => {
    const a = await book(); await book(FIXTURE_IDS.family, '2026-10-14', 'scaling'); await book(FIXTURE_IDS.parent, '2026-10-14', 'filling');
    const profile = await api.request<Patient>('/api/patients', post({ fullName: 'ครอบครัว ทดลองเพิ่ม', phone: '0990000000', age: 65, address: 'ที่อยู่สมมติ', relationship: 'family', authorizationAcknowledged: true }));
    await expect(book(profile.id)).rejects.toMatchObject({ code: 'FULL' });
    api.setRole('admin'); await decision(a, 'reject'); api.setRole('patient');
    const replacement = await book(profile.id);
    expect(replacement.status).toBe('pending');
    await cancel(replacement);
    expect((await api.request<Availability[]>('/api/availability?from=2026-10-14&to=2026-10-14'))[0].state).toBe('available');
  });
  it.each([['2026-10-07', 'INELIGIBLE_DATE'], ['2027-01-06', 'INELIGIBLE_DATE'], ['2026-10-10', 'INELIGIBLE_DATE'], ['2026-10-12', 'INTAKE_CLOSED'], ['2026-10-13', 'INTAKE_CLOSED']])('refuses ineligible, weekend, closed or paused %s', async (date, code) => {
    await expect(book(FIXTURE_IDS.self, date)).rejects.toMatchObject({ code });
  });
  it.each(['2026-10-08', '2027-01-05'])('allows tomorrow and inclusive day 90: %s', async date => { expect((await book(FIXTURE_IDS.self, date)).status).toBe('pending'); });
  it('exposes full, paused and closed distinctly', async () => {
    const days = await api.request<Availability[]>('/api/availability?from=2026-10-08&to=2026-10-13');
    expect(days.find(d => d.date === '2026-10-09')?.state).toBe('full');
    expect(days.find(d => d.date === '2026-10-12')?.state).toBe('closed');
    expect(days.find(d => d.date === '2026-10-13')?.state).toBe('paused');
  });
  it('enforces exactly one active booking per profile/date across services', async () => { await book(); await expect(book(FIXTURE_IDS.self, '2026-10-14', 'scaling')).rejects.toMatchObject({ code: 'DUPLICATE' }); });
  it('checks expected version on competing decisions and cancellation', async () => {
    const a = await book(); api.setRole('admin'); await decision(a); await expect(decision(a, 'reject')).rejects.toMatchObject({ code: 'VERSION_CONFLICT' }); api.setRole('patient'); await expect(cancel(a)).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
  it('allows cancellation strictly before Bangkok midnight', async () => {
    const a = await book(); clock.set('2026-10-13T16:59:59.999Z'); expect((await cancel(a)).status).toBe('cancelled');
  });
  it('refuses cancellation at Bangkok midnight', async () => { const a = await book(); clock.set('2026-10-13T17:00:00Z'); await expect(cancel(a)).rejects.toMatchObject({ code: 'CUTOFF_PASSED' }); });
  it('refuses approval at 08:30 and preserves pending', async () => { const a = await book(); clock.set('2026-10-14T01:30:00Z'); api.setRole('admin'); await expect(decision(a)).rejects.toMatchObject({ code: 'CUTOFF_PASSED' }); expect((await api.request<Appointment[]>('/api/admin/appointments')).find(x => x.id === a.id)?.status).toBe('pending'); });
  it('completes/no-shows only after 09:30 and only from approved', async () => { const a = await book(); api.setRole('admin'); const approved = await decision(a); await expect(decision(approved, 'complete')).rejects.toMatchObject({ code: 'INVALID_TRANSITION' }); clock.set('2026-10-14T02:30:00Z'); expect((await decision(approved, 'no_show')).status).toBe('no_show'); });
  it('pause preserves requests, blocks approval and close requires resolution', async () => {
    const a = await book(); api.setRole('admin'); await api.request('/api/admin/dates/2026-10-14', { method: 'PUT', body: JSON.stringify({ intake: 'paused', reason: 'สาธิตหยุดรับ' }) });
    await expect(decision(a)).rejects.toMatchObject({ code: 'INTAKE_CLOSED' });
    await expect(api.request('/api/admin/dates/2026-10-14', { method: 'PUT', body: JSON.stringify({ intake: 'closed', reason: 'สาธิตปิด' }) })).rejects.toMatchObject({ code: 'UNRESOLVED_BOOKINGS' });
    api.setRole('patient'); await expect(book(FIXTURE_IDS.family)).rejects.toMatchObject({ code: 'INTAKE_CLOSED' }); await cancel(a); api.setRole('admin'); expect(await api.request('/api/admin/dates/2026-10-14', { method: 'PUT', body: JSON.stringify({ intake: 'closed', reason: 'สาธิตปิด' }) })).toMatchObject({ unresolved: 0 });
  });
  it('does not reject approved appointments to simulate clinic cancellation', async () => { const a = await book(); api.setRole('admin'); const approved = await decision(a); await expect(decision(approved, 'reject')).rejects.toMatchObject({ code: 'INVALID_TRANSITION' }); });
  it('sends one previous-day 18:00 approved reminder and suppresses cancellation', async () => {
    const a = await book(); api.setRole('admin'); const approved = await decision(a); clock.set('2026-10-13T11:00:00Z');
    await api.request('/api/demo/reminders', post({})); await api.request('/api/demo/reminders', post({}));
    expect(api.notifications().filter(n => n.appointmentId === a.id && n.type === 'reminder')).toHaveLength(1);
    api.setRole('patient'); await cancel(approved); clock.set('2026-10-14T00:00:00Z'); await api.request('/api/demo/reminders', post({})); expect(api.notifications().filter(n => n.appointmentId === a.id && n.type === 'reminder')).toHaveLength(1);
  });
  it('late approval receives confirmation only; cancelled scheduled event is suppressed', async () => {
    const a = await book(); api.setRole('admin'); clock.set('2026-10-13T11:00:00Z'); await decision(a); await api.request('/api/demo/reminders', post({})); expect(api.notifications().filter(n => n.appointmentId === a.id).map(n => n.type)).toEqual(['approval']);
    clock.reset(); api.reset(); const b = await book(); api.setRole('admin'); const approved = await decision(b); api.setRole('patient'); await cancel(approved); clock.set('2026-10-13T11:00:00Z'); await api.request('/api/demo/reminders', post({})); expect(api.notifications().filter(n => n.appointmentId === b.id && n.type === 'reminder')).toHaveLength(0);
  });
  it('foreign object and nonexistent object return identical not-found errors', async () => { for (const id of [FIXTURE_IDS.foreignAppointment, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee']) { await expect(api.request(`/api/appointments/${id}`)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 }); await expect(api.request(`/api/appointments/${id}/cancel`, post({ version: 1 }))).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 }); } });
  it('admin switch is required and client-supplied roles are rejected', async () => { await expect(api.request('/api/admin/appointments')).rejects.toMatchObject({ code: 'FORBIDDEN' }); await expect(api.request('/api/appointments', post({ role: 'admin' }))).rejects.toMatchObject({ code: 'VALIDATION' }); });
  it('profile updates enforce version; script strings remain literal data', async () => { const patients = await api.request<Patient[]>('/api/patients'); const self = patients.find(p => p.id === FIXTURE_IDS.self)!; const { id, ageCapturedOn, version, ...fields } = self; expect(ageCapturedOn).toBe('2026-10-07'); await api.request(`/api/patients/${id}`, { method: 'PATCH', body: JSON.stringify({ ...fields, version, fullName: '<script>alert(1)</script>' }) }); await expect(book()).rejects.toMatchObject({ code: 'VERSION_CONFLICT' }); });
  it('fresh instance and reset erase mutations without storage or network', async () => { const fetch = vi.spyOn(globalThis, 'fetch'); const local = vi.spyOn(Storage.prototype, 'setItem'); const key = crypto.randomUUID(); const a = await api.request<Appointment>('/api/appointments', post({ patientId: FIXTURE_IDS.self, patientVersion: 1, service: 'oral_check', date: '2026-10-14', ageConfirmed: 32, authorizationAcknowledged: true }, key)); expect(await api.request(`/api/submissions/${key}`)).toEqual(a); api.reset(); expect(await api.request(`/api/submissions/${key}`)).toBeNull(); await expect(api.request(`/api/appointments/${a.id}`)).rejects.toMatchObject({ code: 'NOT_FOUND' }); expect((await createDemoApi({ now: clock.now }).request<Appointment[]>('/api/appointments')).find(x => x.id === a.id)).toBeUndefined(); expect(fetch).not.toHaveBeenCalled(); expect(local).not.toHaveBeenCalled(); });
});


describe('intake calendar boundaries', () => {
  it('refuses reopening a weekend rather than reporting it open', async () => {
    api.setRole('admin');
    await expect(api.request('/api/admin/dates/2026-10-10', {
      method: 'PUT', body: JSON.stringify({ intake: 'open', reason: 'สาธิตเปิดวัน' }),
    })).rejects.toMatchObject({ code: 'INELIGIBLE_DATE' });
    expect((await api.request<Availability[]>('/api/availability?from=2026-10-10&to=2026-10-10'))[0].state).toBe('closed');
  });
  it('limits intake reasons to the same 500-character public form limit', async () => {
    api.setRole('admin');
    await expect(api.request('/api/admin/dates/2026-10-14', {
      method: 'PUT', body: JSON.stringify({ intake: 'paused', reason: 'ก'.repeat(501) }),
    })).rejects.toMatchObject({ code: 'VALIDATION', status: 400 });
  });
});

describe('clinic emergency cancellation', () => {
  it.each(['2026-10-13T17:00:00Z', '2026-10-14T02:30:00Z'])('allows approved clinic cancellation after the patient cutoff at %s', async time => {
    const a = await book(); api.setRole('admin'); const approved = await decision(a); clock.set(time);
    expect(await decision(approved, 'cancel')).toMatchObject({ id: a.id, date: a.date, status: 'cancelled', version: approved.version + 1, approvedAt: approved.approvedAt });
    api.setRole('patient');
    expect((await api.request<Appointment>(`/api/appointments/${a.id}`)).status).toBe('cancelled');
  });
  it('requires admin access for the clinic route', async () => {
    const a = await book(); await expect(decision(a, 'cancel')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });
  it.each(['pending', 'rejected', 'cancelled', 'completed', 'no_show'] as const)('rejects clinic cancellation of %s appointments', async status => {
    let a = await book(); api.setRole('admin');
    if (status === 'rejected') a = await decision(a, 'reject');
    else if (status !== 'pending') { a = await decision(a); if (status === 'cancelled') { api.setRole('patient'); a = await cancel(a); api.setRole('admin'); } else { clock.set('2026-10-14T02:30:00Z'); a = await decision(a, status === 'completed' ? 'complete' : 'no_show'); } }
    await expect(decision(a, 'cancel')).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
  });
  it.each([undefined, '', '   ', 'ก'.repeat(501)])('rejects missing or invalid reason before changing approved state', async reason => {
    const a = await book(); api.setRole('admin'); const approved = await decision(a);
    await expect(api.request(`/api/admin/appointments/${a.id}/decision`, post({ version: approved.version, decision: 'cancel', reason }))).rejects.toMatchObject({ code: 'VALIDATION', status: 400 });
    expect((await api.request<Appointment[]>('/api/admin/appointments')).find(item => item.id === a.id)).toEqual(approved);
  });
  it('frees a seat, sends one private-safe cancellation example, and suppresses the reminder', async () => {
    const a = await book(); await book(FIXTURE_IDS.family); await book(FIXTURE_IDS.parent);
    api.setRole('admin'); const approved = await decision(a);
    expect((await api.request<Availability[]>('/api/availability?from=2026-10-14&to=2026-10-14'))[0].state).toBe('full');
    const cancelled = await decision(approved, 'cancel');
    await expect(decision(approved, 'cancel')).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    await expect(decision(cancelled, 'cancel')).rejects.toMatchObject({ code: 'INVALID_TRANSITION' });
    expect((await api.request<Availability[]>('/api/availability?from=2026-10-14&to=2026-10-14'))[0].state).toBe('available');
    clock.set('2026-10-13T11:00:00Z'); await api.request('/api/demo/reminders', post({}));
    const notices = api.notifications().filter(n => n.appointmentId === a.id);
    expect(notices.map(n => n.type)).toEqual(['approval', 'cancellation']);
    expect(notices[1].text).toContain('คลินิกยกเลิกนัดหมาย');
    expect(notices[1].text).not.toContain(a.patient.fullName); expect(notices[1].text).not.toContain('เหตุผลสมมติ');
  });
  it('lets an emergency closure finish only after each active booking is individually resolved', async () => {
    const a = await book(); api.setRole('admin'); const approved = await decision(a);
    const close = () => api.request('/api/admin/dates/2026-10-14', { method: 'PUT', body: JSON.stringify({ intake: 'closed', reason: 'ปิดฉุกเฉิน' }) });
    await expect(close()).rejects.toMatchObject({ code: 'UNRESOLVED_BOOKINGS' });
    await decision(approved, 'cancel'); expect(await close()).toMatchObject({ intake: 'closed', unresolved: 0 });
  });
});
