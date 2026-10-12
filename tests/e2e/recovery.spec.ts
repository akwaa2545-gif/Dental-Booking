import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Browser acceptance for the isolated synthetic demo, not PostgreSQL or live LINE evidence.
// Lost-response + authenticated shell interruption coverage lives in tests/web/recovery.test.tsx;
// PostgreSQL recovery is separately exercised by tests/db/privacy.test.ts.
for (const zoomed of [false, true]) {
  test(`cancel dialog recovery at 320px and ${zoomed ? '200%' : '100%'} text`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.goto('/appointments');
    const approved = page.getByRole('article').filter({ hasText: '✓ อนุมัติแล้ว' });
    await approved.getByRole('button', { name: 'ดูรายละเอียด' }).click();
    const detailUrl = page.url();
    const trigger = page.getByRole('button', { name: 'ยกเลิกนัดหมาย', exact: true });
    await expect(trigger).toBeVisible();
    for (const dismissal of ['escape', 'close', 'back']) {
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: 'ยืนยันยกเลิกคำขอ' });
      const close = dialog.getByRole('button', { name: 'ปิดหน้าต่าง' });
      await expect(close).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(dialog.getByRole('button', { name: 'ยืนยันยกเลิก', exact: true })).toBeFocused();
      await page.keyboard.press('Tab'); await expect(close).toBeFocused();
      if (dismissal === 'escape') await page.keyboard.press('Escape');
      else if (dismissal === 'close') await close.click();
      else await page.goBack();
      await expect(dialog).not.toBeVisible(); await expect(trigger).toBeFocused();
      await expect(page).toHaveURL(detailUrl); await expect(page.getByText('✓ อนุมัติแล้ว', { exact: true })).toBeVisible();
    }
    await trigger.click();
    if (zoomed) await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll<HTMLElement>('body *')).map(element => ({ element, size: parseFloat(getComputedStyle(element).fontSize) }));
      for (const { element, size } of items) element.style.fontSize = `${size * 2}px`;
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await testInfo.attach('synthetic-cancellation-dialog', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    await page.getByRole('button', { name: 'ยืนยันยกเลิก', exact: true }).dblclick();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.getByText('− ยกเลิกแล้ว', { exact: true })).toBeVisible();
    await expect(page.getByText(/วันที่ใหม่จะยังไม่ถูกจองจนส่งคำขอสำเร็จ/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'ยกเลิกนัดหมาย', exact: true })).not.toBeVisible();
    await page.getByRole('button', { name: 'เริ่มคำขอใหม่', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'เลือกบริการที่ต้องการ' })).toBeVisible();
    expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  });
}

test('foreign and nonexistent deep links use the same safe not-found screen', async ({ page }) => {
  await page.goto('/appointments/77777777-7777-4777-8777-777777777777');
  await expect(page.getByRole('heading', { name: 'ไม่พบนัดหมาย', exact: true })).toBeVisible();
  const foreign = await page.locator('.flow-card').innerText();
  await page.goto('/appointments/99999999-9999-4999-8999-999999999999');
  await expect(page.getByRole('heading', { name: 'ไม่พบนัดหมาย', exact: true })).toBeVisible();
  expect(await page.locator('.flow-card').innerText()).toBe(foreign);
  await expect(page.getByText('บัญชีอื่น สมมติ', { exact: true })).not.toBeVisible();
});

test('Bangkok appointment-day cutoff removes cancel and preserves web status', async ({ page }) => {
  await page.goto('/appointments');
  await page.getByRole('article').filter({ hasText: '✓ อนุมัติแล้ว' }).getByRole('button', { name: 'ดูรายละเอียด' }).click();
  await page.getByText(/นาฬิกาสาธิต/).click();
  await page.getByRole('button', { name: 'วันนัด 00:00 · หมดยกเลิก', exact: true }).click();
  await expect(page.getByText(/วันนัดหรือเลยกำหนดยกเลิกแล้ว/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'ยกเลิกนัดหมาย', exact: true })).not.toBeVisible();
  await expect(page.getByText('✓ อนุมัติแล้ว', { exact: true })).toBeVisible();
  await expect(page.getByText(/แม้ไม่ได้รับข้อความ/)).toBeVisible();
});
