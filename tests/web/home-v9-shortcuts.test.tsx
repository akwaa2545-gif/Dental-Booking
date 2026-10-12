import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HomeScreen } from '../../src/web/app';
import { SERVICES, SERVICE_DESCRIPTIONS, SERVICE_LABELS } from '../../src/web/copy.th';

describe('approved home v9 shortcuts', () => {
  it('shows photo, large booking entry and name-only shortcuts without old helper copy', () => {
    const start = vi.fn(); render(<HomeScreen onStartBooking={start} onSelectService={() => {}} />);
    expect(screen.queryByText(/เลือกบริการและวันที่สะดวก/)).not.toBeInTheDocument();
    expect(screen.queryByText('ห้องทันตกรรม ใกล้บ้านคุณ')).not.toBeInTheDocument();
    expect(screen.queryByText('เลือกบริการที่ต้องการ')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'นัดหมายทันตกรรม' })).toHaveClass('visually-hidden');
    const photo = screen.getByRole('img'); const cta = screen.getByRole('button', { name: 'เริ่มนัดหมาย' });
    const services = screen.getByRole('region', { name: 'บริการทันตกรรมของเรา' });
    expect(photo.compareDocumentPosition(cta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cta.compareDocumentPosition(services) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const copy of Object.values(SERVICE_DESCRIPTIONS)) expect(screen.queryByText(copy)).not.toBeInTheDocument();
    expect(screen.getByText('รอคลินิกอนุมัติเพื่อยืนยันนัดหมาย')).toBeVisible();
    const artwork = Array.from(services.querySelectorAll('svg[data-dental-icon]'), icon => icon.innerHTML);
    expect(artwork).toHaveLength(3);
    expect(new Set(artwork).size).toBe(3);
    fireEvent.click(cta); expect(start).toHaveBeenCalledOnce();
  });
  it.each(SERVICES)('renders the distinct approved %s line icon and retains selected-service routing', service => {
    const select = vi.fn(); render(<HomeScreen onStartBooking={() => {}} onSelectService={select} />);
    const button = within(screen.getByRole('region', { name: 'บริการทันตกรรมของเรา' })).getByRole('button', { name: SERVICE_LABELS[service] });
    expect(button.textContent).toBe(SERVICE_LABELS[service]);
    const icon = button.querySelector(`svg[data-dental-icon="${service}"]`);
    expect(icon).toHaveAttribute('viewBox', '0 0 32 32');
    expect(icon).toHaveAttribute('width', '30');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon).toHaveAttribute('focusable', 'false');
    fireEvent.click(button); expect(select).toHaveBeenCalledExactlyOnceWith(service);
  });
  it('retains unavailable-entry protection for all shortcuts', () => {
    const select = vi.fn(); const start = vi.fn();
    render(<HomeScreen bookingDisabled onStartBooking={start} onSelectService={select} />);
    for (const button of screen.getAllByRole('button')) { expect(button).toBeDisabled(); fireEvent.click(button); }
    expect(start).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
  });
});
