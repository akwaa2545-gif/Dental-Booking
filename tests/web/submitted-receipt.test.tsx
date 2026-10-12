import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { SubmittedReceipt } from '../../src/web/booking/SubmittedReceipt';
import { createDemoApi } from '../../src/demo/api';
import { createDemoClock } from '../../src/demo/clock';
import type { Appointment } from '../../src/shared/contracts';

async function appointment() {
  return (await createDemoApi({ now: createDemoClock().now }).request<Appointment[]>('/api/appointments'))[0];
}

it('shows actual returned request details, pending wording, navigation and focused announcement', async () => {
  const result = { ...await appointment(), status: 'pending' as const, reference: 'RETURNED-123' };
  const onHome = vi.fn(); const onAppointments = vi.fn(); const user = userEvent.setup();
  render(<SubmittedReceipt appointment={result} animate dataMode="server" onHome={onHome} onAppointments={onAppointments} />);
  expect(screen.getByRole('heading', { name: 'ส่งคำขอแล้ว รอการอนุมัติ' })).toHaveFocus();
  expect(screen.getByText('RETURNED-123')).toBeVisible();
  expect(screen.getByText(result.patient.fullName)).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('ยังไม่ใช่การยืนยันนัดหมาย');
  expect(screen.getByText(/บันทึกในระบบทดสอบ/)).toBeVisible();
  expect(document.querySelector('.receipt-enter')).not.toBeNull();
  await user.click(screen.getByRole('button', { name: 'ดูนัดหมายของฉัน' })); expect(onAppointments).toHaveBeenCalledOnce();
  await user.click(screen.getByRole('button', { name: 'กลับหน้าหลัก' })); expect(onHome).toHaveBeenCalledOnce();
});

it('never animates recovery receipts and describes their actual status', async () => {
  render(<SubmittedReceipt appointment={{ ...await appointment(), status: 'approved' }} animate={false} onHome={() => {}} onAppointments={() => {}} />);
  expect(document.querySelector('.receipt-enter')).toBeNull();
  expect(screen.getByRole('heading', { name: 'พบคำขอนัดหมายแล้ว' })).toBeVisible();
  expect(screen.getByText('✓ อนุมัติแล้ว')).toBeVisible();
  expect(screen.queryByText('รอคลินิกอนุมัติ')).not.toBeInTheDocument();
});

it('keeps a hidden receipt inert and does not replay its animation when revealed', async () => {
  const result = await appointment();
  const props = { appointment: result, animate: true, onHome: () => {}, onAppointments: () => {} };
  const view = render(<SubmittedReceipt {...props} active={false} />);
  expect(document.querySelector('.receipt-enter')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('');
  view.rerender(<SubmittedReceipt {...props} active />);
  expect(document.querySelector('.receipt-enter')).toBeNull();
  expect(screen.getByRole('heading')).toHaveFocus();
});

it('suppresses decorative animation for reduced motion preference', async () => {
  const original = window.matchMedia;
  window.matchMedia = vi.fn().mockReturnValue({ matches: true });
  try {
    await act(async () => { render(<SubmittedReceipt appointment={await appointment()} animate onHome={() => {}} onAppointments={() => {}} />); });
    expect(document.querySelector('.receipt-enter')).toBeNull();
  } finally { window.matchMedia = original; }
});

it('does not replay its initial animation after leaving and returning', async () => {
  const props = { appointment: await appointment(), animate: true, onHome: () => {}, onAppointments: () => {} };
  const view = render(<SubmittedReceipt {...props} />);
  expect(document.querySelector('.receipt-enter')).not.toBeNull();
  view.rerender(<SubmittedReceipt {...props} active={false} />);
  view.rerender(<SubmittedReceipt {...props} active />);
  expect(document.querySelector('.receipt-enter')).toBeNull();
});

it('announces a hidden-mount receipt once on foreground without replay or repeated focus theft', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  try {
    const view = render(<SubmittedReceipt appointment={await appointment()} animate onHome={() => {}} onAppointments={() => {}} />);
    const heading = screen.getByRole('heading');
    expect(heading).not.toHaveFocus();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(document.querySelector('.receipt-enter')).toBeNull();
    visibility.mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(heading).toHaveFocus();
    expect(screen.getByRole('status')).not.toBeEmptyDOMElement();
    expect(document.querySelector('.receipt-enter')).toBeNull();
    const home = screen.getByRole('button', { name: 'กลับหน้าหลัก' }); home.focus();
    visibility.mockReturnValue('hidden'); act(() => document.dispatchEvent(new Event('visibilitychange')));
    visibility.mockReturnValue('visible'); act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(home).toHaveFocus();
    view.unmount();
    act(() => document.dispatchEvent(new Event('visibilitychange')));
  } finally { visibility.mockRestore(); }
});

it('does not announce or focus an inactive receipt when the document returns', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  try {
    const props = { appointment: await appointment(), animate: true, onHome: () => {}, onAppointments: () => {} };
    const view = render(<SubmittedReceipt {...props} />);
    view.rerender(<SubmittedReceipt {...props} active={false} />);
    visibility.mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(screen.getByRole('heading')).not.toHaveFocus();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
    expect(document.querySelector('.receipt-enter')).toBeNull();
  } finally { visibility.mockRestore(); }
});
