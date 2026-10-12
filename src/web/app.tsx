import clinicSeal from './assets/clinic-seal.png?inline';
import clinicBuilding from './assets/clinic-building.webp?inline';
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Service } from '../shared/contracts';
import { CLINIC_NAME, CLINIC_SHORT_NAME, FIXED_WINDOW, SERVICE_LABELS, SERVICES, TEST_DATA_BANNER } from './copy.th';

export type NavigationItem = 'home' | 'booking' | 'appointments' | 'contact' | 'admin';
type IconName = NavigationItem | 'arrow' | 'clock' | 'shield' | 'check' | 'info' | 'tooth';

export function Icon({ name, className = '' }: { name: IconName; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    home: <><path d="m3 11 9-8 9 8" /><path d="M5 10v11h5v-7h4v7h5V10" /></>,
    booking: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M7 3v4m10-4v4M3 10h18m-14 4h2m3 0h2m3 0h1m-11 3h2m3 0h2" /></>,
    appointments: <><rect x="5" y="4" width="14" height="18" rx="2" /><path d="M9 2h6v4H9zm0 9h6m-6 4h6m-6 4h4" /></>,
    contact: <><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5 10 10 0 0 1-4-.8L3 21l1.8-5.5a10 10 0 0 1-.8-4A8.5 8.5 0 0 1 12.5 3H13a8.5 8.5 0 0 1 8 8v.5Z" /><path d="M8 11h.01M12 11h.01M16 11h.01" /></>,
    admin: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6m0-10h.01" /></>,
    tooth: <path d="M12 5c-2-2-6-2-8 1-2 4 0 9 2 13 1 2 3 2 3-1l1-5c1-2 3-2 4 0l1 5c0 3 2 3 3 1 2-4 4-9 2-13-2-3-6-3-8-1Z" />,
  };
  return <svg className={`icon ${className}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

/** Original, affiliation-free tooth artwork. No external asset requests. */
export function ToothArt() {
  return <svg className="tooth-art" viewBox="0 0 440 360" fill="none" aria-hidden="true">
    <defs>
      <linearGradient id="tooth-shade" x1="161" y1="108" x2="289" y2="280" gradientUnits="userSpaceOnUse"><stop stopColor="white" /><stop offset="1" stopColor="#e6f7ff" /></linearGradient>
      <linearGradient id="brush-shade" x1="310" y1="98" x2="351" y2="259"><stop stopColor="#36bfd5" /><stop offset="1" stopColor="#0d81bd" /></linearGradient>
    </defs>
    <circle cx="232" cy="177" r="139" fill="#c8edfb" opacity=".75" />
    <circle cx="263" cy="151" r="100" fill="#e8f9ff" />
    <ellipse cx="234" cy="303" rx="135" ry="17" fill="#a2dce9" opacity=".55" />
    <path d="M82 285c-10-54-32-76-58-93 0 44 24 80 58 93Z" fill="#80c8b8" />
    <path d="M84 287c-1-48 17-72 44-85 1 38-15 72-44 85Z" fill="#b5dfcc" />
    <path d="M367 285c4-38 22-56 46-65-4 32-20 55-46 65Z" fill="#85ccb8" />
    <path d="M366 285c0-27-11-46-27-58-5 28 10 50 27 58Z" fill="#b2e0cd" />
    <path d="m103 81 4-14 4 14 14 4-14 4-4 14-4-14-14-4 14-4Z" fill="#55b8d6" />
    <path d="m364 66 3-11 3 11 11 3-11 3-3 11-3-11-11-3 11-3Z" fill="#67bdd6" />
    <circle cx="124" cy="135" r="5" fill="#76d4d7" /><circle cx="368" cy="157" r="5" fill="#76d4d7" />
    <g transform="rotate(16 335 180)"><rect x="322" y="140" width="20" height="130" rx="10" fill="url(#brush-shade)" /><rect x="312" y="96" width="35" height="62" rx="14" fill="#0e86bc" /><path d="M317 106h21m-21 9h21m-21 9h21m-21 9h21m-21 9h21" stroke="white" strokeWidth="5" strokeLinecap="round" /></g>
    <path d="M216 116c-39-27-83-5-80 36 2 33 16 66 33 105 13 29 27 33 34 3l10-41c4-18 16-19 22 0l12 41c9 30 22 25 33-3 16-40 34-71 34-105 0-41-54-64-98-36Z" fill="url(#tooth-shade)" stroke="#237fad" strokeWidth="4" />
    <path d="M184 115c15 15 38 17 60 7" stroke="#b9e9f8" strokeWidth="7" strokeLinecap="round" />
    <path d="M143 168c-25-13-32-2-23 14l20 21m170-40c22-19 36-7 25 10l-24 19" stroke="#237fad" strokeWidth="4" strokeLinecap="round" />
    <ellipse cx="184" cy="174" rx="5" ry="8" fill="#18506f" /><ellipse cx="260" cy="174" rx="5" ry="8" fill="#18506f" />
    <ellipse cx="174" cy="194" rx="13" ry="7" fill="#fac8cf" /><ellipse cx="271" cy="194" rx="13" ry="7" fill="#fac8cf" />
    <path d="M205 191c7 17 25 17 33 0" fill="#ee7897" stroke="#18506f" strokeWidth="3" strokeLinejoin="round" />
    <path d="M321 59c-7-11-22-3-16 7l16 15 16-15c7-11-9-18-16-7Z" fill="#f1a6be" />
    <rect x="121" y="304" width="229" height="34" rx="17" fill="white" opacity=".92" />
    <path d="m142 321 4 4 8-8" stroke="#2e9989" strokeWidth="3" strokeLinecap="round" />
    <text x="166" y="326" fill="#267896" fontSize="13" fontFamily="Tahoma, sans-serif">ดูแลรอยยิ้ม ด้วยความใส่ใจ</text>
  </svg>;
}

const navItems: { id: NavigationItem; label: string; short: string }[] = [
  { id: 'home', label: 'หน้าหลัก', short: 'หน้าหลัก' },
  { id: 'booking', label: 'นัดหมาย', short: 'นัดหมาย' },
  { id: 'appointments', label: 'นัดหมายของฉัน', short: 'นัดของฉัน' },
  { id: 'contact', label: 'ติดต่อเรา', short: 'ติดต่อ' },
];

export function AppShell({ children, activeNav = 'home', onNavigate, mode = 'demo', navigationDisabled = false, isAdmin = false }: { children: ReactNode; activeNav?: NavigationItem; onNavigate: (nav: NavigationItem) => void; mode?: 'demo' | 'staging'; navigationDisabled?: boolean; isAdmin?: boolean }) {
  const shell = useRef<HTMLDivElement>(null);
  const bottomNav = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const height = bottomNav.current?.getBoundingClientRect().height ?? 0;
      shell.current?.style.setProperty('--bottom-nav-height', `${height}px`);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(measure);
    if (bottomNav.current) observer?.observe(bottomNav.current);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, []);
  const visibleNavItems = isAdmin === true ? [...navItems, { id: 'admin' as const, label: 'แอดมิน', short: 'แอดมิน' }] : navItems;
  return <div className="app-shell" ref={shell}>
    <a className="skip-link" href="#main-content">ข้ามไปเนื้อหาหลัก</a>
    <header className="site-header"><div className="header-inner">
      <button className="brand" disabled={navigationDisabled} onClick={() => onNavigate('home')} aria-label={`${CLINIC_SHORT_NAME} หน้าหลัก`}><img className="brand-seal" src={clinicSeal} width="52" height="52" alt="ตราโรงพยาบาลส่งเสริมสุขภาพตำบลบ้านควนไทรงาม" /><span><strong>ห้องทันตกรรม</strong><small>รพ.สต.บ้านควนไทรงาม</small></span></button>
      <nav className="desktop-nav" aria-label="เมนูเดสก์ท็อป">{visibleNavItems.map(item => <button key={item.id} disabled={navigationDisabled} className={activeNav === item.id ? 'active' : ''} onClick={() => onNavigate(item.id)} aria-current={activeNav === item.id ? 'page' : undefined}>{item.label}</button>)}</nav>
      <span className="demo-pill"><span /> {mode === 'staging' ? 'Staging' : 'โหมดสาธิต'}</span>
    </div></header>
    <main id="main-content" lang="th" className="main-content">
      {children}
    </main>
    <footer className="site-footer"><span>{CLINIC_SHORT_NAME}</span><span className="compact-test-notice" role="status">{mode === 'staging' ? 'Staging · ใช้ข้อมูลสมมติเท่านั้น · อย่ากรอกข้อมูลผู้ป่วยจริง' : `${TEST_DATA_BANNER} · อย่ากรอกข้อมูลผู้ป่วยจริง`}</span></footer>
    <nav ref={bottomNav} className={`bottom-nav${isAdmin === true ? ' has-admin' : ''}`} aria-label="เมนูหลัก">{visibleNavItems.map(item => <button key={item.id} disabled={navigationDisabled} onClick={() => onNavigate(item.id)} className={activeNav === item.id ? 'active' : ''} aria-current={activeNav === item.id ? 'page' : undefined}><Icon name={item.id} /><span>{item.short}</span></button>)}</nav>
  </div>;
}

function ServiceShortcutIcon({ service }: { service: Service }) {
  return <svg data-dental-icon={service} viewBox="0 0 32 32" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d="M11 5.2C7.3 3.5 4.5 6.4 4.5 10c0 3.2 1.8 5.1 2.4 8.5.6 3.5 1.4 8 3.6 8 1.8 0 1.4-8.2 4.5-8.2s2.7 8.2 4.5 8.2c2.2 0 3-4.5 3.6-8 .6-3.4 2.4-5.3 2.4-8.5 0-3.6-2.8-6.5-6.5-4.8-1.3.6-2.5.8-4 .8s-2.7-.2-4-.8z" />
    <path d="M11.2 9.1c1.1.4 2.4.6 3.8.6" opacity=".55" />
    {service === 'oral_check' ? <><circle cx="24" cy="23.5" r="5.5" fill="#eaf3ff" /><path d="m21.5 23.5 1.7 1.8 3.1-3.5" /></> : service === 'scaling' ? <><path d="M25.5 2.2 26.7 5.4 29.8 6.5 26.7 7.7 25.5 10.8 24.3 7.7 21.2 6.5 24.3 5.4z" fill="#eaf3ff" /><path d="M3.5 18v4m-2-2h4" /></> : <><path d="M12.2 11.8c.9-.8 1.8-1.1 2.8-1.1s1.9.3 2.8 1.1v3.5h-5.6z" fill="currentColor" stroke="none" /><path d="M13 13h4" stroke="#eaf3ff" strokeWidth="1.25" /></>}
  </svg>;
}

export function HomeScreen({ onStartBooking, onSelectService, bookingDisabled = false }: { onStartBooking: () => void; onSelectService: (service: Service) => void; bookingDisabled?: boolean }) {
  return <div className="patient-home-page">
    <div className="patient-home">
      <section className="clinic-visual" aria-label="คลินิกของเรา">
        <img className="clinic-photo" src={clinicBuilding} width="960" height="720" alt="อาคารสีชมพูของโรงพยาบาลส่งเสริมสุขภาพตำบลบ้านควนไทรงาม" />
        <div className="clinic-photo-overlay"><div className="clinic-kicker">ห้องทันตกรรม</div><h2>รพ.สต.บ้านควนไทรงาม</h2></div>
      </section>
      <section className="home-intro" aria-labelledby="hero-title">
        <h1 id="hero-title" className="visually-hidden">นัดหมายทันตกรรม</h1>
        <button className="button primary hero-cta home-primary" disabled={bookingDisabled} aria-describedby={bookingDisabled ? 'booking-unavailable' : undefined} onClick={onStartBooking}><Icon name="booking" />เริ่มนัดหมาย<Icon name="arrow" /></button>
        {bookingDisabled && <p id="booking-unavailable">การนัดหมายยังไม่พร้อมใช้งาน</p>}
        <p className="home-soft-note">รอคลินิกอนุมัติเพื่อยืนยันนัดหมาย</p>
      </section>
    </div>
    <section className="services-section home-services" aria-labelledby="services-title">
      <div className="home-services-heading"><h2 id="services-title">บริการทันตกรรมของเรา</h2></div>
      <div className="ios-service-group">{SERVICES.map(service => <button className="home-service" disabled={bookingDisabled} aria-describedby={bookingDisabled ? 'booking-unavailable' : undefined} key={service} onClick={() => onSelectService(service)}><span className="tooth-icon" aria-hidden="true"><ServiceShortcutIcon service={service} /></span><span><strong>{SERVICE_LABELS[service]}</strong></span><Icon name="arrow" /></button>)}</div>
    </section>
  </div>;
}

export function App() {
  const [page, setPage] = useState<NavigationItem>('home');
  return <AppShell activeNav={page} onNavigate={setPage}>
    {page === 'home' ? <HomeScreen onStartBooking={() => setPage('booking')} onSelectService={() => setPage('booking')} /> : <section className="page-card">
      <span className="page-icon"><Icon name={page} /></span>
      <h1>{page === 'booking' ? 'เริ่มต้นคำขอนัดหมาย' : page === 'appointments' ? 'นัดหมายของฉัน' : 'ติดต่อเรา'}</h1>
      <p>{page === 'booking' ? 'เลือกบริการและวันที่ แล้วส่งคำขอเพื่อรอการอนุมัติจากคลินิก' : page === 'appointments' ? 'สถานะนัดหมายจะแสดงที่นี่หลังส่งคำขอในเดโม' : CLINIC_NAME}</p>
      <div className="inline-info"><Icon name="clock" />เวลารับนัด {FIXED_WINDOW} น. · จันทร์–ศุกร์</div>
      <p className="small-copy">หน้านี้เป็นโครงหน้าจอสำหรับเดโม ยังไม่มีการส่งข้อมูลหรือนัดหมายจริง</p>
      <button className="button secondary" onClick={() => setPage('home')}>กลับหน้าหลัก</button>
    </section>}
  </AppShell>;
}
