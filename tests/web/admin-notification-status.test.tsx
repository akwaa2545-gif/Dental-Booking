import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AdminAppointment, AdminNotificationSummary } from '../../src/shared/contracts';
import { Dashboard } from '../../src/web/admin/Dashboard';
import { NotificationHistory } from '../../src/web/admin/WorkspaceViews';
import { ApiRequestError, type ApiClient } from '../../src/web/api';

const now = () => new Date('2026-10-08T03:00:00Z');
const record: AdminAppointment = {
  id: 'synthetic-one', reference: 'SYNTHETIC-one', patientId: 'synthetic-patient',
  patient: { fullName: 'Synthetic Patient', phone: '0000000000', address: 'Synthetic', age: 25, relationship: 'self', authorizationAcknowledged: true },
  service: 'scaling', date: '2026-10-09', status: 'pending', version: 1,
  createdAt: '2026-10-08T02:00:00Z', approvedAt: null, cancelBefore: '2026-10-08T17:00:00Z',
  notificationAttempts: [{ kind: 'approval', state: 'accepted', attemptCount: 1 }],
};
const attempt = (overrides: Partial<AdminNotificationSummary> = {}): AdminNotificationSummary => ({
  recipientLabel: 'แอดมิน 1', state: 'accepted', attemptCount: 1, safeReason: null, ...overrides,
});
function history(attempts: AdminNotificationSummary[]) {
  render(<NotificationHistory items={[{ ...record, adminNotificationAttempts: attempts }]} />);
  return within(screen.getByRole('region', { name: 'ผลการแจ้งเตือนแอดมิน' }));
}
function client(attempts: AdminNotificationSummary[]): ApiClient {
  return { dataMode: 'server', async request<T>(path: string) {
    return (path === '/api/availability' ? [{ date: record.date, state: 'available' }] : [{ ...record, adminNotificationAttempts: attempts }]) as T;
  } };
}

describe('safe per-admin notification presentation', () => {
  it('separates admin acceptance from existing patient outcomes and explains its limits', () => {
    const admin = history([attempt()]);
    expect(admin.getByText('LINE รับคำขอแล้ว')).toBeVisible();
    expect(admin.getByText('แอดมิน 1')).toBeVisible();
    expect(admin.getByText(/ไม่ได้ยืนยันว่าอุปกรณ์ได้รับข้อความหรือผู้รับอ่านแล้ว/)).toBeVisible();
    expect(admin.queryByText('ส่งถึงแล้ว', { exact: true })).not.toBeInTheDocument();
    expect(admin.queryByText('อ่านแล้ว', { exact: true })).not.toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'ผลการแจ้งเตือนผู้รับบริการ' })).getByText('ผู้ให้บริการรับแล้ว · พยายามส่ง 1 ครั้ง')).toBeVisible();
  });

  it.each([
    ['queued', 'รอส่ง'], ['leased', 'กำลังดำเนินการ'], ['retry', 'รอลองใหม่'],
    ['paused_quota', 'พักเพราะโควตา'], ['suppressed', 'หยุดส่ง'], ['failed', 'ส่งไม่สำเร็จ'],
  ] as const)('renders the fixed label for %s', (state, label) => {
    const admin = history([attempt({ state, safeReason: state === 'failed' ? 'invalid_request' : null })]);
    expect(admin.getByText(label)).toBeVisible();
  });

  it('explains the accepted label without claiming that a queued request was accepted', () => {
    const admin = history([attempt({ state: 'queued', attemptCount: 0 })]);
    expect(admin.getByText('สถานะ “LINE รับคำขอแล้ว” ไม่ได้ยืนยันว่าอุปกรณ์ได้รับข้อความหรือผู้รับอ่านแล้ว')).toBeVisible();
    expect(admin.queryByText('LINE รับคำขอแล้ว', { exact: true })).not.toBeInTheDocument();
    expect(admin.getByText('รอส่ง')).toBeVisible();
  });

  it('shows partial acceptance without implying that every admin received a message', () => {
    const admin = history([attempt(), attempt({ recipientLabel: 'แอดมิน 2', state: 'paused_quota', attemptCount: 0, safeReason: 'quota_exhausted' })]);
    expect(admin.getByText(/LINE รับคำขอแล้วสำหรับผู้รับบางราย/)).toBeVisible();
    expect(admin.getByText('พักเพราะโควตา')).toBeVisible();
    expect(admin.getByText(/ตรวจโควตาใหม่ไม่ถี่กว่าทุก 15 นาที/)).toBeVisible();
    expect(admin.getByText(/หมดอายุภายใน 24 ชั่วโมงนับจากบันทึกคำขอ/)).toBeVisible();
    expect(admin.queryByText(/ส่งครบทุกคน|ส่งถึงทุกคน/)).not.toBeInTheDocument();
  });

  it('never describes full acceptance as confirmed delivery to everyone', () => {
    const admin = history([attempt(), attempt({ recipientLabel: 'แอดมิน 2' })]);
    expect(admin.getAllByText('LINE รับคำขอแล้ว')).toHaveLength(2);
    expect(admin.queryByText(/ผู้รับบางราย|ส่งครบทุกคน|ส่งถึงทุกคน/)).not.toBeInTheDocument();
  });

  it.each([
    ['mapping_unavailable', 'ยังไม่มีบัญชี LINE ที่เชื่อมและยืนยันแล้ว'],
    ['recipient_unavailable', 'บัญชีผู้รับยังไม่พร้อมรับข้อความ'],
    ['duplicate_recipient', 'บัญชี LINE นี้มีรายการแจ้งเตือนสำหรับคำขอนี้แล้ว'],
    ['policy_disabled', 'ยังไม่อนุญาตให้ส่งรายการนี้'],
    ['grant_revoked', 'สิทธิ์แอดมินเดิมถูกถอนแล้ว'],
    ['mapping_changed', 'บัญชี LINE ที่เชื่อมไว้เปลี่ยนไป'],
    ['quota_unknown', 'ยังยืนยันโควตาฟรีไม่ได้'],
    ['quota_exhausted', 'โควตาฟรีที่ยืนยันไว้ไม่เพียงพอ'],
    ['budget_expired', 'ข้อมูลยืนยันงบหมดอายุแล้ว'],
    ['invalid_request', 'คำขอไม่ผ่านการตรวจสอบเพื่อส่ง'],
    ['timeout', 'คำขอใช้เวลานานเกินกำหนด ผลเดิมยังไม่แน่ชัด'],
    ['transport', 'การเชื่อมต่อขัดข้อง ผลเดิมยังไม่แน่ชัด'],
    ['server_error', 'ผู้ให้บริการขัดข้องชั่วคราว'],
    ['rate_limited', 'ผู้ให้บริการจำกัดการส่ง จึงหยุดลองส่งอัตโนมัติ'],
    ['unauthorized', 'ผู้ให้บริการไม่อนุญาตคำขอนี้'],
    ['forbidden', 'ผู้ให้บริการปฏิเสธสิทธิ์การส่ง'],
  ])('maps %s to a fixed safe explanation', (safeReason, explanation) => {
    const admin = history([attempt({ state: 'suppressed', safeReason })]);
    expect(admin.getByText(explanation)).toBeVisible();
    expect(admin.queryByText(safeReason)).not.toBeInTheDocument();
  });

  it('describes expiry without promising a later send or cancelling the booking', () => {
    const admin = history([attempt({ state: 'suppressed', attemptCount: 0, safeReason: 'expired' })]);
    expect(admin.getByText('หมดอายุหลังบันทึกคำขอครบ 24 ชั่วโมง จะไม่ส่งย้อนหลัง')).toBeVisible();
    expect(admin.getByText(/สถานะแจ้งเตือนไม่เปลี่ยนผลการจอง/)).toBeVisible();
  });

  it.each(['grant_revoked', 'policy_disabled'])('does not claim to recall an in-flight request after %s', safeReason => {
    const admin = history([attempt({ state: 'suppressed', attemptCount: 1, safeReason })]);
    expect(admin.getByText('หยุดส่ง')).toBeVisible();
    expect(admin.getByText(/คำขอที่เริ่มไปแล้วอาจได้รับการตอบรับและเรียกคืนไม่ได้/)).toBeVisible();
    expect(admin.queryByText(/ไม่เคยส่ง|ยังไม่ได้ส่ง|ยกเลิกข้อความแล้ว/)).not.toBeInTheDocument();
  });

  it('keeps exhausted or expired uncertain attempts explicitly unknown', () => {
    const admin = history([attempt({ state: 'failed', attemptCount: 6, safeReason: 'unknown' })]);
    expect(admin.getByText('ผลการส่งยังไม่แน่ชัด')).toBeVisible();
    expect(admin.getByText(/ยุติการลองส่งอัตโนมัติแล้ว ไม่สามารถยืนยันผลคำขอเดิม/)).toBeVisible();
    expect(admin.queryByText('ส่งไม่สำเร็จ', { exact: true })).not.toBeInTheDocument();
    expect(admin.queryByText(/ส่งไม่ถึงแน่นอน/)).not.toBeInTheDocument();
  });

  it.each(['PRIVATE_CANARY', 'constructor', '__proto__', 'toString'])('does not render unknown or inherited state/reason values: %s', value => {
    const admin = history([{
      ...attempt(), state: value, safeReason: value, recipientLabel: `account-${value}`,
      attemptCount: `token-${value}`, provider: `line-${value}`, grantId: `grant-${value}`,
    } as unknown as AdminNotificationSummary]);
    expect(admin.getByText('ยังยืนยันสถานะไม่ได้')).toBeVisible();
    expect(admin.getByText('ไม่มีรายละเอียดเหตุผลที่แสดงได้')).toBeVisible();
    expect(admin.getByText('แอดมิน (ไม่ระบุลำดับ)')).toBeVisible();
    expect(admin.getByText('ไม่ทราบจำนวนครั้งที่พยายามส่ง')).toBeVisible();
    expect(document.body.textContent).not.toContain(value);
  });

  it.each(['แอดมิน 0', 'แอดมิน -1', 'แอดมิน 01', 'แอดมิน 1\nPRIVATE', 'แอดมิน 1\n', 'แอดมิน 9007199254740992'])('rejects malformed recipient labels: %j', recipientLabel => {
    const admin = history([attempt({ recipientLabel })]);
    expect(admin.getByText('แอดมิน (ไม่ระบุลำดับ)')).toBeVisible();
    expect(admin.queryByText(recipientLabel, { exact: true })).not.toBeInTheDocument();
  });

  it.each([-1, 1.5, Infinity, NaN, 7])('does not present an invalid attempt count: %s', attemptCount => {
    const admin = history([attempt({ attemptCount })]);
    expect(admin.getByText('ไม่ทราบจำนวนครั้งที่พยายามส่ง')).toBeVisible();
  });

  it('shows readiness without invented live state, counts or activation/grant controls', () => {
    render(<NotificationHistory items={[record]} />);
    const admin = within(screen.getByRole('region', { name: 'ผลการแจ้งเตือนแอดมิน' }));
    expect(admin.getByText(/ระบบแจ้งเตือนนี้ปิดโดยค่าเริ่มต้น/)).toBeVisible();
    expect(admin.getByText(/การเปิดส่งต้องได้รับอนุมัติแยกต่างหาก/)).toBeVisible();
    expect(admin.getByText('ยังไม่มีรายการแจ้งเตือนแอดมินในข้อมูลที่โหลด')).toBeVisible();
    expect(admin.queryByRole('button')).not.toBeInTheDocument();
    expect(admin.queryByText(/อยู่ในแผน|ยังไม่ตั้งค่า|โควตาคงเหลือ|เปิดส่งแล้ว|แอดมินทั้งหมด/)).not.toBeInTheDocument();
  });

  it('adds per-card admin status alongside patient notification history', async () => {
    render(<Dashboard api={client([attempt()])} now={now} section="queue" />);
    const card = within(await screen.findByRole('article'));
    const admin = within(card.getByRole('region', { name: 'แจ้งเตือนแอดมิน' }));
    expect(admin.getByText('LINE รับคำขอแล้ว')).toBeVisible();
    expect(card.getByText(/ผู้ให้บริการรับแล้ว/)).toBeVisible();
  });

  it.each([401, 403])('clears loaded private data when a dependency reload rejects with HTTP %s', async status => {
    const view = render(<Dashboard api={client([attempt()])} now={now} section="queue" />);
    expect(await screen.findByText('LINE รับคำขอแล้ว')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'พิจารณาคำขอ' }));
    expect(screen.getByRole('dialog')).toBeVisible();
    const denied: ApiClient = { dataMode: 'server', async request<T>(path: string) {
      if (path === '/api/admin/appointments') throw new ApiRequestError(status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN', status);
      return [{ date: record.date, state: 'available' }] as T;
    } };
    view.rerender(<Dashboard api={denied} now={now} section="queue" />);
    await waitFor(() => expect(screen.queryAllByText('Synthetic Patient')).toHaveLength(0));
    expect(screen.queryByText('LINE รับคำขอแล้ว')).not.toBeInTheDocument();
    expect(screen.queryByText('แอดมิน 1')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeVisible();
  });

  it('preserves the existing ordinary-error behavior on a dependency reload', async () => {
    const view = render(<Dashboard api={client([attempt()])} now={now} section="queue" />);
    expect(await screen.findByText('LINE รับคำขอแล้ว')).toBeVisible();
    const unavailable: ApiClient = { dataMode: 'server', async request() {
      throw new ApiRequestError('UNAVAILABLE', 503);
    } };
    view.rerender(<Dashboard api={unavailable} now={now} section="queue" />);
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.getByText('Synthetic Patient')).toBeVisible();
    expect(screen.getByText('LINE รับคำขอแล้ว')).toBeVisible();
  });

  it.each([401, 403])('clears the added private status when authority is lost with HTTP %s', async status => {
    const api = client([attempt()]); const read = api.request;
    api.request = async <T,>(path: string, init?: RequestInit): Promise<T> => {
      if (init?.method === 'POST') throw new ApiRequestError(status === 401 ? 'UNAUTHENTICATED' : 'FORBIDDEN', status);
      return read<T>(path, init);
    };
    render(<Dashboard api={api} now={now} section="queue" />);
    expect(await screen.findByText('LINE รับคำขอแล้ว')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'พิจารณาคำขอ' }));
    await userEvent.type(screen.getByLabelText('เหตุผล'), 'เหตุผลสมมติ');
    await userEvent.click(screen.getByRole('button', { name: 'อนุมัติคำขอ' }));
    await waitFor(() => expect(screen.queryByText('Synthetic Patient')).not.toBeInTheDocument());
    expect(screen.queryByText('LINE รับคำขอแล้ว')).not.toBeInTheDocument();
    expect(screen.queryByText('แอดมิน 1')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeVisible();
  });
});
