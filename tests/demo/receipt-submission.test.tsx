import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { BookingFlow } from '../../src/web/booking/BookingFlow';
import { ApiRequestError, type ApiClient } from '../../src/web/api';
import { createDemoApi } from '../../src/demo/api';
import { createDemoClock } from '../../src/demo/clock';

async function review(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByDisplayValue('คุณยิ้ม ทดลอง');
  await user.click(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }));
  await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
  await user.click(await screen.findByRole('button', { name: /^2026-10-08 ว่าง/ }));
  await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
}

it('signals a new receipt only after a successful POST response, keeping one dock submit', async () => {
  const real = createDemoApi({ now: createDemoClock().now });
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const api: ApiClient = { async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (path === '/api/appointments' && init?.method === 'POST') await hold;
    return real.request<T>(path, init);
  } };
  const onSubmitted = vi.fn(); const user = userEvent.setup();
  render(<BookingFlow api={api} initialService="scaling" onSubmitted={onSubmitted} />);
  await review(user);
  const submit = screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' });
  expect(submit.closest('.review-submit-dock')).not.toBeNull();
  await user.dblClick(submit);
  expect(onSubmitted).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'กำลังส่งคำขอ…' })).toBeDisabled();
  await act(async () => release());
  expect(onSubmitted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'pending', service: 'scaling' }), { animate: true });
});

it.each(['lookup', 'retry'] as const)('never animates the %s recovery of an uncertain request', async mode => {
  const real = createDemoApi({ now: createDemoClock().now }); let writes = 0;
  const api: ApiClient = { async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (path === '/api/appointments' && init?.method === 'POST' && ++writes === 1) {
      if (mode === 'lookup') await real.request(path, init);
      throw new ApiRequestError('UNAVAILABLE', 503);
    }
    return real.request<T>(path, init);
  } };
  const onSubmitted = vi.fn(); const user = userEvent.setup();
  render(<BookingFlow api={api} initialService="filling" onSubmitted={onSubmitted} />);
  await review(user); await user.click(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' }));
  expect(onSubmitted).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'ตรวจสอบคำขอเดิม' }));
  if (mode === 'retry') await user.click(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' }));
  expect(onSubmitted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'pending' }), { animate: false });
});

it('uses three decorative service image banners with real service selection', async () => {
  const user = userEvent.setup();
  render(<BookingFlow api={createDemoApi({ now: createDemoClock().now })} onSubmitted={() => {}} />);
  const banners = document.querySelectorAll('.booking-service.service-banner');
  expect(banners).toHaveLength(3);
  for (const banner of banners) expect(banner.querySelector('img')).toHaveAttribute('alt', '');
  await user.click(screen.getByRole('button', { name: /ขูดหินปูน/ }));
  expect(await screen.findByRole('heading', { name: 'ข้อมูลผู้รับบริการ' })).toBeVisible();
});

it('measures the review dock for content clearance and updates when its size changes', async () => {
  const original = globalThis.ResizeObserver;
  let resize: (() => void) | undefined;
  let dockHeight = 114;
  const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { height: this.classList.contains('review-submit-dock') ? dockHeight : 0 } as DOMRect;
  });
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { resize = () => callback([], this); }
    observe() {} unobserve() {} disconnect() {}
  };
  try {
    const user = userEvent.setup();
    render(<BookingFlow api={createDemoApi({ now: createDemoClock().now })} initialService="filling" onSubmitted={() => {}} />);
    await review(user);
    const card = document.querySelector<HTMLElement>('.review-flow-card')!;
    expect(card.style.getPropertyValue('--review-dock-height')).toBe('114px');
    dockHeight = 168;
    act(() => resize?.());
    expect(card.style.getPropertyValue('--review-dock-height')).toBe('168px');
  } finally { rect.mockRestore(); globalThis.ResizeObserver = original; }
});

it.each(['hidden', 'inactive'] as const)('does not animate a response that arrives while %s', async mode => {
  const real = createDemoApi({ now: createDemoClock().now });
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const api: ApiClient = { async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (path === '/api/appointments' && init?.method === 'POST') await hold;
    return real.request<T>(path, init);
  } };
  const onSubmitted = vi.fn(); const user = userEvent.setup();
  const view = render(<BookingFlow api={api} initialService="scaling" onSubmitted={onSubmitted} />);
  await review(user); await user.click(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' }));
  const visibility = mode === 'hidden' ? vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden') : undefined;
  if (mode === 'inactive') view.rerender(<BookingFlow api={api} initialService="scaling" onSubmitted={onSubmitted} active={false} />);
  try {
    await act(async () => release());
    expect(onSubmitted).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ status: 'pending' }), { animate: false });
  } finally { visibility?.mockRestore(); }
});
