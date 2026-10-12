import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/production';
import { readInvitationContext } from '../../src/web/invitations/context';
import type { OwnClaim, Page } from '../../src/shared/admin-management';
const token = 'a'.repeat(43), key = 'toothtalk.admin-invitation.v1';
const now = () => new Date('2026-10-10T10:00:00Z');
const initialSession = { accountId: '10000000-0000-4000-8000-000000000001', csrfToken: 'synthetic', isAdmin: false, expiresAt: '2026-10-10T12:00:00Z' };
const claim: OwnClaim = { invitation: { id: '20000000-0000-4000-8000-000000000001', label: 'Synthetic colleague', reason: null, state: 'claimed', version: 2,
  expiresAt: '2026-10-11T10:00:00Z', createdAt: '2026-10-10T10:00:00Z', claimedAt: '2026-10-10T10:01:00Z', claimReference: 'AC-12345678', canClose: false }, verificationCode: '01234567' };
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function setup() {
  let session = { ...initialSession }; let mine: Page<OwnClaim> = { items: [], nextCursor: null };
  const sdk = { init: vi.fn().mockResolvedValue(undefined), isLoggedIn: () => true, isInClient: () => false, login: vi.fn(), logout: vi.fn(), closeWindow: vi.fn(), getIDToken: () => 'synthetic-id-token' };
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === '/api/session' || path === '/api/auth/liff') return response(session);
    if (path === '/api/admin-invitations/mine') return response(mine);
    if (path === '/api/admin-invitations/claim') return response(claim);
    if (path === '/api/logout') return new Response(null, { status: 204 });
    if (path.startsWith('/api/admin/')) return response([]);
    return response({ error: { code: 'NOT_FOUND' } }, 404);
  });
  return { sdk, fetcher, props: { config: { liffId: '12345-abc', staging: true, origin: 'https://staging.example' }, now, fetcher, loadSdk: async () => sdk },
    approve() { mine = { items: [{ invitation: { ...claim.invitation, state: 'approved' }, verificationCode: null }], nextCursor: null }; session = { ...session, isAdmin: true }; },
    historicalApproval() { mine = { items: [{ invitation: { ...claim.invitation, state: 'approved' }, verificationCode: null }], nextCursor: null }; },
    emptyOwnClaims() { mine = { items: [], nextCursor: null }; },
    switchAccount() { session = { ...session, accountId: '10000000-0000-4000-8000-000000000002' }; } };
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now()); sessionStorage.clear(); window.history.replaceState(null, '', `/admin-invitation#invite=${token}`); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); sessionStorage.clear(); window.history.replaceState(null, '', '/'); });
describe('verified invitation production routing', () => {
  it('renders the dedicated verified route and enables admin navigation only after a fresh server session', async () => {
    const runtime = setup(); render(<App {...runtime.props} />);
    expect(await screen.findByRole('heading', { level: 1, name: 'คำเชิญผู้ดูแล' })).toBeVisible();
    expect(window.location.hash).toBe(''); expect(screen.queryByRole('button', { name: 'แอดมิน' })).not.toBeInTheDocument();
    expect(runtime.fetcher.mock.calls.some(([path]) => path === '/api/admin-invitations/claim')).toBe(false);
    await waitFor(() => expect(screen.getByRole('button', { name: 'รับคำเชิญด้วยบัญชีนี้' })).toBeEnabled()); fireEvent.click(screen.getByRole('button', { name: 'รับคำเชิญด้วยบัญชีนี้' })); expect(await screen.findByText('01234567')).toBeVisible();
    runtime.approve(); fireEvent.click(screen.getByRole('button', { name: 'ตรวจสอบสถานะอีกครั้ง' }));
    expect(await screen.findByText('คำเชิญนี้ได้รับการอนุมัติแล้ว')).toBeVisible();
    expect(await within(screen.getByRole('navigation', { name: 'เมนูหลัก' })).findByRole('button', { name: 'แอดมิน' })).toBeVisible(); expect(screen.queryByText('01234567')).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/admin-invitation');
  });
  it('does not restore authority from a historical approved invitation when the current grant is revoked', async () => {
    const runtime = setup(); runtime.historicalApproval(); render(<App {...runtime.props} />);
    expect(await screen.findByText('คำเชิญนี้ได้รับการอนุมัติแล้ว')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'แอดมิน' })).not.toBeInTheDocument();
    expect(runtime.fetcher.mock.calls.some(([path]) => path === '/api/admin-invitations/claim')).toBe(false);
  });
  it('clears invitation context and code at logout before a delayed logout returns', async () => {
    const runtime = setup(); let finish!: (response: Response) => void; const normal = runtime.fetcher.getMockImplementation()!;
    runtime.fetcher.mockImplementation(input => String(input) === '/api/logout' ? new Promise<Response>(resolve => { finish = resolve; }) : normal(input));
    render(<App {...runtime.props} />); await waitFor(() => expect(screen.getByRole('button', { name: 'รับคำเชิญด้วยบัญชีนี้' })).toBeEnabled()); fireEvent.click(screen.getByRole('button', { name: 'รับคำเชิญด้วยบัญชีนี้' })); await screen.findByText('01234567');
    sessionStorage.setItem(key, JSON.stringify({ token, capturedAt: now().toISOString() })); fireEvent.click(screen.getByText('ออกจากระบบ'));
    expect(sessionStorage.getItem(key)).toBeNull(); expect(screen.queryByText('01234567')).not.toBeInTheDocument();
    await waitFor(() => expect(finish).toBeTypeOf('function')); await act(async () => finish(new Response(null, { status: 204 })));
  });
  it('discards a successful claim receipt that arrives only after logout has hidden the page', async () => {
    const runtime = setup(); let finish!: (response: Response) => void; const normal = runtime.fetcher.getMockImplementation()!;
    runtime.fetcher.mockImplementation(input => String(input) === '/api/admin-invitations/claim' ? new Promise<Response>(resolve => { finish = resolve; }) : normal(input));
    render(<App {...runtime.props} />); await waitFor(() => expect(screen.getByRole('button', { name: 'รับคำเชิญด้วยบัญชีนี้' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'รับคำเชิญด้วยบัญชีนี้' })); await waitFor(() => expect(finish).toBeTypeOf('function'));
    fireEvent.click(screen.getByText('ออกจากระบบ')); expect(sessionStorage.getItem(key)).toBeNull();
    await act(async () => finish(response(claim))); expect(screen.queryByText('01234567')).not.toBeInTheDocument();
    await screen.findByRole('heading', { name: 'ออกจากระบบแล้ว' });
  });
  it('does not let a retired approved-session refresh clear a new invitation after logout/relogin', async () => {
    const runtime = setup(); render(<App {...runtime.props} />); await screen.findByRole('button', { name: 'รับคำเชิญด้วยบัญชีนี้' });
    runtime.historicalApproval(); const normal = runtime.fetcher.getMockImplementation()!;
    let finish!: (value: Response) => void; let reads = 0;
    runtime.fetcher.mockImplementation(input => {
      if (String(input) === '/api/session' && ++reads === 2) return new Promise<Response>(resolve => { finish = resolve; });
      return normal(input);
    });
    fireEvent.click(screen.getByRole('button', { name: 'ตรวจสอบสถานะอีกครั้ง' })); await waitFor(() => expect(finish).toBeTypeOf('function'));
    fireEvent.click(screen.getByText('ออกจากระบบ')); await screen.findByRole('heading', { name: 'ออกจากระบบแล้ว' });
    runtime.emptyOwnClaims(); const second = 'b'.repeat(43); window.history.replaceState(null, '', `/admin-invitation#invite=${second}`);
    fireEvent.click(screen.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' })); await screen.findByRole('button', { name: 'รับคำเชิญด้วยบัญชีนี้' });
    expect(readInvitationContext(sessionStorage, now())?.token).toBe(second);
    await act(async () => finish(response(initialSession)));
    expect(readInvitationContext(sessionStorage, now())?.token).toBe(second);
    expect(screen.getByRole('button', { name: 'รับคำเชิญด้วยบัญชีนี้' })).toBeEnabled();
    expect(runtime.fetcher.mock.calls.some(([path]) => path === '/api/admin-invitations/claim')).toBe(false);
  });
  it('cleans its own deferred provider fragment after cancelling login while preserving liff parameters', async () => {
    window.history.replaceState(null, '', `/admin-invitation?liff.state=synthetic&liff.referrer=LINE#invite=${token}`);
    const original = window.location.href; const runtime = setup(); let finish!: () => void;
    runtime.sdk.init.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; })); runtime.sdk.isLoggedIn = () => false;
    render(<App {...runtime.props} />); await waitFor(() => expect(runtime.sdk.init).toHaveBeenCalled()); expect(window.location.href).toBe(original);
    fireEvent.click(screen.getByRole('button', { name: 'ยกเลิกการรับคำเชิญ' })); await act(async () => finish());
    expect(window.location.hash).toBe(''); expect(window.location.search).toBe('?liff.state=synthetic&liff.referrer=LINE');
    expect(sessionStorage.getItem(key)).toBeNull(); expect(runtime.sdk.login).not.toHaveBeenCalled();
    expect(runtime.fetcher.mock.calls.some(([path]) => path === '/api/auth/liff' || path === '/api/admin-invitations/claim')).toBe(false);
  });
  it('clears context when a different server account invalidates the verified lifetime', async () => {
    const runtime = setup(); render(<App {...runtime.props} />); await screen.findByRole('heading', { level: 1, name: 'คำเชิญผู้ดูแล' });
    runtime.switchAccount(); fireEvent.focus(window); await screen.findByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' });
    expect(sessionStorage.getItem(key)).toBeNull(); expect(screen.queryByRole('heading', { name: 'คำเชิญผู้ดูแล' })).not.toBeInTheDocument();
  });
  it('can cancel invitation login without a late SDK init redirect or claim', async () => {
    const runtime = setup(); let finish!: () => void;
    runtime.sdk.init.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; })); runtime.sdk.isLoggedIn = () => false;
    render(<App {...runtime.props} />); await waitFor(() => expect(runtime.sdk.init).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'ยกเลิกการรับคำเชิญ' })); expect(sessionStorage.getItem(key)).toBeNull();
    await act(async () => finish()); expect(runtime.sdk.login).not.toHaveBeenCalled();
    expect(runtime.fetcher.mock.calls.some(([path]) => path === '/api/admin-invitations/claim')).toBe(false);
    expect(screen.getByText(/เปิดลิงก์คำเชิญเดิมอีกครั้ง/)).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'ออกจากระบบแล้ว' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'ยกเลิกการรับคำเชิญบนหน้านี้แล้ว' })).toBeVisible();
  });
  it('preserves the exact invitation route through explicit auth recovery instead of the appointments fallback', async () => {
    const runtime = setup(); runtime.sdk.init.mockRejectedValueOnce(new Error('synthetic failure'));
    render(<App {...runtime.props} />); fireEvent.click(await screen.findByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'คำเชิญผู้ดูแล' })).toBeVisible(); expect(window.location.pathname).toBe('/admin-invitation');
    expect(screen.queryByRole('heading', { name: 'นัดหมายของฉัน' })).not.toBeInTheDocument();
  });
  it('reopening the route after back navigation recovers only a fresh account-bound GET', async () => {
    const runtime = setup(); render(<App {...runtime.props} />); await screen.findByRole('heading', { level: 1, name: 'คำเชิญผู้ดูแล' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'เมนูหลัก' })).getByRole('button', { name: 'หน้าหลัก' }));
    window.history.replaceState(null, '', '/admin-invitation'); fireEvent.popState(window);
    expect(await screen.findByRole('heading', { level: 1, name: 'คำเชิญผู้ดูแล' })).toBeVisible();
    expect(runtime.fetcher.mock.calls.some(([path]) => path === '/api/admin-invitations/claim')).toBe(false);
  });
});
