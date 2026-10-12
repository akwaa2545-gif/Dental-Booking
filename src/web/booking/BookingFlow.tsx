import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Appointment, Availability, Patient, Service } from '../../shared/contracts';
import { ApiRequestError, errorText, type ApiClient } from '../api';
import { Icon } from '../app';
import { FIXED_WINDOW, SERVICES, SERVICE_LABELS } from '../copy.th';
import { PatientForm, type PatientDraft } from './PatientForm';
import { DateCalendar } from './DateCalendar';
import { ReviewRequest } from './ReviewRequest';
import scalingImage from '../assets/service-scaling.webp?inline';
import fillingImage from '../assets/service-filling.webp?inline';
import oralCheckImage from '../assets/service-oral-check.webp?inline';

const serviceImages: Record<Service, string> = { scaling: scalingImage, filling: fillingImage, oral_check: oralCheckImage };
export type SubmissionReceiptOptions = { animate: boolean };

export function BookingFlow({ api, onSubmitted, initialService, active = true }: { active?: boolean; api: ApiClient; onSubmitted: (appointment: Appointment, options: SubmissionReceiptOptions) => void; initialService?: Service }) {
  const [step, setStep] = useState(initialService ? 1 : 0);
  const [service, setService] = useState<Service | null>(initialService ?? null);
  const [patient, setPatient] = useState<Patient>();
  const [patientDraft, setPatientDraft] = useState<PatientDraft>();
  const [date, setDate] = useState<string | null>(null);
  const [days, setDays] = useState<Availability[]>([]);
  const [error, setError] = useState('');
  const [calendarError, setCalendarError] = useState('');
  const [calendarLoading, setCalendarLoading] = useState(true);
  const [uncertain, setUncertain] = useState(false);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const guard = useRef(false);
  const activeRef = useRef(active);
  useEffect(() => { activeRef.current = active; }, [active]);
  const submission = useRef<{ key: string; body: string } | null>(null);
  const flowCard = useRef<HTMLDivElement>(null);
  const submitDock = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const card = flowCard.current;
    const dock = submitDock.current;
    if (step !== 3 || !active || !card || !dock) return;
    const measure = () => {
      const height = dock.getBoundingClientRect().height;
      if (height > 0) card.style.setProperty('--review-dock-height', `${Math.ceil(height)}px`);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    observer?.observe(dock);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [step, uncertain, busy, active]);
  useEffect(() => {
    if (active) flowCard.current?.querySelector<HTMLElement>('h2')?.focus();
  }, [step, active]);
  useEffect(() => {
    let alive = true;
    api.request<Availability[]>('/api/availability')
      .then(data => { if (alive) { setDays(data); setCalendarError(''); } })
      .catch(e => { if (alive) setCalendarError(errorText(e)); })
      .finally(() => { if (alive) setCalendarLoading(false); });
    return () => { alive = false; };
  }, [api]);
  const move = (next: number) => { setStep(next); setError(''); };
  async function submit() {
    if (guard.current || uncertain || !patient || !service || !date) return;
    guard.current = true;
    setBusy(true);
    setError('');
    // Freeze the exact request before the first write. A missing lookup result is
    // not proof that an earlier write cannot still commit, so every retry replays it.
    submission.current ??= {
      key: crypto.randomUUID(),
      body: JSON.stringify({
        patientId: patient.id, patientVersion: patient.version, service, date,
        ageConfirmed: patient.age, authorizationAcknowledged: true,
      }),
    };
    const attempt = submission.current;
    try {
      const appointment = await api.request<Appointment>('/api/appointments', {
        method: 'POST',
        headers: { 'Idempotency-Key': attempt.key },
        body: attempt.body,
      });
      onSubmitted(appointment, { animate: !recoveryPending && activeRef.current && document.visibilityState !== 'hidden' });
    } catch (e) {
      setError(errorText(e));
      if (!recoveryPending && e instanceof ApiRequestError && e.code === 'FULL') {
        setDate(null);
        setStep(2);
        submission.current = null;
        setRecoveryPending(false);
        setCalendarLoading(true);
        try {
          setDays(await api.request('/api/availability'));
          setCalendarError('');
        } catch (refreshError) {
          setDays([]);
          setCalendarError(errorText(refreshError));
        } finally {
          setCalendarLoading(false);
        }
      } else if (recoveryPending || !(e instanceof ApiRequestError) || ['UNAVAILABLE', 'UNAUTHENTICATED'].includes(e.code)) {
        if (recoveryPending) setError('ยังไม่ทราบผลคำขอเดิม โปรดตรวจสอบคำขอเดิมก่อนดำเนินการต่อ');
        setUncertain(true);
        setRecoveryPending(true);
      } else {
        submission.current = null;
        setRecoveryPending(false);
      }
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  async function reloadCalendar() {
    if (guard.current) return;
    guard.current = true;
    setBusy(true);
    setCalendarLoading(true);
    try {
      setDays(await api.request('/api/availability'));
      setCalendarError('');
    } catch (e) {
      setCalendarError(errorText(e));
    } finally {
      guard.current = false;
      setBusy(false);
      setCalendarLoading(false);
    }
  }
  async function checkSubmission() {
    if (guard.current || !submission.current) return;
    guard.current = true;
    setBusy(true);
    try {
      const existing = await api.request<Appointment | null>(`/api/submissions/${submission.current.key}`);
      if (existing) onSubmitted(existing, { animate: false });
      else {
        setUncertain(false);
        setError('ยังไม่พบคำขอเดิม โปรดเลือกส่งต่อด้วยตัวเอง ไม่มีการส่งซ้ำอัตโนมัติ');
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  return <section className="flow-container"><div className="page-title"><span className="page-icon"><Icon name="booking" /></span><div><h1>นัดหมายทันตกรรม</h1><p>เลือกบริการและส่งคำขอสำหรับผู้รับบริการสมมติ</p></div></div><ol className="progress-steps" aria-label="ขั้นตอนคำขอ">{['เลือกบริการ', 'ผู้รับบริการ', 'เลือกวันที่', 'ตรวจสอบ'].map((label, i) => <li key={label} aria-current={i === step ? 'step' : undefined} className={i <= step ? 'active' : ''}><span>{i < step ? '✓' : i + 1}</span>{label}</li>)}</ol><div className={`flow-card${step === 2 ? ' date-flow-card' : step === 3 ? ' review-flow-card' : ''}`} ref={flowCard}>
    {step === 0 && <><h2 tabIndex={-1}>เลือกบริการที่ต้องการ</h2><p className="small-copy">เลือกเพียงหนึ่งบริการต่อคำขอ</p><div className="booking-services">{SERVICES.map(item => <button className="booking-service service-banner" data-service={item} key={item} onClick={() => { setService(item); move(1); }}><img src={serviceImages[item]} alt="" /><span className="banner-copy"><strong>{SERVICE_LABELS[item]}</strong></span><span className="banner-selection"><Icon name="arrow" /></span></button>)}</div></>}
    {step === 1 && <PatientForm api={api} initial={patient} initialDraft={patientDraft} onContinue={p => { setPatient(p); setPatientDraft(undefined); move(2); }} onBack={draft => { setPatientDraft(draft); move(0); }} />}
    {step === 2 && <><h2 tabIndex={-1}>เลือกวันนัดหมาย</h2><p className="small-copy">ล่วงหน้า 1–90 วัน · รวมทุกบริการ 3 คนต่อวัน · คำขอรออนุมัติก็ใช้ที่ว่าง</p><div className="date-layout"><div>
      {calendarError && <><p role="alert" className="error-text">โหลดวันนัดหมายไม่สำเร็จ · {calendarError}</p><button className="button secondary" disabled={busy} onClick={() => void reloadCalendar()}>โหลดวันนัดหมายใหม่</button></>}
      {calendarLoading ? <p role="status">กำลังโหลดวันนัดหมาย…</p> : days.length ? <DateCalendar days={days} value={date} onChange={setDate} /> : !calendarError && <p role="status">ยังไม่มีวันนัดหมายให้เลือก</p>}
    </div><aside className="date-summary"><Icon name="clock" /><h3>เวลารับนัดคงที่</h3><strong>{FIXED_WINDOW} น.</strong><p>จันทร์–ศุกร์ · เวลาไทย</p><p>ทันตแพทย์ประจำหนึ่งคน<br />ไม่มีตัวเลือกช่วงเวลา</p></aside></div><div className="form-actions"><button className="button secondary" onClick={() => move(1)}>ย้อนกลับ</button><button className="button primary" disabled={!date} onClick={() => move(3)}>ถัดไป</button></div></>}
    {step === 3 && patient && service && date && <><ReviewRequest patient={patient} service={service} date={date} dataMode={api.dataMode} />{recoveryPending && <p className="notice">เก็บข้อมูลคำขอเดิมไว้ระหว่างตรวจสอบผล ยังแก้ไขหรือเปลี่ยนวันไม่ได้ หากเซสชันสิ้นสุด ให้เข้าสู่ระบบอีกครั้งแล้วตรวจสอบคำขอเดิมก่อนส่งต่อ</p>}<div className="form-actions review-submit-dock" ref={submitDock}><button className="button secondary" disabled={busy || recoveryPending} onClick={() => move(2)}>ย้อนกลับ</button>{uncertain ? <button className="button primary" disabled={busy} onClick={() => void checkSubmission()}>ตรวจสอบคำขอเดิม</button> : <button className="button primary" disabled={busy} onClick={() => void submit()}>{busy ? 'กำลังส่งคำขอ…' : 'ส่งคำขอนัดหมาย'}</button>}</div></>}
    {error && <p role="alert" className="error-text">{error}</p>}
  </div></section>;
}
