import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnClaim, Page } from '../../src/shared/admin-management';
import type { ApiClient } from '../../src/web/api';
import { ApiRequestError, claimAdminInvitation, listOwnAdminClaims } from '../../src/web/api';
import { InvitationPage } from '../../src/web/invitations/InvitationPage';

const token = 'a'.repeat(43), key = 'toothtalk.admin-invitation.v1';
const account = '10000000-0000-4000-8000-000000000001', other = '10000000-0000-4000-8000-000000000002';
const claim: OwnClaim = { invitation: { id: '20000000-0000-4000-8000-000000000001', label: 'Synthetic colleague', reason: null,
  state: 'claimed', version: 2, expiresAt: '2026-10-11T10:00:00Z', createdAt: '2026-10-10T10:00:00Z', claimedAt: '2026-10-10T10:01:00Z', claimReference: 'AC-12345678', canClose: false }, verificationCode: '01234567' };
const page = (items: OwnClaim[] = [], nextCursor: string | null = null): Page<OwnClaim> => ({ items, nextCursor });
function setup(items: OwnClaim[] = []) {
  const request = vi.fn(async <T,>(path: string): Promise<T> => (path === '/api/admin-invitations/claim' ? claim : page(items)) as T);
  const api: ApiClient = { request: request as ApiClient['request'] }; const refresh = vi.fn(async () => {});
  return { api, request, refresh };
}
function pending<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-10T10:00:00Z'); sessionStorage.clear(); sessionStorage.setItem(key, JSON.stringify({ token, capturedAt: new Date().toISOString() })); });
afterEach(() => { vi.useRealTimers(); sessionStorage.clear(); });

describe('recipient API validation', () => {
  it('posts only the bearer token and validates the direct successful OwnClaim body', async () => {
    const { api, request } = setup(); expect(await claimAdminInvitation(api, token)).toEqual(claim);
    expect(request).toHaveBeenCalledWith('/api/admin-invitations/claim', { method: 'POST', body: JSON.stringify({ token }) });
  });
  it('reads own claims with a validated cursor and strict page schema', async () => {
    const { api, request } = setup([claim]); expect(await listOwnAdminClaims(api)).toEqual(page([claim]));
    expect(request).toHaveBeenCalledWith('/api/admin-invitations/mine');
    await expect(listOwnAdminClaims(api, 'invalid')).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(request).toHaveBeenCalledOnce();
  });
  it.each([{ ok: true, value: claim }, { ...claim, accountId: other }, { ...claim, verificationCode: 1234567 }, { ...claim, invitation: { ...claim.invitation, state: 'approved' } }])('rejects foreign fields/envelopes/invalid code shapes %j', async body => {
    const api: ApiClient = { request: async <T,>() => body as T };
    await expect(claimAdminInvitation(api, token)).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
});

describe('explicit verified recipient flow', () => {
  it('reads status on mount but never claims until the explicit accept button, preserving leading zero', async () => {
    const { api, request, refresh } = setup(); render(<InvitationPage api={api} accountId={account} onSessionRefresh={refresh} />);
    await screen.findByRole('button', { name: 'รับคำเชิญด้วยบัญชีนี้' });
    expect(request.mock.calls.filter(([path]) => path.includes('/claim'))).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'รับคำเชิญด้วยบัญชีนี้' }));
    expect(await screen.findByText('01234567')).toBeVisible(); expect(sessionStorage.getItem(key)).toBeNull();
    expect(screen.getByText(/ยังไม่ได้รับสิทธิ์ผู้ดูแล/)).toBeVisible(); expect(refresh).not.toHaveBeenCalled();
  });
  it('recovers this verified account’s pending code from GET without accepting a link', async () => {
    sessionStorage.clear(); const { api, request, refresh } = setup([claim]); render(<InvitationPage api={api} accountId={account} onSessionRefresh={refresh} />);
    expect(await screen.findByText('01234567')).toBeVisible(); expect(request).toHaveBeenCalledOnce();
    expect(screen.queryByRole('button', { name: 'รับคำเชิญด้วยบัญชีนี้' })).not.toBeInTheDocument();
  });
  it('shows reopen-link guidance if tab context is lost or malformed', async () => {
    sessionStorage.setItem(key, 'broken'); const { api, refresh } = setup(); render(<InvitationPage api={api} accountId={account} onSessionRefresh={refresh} />);
    expect(await screen.findByText(/เปิดลิงก์คำเชิญเดิมอีกครั้ง/)).toBeVisible(); expect(sessionStorage.getItem(key)).toBeNull();
  });
  it('ignores a delayed old-account response and discards token/code immediately on account switch', async () => {
    const slow = pending<OwnClaim>(); const first = setup(); first.request.mockImplementation(async <T,>(path: string) => (path.includes('/claim') ? await slow.promise : page()) as T);
    const next = setup(); const view = render(<InvitationPage api={first.api} accountId={account} onSessionRefresh={first.refresh} />);
    fireEvent.click(await screen.findByRole('button', { name: 'รับคำเชิญด้วยบัญชีนี้' }));
    view.rerender(<InvitationPage api={next.api} accountId={other} onSessionRefresh={next.refresh} />);
    expect(screen.queryByText('01234567')).not.toBeInTheDocument(); expect(sessionStorage.getItem(key)).toBeNull();
    await act(async () => slow.resolve(claim)); expect(screen.queryByText('01234567')).not.toBeInTheDocument();
    expect(next.request.mock.calls.some(([path]) => path.includes('/claim'))).toBe(false);
  });
  it('requires a successful mine check before offering acceptance when a previous outcome may be uncertain', async () => {
    const { api, request, refresh } = setup(); request.mockRejectedValue(new ApiRequestError('UNAVAILABLE', 503));
    render(<InvitationPage api={api} accountId={account} onSessionRefresh={refresh} />); await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'รับคำเชิญด้วยบัญชีนี้' })).not.toBeInTheDocument();
    expect(request.mock.calls.some(([path]) => path.includes('/claim'))).toBe(false);
  });
  it('removes already-visible code immediately when switching accounts without a new API instance', async () => {
    const { api, request, refresh } = setup([claim]); const view = render(<InvitationPage api={api} accountId={account} onSessionRefresh={refresh} />);
    expect(await screen.findByText('01234567')).toBeVisible(); request.mockResolvedValue(page());
    view.rerender(<InvitationPage api={api} accountId={other} onSessionRefresh={refresh} />);
    expect(screen.queryByText('01234567')).not.toBeInTheDocument(); expect(sessionStorage.getItem(key)).toBeNull();
  });
  it('clears newly present context on every account switch, including returning to the original account', async () => {
    const { api, refresh } = setup(); const view = render(<InvitationPage api={api} accountId={account} onSessionRefresh={refresh} />);
    await screen.findByRole('button', { name: 'รับคำเชิญด้วยบัญชีนี้' });
    view.rerender(<InvitationPage api={api} accountId={other} onSessionRefresh={refresh} />);
    sessionStorage.setItem(key, JSON.stringify({ token, capturedAt: new Date().toISOString() }));
    view.rerender(<InvitationPage api={api} accountId={account} onSessionRefresh={refresh} />);
    expect(sessionStorage.getItem(key)).toBeNull();
  });
  it('cancellation fences a pending claim and removes the local bearer', async () => {
    const slow = pending<OwnClaim>(); const { api, request, refresh } = setup(); request.mockImplementation(async <T,>(path: string) => (path.includes('/claim') ? await slow.promise : page()) as T);
    render(<InvitationPage api={api} accountId={account} onSessionRefresh={refresh} />);
    fireEvent.click(await screen.findByRole('button', { name: 'รับคำเชิญด้วยบัญชีนี้' })); fireEvent.click(screen.getByRole('button', { name: 'ยกเลิกการรับคำเชิญ' }));
    expect(sessionStorage.getItem(key)).toBeNull(); await act(async () => slow.resolve(claim));
    expect(screen.queryByText('01234567')).not.toBeInTheDocument();
  });
  it('does not duplicate an in-flight explicit claim', async () => {
    const slow = pending<OwnClaim>(); const { api, request, refresh } = setup(); request.mockImplementation(async <T,>(path: string) => (path.includes('/claim') ? await slow.promise : page()) as T);
    render(<InvitationPage api={api} accountId={account} onSessionRefresh={refresh} />); const accept = await screen.findByRole('button', { name: 'รับคำเชิญด้วยบัญชีนี้' });
    fireEvent.click(accept); fireEvent.click(accept); expect(request.mock.calls.filter(([path]) => path.includes('/claim'))).toHaveLength(1);
    await act(async () => slow.resolve(claim));
  });
  it('checks mine before allowing an explicit retry after uncertain claim without replaying the write', async () => {
    const lookup = pending<Page<OwnClaim>>(); const { api, request, refresh } = setup(); let reads = 0;
    request.mockImplementation(async <T,>(path: string) => { if (path.includes('/claim')) throw new ApiRequestError('UNAVAILABLE', 503); return (++reads === 1 ? page() : await lookup.promise) as T; });
    render(<InvitationPage api={api} accountId={account} onSessionRefresh={refresh} />); fireEvent.click(await screen.findByRole('button', { name: 'รับคำเชิญด้วยบัญชีนี้' }));
    await waitFor(() => expect(reads).toBe(2)); expect(screen.queryByRole('button', { name: 'ลองรับคำเชิญอีกครั้ง' })).not.toBeInTheDocument();
    await act(async () => lookup.resolve(page([claim]))); expect(await screen.findByText('01234567')).toBeVisible();
    expect(screen.getByRole('button', { name: 'ลองรับคำเชิญอีกครั้ง' })).toBeEnabled();
    expect(request.mock.calls.filter(([path]) => path.includes('/claim'))).toHaveLength(1);
  });
  it('keeps retry unavailable when uncertain recovery GET also fails', async () => {
    const { api, request, refresh } = setup(); let reads = 0;
    request.mockImplementation(async <T,>(path: string) => { if (path.includes('/claim') || ++reads > 1) throw new ApiRequestError('UNAVAILABLE', 503); return page() as T; });
    render(<InvitationPage api={api} accountId={account} onSessionRefresh={refresh} />); fireEvent.click(await screen.findByRole('button', { name: 'รับคำเชิญด้วยบัญชีนี้' }));
    await screen.findByRole('alert'); expect(screen.queryByRole('button', { name: 'ลองรับคำเชิญอีกครั้ง' })).not.toBeInTheDocument();
    expect(request.mock.calls.filter(([path]) => path.includes('/claim'))).toHaveLength(1);
  });
  it('refreshes the server session for an approved invitation without claiming current admin authority', async () => {
    const approved = { invitation: { ...claim.invitation, state: 'approved' as const }, verificationCode: null }; const { api, refresh } = setup([approved]);
    render(<InvitationPage api={api} accountId={account} onSessionRefresh={refresh} />);
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce()); expect(screen.getByText('คำเชิญนี้ได้รับการอนุมัติแล้ว')).toBeVisible();
    expect(screen.queryByText('01234567')).not.toBeInTheDocument(); expect(screen.queryByText(/คุณเป็นผู้ดูแลแล้ว/)).not.toBeInTheDocument();
  });
  it('hides a pending code as soon as its known expiry passes without another GET', async () => {
    vi.useFakeTimers(); vi.setSystemTime('2026-10-10T10:00:00Z'); const near = { ...claim, invitation: { ...claim.invitation, expiresAt: '2026-10-10T10:00:01Z' } };
    const { api, request, refresh } = setup([near]); render(<InvitationPage api={api} accountId={account} onSessionRefresh={refresh} />);
    await act(async () => {}); expect(screen.getByText('01234567')).toBeVisible();
    await act(async () => vi.advanceTimersByTime(1001)); expect(screen.queryByText('01234567')).not.toBeInTheDocument();
    expect(screen.getByText('คำเชิญหมดอายุแล้ว')).toBeVisible(); expect(request).toHaveBeenCalledOnce();
  });
  it('shows explicit pagination and can recover a claim beyond the first page', async () => {
    const cursor = btoa(JSON.stringify({ occurredAt: claim.invitation.createdAt, id: claim.invitation.id })).replaceAll('=', ''); const { api, request, refresh } = setup();
    request.mockImplementation(async <T,>(path: string) => (path.includes('?cursor=') ? page([claim]) : page([], cursor)) as T);
    render(<InvitationPage api={api} accountId={account} onSessionRefresh={refresh} />); fireEvent.click(await screen.findByRole('button', { name: 'รายการคำเชิญถัดไป' }));
    expect(await screen.findByText('01234567')).toBeVisible(); expect(request).toHaveBeenLastCalledWith(`/api/admin-invitations/mine?cursor=${encodeURIComponent(cursor)}`);
  });
});
