import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Authored acceptance checks. Chromium execution is blocked in this executor;
// listing/typechecking these tests is not E2E evidence. Use only an approved runtime.
async function startRequest(page: Page, date = '2026-10-08') {
  await page.getByRole('button', { name: 'เริ่มนัดหมาย', exact: true }).click();
  await page.getByRole('button', { name: /ตรวจสุขภาพช่องปาก/ }).click();
  await expect(page.getByLabel('ชื่อ–นามสกุล *')).toHaveValue('คุณยิ้ม ทดลอง');
  await page.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }).check();
  await page.getByRole('button', { name: 'ถัดไป', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(`^${date} ว่าง`), exact: true }).click();
  await page.getByRole('button', { name: 'ถัดไป', exact: true }).click();
}
async function ownApprovedCard(page: Page) {
  const card = page.getByRole('article').filter({ has: page.getByText('คุณใจดี สมมติ', { exact: true }) });
  await expect(card).toBeVisible(); return card;
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}

test('patient → admin → approval stays fictional and makes no outbound data request', async ({ page, baseURL }) => {
  const outbound: string[] = []; const apiCalls: string[] = [];
  const origin = new URL(baseURL!).origin;
  page.on('request', request => {
    if (new URL(request.url()).origin !== origin) outbound.push(request.url());
    if (new URL(request.url()).pathname.startsWith('/api/')) apiCalls.push(request.url());
  });
  await page.goto('/'); await expect(page).toHaveTitle('ToothTalk Booking Demo');
  await expect(page.getByText('ข้อมูลสมมติสำหรับสาธิตเท่านั้น', { exact: true })).toBeVisible();
  await startRequest(page);
  await expect(page.getByText('08:30–09:30 น. · Asia/Bangkok', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'ส่งคำขอนัดหมาย', exact: true }).dblclick();
  await expect(page.getByRole('heading', { name: 'ส่งคำขอแล้ว รอการอนุมัติ' })).toBeVisible();
  const deepLink = new URL(page.url()).pathname;
  await page.getByRole('button', { name: 'ผู้ดูแลจำลอง', exact: true }).click();
  const newRequest = page.getByRole('article').filter({ has: page.getByText('คุณยิ้ม ทดลอง', { exact: true }) });
  await newRequest.getByRole('button', { name: 'พิจารณาคำขอ' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'อนุมัติคำขอ', exact: true }).click();
  await page.getByRole('button', { name: 'ผู้รับบริการจำลอง', exact: true }).click();
  await expect(page.getByText('✓ อนุมัติแล้ว', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'ส่งคำขอแล้ว รอการอนุมัติ' })).toHaveCount(0);
  await expect(page.getByText('ตัวอย่างการแจ้งเตือน: คำขอนัดหมายได้รับการอนุมัติ ดูสถานะล่าสุดในเว็บไซต์', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  expect(outbound).toEqual([]); expect(apiCalls).toEqual([]);
  await page.reload(); await expect(page.getByRole('heading', { name: 'ไม่พบนัดหมาย' })).toBeVisible();
  await page.goto(deepLink); await expect(page.getByRole('heading', { name: 'ไม่พบนัดหมาย' })).toBeVisible();
});

test('family calendar distinguishes unavailable dates and review requires all fields', async ({ page }) => {
  await page.goto('/booking'); await page.getByRole('button', { name: /ขูดหินปูน/ }).click();
  await page.getByRole('combobox', { name: 'ผู้รับบริการสมมติ' }).selectOption('33333333-3333-4333-8333-333333333333');
  await expect(page.getByLabel('ชื่อ–นามสกุล *')).toHaveValue('คุณอุ่นใจ สมมติ');
  await page.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }).check();
  await page.getByRole('button', { name: 'ถัดไป', exact: true }).click();
  for (const label of ['2026-10-09 เต็ม', '2026-10-12 ปิดรับนัด', '2026-10-13 หยุดรับคำขอ', '2026-10-10 ปิดรับนัด']) await expect(page.getByRole('button', { name: new RegExp(`^${label}`), exact: true })).toBeDisabled();
  await page.getByRole('button', { name: /^2026-10-14 ว่าง/, exact: true }).click();
  await page.getByRole('button', { name: 'ถัดไป', exact: true }).click();
  await expect(page.getByText('คุณอุ่นใจ สมมติ', { exact: true })).toBeVisible(); await expect(page.getByText('65 ปี', { exact: true })).toBeVisible();
  await expect(page.getByText('ขูดหินปูน', { exact: true })).toBeVisible();
});

test('cancel supports keyboard focus, Escape, Back/Forward, and reset', async ({ page }) => {
  await page.goto('/appointments'); const card = await ownApprovedCard(page);
  await card.getByRole('button', { name: 'ดูรายละเอียด' }).click();
  const opener = page.getByRole('button', { name: 'ยกเลิกนัดหมาย', exact: true });
  await opener.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(opener).toBeFocused();
  await opener.click(); await page.goBack(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goForward(); await expect(page.getByText('✓ อนุมัติแล้ว', { exact: true })).toBeVisible();
  await opener.click(); await page.getByRole('dialog').getByRole('button', { name: 'ยืนยันยกเลิก', exact: true }).dblclick();
  await expect(page.getByText('− ยกเลิกแล้ว', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'เริ่มเดโมใหม่', exact: true }).click();
  await expect(page.getByRole('button', { name: 'เริ่มนัดหมาย', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'ผู้รับบริการจำลอง', exact: true }).click();
  await expect((await ownApprovedCard(page)).getByText('✓ อนุมัติแล้ว', { exact: true })).toBeVisible();
});

test('clock uses Bangkok 18:00 reminders and midnight cutoff', async ({ page }) => {
  await page.goto('/appointments'); await page.getByText(/นาฬิกาสาธิต ·/).click();
  await page.getByRole('button', { name: 'วันก่อนนัด 18:00 · จำลองเตือน', exact: true }).click();
  await expect(page.getByText('ตัวอย่างการแจ้งเตือน: คุณมีนัดหมายวันพรุ่งนี้ ดูรายละเอียดล่าสุดในเว็บไซต์', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'วันก่อนนัด 18:00 · จำลองเตือน', exact: true }).click();
  await expect(page.getByText('ตัวอย่างการแจ้งเตือน: คุณมีนัดหมายวันพรุ่งนี้ ดูรายละเอียดล่าสุดในเว็บไซต์', { exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'วันนัด 00:00 · หมดยกเลิก', exact: true }).click();
  await (await ownApprovedCard(page)).getByRole('button', { name: 'ดูรายละเอียด' }).click();
  await expect(page.getByText(/วันนัดหรือเลยกำหนดยกเลิกแล้ว/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'ยกเลิกนัดหมาย', exact: true })).toHaveCount(0);
});

for (const id of ['77777777-7777-4777-8777-777777777777', 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee']) {
  test(`opaque direct load ${id} stays missing`, async ({ page }) => {
    await page.goto(`/appointments/${id}`); await expect(page.getByRole('heading', { name: 'ไม่พบนัดหมาย' })).toBeVisible();
    await expect(page.getByText('บัญชีอื่น สมมติ', { exact: true })).toHaveCount(0);
  });
}

for (const width of [320, 375, 768, 1280]) {
  test(`Thai layouts ${width}px have usable targets, semantic access, 200% text and no overflow`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 }); await page.goto('/'); await noOverflow(page);
    await page.screenshot({ path: `artifacts/screenshots/${testInfo.project.name}-${width}-home.png`, fullPage: true });
    await startRequest(page); await noOverflow(page);
    await page.getByRole('button', { name: 'ย้อนกลับ', exact: true }).click();
    const sizes = await page.locator('.calendar-day:not([disabled])').evaluateAll(buttons => buttons.map(button => ({ width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })));
    expect(sizes.length).toBeGreaterThan(0);
    for (const size of sizes) { expect(size.width).toBeGreaterThanOrEqual(24); expect(size.height).toBeGreaterThanOrEqual(44); }
    await expect(page.getByRole('button', { name: 'รายเดือน', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'รายการ', exact: true }).click();
    for (const button of await page.locator('.calendar-day:not([disabled])').all()) {
      const bounds = await button.boundingBox();
      expect(bounds?.width).toBeGreaterThanOrEqual(44);
      expect(bounds?.height).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole('button', { name: 'รายเดือน', exact: true }).click();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: `artifacts/screenshots/${testInfo.project.name}-${width}-calendar.png`, fullPage: true });
    // Text-only zoom approximates browser 200% text enlargement. Real browser/page zoom remains a separate manual check.
    await page.evaluate(() => { const sizes = Array.from(document.querySelectorAll<HTMLElement>('body *'), element => ({ element, size: parseFloat(getComputedStyle(element).fontSize) })); for (const { element, size } of sizes) element.style.fontSize = `${size * 2}px`;  });
    await noOverflow(page);
    await page.goto('/'); await page.getByRole('button', { name: 'ผู้ดูแลจำลอง', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'ผู้ดูแลจำลอง', exact: true })).toBeVisible(); await noOverflow(page);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: `artifacts/screenshots/${testInfo.project.name}-${width}-admin.png`, fullPage: true });
  });
}

test('valid unbroken fictional name wraps in history and admin at 320px', async ({ page }, testInfo) => {
  const name = 'A'.repeat(120);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.goto('/booking');
  await page.getByRole('button', { name: /อุดฟัน/ }).click();
  await page.getByRole('combobox', { name: 'ผู้รับบริการสมมติ' }).selectOption('new');
  await page.getByLabel('ชื่อ–นามสกุล *').fill(name);
  await page.getByLabel('เบอร์โทรศัพท์ *').fill('0990000000');
  await page.getByLabel('อายุ (ปี) *').fill('32');
  await page.getByLabel('ที่อยู่บ้าน *').fill('ที่อยู่สมมติสำหรับทดสอบการตัดบรรทัด');
  await page.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }).check();
  await page.getByRole('button', { name: 'ถัดไป', exact: true }).click();
  await page.getByRole('button', { name: /^2026-10-08 ว่าง/, exact: true }).click();
  await page.getByRole('button', { name: 'ถัดไป', exact: true }).click();
  await page.getByRole('button', { name: 'ส่งคำขอนัดหมาย', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ส่งคำขอแล้ว รอการอนุมัติ' })).toBeVisible();
  await page.getByRole('navigation', { name: 'เมนูหลัก', exact: true }).getByRole('button', { name: 'นัดของฉัน', exact: true }).click();
  const patientHeading = page.getByRole('heading', { name, exact: true });
  await expect(patientHeading).toHaveText(name); await expect(patientHeading).toHaveCSS('overflow-wrap', 'anywhere');
  expect(await patientHeading.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await noOverflow(page);
  await page.screenshot({ path: `artifacts/screenshots/${testInfo.project.name}-320-long-name-history.png`, fullPage: true });
  await page.getByRole('button', { name: 'ผู้ดูแลจำลอง', exact: true }).click();
  const adminHeading = page.getByRole('heading', { name, exact: true });
  await expect(adminHeading).toHaveText(name); await expect(adminHeading).toHaveCSS('overflow-wrap', 'anywhere');
  expect(await adminHeading.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await noOverflow(page);
  await page.screenshot({ path: `artifacts/screenshots/${testInfo.project.name}-320-long-name-admin.png`, fullPage: true });
});
