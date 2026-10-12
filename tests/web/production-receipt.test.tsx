import { act, render, screen, waitFor, within } from '@testing-library/react';
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

it('shows the real returned pending receipt only after the write resolves and never repeats the POST', async () => {
  window.history.replaceState(null, '', '/booking'); const r = runtime(); r.setMode('pending'); const user = userEvent.setup();
  render(<App {...r.props} />); await review(user); await user.dblClick(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' }));
  await waitFor(() => expect(r.writes).toHaveLength(1));
  expect(document.querySelector('.receipt-card')).toBeNull();
  expect(screen.getByRole('button', { name: 'กำลังส่งคำขอ…' })).toBeDisabled();
  await act(async () => r.release());
  expect(await screen.findByRole('heading', { name: 'ส่งคำขอแล้ว รอการอนุมัติ' })).toHaveFocus();
  const result = await r.real.request<Appointment>(`/api/submissions/${r.writes[0].key}`);
  expect(screen.getByText(result.reference)).toBeVisible();
  expect(screen.getByText(result.patient.fullName)).toBeVisible();
  expect(screen.getByText('รอคลินิกอนุมัติ')).toBeVisible();
  expect(document.querySelector('.receipt-enter')).not.toBeNull();
  expect(window.location.pathname).toBe(`/appointments/${result.id}`);
  expect(r.writes).toHaveLength(1);
  await user.click(screen.getByRole('button', { name: 'ดูนัดหมายของฉัน' }));
  expect(await screen.findByRole('heading', { name: 'นัดหมายของฉัน' })).toBeVisible();
  expect(document.querySelector('.receipt-card')).toBeNull();
  await act(async () => { window.history.back(); await new Promise(resolve => setTimeout(resolve, 30)); });
  expect(await screen.findByRole('heading', { name: 'รายละเอียดนัดหมาย' })).toBeVisible();
  expect(document.querySelector('.receipt-enter')).toBeNull();
  expect(r.writes).toHaveLength(1);
});

it('routes a recovered committed request to a static receipt with no second POST', async () => {
  window.history.replaceState(null, '', '/booking'); const r = runtime(); r.setMode('lose-response'); const user = userEvent.setup();
  render(<App {...r.props} />); await review(user); await user.click(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' }));
  await screen.findByRole('button', { name: 'ตรวจสอบคำขอเดิม' });
  expect(document.querySelector('.receipt-card')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'ตรวจสอบคำขอเดิม' }));
  expect(await screen.findByRole('heading', { name: 'ส่งคำขอแล้ว รอการอนุมัติ' })).toBeVisible();
  expect(document.querySelector('.receipt-card')).not.toBeNull();
  expect(document.querySelector('.receipt-enter')).toBeNull();
  expect(r.writes).toHaveLength(1);
});

it('never shows a receipt or steals navigation after a hidden-flow POST resolves', async () => {
  window.history.replaceState(null, '', '/booking'); const r = runtime(); r.setMode('pending'); const user = userEvent.setup();
  render(<App {...r.props} />); await review(user); await user.click(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' }));
  await waitFor(() => expect(r.writes).toHaveLength(1));
  await user.click(nav('ติดต่อ')); await act(async () => r.release());
  expect(screen.getByRole('heading', { name: 'ติดต่อเรา' })).toBeVisible();
  expect(document.querySelector('.receipt-card')).toBeNull();
  const result = await r.real.request<Appointment>(`/api/submissions/${r.writes[0].key}`);
  await act(async () => { window.history.pushState(null, '', `/appointments/${result.id}`); window.dispatchEvent(new PopStateEvent('popstate')); });
  expect(await screen.findByRole('heading', { name: 'รายละเอียดนัดหมาย' })).toBeVisible();
  expect(document.querySelector('.receipt-enter')).toBeNull();
  expect(r.writes).toHaveLength(1);
});
