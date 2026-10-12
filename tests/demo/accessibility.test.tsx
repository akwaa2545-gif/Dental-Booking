import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { DemoApp } from '../../src/demo/DemoApp';

// jsdom has no layout/canvas: this gate checks semantics, not rendered contrast,
// actual 44px hit boxes, zoom, overflow or native browser focus containment.
async function checkSemantics(container: HTMLElement) {
  const result = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  expect(result.violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))).toEqual([]);
}

describe('demo DOM accessibility', () => {
  it('keeps home, family form, date and review controls labeled', async () => {
    window.history.replaceState(null, '', '/');
    const { container } = render(<DemoApp />); const user = userEvent.setup();
    await checkSemantics(container);
    await user.click(screen.getByRole('button', { name: 'เริ่มนัดหมาย' }));
    await user.click(screen.getByRole('button', { name: /ตรวจสุขภาพช่องปาก/ }));
    await screen.findByDisplayValue('คุณยิ้ม ทดลอง'); await checkSemantics(container);
    await user.click(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }));
    await user.click(screen.getByRole('button', { name: 'ถัดไป' })); await checkSemantics(container);
    await user.click(screen.getByRole('button', { name: /^2026-10-08 ว่าง/ }));
    await user.click(screen.getByRole('button', { name: 'ถัดไป' })); await checkSemantics(container);
  });

  it('keeps history and cancellation dialog labeled with reversible close', async () => {
    window.history.replaceState(null, '', '/appointments');
    const { container } = render(<DemoApp />); const user = userEvent.setup();
    const card = (await screen.findAllByRole('article')).find(c => within(c).queryByText('คุณใจดี สมมติ'))!;
    await checkSemantics(container);
    await user.click(within(card).getByRole('button', { name: 'ดูรายละเอียด' }));
    const opener = await screen.findByRole('button', { name: 'ยกเลิกนัดหมาย' }); await user.click(opener);
    await checkSemantics(container);
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'ปิดหน้าต่าง' }));
    expect(opener).toHaveFocus(); expect(screen.getByText('✓ อนุมัติแล้ว')).toBeVisible();
  });

  it('keeps simulated admin filters and decision dialog labeled', async () => {
    window.history.replaceState(null, '', '/');
    const { container } = render(<DemoApp />); const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'ผู้ดูแลจำลอง' }));
    await screen.findByLabelText('วันที่นัด');
    await user.click(screen.getByRole('button', { name: 'ดูทุกวันและสถานะ' }));
    const card = (await screen.findAllByRole('article')).find(c => within(c).queryByText('คุณอุ่นใจ สมมติ') && within(c).queryByRole('button', { name: 'พิจารณาคำขอ' }))!;
    await checkSemantics(container);
    await user.click(within(card).getByRole('button', { name: 'พิจารณาคำขอ' })); await checkSemantics(container);
  });
});
