import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { BookingFlow } from '../../src/web/booking/BookingFlow';
import { Dashboard } from '../../src/web/admin/Dashboard';
import { ApiRequestError, type ApiClient } from '../../src/web/api';
import { createDemoApi } from '../../src/demo/api';
import { createDemoClock } from '../../src/demo/clock';
import { FIXTURE_IDS } from '../../src/demo/fixtures';
import type { Appointment } from '../../src/shared/contracts';

async function reachReview(user: ReturnType<typeof userEvent.setup>, date = '2026-10-08') {
  await screen.findByDisplayValue('คุณยิ้ม ทดลอง');
  await user.click(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }));
  await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
  await user.click(await screen.findByRole('button', { name: new RegExp(`^${date} ว่าง`) }));
  await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
}

const bookingBody = (patientId: string, ageConfirmed: number) => JSON.stringify({ patientId, patientVersion: 1, service: 'filling', date: '2026-10-08', ageConfirmed, authorizationAcknowledged: true });

describe('recoverable UI interruptions with the real memory adapter', () => {
  it('checks the original key after an uncertain committed submission and never resends', async () => {
    const clock = createDemoClock(); const real = createDemoApi({ now: clock.now });
    let writes = 0; let submissionKey: string | null = null; let checkedKey = '';
    const api: ApiClient = { async request<T>(path: string, init?: RequestInit): Promise<T> {
      if (path === '/api/appointments' && init?.method === 'POST') {
        writes++; submissionKey = new Headers(init.headers).get('Idempotency-Key');
        await real.request(path, init); throw new ApiRequestError('UNAVAILABLE', 503);
      }
      if (path.startsWith('/api/submissions/')) checkedKey = path.split('/').at(-1)!;
      return real.request<T>(path, init);
    } };
    let result: Appointment | undefined;
    const user = userEvent.setup();
    render(<BookingFlow api={api} initialService="oral_check" onSubmitted={a => { result = a; }} />);
    await reachReview(user); await user.click(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ตรวจสอบคำขอเดิม');
    expect(result).toBeUndefined(); expect(writes).toBe(1);
    await user.click(screen.getByRole('button', { name: 'ตรวจสอบคำขอเดิม' }));
    expect(result?.status).toBe('pending'); expect(checkedKey).toBe(submissionKey); expect(writes).toBe(1);
    expect((await real.request<Appointment[]>('/api/appointments')).filter(a => a.patientId === FIXTURE_IDS.self && a.date === '2026-10-08')).toHaveLength(1);
  });

  it('requires explicit continuation after an uncertain write that did not commit', async () => {
    const clock = createDemoClock(); const real = createDemoApi({ now: clock.now });
    let writes = 0; const keys: (string | null)[] = [];
    const api: ApiClient = { async request<T>(path: string, init?: RequestInit): Promise<T> {
      if (path === '/api/appointments' && init?.method === 'POST') {
        keys.push(new Headers(init.headers).get('Idempotency-Key'));
        if (++writes === 1) throw new ApiRequestError('UNAUTHENTICATED', 401);
      }
      return real.request<T>(path, init);
    } };
    let result: Appointment | undefined; const user = userEvent.setup();
    render(<BookingFlow api={api} initialService="filling" onSubmitted={a => { result = a; }} />);
    await reachReview(user); await user.click(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' }));
    await user.click(await screen.findByRole('button', { name: 'ตรวจสอบคำขอเดิม' }));
    expect(screen.getByRole('alert')).toHaveTextContent('ไม่มีการส่งซ้ำอัตโนมัติ');
    expect(writes).toBe(1); expect(result).toBeUndefined();
    await user.click(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' }));
    expect(result?.status).toBe('pending'); expect(writes).toBe(2); expect(keys[1]).toBe(keys[0]);
  });

  it('refreshes a newly full date while preserving service and family fields', async () => {
    const clock = createDemoClock(); const api = createDemoApi({ now: clock.now }); const user = userEvent.setup();
    render(<BookingFlow api={api} initialService="scaling" onSubmitted={() => {}} />);
    await reachReview(user);
    for (const [id, age] of [[FIXTURE_IDS.parent, 65], [FIXTURE_IDS.child, 12]] as const) {
      await api.request('/api/appointments', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: bookingBody(id, age) });
    }
    await user.click(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ข้อมูลอื่นยังอยู่');
    expect(screen.getByRole('button', { name: /^2026-10-08 เต็ม/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /^2026-10-14 ว่าง/ }));
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    expect(screen.getByText('คุณยิ้ม ทดลอง')).toBeVisible(); expect(screen.getByText('ขูดหินปูน')).toBeVisible();
  });

  it('contains a failed FULL calendar refresh and lets the user retry without losing inputs', async () => {
    const clock = createDemoClock(); const real = createDemoApi({ now: clock.now }); let reads = 0;
    const api: ApiClient = { async request<T>(path: string, init?: RequestInit): Promise<T> {
      if (path === '/api/availability' && ++reads === 2) throw new ApiRequestError('UNAVAILABLE', 503);
      return real.request<T>(path, init);
    } };
    const user = userEvent.setup(); render(<BookingFlow api={api} initialService="filling" onSubmitted={() => {}} />);
    await reachReview(user);
    for (const [id, age] of [[FIXTURE_IDS.parent, 65], [FIXTURE_IDS.child, 12]] as const) await real.request('/api/appointments', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: bookingBody(id, age) });
    await user.click(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' }));
    await user.click(await screen.findByRole('button', { name: 'โหลดวันนัดหมายใหม่' }));
    expect(await screen.findByRole('button', { name: /^2026-10-08 เต็ม/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /^2026-10-14 ว่าง/ })); await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    expect(screen.getByText('คุณยิ้ม ทดลอง')).toBeVisible(); expect(screen.getByText('อุดฟัน')).toBeVisible();
  });

  it('refreshes the selected decision after a competing version change', async () => {
    const clock = createDemoClock(); const api = createDemoApi({ now: clock.now }); api.setRole('admin');
    const user = userEvent.setup(); render(<Dashboard api={api} now={clock.now} />);
    await user.click(screen.getByRole('button', { name: 'ดูทุกวันและสถานะ' }));
    const card = (await screen.findAllByRole('article')).find(c => within(c).queryByText('คุณอุ่นใจ สมมติ') && within(c).queryByRole('button', { name: 'พิจารณาคำขอ' }))!;
    await user.click(within(card).getByRole('button', { name: 'พิจารณาคำขอ' }));
    const pending = (await api.request<Appointment[]>('/api/admin/appointments')).find(a => a.patientId === FIXTURE_IDS.parent && a.status === 'pending')!;
    await api.request(`/api/admin/appointments/${pending.id}/decision`, { method: 'POST', body: JSON.stringify({ version: pending.version, decision: 'approve', reason: 'สาธิตผู้ดูแลอีกหน้าหนึ่ง' }) });
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'ไม่อนุมัติคำขอ' }));
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('สถานะเปลี่ยนแล้ว');
    expect(within(screen.getByRole('dialog')).getByText('✓ อนุมัติแล้ว')).toBeVisible();
    expect(within(screen.getByRole('dialog')).queryByRole('button', { name: 'อนุมัติคำขอ' })).not.toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'ปิดหน้าต่าง' }));
    expect(within(card).getByRole('button', { name: 'จัดการนัดหมาย' })).toHaveFocus();
  });

  it('dismisses decision on browser navigation without committing it', async () => {
    const clock = createDemoClock(); const api = createDemoApi({ now: clock.now }); api.setRole('admin');
    const user = userEvent.setup(); render(<Dashboard api={api} now={clock.now} />);
    await user.click(screen.getByRole('button', { name: 'ดูทุกวันและสถานะ' }));
    const card = (await screen.findAllByRole('article')).find(c => within(c).queryByText('คุณอุ่นใจ สมมติ') && within(c).queryByRole('button', { name: 'พิจารณาคำขอ' }))!;
    const opener = within(card).getByRole('button', { name: 'พิจารณาคำขอ' }); await user.click(opener);
    await act(async () => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(opener).toHaveFocus();
    expect((await api.request<Appointment[]>('/api/admin/appointments')).find(a => a.patientId === FIXTURE_IDS.parent && a.date === '2026-10-09')?.status).toBe('pending');
  });
  it('retains the first calendar error across service and patient navigation and retries explicitly', async () => {
    const clock = createDemoClock(); const real = createDemoApi({ now: clock.now }); let reads = 0;
    const api: ApiClient = { async request<T>(path: string, init?: RequestInit): Promise<T> {
      if (path === '/api/availability' && ++reads === 1) throw new ApiRequestError('UNAVAILABLE', 503);
      return real.request<T>(path, init);
    } };
    const user = userEvent.setup(); render(<BookingFlow api={api} onSubmitted={() => {}} />);
    await act(async () => {});
    await user.click(screen.getByRole('button', { name: /ขูดหินปูน/ }));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'ผู้รับบริการสมมติ' }), FIXTURE_IDS.parent);
    await user.click(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }));
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    await user.click(await screen.findByRole('button', { name: 'โหลดวันนัดหมายใหม่' }));
    await user.click(await screen.findByRole('button', { name: /^2026-10-14 ว่าง/ }));
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    expect(screen.getByText('คุณอุ่นใจ สมมติ')).toBeVisible();
    expect(screen.getByText('ขูดหินปูน')).toBeVisible(); expect(reads).toBe(2);
  });

});
