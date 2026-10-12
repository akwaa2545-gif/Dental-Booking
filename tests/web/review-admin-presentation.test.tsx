import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AdminAppointment, Patient } from '../../src/shared/contracts';
import type { ApiClient } from '../../src/web/api';
import { Dashboard } from '../../src/web/admin/Dashboard';
import { ReviewRequest } from '../../src/web/booking/ReviewRequest';

const now = () => new Date('2026-10-08T03:00:00Z');
const patient: Patient = {
  id: 'synthetic-patient', fullName: 'ผู้รับบริการ สมมติ', phone: '0990000000',
  age: 32, address: '99 ถนนสมมติ', relationship: 'self', authorizationAcknowledged: true,
  ageCapturedOn: '2026-10-08', version: 1,
};

function appointment(id: string, status: AdminAppointment['status'] = 'pending'): AdminAppointment {
  return {
    id, reference: `SYNTHETIC-${id}`, patientId: patient.id,
    patient: { ...patient, fullName: `Synthetic ${id}` }, service: 'scaling',
    date: '2026-10-09', status, version: 1, createdAt: '2026-10-08T01:00:00Z',
    approvedAt: status === 'approved' ? '2026-10-08T02:00:00Z' : null,
    cancelBefore: '2026-10-08T17:00:00Z', notificationAttempts: [],
  };
}

function api(items: AdminAppointment[], dataMode: 'demo' | 'server' = 'server'): ApiClient {
  return {
    dataMode,
    async request<T>(path: string): Promise<T> {
      return (path === '/api/availability' ? [{ date: '2026-10-09', state: 'available' }] : items) as T;
    },
  };
}

describe('review and admin presentation groups', () => {
  it('separates appointment, patient and conditions into three labelled review cards', () => {
    render(<ReviewRequest patient={patient} service="scaling" date="2026-10-09" />);
    const details = screen.getByRole('region', { name: 'รายละเอียดนัดหมาย' });
    const person = screen.getByRole('region', { name: 'ข้อมูลผู้รับบริการ' });
    const conditions = screen.getByRole('region', { name: 'เงื่อนไขและความเป็นส่วนตัว' });

    expect(details).toHaveClass('review-card', 'review-appointment');
    expect(person).toHaveClass('review-card', 'review-patient');
    expect(conditions).toHaveClass('review-card', 'review-conditions');
    expect(details.parentElement).toHaveClass('review-cards');
    expect(details.parentElement?.children).toHaveLength(3);
    expect(person.parentElement).toBe(details.parentElement);
    expect(conditions.parentElement).toBe(details.parentElement);
    expect(within(details).getByText('ขูดหินปูน')).toBeVisible();
    expect(within(details).getByText(/9 ตุลาคม/)).toBeVisible();
    expect(within(details).getByText('08:30–09:30 น. · Asia/Bangkok')).toBeVisible();
    for (const value of [patient.fullName, patient.phone, '32 ปี', patient.address]) {
      expect(within(person).getByText(value)).toBeVisible();
      expect(within(details).queryByText(value)).not.toBeInTheDocument();
    }
    expect(within(conditions).getByText('ก่อน 00:00 น. ของวันนัด (2026-10-09) ตามเวลาไทย')).toBeVisible();
    expect(screen.getByText('การส่งคำขอยังไม่ใช่การยืนยัน ต้องรอคลินิกอนุมัติ')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'ตรวจสอบคำขอนัดหมาย' })).toHaveAttribute('tabindex', '-1');
  });

  it.each(['demo', 'server'] as const)('keeps %s privacy and contact caveats inside the conditions card', dataMode => {
    render(<ReviewRequest patient={patient} service="oral_check" date="2026-10-09" dataMode={dataMode} />);
    const conditions = within(screen.getByRole('region', { name: 'เงื่อนไขและความเป็นส่วนตัว' }));
    expect(conditions.getByText(/ห้ามใช้ข้อมูลผู้ป่วยจริง/)).toBeVisible();
    expect(conditions.getByText(/ติดต่อคลินิก: ยังไม่ตั้งค่าช่องทางที่ตรวจสอบแล้ว/)).toBeVisible();
    if (dataMode === 'server') {
      expect(conditions.getByText(/โหลดหน้าใหม่ไม่ลบข้อมูล/)).toBeVisible();
      expect(conditions.queryByText(/การเข้าสู่ระบบ LINE และข้อความทั้งหมดเป็นการจำลอง/)).not.toBeInTheDocument();
    } else {
      expect(conditions.getByText(/ข้อมูลนี้อยู่ในหน่วยความจำของแท็บเท่านั้น โหลดหน้าใหม่เพื่อล้าง/)).toBeVisible();
      expect(conditions.getByText(/การเข้าสู่ระบบ LINE และข้อความทั้งหมดเป็นการจำลอง/)).toBeVisible();
    }
  });

  it('groups admin filters, existing day summary and request details without changing the queue', async () => {
    const user = userEvent.setup();
    const pending = appointment('pending');
    pending.notificationAttempts = [{ kind: 'approval', state: 'queued', attemptCount: 2 }];
    render(<Dashboard api={api([pending, appointment('approved', 'approved')])} now={now} />);

    const filters = screen.getByRole('region', { name: 'ตัวกรองคำขอ' });
    const summary = screen.getByRole('region', { name: 'สรุปวันที่เลือก' });
    const queue = screen.getByRole('region', { name: 'รายการคำขอนัดหมาย' });
    expect(filters.parentElement).toHaveClass('admin-dashboard');
    expect(filters).toHaveClass('admin-filters');
    expect(queue).toHaveClass('admin-queue');
    expect(await within(summary).findByText('2/3 ที่ใช้ในวันที่เลือก')).toBeVisible();
    expect(summary.querySelectorAll('.admin-summary-card')).toHaveLength(3);
    expect(within(summary).getByText('รับคำขอได้ตามปฏิทิน')).toBeVisible();
    expect(within(summary).getByText('08:30–09:30 น. เวลาไทย')).toBeVisible();
    expect(within(filters).getByLabelText('วันที่นัด')).toHaveValue('2026-10-09');
    expect(within(filters).getByLabelText('สถานะคำขอ')).toHaveValue('pending');
    expect(within(queue).getAllByRole('article')).toHaveLength(1);

    const card = within(queue).getByRole('article');
    expect(card).toHaveClass('appointment-card', 'admin-appointment-card');
    expect(within(card).getByText('◷ รอการอนุมัติ')).toHaveClass('status-badge', 'pending');
    expect(card.querySelector('.admin-card-details')).toHaveTextContent('Synthetic pending');
    expect(card.querySelector('.admin-card-details')).toHaveTextContent('ขูดหินปูน');
    expect(card.querySelector('.admin-card-details')).toHaveTextContent('รอมาแล้ว 2 ชั่วโมง · นัดวันพรุ่งนี้');
    expect(card.querySelector('.admin-notifications')).toHaveTextContent('ยืนยันอนุมัติ · รอส่ง · พยายามส่ง 2 ครั้ง');
    const actions = card.querySelector<HTMLElement>('.admin-card-actions')!;
    await user.click(within(actions).getByRole('button', { name: 'พิจารณาคำขอ' }));
    expect(screen.getByRole('dialog', { name: 'พิจารณานัดหมาย' })).toBeVisible();
    expect(screen.getByLabelText('เหตุผล')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'อนุมัติคำขอ' })).toBeDisabled();
  });

  it('preserves demo notification copy and status-specific actions when showing all request cards', async () => {
    const user = userEvent.setup();
    render(<Dashboard api={api([appointment('approved', 'approved'), appointment('cancelled', 'cancelled')], 'demo')} now={now} />);
    await screen.findByText('1/3 ที่ใช้ในวันที่เลือก');
    const queue = screen.getByRole('region', { name: 'รายการคำขอนัดหมาย' });
    expect(within(queue).getByText('ไม่พบคำขอในตัวกรองนี้')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'ดูทุกวันและสถานะ' }));
    const [approved, cancelled] = within(queue).getAllByRole('article');
    expect(approved.querySelector('.admin-notifications')).toHaveTextContent('การแจ้งเตือน: ตัวอย่างเท่านั้น ไม่มีการส่งจริง');
    expect(within(approved).getByRole('button', { name: 'จัดการนัดหมาย' })).toBeEnabled();
    expect(cancelled.querySelector('.admin-notifications')).toHaveTextContent('การแจ้งเตือน: ยังไม่มีการส่งจริง');
    expect(within(cancelled).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText('2/3 ที่ใช้ในวันที่เลือก')).not.toBeInTheDocument();
  });
});
