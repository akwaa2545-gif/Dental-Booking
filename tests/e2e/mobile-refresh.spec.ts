import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Authored acceptance checks only until an authorized browser executes them.
async function enlargeText(page: Page) {
  await page.evaluate(() => {
    const values = Array.from(document.querySelectorAll<HTMLElement>('body *:not([data-text-enlarged])')).map(element => ({ element, size: parseFloat(getComputedStyle(element).fontSize) }));
    for (const { element, size } of values) {
      element.style.fontSize = `${size * 2}px`;
      element.dataset.textEnlarged = 'true';
    }
  });
}
for (const width of [320, 375, 390, 430]) {
  for (const scale of [1, 2]) {
    test(`clinic mobile home ${width}px / ${scale * 100}% text`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/');
      const seal = page.getByRole('img', { name: 'ตราโรงพยาบาลส่งเสริมสุขภาพตำบลบ้านควนไทรงาม' });
      await expect(seal).toBeVisible();
      expect(await seal.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      if (scale === 2) await enlargeText(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      const tabs = page.getByRole('navigation', { name: 'เมนูหลัก' }).getByRole('button');
      await expect(tabs).toHaveCount(4);
      for (const tab of await tabs.all()) {
        const bounds = await tab.boundingBox();
        expect(bounds?.height).toBeGreaterThanOrEqual(44);
        expect(bounds?.width).toBeGreaterThanOrEqual(44);
      }
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await testInfo.attach('clinic-mobile-home', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
      await page.getByRole('button', { name: 'เริ่มนัดหมาย', exact: true }).click();
      await page.getByRole('button', { name: /ตรวจสุขภาพช่องปาก/ }).click();
      await page.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }).check();
      await page.getByRole('button', { name: 'ถัดไป', exact: true }).click();
      const full = page.getByRole('button', { name: /^2026-10-09 เต็ม/, exact: true });
      await expect(full).toBeDisabled();
      if (scale === 2) await enlargeText(page);
      const calendar = page.getByRole('region', { name: 'ปฏิทินเลือกวันนัด' });
      await expect(calendar).toHaveAttribute('data-view', 'month');
      await expect(full.locator('.day-number')).toBeVisible();
      await expect(full.locator('.compact-date')).toBeHidden();
      await expect(calendar.locator('.weekday-label')).toHaveCount(7);
      const columns = await calendar.locator('.calendar-grid').evaluate(element => getComputedStyle(element).gridTemplateColumns.split(' '));
      expect(columns).toHaveLength(7);
      for (const cell of await calendar.locator('.calendar-day').all()) {
        const bounds = await cell.boundingBox();
        expect(bounds?.width).toBeGreaterThanOrEqual(24);
        expect(bounds?.height).toBeGreaterThanOrEqual(44);
        const number = await cell.locator('.day-number').evaluate(element => {
          const range = document.createRange();
          range.selectNodeContents(element);
          const rects = Array.from(range.getClientRects());
          const button = element.closest('button')!.getBoundingClientRect();
          return { lines: rects.length, fits: rects.every(rect => rect.left >= button.left && rect.right <= button.right) };
        });
        expect(number.lines).toBe(1);
        expect(number.fits).toBe(true);
      }
      await calendar.getByRole('button', { name: 'รายการ', exact: true }).click();
      await expect(full.locator('.compact-date')).toBeVisible();
      await expect(full.locator('.compact-date')).toContainText('ศุกร์');
      await expect(full.locator('.day-number')).toBeHidden();
      const listBounds = await full.boundingBox();
      expect(listBounds?.width).toBeGreaterThanOrEqual(44);
      expect(listBounds?.height).toBeGreaterThanOrEqual(44);
      await calendar.getByRole('button', { name: 'รายเดือน', exact: true }).click();
      await expect(full.locator('.day-number')).toBeVisible();
      await expect(full).toHaveCSS('color', 'rgb(162, 36, 54)');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await testInfo.attach('clinic-mobile-month', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
      await calendar.getByRole('button', { name: /^2026-10-08 ว่าง/ }).click();
      await expect(calendar.getByRole('status')).toContainText('8 ตุลาคม');
      await page.getByRole('button', { name: 'ถัดไป', exact: true }).click();
      if (scale === 2) await enlargeText(page);
      for (const name of ['รายละเอียดนัดหมาย', 'ข้อมูลผู้รับบริการ', 'เงื่อนไขและความเป็นส่วนตัว']) {
        await expect(page.getByRole('region', { name })).toBeVisible();
      }
      const submit = page.getByRole('button', { name: 'ส่งคำขอนัดหมาย', exact: true });
      await submit.scrollIntoViewIfNeeded();
      const submitBounds = await submit.boundingBox();
      const navBounds = await page.getByRole('navigation', { name: 'เมนูหลัก' }).boundingBox();
      expect(submitBounds!.y + submitBounds!.height).toBeLessThanOrEqual(navBounds!.y);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await testInfo.attach('clinic-mobile-review', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
      await page.goto('/');
      await page.getByRole('button', { name: 'ผู้ดูแลจำลอง', exact: true }).click();
      await expect(page.getByRole('region', { name: 'ตัวกรองคำขอ' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'สรุปวันที่เลือก' })).toBeVisible();
      await expect(page.getByRole('region', { name: 'รายการคำขอนัดหมาย' })).toBeVisible();
      if (scale === 2) await enlargeText(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      await testInfo.attach('clinic-mobile-admin', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    });
  }
}
