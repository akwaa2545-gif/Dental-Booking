import type { Appointment, Intake, Patient } from '../shared/contracts';
import { bangkokDate, cancelBefore } from '../shared/calendar';

export const FIXTURE_IDS = {
  self: '11111111-1111-4111-8111-111111111111', family: '22222222-2222-4222-8222-222222222222', parent: '33333333-3333-4333-8333-333333333333', child: '44444444-4444-4444-8444-444444444444',
  foreign: '55555555-5555-4555-8555-555555555555', foreign2: '66666666-6666-4666-8666-666666666666', foreignAppointment: '77777777-7777-4777-8777-777777777777',
};
export function addDays(date: string, offset: number): string { return new Date(new Date(`${date}T12:00:00Z`).getTime() + offset * 86400000).toISOString().slice(0, 10); }
export function weekday(date: string): boolean { const day = new Date(`${date}T12:00:00Z`).getUTCDay(); return day !== 0 && day !== 6; }
export function createFixtures(now: Date) {
  const today = bangkokDate(now);
  const open = Array.from({ length: 20 }, (_, i) => addDays(today, i + 1)).filter(weekday);
  const names = ['คุณยิ้ม ทดลอง', 'คุณใจดี สมมติ', 'คุณอุ่นใจ สมมติ', 'เด็กตัวอย่าง สมมติ', 'บัญชีอื่น สมมติ', 'ครอบครัวบัญชีอื่น สมมติ'];
  const ids = [FIXTURE_IDS.self, FIXTURE_IDS.family, FIXTURE_IDS.parent, FIXTURE_IDS.child, FIXTURE_IDS.foreign, FIXTURE_IDS.foreign2];
  const patients: Patient[] = ids.map((id, i) => ({ id, fullName: names[i], phone: '0990000000', age: [32, 44, 65, 12, 41, 55][i], address: '99 ถนนสมมติ ตำบลตัวอย่าง (ข้อมูลทดสอบ)', relationship: i === 0 || i === 4 ? 'self' : i === 3 ? 'guardian' : i === 2 ? 'parent' : 'family', authorizationAcknowledged: true, ageCapturedOn: today, version: 1 }));
  const make = (patient: Patient, date: string, status: Appointment['status'], service: Appointment['service'], id: string = crypto.randomUUID()): Appointment => ({ id, reference: `DEMO-${id.slice(0, 8).toUpperCase()}`, patientId: patient.id, patient: { fullName: patient.fullName, phone: patient.phone, age: patient.age, address: patient.address, relationship: patient.relationship, authorizationAcknowledged: true }, service, date, status, version: 1, createdAt: new Date(now.getTime() - 86400000).toISOString(), approvedAt: status === 'approved' ? new Date(now.getTime() - 3600000).toISOString() : null, cancelBefore: cancelBefore(date) });
  const appointments = [make(patients[1], open[0], 'approved', 'scaling'), make(patients[2], open[1], 'pending', 'filling'), make(patients[4], open[1], 'approved', 'oral_check', FIXTURE_IDS.foreignAppointment), make(patients[5], open[1], 'pending', 'scaling'), ...(['rejected', 'cancelled', 'completed', 'no_show'] as const).map((status, i) => make(patients[i % 4], addDays(today, -i - 2), status, 'oral_check'))];
  const owners = new Map(patients.map((p, i) => [p.id, i < 4 ? 'A' : 'B']));
  const intakes = new Map<string, Intake>([[open[2], 'closed' as const], [open[3], 'paused' as const]]);
  return { patients, appointments, owners, intakes, examples: { next: open[0], full: open[1], closed: open[2], paused: open[3] } };
}

/** Fictional management identities are separate from patient profiles and provider accounts. */
export function createManagementFixtures(now: Date) {
  const createdAt = new Date(now.getTime() - 3600000).toISOString();
  return {
    grants: [
      { id: 'a0000000-0000-4000-8000-000000000001', actor: 'A', label: null as string | null, reference: 'AD-DEMO-A', grantedAt: now.toISOString(), revokedAt: null as string | null, protectedOwner: false },
      { id: 'a0000000-0000-4000-8000-000000000002', actor: 'OWNER', label: 'เจ้าของระบบสมมติ' as string | null, reference: 'AD-DEMO-OWNER', grantedAt: now.toISOString(), revokedAt: null as string | null, protectedOwner: true },
    ],
    pending: {
      summary: { id: 'b0000000-0000-4000-8000-000000000001', label: 'ผู้รับคำเชิญ B สมมติ', reason: 'ตัวอย่างสมมติสำหรับสาธิต', state: 'claimed' as const, version: 2, createdAt, expiresAt: new Date(Date.parse(createdAt) + 86400000).toISOString(), claimedAt: new Date(now.getTime() - 1800000).toISOString(), claimReference: 'AC-DEMO-B', canClose: true },
      issuer: 'A', issuerGrantId: 'a0000000-0000-4000-8000-000000000001', token: 's'.repeat(43), claimant: 'B', code: '01234567', attempts: 0, approver: null, closedBy: null,
    },
  };
}
