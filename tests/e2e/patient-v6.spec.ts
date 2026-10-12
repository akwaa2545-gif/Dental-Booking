import { expect, test } from '@playwright/test';

// Authored coverage for the approved visual port. Not executed in the restricted
// October 10 executor: existing browser/socket denials must not be retried.
for (const width of [320, 375, 768, 1280]) {
  test(`approved home and review dock at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    const cta = page.getByRole('button', { name: 'เริ่มนัดหมาย', exact: true });
    const photo = page.getByRole('img', { name: 'อาคารสีชมพูของโรงพยาบาลส่งเสริมสุขภาพตำบลบ้านควนไทรงาม' });
    expect((await cta.boundingBox())!.height).toBeGreaterThanOrEqual(64);
    expect((await photo.boundingBox())!.y).toBeLessThan((await cta.boundingBox())!.y);
    await cta.click();
    await expect(page.locator('.service-banner')).toHaveCount(3);
    await page.getByRole('button', { name: /ขูดหินปูน/ }).click();
    await expect(page.getByLabel('ชื่อ–นามสกุล *')).toHaveValue('คุณยิ้ม ทดลอง');
    await page.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }).check();
    await page.getByRole('button', { name: 'ถัดไป', exact: true }).click();
    await page.getByRole('button', { name: /^2026-10-14 ว่าง/ }).click();
    await page.getByRole('button', { name: 'ถัดไป', exact: true }).click();
    await expect(page.getByRole('button', { name: 'ส่งคำขอนัดหมาย', exact: true })).toHaveCount(1);
    const dock = page.locator('.review-submit-dock');
    await expect(dock).toHaveCSS('position', 'fixed');
    const navBox = await page.getByRole('navigation', { name: 'เมนูหลัก', exact: true }).boundingBox();
    const dockBox = (await dock.boundingBox())!;
    expect(dockBox.y + dockBox.height).toBeLessThanOrEqual(navBox?.y ?? 900);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole('navigation', { name: width <= 950 ? 'เมนูหลัก' : 'เมนูเดสก์ท็อป', exact: true }).getByRole('button', { name: 'ติดต่อ', exact: false }).click();
    await expect(dock).toBeHidden();
  });
}
