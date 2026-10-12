import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Browser evidence for the isolated synthetic UI only; no real database or LINE calls.
async function textZoom(page: Page, zoomed: boolean) {
  await page.evaluate(zoom => {
    const elements = Array.from(document.querySelectorAll<HTMLElement>('body *'));
    for (const element of elements) {
      const original = element.dataset.bookingOriginalSize;
      if (original !== undefined) {
        element.style.fontSize = original;
        delete element.dataset.bookingOriginalSize;
      }
    }
    if (zoom) {
      const sizes = elements.map(element => ({ element, size: parseFloat(getComputedStyle(element).fontSize) }));
      for (const { element, size } of sizes) {
        element.dataset.bookingOriginalSize = element.style.fontSize;
        element.style.fontSize = `${size * 2}px`;
      }
    }
  }, zoomed);
}
async function checkLayout(page: Page, buttonName: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const button = page.getByRole('button', { name: buttonName, exact: true });
  await button.evaluate(element => element.scrollIntoView({ block: 'center' }));
  const box = await button.boundingBox();
  const nav = await page.getByRole('navigation', { name: 'เมนูหลัก', exact: true }).boundingBox();
  expect(box).not.toBeNull(); expect(nav).not.toBeNull();
  expect(box!.y + box!.height).toBeLessThanOrEqual(nav!.y);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}

for (const zoomed of [false, true]) {
  test(`family request at 320px and ${zoomed ? '200%' : '100%'} text keeps keyboard focus and controls clear of navigation`, async ({ page, baseURL }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 900 });
    const external: string[] = []; const apiRequests: string[] = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== new URL(baseURL!).origin) external.push(url.origin);
      if (url.pathname.startsWith('/api/')) apiRequests.push(url.pathname);
    });
    await page.goto('/booking');
    await expect(page.getByRole('heading', { name: 'เลือกบริการที่ต้องการ' })).toBeFocused();
    await page.getByRole('button', { name: /อุดฟัน/ }).focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'ข้อมูลผู้รับบริการ' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('combobox', { name: 'ผู้รับบริการสมมติ' })).toBeFocused();
    await page.getByRole('combobox', { name: 'ผู้รับบริการสมมติ' }).selectOption('new');
    await page.getByLabel('ชื่อ–นามสกุล *').fill('<script>synthetic()</script>');
    await page.getByLabel('เบอร์โทรศัพท์ *').fill('0990000000');
    await page.getByLabel('อายุ (ปี) *').fill('18');
    await page.getByLabel('ที่อยู่บ้าน *').fill('ที่อยู่สมมติสำหรับทดสอบเท่านั้น');
    await page.getByLabel('ความสัมพันธ์ *').selectOption('family');
    await page.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }).check();
    await textZoom(page, zoomed); await checkLayout(page, 'ถัดไป'); await textZoom(page, false);
    await page.getByRole('button', { name: 'ย้อนกลับ', exact: true }).click();
    await page.getByRole('button', { name: /ขูดหินปูน/ }).click();
    await expect(page.getByLabel('ชื่อ–นามสกุล *')).toHaveValue('<script>synthetic()</script>');
    await expect(page.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ })).not.toBeChecked();
    await page.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }).focus(); await page.keyboard.press('Space');
    await page.getByRole('button', { name: 'ถัดไป', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'เลือกวันนัดหมาย' })).toBeFocused();
    await expect(page.getByRole('button', { name: /^2026-10-09 เต็ม/, exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: /^2026-10-09 เต็ม/, exact: true })).toHaveCSS('color', 'rgb(162, 36, 54)');
    for (const label of ['2026-10-12 ปิดรับนัด', '2026-10-13 หยุดรับคำขอ', '2026-10-07 นอกช่วงนัด']) {
      await expect(page.getByRole('button', { name: new RegExp(`^${label}`), exact: true })).toBeDisabled();
    }
    await page.getByRole('button', { name: /^2026-10-14 ว่าง/, exact: true }).focus(); await page.keyboard.press('Enter');
    await textZoom(page, zoomed); await checkLayout(page, 'ถัดไป'); await textZoom(page, false);
    await page.getByRole('button', { name: 'ถัดไป', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'ตรวจสอบคำขอนัดหมาย' })).toBeFocused();
    await expect(page.getByText('<script>synthetic()</script>', { exact: true })).toBeVisible();
    await expect(page.getByText('ขูดหินปูน', { exact: true })).toBeVisible();
    await expect(page.getByText('08:30–09:30 น. · Asia/Bangkok', { exact: true })).toBeVisible();
    await expect(page.getByText(/ก่อน 00:00 น. ของวันนัด/)).toBeVisible();
    await expect(page.getByText(/ติดต่อคลินิก: ยังไม่ตั้งค่าช่องทางที่ตรวจสอบแล้ว/)).toBeVisible();
    await textZoom(page, zoomed); await checkLayout(page, 'ส่งคำขอนัดหมาย');
    await testInfo.attach('synthetic-booking-review', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    await page.getByRole('button', { name: 'ส่งคำขอนัดหมาย', exact: true }).focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'ส่งคำขอแล้ว รอการอนุมัติ' })).toBeVisible();
    expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
    expect(external).toEqual([]); expect(apiRequests).toEqual([]);
  });
}
