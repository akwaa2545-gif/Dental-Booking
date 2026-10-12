import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { createDemoApi } from '../../src/demo/api';
import { createDemoClock } from '../../src/demo/clock';
import type { Appointment, Session } from '../../src/shared/contracts';
import { ApiRequestError } from '../../src/web/api';
import { App } from '../../src/web/production';

function runtime() {
  const clock = createDemoClock(); const real = createDemoApi({ now: clock.now });
  const session: Session = { accountId: '10000000-0000-4000-8000-000000000001', csrfToken: 'synthetic-csrf', expiresAt: new Date(clock.now().getTime() + 3_600_000).toISOString(), isAdmin: false };
  let mode: 'normal' | 'lose-response' | 'pending' = 'normal'; let release!: () => void;
  const writes: { key: string | null; body: BodyInit | null | undefined }[] = [];
  const sdk = { init: async () => {}, isLoggedIn: () => true, isInClient: () => false, login: () => {}, getIDToken: () => 'synthetic-token', logout: () => {}, closeWindow: () => {} };
  const fetcher: typeof fetch = async (input, init) => {
    const path = String(input);
    if (path === '/api/session' || path === '/api/auth/liff') return Response.json(session);
    if (path === '/api/logout') return new Response(null, { status: 204 });
    try {
      if (path === '/api/appointments' && init?.method === 'POST') {
        writes.push({ key: new Headers(init.headers).get('Idempotency-Key'), body: init.body });
        if (mode === 'pending') await new Promise<void>(r => { release = r; });
        const result = await real.request(path, init);
        if (mode === 'lose-response') throw new TypeError('lost synthetic response');
        return Response.json(result);
      }
      return Response.json(await real.request(path, init));
    } catch (error) { if (error instanceof ApiRequestError) return Response.json({ error: { code: error.code } }, { status: error.status }); throw error; }
  };
  return { real, writes, setMode: (next: typeof mode) => { mode = next; }, release: () => release(), props: { config: { liffId: '1234567890-Example', staging: true, origin: 'https://staging.example' }, fetcher, loadSdk: async () => sdk, now: clock.now } };
}
async function review(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: /ตรวจสุขภาพช่องปาก/ }));
  await screen.findByDisplayValue('คุณยิ้ม ทดลอง');
  await user.click(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ })); await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
  await user.click(await screen.findByRole('button', { name: /^2026-10-08 ว่าง/ })); await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
}
const nav = (name: string) => within(screen.getByRole('navigation', { name: 'เมนูหลัก' })).getByRole('button', { name });
afterEach(() => { window.history.replaceState(null, '', '/'); });

it('retains a lost-response key across real Back/Forward and recovers exactly one committed booking', async () => {
  window.history.replaceState(null, '', '/booking'); const r = runtime(); r.setMode('lose-response'); const user = userEvent.setup();
  render(<App {...r.props} />); await review(user); await user.click(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' }));
  await screen.findByRole('button', { name: 'ตรวจสอบคำขอเดิม' }); await user.click(nav('ติดต่อ'));
  await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(screen.getByRole('button', { name: 'ตรวจสอบคำขอเดิม' })).toBeVisible();
  await act(async () => { window.history.forward(); await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(screen.getByRole('heading', { name: 'ติดต่อเรา' })).toBeVisible();
  await user.click(nav('นัดหมาย')); await user.click(screen.getByRole('button', { name: 'ตรวจสอบคำขอเดิม' }));
  await screen.findByRole('heading', { name: 'ส่งคำขอแล้ว รอการอนุมัติ' });
  const recovered = await r.real.request<Appointment>(`/api/submissions/${r.writes[0].key}`);
  expect(window.location.pathname).toBe(`/appointments/${recovered.id}`); expect(r.writes).toHaveLength(1);
  expect((await r.real.request<Appointment[]>('/api/appointments')).filter(a => a.id === recovered.id)).toHaveLength(1);
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
});

it('does not let a delayed booking response take over newer navigation', async () => {
  window.history.replaceState(null, '', '/booking'); const r = runtime(); r.setMode('pending'); const user = userEvent.setup();
  render(<App {...r.props} />); await review(user); await user.click(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' }));
  await waitFor(() => expect(r.writes).toHaveLength(1)); await user.click(nav('ติดต่อ'));
  await act(async () => r.release());
  expect(screen.getByRole('heading', { name: 'ติดต่อเรา' })).toBeVisible(); expect(window.location.pathname).toBe('/contact');
  await user.click(nav('นัดของฉัน')); expect((await screen.findAllByText('คุณยิ้ม ทดลอง')).length).toBeGreaterThan(0); expect(r.writes).toHaveLength(1);
});

it('keeps unsaved family input only in memory across navigation and removes it immediately on logout', async () => {
  window.history.replaceState(null, '', '/booking'); const r = runtime(); const user = userEvent.setup(); render(<App {...r.props} />);
  await user.click(await screen.findByRole('button', { name: /ตรวจสุขภาพช่องปาก/ })); await screen.findByDisplayValue('คุณยิ้ม ทดลอง');
  await user.clear(screen.getByLabelText('ชื่อ–นามสกุล *')); await user.type(screen.getByLabelText('ชื่อ–นามสกุล *'), 'UNSAVED SYNTHETIC FAMILY');
  await user.click(nav('ติดต่อ')); await user.click(nav('นัดหมาย'));
  expect(screen.getByLabelText('ชื่อ–นามสกุล *')).toHaveValue('UNSAVED SYNTHETIC FAMILY');
  await user.click(nav('ติดต่อ')); fireEvent.click(screen.getByText('ออกจากระบบ')); // Programmatic handler coverage: control is deliberately hidden.
  await screen.findByText('ออกจากระบบแล้ว'); expect(document.body.textContent).not.toContain('UNSAVED SYNTHETIC FAMILY');
  expect(document.querySelector('input')).toBeNull(); expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  await user.click(screen.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' })); await screen.findByRole('heading', { name: 'นัดหมายของฉัน' });
  fireEvent.popState(window); expect(document.body.textContent).not.toContain('UNSAVED SYNTHETIC FAMILY'); expect(r.writes).toHaveLength(0);
});

it('reloads a committed opaque deep link without replaying the booking', async () => {
  window.history.replaceState(null, '', '/booking'); const r = runtime(); const user = userEvent.setup(); const view = render(<App {...r.props} />);
  await review(user); await user.click(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' })); await screen.findByRole('heading', { name: 'ส่งคำขอแล้ว รอการอนุมัติ' });
  const path = window.location.pathname; view.unmount(); render(<App {...r.props} />); await screen.findByRole('heading', { name: 'รายละเอียดนัดหมาย' });
  expect(window.location.pathname).toBe(path); expect(r.writes).toHaveLength(1);
});
