import { useEffect, useMemo, useRef, useState } from 'react';
import type { AdminRosterEntry, InvitationSummary } from '../../shared/admin-management';
import { ApiRequestError, type ApiClient } from '../api';
import { INVITATION_STATE_LABELS, MANAGEMENT_AUDIT_LABELS } from '../copy.th';
import { ApproveInvitationDialog, CloseInvitationDialog, CreateInvitationDialog, RevokeAdminDialog } from './InvitationDialogs';
import { createManagementApi, type CreatedInvitationResponse } from './management-api';

type Manager = ReturnType<typeof createManagementApi>;
type Snapshot = { capabilities: Awaited<ReturnType<Manager['capabilities']>>; roster: Awaited<ReturnType<Manager['roster']>>; invitations: Awaited<ReturnType<Manager['invitations']>>; history: Awaited<ReturnType<Manager['history']>> };
type Dialog = { kind: 'create'; receipt?: CreatedInvitationResponse } | { kind: 'approve'; invitation: InvitationSummary } | { kind: 'close'; invitation: InvitationSummary; action: 'cancel' | 'reject' } | { kind: 'revoke'; member: AdminRosterEntry };
function failureText(error: unknown): string {
  if (!(error instanceof ApiRequestError)) return 'ยังไม่ทราบผล โปรดตรวจสอบสถานะล่าสุดก่อนทำรายการอีกครั้ง';
  switch (error.code) {
    case 'UNAUTHENTICATED': return 'เซสชันสิ้นสุด ข้อมูลผู้ดูแลถูกซ่อนแล้ว โปรดเข้าสู่ระบบอีกครั้ง';
    case 'FORBIDDEN': return 'ไม่มีสิทธิ์ทำรายการนี้ ข้อมูลผู้ดูแลถูกซ่อนแล้ว โปรดตรวจสอบบัญชีและสิทธิ์';
    case 'NOT_FOUND': return 'ไม่พบคำเชิญหรือสิทธิ์นี้แล้ว โปรดตรวจสอบรายการล่าสุด';
    case 'DUPLICATE': return 'บัญชีนี้มีสิทธิ์ผู้ดูแลอยู่แล้ว โปรดตรวจสอบรายการล่าสุด';
    case 'VERSION_CONFLICT': return 'สถานะเปลี่ยนแล้ว โปรดตรวจสอบข้อมูลล่าสุดและยืนยันใหม่';
    case 'INVALID_TRANSITION': return 'รหัสไม่ตรง หรือคำเชิญทำรายการต่อไม่ได้ โปรดตรวจสอบรหัสและสถานะล่าสุด';
    case 'RATE_LIMITED': return 'ทำรายการถี่เกินไป โปรดลองใหม่ภายหลัง';
    case 'VALIDATION': return 'กรุณาตรวจสอบข้อมูลที่กรอก';
    default: return 'ยังไม่ทราบผล โปรดตรวจสอบสถานะล่าสุดก่อนทำรายการอีกครั้ง';
  }
}
/** Each account-bound API receives a new private UI lifetime, including immediate render clearing. */
export function AdminManagement({ api }: { api: ApiClient }) {
  const [binding, setBinding] = useState(() => ({ api, generation: 0 }));
  if (binding.api !== api) setBinding({ api, generation: binding.generation + 1 });
  return <ManagementSession key={binding.generation} api={api} />;
}
function ManagementSession({ api }: { api: ApiClient }) {
  const manager = useMemo(() => createManagementApi(api), [api]);
  const [snapshot, setSnapshot] = useState<Snapshot>(); const [dialog, setDialog] = useState<Dialog>();
  const [busy, setBusy] = useState(true); const [stale, setStale] = useState(false); const [accessLost, setAccessLost] = useState(false);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const lifetime = useRef(0); const dialogId = useRef(0); const readId = useRef(0); const operation = useRef(false);
  function loseAccess(error: unknown) {
    ++lifetime.current; ++readId.current; ++dialogId.current; operation.current = false;
    setSnapshot(undefined); setDialog(undefined); setAccessLost(true); setBusy(false); setError(failureText(error)); setNotice('');
  }
  async function readAll(active: number) {
    const read = ++readId.current;
    const [capabilities, roster, invitations, history] = await Promise.all([manager.capabilities(), manager.roster(), manager.invitations(), manager.history()]);
    if (lifetime.current !== active || readId.current !== read) return;
    setSnapshot({ capabilities, roster, invitations, history }); setStale(false);
  }
  useEffect(() => {
    const lifecycle = lifetime, confirmation = dialogId, reads = readId;
    const active = ++lifecycle.current;
    // This effect owns initial read results. The returned cleanup fences every later promise.
    Promise.all([manager.capabilities(), manager.roster(), manager.invitations(), manager.history()]).then(([capabilities, roster, invitations, history]) => {
      if (lifetime.current !== active) return;
      setSnapshot({ capabilities, roster, invitations, history }); setBusy(false);
    }).catch(error => {
      if (lifetime.current !== active) return;
      if (error instanceof ApiRequestError && [401, 403].includes(error.status)) {
        ++lifetime.current; setSnapshot(undefined); setAccessLost(true);
      }
      setError(failureText(error)); setBusy(false); setStale(true);
    });
    return () => { ++lifecycle.current; ++confirmation.current; ++reads.current; };
  }, [manager]);
  function dismiss() {
    ++dialogId.current; setDialog(undefined);
    if (operation.current) { setStale(true); setNotice(''); setError('ยังไม่ทราบผลของรายการที่ส่ง โปรดตรวจสอบสถานะล่าสุดก่อนทำรายการอีกครั้ง'); }
  }
  function open(next: Dialog) { if (busy || stale || accessLost || operation.current) return; ++dialogId.current; setDialog(next); setError(''); setNotice(''); }
  async function recover() {
    if (operation.current || accessLost) return;
    operation.current = true; setBusy(true); dismiss(); setError(''); setNotice('');
    const active = lifetime.current;
    try { await readAll(active); }
    catch (error) {
      if (lifetime.current !== active) return;
      if (error instanceof ApiRequestError && [401, 403].includes(error.status)) loseAccess(error);
      else { setStale(true); setError(failureText(error)); }
    } finally { if (lifetime.current === active) { operation.current = false; setBusy(false); } }
  }
  async function mutate(action: () => Promise<unknown>, kind: Dialog['kind']) {
    if (operation.current || busy || stale || accessLost || !dialog) return;
    operation.current = true; setBusy(true); setError(''); setNotice('');
    const active = lifetime.current, confirmation = dialogId.current;
    try {
      const result = await action();
      if (lifetime.current !== active || dialogId.current !== confirmation) return;
      if (kind === 'create') setDialog({ kind: 'create', receipt: result as CreatedInvitationResponse });
      else { ++dialogId.current; setDialog(undefined); setNotice('บันทึกรายการแล้ว'); }
      try { await readAll(active); }
      catch (error) {
        if (lifetime.current !== active) return;
        if (error instanceof ApiRequestError && [401, 403].includes(error.status)) loseAccess(error);
        else { setStale(true); setError('บันทึกรายการแล้ว แต่ตรวจสอบรายการล่าสุดไม่สำเร็จ โปรดตรวจสอบสถานะอีกครั้ง'); }
      }
    } catch (error) {
      if (lifetime.current !== active || dialogId.current !== confirmation) return;
      if (error instanceof ApiRequestError && [401, 403].includes(error.status)) { loseAccess(error); return; }
      ++dialogId.current; setDialog(undefined); setStale(true); setError(failureText(error));
      if (kind === 'create') setNotice('ตรวจสอบรายการคำเชิญก่อนยกเลิกและสร้างใหม่ รายการที่พบไม่ยืนยันว่าคำขอนี้สำเร็จ ไม่มีการส่งซ้ำหรือสร้างลิงก์ทดแทนอัตโนมัติ');
      // Safe metadata recovery never repeats the mutation or restores its old confirmation.
      try { await readAll(active); }
      catch (readError) {
        if (lifetime.current !== active) return;
        if (readError instanceof ApiRequestError && [401, 403].includes(readError.status)) loseAccess(readError);
        else { setStale(true); setNotice('ยังตรวจสอบสถานะล่าสุดไม่ได้ โปรดตรวจสอบอีกครั้งก่อนทำรายการต่อ'); }
      }
    } finally {
      if (lifetime.current === active) { operation.current = false; setBusy(false); }
    }
  }
  async function more(kind: 'roster' | 'invitations' | 'history') {
    const cursor = snapshot?.[kind].nextCursor;
    if (!cursor || operation.current || busy || stale || accessLost) return;
    operation.current = true; setBusy(true); const active = lifetime.current;
    try {
      if (kind === 'roster') {
        const result = await manager.roster(cursor); if (lifetime.current === active) setSnapshot(old => old ? { ...old, roster: { items: [...old.roster.items.filter(item => !result.items.some(row => row.grantId === item.grantId)), ...result.items], nextCursor: result.nextCursor } } : old);
      } else if (kind === 'invitations') {
        const result = await manager.invitations(cursor); if (lifetime.current === active) setSnapshot(old => old ? { ...old, invitations: { items: [...old.invitations.items.filter(item => !result.items.some(row => row.id === item.id)), ...result.items], nextCursor: result.nextCursor } } : old);
      } else {
        const result = await manager.history(cursor); if (lifetime.current === active) setSnapshot(old => old ? { ...old, history: { items: [...old.history.items.filter(item => !result.items.some(row => row.id === item.id)), ...result.items], nextCursor: result.nextCursor } } : old);
      }
    } catch (error) {
      if (lifetime.current !== active) return;
      if (error instanceof ApiRequestError && [401, 403].includes(error.status)) loseAccess(error);
      else { setStale(true); setError(failureText(error)); }
    } finally { if (lifetime.current === active) { operation.current = false; setBusy(false); } }
  }
  const disabled = busy || stale || accessLost;
  return <section className="admin-management" aria-busy={busy}>
    <div className="page-title"><span className="eyebrow muted">TOOTHTALK · CLINIC</span><h1>จัดการผู้ดูแล</h1>
      <p>{api.dataMode === 'demo' ? 'การเชิญและสิทธิ์ทั้งหมดจำลองในแท็บ ไม่มีการเข้าสู่ระบบหรือให้สิทธิ์จริง' : 'ผู้ดูแลที่ยังมีสิทธิ์เชิญและอนุมัติเพื่อนได้ โปรดตรวจรหัสกับผู้รับก่อนให้สิทธิ์'}</p>
    </div>
    {error && <p role="alert">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
    {!accessLost && <div className="form-actions wrap"><button className="button primary" disabled={disabled || !snapshot} onClick={() => open({ kind: 'create' })}>เชิญผู้ดูแลเพิ่ม</button><button className="button secondary" disabled={busy} onClick={() => void recover()}>ตรวจสอบสถานะล่าสุด</button></div>}
    {busy && !snapshot && <p role="status">กำลังตรวจสอบข้อมูลผู้ดูแล…</p>}
    {stale && !accessLost && <p className="notice">โปรดตรวจสอบสถานะล่าสุดก่อนทำรายการต่อ ไม่มีการส่งซ้ำอัตโนมัติ</p>}
    {snapshot && <>
      <section aria-label="ผู้ดูแลปัจจุบัน"><h2>ผู้ดูแลปัจจุบัน</h2>
        {!snapshot.roster.nextCursor && !snapshot.roster.items.some(member => member.protectedOwner) && <p className="notice">ยังไม่ได้กำหนดเจ้าของระบบ การถอนสิทธิ์ต้องให้ผู้ปฏิบัติการระบบดำเนินการ การเชิญและอนุมัติยังใช้ได้</p>}
        <div className="management-grid">{snapshot.roster.items.map(member => <article className="management-card" key={member.grantId}>
          <h3>{member.label ?? 'บัญชีผู้ดูแล'}</h3><p className="reference">{member.reference}</p><p>ให้สิทธิ์เมื่อ: <time dateTime={member.grantedAt}>{member.grantedAt}</time></p>
          {member.protectedOwner && <p className="status-badge">เจ้าของระบบที่ได้รับการกำหนด</p>}
          {snapshot.capabilities.canRevokeAdmins && member.canRevoke && !member.protectedOwner && <button className="button danger" disabled={disabled} onClick={() => open({ kind: 'revoke', member })}>ถอนสิทธิ์</button>}
        </article>)}</div>{!snapshot.roster.items.length && <p>ไม่มีรายการผู้ดูแล</p>}
        {snapshot.roster.nextCursor && <button className="button secondary" disabled={disabled} onClick={() => void more('roster')}>ผู้ดูแลเพิ่มเติม</button>}
      </section>
      <section aria-label="รายการคำเชิญ"><h2>รายการคำเชิญ</h2><p className="small-copy">ชื่อเรียกไม่ใช่หลักฐานยืนยันตัวตน รายการนี้ไม่มีรหัสยืนยันของผู้รับ</p>
        <div className="management-grid">{snapshot.invitations.items.map(invitation => <article className="management-card" key={invitation.id}>
          <h3>{invitation.label}</h3><p className={`status-badge invitation-${invitation.state}`}>{INVITATION_STATE_LABELS[invitation.state]}</p>{invitation.reason && <p>{invitation.reason}</p>}
          <p>หมดอายุ: <time dateTime={invitation.expiresAt}>{invitation.expiresAt}</time></p>{invitation.claimReference && <p>บัญชีที่รับคำเชิญ: {invitation.claimReference}</p>}{invitation.claimedAt && <p>รับเมื่อ: {invitation.claimedAt}</p>}
          <div className="form-actions wrap">
            {invitation.state === 'claimed' && <button className="button primary" disabled={disabled} onClick={() => open({ kind: 'approve', invitation })}>ตรวจรหัสและอนุมัติ</button>}
            {invitation.canClose && <button className="button secondary" disabled={disabled} onClick={() => open({ kind: 'close', invitation, action: invitation.state === 'claimed' ? 'reject' : 'cancel' })}>{invitation.state === 'claimed' ? 'ปฏิเสธคำเชิญ' : 'ยกเลิกคำเชิญ'}</button>}
          </div>
        </article>)}</div>{!snapshot.invitations.items.length && <p>ยังไม่มีคำเชิญ</p>}{snapshot.invitations.nextCursor && <button className="button secondary" disabled={disabled} onClick={() => void more('invitations')}>คำเชิญเพิ่มเติม</button>}
      </section>
      <section aria-label="ประวัติจัดการผู้ดูแล"><h2>ประวัติจัดการผู้ดูแล</h2><ul className="management-history">{snapshot.history.items.map(entry => <li key={entry.id}>
        <strong>{MANAGEMENT_AUDIT_LABELS[entry.action] ?? 'รายการจัดการผู้ดูแล'}</strong><span>{entry.actorReference}{entry.targetReference ? ` → ${entry.targetReference}` : ''}</span><time dateTime={entry.occurredAt}>{entry.occurredAt}</time>{entry.reason && <span>{entry.reason}</span>}
      </li>)}</ul>{!snapshot.history.items.length && <p>ยังไม่มีประวัติ</p>}{snapshot.history.nextCursor && <button className="button secondary" disabled={disabled} onClick={() => void more('history')}>ประวัติเพิ่มเติม</button>}</section>
    </>}
    {dialog?.kind === 'create' && <CreateInvitationDialog busy={busy} receipt={dialog.receipt} onClose={dismiss} onConfirm={(label, reason) => { if (operation.current) return; const requestId = crypto.randomUUID(); void mutate(() => manager.create({ requestId, label, reason }), 'create'); }} />}
    {dialog?.kind === 'approve' && <ApproveInvitationDialog invitation={dialog.invitation} busy={busy} onClose={dismiss} onConfirm={verificationCode => void mutate(() => manager.approve(dialog.invitation.id, { version: dialog.invitation.version, verificationCode }), 'approve')} />}
    {dialog?.kind === 'close' && <CloseInvitationDialog invitation={dialog.invitation} action={dialog.action} busy={busy} onClose={dismiss} onConfirm={reason => void mutate(() => manager.close(dialog.invitation.id, { version: dialog.invitation.version, action: dialog.action, reason }), 'close')} />}
    {dialog?.kind === 'revoke' && <RevokeAdminDialog member={dialog.member} busy={busy} onClose={dismiss} onConfirm={reason => void mutate(() => manager.revoke(dialog.member.grantId, { reason }), 'revoke')} />}
  </section>;
}
