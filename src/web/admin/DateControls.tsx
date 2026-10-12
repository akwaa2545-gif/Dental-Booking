import { useRef, useState } from 'react';
import type { Appointment, Intake } from '../../shared/contracts';
import { ApiRequestError, errorText, type ApiClient } from '../api';
import { SERVICE_LABELS, STATUS_LABELS } from '../copy.th';

export function DateControls({ api, date, unresolved, onChanged, onAccessLost, onUncertain }: {
  api: ApiClient;
  date: string;
  unresolved: Appointment[];
  onChanged: () => Promise<void>;
  onAccessLost?: (failure: ApiRequestError) => void;
  onUncertain?: (failure: unknown) => void;
}) {
  const [intake, setIntake] = useState<Intake>('paused');
  const [reason, setReason] = useState(api.dataMode === 'server' ? '' : 'เปลี่ยนการรับคำขอเพื่อสาธิต');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);

  async function change() {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setError('');
    try {
      await api.request(`/api/admin/dates/${date}`, { method: 'PUT', body: JSON.stringify({ intake, reason }) });
      await onChanged();
    } catch (e) {
      if (e instanceof ApiRequestError && [401, 403].includes(e.status)) onAccessLost?.(e);
      if (e instanceof ApiRequestError && e.code === 'UNRESOLVED_BOOKINGS') {
        try { await onChanged(); } catch (refreshError) {
          setError(errorText(e) + ' ' + errorText(refreshError));
          return;
        }
      }
      if (!(e instanceof ApiRequestError) || e.code === 'UNAVAILABLE' || e.status >= 500 || e.status === 408) onUncertain?.(e);
      setError(errorText(e));
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }

  return <section className="date-controls">
    <h2>ควบคุมการรับคำขอ</h2>
    <p className="small-copy">วันที่ {date} · คำขอ/นัดที่ยังต้องจัดการ {unresolved.length} รายการ การหยุดรับคงสถานะเดิม และห้ามอนุมัติใหม่</p>
    <section aria-label="คำขอและนัดที่ยังต้องจัดการ">
      <h3>คำขอและนัดที่ยังต้องจัดการ</h3>
      <p className="small-copy">แสดงทุกรายการรออนุมัติและอนุมัติแล้วของวันที่เลือก โดยไม่ขึ้นกับตัวกรองคิว</p>
      {unresolved.length ? <ul className="resolution-list">{unresolved.map(appointment => <li key={appointment.id}>
        <strong>{appointment.patient.fullName}</strong>
        <span>{SERVICE_LABELS[appointment.service]}</span>
        <span className={`status-badge ${appointment.status}`}>{STATUS_LABELS[appointment.status]}</span>
        <p className="small-copy">{appointment.status === 'pending'
          ? 'พิจารณาไม่อนุมัติเป็นรายคน หรือผู้รับบริการยกเลิกก่อนกำหนด'
          : 'นัดอนุมัติแล้วยังขวางการปิดวัน ใช้ปุ่มจัดการนัดหมายเพื่อยกเลิกโดยคลินิกพร้อมเหตุผล หรือผู้รับบริการยกเลิกก่อนกำหนด'}</p>
      </li>)}</ul> : <p className="small-copy">ไม่มีคำขอหรือนัดที่ยังต้องจัดการในวันที่เลือก</p>}
    </section>
    <form onSubmit={e => { e.preventDefault(); void change(); }}>
      <label className="field">การรับคำขอ<select disabled={busy} value={intake} onChange={e => setIntake(e.target.value as Intake)}>
        <option value="open">เปิดรับคำขอ</option><option value="paused">หยุดรับคำขอชั่วคราว</option><option value="closed">ปิดรับนัด</option>
      </select></label>
      <label className="field">เหตุผลการเปลี่ยนแปลง<input disabled={busy} required maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></label>
      <button className="button secondary" disabled={busy || !reason.trim()}>บันทึกการรับคำขอ</button>
    </form>
    {error && <p role="alert" className="error-text">{error}</p>}
    <p className="small-copy">ปิดวันได้เมื่อไม่มีคำขอรออนุมัติ/อนุมัติแล้ว คำขอรออนุมัติอาจไม่อนุมัติเป็นรายคน หรือผู้รับบริการยกเลิกก่อนกำหนดได้ นัดอนุมัติแล้วคลินิกยกเลิกพร้อมเหตุผลเป็นรายคนได้ ไม่มีการยกเลิกจำนวนมากหรือย้ายนัดอัตโนมัติ</p>
  </section>;
}
