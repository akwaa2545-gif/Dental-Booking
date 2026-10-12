import { useEffect, useRef, useState } from 'react';
import type { Appointment } from '../../shared/contracts';
import { ApiRequestError, errorText, verifiedOaLink, type ApiClient } from '../api';
import { FIXED_WINDOW, SERVICE_LABELS, STATUS_LABELS, formatThaiDate } from '../copy.th';
import { Icon } from '../app';
import { CancelDialog } from './CancelDialog';

type Props = { verifiedOaUrl?: string; api: ApiClient; id: string; now?: () => Date; showSubmitted?: boolean; onBack?: () => void; onRebook?: () => void };
export function AppointmentDetail(props: Props) {
  // An opaque route change must never briefly display the previous patient's data.
  return <Detail key={props.id} {...props} />;
}
function Detail({ api, id, now = () => new Date(), showSubmitted = false, onBack, onRebook, verifiedOaUrl = api.dataMode === 'server' ? import.meta.env.VITE_VERIFIED_LINE_OA_URL : undefined }: Props) {
  const [appointment, setAppointment] = useState<Appointment>();
  const [error, setError] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [stale, setStale] = useState(false);
  const [serverCutoffPassed, setServerCutoffPassed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [cutoffRevision, setCutoffRevision] = useState(0);
  const oaLink = verifiedOaLink(verifiedOaUrl);
  const guard = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    let current = true;
    api.request<Appointment>(`/api/appointments/${id}`)
      .then(a => { if (current) { setAppointment(a); setError(''); } })
      .catch(e => { if (current) { setAppointment(undefined); setError(errorText(e)); } });
    return () => { current = false; alive.current = false; };
  }, [api, id]);
  useEffect(() => {
    if (!appointment || !['pending', 'approved'].includes(appointment.status)) return;
    const delay = Date.parse(appointment.cancelBefore) - now().getTime();
    if (delay <= 0) return;
    const timer = window.setTimeout(() => setCutoffRevision(revision => revision + 1), Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [appointment, now, cutoffRevision]);
  async function refresh() {
    if (guard.current) return;
    guard.current = true; setRefreshing(true);
    try {
      const fresh = await api.request<Appointment>(`/api/appointments/${id}`);
      if (alive.current) { setAppointment(fresh); setStale(false); setError(''); }
    } catch (e) {
      if (alive.current) {
        if (e instanceof ApiRequestError && e.code === 'NOT_FOUND') setAppointment(undefined);
        setError(errorText(e));
      }
    } finally { guard.current = false; if (alive.current) setRefreshing(false); }
  }
  async function cancel() {
    if (!appointment || guard.current || stale) return;
    guard.current = true; setError('');
    try {
      const fresh = await api.request<Appointment>(`/api/appointments/${id}/cancel`, { method: 'POST', body: JSON.stringify({ version: appointment.version }) });
      if (alive.current) setAppointment(fresh);
    } catch (e) {
      if (alive.current && e instanceof ApiRequestError && e.code === 'CUTOFF_PASSED') setServerCutoffPassed(true);
      try {
        const fresh = await api.request<Appointment>(`/api/appointments/${id}`);
        if (alive.current) {
          setAppointment(fresh);
          // A lost response is recovered from the authoritative status, not replayed.
          setError(fresh.status === 'cancelled' ? '' : errorText(e));
        }
      } catch (refreshError) {
        if (alive.current) {
          setStale(true); setError(errorText(refreshError));
          if (refreshError instanceof ApiRequestError && refreshError.code === 'NOT_FOUND') setAppointment(undefined);
        }
      }
    } finally { guard.current = false; if (alive.current) setCancelOpen(false); }
  }
  if (error && !appointment) return <section className="flow-card"><h1>{error}</h1><button className="button secondary" onClick={onBack}>กลับไปนัดหมายของฉัน</button>{error !== errorText(new ApiRequestError('NOT_FOUND')) && <button className="button secondary" disabled={refreshing} onClick={() => void refresh()}>ตรวจสอบสถานะล่าสุด</button>}</section>;
  if (!appointment) return <p role="status">กำลังโหลดนัดหมาย…</p>;
  const active = appointment.status === 'pending' || appointment.status === 'approved';
  const cancellable = !stale && !serverCutoffPassed && active && now().getTime() < new Date(appointment.cancelBefore).getTime();
  return <>{showSubmitted && appointment.status === 'pending' && <section className="submitted-card" role="status"><Icon name="check" /><h1>ส่งคำขอแล้ว รอการอนุมัติ</h1><p>การส่งคำขอสำเร็จยังไม่ใช่การยืนยันนัด ตรวจสถานะล่าสุดด้านล่าง</p></section>}<section className="flow-card appointment-detail"><div className="section-heading"><h1>รายละเอียดนัดหมาย</h1><span className={`status-badge ${appointment.status}`}>{STATUS_LABELS[appointment.status]}</span></div><p className="reference">{appointment.reference}</p><dl className="detail-grid"><dt>ผู้รับบริการสมมติ</dt><dd>{appointment.patient.fullName}</dd><dt>บริการ</dt><dd>{SERVICE_LABELS[appointment.service]}</dd><dt>วันที่</dt><dd>{formatThaiDate(appointment.date)}</dd><dt>เวลา</dt><dd>{FIXED_WINDOW} น. · เวลาไทย</dd><dt>เบอร์โทรศัพท์</dt><dd>{appointment.patient.phone}</dd><dt>อายุที่ยืนยัน</dt><dd>{appointment.patient.age} ปี</dd><dt>ที่อยู่บ้าน</dt><dd>{appointment.patient.address}</dd></dl>{appointment.status === 'pending' && <div className="notice">คำขอรอพิจารณา ยังไม่ใช่การยืนยันนัดหมาย ไม่มีการหมดอายุอัตโนมัติ</div>}<p className="small-copy">{api.dataMode === 'server' ? 'สถานะบนเว็บไซต์เป็นหลัก ระบบทดสอบนี้ยังไม่ส่งข้อความ LINE' : 'สถานะบนเว็บไซต์เป็นหลัก การแจ้งเตือนในเดโมเป็นเพียงตัวอย่าง ไม่มีข้อความ LINE จริง'}</p><p className="small-copy">แม้ไม่ได้รับข้อความหรือการแจ้งเตือนไม่สำเร็จ ให้ตรวจสอบสถานะนัดหมายบนเว็บไซต์เสมอ</p><p className="small-copy">หากต้องการรับข้อความ ให้เพิ่มเพื่อนหรือปลดบล็อก LINE OA ของคลินิก</p>{oaLink ? <p><a href={oaLink} target="_blank" rel="noopener noreferrer">เปิด LINE OA ของคลินิก</a></p> : <p className="small-copy">ยังไม่ตั้งค่าลิงก์ LINE OA ที่ตรวจสอบแล้ว</p>}{error && <p role="alert" className="error-text">{error}</p>}{stale && <><p className="notice">ยังยืนยันสถานะล่าสุดไม่ได้ โปรดตรวจสอบสถานะก่อนทำรายการต่อ ไม่มีการยกเลิกซ้ำอัตโนมัติ</p><button className="button secondary" disabled={refreshing} onClick={() => void refresh()}>ตรวจสอบสถานะล่าสุด</button></>}{!stale && active && !cancellable && <p className="notice">วันนัดหรือเลยกำหนดยกเลิกแล้ว โปรดติดต่อคลินิก ช่องทางจริงยังไม่ตั้งค่า</p>}<div className="form-actions"><button className="button secondary" onClick={onBack}>นัดหมายของฉัน</button>{cancellable && <button className="button danger" onClick={() => setCancelOpen(true)}>ยกเลิกนัดหมาย</button>}{appointment.status === 'cancelled' && onRebook && <button className="button primary" onClick={onRebook}>เริ่มคำขอใหม่</button>}</div>{appointment.status === 'cancelled' && <p className="notice">ไม่มีการย้ายนัดอัตโนมัติ หากนัดใหม่ วันที่ใหม่จะยังไม่ถูกจองจนส่งคำขอสำเร็จ</p>}{cancelOpen && cancellable && <CancelDialog appointment={appointment} onConfirm={cancel} onClose={() => setCancelOpen(false)} />}</section></>;
}
