import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DateCalendar } from '../../src/web/booking/DateCalendar';

describe('month calendar and optional accessible list', () => {
  it('keeps full accessible date labels and selection rules', () => {
    const change = vi.fn();
    render(<DateCalendar days={[{ date: '2026-10-08', state: 'available' }, { date: '2026-10-09', state: 'full' }]} value="2026-10-08" onChange={change} />);
    const available = screen.getByRole('button', { name: /^2026-10-08 ว่าง/ });
    expect(available.querySelector('.compact-date')).toHaveTextContent('พฤหัสบดี');
    expect(available.querySelector('.compact-date')).toHaveTextContent('ตุลาคม');
    expect(available.getAttribute('aria-label')).toContain(available.querySelector('.compact-date')?.textContent);
    expect(available).toHaveAccessibleName(/พฤหัสบดี/);
    expect(available).toHaveAttribute('aria-pressed', 'true');
    expect(available.querySelector('.selected-check')).toHaveTextContent('✓');
    const full = screen.getByRole('button', { name: /^2026-10-09 เต็ม/ });
    expect(full).toBeDisabled();
    expect(full).toHaveClass('full');
    fireEvent.click(full);
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(available);
    expect(change).toHaveBeenCalledWith('2026-10-08');
  });
  it('defaults to a seven-day month with correct weekday offsets and a selected-date summary', () => {
    const { container } = render(<DateCalendar days={[{ date: '2026-10-08', state: 'available' }]} value="2026-10-08" onChange={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'ปฏิทินเลือกวันนัด' })).toHaveAttribute('data-view', 'month');
    expect(screen.getByRole('button', { name: 'รายเดือน' })).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelectorAll('.weekday-label')).toHaveLength(7);
    expect(container.querySelectorAll('.calendar-spacer')).toHaveLength(4);
    expect(container.querySelectorAll('.day-number')).toHaveLength(31);
    expect(screen.getByRole('status')).toHaveTextContent('วันที่เลือก');
    expect(screen.getByRole('status')).toHaveTextContent('8 ตุลาคม');
  });

  it('switches views without selecting a date or losing the displayed month', () => {
    const change = vi.fn();
    render(<DateCalendar days={[{ date: '2026-10-08', state: 'available' }, { date: '2026-11-02', state: 'available' }]} value="2026-10-08" onChange={change} />);
    fireEvent.click(screen.getByRole('button', { name: 'เดือนถัดไป' }));
    fireEvent.click(screen.getByRole('button', { name: 'รายการ' }));
    const calendar = screen.getByRole('region', { name: 'ปฏิทินเลือกวันนัด' });
    expect(calendar).toHaveAttribute('data-view', 'list');
    expect(screen.getByRole('button', { name: 'รายการ' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(calendar).getByRole('heading')).toHaveTextContent('พฤศจิกายน');
    expect(screen.getByRole('status')).toHaveTextContent('8 ตุลาคม');
    fireEvent.click(screen.getByRole('button', { name: 'รายเดือน' }));
    expect(calendar).toHaveAttribute('data-view', 'month');
    expect(within(calendar).getByRole('heading')).toHaveTextContent('พฤศจิกายน');
    expect(change).not.toHaveBeenCalled();
  });

  it.each(['full', 'closed', 'paused', 'ineligible'] as const)('keeps %s dates disabled in both views', state => {
    const change = vi.fn();
    render(<DateCalendar days={[{ date: '2026-10-08', state }]} value={null} onChange={change} />);
    const date = screen.getByRole('button', { name: /^2026-10-08 / });
    expect(date).toBeDisabled();
    fireEvent.click(date);
    fireEvent.click(screen.getByRole('button', { name: 'รายการ' }));
    expect(date).toBeDisabled();
    fireEvent.click(date);
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('ยังไม่ได้เลือกวันนัด');
  });
});
