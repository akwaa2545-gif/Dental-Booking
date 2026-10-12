import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DemoApp } from '../../src/demo/DemoApp';

async function renderDemo() { window.history.replaceState(null, '', '/'); render(<DemoApp />); }

describe('fictional patient and simulated admin', () => {
  it('demo_patient_admin_round_trip_never_sends_real_data', async () => {
    const outboundLineOrDatabaseCalls = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    await renderDemo();
    await user.click(screen.getByRole('button', { name: 'เริ่มนัดหมาย' }));
    await user.click(screen.getByRole('button', { name: /ตรวจสุขภาพช่องปาก/ }));
    await user.click(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }));
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    await user.click(await screen.findByRole('button', { name: /^2026-10-08 ว่าง/ }));
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    expect(screen.getByText(/08:30–09:30/)).toBeVisible();
    await user.dblClick(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' }));
    expect(await screen.findByRole('heading', { name: 'ส่งคำขอแล้ว รอการอนุมัติ' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'ผู้ดูแลจำลอง' }));
    const newRequest = (await screen.findAllByRole('article')).find(card => within(card).queryByText('คุณยิ้ม ทดลอง'))!;
    await user.click(within(newRequest).getByRole('button', { name: 'พิจารณาคำขอ' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'อนุมัติคำขอ' }));
    await user.click(screen.getByRole('button', { name: 'ผู้รับบริการจำลอง' }));
    expect(await screen.findByText('✓ อนุมัติแล้ว')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'ส่งคำขอแล้ว รอการอนุมัติ' })).not.toBeInTheDocument();
    expect(screen.getByText('ตัวอย่างการแจ้งเตือน: คำขอนัดหมายได้รับการอนุมัติ ดูสถานะล่าสุดในเว็บไซต์')).toBeVisible();
    expect(outboundLineOrDatabaseCalls).not.toHaveBeenCalled();
  });

  it('selects an existing family profile and keeps full/closed/paused dates disabled', async () => {
    const user = userEvent.setup(); await renderDemo();
    await user.click(screen.getByRole('button', { name: 'เริ่มนัดหมาย' }));
    await user.click(screen.getByRole('button', { name: /ขูดหินปูน/ }));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'ผู้รับบริการสมมติ' }), '33333333-3333-4333-8333-333333333333');
    expect(screen.getByRole('textbox', { name: 'ชื่อ–นามสกุล *' })).toHaveValue('คุณอุ่นใจ สมมติ');
    await user.click(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ })); await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    expect(await screen.findByRole('button', { name: /^2026-10-09 เต็ม/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^2026-10-12 ปิดรับนัด/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^2026-10-13 หยุดรับคำขอ/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /^2026-10-14 ว่าง/ })); await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    expect(screen.getByText('คุณอุ่นใจ สมมติ')).toBeVisible(); expect(screen.getByText('65 ปี')).toBeVisible();
  });
  it('renders a new profile script string as literal review text', async () => {
    const user = userEvent.setup(); await renderDemo(); await user.click(screen.getByRole('button', { name: 'เริ่มนัดหมาย' })); await user.click(screen.getByRole('button', { name: /อุดฟัน/ }));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'ผู้รับบริการสมมติ' }), 'new');
    await user.type(screen.getByRole('textbox', { name: 'ชื่อ–นามสกุล *' }), '<script>alert(1)</script>');
    await user.type(screen.getByRole('textbox', { name: 'เบอร์โทรศัพท์ *' }), '0990000000');
    await user.clear(screen.getByRole('spinbutton', { name: 'อายุ (ปี) *' })); await user.type(screen.getByRole('spinbutton', { name: 'อายุ (ปี) *' }), '18');
    await user.type(screen.getByRole('textbox', { name: 'ที่อยู่บ้าน *' }), 'ถนนสมมติ'); await user.click(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ })); await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    await user.click(await screen.findByRole('button', { name: /^2026-10-14 ว่าง/ })); await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    expect(screen.getByText('<script>alert(1)</script>')).toBeVisible(); expect(document.querySelector('script')).toBeNull();
  });
  it('cancels with a double-click guard and Escape restores focus without mutation', async () => {
    const user = userEvent.setup(); await renderDemo(); await user.click(screen.getByRole('button', { name: 'ผู้รับบริการจำลอง' }));
    const card = (await screen.findAllByRole('article')).find(c => within(c).queryByText('คุณใจดี สมมติ'))!;
    await user.click(within(card).getByRole('button', { name: 'ดูรายละเอียด' })); const opener = await screen.findByRole('button', { name: 'ยกเลิกนัดหมาย' });
    await user.click(opener); expect(screen.getByRole('dialog')).toBeVisible(); await user.keyboard('{Escape}'); expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(opener).toHaveFocus(); expect(screen.getByText('✓ อนุมัติแล้ว')).toBeVisible();
    await user.click(opener); await user.dblClick(within(screen.getByRole('dialog')).getByRole('button', { name: 'ยืนยันยกเลิก' })); expect(await screen.findByText('− ยกเลิกแล้ว')).toBeVisible();
  });
  it('reset removes a cancellation mutation and restores the approved fixture', async () => {
    const user = userEvent.setup(); await renderDemo(); await user.click(screen.getByRole('button', { name: 'ผู้รับบริการจำลอง' }));
    const cards = await screen.findAllByRole('article'); await user.click(within(cards[0]).getByRole('button', { name: 'ดูรายละเอียด' }));
    await user.click(await screen.findByRole('button', { name: 'ยกเลิกนัดหมาย' })); await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'ยืนยันยกเลิก' })); expect(await screen.findByText('− ยกเลิกแล้ว')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'เริ่มเดโมใหม่' })); expect(screen.getByRole('button', { name: 'เริ่มนัดหมาย' })).toBeVisible(); await user.click(screen.getByRole('button', { name: 'ผู้รับบริการจำลอง' })); expect(await screen.findByText('✓ อนุมัติแล้ว')).toBeVisible();
  });

  it('requires every patient field and a fresh authorization acknowledgement', async () => {
    const user = userEvent.setup(); await renderDemo();
    await user.click(screen.getByRole('button', { name: 'เริ่มนัดหมาย' })); await user.click(screen.getByRole('button', { name: /อุดฟัน/ }));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'ผู้รับบริการสมมติ' }), 'new');
    for (const label of ['ชื่อ–นามสกุล *', 'เบอร์โทรศัพท์ *', 'อายุ (ปี) *', 'ที่อยู่บ้าน *', 'ความสัมพันธ์ *']) expect(screen.getByLabelText(label)).toBeRequired();
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    expect(screen.getByRole('heading', { name: 'ข้อมูลผู้รับบริการ' })).toBeVisible();
    await user.selectOptions(screen.getByRole('combobox', { name: 'ผู้รับบริการสมมติ' }), '11111111-1111-4111-8111-111111111111');
    const acknowledgement = screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }); await user.click(acknowledgement);
    await user.clear(screen.getByLabelText('อายุ (ปี) *')); await user.type(screen.getByLabelText('อายุ (ปี) *'), '33');
    expect(acknowledgement).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'ถัดไป' })); expect(screen.getByRole('heading', { name: 'ข้อมูลผู้รับบริการ' })).toBeVisible();
  });

});
