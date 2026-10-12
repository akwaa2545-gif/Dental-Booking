import type { Appointment, Availability, BookingInput, Decision, Intake, Patient, Status } from '../shared/contracts';
import { bangkokDate, bookingRange, cancelBefore, isISODate, reminderAt } from '../shared/calendar';
import { parseBooking, parsePatient } from '../shared/validation';
import { ApiRequestError, type ApiClient } from '../web/api';
import { createDemoManagement } from './admin-management';
import { addDays, createFixtures, weekday } from './fixtures';

export type DemoNotification = { id: string; appointmentId: string; type: 'approval' | 'rejection' | 'cancellation' | 'reminder'; text: string; at: string; state: 'simulated' };
export type DemoRole = 'patient' | 'admin' | 'other' | 'owner';
export interface DemoApi extends ApiClient { isAdmin(): boolean; subscribe(listener: () => void): () => void; setRole(role: DemoRole): void; reset(): void; notifications(): DemoNotification[]; examples: ReturnType<typeof createFixtures>['examples'] }
const texts = { cancellation: 'ตัวอย่างการแจ้งเตือน: คลินิกยกเลิกนัดหมาย กรุณาดูสถานะล่าสุดในเว็บไซต์และเริ่มคำขอใหม่เมื่อต้องการนัดอีกครั้ง', approval: 'ตัวอย่างการแจ้งเตือน: คำขอนัดหมายได้รับการอนุมัติ ดูสถานะล่าสุดในเว็บไซต์', rejection: 'ตัวอย่างการแจ้งเตือน: คำขอนัดหมายไม่ได้รับการอนุมัติ ดูสถานะล่าสุดในเว็บไซต์', reminder: 'ตัวอย่างการแจ้งเตือน: คุณมีนัดหมายวันพรุ่งนี้ ดูรายละเอียดล่าสุดในเว็บไซต์' };
const active = (a: Appointment) => a.status === 'pending' || a.status === 'approved';
const copy = <T,>(value: T): T => structuredClone(value);
function fail(code: ApiRequestError['code'], status = 409): never { throw new ApiRequestError(code, status); }
function exact(value: unknown, keys: string[]): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)) || keys.some(k => !(k in value))) fail('VALIDATION', 400); return value as Record<string, unknown>; }
function version(value: unknown): number { if (!Number.isInteger(value) || Number(value) < 1) fail('VALIDATION', 400); return Number(value); }

/** Fictional single-tab simulation. This is not authentication or a concurrency boundary. */
export function createDemoApi({ now }: { now: () => Date }): DemoApi {
  const seedTime = now();
  let state = createFixtures(seedTime);
  let role: DemoRole = 'patient';
  const listeners = new Set<() => void>();
  const notifyAuthority = () => { for (const listener of listeners) listener(); };
  const management = createDemoManagement({ now, role: () => role, origin: () => window.location.origin });
  let notices: DemoNotification[] = [];
  let submissions = new Map<string, { fingerprint: string; appointment: Appointment }>();
  let reminders = new Map<string, { dueAt: string; sent: boolean }>();
  const seedReminders = () => { reminders = new Map(state.appointments.filter(a => a.status === 'approved').map(a => [a.id, { dueAt: reminderAt(a.date), sent: false }])); };
  seedReminders();
  const actor = () => role === 'other' ? 'B' : 'A';
  const ownPatient = (id: string) => { const p = state.patients.find(p => p.id === id); if (!p || state.owners.get(id) !== actor()) fail('NOT_FOUND', 404); return p; };
  const ownAppointment = (id: string) => { const a = state.appointments.find(a => a.id === id); if (!a || state.owners.get(a.patientId) !== actor()) fail('NOT_FOUND', 404); return a; };
  const admin = () => { if (!management.isAdmin()) fail('FORBIDDEN', 403); };
  const available = (date: string): Availability => {
    const range = bookingRange(now());
    if (date < range.min || date > range.max) return { date, state: 'ineligible' };
    if (!weekday(date) || state.intakes.get(date) === 'closed') return { date, state: 'closed' };
    if (state.intakes.get(date) === 'paused') return { date, state: 'paused' };
    return { date, state: state.appointments.filter(a => a.date === date && active(a)).length >= 3 ? 'full' : 'available' };
  };
  const notify = (a: Appointment, type: DemoNotification['type']) => { notices.push({ id: crypto.randomUUID(), appointmentId: a.id, type, text: texts[type], at: now().toISOString(), state: 'simulated' }); };
  const api: DemoApi = {
    dataMode: 'demo',
    examples: state.examples,
    isAdmin: management.isAdmin,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setRole(next) { role = next; notifyAuthority(); },
    reset() { state = createFixtures(seedTime); role = 'patient'; management.reset(); notices = []; submissions = new Map(); seedReminders(); notifyAuthority(); },
    notifications: () => copy(notices.filter(n => role === 'admin' || state.owners.get(state.appointments.find(a => a.id === n.appointmentId)?.patientId ?? '') === actor())),
    async request<T>(path: string, init: RequestInit = {}): Promise<T> {
      if (!path.startsWith('/api/')) fail('NOT_FOUND', 404);
      const url = new URL(path, 'https://fictional.invalid');
      const route = url.pathname;
      const method = (init.method ?? 'GET').toUpperCase();
      let body: unknown = null;
      if (init.body) { try { body = JSON.parse(String(init.body)); } catch { fail('VALIDATION', 400); } }
      let managementResult: unknown;
      try { managementResult = management.handle(url, method, body); }
      finally { notifyAuthority(); }
      if (managementResult !== undefined) return copy(managementResult) as T;
      let result: unknown;
      if (route === '/api/patients' && method === 'GET') result = state.patients.filter(p => state.owners.get(p.id) === actor());
      else if (route === '/api/patients' && method === 'POST') {
        let fields; try { fields = parsePatient(body); } catch { fail('VALIDATION', 400); }
        const patient: Patient = { ...fields, id: crypto.randomUUID(), ageCapturedOn: bangkokDate(now()), version: 1 };
        state.patients.push(patient); state.owners.set(patient.id, actor()); result = patient;
      } else if (/^\/api\/patients\/[^/]+$/.test(route) && method === 'PATCH') {
        const p = ownPatient(route.split('/')[3]); const fields = exact(body, ['version', 'fullName', 'phone', 'age', 'address', 'relationship', 'authorizationAcknowledged']); const expected = version(fields.version);
        if (expected !== p.version) fail('VERSION_CONFLICT');
        const { version: _version, ...input } = fields; void _version;
        let parsed; try { parsed = parsePatient(input); } catch { fail('VALIDATION', 400); }
        Object.assign(p, parsed, { version: p.version + 1, ageCapturedOn: bangkokDate(now()) }); result = p;
      } else if (route === '/api/availability' && method === 'GET') {
        const from = url.searchParams.get('from') ?? bookingRange(now()).min; const to = url.searchParams.get('to') ?? bookingRange(now()).max;
        if (!isISODate(from) || !isISODate(to) || from > to || new Date(to).getTime() - new Date(from).getTime() > 91 * 86400000) fail('VALIDATION', 400);
        const days = []; for (let date = from; date <= to; date = addDays(date, 1)) days.push(available(date)); result = days;
      } else if (route === '/api/appointments' && method === 'POST') {
        let input: BookingInput; try { input = parseBooking(body); } catch { fail('VALIDATION', 400); }
        const key = new Headers(init.headers).get('Idempotency-Key'); if (!key || !/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(key)) fail('VALIDATION', 400);
        const p = ownPatient(input.patientId); const fingerprint = JSON.stringify(input); const keyWithActor = `${actor()}:${key}`; const existing = submissions.get(keyWithActor);
        if (existing) { if (existing.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT'); return copy(existing.appointment) as T; }
        if (p.version !== input.patientVersion || p.age !== input.ageConfirmed) fail('VERSION_CONFLICT');
        const day = available(input.date); if (day.state === 'full') fail('FULL'); if (day.state === 'paused' || state.intakes.get(input.date) === 'closed') fail('INTAKE_CLOSED'); if (day.state !== 'available') fail('INELIGIBLE_DATE');
        if (state.appointments.some(a => a.patientId === p.id && a.date === input.date && active(a))) fail('DUPLICATE');
        const id = crypto.randomUUID(); const { id: _id, version: _v, ageCapturedOn: _date, ...patient } = p; void _id; void _v; void _date;
        const appointment: Appointment = { id, reference: `DEMO-${id.slice(0, 8).toUpperCase()}`, patientId: p.id, patient, service: input.service, date: input.date, status: 'pending', version: 1, createdAt: now().toISOString(), approvedAt: null, cancelBefore: cancelBefore(input.date) };
        state.appointments.push(appointment); submissions.set(keyWithActor, { fingerprint, appointment: copy(appointment) }); result = appointment;
      } else if (/^\/api\/submissions\/[^/]+$/.test(route) && method === 'GET') { const entry = submissions.get(`${actor()}:${route.split('/')[3]}`); result = entry ? ownAppointment(entry.appointment.id) : null; }
      else if (route === '/api/appointments' && method === 'GET') result = state.appointments.filter(a => state.owners.get(a.patientId) === actor());
      else if (/^\/api\/appointments\/[^/]+$/.test(route) && method === 'GET') result = ownAppointment(route.split('/')[3]);
      else if (/^\/api\/appointments\/[^/]+\/cancel$/.test(route) && method === 'POST') {
        const a = ownAppointment(route.split('/')[3]); const expected = version(exact(body, ['version']).version); if (a.version !== expected) fail('VERSION_CONFLICT'); if (!active(a)) fail('INVALID_TRANSITION'); if (now().getTime() >= new Date(a.cancelBefore).getTime()) fail('CUTOFF_PASSED'); a.status = 'cancelled'; a.version++; result = a;
      } else if (route === '/api/admin/appointments' && method === 'GET') {
        admin(); const date = url.searchParams.get('date'); const status = url.searchParams.get('status'); if (date && !isISODate(date)) fail('VALIDATION', 400); if (status && !['pending', 'approved', 'rejected', 'cancelled', 'completed', 'no_show'].includes(status)) fail('VALIDATION', 400);
        result = state.appointments.filter(a => (!date || a.date === date) && (!status || a.status === status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      } else if (/^\/api\/admin\/appointments\/[^/]+\/decision$/.test(route) && method === 'POST') {
        admin(); const a = state.appointments.find(a => a.id === route.split('/')[4]); if (!a) fail('NOT_FOUND', 404); const fields = exact(body, ['version', 'decision', 'reason']); if (a.version !== version(fields.version)) fail('VERSION_CONFLICT');
        const d = fields.decision as Decision; if (!['approve', 'reject', 'cancel', 'complete', 'no_show'].includes(d) || typeof fields.reason !== 'string' || !fields.reason.trim() || fields.reason.length > 500) fail('VALIDATION', 400);
        if ((d === 'approve' || d === 'reject') && a.status !== 'pending') fail('INVALID_TRANSITION');
        if (d === 'approve') { if (state.intakes.get(a.date) && state.intakes.get(a.date) !== 'open') fail('INTAKE_CLOSED'); if (now().getTime() >= new Date(`${a.date}T08:30:00+07:00`).getTime()) fail('CUTOFF_PASSED'); a.status = 'approved'; a.approvedAt = now().toISOString(); notify(a, 'approval'); if (now().getTime() < new Date(reminderAt(a.date)).getTime()) reminders.set(a.id, { dueAt: reminderAt(a.date), sent: false }); }
        else if (d === 'reject') { a.status = 'rejected'; notify(a, 'rejection'); }
        else if (d === 'cancel') { if (a.status !== 'approved') fail('INVALID_TRANSITION'); a.status = 'cancelled'; reminders.delete(a.id); notify(a, 'cancellation'); }
        else { if (a.status !== 'approved' || now().getTime() < new Date(`${a.date}T09:30:00+07:00`).getTime()) fail('INVALID_TRANSITION'); a.status = d === 'complete' ? 'completed' : 'no_show'; }
        a.version++; result = a;
      } else if (/^\/api\/admin\/dates\/[^/]+$/.test(route) && method === 'PUT') {
        admin(); const date = route.split('/')[4]; const fields = exact(body, ['intake', 'reason']); if (!isISODate(date) || !['open', 'paused', 'closed'].includes(String(fields.intake)) || typeof fields.reason !== 'string' || !fields.reason.trim() || fields.reason.length > 500) fail('VALIDATION', 400);
        if (!weekday(date) && fields.intake === 'open') fail('INELIGIBLE_DATE');
        const unresolved = state.appointments.filter(a => a.date === date && active(a)).length; if (fields.intake === 'closed' && unresolved) fail('UNRESOLVED_BOOKINGS'); state.intakes.set(date, fields.intake as Intake); result = { date, intake: fields.intake, unresolved };
      } else if (route === '/api/demo/reminders' && method === 'POST') {
        exact(body, []); for (const [id, event] of reminders) { const a = state.appointments.find(a => a.id === id); if (!event.sent && a?.status === 'approved' && now().getTime() >= new Date(event.dueAt).getTime() && bangkokDate(now()) < a.date) { notify(a, 'reminder'); event.sent = true; } } result = api.notifications();
      } else fail('NOT_FOUND', 404);
      return copy(result) as T;
    },
  };
  return api;
}
export function resetDemo(api: DemoApi): void { api.reset(); }
export const STATUS_LABELS: Record<Status, string> = { pending: '◷ รอการอนุมัติ', approved: '✓ อนุมัติแล้ว', rejected: '× ไม่อนุมัติ', cancelled: '− ยกเลิกแล้ว', completed: '✓ รับบริการแล้ว', no_show: '! ไม่มาตามนัด' };
