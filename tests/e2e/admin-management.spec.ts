import { expect, test, type Page, type Route } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { OwnClaim } from '../../src/shared/admin-management';

// Only localhost. Production components use a synthetic SDK and intercepted API;
// demo tests use the actual isolated demo. Neither establishes live LINE OAuth.
const token = 'x'.repeat(43), code = '08372615', subject = 'U_SYNTHETIC_PRIVATE_SUBJECT';
const account = '10000000-0000-4000-8000-000000000001';
const other = '10000000-0000-4000-8000-000000000002';
const id = '20000000-0000-4000-8000-000000000001';
const key = 'toothtalk.admin-invitation.v1';
function claimed(expiresAt = new Date(Date.now() + 3600000).toISOString()): OwnClaim {
  return { invitation: { id, label: 'Synthetic browser colleague', reason: null, state: 'claimed', version: 2, expiresAt, createdAt: new Date().toISOString(), claimedAt: new Date().toISOString(), claimReference: 'I-SYNTHETIC-BROWSER', canClose: false }, verificationCode: code };
}
async function production(page: Page, options: { admin?: boolean; loggedIn?: boolean; holdInit?: boolean } = {}) {
  // Stop any unexpected third-party request before transmission.
  await page.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.fallback() : route.abort('blockedbyclient'));
  await page.addInitScript(value => { window.adminBrowserFixture = value; }, { loggedIn: options.loggedIn, holdInit: options.holdInit });
  await page.route('**/src/web/main.tsx', route => route.fulfill({ contentType: 'text/javascript', body: "import '/tests/support/admin-management-browser.tsx';" }));
  const state = { accountId: account, isAdmin: !!options.admin, claims: [] as ReturnType<typeof claimed>[], postClaims: 0, heldClaim: null as Route | null, holdClaim: false };
  const requests: string[] = [], logs: string[] = [], external: string[] = [];
  page.on('console', entry => logs.push(entry.text()));
  page.on('pageerror', error => logs.push(error.message));
  page.on('request', request => { requests.push(request.url()); if (!['127.0.0.1', 'localhost'].includes(new URL(request.url()).hostname)) external.push(request.url()); });
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    const reply = (json: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(json) });
    if (path === '/api/session' || path === '/api/auth/liff') return reply({ accountId: state.accountId, isAdmin: state.isAdmin, csrfToken: 'synthetic-browser-csrf', expiresAt: new Date(Date.now() + 3600000).toISOString() });
    if (path === '/api/logout') return route.fulfill({ status: 204 });
    if (path === '/api/admin-invitations/mine') return reply({ items: state.accountId === account ? state.claims : [], nextCursor: null });
    if (path === '/api/admin-invitations/claim') {
      expect(route.request().method()).toBe('POST'); expect(route.request().postDataJSON()).toEqual({ token }); state.postClaims++;
      if (state.holdClaim) { state.heldClaim = route; return; }
      state.claims = [claimed()]; return reply(state.claims[0]);
    }
    if (path.endsWith('/capabilities')) return reply({ canRevokeAdmins: false });
    if (path.endsWith('/invitations')) return reply({ items: [claimed().invitation], nextCursor: null });
    if (path.startsWith('/api/admin/management/')) return reply({ items: [], nextCursor: null });
    return reply([]);
  });
  return { state, requests, logs, external };
}
async function safeSurface(page: Page, logs: string[], requests: string[]) {
  for (const canary of [token, subject]) expect(await page.locator('body').innerText()).not.toContain(canary);
  for (const canary of [token, code, subject]) { expect(page.url()).not.toContain(canary); expect(JSON.stringify(logs)).not.toContain(canary); expect(JSON.stringify(requests)).not.toContain(canary); }
}

test.beforeEach(async ({ baseURL }) => { expect(['127.0.0.1', 'localhost']).toContain(new URL(baseURL!).hostname); });

test('direct recipient reload removes its own fragment, never GET-claims, and recovers only after explicit acceptance', async ({ page }) => {
  const h = await production(page);
  await page.goto(`/admin-invitation#invite=${token}`);
  await expect(page.getByRole('button', { name: 'รับคำเชิญด้วยบัญชีนี้', exact: true })).toBeEnabled();
  expect(new URL(page.url()).hash).toBe(''); expect(h.state.postClaims).toBe(0);
  await page.reload(); await expect(page.getByRole('button', { name: 'รับคำเชิญด้วยบัญชีนี้', exact: true })).toBeEnabled(); expect(h.state.postClaims).toBe(0);
  await page.getByRole('button', { name: 'รับคำเชิญด้วยบัญชีนี้', exact: true }).dblclick();
  await expect(page.locator('.invitation-verification-code')).toHaveText(code); expect(h.state.postClaims).toBe(1);
  expect(await page.evaluate(key => sessionStorage.getItem(key), key)).toBeNull();
  await page.reload(); await expect(page.locator('.invitation-verification-code')).toHaveText(code); expect(h.state.postClaims).toBe(1);
  await safeSurface(page, h.logs, h.requests); expect(h.external).toEqual([]);
});

for (const dismiss of ['cancel', 'navigation', 'account-switch', 'logout'] as const) {
  test(`late successful claim cannot publish code after ${dismiss}`, async ({ page }) => {
    const h = await production(page); h.state.holdClaim = true;
    await page.goto(`/admin-invitation#invite=${token}`);
    await page.getByRole('button', { name: 'รับคำเชิญด้วยบัญชีนี้', exact: true }).click();
    await expect.poll(() => h.state.heldClaim !== null).toBe(true);
    if (dismiss === 'cancel') await page.getByRole('button', { name: 'ยกเลิกการรับคำเชิญ', exact: true }).click();
    else if (dismiss === 'navigation') await page.getByRole('navigation', { name: 'เมนูหลัก', exact: true }).getByRole('button', { name: 'หน้าหลัก', exact: true }).click();
    else if (dismiss === 'account-switch') {
      h.state.accountId = other;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง', exact: true })).toBeVisible();
    } else {
      // The current production shell intentionally hides its logout control.
      // Invoke that existing control without presenting it as reachable UI.
      await page.getByRole('button', { name: 'ออกจากระบบ', includeHidden: true, exact: true }).evaluate(button => (button as HTMLButtonElement).click());
      await expect(page.getByRole('heading', { name: 'ออกจากระบบแล้ว' })).toBeVisible();
    }
    await h.state.heldClaim!.fulfill({ contentType: 'application/json', body: JSON.stringify(claimed()) });
    await page.waitForTimeout(100);
    await expect(page.locator('.invitation-verification-code')).toHaveCount(0);
    expect(await page.locator('body').innerText()).not.toContain(code); expect(h.state.postClaims).toBe(1);
    if (dismiss !== 'navigation') expect(await page.evaluate(key => sessionStorage.getItem(key), key)).toBeNull();
    await safeSurface(page, h.logs, h.requests); expect(h.external).toEqual([]);
  });
}

test('code disappears at the original expiry and approved history never becomes fresh admin authority', async ({ page }) => {
  await page.clock.install(); const h = await production(page);
  h.state.claims = [claimed(new Date(Date.now() + 60000).toISOString())];
  await page.goto('/admin-invitation'); await expect(page.locator('.invitation-verification-code')).toHaveText(code);
  await page.clock.runFor(61000); await expect(page.locator('.invitation-verification-code')).toHaveCount(0);
  await expect(page.getByText('คำเชิญหมดอายุแล้ว', { exact: true })).toBeVisible();
  h.state.claims = [{ invitation: { ...claimed().invitation, state: 'approved' }, verificationCode: null }];
  await page.getByRole('button', { name: 'ตรวจสอบสถานะอีกครั้ง', exact: true }).click();
  await expect(page.getByText('คำเชิญนี้ได้รับการอนุมัติแล้ว', { exact: true })).toBeVisible();
  await page.goto('/admin/administrators'); await expect(page.getByRole('heading', { name: 'ไม่มีสิทธิ์ผู้ดูแล' })).toBeVisible();
});

test('login return is exact and token-free, preserving a provider fragment until SDK initialization', async ({ page }) => {
  const h = await production(page, { loggedIn: false, holdInit: true });
  const providerFragment = '#access_token=synthetic-provider-placeholder&token_type=Bearer';
  await page.goto('/admin-invitation?liff.state=%2Fadmin-invitation' + providerFragment);
  await expect.poll(() => page.evaluate(() => !!window.adminBrowserFixture.releaseInit)).toBe(true);
  expect(await page.evaluate(() => location.hash)).toBe(providerFragment);
  expect(await page.evaluate(() => window.adminBrowserFixture.initUrl)).toBe(page.url());
  await page.evaluate(() => window.adminBrowserFixture.releaseInit!());
  await expect.poll(() => page.evaluate(() => window.adminBrowserFixture.returnUrl)).toBe('https://synthetic-browser.example/admin-invitation');
  expect(h.state.postClaims).toBe(0); expect(await page.evaluate(key => sessionStorage.getItem(key), key)).toBeNull(); expect(h.external).toEqual([]);
});

test('interrupted direct-link login keeps only a safe return route and cancellation clears the pending bearer', async ({ page }) => {
  const h = await production(page, { loggedIn: false, holdInit: true });
  await page.goto(`/admin-invitation#invite=${token}`);
  await expect.poll(() => page.evaluate(() => !!window.adminBrowserFixture.releaseInit)).toBe(true);
  expect(await page.evaluate(() => window.adminBrowserFixture.initUrl)).not.toContain(token);
  expect(new URL(page.url()).hash).toBe('');
  await page.evaluate(() => window.adminBrowserFixture.releaseInit!());
  await expect.poll(() => page.evaluate(() => window.adminBrowserFixture.returnUrl)).toBe('https://synthetic-browser.example/admin-invitation');
  await page.getByRole('button', { name: 'ยกเลิกการรับคำเชิญ', exact: true }).click();
  expect(await page.evaluate(key => sessionStorage.getItem(key), key)).toBeNull();
  expect(h.state.postClaims).toBe(0); await safeSurface(page, h.logs, h.requests); expect(h.external).toEqual([]);
});

test('direct management reload uses the real shell and respects false capability without patient reads or code', async ({ page }) => {
  const h = await production(page, { admin: true });
  await page.goto('/admin/administrators'); await expect(page.getByRole('heading', { name: 'จัดการผู้ดูแล', exact: true })).toBeVisible();
  await expect(page.getByText('Synthetic browser colleague', { exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByText('Synthetic browser colleague', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'ถอนสิทธิ์', exact: true })).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain(code);
  expect(h.requests.some(url => /\/api\/(appointments|patients|availability)/.test(url))).toBe(false);
  await safeSurface(page, h.logs, h.requests); expect(h.external).toEqual([]);
});

test('synthetic manager approval needs a fresh consequence confirmation and isolates the recipient code', async ({ page }, testInfo) => {
  await page.goto('/'); await page.getByRole('button', { name: 'ผู้ดูแลจำลอง', exact: true }).click();
  await page.getByRole('button', { name: 'จัดการผู้ดูแลจำลอง', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'จัดการผู้ดูแล', exact: true })).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain('01234567');
  await expect(page.getByRole('button', { name: 'ถอนสิทธิ์', exact: true })).toHaveCount(0);
  const trigger = page.getByRole('button', { name: 'ตรวจรหัสและอนุมัติ', exact: true });
  await trigger.click(); await expect(page.getByRole('dialog').getByRole('button', { name: 'ปิดหน้าต่าง', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  await trigger.click(); await page.getByLabel('รหัส 8 หลักจากผู้รับ', { exact: true }).fill('01234567'); await page.getByRole('button', { name: 'ตรวจสอบและยืนยัน', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'ยืนยันให้สิทธิ์ผู้ดูแล', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await testInfo.attach('synthetic-admin-approval-confirmation', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  await page.getByRole('button', { name: 'ยืนยันให้สิทธิ์ผู้ดูแล', exact: true }).dblclick();
  await expect(page.getByRole('region', { name: 'ผู้ดูแลปัจจุบัน', exact: true }).getByText('AD-DEMO-B', { exact: true })).toBeVisible();
  await page.getByText(/นาฬิกาสาธิต ·/).click(); await page.getByRole('button', { name: 'ลองบัญชี B สมมติ', exact: true }).click();
  await page.getByRole('button', { name: 'คำเชิญผู้ดูแลจำลอง', exact: true }).click();
  await expect(page.getByText('ให้สิทธิ์แล้ว', { exact: true })).toBeVisible(); expect(await page.locator('body').innerText()).not.toContain('01234567');
  await page.getByRole('button', { name: 'จัดการผู้ดูแลจำลอง', exact: true }).click();
  await expect(page.getByRole('button', { name: 'เชิญผู้ดูแลเพิ่ม', exact: true })).toBeEnabled(); await expect(page.getByRole('button', { name: 'ถอนสิทธิ์', exact: true })).toHaveCount(0);
});

test('local HTTP demo creates metadata but cannot copy a fresh HTTPS-only link', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: 'ผู้ดูแลจำลอง', exact: true }).click();
  await page.getByRole('button', { name: 'จัดการผู้ดูแลจำลอง', exact: true }).click();
  await page.getByRole('button', { name: 'เชิญผู้ดูแลเพิ่ม', exact: true }).click();
  await page.getByLabel('ชื่อเรียกผู้รับคำเชิญ', { exact: true }).fill('Local synthetic colleague');
  await page.getByRole('button', { name: 'สร้างคำเชิญ', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'คำเชิญที่สร้าง', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'คัดลอกลิงก์คำเชิญ', exact: true })).toHaveCount(0);
  await expect(page.getByText(/หากใช้เดโมบน HTTP จะคัดลอกลิงก์ไม่ได้/)).toBeVisible();
  expect(await page.locator('body').innerText()).not.toContain('#invite=');
  await page.getByRole('button', { name: 'ปิดหน้าต่าง', exact: true }).click();
  await expect(page.getByRole('region', { name: 'รายการคำเชิญ', exact: true }).getByText('Local synthetic colleague', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
});
