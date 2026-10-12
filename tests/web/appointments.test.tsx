import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDemoApi } from '../../src/demo/api';
import { createDemoClock } from '../../src/demo/clock';
import { FIXTURE_IDS } from '../../src/demo/fixtures';
import type { Appointment } from '../../src/shared/contracts';
import { ApiRequestError, type ApiClient } from '../../src/web/api';
import { AppointmentDetail } from '../../src/web/appointments/AppointmentDetail';
import { MyAppointments } from '../../src/web/appointments/MyAppointments';
import { STATUS_LABELS } from '../../src/web/copy.th';

// Real synthetic state transitions behind the UI. PostgreSQL proof is a separate integration check.
function setup() { const clock = createDemoClock(); return { clock, api: createDemoApi({ now: clock.now }) }; }
async function active(api: ApiClient, status: 'pending' | 'approved' = 'approved') {
  return (await api.request<Appointment[]>('/api/appointments')).find(a => a.status === status)!;
}
afterEach(() => { vi.useRealTimers(); window.history.replaceState(null, '', '/'); });

describe('appointment management and cancellation recovery', () => {
  it('groups all managed family patients into upcoming and past with Thai status text and icons', async () => {
    const { api, clock } = setup(); render(<MyAppointments api={api} now={clock.now} />);
    await screen.findAllByText('คุณใจดี สมมติ');
    const upcoming = screen.getByRole('heading', { name: 'นัดหมายที่กำลังจะมาถึง' }).closest('section')!;
    const past = screen.getByRole('heading', { name: 'ประวัติและคำขอที่สิ้นสุด' }).closest('section')!;
    expect(within(upcoming).getByText('คุณใจดี สมมติ')).toBeVisible();
    expect(within(upcoming).getByText('คุณอุ่นใจ สมมติ')).toBeVisible();
    for (const status of ['pending', 'approved'] as const) expect(within(upcoming).getByText(STATUS_LABELS[status])).toBeVisible();
    for (const status of ['rejected', 'cancelled', 'completed', 'no_show'] as const) expect(within(past).getByText(STATUS_LABELS[status])).toBeVisible();
    expect(screen.queryByText('บัญชีอื่น สมมติ')).not.toBeInTheDocument();
  });
  it('shows loading instead of false empty groups and allows explicit list retry', async () => {
    const { api: real, clock } = setup(); let reads = 0;
    const api: ApiClient = { async request<T>(path: string): Promise<T> { if (++reads === 1) throw new ApiRequestError('UNAVAILABLE'); return real.request<T>(path); } };
    render(<MyAppointments api={api} now={clock.now} />);
    expect(screen.getByRole('status')).toHaveTextContent('กำลังโหลด');
    expect(screen.queryByText('ยังไม่มีนัดหมายในกลุ่มนี้')).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: 'โหลดนัดหมายใหม่' }));
    expect((await screen.findAllByText('คุณใจดี สมมติ'))[0]).toBeVisible(); expect(reads).toBe(2);
  });
  it.each(['pending', 'approved'] as const)('cancels %s once with its current version despite repeated clicks', async status => {
    const { api: real, clock } = setup(); const item = await active(real, status); let writes = 0;
    let release!: () => void; const pending = new Promise<void>(r => { release = r; });
    const api: ApiClient = { async request<T>(path: string, init?: RequestInit): Promise<T> { if (init?.method === 'POST') { writes++; expect(JSON.parse(String(init.body))).toEqual({ version: item.version }); await pending; } return real.request<T>(path, init); } };
    render(<AppointmentDetail api={api} id={item.id} now={clock.now} />);
    await userEvent.click(await screen.findByRole('button', { name: 'ยกเลิกนัดหมาย' }));
    const confirm = screen.getByRole('button', { name: 'ยืนยันยกเลิก' }); fireEvent.click(confirm); fireEvent.click(confirm);
    expect(writes).toBe(1); expect(screen.getByRole('button', { name: 'ปิดหน้าต่าง' })).toBeDisabled();
    await act(async () => { release(); await pending; });
    expect(await screen.findByText(STATUS_LABELS.cancelled)).toBeVisible();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect((await real.request<Appointment>(`/api/appointments/${item.id}`)).version).toBe(item.version + 1);
  });
  it('recovers a committed cancellation after a lost response without another write or stale error', async () => {
    const { api: real, clock } = setup(); const item = await active(real); let writes = 0;
    const api: ApiClient = { async request<T>(path: string, init?: RequestInit): Promise<T> { const result = await real.request<T>(path, init); if (init?.method === 'POST') { writes++; throw new TypeError('lost response'); } return result; } };
    render(<AppointmentDetail api={api} id={item.id} now={clock.now} onRebook={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: 'ยกเลิกนัดหมาย' }));
    await userEvent.click(screen.getByRole('button', { name: 'ยืนยันยกเลิก' }));
    expect(await screen.findByText(STATUS_LABELS.cancelled)).toBeVisible(); expect(writes).toBe(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/วันที่ใหม่จะยังไม่ถูกจองจนส่งคำขอสำเร็จ/)).toBeVisible();
  });
  it.each(['VERSION_CONFLICT', 'CUTOFF_PASSED'] as const)('re-fetches after %s and requires a new decision against latest state', async code => {
    const { api: real, clock } = setup(); const item = await active(real); let reads = 0;
    const api: ApiClient = { async request<T>(path: string, init?: RequestInit): Promise<T> {
      if (init?.method === 'POST') {
        if (code === 'CUTOFF_PASSED') clock.set(`${item.date}T00:00:00+07:00`);
        else await real.request(path, init);
        throw new ApiRequestError(code);
      }
      reads++; return real.request<T>(path, init);
    } };
    render(<AppointmentDetail api={api} id={item.id} now={clock.now} />);
    await userEvent.click(await screen.findByRole('button', { name: 'ยกเลิกนัดหมาย' })); await userEvent.click(screen.getByRole('button', { name: 'ยืนยันยกเลิก' }));
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.queryByRole('button', { name: 'ยืนยันยกเลิก' })).not.toBeInTheDocument();
    if (code === 'CUTOFF_PASSED') expect(screen.getByText(/วันนัดหรือเลยกำหนดยกเลิกแล้ว/)).toBeVisible();
    else expect(screen.getByText(STATUS_LABELS.cancelled)).toBeVisible();
  });
  it('blocks another cancel after both the write and reconciliation fail until a successful explicit re-fetch', async () => {
    const { api: real, clock } = setup(); const item = await active(real); let reads = 0; let writes = 0;
    const api: ApiClient = { async request<T>(path: string, init?: RequestInit): Promise<T> {
      if (init?.method === 'POST') { writes++; await real.request(path, init); throw new ApiRequestError('UNAVAILABLE'); }
      if (++reads === 2) throw new ApiRequestError('UNAVAILABLE'); return real.request<T>(path, init);
    } };
    render(<AppointmentDetail api={api} id={item.id} now={clock.now} />);
    await userEvent.click(await screen.findByRole('button', { name: 'ยกเลิกนัดหมาย' })); await userEvent.click(screen.getByRole('button', { name: 'ยืนยันยกเลิก' }));
    expect(screen.queryByRole('button', { name: 'ยืนยันยกเลิก' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ยกเลิกนัดหมาย' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'ตรวจสอบสถานะล่าสุด' }));
    expect(await screen.findByText(STATUS_LABELS.cancelled)).toBeVisible(); expect(writes).toBe(1);
  });
  it('shows contact guidance at Bangkok midnight without waiting for another request', async () => {
    const { api, clock } = setup(); const item = await active(api); clock.set(`${item.date}T00:00:00+07:00`);
    render(<AppointmentDetail api={api} id={item.id} now={clock.now} />);
    expect(await screen.findByText(/วันนัดหรือเลยกำหนดยกเลิกแล้ว/)).toBeVisible(); expect(screen.queryByRole('button', { name: 'ยกเลิกนัดหมาย' })).not.toBeInTheDocument();
  });
  it.each(['close', 'escape', 'back'] as const)('%s dismisses cancellation without changing data and restores trigger focus', async how => {
    const { api, clock } = setup(); const item = await active(api); const route = `/appointments/${item.id}`;
    window.history.replaceState(null, '', '/appointments'); window.history.pushState(null, '', route);
    render(<AppointmentDetail api={api} id={item.id} now={clock.now} />);
    const trigger = await screen.findByRole('button', { name: 'ยกเลิกนัดหมาย' }); await userEvent.click(trigger);
    const close = screen.getByRole('button', { name: 'ปิดหน้าต่าง' }); expect(close).toHaveFocus();
    if (how === 'close') await userEvent.click(close);
    else if (how === 'escape') await userEvent.keyboard('{Escape}');
    else await act(async () => { window.history.back(); await new Promise(r => setTimeout(r, 30)); });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus(); expect(window.location.pathname).toBe(route);
    expect((await api.request<Appointment>(`/api/appointments/${item.id}`)).status).toBe('approved');
  });
  it('uses the same not-found screen for an unowned and nonexistent opaque ID', async () => {
    const { api, clock } = setup(); const first = render(<AppointmentDetail api={api} id={FIXTURE_IDS.foreignAppointment} now={clock.now} />);
    await screen.findByRole('heading', { name: 'ไม่พบนัดหมาย' }); const text = first.container.textContent; first.unmount();
    render(<AppointmentDetail api={api} id={crypto.randomUUID()} now={clock.now} />);
    await screen.findByRole('heading', { name: 'ไม่พบนัดหมาย' }); expect(document.querySelector('section')?.textContent).toBe(text);
  });
  it('never leaves the prior patient visible while another deep link is loading', async () => {
    const { api: real, clock } = setup(); const item = await active(real);
    const api: ApiClient = { request<T>(path: string): Promise<T> { return path.endsWith(FIXTURE_IDS.foreignAppointment) ? new Promise(() => {}) : real.request<T>(path); } };
    const view = render(<AppointmentDetail api={api} id={item.id} now={clock.now} />);
    await screen.findByText(item.patient.fullName);
    view.rerender(<AppointmentDetail api={api} id={FIXTURE_IDS.foreignAppointment} now={clock.now} />);
    expect(screen.queryByText(item.patient.fullName)).not.toBeInTheDocument(); expect(screen.getByRole('status')).toHaveTextContent('กำลังโหลด');
  });
});

it('keeps web status visible and offers only an operator-configured verified OA add/unblock link', async () => {
  const { api, clock } = setup(); const item = await active(api);
  render(<AppointmentDetail api={api} id={item.id} now={clock.now} verifiedOaUrl="https://line.me/R/ti/p/%40synthetic-clinic" />);
  expect(await screen.findByText(STATUS_LABELS.approved)).toBeVisible();
  expect(screen.getByText(/แม้ไม่ได้รับข้อความ/)).toBeVisible(); expect(screen.getByText(/ปลดบล็อก/)).toBeVisible();
  const link = screen.getByRole('link', { name: 'เปิด LINE OA ของคลินิก' });
  expect(link).toHaveAttribute('href', 'https://line.me/R/ti/p/%40synthetic-clinic'); expect(link).toHaveAttribute('rel', 'noopener noreferrer');
});
it.each([undefined, 'javascript:alert(1)', 'https://line.me.evil.example/R/ti/p/@clinic', 'https://line.me/R/ti/p/@clinic?patient=private', 'https://user:secret@lin.ee/clinic', 'https://lin.ee/clinic#private', 'https://line.me/other'])('never renders an unconfigured or unsafe OA link: %s', async verifiedOaUrl => {
  const { api, clock } = setup(); const item = await active(api);
  render(<AppointmentDetail api={api} id={item.id} now={clock.now} verifiedOaUrl={verifiedOaUrl} />);
  await screen.findByText(STATUS_LABELS.approved); expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(screen.getByText(/ยังไม่ตั้งค่าลิงก์ LINE OA ที่ตรวจสอบแล้ว/)).toBeVisible();
});

it('updates cutoff guidance while the detail remains open across Bangkok midnight', async () => {
  const { api } = setup(); const item = await active(api);
  vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(Date.parse(item.cancelBefore) - 1_000);
  render(<AppointmentDetail api={api} id={item.id} now={() => new Date()} />);
  await screen.findByRole('button', { name: 'ยกเลิกนัดหมาย' });
  await act(async () => { await vi.advanceTimersByTimeAsync(1_001); });
  expect(screen.queryByRole('button', { name: 'ยกเลิกนัดหมาย' })).not.toBeInTheDocument();
  expect(screen.getByText(/วันนัดหรือเลยกำหนดยกเลิกแล้ว/)).toBeVisible();
});

it('honors a server cutoff even when the browser clock is behind', async () => {
  const { api: real, clock } = setup(); const item = await active(real); let reads = 0; let writes = 0;
  const api: ApiClient = { async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (init?.method === 'POST') { writes++; throw new ApiRequestError('CUTOFF_PASSED'); }
    reads++; return real.request<T>(path, init);
  } };
  render(<AppointmentDetail api={api} id={item.id} now={clock.now} />);
  await userEvent.click(await screen.findByRole('button', { name: 'ยกเลิกนัดหมาย' }));
  await userEvent.click(screen.getByRole('button', { name: 'ยืนยันยกเลิก' }));
  expect(reads).toBe(2); expect(writes).toBe(1);
  expect(screen.queryByRole('button', { name: 'ยกเลิกนัดหมาย' })).not.toBeInTheDocument();
  expect(screen.getByText(/วันนัดหรือเลยกำหนดยกเลิกแล้ว/)).toBeVisible();
});

it('closes the native modal before restoring focus, including StrictMode effect replay', async () => {
  const { api, clock } = setup(); const item = await active(api);
  const prototype = HTMLDialogElement.prototype;
  const oldShow = Object.getOwnPropertyDescriptor(prototype, 'showModal');
  const oldClose = Object.getOwnPropertyDescriptor(prototype, 'close');
  Object.defineProperty(prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  Object.defineProperty(prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.removeAttribute('open'); } });
  const originalFocus = HTMLElement.prototype.focus;
  // Native modal inertness prevents focusing the trigger until dialog.close().
  const focus = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
    const modal = document.querySelector('dialog[open]');
    if (!modal || modal.contains(this)) originalFocus.call(this, options);
  });
  try {
    render(<StrictMode><AppointmentDetail api={api} id={item.id} now={clock.now} /></StrictMode>);
    const trigger = await screen.findByRole('button', { name: 'ยกเลิกนัดหมาย' });
    await userEvent.click(trigger); await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  } finally {
    focus.mockRestore();
    if (oldShow) Object.defineProperty(prototype, 'showModal', oldShow); else Reflect.deleteProperty(prototype, 'showModal');
    if (oldClose) Object.defineProperty(prototype, 'close', oldClose); else Reflect.deleteProperty(prototype, 'close');
  }
});
