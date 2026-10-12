import { useEffect, useState } from 'react';
import type { Appointment, AdminAppointment, Availability, Decision, Status } from '../../shared/contracts';
import { bangkokDate } from '../../shared/calendar';
import { ApiRequestError, errorText, type ApiClient } from '../api';
import { FIXED_WINDOW, SERVICE_LABELS, STATUS_LABELS, formatThaiDate } from '../copy.th';
import { DecisionDialog } from './DecisionDialog';
import { AdminNotificationStatus } from './AdminNotificationStatus';
import { NotificationReadiness } from './NotificationReadiness';
import { DateControls } from './DateControls';
import { AdminMenu, Overview, UpcomingDays, AdminCalendar, NotificationHistory } from './WorkspaceViews';
import { AdminManagement } from './AdminManagement';
import { ADMIN_SECTIONS, type AdminSection } from './workspace';
export type { AdminSection } from './workspace';

export function Dashboard({ api, now, section, onSectionChange }: { api: ApiClient; now: () => Date; section?: AdminSection; onSectionChange?: (section: AdminSection) => void }) {
  const [localSection, setLocalSection] = useState<AdminSection>('overview');
  const activeSection = section ?? localSection;
  const workspace = section !== undefined;
  const changeSection = onSectionChange ?? setLocalSection;
  if (activeSection === 'administrators') return <div className="admin-workspace"><AdminMenu section={activeSection} onChange={changeSection} /><AdminManagement api={api} /></div>;
  return <AppointmentDashboard api={api} now={now} activeSection={activeSection} workspace={workspace} changeSection={changeSection} />;
}
function AppointmentDashboard({ api, now, activeSection, workspace, changeSection }: { api: ApiClient; now: () => Date; activeSection: AdminSection; workspace: boolean; changeSection: (section: AdminSection) => void }) {
  const [loaded, setLoaded] = useState(false);
  const [date, setDate] = useState('');
  const [status, setStatus] = useState<Status | ''>('pending');
  const [all, setAll] = useState<(Appointment & Partial<AdminAppointment>)[]>([]);
  const [days, setDays] = useState<Availability[]>([]);
  const [selected, setSelected] = useState<Appointment>();
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.request<AdminAppointment[]>('/api/admin/appointments'),
      api.request<Availability[]>('/api/availability'),
    ]).then(([items, availability]) => {
      if (!alive) return;
      setAll(items); setLoaded(true);
      setDays(availability);
      // Full is still open for clinic review; remaining seats do not define the queue.
      const nextOpen = availability.find(day => day.state === 'available' || day.state === 'full');
      setDate(nextOpen?.date ?? bangkokDate(now()));
    }).catch(e => {
      if (!alive) return;
      if (e instanceof ApiRequestError && [401, 403].includes(e.status)) clearPrivate(e);
      else setError(errorText(e));
    });
    return () => { alive = false; };
  }, [api, now]);

  function clearPrivate(failure: ApiRequestError) {
    setLoaded(false); setAll([]); setSelected(undefined); setDays([]); setDate(''); setError(errorText(failure));
  }

  async function refresh() {
    try {
    const [items, availability] = await Promise.all([
      api.request<AdminAppointment[]>('/api/admin/appointments'),
      api.request<Availability[]>('/api/availability'),
    ]);
    if (!loaded) setDate(availability.find(day => day.state === 'available' || day.state === 'full')?.date ?? bangkokDate(now()));
    setAll(items); setLoaded(true);
    setDays(availability);
    setStale(false);
    return items;
    } catch (failure) {
      if (failure instanceof ApiRequestError && [401, 403].includes(failure.status)) {
        clearPrivate(failure);
      }
      if (workspace) { setStale(true); setError(errorText(failure)); }
      throw failure;
    }
  }

  async function decide(decision: Decision, reason: string) {
    if (!selected || stale) return;
    try {
      await api.request(`/api/admin/appointments/${selected.id}/decision`, {
        method: 'POST', body: JSON.stringify({ version: selected.version, decision, reason }),
      });
      await refresh();
    } catch (e) {
      if (e instanceof ApiRequestError && [401, 403].includes(e.status)) {
        clearPrivate(e);
        throw e;
      }
      let latest: AdminAppointment[];
      try {
        latest = await refresh();
      } catch (refreshError) {
        setSelected(undefined);
        setStale(true);
        setError(errorText(refreshError));
        throw refreshError;
      }
      const current = latest.find(appointment => appointment.id === selected.id);
      // A response may be lost after the cancellation committed. The fresh
      // cancelled state is enough to stop; never repeat the mutation.
      if (decision === 'cancel' && current?.status === 'cancelled' && current.version > selected.version) return;
      setSelected(current);
      throw e;
    }
  }

  async function recover() {
    setRefreshing(true);
    try { await refresh(); setError(''); }
    catch (e) { setError(errorText(e)); }
    finally { setRefreshing(false); }
  }

  const records = all.filter(appointment =>
    workspace && activeSection === 'schedule' && !date ? false :
    workspace && activeSection === 'overview' ? appointment.status === 'pending' :
    workspace && activeSection === 'intake' ? appointment.date === date && (appointment.status === 'pending' || appointment.status === 'approved') :
    (!date || appointment.date === date) && (workspace && activeSection === 'schedule' ? true : !status || appointment.status === status)).sort((a,b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  // Resolution is deliberately independent of the normal status-filtered queue.
  const unresolved = all.filter(appointment => appointment.date === date &&
    (appointment.status === 'pending' || appointment.status === 'approved'));
  const day = days.find(item => item.date === date);
  const tomorrow = new Date(new Date(`${bangkokDate(now())}T12:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);

  return <div className={workspace ? 'admin-workspace' : undefined}>
    {workspace && <AdminMenu section={activeSection} onChange={changeSection} />}
    <section className="admin-dashboard">
    {workspace && <div className="page-title"><span className="eyebrow muted">TOOTHTALK · CLINIC</span><h1>{ADMIN_SECTIONS.find(item => item.id === activeSection)?.label}</h1><p>ข้อมูลสมมติสำหรับทดสอบระบบเท่านั้น ห้ามใช้ข้อมูลผู้ป่วยจริง</p></div>}
    {!workspace && <>
    <div className="page-title"><h1>{api.dataMode === 'server' ? 'จัดการนัดหมาย' : 'ผู้ดูแลจำลอง'}</h1><p>{api.dataMode === 'server' ? 'ข้อมูลสมมติสำหรับทดสอบระบบเท่านั้น ห้ามใช้ข้อมูลผู้ป่วยจริง' : 'สวิตช์นี้ใช้สาธิต ไม่ใช่การเข้าสู่ระบบหรือการควบคุมสิทธิ์จริง'}</p></div>
    </>}
    {(!workspace || activeSection === 'queue' || activeSection === 'intake') && <section className="admin-filters" aria-label="ตัวกรองคำขอ">
      <label className="field">วันที่นัด<input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
      {(!workspace || activeSection === 'queue') && <><label className="field">สถานะคำขอ<select value={status} onChange={e => setStatus(e.target.value as Status | '')}>
        <option value="">ทุกสถานะ</option>
        {Object.entries(STATUS_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
      </select></label>
      <button className="button secondary" onClick={() => { setDate(''); setStatus(''); }}>ดูทุกวันและสถานะ</button></>}
    </section>}
    {workspace && !loaded && !error && <p role="status">กำลังโหลดข้อมูลผู้ดูแล…</p>}
    {workspace && loaded && activeSection === 'overview' && <Overview items={all} days={days} onChange={changeSection} />}
    {workspace && loaded && activeSection === 'schedule' && <AdminCalendar days={days} items={all} date={date} onSelect={setDate} />}
    {(!workspace || (loaded && ['queue', 'schedule', 'intake'].includes(activeSection))) && <section className="admin-summary" aria-label="สรุปวันที่เลือก">
      <div className="admin-summary-card"><strong>{workspace && !date ? 'ทุกวัน · ยังไม่เลือกวันที่' : `${unresolved.length}/3 ที่ใช้ในวันที่เลือก`}</strong></div>
      <div className="admin-summary-card"><span>{workspace && !day ? 'ไม่มีข้อมูลวันที่เลือก' : workspace && day?.state === 'ineligible' ? 'นอกวันรับนัด' : day?.state === 'paused' ? 'หยุดรับคำขอ' : day?.state === 'closed' ? 'ปิดรับนัด' : day?.state === 'full' ? 'เต็ม' : 'รับคำขอได้ตามปฏิทิน'}</span></div>
      <div className="admin-summary-card"><span>{FIXED_WINDOW} น. เวลาไทย</span></div>
    </section>
    }
    {error && <p role="alert">{error}</p>}
    {(stale || (workspace && !loaded && error)) && <><p className="notice">ยังยืนยันสถานะล่าสุดไม่ได้ โปรดตรวจสอบสถานะก่อนทำรายการต่อ ไม่มีการส่งซ้ำอัตโนมัติ</p><button className="button secondary" disabled={refreshing} onClick={() => void recover()}>ตรวจสอบสถานะล่าสุด</button></>}
    {(!workspace || (loaded && activeSection !== 'notifications')) && <section className="admin-queue" aria-label="รายการคำขอนัดหมาย">
      <div className="appointment-grid">{records.map(appointment => <article className="appointment-card admin-appointment-card" key={appointment.id}>
        <div className="card-top"><span className="reference">{appointment.reference}</span><span className={`status-badge ${appointment.status}`}>{STATUS_LABELS[appointment.status]}</span></div>
        <div className="admin-card-details">
          <h2>{appointment.patient.fullName}</h2>
          <p>{SERVICE_LABELS[appointment.service]} · {formatThaiDate(appointment.date)}</p>
          <p className="small-copy">รอมาแล้ว {Math.max(0, Math.floor((now().getTime() - new Date(appointment.createdAt).getTime()) / 3600000))} ชั่วโมง · {appointment.date === tomorrow ? 'นัดวันพรุ่งนี้' : 'ตามวันที่เลือก'}</p>
        </div>
        {api.dataMode === 'server' ? <div className="small-copy admin-notifications">การแจ้งเตือน: {appointment.notificationAttempts?.length ? <ul>{appointment.notificationAttempts.map((notice,index) => <li key={index}>{({approval:'ยืนยันอนุมัติ',rejection:'แจ้งไม่อนุมัติ',cancellation:'แจ้งคลินิกยกเลิก',reminder:'เตือนก่อนนัด'})[notice.kind]} · {({queued:'รอส่ง',leased:'กำลังดำเนินการ',retry:'รอลองใหม่',accepted:'ผู้ให้บริการรับแล้ว',suppressed:'ระงับการส่ง',failed:'ส่งไม่สำเร็จ'})[notice.state]} · พยายามส่ง {notice.attemptCount} ครั้ง</li>)}</ul> : 'ยังไม่มีรายการส่ง'}</div> : <p className="small-copy admin-notifications">การแจ้งเตือน: {appointment.status === 'approved' || appointment.status === 'rejected' ? 'ตัวอย่างเท่านั้น ไม่มีการส่งจริง' : 'ยังไม่มีการส่งจริง'}</p>}
        {api.dataMode === 'server' && <AdminNotificationStatus items={appointment.adminNotificationAttempts ?? []} />}
        {(appointment.status === 'pending' || appointment.status === 'approved') && <div className="admin-card-actions"><button className="button secondary" disabled={stale} onClick={() => setSelected(appointment)}>{appointment.status === 'pending' ? 'พิจารณาคำขอ' : 'จัดการนัดหมาย'}</button></div>}
      </article>)}</div>
      {!records.length && <p className="empty-state">{workspace && activeSection === 'schedule' && !date ? 'เลือกวันจากปฏิทินเพื่อดูรายการ' : 'ไม่พบคำขอในตัวกรองนี้'}</p>}
    </section>
    }
    {workspace && loaded && activeSection === 'overview' && <UpcomingDays days={days} items={all} onSelect={value => { setDate(value); changeSection('schedule'); }} />}
    {workspace && activeSection === 'notifications' && api.dataMode === 'server' && <NotificationReadiness api={api} now={now} />}
    {workspace && loaded && activeSection === 'notifications' && <NotificationHistory items={all} />}
    {date && (!workspace || (loaded && !stale && activeSection === 'intake' && day)) && <DateControls key={date} api={api} date={date} unresolved={unresolved} onAccessLost={clearPrivate} onUncertain={workspace ? failure => { setStale(true); setError(errorText(failure)); } : undefined} onChanged={async () => { await refresh(); }} />}
    {selected && <DecisionDialog dataMode={api.dataMode} appointment={selected} onConfirm={decide} onClose={() => setSelected(undefined)} />}
  </section></div>;
}
