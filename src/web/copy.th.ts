import type { Service } from '../shared/contracts';

export const SERVICE_LABELS: Record<Service, string> = {
  oral_check: 'ตรวจสุขภาพช่องปาก',
  scaling: 'ขูดหินปูน',
  filling: 'อุดฟัน',
};

export const SERVICES: Service[] = ['oral_check', 'scaling', 'filling'];
export const SERVICE_DESCRIPTIONS: Record<Service, string> = {
  oral_check: 'ตรวจฟันและประเมินสุขภาพช่องปาก เพื่อวางแผนการดูแลที่เหมาะกับคุณ',
  scaling: 'นัดประเมินและดูแลคราบหินปูน พร้อมคำแนะนำการดูแลเหงือก',
  filling: 'นัดตรวจและประเมินฟันผุ โดยทันตแพทย์เป็นผู้พิจารณาการรักษา',
};
export const CLINIC_NAME = 'ห้องทันตกรรม โรงพยาบาลส่งเสริมสุขภาพตำบลบ้านควนไทรงาม';
export const CLINIC_SHORT_NAME = 'ห้องทันตกรรม รพ.สต.บ้านควนไทรงาม';
export const FIXED_WINDOW = '08:30–09:30';
export const TEST_DATA_BANNER = 'ข้อมูลสมมติสำหรับสาธิตเท่านั้น';

export const STATUS_LABELS = { pending: '◷ รอการอนุมัติ', approved: '✓ อนุมัติแล้ว', rejected: '× ไม่อนุมัติ', cancelled: '− ยกเลิกแล้ว', completed: '✓ รับบริการแล้ว', no_show: '! ไม่มาตามนัด' } as const;
export function formatThaiDate(date: string): string { return new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeZone: 'Asia/Bangkok' }).format(new Date(`${date}T12:00:00+07:00`)); }

export const INVITATION_STATE_LABELS = {
  issued: 'รอรับคำเชิญ', claimed: 'รอตรวจรหัสและอนุมัติ', approved: 'ให้สิทธิ์แล้ว',
  rejected: 'ปฏิเสธแล้ว', cancelled: 'ยกเลิกแล้ว', locked: 'ล็อกแล้ว', expired: 'หมดอายุแล้ว', invalidated: 'ใช้ต่อไม่ได้แล้ว',
} as const;
export const ADMIN_APPROVAL_CONSEQUENCE = 'บัญชีนี้จะจัดการนัดหมายและเชิญผู้ดูแลเพิ่มได้';
export const MANAGEMENT_AUDIT_LABELS: Record<string, string> = {
  invitation_created: 'สร้างคำเชิญ', invitation_claimed: 'รับคำเชิญ', invitation_approved: 'ให้สิทธิ์ผู้ดูแล',
  invitation_cancelled: 'ยกเลิกคำเชิญ', invitation_rejected: 'ปฏิเสธคำเชิญ', invitation_locked: 'ล็อกคำเชิญ',
  invitation_verification_failed: 'ตรวจรหัสไม่ผ่าน', admin_revoked: 'ถอนสิทธิ์ผู้ดูแล',
};
