import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createDemoApi } from '../../src/demo/api';
import { createDemoClock } from '../../src/demo/clock';
import { BookingFlow } from '../../src/web/booking/BookingFlow';
import { SERVICES, SERVICE_LABELS } from '../../src/web/copy.th';
import scalingImage from '../../src/web/assets/service-scaling.webp?inline';
import fillingImage from '../../src/web/assets/service-filling.webp?inline';
import oralCheckImage from '../../src/web/assets/service-oral-check.webp?inline';

const images = { scaling: scalingImage, filling: fillingImage, oral_check: oralCheckImage };
const makeApi = () => createDemoApi({ now: createDemoClock().now });

describe('service selection banner copy', () => {
  it('shows only the service name on each original service image', async () => {
    await act(async () => { render(<BookingFlow api={makeApi()} onSubmitted={() => {}} />); });

    const banners = screen.getAllByRole('button');
    expect(banners).toHaveLength(SERVICES.length);
    SERVICES.forEach((service, index) => {
      const banner = banners[index]!;
      expect(banner.textContent).toBe(SERVICE_LABELS[service]);
      expect(banner).toHaveAccessibleName(SERVICE_LABELS[service]);
      expect(banner).toHaveAttribute('data-service', service);
      expect(banner.querySelector('img')).toHaveAttribute('src', images[service]);
      expect(banner.querySelector('img')).toHaveAttribute('alt', '');
    });
    expect(screen.getByText('เลือกเพียงหนึ่งบริการต่อคำขอ')).toBeVisible();
  });

  it.each(SERVICES)('keeps %s selection connected to the patient step and review', async service => {
    const user = userEvent.setup();
    render(<BookingFlow api={makeApi()} onSubmitted={() => {}} />);
    await user.click(screen.getByRole('button', { name: SERVICE_LABELS[service] }));
    expect(screen.getByRole('heading', { name: 'ข้อมูลผู้รับบริการ' })).toBeVisible();
    await screen.findByDisplayValue('คุณยิ้ม ทดลอง');
    await user.click(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }));
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    await user.click(await screen.findByRole('button', { name: /^2026-10-08 ว่าง/ }));
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    expect(screen.getByRole('heading', { name: 'ตรวจสอบคำขอนัดหมาย' })).toBeVisible();
    expect(screen.getByText(SERVICE_LABELS[service])).toBeVisible();
    expect(screen.getByText('การส่งคำขอยังไม่ใช่การยืนยัน ต้องรอคลินิกอนุมัติ')).toBeVisible();
    expect(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' })).toBeEnabled();
  });
});
