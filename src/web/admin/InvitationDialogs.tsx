import { useEffect, useRef, useState } from 'react';
import type { AdminRosterEntry, InvitationSummary } from '../../shared/admin-management';
import { Modal } from '../appointments/CancelDialog';
import { ADMIN_APPROVAL_CONSEQUENCE } from '../copy.th';
import { safeInvitationUrl, type CreatedInvitationResponse } from './management-api';

type Common = { busy: boolean; onClose: () => void };
export function CreateInvitationDialog({ busy, onClose, onConfirm, receipt }: Common & {
  onConfirm: (label: string, reason: string | null) => void; receipt?: CreatedInvitationResponse;
}) {
  const [label, setLabel] = useState(''); const [reason, setReason] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copying' | 'copied' | 'fallback'>('idle');
  const selected = useRef<HTMLInputElement>(null); const lifetime = useRef(0); const copying = useRef(false);
  useEffect(() => { const fence = lifetime; ++fence.current; return () => { ++fence.current; }; }, []);
  const link = receipt?.created ? safeInvitationUrl(receipt.invitationUrl) : null;
  async function copyLink() {
    if (!link || copying.current) return;
    const active = lifetime.current; copying.current = true; setCopyState('copying');
    try { await navigator.clipboard.writeText(link); if (active === lifetime.current) setCopyState('copied'); }
    catch { if (active === lifetime.current) setCopyState('fallback'); }
    finally { copying.current = false; }
  }
  return <Modal title={receipt ? 'คำเชิญที่สร้าง' : 'เชิญผู้ดูแลเพิ่ม'} onClose={onClose} busy={false}>
    {receipt ? <>
      <p>{receipt.invitation.label}</p><p>หมดอายุ: <time dateTime={receipt.invitation.expiresAt}>{receipt.invitation.expiresAt}</time></p>
      <p className="notice">ลิงก์แสดงเฉพาะครั้งนี้ โปรดส่งเองให้คนที่ตั้งใจเชิญผ่านช่องทางที่รู้จักกัน ลิงก์อย่างเดียวไม่ให้สิทธิ์ผู้ดูแล</p>
      {link ? <>
        <button className="button primary" disabled={copyState === 'copying'} onClick={() => void copyLink()}>คัดลอกลิงก์คำเชิญ</button>
        {copyState === 'copied' && <p role="status">คัดลอกลิงก์แล้ว</p>}
        {copyState === 'fallback' && <div><p role="status">คัดลอกอัตโนมัติไม่ได้ โปรดเลือกข้อความแล้วคัดลอกด้วยตนเอง</p>
          <label className="field">ลิงก์สำหรับคัดลอกด้วยตนเอง<input ref={selected} readOnly value={link} /></label>
          <button className="button secondary" onClick={() => { selected.current?.focus(); selected.current?.select(); }}>เลือกข้อความลิงก์</button>
        </div>}
      </> : <p role="status">ไม่สามารถแสดงลิงก์ของคำเชิญนี้ได้ โปรดตรวจสอบรายการคำเชิญก่อนยกเลิกและสร้างใหม่ หากใช้เดโมบน HTTP จะคัดลอกลิงก์ไม่ได้</p>}
    </> : <form onSubmit={event => { event.preventDefault(); if (!busy && label.trim() && label.trim().length <= 120 && reason.trim().length <= 500) onConfirm(label.trim(), reason.trim() || null); }}>
      <p>คำเชิญหมดอายุใน 24 ชั่วโมง ชื่อเรียกช่วยจำเท่านั้น ต้องตรวจรหัสจากผู้รับก่อนให้สิทธิ์</p>
      <label className="field">ชื่อเรียกผู้รับคำเชิญ<input type="text" required maxLength={120} value={label} disabled={busy} onChange={event => setLabel(event.target.value)} /></label>
      <label className="field">เหตุผล (ไม่บังคับ)<textarea maxLength={500} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></label>
      <div className="form-actions"><button type="button" className="button secondary" onClick={onClose}>กลับ</button><button className="button primary" disabled={busy || !label.trim()}>{busy ? 'กำลังสร้าง…' : 'สร้างคำเชิญ'}</button></div>
    </form>}
    {busy && <p role="status">คำขออาจถูกส่งแล้ว การปิดหน้าต่างไม่ยกเลิกรายการบนเซิร์ฟเวอร์</p>}
  </Modal>;
}
export function ApproveInvitationDialog({ invitation, busy, onClose, onConfirm }: Common & {
  invitation: InvitationSummary; onConfirm: (verificationCode: string) => void;
}) {
  const [code, setCode] = useState(''); const [confirming, setConfirming] = useState(false);
  return <Modal title={confirming ? 'ยืนยันให้สิทธิ์ผู้ดูแล' : 'ตรวจรหัสผู้รับคำเชิญ'} busy={false} onClose={onClose}>
    <p>{invitation.label}</p><p>บัญชีที่ผูกกับคำเชิญ: {invitation.claimReference}</p><p>รับคำเชิญเมื่อ: {invitation.claimedAt}</p>
    {confirming ? <>
      <p className="notice">{ADMIN_APPROVAL_CONSEQUENCE}</p><p>สิทธิ์จะให้บัญชีที่ผูกกับคำเชิญนี้ ชื่อเรียกไม่ใช่หลักฐานยืนยันตัวตน โปรดยืนยันรหัสกับผู้รับผ่านช่องทางที่รู้จักกัน</p>
      <div className="form-actions"><button className="button secondary" disabled={busy} onClick={() => setConfirming(false)}>กลับไปตรวจรหัส</button><button className="button primary" disabled={busy} onClick={() => onConfirm(code)}>{busy ? 'กำลังให้สิทธิ์…' : 'ยืนยันให้สิทธิ์ผู้ดูแล'}</button></div>
    </> : <form onSubmit={event => { event.preventDefault(); if (/^[0-9]{8}$/.test(code)) setConfirming(true); }}>
      <p>กรอกรหัสที่ผู้รับบอกคุณโดยตรง ตรวจรหัสผิด 5 ครั้งจะล็อกคำเชิญ</p>
      <label className="field">รหัส 8 หลักจากผู้รับ<input type="text" inputMode="numeric" autoComplete="off" pattern="[0-9]{8}" maxLength={8} required value={code} onChange={event => { setCode(event.target.value); setConfirming(false); }} /></label>
      <div className="form-actions"><button type="button" className="button secondary" onClick={onClose}>กลับ</button><button className="button primary" disabled={!/^[0-9]{8}$/.test(code)}>ตรวจสอบและยืนยัน</button></div>
    </form>}
    {busy && <p role="status">คำขออาจถูกส่งแล้ว โปรดตรวจสอบสถานะหากปิดหน้าต่าง</p>}
  </Modal>;
}
export function CloseInvitationDialog({ invitation, action, busy, onClose, onConfirm }: Common & {
  invitation: InvitationSummary; action: 'cancel' | 'reject'; onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState(''); const label = action === 'cancel' ? 'ยกเลิกคำเชิญ' : 'ปฏิเสธคำเชิญ';
  return <Modal title={`ยืนยัน${label}`} busy={false} onClose={onClose}><p>{invitation.label}</p><p>คำเชิญนี้จะใช้ต่อไม่ได้ หากต้องการให้สิทธิ์ต้องสร้างคำเชิญใหม่</p>
    <form onSubmit={event => { event.preventDefault(); if (!busy && reason.trim()) onConfirm(reason.trim()); }}>
      <label className="field">เหตุผล<textarea required maxLength={500} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></label>
      <div className="form-actions"><button type="button" className="button secondary" onClick={onClose}>กลับ</button><button className="button danger" disabled={busy || !reason.trim()}>{`ยืนยัน${label}`}</button></div>
    </form></Modal>;
}
export function RevokeAdminDialog({ member, busy, onClose, onConfirm }: Common & { member: AdminRosterEntry; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  return <Modal title="ยืนยันถอนสิทธิ์ผู้ดูแล" busy={false} onClose={onClose}>
    <p>{member.label ?? 'บัญชีผู้ดูแล'} · {member.reference}</p><p>ให้สิทธิ์เมื่อ: {member.grantedAt}</p>
    <p className="notice">บัญชีนี้จะจัดการนัดหมายหรือเชิญผู้ดูแลเพิ่มไม่ได้ การเข้าถึงนัดหมายของตนเองยังคงอยู่ คำเชิญที่ออกด้วยสิทธิ์นี้จะใช้ต่อไม่ได้</p>
    <form onSubmit={event => { event.preventDefault(); if (!busy && reason.trim()) onConfirm(reason.trim()); }}>
      <label className="field">เหตุผล<textarea required maxLength={500} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></label>
      <div className="form-actions"><button type="button" className="button secondary" onClick={onClose}>กลับ</button><button className="button danger" disabled={busy || !reason.trim()}>ยืนยันถอนสิทธิ์</button></div>
    </form></Modal>;
}
