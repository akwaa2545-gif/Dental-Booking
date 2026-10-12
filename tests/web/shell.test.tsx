import clinicSeal from '../../src/web/assets/clinic-seal.png?inline';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { App, AppShell } from '../../src/web/app';

describe('Thai booking shell', () => {
  it('uses the supplied clinic identity and live Thai name without inventing a phone number', () => {
    render(<App />);
    expect(screen.getByRole('button', { name: 'ห้องทันตกรรม รพ.สต.บ้านควนไทรงาม หน้าหลัก' })).toBeVisible();
    expect(screen.getByRole('img', { name: 'ตราโรงพยาบาลส่งเสริมสุขภาพตำบลบ้านควนไทรงาม' })).toHaveAttribute('src', clinicSeal);
    expect(screen.getAllByText('ห้องทันตกรรม รพ.สต.บ้านควนไทรงาม').length).toBeGreaterThan(0);
    expect(document.querySelector('a[href^="tel:"]')).toBeNull();
  });
  it('renders exactly the three approved services as accessible cards', () => {
    render(<App />);
    const services = screen.getByRole('region', { name: 'บริการทันตกรรมของเรา' });
    expect(within(services).getAllByRole('button')).toHaveLength(3);
    for (const name of ['ตรวจสุขภาพช่องปาก', 'ขูดหินปูน', 'อุดฟัน']) {
      expect(within(services).getByRole('button', { name: new RegExp(name) })).toBeVisible();
    }
  });
  it('keeps the home uncluttered while preserving the synthetic-data warning', () => {
    render(<App />);
    expect(screen.getByRole('status')).toHaveTextContent('ข้อมูลสมมติสำหรับสาธิตเท่านั้น');
    expect(screen.getByRole('status')).toHaveTextContent('อย่ากรอกข้อมูลผู้ป่วยจริง');
    expect(screen.queryByText(/08:30–09:30/)).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(document.querySelector('input[type="time"]')).toBeNull();
    expect(screen.getByRole('main')).toHaveAttribute('lang', 'th');
  });
  it('offers named navigation and an honest booking-shell entry without claiming confirmation', () => {
    render(<App />);
    expect(screen.getByRole('navigation', { name: 'เมนูหลัก' })).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'เมนูเดสก์ท็อป' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'เริ่มนัดหมาย' }));
    expect(screen.getByRole('heading', { name: 'เริ่มต้นคำขอนัดหมาย' })).toBeVisible();
    expect(screen.getByText(/รอการอนุมัติจากคลินิก/)).toBeVisible();
    expect(screen.queryByText('จองนัดหมายสำเร็จ')).not.toBeInTheDocument();
  });
});


describe('verified admin shell navigation', () => {
  it('shows an active admin menu in both navigation layouts only after verified authority', () => {
    const navigate = vi.fn();
    render(<AppShell isAdmin activeNav="admin" onNavigate={navigate}><p>Admin workspace</p></AppShell>);
    for (const label of ['เมนูเดสก์ท็อป', 'เมนูหลัก']) {
      const menu = within(screen.getByRole('navigation', { name: label }));
      const admin = menu.getByRole('button', { name: 'แอดมิน' });
      expect(admin).toHaveAttribute('aria-current', 'page');
      fireEvent.click(admin);
    }
    expect(navigate.mock.calls).toEqual([['admin'], ['admin']]);
  });
  it.each([undefined, false])('keeps both admin menu entries absent for authority %s', isAdmin => {
    render(<AppShell isAdmin={isAdmin} onNavigate={() => {}}><p>Patient workspace</p></AppShell>);
    expect(screen.queryByRole('button', { name: 'แอดมิน' })).not.toBeInTheDocument();
    for (const label of ['เมนูเดสก์ท็อป', 'เมนูหลัก']) {
      expect(within(screen.getByRole('navigation', { name: label })).getAllByRole('button')).toHaveLength(4);
    }
  });
  it('removes both admin entries immediately when verified authority is revoked', () => {
    const page = render(<AppShell isAdmin onNavigate={() => {}}><p>Workspace</p></AppShell>);
    expect(screen.getAllByRole('button', { name: 'แอดมิน' })).toHaveLength(2);
    page.rerender(<AppShell isAdmin={false} onNavigate={() => {}}><p>Workspace</p></AppShell>);
    expect(screen.queryByRole('button', { name: 'แอดมิน' })).not.toBeInTheDocument();
  });
});


describe('approved patient home', () => {
  it('puts the real clinic photo above the booking entry and overlays the name without a card', () => {
    render(<App />);
    const photo = screen.getByRole('img', { name: 'อาคารสีชมพูของโรงพยาบาลส่งเสริมสุขภาพตำบลบ้านควนไทรงาม' });
    const entry = screen.getByRole('button', { name: 'เริ่มนัดหมาย' });
    expect(photo.compareDocumentPosition(entry) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText('ดูแลรอยยิ้ม')).not.toBeInTheDocument();
    expect(document.querySelector('.clinic-facts')).toBeNull();
    expect(document.querySelector('.clinic-info-card')).toBeNull();
    expect(document.querySelector('.clinic-photo-overlay')).toHaveTextContent('รพ.สต.บ้านควนไทรงาม');
    expect(screen.getByText('รอคลินิกอนุมัติเพื่อยืนยันนัดหมาย')).toBeVisible();
  });
});

describe('measured navigation clearance', () => {
  it('publishes actual navigation height and updates when the viewport changes', () => {
    let height = 87;
    const original = HTMLElement.prototype.getBoundingClientRect;
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('bottom-nav') ? { ...original.call(this), height } : original.call(this);
    });
    try {
      const view = render(<AppShell onNavigate={() => {}}><p>Content</p></AppShell>);
      const shell = view.container.querySelector<HTMLElement>('.app-shell')!;
      expect(shell.style.getPropertyValue('--bottom-nav-height')).toBe('87px');
      height = 138; fireEvent.resize(window);
      expect(shell.style.getPropertyValue('--bottom-nav-height')).toBe('138px');
      height = 0; fireEvent.resize(window);
      expect(shell.style.getPropertyValue('--bottom-nav-height')).toBe('0px');
    } finally { measure.mockRestore(); }
  });
});


describe('compact staging disclosure', () => {
  it('removes the top warning panel and preserves a truthful footer notice', () => {
    render(<AppShell mode="staging" onNavigate={() => {}}><p>Workspace</p></AppShell>);
    expect(document.querySelector('main .test-banner')).toBeNull();
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Staging · ใช้ข้อมูลสมมติเท่านั้น · อย่ากรอกข้อมูลผู้ป่วยจริง');
  });
});
