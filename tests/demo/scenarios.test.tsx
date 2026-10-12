import { readFileSync } from 'node:fs';
import { MyAppointments } from '../../src/web/appointments/MyAppointments';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Dashboard } from '../../src/web/admin/Dashboard';
import { createDemoClock } from '../../src/demo/clock';
import { createDemoApi } from '../../src/demo/api';
import type { Patient } from '../../src/shared/contracts';
import { FIXTURE_IDS } from '../../src/demo/fixtures';
import { DemoApp } from '../../src/demo/DemoApp';

function renderAt(path = '/') { window.history.replaceState(null, '', path); return render(<DemoApp />); }

async function openAdminRequest(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'ผู้ดูแลจำลอง' }));
  await user.click(screen.getByRole('button', { name: 'ดูทุกวันและสถานะ' }));
  const card = (await screen.findAllByRole('article')).find(c => within(c).queryByText('คุณอุ่นใจ สมมติ') && within(c).queryByRole('button', { name: 'พิจารณาคำขอ' }))!;
  await user.click(within(card).getByRole('button', { name: 'พิจารณาคำขอ' })); return card;
}

describe('controlled synthetic scenarios', () => {
  it('rejects a request once and updates the patient web status and generic preview', async () => {
    renderAt(); const user = userEvent.setup(); await openAdminRequest(user);
    await user.dblClick(within(screen.getByRole('dialog')).getByRole('button', { name: 'ไม่อนุมัติคำขอ' }));
    await user.click(screen.getByRole('button', { name: 'ผู้รับบริการจำลอง' }));
    const card = (await screen.findAllByRole('article')).find(c => within(c).queryByText('คุณอุ่นใจ สมมติ'))!;
    expect(within(card).getByText('× ไม่อนุมัติ')).toBeVisible();
    expect(screen.getAllByText('ตัวอย่างการแจ้งเตือน: คำขอนัดหมายไม่ได้รับการอนุมัติ ดูสถานะล่าสุดในเว็บไซต์')).toHaveLength(1);
    await user.click(within(card).getByRole('button', { name: 'ดูรายละเอียด' }));
    expect(await screen.findByText('× ไม่อนุมัติ')).toBeVisible(); expect(screen.queryByRole('button', { name: 'ยกเลิกนัดหมาย' })).not.toBeInTheDocument();
  });

  it('pauses a full date without changing requests and refuses closing unresolved records', async () => {
    renderAt(); const user = userEvent.setup(); await user.click(screen.getByRole('button', { name: 'ผู้ดูแลจำลอง' }));
    const date = screen.getByLabelText('วันที่นัด'); await user.clear(date); await user.type(date, '2026-10-09');
    expect(await screen.findByText('3/3 ที่ใช้ในวันที่เลือก')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'บันทึกการรับคำขอ' }));
    expect(await screen.findByText('หยุดรับคำขอ')).toBeVisible();
    const card = (await screen.findAllByRole('article')).find(c => within(c).queryByText('คุณอุ่นใจ สมมติ'))!;
    expect(within(card).getByText('◷ รอการอนุมัติ')).toBeVisible();
    await user.click(within(card).getByRole('button', { name: 'พิจารณาคำขอ' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'อนุมัติคำขอ' }));
    expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('ยังอนุมัติไม่ได้');
    await user.keyboard('{Escape}');
    await user.selectOptions(screen.getByRole('combobox', { name: 'การรับคำขอ' }), 'closed');
    await user.click(screen.getByRole('button', { name: 'บันทึกการรับคำขอ' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('ยังปิดวันไม่ได้');
    expect(within(card).getByText('◷ รอการอนุมัติ')).toBeVisible();
  });

  it('uses the fixed Bangkok clock for reminder and cancellation cutoff without real requests', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch'); const storage = vi.spyOn(Storage.prototype, 'setItem');
    renderAt('/appointments'); const user = userEvent.setup();
    await user.click(screen.getByText(/นาฬิกาสาธิต ·/));
    await user.click(screen.getByRole('button', { name: 'วันก่อนนัด 18:00 · จำลองเตือน' }));
    expect(await screen.findByText('ตัวอย่างการแจ้งเตือน: คุณมีนัดหมายวันพรุ่งนี้ ดูรายละเอียดล่าสุดในเว็บไซต์')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'วันก่อนนัด 18:00 · จำลองเตือน' }));
    expect(screen.getAllByText('ตัวอย่างการแจ้งเตือน: คุณมีนัดหมายวันพรุ่งนี้ ดูรายละเอียดล่าสุดในเว็บไซต์')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'วันนัด 00:00 · หมดยกเลิก' }));
    const card = (await screen.findAllByRole('article')).find(c => within(c).queryByText('คุณใจดี สมมติ'))!;
    await user.click(within(card).getByRole('button', { name: 'ดูรายละเอียด' }));
    expect(await screen.findByText(/วันนัดหรือเลยกำหนดยกเลิกแล้ว/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'ยกเลิกนัดหมาย' })).not.toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
  });

  it('fresh mount behaves like reload and removes the cancelled fixture mutation', async () => {
    const user = userEvent.setup(); const first = renderAt('/appointments');
    const card = (await screen.findAllByRole('article')).find(c => within(c).queryByText('คุณใจดี สมมติ'))!;
    await user.click(within(card).getByRole('button', { name: 'ดูรายละเอียด' }));
    const deepLink = window.location.pathname;
    await user.click(await screen.findByRole('button', { name: 'ยกเลิกนัดหมาย' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'ยืนยันยกเลิก' }));
    expect(await screen.findByText('− ยกเลิกแล้ว')).toBeVisible();
    first.unmount(); renderAt(deepLink);
    // Fixture references are regenerated, so a stale generated fixture deep link is missing.
    expect(await screen.findByRole('heading', { name: 'ไม่พบนัดหมาย' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'กลับไปนัดหมายของฉัน' }));
    expect(await screen.findByText('✓ อนุมัติแล้ว')).toBeVisible();
  });

  it.each(['77777777-7777-4777-8777-777777777777', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'])('direct foreign or missing link %s shows identical missing screen', async id => {
    renderAt(`/appointments/${id}`);
    expect(await screen.findByRole('heading', { name: 'ไม่พบนัดหมาย' })).toBeVisible();
    expect(screen.queryByText('บัญชีอื่น สมมติ')).not.toBeInTheDocument();
  });

  it('Back/Forward dismisses a cancel dialog and keeps the committed status', async () => {
    const user = userEvent.setup(); renderAt('/appointments');
    const card = (await screen.findAllByRole('article')).find(c => within(c).queryByText('คุณใจดี สมมติ'))!;
    await user.click(within(card).getByRole('button', { name: 'ดูรายละเอียด' })); const detail = window.location.pathname;
    await user.click(await screen.findByRole('button', { name: 'ยกเลิกนัดหมาย' }));
    await act(async () => { window.history.replaceState(null, '', '/appointments'); window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await act(async () => { window.history.replaceState(null, '', detail); window.dispatchEvent(new PopStateEvent('popstate')); });
    expect(await screen.findByText('✓ อนุมัติแล้ว')).toBeVisible();
  });
});

describe('admin review regressions', () => {
  it('defaults pending review to the nearest open date even when that date is full', async () => {
    const clock = createDemoClock(); const api = createDemoApi({ now: clock.now });
    for (const [patientId, ageConfirmed] of [[FIXTURE_IDS.self, 32], [FIXTURE_IDS.parent, 65]] as const) {
      await api.request('/api/appointments', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ patientId, patientVersion: 1, service: 'filling', date: '2026-10-08', ageConfirmed, authorizationAcknowledged: true }) });
    }
    api.setRole('admin'); render(<Dashboard api={api} now={clock.now} />);
    expect(await screen.findByLabelText('วันที่นัด')).toHaveValue('2026-10-08');
    expect(screen.getByRole('combobox', { name: 'สถานะคำขอ' })).toHaveValue('pending');
    expect(await screen.findAllByRole('article')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'คุณยิ้ม ทดลอง' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'คุณอุ่นใจ สมมติ' })).toBeVisible();
  });

  it('lists approved and pending pause blockers independently of the pending queue', async () => {
    renderAt(); const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'ผู้ดูแลจำลอง' }));
    const date = screen.getByLabelText('วันที่นัด'); await user.clear(date); await user.type(date, '2026-10-09');
    expect(screen.getByRole('combobox', { name: 'สถานะคำขอ' })).toHaveValue('pending');
    await user.click(screen.getByRole('button', { name: 'บันทึกการรับคำขอ' }));
    const resolution = await screen.findByRole('region', { name: 'คำขอและนัดที่ยังต้องจัดการ' });
    expect(within(resolution).getAllByRole('listitem')).toHaveLength(3);
    expect(within(resolution).getByText('คุณอุ่นใจ สมมติ')).toBeVisible();
    expect(within(resolution).getByText('ครอบครัวบัญชีอื่น สมมติ')).toBeVisible();
    expect(within(resolution).getByText('บัญชีอื่น สมมติ')).toBeVisible();
    expect(within(resolution).getByText('✓ อนุมัติแล้ว')).toBeVisible();
    expect(within(resolution).getAllByText('◷ รอการอนุมัติ')).toHaveLength(2);
    expect(within(resolution).queryByRole('button', { name: /ยกเลิก|ย้าย/ })).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'สถานะคำขอ' })).toHaveValue('pending');
  });
  it('keeps every pause blocker visible when the selected date is today', async () => {
    renderAt(); const user = userEvent.setup();
    await user.click(screen.getByText(/นาฬิกาสาธิต ·/));
    const scenarioDate = screen.getByLabelText('วันนัดสำหรับสถานการณ์');
    await user.clear(scenarioDate); await user.type(scenarioDate, '2026-10-09');
    await user.click(screen.getByRole('button', { name: 'วันนัด 00:00 · หมดยกเลิก' }));
    await user.click(screen.getByRole('button', { name: 'ผู้ดูแลจำลอง' }));
    const date = screen.getByLabelText('วันที่นัด'); await user.clear(date); await user.type(date, '2026-10-09');
    expect(await screen.findByText('3/3 ที่ใช้ในวันที่เลือก')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'บันทึกการรับคำขอ' }));
    const resolution = await screen.findByRole('region', { name: 'คำขอและนัดที่ยังต้องจัดการ' });
    expect(within(resolution).getAllByRole('listitem')).toHaveLength(3);
    expect(within(resolution).getByText('บัญชีอื่น สมมติ')).toBeVisible();
    expect(within(resolution).getByText('✓ อนุมัติแล้ว')).toBeVisible();
    expect(within(resolution).getAllByText('◷ รอการอนุมัติ')).toHaveLength(2);
    expect(screen.getByRole('combobox', { name: 'สถานะคำขอ' })).toHaveValue('pending');
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(within(resolution).queryByRole('button', { name: /ยกเลิก|ย้าย/ })).not.toBeInTheDocument();
  });

  it('keeps a valid 120-character unbroken name intact with wrapping styles in patient and admin cards', async () => {
    const clock = createDemoClock(); const api = createDemoApi({ now: clock.now }); const name = 'A'.repeat(120);
    const profile = await api.request<Patient>('/api/patients', { method: 'POST', body: JSON.stringify({ fullName: name, phone: '0990000000', age: 32, address: 'ที่อยู่สมมติ', relationship: 'family', authorizationAcknowledged: true }) });
    await api.request('/api/appointments', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ patientId: profile.id, patientVersion: 1, service: 'filling', date: '2026-10-08', ageConfirmed: 32, authorizationAcknowledged: true }) });
    const style = document.createElement('style'); style.textContent = readFileSync('src/web/styles.css', 'utf8'); document.head.append(style);
    try {
      const patientView = render(<MyAppointments api={api} now={clock.now} />);
      const patientName = await screen.findByRole('heading', { name });
      expect(patientName.textContent).toBe(name); expect(getComputedStyle(patientName).overflowWrap).toBe('anywhere');
      patientView.unmount(); api.setRole('admin'); render(<Dashboard api={api} now={clock.now} />);
      const adminName = await screen.findByRole('heading', { name });
      expect(adminName.textContent).toBe(name); expect(getComputedStyle(adminName).overflowWrap).toBe('anywhere');
    } finally { style.remove(); }
  });

});
