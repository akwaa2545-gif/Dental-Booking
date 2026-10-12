import clinicSeal from '../../src/web/assets/clinic-seal.png?inline';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/production';
import type { Session } from '../../src/shared/contracts';
const epoch = new Date('2026-10-08T00:00:00Z');
const now = () => epoch;
const session: Session = { accountId: '10000000-0000-4000-8000-000000000001', csrfToken: 'synthetic-csrf', expiresAt: '2026-10-08T02:00:00Z', isAdmin: false };
const appointment = { id: '30000000-0000-4000-8000-000000000001', reference: 'SYNTHETIC-PRIVATE', patientId: '20000000-0000-4000-8000-000000000001', patient: { fullName: 'PRIVATE SYNTHETIC PERSON', phone: '0990000000', age: 30, address: 'synthetic only', relationship: 'self', authorizationAcknowledged: true }, service: 'oral_check', date: '2026-10-09', status: 'pending', version: 1, createdAt: '2026-10-08T00:00:00Z', approvedAt: null, cancelBefore: '2026-10-08T17:00:00Z' };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function setup(overrides: Partial<Session> = {}) {
  let current = { ...session, ...overrides }; let denied = 0; let logoutDenied = false;
  const sdk = { init: vi.fn().mockResolvedValue(undefined), isLoggedIn: () => true, isInClient: () => false, login: vi.fn(), getIDToken: () => 'synthetic-token', logout: vi.fn(), closeWindow: vi.fn() };
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path === '/api/auth/liff') return response(current);
    if (path === '/api/session') return denied ? response({ error: { code: denied === 401 ? 'UNAUTHENTICATED' : 'UNAVAILABLE' } }, denied) : response(current);
    if (path === '/api/logout') return logoutDenied ? response({ error: { code: 'UNAVAILABLE' } }, 503) : new Response(null, { status: 204 });
    if (path.startsWith('/api/availability')) return response([{ date: '2026-10-09', state: 'available' }]);
    if (path === '/api/patients') return response([]);
    if (path === '/api/appointments' || path === '/api/admin/appointments') return response([appointment]);
    if (path === `/api/appointments/${appointment.id}`) return response(appointment);
    return response({ error: { code: 'NOT_FOUND' } }, 404);
  });
  const props = { config: { liffId: '1234567890-Example', staging: true, origin: 'https://staging.example' }, fetcher, now, loadSdk: async () => sdk };
  return { props, fetcher, sdk, change: (values: Partial<Session>) => { current = { ...current, ...values }; }, deny: (status: number) => { denied = status; }, failLogout: () => { logoutDenied = true; } };
}
afterEach(() => { window.history.replaceState(null, '', '/'); vi.useRealTimers(); });
async function ready() { await screen.findByRole('navigation', { name: 'เมนูหลัก' }); }

describe('clinic-branded LINE entry', () => {
  const clinic = 'ห้องทันตกรรม รพ.สต.บ้านควนไทรงาม';
  it.each(['sdk-load', 'sdk-init', 'token-exchange'] as const)('shows only the branded pending screen while %s is unresolved', async phase => {
    const runtime = setup(); const pending = new Promise<never>(() => {});
    const normalFetch = runtime.fetcher.getMockImplementation()!;
    if (phase === 'sdk-init') runtime.sdk.init.mockReturnValue(pending);
    if (phase === 'token-exchange') runtime.fetcher.mockImplementation(input => String(input) === '/api/auth/liff' ? pending : normalFetch(input));
    window.history.replaceState(null, '', '/booking?liff.state=synthetic-state');
    render(<StrictMode><App {...runtime.props} loadSdk={phase === 'sdk-load' ? () => pending : runtime.props.loadSdk} /></StrictMode>);
    if (phase === 'sdk-init') await waitFor(() => expect(runtime.sdk.init).toHaveBeenCalledOnce());
    if (phase === 'token-exchange') await waitFor(() => expect(runtime.fetcher.mock.calls.some(([path]) => path === '/api/auth/liff')).toBe(true));
    expect(screen.getByRole('heading', { name: clinic })).toBeVisible();
    expect(screen.getByRole('img', { name: `ตราประจำ${clinic}` })).toHaveAttribute('src', clinicSeal);
    expect(screen.getByRole('main')).toHaveClass('auth-screen');
    expect(screen.getByRole('status')).toHaveTextContent('กำลังตรวจสอบความพร้อมของระบบ…');
    expect(screen.getByRole('status').closest('section')).toHaveAttribute('aria-busy', 'true');
    expect(document.querySelector('.auth-spinner')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText(/ระบบทดสอบ Staging/)).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
    expect(window.location.search).toBe('?liff.state=synthetic-state');
  });
  it('keeps the external-browser LINE redirect as a branded pending state without mounting private screens', async () => {
    const runtime = setup(); runtime.sdk.isLoggedIn = () => false;
    render(<StrictMode><App {...runtime.props} /></StrictMode>);
    await screen.findByText('กำลังไปยัง LINE เพื่อเข้าสู่ระบบ…');
    expect(screen.getByRole('heading', { name: clinic })).toBeVisible();
    expect(screen.getByRole('status').closest('section')).toHaveClass('auth-loading');
    expect(document.querySelector('.auth-spinner')).toBeInTheDocument();
    expect(runtime.sdk.login).toHaveBeenCalledExactlyOnceWith({ redirectUri: 'https://staging.example/' });
    expect(runtime.fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/session']);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
  it('shows a branded loader during logout, then replaces it with explicit signed-out recovery', async () => {
    const runtime = setup(); const normalFetch = runtime.fetcher.getMockImplementation()!;
    let finish!: (value: Response) => void;
    runtime.fetcher.mockImplementation(input => String(input) === '/api/logout' ? new Promise<Response>(resolve => { finish = resolve; }) : normalFetch(input));
    window.history.replaceState(null, '', '/appointments');
    render(<App {...runtime.props} />); await screen.findByText('PRIVATE SYNTHETIC PERSON');
    fireEvent.click(screen.getByText('ออกจากระบบ'));
    expect(screen.getByRole('heading', { name: clinic })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('กำลังออกจากระบบ…');
    expect(document.querySelector('.auth-spinner')).toBeInTheDocument();
    expect(screen.queryByText('PRIVATE SYNTHETIC PERSON')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    await act(async () => finish(new Response(null, { status: 204 })));
    expect(screen.getByRole('heading', { name: 'ออกจากระบบแล้ว' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' })).toBeEnabled();
    expect(document.querySelector('.auth-spinner')).not.toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeInTheDocument();
  });
  it('replaces the loader with a branded error and explicit retry when initialization fails', async () => {
    const runtime = setup(); runtime.sdk.init.mockRejectedValue(new Error('PRIVATE_SDK_ERROR'));
    render(<App {...runtime.props} />);
    await screen.findByRole('alert');
    expect(screen.getByRole('heading', { name: clinic })).toBeVisible();
    expect(screen.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' })).toBeEnabled();
    expect(screen.getByText('รหัสตรวจสอบ: A02 · UNAVAILABLE')).toBeVisible();
    expect(document.querySelector('.auth-spinner')).not.toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('PRIVATE_SDK_ERROR');
  });
  it('uses the official clinic name on the contact screen without inventing contact details', async () => {
    const runtime = setup(); render(<App {...runtime.props} />); await ready();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'เมนูหลัก' })).getByRole('button', { name: 'ติดต่อ' }));
    expect(screen.getByText('ห้องทันตกรรม โรงพยาบาลส่งเสริมสุขภาพตำบลบ้านควนไทรงาม อยู่ระหว่างการทดสอบ ยังไม่เปิดรับผู้ป่วยจริง')).toBeVisible();
    expect(screen.getByRole('link', { name: '098-189-2216' })).toHaveAttribute('href', 'tel:0981892216');
    expect(screen.getByText('ที่อยู่และช่องทางติดต่ออื่น: ยังไม่ตั้งค่าช่องทางที่ตรวจสอบแล้ว')).toBeVisible();
  });
});

describe('bounded authentication presentation', () => {
  const timeoutMessage = 'การเชื่อมต่อใช้เวลานานกว่าปกติ';
  it.each(['sdk-load', 'sdk-init', 'token-exchange'] as const)('offers only manual reopening after 20 seconds of %s and admits its late verified result without a concurrent attempt', async phase => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const runtime = setup(); const normalFetch = runtime.fetcher.getMockImplementation()!;
    let finish!: () => void; const pending = new Promise<void>(resolve => { finish = resolve; });
    if (phase === 'sdk-init') runtime.sdk.init.mockReturnValue(pending);
    if (phase === 'token-exchange') runtime.fetcher.mockImplementation(async input => { if (String(input) === '/api/auth/liff') await pending; return normalFetch(input); });
    render(<App {...runtime.props} loadSdk={phase === 'sdk-load' ? async () => { await pending; return runtime.sdk; } : runtime.props.loadSdk} />);
    if (phase === 'sdk-init') await waitFor(() => expect(runtime.sdk.init).toHaveBeenCalledOnce());
    if (phase === 'token-exchange') await waitFor(() => expect(runtime.fetcher.mock.calls.some(([path]) => path === '/api/auth/liff')).toBe(true));
    const requests = runtime.fetcher.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(19900); });
    expect(document.querySelector('.auth-spinner')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByRole('alert')).toHaveTextContent(timeoutMessage);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/ปิดหน้านี้ แล้วเปิดแอปใหม่จาก LINE/)).toBeVisible();
    expect(document.querySelector('.auth-spinner')).not.toBeInTheDocument();
    expect(runtime.fetcher).toHaveBeenCalledTimes(requests);
    expect(runtime.sdk.login).not.toHaveBeenCalled();
    fireEvent.focus(window); fireEvent.popState(window);
    await act(async () => { await vi.advanceTimersByTimeAsync(40000); });
    expect(runtime.fetcher).toHaveBeenCalledTimes(requests);
    expect(runtime.sdk.login).not.toHaveBeenCalled();
    await act(async () => finish()); await ready();
    expect(screen.queryByText(timeoutMessage)).not.toBeInTheDocument();
    expect(runtime.sdk.init).toHaveBeenCalledOnce();
    expect(runtime.fetcher.mock.calls.filter(([path]) => path === '/api/auth/liff')).toHaveLength(1);
  });
  it('replaces a stalled external redirect with explicit recovery instead of repeated provider redirects', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const runtime = setup(); runtime.sdk.isLoggedIn = () => false;
    render(<StrictMode><App {...runtime.props} /></StrictMode>);
    await screen.findByText('กำลังไปยัง LINE เพื่อเข้าสู่ระบบ…');
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(screen.getByRole('alert')).toHaveTextContent(timeoutMessage);
    expect(document.querySelector('.auth-spinner')).not.toBeInTheDocument();
    expect(runtime.sdk.login).toHaveBeenCalledOnce();
    expect(runtime.fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/session']);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/ปิดหน้านี้ แล้วเปิดแอปใหม่จาก LINE/)).toBeVisible();
    fireEvent.focus(window); fireEvent.popState(window);
    await act(async () => { await vi.advanceTimersByTimeAsync(40000); });
    expect(runtime.sdk.login).toHaveBeenCalledOnce();
    expect(runtime.sdk.init).toHaveBeenCalledOnce();
    expect(runtime.fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/session']);
  });
  it.each(['sdk-load', 'sdk-init', 'token-exchange'] as const)('restores normal recovery only after a timed-out %s operation has actually failed', async phase => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const runtime = setup(); const normalFetch = runtime.fetcher.getMockImplementation()!;
    let fail!: (error: Error) => void; const pending = new Promise<never>((_resolve, reject) => { fail = reject; });
    if (phase === 'sdk-init') runtime.sdk.init.mockReturnValue(pending);
    if (phase === 'token-exchange') runtime.fetcher.mockImplementation(input => String(input) === '/api/auth/liff' ? pending : normalFetch(input));
    render(<App {...runtime.props} loadSdk={phase === 'sdk-load' ? () => pending : runtime.props.loadSdk} />);
    if (phase === 'sdk-init') await waitFor(() => expect(runtime.sdk.init).toHaveBeenCalledOnce());
    if (phase === 'token-exchange') await waitFor(() => expect(runtime.fetcher.mock.calls.some(([path]) => path === '/api/auth/liff')).toBe(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    const requests = runtime.fetcher.mock.calls.length;
    await act(async () => fail(new Error('PRIVATE_LATE_FAILURE')));
    expect(screen.getByRole('alert')).toHaveTextContent('เข้าสู่ระบบแอปไม่สำเร็จ โปรดลองเข้าสู่ระบบอีกครั้ง');
    expect(screen.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' })).toBeEnabled();
    expect(runtime.fetcher).toHaveBeenCalledTimes(requests);
    expect(document.body.textContent).not.toContain('PRIVATE_LATE_FAILURE');
  });
  it('clears the watchdog on unmount and keeps a late failed initialization out of the next app', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const old = setup(); let fail!: (error: Error) => void;
    old.sdk.init.mockReturnValue(new Promise<void>((_resolve, reject) => { fail = reject; }));
    const mounted = render(<App {...old.props} />); await waitFor(() => expect(old.sdk.init).toHaveBeenCalledOnce());
    mounted.unmount();
    const current = setup(); render(<App {...current.props} />); await ready();
    await act(async () => { fail(new Error('PRIVATE_OLD_ERROR')); await vi.advanceTimersByTimeAsync(20000); });
    expect(screen.getByText('ออกจากระบบ')).not.toBeVisible();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('PRIVATE_OLD_ERROR');
    expect(old.fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/session']);
  });
  it.each(['session-refresh', 'logout-request'] as const)('prevents a new sign-in while the timed-out logout %s remains unresolved', async phase => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const runtime = setup(); const normalFetch = runtime.fetcher.getMockImplementation()!;
    let finish!: (value: Response) => void; let waiting = false;
    render(<App {...runtime.props} />); await ready();
    runtime.fetcher.mockImplementation(input => {
      if (!waiting && String(input) === (phase === 'session-refresh' ? '/api/session' : '/api/logout')) {
        waiting = true; return new Promise<Response>(resolve => { finish = resolve; });
      }
      return normalFetch(input);
    });
    fireEvent.click(screen.getByText('ออกจากระบบ')); await waitFor(() => expect(finish).toBeTypeOf('function'));
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(screen.getByRole('alert')).toHaveTextContent('ยังยืนยันการออกจากระบบบนเซิร์ฟเวอร์ไม่ได้');
    expect(document.querySelector('.auth-spinner')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/ปิดหน้านี้ แล้วเปิดแอปใหม่จาก LINE/)).toBeVisible();
    const requests = runtime.fetcher.mock.calls.length;
    fireEvent.focus(window); fireEvent.popState(window);
    await act(async () => { await vi.advanceTimersByTimeAsync(40000); });
    expect(runtime.fetcher).toHaveBeenCalledTimes(requests);
    expect(runtime.sdk.logout).not.toHaveBeenCalled();
    await act(async () => finish(phase === 'session-refresh' ? response(session) : new Response(null, { status: 204 })));
    expect(screen.getByRole('heading', { name: 'ออกจากระบบแล้ว' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' })).toBeEnabled();
    expect(runtime.sdk.logout).toHaveBeenCalledOnce();
    expect(runtime.fetcher.mock.calls.filter(([path]) => path === '/api/auth/liff')).toHaveLength(1);
    expect(runtime.fetcher.mock.calls.filter(([path]) => path === '/api/logout')).toHaveLength(1);
  });
});

describe('LIFF synthetic-staging application', () => {
  it('renders actual booking navigation and a staging warning after server verification, with no demo controls', async () => {
    const { props } = setup(); render(<App {...props} />); await ready();
    expect(screen.getByRole('contentinfo')).toHaveTextContent('Staging · ใช้ข้อมูลสมมติเท่านั้น · อย่ากรอกข้อมูลผู้ป่วยจริง');
    expect(screen.queryByRole('region', { name: 'เครื่องมือสาธิต' })).not.toBeInTheDocument(); expect(screen.queryByText('ไม่มีการล็อกอินจริง')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'เริ่มนัดหมาย' })); expect(screen.getByRole('heading', { name: 'เลือกบริการที่ต้องการ' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /ตรวจสุขภาพช่องปาก/ })); await screen.findByRole('heading', { name: 'ข้อมูลผู้รับบริการ' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'ถัดไป' })).toBeEnabled());
  });
  it('does not mount private screens or rewrite LIFF URL parameters before bootstrap resolves', async () => {
    let initialize!: () => void; const pending = new Promise<void>(resolve => { initialize = resolve; }); const { props, sdk, fetcher } = setup(); sdk.init.mockReturnValue(pending);
    window.history.replaceState(null, '', '/booking?liff.state=synthetic-state'); render(<App {...props} />);
    expect(screen.queryByRole('heading', { name: 'เลือกบริการที่ต้องการ' })).not.toBeInTheDocument(); expect(window.location.search).toBe('?liff.state=synthetic-state'); expect(fetcher.mock.calls.every(([path]) => path === '/api/session')).toBe(true);
    await act(async () => initialize()); await screen.findByRole('heading', { name: 'เลือกบริการที่ต้องการ' });
  });
  it('performs only one authentication write under StrictMode', async () => {
    const { props, fetcher } = setup(); render(<StrictMode><App {...props} /></StrictMode>); await ready();
    expect(fetcher.mock.calls.filter(([path]) => path === '/api/auth/liff')).toHaveLength(1);
  });
  it('does not expose an admin link or mount the admin screen for a server-verified nonadmin', async () => {
    window.history.replaceState(null, '', '/admin'); const { props, fetcher } = setup(); render(<App {...props} />); await ready();
    expect(screen.getByText(/ไม่มีสิทธิ์ผู้ดูแล/)).toBeVisible(); expect(screen.queryByRole('button', { name: 'จัดการนัดหมาย' })).not.toBeInTheDocument();
    expect(fetcher.mock.calls.some(([path]) => path === '/api/admin/appointments')).toBe(false);
  });
  it('mounts existing admin screen only with fresh server authority and removes it after grant revocation', async () => {
    window.history.replaceState(null, '', '/admin/queue'); const runtime = setup({ isAdmin: true }); render(<App {...runtime.props} />); await ready(); await screen.findAllByText('PRIVATE SYNTHETIC PERSON');
    runtime.change({ isAdmin: false }); fireEvent.focus(window);
    await screen.findByText(/ไม่มีสิทธิ์ผู้ดูแล/); expect(screen.queryByText('PRIVATE SYNTHETIC PERSON')).not.toBeInTheDocument();
  });
  it.each([401, 503])('clears private screens after denied or unavailable foreground session refresh %s', async status => {
    window.history.replaceState(null, '', '/appointments'); const runtime = setup(); render(<App {...runtime.props} />); await screen.findByText('PRIVATE SYNTHETIC PERSON');
    runtime.deny(status); fireEvent.focus(window); await screen.findByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' }); expect(screen.queryByText('PRIVATE SYNTHETIC PERSON')).not.toBeInTheDocument();
  });
  it('clears all private screens on account switch and does not replay old requests after explicit reauthentication', async () => {
    window.history.replaceState(null, '', '/appointments'); const runtime = setup(); render(<App {...runtime.props} />); await screen.findByText('PRIVATE SYNTHETIC PERSON');
    runtime.change({ accountId: '10000000-0000-4000-8000-000000000002' }); fireEvent.focus(window); await screen.findByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' });
    expect(screen.queryByText('PRIVATE SYNTHETIC PERSON')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' })); await screen.findByRole('heading', { name: 'นัดหมายของฉัน' });
    expect(runtime.fetcher.mock.calls.filter(([path]) => path === '/api/auth/liff')).toHaveLength(2);
    expect(runtime.fetcher.mock.calls.some(([path]) => path === '/api/patients')).toBe(false);
  });
  it('clears private UI when the SDK token changes even if the server cookie still names the prior account', async () => {
    window.history.replaceState(null, '', '/appointments'); const runtime = setup(); render(<App {...runtime.props} />); await screen.findByText('PRIVATE SYNTHETIC PERSON');
    runtime.sdk.getIDToken = () => 'changed-synthetic-token'; fireEvent.focus(window);
    await screen.findByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' }); expect(screen.queryByText('PRIVATE SYNTHETIC PERSON')).not.toBeInTheDocument();
  });
  it('clears private UI if the SDK becomes unreadable during foreground verification', async () => {
    window.history.replaceState(null, '', '/appointments'); const runtime = setup(); render(<App {...runtime.props} />); await screen.findByText('PRIVATE SYNTHETIC PERSON');
    runtime.sdk.isLoggedIn = () => { throw new Error('PRIVATE_PROVIDER_ERROR'); }; fireEvent.focus(window);
    await screen.findByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' }); expect(screen.queryByText('PRIVATE SYNTHETIC PERSON')).not.toBeInTheDocument(); expect(screen.queryByText(/PRIVATE_PROVIDER_ERROR/)).not.toBeInTheDocument();
  });
  it('removes private UI immediately on logout and revokes the server session with fresh CSRF', async () => {
    window.history.replaceState(null, '', '/appointments'); const runtime = setup(); render(<App {...runtime.props} />); await screen.findByText('PRIVATE SYNTHETIC PERSON');
    fireEvent.click(screen.getByText('ออกจากระบบ')); expect(screen.queryByText('PRIVATE SYNTHETIC PERSON')).not.toBeInTheDocument();
    await screen.findByText('ออกจากระบบแล้ว'); expect(runtime.sdk.logout).toHaveBeenCalledOnce();
    expect(runtime.fetcher.mock.calls.filter(([path]) => path === '/api/logout')).toHaveLength(1);
  });
  it('keeps the new session alive when an old private request completes after logout and sign-in', async () => {
    const runtime = setup(); const normalFetch = runtime.fetcher.getMockImplementation()!;
    let finish!: (value: Response) => void; let waiting = false;
    runtime.fetcher.mockImplementation(async input => {
      if (String(input) === '/api/appointments' && !waiting) { waiting = true; return new Promise<Response>(resolve => { finish = resolve; }); }
      return normalFetch(input);
    });
    window.history.replaceState(null, '', '/appointments'); render(<App {...runtime.props} />); await ready(); await waitFor(() => expect(waiting).toBe(true));
    fireEvent.click(screen.getByText('ออกจากระบบ')); await screen.findByText('ออกจากระบบแล้ว');
    fireEvent.click(screen.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' })); await screen.findByText('PRIVATE SYNTHETIC PERSON');
    await act(async () => { finish(response({ error: { code: 'UNAUTHENTICATED' } }, 401)); });
    expect(screen.getByText('ออกจากระบบ')).not.toBeVisible(); expect(screen.getByText('PRIVATE SYNTHETIC PERSON')).toBeVisible();
  });
  it('shows honest server-staging notification copy in appointment details', async () => {
    window.history.replaceState(null, '', `/appointments/${appointment.id}`); const runtime = setup(); render(<App {...runtime.props} />); await screen.findByRole('heading', { name: 'รายละเอียดนัดหมาย' });
    expect(screen.getByText(/ระบบทดสอบนี้ยังไม่ส่งข้อความ LINE/)).toBeVisible(); expect(screen.queryByText(/การแจ้งเตือนในเดโม/)).not.toBeInTheDocument();
  });
  it('states uncertain logout honestly while keeping private data cleared', async () => {
    const runtime = setup(); runtime.failLogout(); render(<App {...runtime.props} />); await ready(); fireEvent.click(screen.getByText('ออกจากระบบ'));
    await screen.findByText(/ยังยืนยันการออกจากระบบบนเซิร์ฟเวอร์ไม่ได้/); expect(screen.queryByRole('button', { name: 'เริ่มนัดหมาย' })).not.toBeInTheDocument();
  });
  it('expires the private boundary even without another network request', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true }); vi.setSystemTime(epoch); const runtime = setup({ expiresAt: '2026-10-08T00:01:00Z' });
    render(<App {...runtime.props} now={() => new Date()} />); await ready();
    expect(screen.getByText('ออกจากระบบ')).not.toBeVisible(); await act(async () => { await vi.advanceTimersByTimeAsync(60001); });
    expect(screen.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' })).toBeVisible(); expect(screen.queryByRole('button', { name: 'เริ่มนัดหมาย' })).not.toBeInTheDocument();
  });
  it('uses browser back and forward without restoring private screens after logout', async () => {
    const runtime = setup(); render(<App {...runtime.props} />); await ready(); fireEvent.click(within(screen.getByRole('navigation', { name: 'เมนูหลัก' })).getByRole('button', { name: 'นัดของฉัน' })); await screen.findByText('PRIVATE SYNTHETIC PERSON');
    window.history.replaceState(null, '', '/contact'); fireEvent.popState(window); expect(screen.getByRole('heading', { name: 'ติดต่อเรา' })).toBeVisible();
    fireEvent.click(screen.getByText('ออกจากระบบ')); await screen.findByText('ออกจากระบบแล้ว'); window.history.replaceState(null, '', '/appointments'); fireEvent.popState(window); expect(screen.queryByText('PRIVATE SYNTHETIC PERSON')).not.toBeInTheDocument();
  });
});


describe('unconfigured staging public shell', () => {
  it('shows public services with disabled booking controls and no SDK or private requests', async () => {
    const runtime = setup(); runtime.deny(503); const loadSdk = vi.fn(runtime.props.loadSdk);
    render(<App {...runtime.props} loadSdk={loadSdk} />);
    await screen.findByRole('heading', { name: 'ระบบทดสอบยังไม่พร้อมใช้งาน' });
    expect(document.querySelector('.auth-spinner')).not.toBeInTheDocument();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'บริการทันตกรรมของเรา' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'เริ่มนัดหมาย' })).toBeDisabled();
    for (const button of within(screen.getByRole('region', { name: 'บริการทันตกรรมของเรา' })).getAllByRole('button')) expect(button).toBeDisabled();
    for (const button of within(screen.getByRole('navigation', { name: 'เมนูหลัก' })).getAllByRole('button')) expect(button).toBeDisabled();
    expect(screen.getByText(/ยังไม่เปิดให้เข้าสู่ระบบ LINE หรือส่งคำขอนัดหมาย/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' })).not.toBeInTheDocument();
    expect(screen.queryByText(/ยังไม่ทราบผล/)).not.toBeInTheDocument(); expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(loadSdk).not.toHaveBeenCalled(); expect(runtime.fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/session']);
  });
  it('checks readiness again only on an explicit action, and still does not load the SDK while blocked', async () => {
    const runtime = setup(); runtime.deny(503); const loadSdk = vi.fn(runtime.props.loadSdk);
    render(<StrictMode><App {...runtime.props} loadSdk={loadSdk} /></StrictMode>);
    fireEvent.click(await screen.findByRole('button', { name: 'ตรวจสอบความพร้อมอีกครั้ง' }));
    await screen.findByRole('button', { name: 'ตรวจสอบความพร้อมอีกครั้ง' });
    expect(runtime.fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/session', '/api/session']); expect(loadSdk).not.toHaveBeenCalled();
  });
});

describe('safe sign-in and lifecycle diagnostics', () => {
  it('shows an app sign-in failure with only a safe auth response diagnostic and waits for explicit retry', async () => {
    const runtime = setup(); const normalFetch = runtime.fetcher.getMockImplementation()!;
    runtime.fetcher.mockImplementation(async input => String(input) === '/api/auth/liff'
      ? response({ error: { code: 'UNAVAILABLE', diagnostic: 'A10', message: 'PRIVATE_CANARY https://private.example/?token=SECRET' } }, 503)
      : normalFetch(input));
    render(<StrictMode><App {...runtime.props} /></StrictMode>);
    await screen.findByText('เข้าสู่ระบบแอปไม่สำเร็จ โปรดลองเข้าสู่ระบบอีกครั้ง');
    expect(screen.getByText('รหัสตรวจสอบ: A06 · HTTP 503 · UNAVAILABLE · A10')).toBeVisible();
    expect(document.body.textContent).not.toMatch(/PRIVATE_CANARY|private\.example|SECRET|ยังไม่ทราบผล/);
    expect(runtime.fetcher.mock.calls.filter(([path]) => path === '/api/auth/liff')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' }));
    await screen.findByText('รหัสตรวจสอบ: A06 · HTTP 503 · UNAVAILABLE · A10');
    expect(runtime.fetcher.mock.calls.filter(([path]) => path === '/api/auth/liff')).toHaveLength(2);
  });
  it('does not label an SDK failure as an HTTP response', async () => {
    const runtime = setup(); runtime.sdk.init.mockRejectedValue(new Error('PRIVATE_CANARY'));
    render(<App {...runtime.props} />);
    expect(await screen.findByText('รหัสตรวจสอบ: A02 · UNAVAILABLE')).toBeVisible();
    expect(document.body.textContent).not.toMatch(/HTTP|PRIVATE_CANARY|ยังไม่ทราบผล/);
  });
  it('reports an auth transport failure without inferring HTTP 503', async () => {
    const runtime = setup(); const normalFetch = runtime.fetcher.getMockImplementation()!;
    runtime.fetcher.mockImplementation(async input => { if (String(input) === '/api/auth/liff') throw new Error('PRIVATE_CANARY'); return normalFetch(input); });
    render(<App {...runtime.props} />);
    expect(await screen.findByText('รหัสตรวจสอบ: A05 · UNAVAILABLE')).toBeVisible();
    expect(document.body.textContent).not.toMatch(/HTTP|PRIVATE_CANARY|ยังไม่ทราบผล/);
  });
  it('does not show auth-only server hints or invented HTTP codes for a foreground transport failure', async () => {
    const runtime = setup(); render(<App {...runtime.props} />); await ready();
    runtime.fetcher.mockRejectedValue(new Error('PRIVATE_CANARY A10'));
    fireEvent.focus(window);
    expect(await screen.findByText('รหัสตรวจสอบ: A08 · UNAVAILABLE')).toBeVisible();
    expect(document.body.textContent).not.toMatch(/HTTP|PRIVATE_CANARY|A10/);
  });
  it('shows no HTTP response for a local foreground token mismatch', async () => {
    const runtime = setup(); render(<App {...runtime.props} />); await ready(); runtime.sdk.getIDToken = () => 'changed-token';
    fireEvent.focus(window);
    expect(await screen.findByText('รหัสตรวจสอบ: A08 · UNAUTHENTICATED')).toBeVisible();
    expect(document.body.textContent).not.toMatch(/HTTP|changed-token/);
  });
  it('labels foreground session refresh failures and clears private data', async () => {
    window.history.replaceState(null, '', '/appointments'); const runtime = setup(); render(<App {...runtime.props} />);
    await screen.findByText('PRIVATE SYNTHETIC PERSON'); runtime.deny(503); fireEvent.focus(window);
    expect(await screen.findByText('รหัสตรวจสอบ: A08 · HTTP 503 · UNAVAILABLE')).toBeVisible();
    expect(screen.queryByText('PRIVATE SYNTHETIC PERSON')).not.toBeInTheDocument();
  });
  it('labels fresh-session failures before private navigation separately from foreground checks', async () => {
    const runtime = setup(); render(<App {...runtime.props} />); await ready(); runtime.deny(503);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'เมนูหลัก' })).getByRole('button', { name: 'นัดของฉัน' }));
    expect(await screen.findByText('รหัสตรวจสอบ: A09 · HTTP 503 · UNAVAILABLE')).toBeVisible();
    expect(runtime.fetcher.mock.calls.some(([path]) => path === '/api/appointments')).toBe(false);
  });
  it('does not let a retired foreground refresh replace the new authenticated generation', async () => {
    const runtime = setup(); const normalFetch = runtime.fetcher.getMockImplementation()!;
    render(<App {...runtime.props} />); await ready();
    let finish!: (value: Response) => void;
    runtime.fetcher.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    fireEvent.focus(window); await waitFor(() => expect(finish).toBeTypeOf('function'));
    runtime.fetcher.mockImplementation(normalFetch);
    fireEvent.click(screen.getByText('ออกจากระบบ')); await screen.findByText('ออกจากระบบแล้ว');
    fireEvent.click(screen.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' })); await ready();
    await act(async () => { finish(response({ error: { code: 'UNAVAILABLE' } }, 503)); });
    expect(screen.getByText('ออกจากระบบ')).not.toBeVisible(); expect(screen.queryByText(/รหัสตรวจสอบ/)).not.toBeInTheDocument();
  });
});


describe('rejected LINE ID-token recovery', () => {
  function rejectedRuntime() {
    const runtime = setup(); const normalFetch = runtime.fetcher.getMockImplementation()!;
    runtime.fetcher.mockImplementation(async input => String(input) === '/api/auth/liff'
      ? response({ error: { code: 'UNAUTHENTICATED', message: 'PRIVATE_REJECTED_TOKEN_CANARY' } }, 401)
      : normalFetch(input));
    return runtime;
  }
  it.each([false, true])('shows manual guidance after a recovery action does not navigate or close within 20 seconds (LIFF client: %s)', async inClient => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const runtime = rejectedRuntime(); runtime.sdk.isInClient = () => inClient;
    render(<App {...runtime.props} />);
    await screen.findByText('รหัสตรวจสอบ: A06 · HTTP 401 · UNAUTHENTICATED');
    const action = screen.getByRole('button', { name: inClient ? 'ปิดหน้าต่าง LIFF' : 'เข้าสู่ระบบอีกครั้ง' });
    fireEvent.click(action); fireEvent.click(action);
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(screen.getByText('ยังเปิดการเข้าสู่ระบบใหม่หรือปิดหน้าต่างไม่ได้ โปรดปิดหน้านี้ด้วยตนเอง')).toBeVisible();
    expect(screen.getByText(/ปิดหน้านี้ แล้วเปิดแอปใหม่จาก LINE/)).toBeVisible();
    expect(screen.queryByText('กำลังไปยัง LINE เพื่อเข้าสู่ระบบใหม่…')).not.toBeInTheDocument();
    expect(action).toBeDisabled();
    fireEvent.click(action); fireEvent.focus(window); fireEvent.popState(window);
    await act(async () => { await vi.advanceTimersByTimeAsync(40000); });
    expect(runtime.sdk.init).toHaveBeenCalledOnce();
    expect(runtime.sdk.closeWindow).toHaveBeenCalledTimes(inClient ? 1 : 0);
    expect(runtime.sdk.login).toHaveBeenCalledTimes(inClient ? 0 : 1);
    expect(runtime.sdk.logout).toHaveBeenCalledTimes(inClient ? 0 : 1);
    expect(runtime.fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/session', '/api/auth/liff']);
  });
  it('uses one explicit external re-login instead of reposting the rejected cached token', async () => {
    const runtime = rejectedRuntime(); render(<StrictMode><App {...runtime.props} /></StrictMode>);
    await screen.findByText('รหัสตรวจสอบ: A06 · HTTP 401 · UNAUTHENTICATED');
    expect(runtime.sdk.logout).not.toHaveBeenCalled(); expect(runtime.sdk.login).not.toHaveBeenCalled();
    const retry = screen.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' });
    fireEvent.click(retry); fireEvent.click(retry);
    await waitFor(() => expect(runtime.sdk.login.mock.calls.length > 0 || screen.queryByText('รหัสตรวจสอบ: A06 · HTTP 401 · UNAUTHENTICATED') !== null).toBe(true));
    expect(runtime.fetcher.mock.calls.filter(([path]) => path === '/api/auth/liff')).toHaveLength(1);
    expect(runtime.sdk.logout).toHaveBeenCalledOnce();
    expect(runtime.sdk.login).toHaveBeenCalledExactlyOnceWith({ redirectUri: 'https://staging.example/' });
    expect(runtime.sdk.logout.mock.invocationCallOrder[0]).toBeLessThan(runtime.sdk.login.mock.invocationCallOrder[0]);
    expect(runtime.sdk.init).toHaveBeenCalledOnce(); expect(runtime.sdk.closeWindow).not.toHaveBeenCalled();
    expect(runtime.fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/session', '/api/auth/liff']);
    expect(screen.getByText(/หลังเข้าสู่ระบบ โปรดตรวจสอบนัดหมายของฉันก่อนส่งคำขอใหม่/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'เริ่มนัดหมาย' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('PRIVATE_REJECTED_TOKEN_CANARY');
  });
  it('explains LIFF reopening and only closes on an explicit action without retrying auth', async () => {
    const runtime = rejectedRuntime(); runtime.sdk.isInClient = () => true;
    render(<StrictMode><App {...runtime.props} /></StrictMode>);
    await screen.findByText('รหัสตรวจสอบ: A06 · HTTP 401 · UNAUTHENTICATED');
    expect(screen.getByText(/ปิดหน้านี้ แล้วเปิดแอปใหม่จาก LINE/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' })).not.toBeInTheDocument();
    expect(runtime.sdk.closeWindow).not.toHaveBeenCalled();
    const close = screen.getByRole('button', { name: 'ปิดหน้าต่าง LIFF' });
    fireEvent.click(close); fireEvent.click(close);
    await act(async () => {});
    expect(runtime.sdk.closeWindow).toHaveBeenCalledOnce(); expect(close).toBeDisabled();
    expect(runtime.sdk.logout).not.toHaveBeenCalled(); expect(runtime.sdk.login).not.toHaveBeenCalled();
    expect(runtime.sdk.init).toHaveBeenCalledOnce();
    expect(runtime.fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/session', '/api/auth/liff']);
  });
  it.each(['logout', 'login', 'closeWindow'] as const)('keeps recovery failure safe and does not reopen bootstrap when %s throws', async action => {
    const runtime = rejectedRuntime(); runtime.sdk.isInClient = () => action === 'closeWindow';
    runtime.sdk[action].mockImplementation(() => { throw new Error('PRIVATE_RECOVERY_CANARY'); });
    render(<App {...runtime.props} />);
    await screen.findByText('รหัสตรวจสอบ: A06 · HTTP 401 · UNAUTHENTICATED');
    const button = screen.getByRole('button', { name: action === 'closeWindow' ? 'ปิดหน้าต่าง LIFF' : 'เข้าสู่ระบบอีกครั้ง' });
    fireEvent.click(button); fireEvent.click(button); await act(async () => {});
    expect(runtime.sdk[action]).toHaveBeenCalledOnce();
    expect(runtime.fetcher.mock.calls.map(([path]) => path)).toEqual(['/api/session', '/api/auth/liff']);
    expect(screen.getByText(/ปิดหน้านี้ แล้วเปิดแอปใหม่จาก LINE/)).toBeVisible();
    expect(screen.getByText('รหัสตรวจสอบ: A06 · HTTP 401 · UNAUTHENTICATED')).toBeVisible();
    expect(document.body.textContent).not.toContain('PRIVATE_RECOVERY_CANARY');
    if (action === 'logout') expect(runtime.sdk.login).not.toHaveBeenCalled();
  });
  it('keeps the private booking draft discarded through rejected-token recovery without any replay', async () => {
    window.history.replaceState(null, '', '/booking');
    const runtime = setup(); render(<App {...runtime.props} />); await ready();
    fireEvent.click(screen.getByRole('button', { name: /ตรวจสุขภาพช่องปาก/ }));
    const name = await screen.findByRole('textbox', { name: 'ชื่อ–นามสกุล *' });
    fireEvent.change(name, { target: { value: 'PRIVATE UNSAVED DRAFT' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'ถัดไป' })).toBeEnabled());
    runtime.deny(401); fireEvent.focus(window);
    await screen.findByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' });
    expect(screen.queryByDisplayValue('PRIVATE UNSAVED DRAFT')).not.toBeInTheDocument();
    const normalFetch = runtime.fetcher.getMockImplementation()!;
    runtime.fetcher.mockImplementation(async input => String(input) === '/api/auth/liff'
      ? response({ error: { code: 'UNAUTHENTICATED' } }, 401) : normalFetch(input));
    fireEvent.click(screen.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' }));
    await screen.findByText('รหัสตรวจสอบ: A06 · HTTP 401 · UNAUTHENTICATED');
    const requestsBeforeRecovery = runtime.fetcher.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' }));
    fireEvent.focus(window); fireEvent.popState(window);
    await act(async () => {});
    expect(runtime.sdk.logout).toHaveBeenCalledOnce(); expect(runtime.sdk.login).toHaveBeenCalledOnce();
    expect(runtime.fetcher).toHaveBeenCalledTimes(requestsBeforeRecovery);
    expect(runtime.fetcher.mock.calls.filter(([path]) => path === '/api/patients')).toHaveLength(1);
    expect(runtime.fetcher.mock.calls.some(([path]) => path === '/api/appointments')).toBe(false);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument(); expect(document.body.textContent).not.toContain('PRIVATE UNSAVED DRAFT');
    expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0);
  });
  it('offers only manual reopening if the SDK cannot determine the browser type', async () => {
    const runtime = rejectedRuntime(); runtime.sdk.isInClient = () => { throw new Error('PRIVATE_BROWSER_CANARY'); };
    render(<App {...runtime.props} />); await screen.findByText('รหัสตรวจสอบ: A06 · HTTP 401 · UNAUTHENTICATED');
    expect(screen.getByText(/ปิดหน้านี้ แล้วเปิดแอปใหม่จาก LINE/)).toBeVisible();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(runtime.sdk.logout).not.toHaveBeenCalled(); expect(runtime.sdk.login).not.toHaveBeenCalled(); expect(runtime.sdk.closeWindow).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('PRIVATE_BROWSER_CANARY');
  });
  it('does not change transport-failure retries into provider re-logins', async () => {
    const runtime = setup(); const normalFetch = runtime.fetcher.getMockImplementation()!;
    runtime.fetcher.mockImplementation(async input => { if (String(input) === '/api/auth/liff') throw new Error('PRIVATE_CANARY'); return normalFetch(input); });
    render(<App {...runtime.props} />); await screen.findByText('รหัสตรวจสอบ: A05 · UNAVAILABLE');
    fireEvent.click(screen.getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' }));
    await screen.findByText('รหัสตรวจสอบ: A05 · UNAVAILABLE');
    expect(runtime.fetcher.mock.calls.filter(([path]) => path === '/api/auth/liff')).toHaveLength(2);
    expect(runtime.sdk.logout).not.toHaveBeenCalled(); expect(runtime.sdk.login).not.toHaveBeenCalled(); expect(runtime.sdk.closeWindow).not.toHaveBeenCalled();
  });
});

it('shows the explicit test control only to the approved staging admin without auto-send',async()=>{
 window.history.replaceState(null,'','/admin/notifications');window.sessionStorage.clear();const runtime=setup({isAdmin:true,accountId:'f0000000-0000-4000-8000-000000000001'});render(<App {...runtime.props}/>);await ready();expect(screen.getByRole('button',{name:'ส่งการแจ้งเตือนทดสอบที่อนุมัติ'})).toBeEnabled();expect(runtime.fetcher.mock.calls.some(([path])=>path==='/api/admin/line/test-approval')).toBe(false);
});
it('does not show the pinned test control for another staging admin',async()=>{
 window.history.replaceState(null,'','/admin/notifications');const runtime=setup({isAdmin:true});render(<App {...runtime.props}/>);await ready();expect(screen.queryByRole('button',{name:'ส่งการแจ้งเตือนทดสอบที่อนุมัติ'})).not.toBeInTheDocument();
});


describe('verified admin workspace navigation', () => {
  const sections = [
    ['/admin', 'ภาพรวม'],
    ['/admin/queue', 'คำขอนัดหมาย'],
    ['/admin/schedule', 'ตารางนัด'],
    ['/admin/intake', 'วันปิด / การรับจอง'],
    ['/admin/notifications', 'ประวัติแจ้งเตือน'],
  ] as const;
  it.each(sections)('rejects a nonadmin direct link to %s without private admin requests', async path => {
    window.history.replaceState(null, '', path);
    const runtime = setup(); render(<App {...runtime.props} />); await ready();
    expect(screen.getByRole('heading', { name: 'ไม่มีสิทธิ์ผู้ดูแล' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'แอดมิน' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'เมนูแอดมิน' })).not.toBeInTheDocument();
    expect(runtime.fetcher.mock.calls.some(([request]) => String(request).startsWith('/api/admin/'))).toBe(false);
  });
  it('keeps admin entries and data absent while server authority is unresolved', async () => {
    window.history.replaceState(null, '', '/admin/queue');
    const runtime = setup({ isAdmin: true });
    const normalFetch = runtime.fetcher.getMockImplementation()!;
    let finish!: (value: Response) => void;
    runtime.fetcher.mockImplementation(input => String(input) === '/api/auth/liff'
      ? new Promise<Response>(resolve => { finish = resolve; }) : normalFetch(input));
    render(<App {...runtime.props} />);
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(screen.queryByRole('button', { name: 'แอดมิน' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'เมนูแอดมิน' })).not.toBeInTheDocument();
    expect(runtime.fetcher.mock.calls.some(([request]) => String(request).startsWith('/api/admin/'))).toBe(false);
    await act(async () => finish(response({ ...session, isAdmin: true })));
    await screen.findByRole('heading', { level: 1, name: 'คำขอนัดหมาย' });
    expect(screen.getAllByRole('button', { name: 'แอดมิน' })).toHaveLength(2);
  });
  it.each(sections)('opens verified deep link %s with the corresponding section selected', async (path, label) => {
    window.history.replaceState(null, '', path);
    const runtime = setup({ isAdmin: true }); render(<App {...runtime.props} />); await ready();
    expect(await screen.findByRole('heading', { level: 1, name: label })).toBeVisible();
    expect(within(screen.getByRole('navigation', { name: 'เมนูแอดมิน' })).getByRole('button', { name: label })).toHaveAttribute('aria-current', 'page');
    for (const navLabel of ['เมนูเดสก์ท็อป', 'เมนูหลัก']) {
      expect(within(screen.getByRole('navigation', { name: navLabel })).getByRole('button', { name: 'แอดมิน' })).toHaveAttribute('aria-current', 'page');
    }
  });
  it('navigates through every admin section and browser history without disturbing patient navigation', async () => {
    const runtime = setup({ isAdmin: true }); render(<App {...runtime.props} />); await ready();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'เมนูหลัก' })).getByRole('button', { name: 'แอดมิน' }));
    await screen.findByRole('heading', { level: 1, name: 'ภาพรวม' });
    expect(window.location.pathname).toBe('/admin');
    for (const [path, label] of sections.slice(1)) {
      fireEvent.click(within(screen.getByRole('navigation', { name: 'เมนูแอดมิน' })).getByRole('button', { name: label }));
      expect(window.location.pathname).toBe(path);
      await screen.findByRole('heading', { level: 1, name: label });
    }
    await act(async () => { window.history.back(); });
    await screen.findByRole('heading', { level: 1, name: 'วันปิด / การรับจอง' });
    expect(window.location.pathname).toBe('/admin/intake');
    await act(async () => { window.history.forward(); });
    await screen.findByRole('heading', { level: 1, name: 'ประวัติแจ้งเตือน' });
    expect(window.location.pathname).toBe('/admin/notifications');
    fireEvent.click(within(screen.getByRole('navigation', { name: 'เมนูหลัก' })).getByRole('button', { name: 'นัดของฉัน' }));
    await screen.findByRole('heading', { level: 1, name: 'นัดหมายของฉัน' });
    expect(window.location.pathname).toBe('/appointments');
  });
  it('preserves the selected date and queue filters between admin sections and history transitions', async () => {
    window.history.replaceState(null, '', '/admin/queue');
    const runtime = setup({ isAdmin: true }); render(<App {...runtime.props} />);
    await screen.findByText('PRIVATE SYNTHETIC PERSON');
    fireEvent.change(screen.getByLabelText('วันที่นัด'), { target: { value: '2026-10-12' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'สถานะคำขอ' }), { target: { value: 'approved' } });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'เมนูแอดมิน' })).getByRole('button', { name: 'วันปิด / การรับจอง' }));
    expect(screen.getByLabelText('วันที่นัด')).toHaveValue('2026-10-12');
    await act(async () => { window.history.back(); });
    await screen.findByRole('heading', { level: 1, name: 'คำขอนัดหมาย' });
    expect(screen.getByLabelText('วันที่นัด')).toHaveValue('2026-10-12');
    expect(screen.getByRole('combobox', { name: 'สถานะคำขอ' })).toHaveValue('approved');
    expect(runtime.fetcher.mock.calls.filter(([request]) => request === '/api/admin/appointments')).toHaveLength(1);
  });
  it('removes shell entries, section navigation and an open private decision when server authority is revoked', async () => {
    window.history.replaceState(null, '', '/admin/queue');
    const runtime = setup({ isAdmin: true }); render(<App {...runtime.props} />);
    await screen.findByText('PRIVATE SYNTHETIC PERSON');
    fireEvent.click(screen.getByRole('button', { name: 'พิจารณาคำขอ' }));
    expect(screen.getByRole('dialog')).toBeVisible();
    runtime.change({ isAdmin: false }); fireEvent.focus(window);
    await screen.findByRole('heading', { name: 'ไม่มีสิทธิ์ผู้ดูแล' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText('PRIVATE SYNTHETIC PERSON')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'แอดมิน' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'เมนูแอดมิน' })).not.toBeInTheDocument();
    const requests = runtime.fetcher.mock.calls.length;
    window.history.replaceState(null, '', '/admin/schedule'); fireEvent.popState(window);
    expect(screen.getByRole('heading', { name: 'ไม่มีสิทธิ์ผู้ดูแล' })).toBeVisible();
    expect(runtime.fetcher).toHaveBeenCalledTimes(requests);
  });
  it('honors backend 403 and clears the verified shell until explicit auth recovery', async () => {
    window.history.replaceState(null, '', '/admin/queue');
    const runtime = setup({ isAdmin: true });
    const normalFetch = runtime.fetcher.getMockImplementation()!;
    runtime.fetcher.mockImplementation(input => String(input) === '/api/admin/appointments'
      ? Promise.resolve(response({ error: { code: 'FORBIDDEN' } }, 403)) : normalFetch(input));
    render(<App {...runtime.props} />);
    await screen.findByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' });
    expect(screen.queryByRole('button', { name: 'แอดมิน' })).not.toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'เมนูแอดมิน' })).not.toBeInTheDocument();
    expect(screen.queryByText('PRIVATE SYNTHETIC PERSON')).not.toBeInTheDocument();
    expect(runtime.fetcher.mock.calls.filter(([request]) => request === '/api/admin/appointments')).toHaveLength(1);
  });
  it('keeps the approved notification control confined to notifications with no automatic send', async () => {
    window.history.replaceState(null, '', '/admin');
    window.sessionStorage.clear();
    const runtime = setup({ isAdmin: true, accountId: 'f0000000-0000-4000-8000-000000000001' });
    render(<App {...runtime.props} />); await ready();
    const label = 'ส่งการแจ้งเตือนทดสอบที่อนุมัติ';
    expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'เมนูแอดมิน' })).getByRole('button', { name: 'ประวัติแจ้งเตือน' }));
    expect(await screen.findByRole('button', { name: label })).toBeEnabled();
    expect(runtime.fetcher.mock.calls.some(([request]) => request === '/api/admin/line/test-approval')).toBe(false);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'เมนูแอดมิน' })).getByRole('button', { name: 'คำขอนัดหมาย' }));
    expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
  });
});


describe('approved session control visibility', () => {
  it.each([false, true])('does not expose logout for verified admin=%s', async isAdmin => {
    const runtime = setup({ isAdmin }); render(<App {...runtime.props} />);
    await ready();
    expect(screen.queryByRole('region', { name: 'บัญชีที่ตรวจสอบแล้ว' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'ออกจากระบบ' })).not.toBeInTheDocument();
  });
});

describe('user-provided clinic contact', () => {
  it('shows the supplied clinic number and an exact dial link without inventing an address', async () => {
    window.history.replaceState(null, '', '/contact');
    const runtime = setup(); render(<App {...runtime.props} />); await ready();
    expect(screen.getByRole('link', { name: '098-189-2216' })).toHaveAttribute('href', 'tel:0981892216');
    expect(screen.queryByText(/โทรศัพท์ ที่อยู่ และช่องทางติดต่อคลินิก: ยังไม่ตั้งค่า/)).not.toBeInTheDocument();
    expect(screen.getByText('ที่อยู่และช่องทางติดต่ออื่น: ยังไม่ตั้งค่าช่องทางที่ตรวจสอบแล้ว')).toBeVisible();
  });
});
