import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/production';
const now = () => new Date('2026-10-10T10:00:00Z');
const session = { accountId: '10000000-0000-4000-8000-000000000001', csrfToken: 'synthetic', isAdmin: true, expiresAt: '2026-10-10T12:00:00Z' };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const invitation = { id: '20000000-0000-4000-8000-000000000001', label: 'เพื่อนร่วมงานสมมติ', reason: null, state: 'claimed', version: 2, expiresAt: '2026-10-11T10:00:00Z', createdAt: now().toISOString(), claimedAt: now().toISOString(), claimReference: 'AC-DEMO', canClose: false };
function runtime() {
  const sdk = { init: vi.fn().mockResolvedValue(undefined), isLoggedIn: () => true, isInClient: () => false, login: vi.fn(), logout: vi.fn(), closeWindow: vi.fn(), getIDToken: () => 'synthetic-id-token' };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if (path === '/api/session' || path === '/api/auth/liff') return response(session);
    if (path === '/api/logout') return new Response(null, { status: 204 });
    if (path.endsWith('/capabilities')) return response({ canRevokeAdmins: false });
    if (path.endsWith('/invitations') && !init?.body) return response({ items: [invitation], nextCursor: null });
    if (path.startsWith('/api/admin/management/')) return response({ items: [], nextCursor: null });
    return response([], 200);
  });
  return { fetcher, props: { config: { liffId: '12345-abc', staging: true, origin: 'https://staging.example' }, now, fetcher, loadSdk: async () => sdk } };
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now()); window.history.replaceState(null, '', '/admin/administrators'); sessionStorage.clear(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });
describe('production management routing and private lifetime', () => {
  it('loads the exact management route using the verified API without unrelated patient reads', async () => {
    const app = runtime(); render(<App {...app.props} />); expect(await screen.findByRole('heading', { name: 'จัดการผู้ดูแล' })).toBeVisible(); await screen.findByText('เพื่อนร่วมงานสมมติ');
    expect(app.fetcher.mock.calls.some(([path]) => String(path).includes('/appointments') || String(path).includes('/patients') || String(path).includes('/availability'))).toBe(false);
    expect(within(screen.getByRole('navigation', { name: 'เมนูแอดมิน' })).getByRole('button', { name: 'จัดการผู้ดูแล' })).toHaveAttribute('aria-current', 'page');
  });
  it.each(['logout', 'navigation', 'back'] as const)('discards a late create receipt after %s', async mode => {
    const app = runtime(); const normal = app.fetcher.getMockImplementation()!; let finish!: (result: Response) => void;
    app.fetcher.mockImplementation((path, init) => String(path).endsWith('/api/admin/management/invitations') && init?.method === 'POST' ? new Promise<Response>(resolve => { finish = resolve; }) : normal(path, init));
    render(<App {...app.props} />); await screen.findByText('เพื่อนร่วมงานสมมติ'); fireEvent.click(screen.getByRole('button', { name: 'เชิญผู้ดูแลเพิ่ม' })); fireEvent.change(screen.getByLabelText('ชื่อเรียกผู้รับคำเชิญ'), { target: { value: 'new colleague' } }); fireEvent.click(screen.getByRole('button', { name: 'สร้างคำเชิญ' })); await waitFor(() => expect(finish).toBeTypeOf('function'));
    if (mode === 'logout') fireEvent.click(screen.getByText('ออกจากระบบ'));
    else if (mode === 'navigation') fireEvent.click(within(screen.getByRole('navigation', { name: 'เมนูหลัก' })).getByRole('button', { name: 'หน้าหลัก' }));
    else { window.history.replaceState(null, '', '/'); fireEvent.popState(window); }
    await act(async () => finish(response({ created: true, invitation: { ...invitation, state: 'issued' }, invitationUrl: `https://staging.example/admin-invitation#invite=${'a'.repeat(43)}` }, 201)));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(document.body.textContent).not.toContain('a'.repeat(43)); expect(screen.queryByRole('heading', { name: 'จัดการผู้ดูแล' })).not.toBeInTheDocument();
  });
  it('hides management data when the live grant is denied by the server', async () => {
    const app = runtime(); render(<App {...app.props} />); await screen.findByText('เพื่อนร่วมงานสมมติ'); const normal = app.fetcher.getMockImplementation()!;
    app.fetcher.mockImplementation((path, init) => String(path).startsWith('/api/admin/management/') ? Promise.resolve(response({ error: { code: 'FORBIDDEN' } }, 403)) : normal(path, init));
    fireEvent.click(screen.getByRole('button', { name: 'ตรวจสอบสถานะล่าสุด' })); await screen.findByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' }); expect(screen.queryByText('เพื่อนร่วมงานสมมติ')).not.toBeInTheDocument(); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
