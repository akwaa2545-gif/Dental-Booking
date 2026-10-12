import { useEffect, useRef, useState } from 'react';
import type { Appointment } from '../../shared/contracts';
import { FIXED_WINDOW, SERVICE_LABELS, STATUS_LABELS, formatThaiDate } from '../copy.th';

type ReceiptProps = { appointment: Appointment; animate: boolean; active?: boolean; dataMode?: 'demo' | 'server'; onAppointments: () => void; onHome: () => void };

/** The caller supplies only the appointment returned by a successful write or lookup. */
export function SubmittedReceipt({ appointment, animate, active = true, dataMode = 'demo', onAppointments, onHome }: ReceiptProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Decide once at mount. Revealing an inactive receipt must never replay success.
  const [playAnimation, setPlayAnimation] = useState(() => animate && active && document.visibilityState !== 'hidden' && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  const announcement = useRef<HTMLParagraphElement>(null);
  if (!active && playAnimation) setPlayAnimation(false);
  const pending = appointment.status === 'pending';
  const title = pending ? 'ส่งคำขอแล้ว รอการอนุมัติ' : 'พบคำขอนัดหมายแล้ว';
  const message = pending ? `${title} ยังไม่ใช่การยืนยันนัดหมาย` : `${title} ${STATUS_LABELS[appointment.status]}`;
  useEffect(() => {
    if (!active) {
      if (announcement.current) announcement.current.textContent = '';
      return;
    }
    let announced = false;
    const announceWhenVisible = () => {
      if (announced || document.visibilityState === 'hidden') return;
      announced = true;
      heading.current?.focus();
      if (announcement.current) announcement.current.textContent = message;
    };
    announceWhenVisible();
    document.addEventListener('visibilitychange', announceWhenVisible);
    return () => document.removeEventListener('visibilitychange', announceWhenVisible);
  }, [active, message]);
  return <section className="flow-container receipt-shell" aria-labelledby="receipt-title">
    <div className="flow-card receipt-card">
      <div className={`receipt-animation${playAnimation && active ? ' receipt-enter' : ''}`} aria-hidden="true">
        <span className="receipt-halo halo-outer" /><span className="receipt-halo halo-inner" />
        <span className="receipt-check"><svg viewBox="0 0 48 48" focusable="false"><path d="M12 25l8 8 17-19" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
      </div>
      <span className="receipt-kicker">คำขอนัดหมาย · {dataMode === 'server' ? 'ระบบทดสอบ Staging' : 'โหมดสาธิต'}</span>
      <h1 id="receipt-title" tabIndex={-1} ref={heading}>{title}</h1>
      <p className="receipt-subtitle">{pending ? <>รอคลินิกอนุมัติ<br />ยังไม่ใช่การยืนยันนัดหมาย</> : 'ติดตามรายละเอียดและสถานะล่าสุดได้ในนัดหมายของฉัน'}</p>
      <article className="receipt-summary" aria-label="สรุปคำขอนัดหมาย">
        <div className="receipt-reference"><span>เลขคำขอ</span><strong>{appointment.reference}</strong></div>
        <dl><dt>บริการ</dt><dd>{SERVICE_LABELS[appointment.service]}</dd><dt>วันที่</dt><dd>{formatThaiDate(appointment.date)}</dd><dt>เวลา</dt><dd>{FIXED_WINDOW} น. · เวลาไทย</dd><dt>ผู้รับบริการ</dt><dd>{appointment.patient.fullName}</dd></dl>
        <span className={`status ${appointment.status}`}>{pending ? 'รอคลินิกอนุมัติ' : STATUS_LABELS[appointment.status]}</span>
      </article>
      <p className="receipt-demo-note">{dataMode === 'server' ? 'ข้อมูลสมมติถูกบันทึกในระบบทดสอบ โหลดหน้าใหม่ไม่ลบข้อมูล ยังไม่เปิดรับนัดหมายจริง' : 'ข้อมูลสมมติอยู่ในหน่วยความจำของแท็บเท่านั้น ไม่มีการส่งข้อมูลหรือ LINE จริง'}</p>
      <div className="receipt-actions"><button className="button primary" onClick={onAppointments}>ดูนัดหมายของฉัน</button><button className="button secondary text-button" onClick={onHome}>กลับหน้าหลัก</button></div>
    </div>
    <p ref={announcement} className="visually-hidden" role="status" aria-live="polite" aria-atomic="true" />
  </section>;
}
