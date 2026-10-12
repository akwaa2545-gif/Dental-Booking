import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createDemoApi } from '../../src/demo/api';
import { createDemoClock } from '../../src/demo/clock';
import type { Appointment, AdminAppointment, Decision } from '../../src/shared/contracts';
import { Dashboard } from '../../src/web/admin/Dashboard';
import { DecisionDialog } from '../../src/web/admin/DecisionDialog';
import { DateControls } from '../../src/web/admin/DateControls';
import { AppointmentDetail } from '../../src/web/appointments/AppointmentDetail';
import { ApiRequestError, type ApiClient } from '../../src/web/api';
import { STATUS_LABELS } from '../../src/web/copy.th';

async function setup() {
  const clock = createDemoClock();
  const real = createDemoApi({ now: clock.now });
  const appointment = (await real.request<Appointment[]>('/api/appointments')).find(a => a.status === 'approved')!;
  return { clock, real, appointment };
}
async function openApproved(user: ReturnType<typeof userEvent.setup>, appointment: Appointment) {
  await user.selectOptions(await screen.findByLabelText('สถานะคำขอ'), 'approved');
  fireEvent.change(screen.getByLabelText('วันที่นัด'), { target: { value: appointment.date } });
  const card = (await screen.findAllByRole('article')).find(c => within(c).queryByText(appointment.reference))!;
  await user.click(within(card).getByRole('button', { name: 'จัดการนัดหมาย' }));
  await user.type(screen.getByLabelText('เหตุผล'), 'คลินิกหยุดฉุกเฉิน');
}

describe('clinic cancellation UI', () => {
  it('requires a deliberate reason and guards repeated clinic cancellation clicks', async () => {
    const { appointment } = await setup();
    const decisions: { decision: Decision; reason: string }[] = [];
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    let closed = false;
    render(<DecisionDialog dataMode="server" appointment={appointment} onConfirm={async (decision, reason) => { decisions.push({ decision, reason }); await pending; }} onClose={() => { closed = true; }} />);
    const reason = screen.getByLabelText('เหตุผล');
    const cancel = screen.getByRole('button', { name: 'ยกเลิกนัดโดยคลินิก' });
    expect(reason).toHaveValue(''); expect(cancel).toBeDisabled();
    fireEvent.change(reason, { target: { value: '   ' } }); expect(cancel).toBeDisabled();
    fireEvent.change(reason, { target: { value: 'คลินิกหยุดฉุกเฉิน' } });
    fireEvent.click(cancel); fireEvent.click(cancel);
    expect(decisions).toEqual([{ decision: 'cancel', reason: 'คลินิกหยุดฉุกเฉิน' }]);
    expect(reason).toBeDisabled(); expect(screen.getByRole('button', { name: 'ปิดหน้าต่าง' })).toBeDisabled();
    await act(async () => { finish(); await pending; });
    expect(closed).toBe(true);
  });

  it('separates clinic cancellation from completion timing and never offers cancellation for pending', async () => {
    const { appointment } = await setup();
    const view = render(<DecisionDialog dataMode="server" appointment={appointment} onConfirm={async () => {}} onClose={() => {}} />);
    expect(screen.getByText(/บันทึกรับบริการแล้วและไม่มาตามนัดทำได้ตั้งแต่ 09:30/)).toBeVisible();
    expect(screen.getByText(/คลินิกยกเลิกได้แม้เลยกำหนดยกเลิกของผู้รับบริการ/)).toBeVisible();
    expect(screen.getByText(/ไม่มีการย้ายนัดอัตโนมัติ/)).toBeVisible();
    view.rerender(<DecisionDialog dataMode="server" appointment={{ ...appointment, status: 'pending' }} onConfirm={async () => {}} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: 'ยกเลิกนัดโดยคลินิก' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ไม่อนุมัติคำขอ' })).toBeVisible();
  });

  it('cancels after patient cutoff, refreshes the admin queue, and offers patient-controlled rebooking', async () => {
    const { real, clock, appointment } = await setup();
    clock.set(`${appointment.date}T00:00:00+07:00`); real.setRole('admin');
    const writes: unknown[] = [];
    const api: ApiClient = { dataMode: 'server', async request<T>(path: string, init?: RequestInit): Promise<T> { if (init?.method === 'POST') writes.push(JSON.parse(String(init.body))); return real.request<T>(path, init); } };
    const user = userEvent.setup(); const view = render(<Dashboard api={api} now={clock.now} />);
    await user.click(await screen.findByRole('button', { name: 'ดูทุกวันและสถานะ' }));
    await openApproved(user, appointment);
    await user.click(screen.getByRole('button', { name: 'ยกเลิกนัดโดยคลินิก' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(writes).toEqual([{ version: appointment.version, decision: 'cancel', reason: 'คลินิกหยุดฉุกเฉิน' }]);
    expect(screen.queryByText(appointment.reference)).not.toBeInTheDocument();
    view.unmount(); real.setRole('patient');
    let rebooked = false;
    render(<AppointmentDetail api={real} id={appointment.id} now={clock.now} onRebook={() => { rebooked = true; }} />);
    expect(await screen.findByText(STATUS_LABELS.cancelled)).toBeVisible();
    expect(screen.getByText(/ไม่มีการย้ายนัดอัตโนมัติ/)).toBeVisible();
    expect(screen.getByText(/วันที่ใหม่จะยังไม่ถูกจองจนส่งคำขอสำเร็จ/)).toBeVisible();
    expect(rebooked).toBe(false);
    await user.click(screen.getByRole('button', { name: 'เริ่มคำขอใหม่' }));
    expect(rebooked).toBe(true);
  });

  it('reconciles a lost clinic-cancel response without another write', async () => {
    const { real, clock, appointment } = await setup(); real.setRole('admin'); let writes = 0;
    const api: ApiClient = { dataMode: 'server', async request<T>(path: string, init?: RequestInit): Promise<T> { const result = await real.request<T>(path, init); if (init?.method === 'POST') { writes++; throw new ApiRequestError('UNAVAILABLE', 503); } return result; } };
    const user = userEvent.setup(); render(<Dashboard api={api} now={clock.now} />);
    await openApproved(user, appointment); await user.click(screen.getByRole('button', { name: 'ยกเลิกนัดโดยคลินิก' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument(); expect(writes).toBe(1);
    expect((await real.request<Appointment>(`/api/appointments/${appointment.id}`)).status).toBe('cancelled');
  });

  it('refreshes a competing completed state and removes the stale cancellation action', async () => {
    const { real, clock, appointment } = await setup(); real.setRole('admin'); let writes = 0;
    const api: ApiClient = { dataMode: 'server', async request<T>(path: string, init?: RequestInit): Promise<T> { if (init?.method === 'POST') { writes++; clock.set(`${appointment.date}T09:30:00+07:00`); await real.request(path, { ...init, body: JSON.stringify({ version: appointment.version, decision: 'complete', reason: 'รับบริการแล้ว' }) }); throw new ApiRequestError('VERSION_CONFLICT', 409); } return real.request<T>(path, init); } };
    const user = userEvent.setup(); render(<Dashboard api={api} now={clock.now} />);
    await openApproved(user, appointment); await user.click(screen.getByRole('button', { name: 'ยกเลิกนัดโดยคลินิก' }));
    expect(await within(screen.getByRole('dialog')).findByText(STATUS_LABELS.completed)).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('สถานะเปลี่ยนแล้ว');
    expect(screen.queryByRole('button', { name: 'ยกเลิกนัดโดยคลินิก' })).not.toBeInTheDocument(); expect(writes).toBe(1);
  });

  it('blocks stale actions after a failed write and failed refresh until explicit recovery', async () => {
    const { real, clock, appointment } = await setup(); real.setRole('admin'); let writes = 0; let failReads = false;
    const api: ApiClient = { dataMode: 'server', async request<T>(path: string, init?: RequestInit): Promise<T> { if (init?.method === 'POST') { writes++; failReads = true; throw new ApiRequestError('UNAVAILABLE', 503); } if (failReads) throw new ApiRequestError('UNAVAILABLE', 503); return real.request<T>(path, init); } };
    const user = userEvent.setup(); render(<Dashboard api={api} now={clock.now} />);
    await openApproved(user, appointment); await user.click(screen.getByRole('button', { name: 'ยกเลิกนัดโดยคลินิก' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'จัดการนัดหมาย' })).toBeDisabled();
    expect(screen.getByText(/ยังยืนยันสถานะล่าสุดไม่ได้/)).toBeVisible();
    failReads = false; await user.click(screen.getByRole('button', { name: 'ตรวจสอบสถานะล่าสุด' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'จัดการนัดหมาย' })).not.toBeDisabled());
    expect(writes).toBe(1);
    expect((await real.request<Appointment>(`/api/appointments/${appointment.id}`)).status).toBe('approved');
  });

  it('explains individual clinic cancellation before closing a date', async () => {
    const { real, appointment } = await setup();
    render(<DateControls api={real} date={appointment.date} unresolved={[appointment]} onChanged={async () => {}} />);
    expect(screen.getByText(/ใช้ปุ่มจัดการนัดหมายเพื่อยกเลิกโดยคลินิกพร้อมเหตุผล/)).toBeVisible();
    expect(screen.queryByText(/ยังไม่รองรับ|ยังไม่ได้กำหนด/)).not.toBeInTheDocument();
  });

  it('labels cancellation delivery status without exposing the reason', async () => {
    const { clock, appointment } = await setup();
    const record = { ...appointment, status: 'cancelled', notificationAttempts: [{ kind: 'cancellation', state: 'queued', attemptCount: 0 }] } as AdminAppointment;
    const api: ApiClient = { dataMode: 'server', async request<T>(path: string): Promise<T> { return (path === '/api/availability' ? [{ date: appointment.date, state: 'available' }] : [record]) as T; } };
    render(<Dashboard api={api} now={clock.now} />);
    await userEvent.click(await screen.findByRole('button', { name: 'ดูทุกวันและสถานะ' }));
    expect(await screen.findByText(/แจ้งคลินิกยกเลิก · รอส่ง · พยายามส่ง 0 ครั้ง/)).toBeVisible();
  });
});
