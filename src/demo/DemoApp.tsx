import { useEffect, useState, useSyncExternalStore } from 'react';
import { CLINIC_NAME } from '../web/copy.th';
import type { Appointment, Service } from '../shared/contracts';
import { AppShell, HomeScreen, Icon, type NavigationItem } from '../web/app';
import { BookingFlow } from '../web/booking/BookingFlow';
import { MyAppointments } from '../web/appointments/MyAppointments';
import { AppointmentDetail } from '../web/appointments/AppointmentDetail';
import { Dashboard } from '../web/admin/Dashboard';
import { createDemoApi, type DemoRole } from './api';
import { createDemoClock, thaiTime } from './clock';
import { DemoInvitationPage } from './DemoInvitationPage';
import { addDays } from './fixtures';

export function DemoApp() {
  const [clock] = useState(createDemoClock);
  const [api] = useState(() => createDemoApi({ now: clock.now }));
  const isAdmin = useSyncExternalStore(api.subscribe, api.isAdmin);
  const [path, setPath] = useState(window.location.pathname);
  const [role, setRole] = useState<DemoRole>('patient');
  const [initialService, setInitialService] = useState<Service>();
  const [submitted, setSubmitted] = useState<Appointment>();
  const [revision, setRevision] = useState(0);
  const [scenarioDate, setScenarioDate] = useState(api.examples.next);
  const [timeInput, setTimeInput] = useState('2026-10-07T10:00');
  useEffect(() => { const back = () => setPath(window.location.pathname); window.addEventListener('popstate', back); return () => window.removeEventListener('popstate', back); }, []);
  function navigate(next: string) { window.history.pushState(null, '', next); setPath(next); }
  function nav(item: NavigationItem) { setInitialService(undefined); navigate(item === 'home' ? '/' : item === 'admin' ? '/demo/admin' : `/${item}`); }
  function switchRole(next: DemoRole) { api.setRole(next); setRole(next); setSubmitted(old => next === 'other' ? undefined : old); navigate(next === 'admin' ? '/demo/admin' : submitted && next === 'patient' ? `/appointments/${submitted.id}` : '/appointments'); setRevision(v => v + 1); }
  function reset() { api.reset(); clock.reset(); setRole('patient'); setSubmitted(undefined); setInitialService(undefined); setScenarioDate(api.examples.next); setTimeInput('2026-10-07T10:00'); setRevision(v => v + 1); navigate('/'); }
  async function simulate(value: string) { clock.set(value); await api.request('/api/demo/reminders', { method: 'POST', body: '{}' }); setRevision(v => v + 1); }
  const activeNav: NavigationItem = ['/demo/admin', '/demo/admin/administrators'].includes(path) ? 'admin' : path.startsWith('/appointments') ? 'appointments' : path === '/booking' ? 'booking' : path === '/contact' ? 'contact' : 'home';
  const detailId = /^\/appointments\/([^/]+)$/.exec(path)?.[1];
  const notices = api.notifications();
  return <AppShell activeNav={activeNav} onNavigate={nav} isAdmin={isAdmin}>
    <section className="demo-controls" aria-label="เครื่องมือสาธิต"><div className="demo-mode-row"><span><strong>{role === 'owner' ? 'เจ้าของระบบสมมติ' : `บัญชี${role === 'other' ? ' B' : ' A'} สมมติ`}</strong><small>ไม่มีการล็อกอินจริง</small></span><div className="demo-mode-buttons"><button className={`button ${role === 'patient' ? 'primary' : 'secondary'}`} onClick={() => switchRole('patient')}>ผู้รับบริการจำลอง</button><button className={`button ${role === 'admin' ? 'primary' : 'secondary'}`} onClick={() => switchRole('admin')}>ผู้ดูแลจำลอง</button><button className="button secondary" onClick={reset}>เริ่มเดโมใหม่</button>{isAdmin && <button className="button secondary" onClick={() => navigate('/demo/admin/administrators')}>จัดการผู้ดูแลจำลอง</button>}{role === 'other' && <button className="button secondary" onClick={() => navigate('/demo/admin-invitation')}>คำเชิญผู้ดูแลจำลอง</button>}</div></div><details><summary>นาฬิกาสาธิต · {thaiTime(clock.now())} น. เวลาไทย</summary><p className="small-copy">เวลาเดโมคงที่ ไม่ใช้เวลาปัจจุบันของเครื่อง เลื่อนเพื่อทดสอบการเตือนและกำหนดเวลา ไม่มีข้อความจริง</p><div className="clock-controls"><label className="field">วันนัดสำหรับสถานการณ์<input type="date" value={scenarioDate} onChange={e => setScenarioDate(e.target.value)} /></label><button className="button secondary" disabled={!scenarioDate} onClick={() => void simulate(`${addDays(scenarioDate, -1)}T18:00:00+07:00`)}>วันก่อนนัด 18:00 · จำลองเตือน</button><button className="button secondary" disabled={!scenarioDate} onClick={() => void simulate(`${scenarioDate}T00:00:00+07:00`)}>วันนัด 00:00 · หมดยกเลิก</button><button className="button secondary" disabled={!scenarioDate} onClick={() => void simulate(`${scenarioDate}T08:30:00+07:00`)}>วันนัด 08:30 · หมดอนุมัติ</button><button className="button secondary" disabled={!scenarioDate} onClick={() => void simulate(`${scenarioDate}T09:30:00+07:00`)}>วันนัด 09:30 · บันทึกผล</button><label className="field">กำหนดเวลาสมมติ (ไทย)<input type="datetime-local" value={timeInput} onChange={e => setTimeInput(e.target.value)} /></label><button className="button secondary" disabled={!timeInput} onClick={() => void simulate(`${timeInput}:00+07:00`)}>ใช้เวลาที่เลือก</button><button className="button secondary" onClick={() => { clock.reset(); setRevision(v => v + 1); }}>คืนเวลาเริ่มต้น</button><button className="button secondary" onClick={() => switchRole('other')}>ลองบัญชี B สมมติ</button></div></details></section>
    <div key={`${path}:${role}:${revision}`}>
      {path === '/' && <HomeScreen onStartBooking={() => { setInitialService(undefined); navigate('/booking'); }} onSelectService={service => { setInitialService(service); navigate('/booking'); }} />}
      {path === '/booking' && <BookingFlow api={api} initialService={initialService} onSubmitted={appointment => { setSubmitted(appointment); navigate(`/appointments/${appointment.id}`); }} />}
      {path === '/appointments' && <MyAppointments api={api} now={clock.now} onSelect={id => navigate(`/appointments/${id}`)} />}
      {detailId && <AppointmentDetail api={api} id={detailId} now={clock.now} showSubmitted={submitted?.id === detailId} onBack={() => navigate('/appointments')} onRebook={() => navigate('/booking')} />}
      {path === '/demo/admin-invitation' && <DemoInvitationPage api={api} />}
      {path === '/demo/admin/administrators' && (isAdmin ? <><p className="notice">ใช้บัญชีและสิทธิ์สมมติเท่านั้น</p><button className="button secondary" onClick={() => { api.setRole(role === 'owner' ? 'admin' : 'owner'); setRole(role === 'owner' ? 'admin' : 'owner'); }}>สลับเจ้าของระบบสมมติ</button><Dashboard api={api} now={clock.now} section="administrators" onSectionChange={section => navigate(section === 'administrators' ? '/demo/admin/administrators' : '/demo/admin')} /></> : <p>ต้องเลือกผู้ดูแลจำลองก่อน</p>)}
      {path === '/demo/admin' && (isAdmin ? <Dashboard api={api} now={clock.now} /> : <p>ต้องเลือกผู้ดูแลจำลองก่อน</p>)}
      {path === '/contact' && <section className="flow-card contact-card"><span className="page-icon"><Icon name="contact" /></span><h1>ติดต่อเรา</h1><p>{CLINIC_NAME}</p><div className="inline-info"><Icon name="clock" />จันทร์–ศุกร์ · 08:30–09:30 น. เวลาไทย</div><p>โทรศัพท์ ที่อยู่ และ LINE OA: ยังไม่ตั้งค่าช่องทางที่ตรวจสอบแล้ว</p><p className="small-copy">ตัวอย่างนี้ไม่มีลิงก์เพิ่มเพื่อน ไม่มีการล็อกอิน LINE และไม่มีการส่งข้อความ หากใช้ระบบจริงในอนาคต ต้องเข้าสู่ระบบผ่านบัญชีที่ตรวจสอบแล้วก่อนดูข้อมูลส่วนตัว</p></section>}
      {!['/', '/booking', '/appointments', '/contact', '/demo/admin', '/demo/admin/administrators', '/demo/admin-invitation'].includes(path) && !detailId && <section className="flow-card"><h1>ไม่พบหน้า</h1><button className="button secondary" onClick={() => navigate('/')}>กลับหน้าหลัก</button></section>}
    </div>
    <section className="simulation-notices" aria-label="ตัวอย่างการแจ้งเตือน"><h2>การแจ้งเตือนจำลอง</h2><p className="small-copy">LINE การเตือน และจำนวนที่ว่างทั้งหมดจำลองในแท็บ ไม่มีการส่งจริง และยังไม่พิสูจน์ความถูกต้องการจองหลายผู้ใช้</p>{notices.length ? notices.map(n => <p className="notice" key={n.id}>{n.text}<small>จำลองเท่านั้น · {thaiTime(new Date(n.at))}</small></p>) : <p className="small-copy">ยังไม่มีข้อความตัวอย่างใหม่ ลองอนุมัติคำขอ หรือจำลองวันก่อนนัด 18:00</p>}</section>
  </AppShell>;
}
export { DemoApp as App };
