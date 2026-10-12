import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Appointment } from '../../shared/contracts';
import { errorText } from '../api';
import { SERVICE_LABELS, formatThaiDate } from '../copy.th';

/** Native modal supplies browser focus containment; fallback supports the DOM test harness. */
export function Modal({ title, onClose, busy, children, historyEntry = false }: { title: string; onClose: () => void; busy: boolean; children: ReactNode; historyEntry?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef(onClose);
  const historyToken = useRef(crypto.randomUUID());
  const lifetime = useRef(0);
  const working = useRef(busy);
  useEffect(() => { close.current = onClose; working.current = busy; }, [onClose, busy]);
  useEffect(() => {
    const generation = ++lifetime.current;
    const token = historyToken.current;
    const route = window.location.href;
    if (historyEntry && window.history.state?.appointmentDialog !== token) {
      window.history.pushState({ ...window.history.state, appointmentDialog: token }, '', route);
    }
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current!;
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
    dialog.querySelector<HTMLElement>('button, input, textarea')?.focus();
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); if (!working.current) close.current(); } };
    const back = (event: PopStateEvent) => {
      if (historyEntry) {
        if (window.history.state?.appointmentDialog === token) return;
        event.stopImmediatePropagation();
        if (working.current) { window.history.pushState({ ...window.history.state, appointmentDialog: token }, '', route); return; }
      }
      if (!working.current) close.current();
    };
    document.addEventListener('keydown', escape); window.addEventListener('popstate', back, true);
    const releaseHistory = () => {
      if (historyEntry && lifetime.current === generation && window.location.href === route && window.history.state?.appointmentDialog === token) window.history.back();
    };
    return () => {
      document.removeEventListener('keydown', escape); window.removeEventListener('popstate', back, true);
      // Release native modal inertness before restoring focus, including StrictMode replay.
      if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
      previous?.focus();
      // StrictMode re-acquires this dialog before the microtask; real dismissal consumes its entry.
      queueMicrotask(releaseHistory);
    };
  }, [historyEntry]);
  return <dialog className="modal" ref={ref} aria-label={title} aria-modal="true" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}><div className="modal-heading"><h2>{title}</h2><button type="button" className="icon-button" aria-label="ปิดหน้าต่าง" disabled={busy} onClick={onClose}>×</button></div>{children}</dialog>;
}
export function CancelDialog({ appointment, onConfirm, onClose }: { appointment: Appointment; onConfirm: () => Promise<void>; onClose: () => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const guard = useRef(false);
  async function confirm() { if (guard.current) return; guard.current = true; setBusy(true); try { await onConfirm(); onClose(); } catch (e) { setError(errorText(e)); } finally { guard.current = false; setBusy(false); } }
  return <Modal historyEntry title="ยืนยันยกเลิกคำขอ" onClose={onClose} busy={busy}><p>{appointment.patient.fullName} · {SERVICE_LABELS[appointment.service]}</p><p>{formatThaiDate(appointment.date)}</p><div className="notice">การยกเลิกคืนที่ว่างทันที หากนัดใหม่ วันที่ใหม่จะยังไม่ถูกจองจนส่งคำขอสำเร็จ</div>{error && <p role="alert" className="error-text">{error}</p>}<div className="form-actions"><button className="button secondary" disabled={busy} onClick={onClose}>กลับไปดูนัด</button><button className="button danger" disabled={busy} onClick={() => void confirm()}>{busy ? 'กำลังยกเลิก…' : 'ยืนยันยกเลิก'}</button></div></Modal>;
}
