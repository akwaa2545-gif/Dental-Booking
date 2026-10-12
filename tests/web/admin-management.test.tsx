// @vitest-environment-options {"url":"https://staging.example"}
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminRosterEntry, InvitationSummary, ManagementAuditEntry, Page } from '../../src/shared/admin-management';
import { ApiRequestError, type ApiClient } from '../../src/web/api';
import { AdminManagement } from '../../src/web/admin/AdminManagement';
import { createManagementApi, safeInvitationUrl } from '../../src/web/admin/management-api';
import { Dashboard } from '../../src/web/admin/Dashboard';

const id = '20000000-0000-4000-8000-000000000001', grantId = '30000000-0000-4000-8000-000000000001';
const at = '2026-10-10T10:00:00Z', token = 'a'.repeat(43);
const invitation: InvitationSummary = { id, label: 'เพื่อนร่วมงานสมมติ', reason: null, state: 'claimed', version: 2, expiresAt: '2026-10-11T10:00:00Z', createdAt: at, claimedAt: at, claimReference: 'AC-DEMO', canClose: true };
const member: AdminRosterEntry = { grantId, reference: 'AD-DEMO', label: null, grantedAt: at, protectedOwner: false, canRevoke: false };
const audit: ManagementAuditEntry = { id, action: 'invitation_created', actorReference: 'AD-DEMO', targetReference: null, invitationId: id, grantId: null, reason: null, occurredAt: at };
const page = <T,>(items: T[] = [], nextCursor: string | null = null): Page<T> => ({ items, nextCursor });
const cursor = btoa(JSON.stringify({ occurredAt: at, id })).replaceAll('=', '');
function setup(options: { owner?: boolean; entries?: AdminRosterEntry[]; invitations?: InvitationSummary[]; next?: string | null } = {}) {
  const state = { invitations: options.invitations ?? [structuredClone(invitation)], roster: options.entries ?? [{ ...member, canRevoke: options.owner ?? false }], next: options.next ?? null };
  const request = vi.fn(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    if (init?.method === 'POST') {
      if (path.endsWith('/approve')) { state.invitations = [{ ...invitation, state: 'approved', version: 3, canClose: false }]; return state.invitations[0] as T; }
      if (path.endsWith('/close')) { state.invitations = []; return { ...invitation, state: 'cancelled', version: 3, canClose: false } as T; }
      if (path.endsWith('/revoke')) { state.roster = []; return { revoked: true } as T; }
      return { created: true, invitation: { ...invitation, state: 'issued', version: 1 }, invitationUrl: `${window.location.origin}/admin-invitation#invite=${token}` } as T;
    }
    if (path.endsWith('/capabilities')) return { canRevokeAdmins: options.owner ?? false } as T;
    if (path.includes('/roster')) return page(state.roster) as T;
    if (path.includes('/invitations')) return (path.includes('?') ? page([{ ...invitation, id: '20000000-0000-4000-8000-000000000002', label: 'หน้าถัดไป' }]) : page(state.invitations, state.next)) as T;
    if (path.includes('/history')) return page([audit]) as T;
    throw new Error(`Unexpected request ${path}`);
  });
  return { request, state, api: { dataMode: 'server', request: request as ApiClient['request'] } satisfies ApiClient };
}
function slow<T>() { let resolve!: (value: T) => void; let reject!: (value: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const posts = (request: ReturnType<typeof setup>['request']) => request.mock.calls.filter(([, init]) => init?.method === 'POST');
async function ready(api: ApiClient) { render(<AdminManagement api={api} />); await screen.findByText('เพื่อนร่วมงานสมมติ'); }
async function openCreate() { fireEvent.click(screen.getByRole('button', { name: 'เชิญผู้ดูแลเพิ่ม' })); fireEvent.change(screen.getByLabelText('ชื่อเรียกผู้รับคำเชิญ'), { target: { value: 'ผู้ดูแลทดสอบ' } }); }
async function prepareApproval() { fireEvent.click(screen.getByRole('button', { name: 'ตรวจรหัสและอนุมัติ' })); const code = screen.getByLabelText('รหัส 8 หลักจากผู้รับ'); fireEvent.change(code, { target: { value: '01234567' } }); fireEvent.click(screen.getByRole('button', { name: 'ตรวจสอบและยืนยัน' })); }
beforeEach(() => { window.history.replaceState(null, '', '/admin/administrators'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('strict management HTTP counterpart', () => {
  it('uses actual direct DTOs, exact routes and bodies with no actor identity', async () => {
    const { api, request } = setup({ owner: true }); const manager = createManagementApi(api);
    expect(await manager.capabilities()).toEqual({ canRevokeAdmins: true }); expect(await manager.roster()).toEqual(page([{ ...member, canRevoke: true }]));
    await manager.invitations(cursor); await manager.history();
    const requestId = '40000000-0000-4000-8000-000000000001'; await manager.create({ requestId, label: 'ผู้ดูแลสมมติ', reason: null });
    await manager.approve(id, { version: 2, verificationCode: '01234567' }); await manager.close(id, { version: 2, action: 'reject', reason: 'ตรวจไม่ผ่าน' }); await manager.revoke(grantId, { reason: 'ย้ายหน้าที่' });
    expect(request.mock.calls).toContainEqual([`/api/admin/management/invitations?cursor=${cursor}`]);
    expect(request.mock.calls).toContainEqual([`/api/admin/management/grants/${grantId}/revoke`, { method: 'POST', body: JSON.stringify({ reason: 'ย้ายหน้าที่' }) }]);
    expect(posts(request).map(([, init]) => JSON.parse(String(init?.body)))).toEqual([{ requestId, label: 'ผู้ดูแลสมมติ', reason: null }, { version: 2, verificationCode: '01234567' }, { version: 2, action: 'reject', reason: 'ตรวจไม่ผ่าน' }, { reason: 'ย้ายหน้าที่' }]);
  });
  it.each(['bad', '../foo', '20000000-0000-4000-8000-000000000001/approve'])('rejects unsafe route IDs before transport %s', async bad => {
    const { api, request } = setup(); await expect(createManagementApi(api).revoke(bad, { reason: 'test' })).rejects.toMatchObject({ code: 'VALIDATION' }); expect(request).not.toHaveBeenCalled();
  });
  it('rejects invalid cursors and forged extra request fields', async () => {
    const { api, request } = setup(); const manager = createManagementApi(api); await expect(manager.invitations('bad')).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(manager.approve(id, { version: 2, verificationCode: '01234567', actorId: id } as never)).rejects.toMatchObject({ code: 'VALIDATION' }); expect(request).not.toHaveBeenCalled();
  });
  it.each([{ items: [{ ...invitation, verificationCode: '01234567' }], nextCursor: null }, { ok: true, value: page([invitation]) }, page([{ ...invitation, claimReference: 'U' + 'a'.repeat(32) }])])('rejects confidential fields or envelopes from manager lists %j', async value => {
    const api: ApiClient = { request: async <T,>() => value as T }; await expect(createManagementApi(api).invitations()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
  it('rejects extra provider fields in roster and history', async () => {
    const api: ApiClient = { request: async <T,>(path: string) => (path.endsWith('/roster') ? page([{ ...member, subject: 'secret' }]) : page([{ ...audit, verificationCode: '01234567' }])) as T };
    await expect(createManagementApi(api).roster()).rejects.toMatchObject({ code: 'UNAVAILABLE' }); await expect(createManagementApi(api).history()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
  it('rejects a replay paired with a newly exposed link', async () => {
    const api: ApiClient = { request: async <T,>() => ({ created: false, invitation, invitationUrl: `https://staging.example/admin-invitation#invite=${token}` }) as T };
    await expect(createManagementApi(api).create({ requestId: id, label: 'test', reason: null })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });
  it('allows only exact HTTPS same-origin own invitation fragment URLs', () => {
    const good = `https://staging.example/admin-invitation#invite=${token}`; expect(safeInvitationUrl(good, 'https://staging.example')).toBe(good);
    for (const bad of [`http://staging.example/admin-invitation#invite=${token}`, good.replace('staging.example', 'evil.example'), good.replace('/admin-invitation', '/admin-invitation/'), good.replace('#', '?x=1#'), good.replace('https://', 'https://user@'), good + '&x=1', good.replace('invite=', 'invite=%61'), good.replace('/admin-invitation', '/foo/../admin-invitation')]) expect(safeInvitationUrl(bad, 'https://staging.example')).toBeNull();
    expect(safeInvitationUrl(good, 'http://staging.example')).toBeNull();
  });
});

describe('management view and guarded dialogs', () => {
  it('names the actual Worker verification-failure audit event in Thai', async () => {
    const { api, request } = setup(); const normal = request.getMockImplementation()!; request.mockImplementation((path, init) => path.endsWith('/history') ? Promise.resolve(page([{ ...audit, action: 'invitation_verification_failed' }])) : normal(path, init)); await ready(api); expect(screen.getByText('ตรวจรหัสไม่ผ่าน')).toBeVisible();
  });
  it('keeps management and the fresh confirmation semantically accessible', async () => {
    const { api } = setup(); const view = render(<AdminManagement api={api} />); await screen.findByText('เพื่อนร่วมงานสมมติ'); await prepareApproval(); const result = await axe.run(view.container, { rules: { 'color-contrast': { enabled: false }, 'region': { enabled: false } } }); expect(result.violations.map(item => item.id)).toEqual([]);
  });
  it('lets ordinary admins invite and approve while hiding revoke and all matching codes', async () => {
    const { api, request } = setup(); await ready(api); expect(screen.getByRole('heading', { name: 'จัดการผู้ดูแล' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'เชิญผู้ดูแลเพิ่ม' })).toBeEnabled(); expect(screen.getByRole('button', { name: 'ตรวจรหัสและอนุมัติ' })).toBeEnabled(); expect(screen.queryByRole('button', { name: 'ถอนสิทธิ์' })).not.toBeInTheDocument();
    expect(screen.queryByText('01234567')).not.toBeInTheDocument(); expect(request.mock.calls.every(([path]) => path.startsWith('/api/admin/management/'))).toBe(true);
    expect(screen.getByText(/ยังไม่ได้กำหนดเจ้าของระบบ/)).toBeVisible();
  });
  it('renders labels and reasons as literal text with no profile lookup', async () => {
    const label = '<img src=x onerror=alert(1)>'; const { api, request } = setup({ invitations: [{ ...invitation, label, reason: '<script>alert(1)</script>' }] }); render(<AdminManagement api={api} />);
    expect(await screen.findByText(label)).toBeVisible(); expect(screen.getByText('<script>alert(1)</script>')).toBeVisible(); expect(document.querySelector('img, script')).toBeNull(); expect(request.mock.calls.every(([path]) => path.startsWith('/api/admin/management/'))).toBe(true);
  });
  it('requires the recipient-supplied text code and a fresh explicit consequence confirmation', async () => {
    const { api, request } = setup(); await ready(api); fireEvent.click(screen.getByRole('button', { name: 'ตรวจรหัสและอนุมัติ' }));
    const input = screen.getByLabelText('รหัส 8 หลักจากผู้รับ'); expect(input).toHaveAttribute('type', 'text'); expect(input).toHaveAttribute('inputmode', 'numeric');
    expect(screen.getByRole('button', { name: 'ตรวจสอบและยืนยัน' })).toBeDisabled(); fireEvent.change(input, { target: { value: '01234567' } }); fireEvent.click(screen.getByRole('button', { name: 'ตรวจสอบและยืนยัน' }));
    expect(screen.getByText('บัญชีนี้จะจัดการนัดหมายและเชิญผู้ดูแลเพิ่มได้')).toBeVisible(); expect(posts(request)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันให้สิทธิ์ผู้ดูแล' })); await waitFor(() => expect(posts(request)).toHaveLength(1)); expect(JSON.parse(String(posts(request)[0][1]?.body))).toEqual({ version: 2, verificationCode: '01234567' });
  });
  it('guards duplicate approval submits and discards stale confirmation on version conflict', async () => {
    const { api, request, state } = setup(); const normal = request.getMockImplementation()!; const pending = slow<unknown>(); request.mockImplementation((path, init) => path.endsWith('/approve') ? pending.promise : normal(path, init)); await ready(api); await prepareApproval();
    const confirm = screen.getByRole('button', { name: 'ยืนยันให้สิทธิ์ผู้ดูแล' }); fireEvent.click(confirm); fireEvent.click(confirm); expect(posts(request)).toHaveLength(1);
    state.invitations = [{ ...invitation, version: 3 }]; await act(async () => pending.reject(new ApiRequestError('VERSION_CONFLICT', 409)));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument()); expect(screen.getByRole('alert')).toHaveTextContent(/สถานะเปลี่ยน/); fireEvent.click(screen.getByRole('button', { name: 'ตรวจรหัสและอนุมัติ' })); expect(screen.getByLabelText('รหัส 8 หลักจากผู้รับ')).toHaveValue(''); expect(screen.queryByRole('button', { name: 'ยืนยันให้สิทธิ์ผู้ดูแล' })).not.toBeInTheDocument();
  });
  it.each(['INVALID_TRANSITION', 'NOT_FOUND', 'DUPLICATE'] as const)('clears the confirmation after %s and uses management-specific text', async code => {
    const { api, request } = setup(); const normal = request.getMockImplementation()!; request.mockImplementation((path, init) => path.endsWith('/approve') ? Promise.reject(new ApiRequestError(code)) : normal(path, init)); await ready(api); await prepareApproval(); fireEvent.click(screen.getByRole('button', { name: 'ยืนยันให้สิทธิ์ผู้ดูแล' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument()); expect(screen.getByRole('alert')).not.toHaveTextContent(/ไม่พบนัดหมาย|ผู้รับบริการนี้/); expect(posts(request)).toHaveLength(1);
  });
  it('offers exact-grant revoke only with owner capability and eligible row', async () => {
    const { api, request } = setup({ owner: true, entries: [{ ...member, canRevoke: true }, { ...member, grantId: '30000000-0000-4000-8000-000000000002', reference: 'AD-OWNER', protectedOwner: true, canRevoke: true }] }); await ready(api);
    expect(screen.getAllByRole('button', { name: 'ถอนสิทธิ์' })).toHaveLength(1); fireEvent.click(screen.getByRole('button', { name: 'ถอนสิทธิ์' })); fireEvent.change(screen.getByLabelText('เหตุผล'), { target: { value: 'ย้ายหน้าที่' } }); fireEvent.click(screen.getByRole('button', { name: 'ยืนยันถอนสิทธิ์' }));
    await waitFor(() => expect(posts(request)).toHaveLength(1)); expect(posts(request)[0]).toEqual([`/api/admin/management/grants/${grantId}/revoke`, { method: 'POST', body: JSON.stringify({ reason: 'ย้ายหน้าที่' }) }]);
  });
  it('never trusts an eligible row without protected-owner capability', async () => { const { api } = setup({ entries: [{ ...member, canRevoke: true }] }); await ready(api); expect(screen.queryByRole('button', { name: 'ถอนสิทธิ์' })).not.toBeInTheDocument(); });
  it('clears all private data and confirms nothing further after server authorization denial', async () => {
    const { api, request } = setup({ owner: true }); const normal = request.getMockImplementation()!; request.mockImplementation((path, init) => path.endsWith('/revoke') ? Promise.reject(new ApiRequestError('FORBIDDEN', 403)) : normal(path, init)); await ready(api);
    fireEvent.click(screen.getByRole('button', { name: 'ถอนสิทธิ์' })); fireEvent.change(screen.getByLabelText('เหตุผล'), { target: { value: 'review' } }); fireEvent.click(screen.getByRole('button', { name: 'ยืนยันถอนสิทธิ์' }));
    await waitFor(() => expect(screen.queryByText('เพื่อนร่วมงานสมมติ')).not.toBeInTheDocument()); expect(screen.queryByText('AD-DEMO')).not.toBeInTheDocument(); expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(screen.getByRole('alert')).toHaveTextContent(/ไม่มีสิทธิ์/); expect(posts(request)).toHaveLength(1);
  });
  it('shows a fresh link only in its creation lifetime and copies deliberately', async () => {
    const { api, request } = setup(); const writeText = vi.fn().mockResolvedValue(undefined); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } }); await ready(api); await openCreate();
    fireEvent.click(screen.getByRole('button', { name: 'สร้างคำเชิญ' })); const copy = await screen.findByRole('button', { name: 'คัดลอกลิงก์คำเชิญ' }); expect(writeText).not.toHaveBeenCalled(); fireEvent.click(copy);
    await screen.findByText('คัดลอกลิงก์แล้ว'); expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/admin-invitation#invite=${token}`);
    const body = JSON.parse(String(posts(request)[0][1]?.body)); expect(body).toMatchObject({ label: 'ผู้ดูแลทดสอบ', reason: null }); expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/); expect(Object.keys(body)).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: 'ปิดหน้าต่าง' })); await openCreate(); expect(screen.queryByRole('button', { name: 'คัดลอกลิงก์คำเชิญ' })).not.toBeInTheDocument(); expect(document.body.textContent).not.toContain(token);
  });
  it('shows a deliberate selectable fallback if clipboard permission fails', async () => {
    const { api } = setup(); Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } }); await ready(api); await openCreate(); fireEvent.click(screen.getByRole('button', { name: 'สร้างคำเชิญ' })); fireEvent.click(await screen.findByRole('button', { name: 'คัดลอกลิงก์คำเชิญ' }));
    const fallback = await screen.findByLabelText('ลิงก์สำหรับคัดลอกด้วยตนเอง'); expect(fallback).toHaveValue(`${window.location.origin}/admin-invitation#invite=${token}`); expect(screen.queryByText('คัดลอกลิงก์แล้ว')).not.toBeInTheDocument(); fireEvent.click(screen.getByRole('button', { name: 'เลือกข้อความลิงก์' })); expect(fallback).toHaveFocus();
  });
  it.each([false, 'unsafe'])('does not expose a replay or invalid fresh URL (%s)', async mode => {
    const { api, request } = setup(); const normal = request.getMockImplementation()!; request.mockImplementation((path, init) => init?.method === 'POST' ? Promise.resolve(mode === false ? { created: false, invitation } : { created: true, invitation, invitationUrl: `https://evil.example/admin-invitation#invite=${token}` }) : normal(path, init)); await ready(api); await openCreate(); fireEvent.click(screen.getByRole('button', { name: 'สร้างคำเชิญ' }));
    await screen.findByText(/ไม่สามารถแสดงลิงก์/); expect(screen.queryByRole('button', { name: 'คัดลอกลิงก์คำเชิญ' })).not.toBeInTheDocument(); expect(document.body.textContent).not.toContain(token); expect(posts(request)).toHaveLength(1);
  });
  it('refreshes safe metadata after uncertain create and never retries or manufactures a link', async () => {
    const { api, request } = setup(); const normal = request.getMockImplementation()!; request.mockImplementation((path, init) => init?.method === 'POST' ? Promise.reject(new ApiRequestError('UNAVAILABLE', 503)) : normal(path, init)); await ready(api); await openCreate(); fireEvent.click(screen.getByRole('button', { name: 'สร้างคำเชิญ' }));
    await screen.findByText(/ตรวจสอบรายการคำเชิญ.*ยกเลิก.*สร้างใหม่/); expect(posts(request)).toHaveLength(1); expect(request.mock.calls.filter(([path, init]) => path.endsWith('/invitations') && !init)).toHaveLength(2); expect(document.body.textContent).not.toContain(token); expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
  it.each(['approve', 'revoke'] as const)('refreshes metadata after uncertain %s with no automatic mutation retry', async action => {
    const { api, request } = setup({ owner: true }); const normal = request.getMockImplementation()!; request.mockImplementation((path, init) => path.endsWith(`/${action}`) ? Promise.reject(new ApiRequestError('UNAVAILABLE', 503)) : normal(path, init)); await ready(api);
    if (action === 'approve') { await prepareApproval(); fireEvent.click(screen.getByRole('button', { name: 'ยืนยันให้สิทธิ์ผู้ดูแล' })); } else { fireEvent.click(screen.getByRole('button', { name: 'ถอนสิทธิ์' })); fireEvent.change(screen.getByLabelText('เหตุผล'), { target: { value: 'review' } }); fireEvent.click(screen.getByRole('button', { name: 'ยืนยันถอนสิทธิ์' })); }
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument()); expect(screen.getByRole('alert')).toHaveTextContent(/ยังไม่ทราบผล/); expect(posts(request)).toHaveLength(1); expect(request.mock.calls.filter(([path]) => path.endsWith('/roster'))).toHaveLength(2);
  });
  it('uses server canClose and preserves reason on explicit cancel/reject', async () => {
    const { api, request } = setup(); await ready(api); fireEvent.click(screen.getByRole('button', { name: 'ปฏิเสธคำเชิญ' })); fireEvent.change(screen.getByLabelText('เหตุผล'), { target: { value: 'ตรวจสอบไม่ได้' } }); fireEvent.click(screen.getByRole('button', { name: 'ยืนยันปฏิเสธคำเชิญ' })); await waitFor(() => expect(posts(request)).toHaveLength(1)); expect(JSON.parse(String(posts(request)[0][1]?.body))).toEqual({ version: 2, action: 'reject', reason: 'ตรวจสอบไม่ได้' });
  });
  it('honors owner canClose on an effectively expired invitation', async () => { const { api } = setup({ owner: true, invitations: [{ ...invitation, state: 'expired', canClose: true }] }); await ready(api); expect(screen.getByRole('button', { name: 'ยกเลิกคำเชิญ' })).toBeEnabled(); });
  it('hides close controls when server canClose is false', async () => { const { api } = setup({ invitations: [{ ...invitation, canClose: false }] }); await ready(api); expect(screen.queryByRole('button', { name: 'ปฏิเสธคำเชิญ' })).not.toBeInTheDocument(); });
  it('pages invitations explicitly without duplicate rows or writes', async () => { const { api, request } = setup({ next: cursor }); await ready(api); fireEvent.click(screen.getByRole('button', { name: 'คำเชิญเพิ่มเติม' })); expect(await screen.findByText('หน้าถัดไป')).toBeVisible(); expect(screen.getAllByText('เพื่อนร่วมงานสมมติ')).toHaveLength(1); expect(request.mock.calls).toContainEqual([`/api/admin/management/invitations?cursor=${cursor}`]); expect(posts(request)).toHaveLength(0); });
  it.each(['escape', 'back', 'close'] as const)('dismisses confirmation on %s without a mutation', async mode => { const { api, request } = setup(); await ready(api); await prepareApproval(); if (mode === 'escape') fireEvent.keyDown(document, { key: 'Escape' }); else if (mode === 'back') fireEvent.popState(window); else fireEvent.click(screen.getByRole('button', { name: 'ปิดหน้าต่าง' })); expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(posts(request)).toHaveLength(0); });
  it.each(['dismiss', 'unmount', 'switch'] as const)('discards a delayed created secret after %s', async mode => {
    const { api, request } = setup(); const normal = request.getMockImplementation()!; const pending = slow<unknown>(); request.mockImplementation((path, init) => init?.method === 'POST' ? pending.promise : normal(path, init)); const view = render(<AdminManagement api={api} />); await screen.findByText('เพื่อนร่วมงานสมมติ'); await openCreate(); fireEvent.click(screen.getByRole('button', { name: 'สร้างคำเชิญ' }));
    if (mode === 'dismiss') fireEvent.click(screen.getByRole('button', { name: 'ปิดหน้าต่าง' })); else if (mode === 'unmount') view.unmount(); else view.rerender(<AdminManagement api={setup({ invitations: [] }).api} />);
    await act(async () => pending.resolve({ created: true, invitation, invitationUrl: `${window.location.origin}/admin-invitation#invite=${token}` })); expect(document.body.textContent).not.toContain(token); expect(screen.queryByRole('button', { name: 'คัดลอกลิงก์คำเชิญ' })).not.toBeInTheDocument();
  });
  it('clears confirmation and old-account data synchronously when the API lifetime changes', async () => { const first = setup(); const view = render(<AdminManagement api={first.api} />); await screen.findByText('เพื่อนร่วมงานสมมติ'); await prepareApproval(); const next = setup({ invitations: [] }); view.rerender(<AdminManagement api={next.api} />); expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); expect(screen.queryByText('เพื่อนร่วมงานสมมติ')).not.toBeInTheDocument(); });
  it('renders the management dashboard without any patient appointment or availability fetch', async () => { const { api, request } = setup(); render(<Dashboard api={api} now={() => new Date(at)} section={'administrators' as never} />); await screen.findByRole('heading', { name: 'จัดการผู้ดูแล' }); await screen.findByText('เพื่อนร่วมงานสมมติ'); expect(request.mock.calls.every(([path]) => path.startsWith('/api/admin/management/'))).toBe(true); });
});
