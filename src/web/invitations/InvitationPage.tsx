import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { UUID } from '../../shared/contracts';
import type { OwnClaim } from '../../shared/admin-management';
import { ApiRequestError, claimAdminInvitation, listOwnAdminClaims, type ApiClient } from '../api';
import { clearInvitationContext, invitationStorage, readInvitationContext } from './context';

type Props = { api: ApiClient; accountId: UUID; onSessionRefresh: () => Promise<void> };
const contextLifetime = 24 * 60 * 60 * 1000;
function discardContext() { const storage = invitationStorage(); if (storage) clearInvitationContext(storage); }
const stateText = {
  issued: 'คำเชิญยังไม่ได้รับการยืนยัน', claimed: 'รอผู้ดูแลตรวจรหัสและอนุมัติ',
  approved: 'คำเชิญนี้ได้รับการอนุมัติแล้ว', rejected: 'คำเชิญถูกปฏิเสธแล้ว', cancelled: 'คำเชิญถูกยกเลิกแล้ว',
  locked: 'คำเชิญถูกล็อกแล้ว โปรดขอคำเชิญใหม่', expired: 'คำเชิญหมดอายุแล้ว', invalidated: 'คำเชิญนี้ใช้ต่อไม่ได้แล้ว',
};

/** A changed account gets a new UI lifetime and cannot inherit the old bearer. */
export function InvitationPage(props: Props) {
  const [binding, setBinding] = useState(() => ({ accountId: props.accountId, allowContext: true }));
  // Reset this component's derived state before rendering any changed-account child.
  // Once switched, a fresh direct-link/page lifetime is needed to adopt a bearer.
  if (binding.accountId !== props.accountId) setBinding({ accountId: props.accountId, allowContext: false });
  const allowContext = binding.accountId === props.accountId && binding.allowContext;
  useLayoutEffect(() => { if (!allowContext) discardContext(); }, [props.accountId, allowContext]);
  return <AccountInvitationPage key={props.accountId} {...props} allowContext={allowContext} />;
}
function AccountInvitationPage({ api, accountId, onSessionRefresh, allowContext }: Props & { allowContext: boolean }) {
  const [context, setContext] = useState(() => {
    const storage = invitationStorage(); return allowContext && storage ? readInvitationContext(storage, new Date()) : null;
  });
  const [claims, setClaims] = useState<OwnClaim[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [uncertain, setUncertain] = useState(false);
  const [recoveryChecked, setRecoveryChecked] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const [error, setError] = useState<string>();
  const [clock, setClock] = useState(() => Date.now());
  const generation = useRef(0);
  const operation = useRef(false);

  useEffect(() => {
    const active = ++generation.current;
    operation.current = true;
    async function recover() {
      try {
        const result = await listOwnAdminClaims(api);
        if (generation.current !== active) return;
        setClaims(result.items); setNextCursor(result.nextCursor); setClock(Date.now()); setRecoveryChecked(true);
        if (result.items.some(item => item.invitation.state === 'approved')) {
          await onSessionRefresh();
          if (generation.current !== active) return;
        }
      } catch {
        if (generation.current === active) setError('ตรวจสอบคำเชิญของบัญชีนี้ไม่สำเร็จ โปรดตรวจสอบสถานะอีกครั้ง');
      } finally {
        if (generation.current === active) { operation.current = false; setBusy(false); }
      }
    }
    void recover();
    return () => { generation.current += 1; operation.current = false; };
  }, [api, accountId, onSessionRefresh]);

  useEffect(() => {
    const deadlines = claims.filter(item => item.invitation.state === 'claimed').map(item => Date.parse(item.invitation.expiresAt));
    if (context) deadlines.push(Date.parse(context.capturedAt) + contextLifetime);
    const upcoming = deadlines.filter(deadline => deadline > clock);
    if (!upcoming.length) return;
    const timeout = window.setTimeout(() => {
      const current = Date.now(); setClock(current);
      if (context && current >= Date.parse(context.capturedAt) + contextLifetime) { discardContext(); setContext(null); }
    }, Math.min(60000, Math.max(1, Math.min(...upcoming) - clock)));
    return () => window.clearTimeout(timeout);
  }, [claims, context, clock]);

  async function reload(cursor: string | null = null) {
    if (operation.current || cancelled) return;
    operation.current = true; setBusy(true); setError(undefined);
    const active = ++generation.current;
    try {
      const result = await listOwnAdminClaims(api, cursor);
      if (generation.current !== active) return;
      setClaims(old => cursor === null ? result.items : [...old.filter(item => !result.items.some(fresh => fresh.invitation.id === item.invitation.id)), ...result.items]);
      setNextCursor(result.nextCursor); setClock(Date.now()); setRecoveryChecked(true);
      if (result.items.some(item => item.invitation.state === 'approved')) await onSessionRefresh();
    } catch {
      if (generation.current === active) { setRecoveryChecked(false); setError('ตรวจสอบคำเชิญของบัญชีนี้ไม่สำเร็จ โปรดตรวจสอบสถานะอีกครั้ง'); }
    } finally { if (generation.current === active) { operation.current = false; setBusy(false); } }
  }
  async function accept() {
    if (operation.current || cancelled || !recoveryChecked || uncertain && (!recoveryChecked || nextCursor !== null)) return;
    const storage = invitationStorage(); const current = storage ? readInvitationContext(storage, new Date()) : null;
    if (!current || !context || current.token !== context.token) { discardContext(); setContext(null); return; }
    operation.current = true; setBusy(true); setError(undefined); setRecoveryChecked(false);
    const active = ++generation.current;
    try {
      const result = await claimAdminInvitation(api, current.token);
      if (generation.current !== active) return;
      discardContext(); setContext(null); setUncertain(false);
      setClaims(old => [result, ...old.filter(item => item.invitation.id !== result.invitation.id)]); setClock(Date.now());
      if (result.invitation.state === 'approved') await onSessionRefresh();
    } catch (failure) {
      if (generation.current !== active) return;
      if (!(failure instanceof ApiRequestError) || failure.code === 'UNAVAILABLE') {
        setUncertain(true);
        // Read only. An uncertain mutation is never automatically replayed.
        try {
          const recovered = await listOwnAdminClaims(api);
          if (generation.current !== active) return;
          setClaims(recovered.items); setNextCursor(recovered.nextCursor); setClock(Date.now()); setRecoveryChecked(true);
          if (recovered.items.some(item => item.invitation.state === 'approved')) await onSessionRefresh();
        } catch {
          if (generation.current === active) setError('ยังยืนยันผลการรับคำเชิญไม่ได้ โปรดตรวจสอบสถานะก่อนลองรับอีกครั้ง');
        }
      } else if (failure.code === 'RATE_LIMITED') {
        setError('มีการทำรายการมากเกินไป โปรดลองใหม่ภายหลัง');
      } else {
        discardContext(); setContext(null); setError('คำเชิญนี้ใช้ไม่ได้ โปรดตรวจสอบบัญชีหรือขอคำเชิญใหม่จากผู้ดูแล');
      }
    } finally { if (generation.current === active) { operation.current = false; setBusy(false); } }
  }
  function cancel() {
    generation.current += 1; operation.current = false; discardContext(); setContext(null);
    setClaims([]); setNextCursor(null); setError(undefined); setBusy(false); setCancelled(true);
  }
  const activeContext = context && clock < Date.parse(context.capturedAt) + contextLifetime;
  return <section className="page-card" lang="th" aria-busy={busy}>
    <h1>คำเชิญผู้ดูแล</h1>
    <p>รับคำเชิญด้วยบัญชี LINE ที่เข้าสู่ระบบและตรวจสอบแล้ว จากนั้นแจ้งรหัส 8 หลักแก่ผู้ดูแลผ่านช่องทางที่รู้จักกัน</p>
    {busy && <p role="status">กำลังตรวจสอบคำเชิญ…</p>}
    {error && <p role="alert">{error}</p>}
    {cancelled ? <p>หยุดการรับคำเชิญบนหน้านี้แล้ว หากต้องการตรวจสอบผล ให้เปิดลิงก์คำเชิญเดิมอีกครั้ง</p> : <>
      {!activeContext && !claims.length && <p>ไม่มีลิงก์คำเชิญที่ใช้ได้ในแท็บนี้ โปรดเปิดลิงก์คำเชิญเดิมอีกครั้งหลังเข้าสู่ระบบ</p>}
      {uncertain && <p>ยังไม่ทราบผลการรับคำเชิญ โปรดตรวจสอบรายการคำเชิญของบัญชีนี้ก่อนลองอีกครั้ง ไม่มีการรับคำเชิญซ้ำอัตโนมัติ</p>}
      {activeContext && recoveryChecked && (!uncertain || nextCursor === null) && <button className="button primary" disabled={busy} onClick={() => void accept()}>{uncertain ? 'ลองรับคำเชิญอีกครั้ง' : 'รับคำเชิญด้วยบัญชีนี้'}</button>}
      <div className="form-actions">
        <button className="button secondary" disabled={busy} onClick={() => void reload()}>ตรวจสอบสถานะอีกครั้ง</button>
        {nextCursor && <button className="button secondary" disabled={busy} onClick={() => void reload(nextCursor)}>รายการคำเชิญถัดไป</button>}
        <button className="button secondary" onClick={cancel}>ยกเลิกการรับคำเชิญ</button>
      </div>
      {claims.map(item => {
        const invitation = item.invitation;
        const expired = ['issued', 'claimed'].includes(invitation.state) && Date.parse(invitation.expiresAt) <= clock;
        const pending = invitation.state === 'claimed' && !expired;
        return <section className="page-card" key={invitation.id} aria-label={invitation.label}>
          <h2>{invitation.label}</h2><p>{stateText[expired ? 'expired' : invitation.state]}</p>
          {invitation.claimReference && <p>อ้างอิงการรับคำเชิญ: {invitation.claimReference}</p>}
          {pending && item.verificationCode && <><p>รหัสยืนยัน 8 หลัก</p><p className="invitation-verification-code">{item.verificationCode}</p><p>ยังไม่ได้รับสิทธิ์ผู้ดูแล โปรดแจ้งรหัสนี้แก่ผู้ดูแลที่คุณรู้จักเพื่อให้ตรวจสอบและอนุมัติ</p></>}
          {invitation.state === 'approved' && <p>เมนูผู้ดูแลจะอ้างอิงสิทธิ์ปัจจุบันที่ตรวจสอบจากเซิร์ฟเวอร์</p>}
          <p>หมดอายุ: <time dateTime={invitation.expiresAt}>{new Date(invitation.expiresAt).toLocaleString('th-TH')}</time></p>
        </section>;
      })}
    </>}
  </section>;
}
