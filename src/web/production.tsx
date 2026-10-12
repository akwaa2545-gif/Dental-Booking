import clinicSeal from './assets/clinic-seal.png?inline';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Appointment, Service } from '../shared/contracts';
import { AppShell, HomeScreen, type NavigationItem } from './app';
import { createBrowserApi, ApiRequestError, SessionRefreshError } from './api';
import { createLiffBootstrap, fingerprintLiffToken, LiffSetupUnavailableError, LiffAuthError, authDiagnosticText, type LiffBootstrapOptions, type LiffSession, type LiffAuthRecovery } from './liff';
import { BookingFlow } from './booking/BookingFlow';
import { SubmittedReceipt } from './booking/SubmittedReceipt';
import { MyAppointments } from './appointments/MyAppointments';
import { AppointmentDetail } from './appointments/AppointmentDetail';
import { Dashboard, type AdminSection } from './admin/Dashboard';
import { ManualApprovalControl } from './admin/ManualApprovalControl';
import { CLINIC_NAME, CLINIC_SHORT_NAME } from './copy.th';
import { InvitationPage } from './invitations/InvitationPage';
import { clearInvitationContext, invitationStorage } from './invitations/context';

const currentTime = () => new Date();
function discardInvitationContext() { const storage = invitationStorage(); if (storage) clearInvitationContext(storage); }
const adminRoutes: Partial<Record<string, AdminSection>> = {
  '/admin': 'overview',
  '/admin/queue': 'queue',
  '/admin/schedule': 'schedule',
  '/admin/intake': 'intake',
  '/admin/notifications': 'notifications',
  '/admin/administrators': 'administrators',
};
function adminPath(section: AdminSection) { return section === 'overview' ? '/admin' : `/admin/${section}`; }
const uncertainLogoutMessage = 'ยังยืนยันการออกจากระบบบนเซิร์ฟเวอร์ไม่ได้ ข้อมูลส่วนตัวถูกซ่อนแล้ว โปรดเข้าสู่ระบบใหม่เพื่อตรวจสอบ';
type Config = Pick<LiffBootstrapOptions, 'liffId' | 'staging' | 'origin'>;
type Props = { config?: Config; fetcher?: typeof fetch; now?: () => Date; loadSdk?: LiffBootstrapOptions['loadSdk'] };
type AuthState = { kind: 'loading' | 'redirecting' | 'signing-out' | 'signed-out' | 'invitation-cancelled' | 'setup-blocked' } | { kind: 'error'; message: string; diagnostic?: string; recovery?: LiffAuthRecovery; pendingRecovery?: true } | { kind: 'ready'; value: LiffSession; generation: number };

/** Genuine LIFF/server runtime. Test-only props are dependency seams, never URL identity switches. */
export function App({ config, fetcher, now = currentTime, loadSdk }: Props = {}) {
  const [options] = useState<LiffBootstrapOptions>(() => ({
    ...(config ?? { liffId: import.meta.env.VITE_LIFF_ID ?? '', staging: import.meta.env.VITE_APP_STAGE === 'synthetic-staging', origin: window.location.origin }),
    fetch: fetcher, now, loadSdk,
  }));
  const [initialController] = useState(() => new AbortController());
  const activeController = useRef(initialController);
  const [bootstrap, setBootstrap] = useState(() => createLiffBootstrap({ ...options, signal: initialController.signal }));
  const [auth, setAuth] = useState<AuthState>({ kind: 'loading' });
  const [recovering, setRecovering] = useState(false);
  const [recoveryAction, setRecoveryAction] = useState<'idle' | 'started' | 'failed'>('idle');
  const recoveryGuard = useRef(false);
  const attempt = useRef(0);
  useEffect(() => () => { attempt.current += 1; }, []);
  useEffect(() => {
    let alive = true;
    const generation = attempt.current;
    bootstrap().then(value => { if (alive && generation === attempt.current) setAuth(value ? { kind: 'ready', value, generation } : { kind: 'redirecting' }); })
      .catch(error => { if (alive && generation === attempt.current) setAuth(error instanceof LiffSetupUnavailableError ? { kind: 'setup-blocked' } : { kind: 'error', message: 'เข้าสู่ระบบแอปไม่สำเร็จ โปรดลองเข้าสู่ระบบอีกครั้ง', diagnostic: error instanceof LiffAuthError ? authDiagnosticText(error) : undefined, recovery: error instanceof LiffAuthError ? error.recovery : undefined }); });
    return () => { alive = false; };
  }, [bootstrap]);
  useEffect(() => {
    if (!['loading', 'redirecting', 'signing-out'].includes(auth.kind)) return;
    // Bound the waiting screen only. This neither retries a request nor grants a session.
    // The operation may still affect SDK state or cookies, so no parallel attempt is offered.
    const timeout = window.setTimeout(() => setAuth(current => current === auth ? {
      kind: 'error', pendingRecovery: true,
      message: auth.kind === 'signing-out' ? uncertainLogoutMessage : 'การเชื่อมต่อใช้เวลานานกว่าปกติ',
    } : current), 20000);
    return () => window.clearTimeout(timeout);
  }, [auth]);
  useEffect(() => {
    if (recoveryAction !== 'started') return;
    const timeout = window.setTimeout(() => setRecoveryAction(current => current === 'started' ? 'failed' : current), 20000);
    return () => window.clearTimeout(timeout);
  }, [recoveryAction]);
  function signIn() {
    if (auth.kind === 'error' && auth.pendingRecovery) return;
    // A rejected SDK token must never be sent through bootstrap again in this instance.
    if (auth.kind === 'error' && auth.recovery) {
      if (recoveryGuard.current || !auth.recovery.run) return;
      recoveryGuard.current = true;
      setRecoveryAction('started');
      try { auth.recovery.run(); } catch { setRecoveryAction('failed'); }
      return;
    }
    attempt.current += 1;
    setRecovering(true); setAuth({ kind: 'loading' });
    activeController.current.abort();
    const controller = new AbortController(); activeController.current = controller;
    setBootstrap(() => createLiffBootstrap({ ...options, signal: controller.signal }));
  }
  function cancelInvitationLogin() {
    attempt.current += 1; activeController.current.abort(); discardInvitationContext();
    setAuth({ kind: 'invitation-cancelled' });
  }
  async function logout(value: LiffSession) {
    discardInvitationContext();
    const generation = ++attempt.current;
    setAuth({ kind: 'signing-out' });
    const logoutApi = createBrowserApi({ fetch: options.fetch, now: options.now, accountId: value.session.accountId });
    let failed = false;
    try { await logoutApi.request('/api/logout', { method: 'POST', body: '{}' }); }
    catch { failed = true; }
    finally {
      logoutApi.dispose();
      // A delayed logout must not clear the SDK or UI of a newer sign-in attempt.
      if (generation === attempt.current) { try { value.sdk.logout(); } catch { failed = true; } }
    }
    if (generation === attempt.current) setAuth(failed ? { kind: 'error', message: uncertainLogoutMessage } : { kind: 'signed-out' });
  }
  if (auth.kind === 'setup-blocked') return <AppShell mode="staging" navigationDisabled onNavigate={() => {}}>
    <section className="page-card" role="alert"><h2>ระบบทดสอบยังไม่พร้อมใช้งาน</h2>
      <p>อยู่ระหว่างตั้งค่าและตรวจสอบความพร้อมของระบบ ยังไม่เปิดให้เข้าสู่ระบบ LINE หรือส่งคำขอนัดหมาย</p>
      <p>ข้อมูลด้านล่างเป็นตัวอย่างบริการสำหรับทดสอบเท่านั้น ไม่มีการรับข้อมูลผู้ป่วยจริง</p>
      <button className="button secondary" onClick={signIn}>ตรวจสอบความพร้อมอีกครั้ง</button>
    </section>
    <HomeScreen bookingDisabled onStartBooking={() => {}} onSelectService={() => {}} />
  </AppShell>;
  if (auth.kind === 'ready') return <VerifiedApp value={auth.value} options={options} recovering={recovering}
    onEnd={error => {
      // Shared context cleanup belongs to this exact verified auth generation.
      // A disposed old API can reject after a newer sign-in has captured a link.
      if (attempt.current !== auth.generation) return;
      attempt.current += 1; discardInvitationContext();
      setAuth(current => current.kind === 'ready' && current.value === auth.value ? { kind: 'error', message: 'ตรวจสอบเซสชันไม่สำเร็จ ข้อมูลส่วนตัวถูกซ่อนแล้ว โปรดเข้าสู่ระบบอีกครั้ง', diagnostic: error instanceof LiffAuthError ? authDiagnosticText(error) : undefined } : current);
    }}
    onLogout={() => void logout(auth.value)} />;
  const pending = ['loading', 'redirecting', 'signing-out'].includes(auth.kind);
  const recovery = auth.kind === 'error' ? auth.recovery : undefined;
  const pendingRecovery = auth.kind === 'error' && auth.pendingRecovery;
  return <main lang="th" className="auth-screen"><section className={`auth-card${pending ? ' auth-loading' : ''}`} aria-busy={pending}>
    <img className="auth-brand-seal" src={clinicSeal} alt={`ตราประจำ${CLINIC_SHORT_NAME}`} width="112" height="112" />
    <h1>{CLINIC_SHORT_NAME}</h1>
    {pending && <span className="auth-spinner" aria-hidden="true" />}
    {auth.kind === 'loading' && <p role="status">กำลังตรวจสอบความพร้อมของระบบ…</p>}
    {auth.kind === 'redirecting' && <p role="status">กำลังไปยัง LINE เพื่อเข้าสู่ระบบ…</p>}
    {auth.kind === 'signing-out' && <p role="status">กำลังออกจากระบบ…</p>}
    {auth.kind === 'signed-out' && <h2>ออกจากระบบแล้ว</h2>}
    {auth.kind === 'invitation-cancelled' && <h2>ยกเลิกการรับคำเชิญบนหน้านี้แล้ว</h2>}
    {auth.kind === 'error' && <div role="alert"><p>{auth.message}</p>{auth.diagnostic && <p className="small-copy">รหัสตรวจสอบ: {auth.diagnostic}</p>}</div>}
    {!pending && <>
      <p>หลังเข้าสู่ระบบ โปรดตรวจสอบนัดหมายของฉันก่อนส่งคำขอใหม่ ไม่มีการส่งคำขอซ้ำอัตโนมัติ</p>
      {(pendingRecovery || recovery?.kind === 'reopen-liff' || recoveryAction === 'failed') && <p>ปิดหน้านี้ แล้วเปิดแอปใหม่จาก LINE โดยแตะลิงก์แอปในแชต อย่าเปิดจากบริการล่าสุด เพื่อเริ่มการเข้าสู่ระบบใหม่</p>}
      {recovery?.kind === 'external-login' && recoveryAction === 'idle' && <p>ข้อมูลเข้าสู่ระบบ LINE เดิมไม่ผ่านการตรวจสอบ กดเข้าสู่ระบบอีกครั้งเพื่อเริ่มการเข้าสู่ระบบ LINE ใหม่</p>}
      {recovery?.kind === 'external-login' && recoveryAction === 'started' && <p role="status">กำลังไปยัง LINE เพื่อเข้าสู่ระบบใหม่…</p>}
      {recoveryAction === 'failed' && <p role="status">ยังเปิดการเข้าสู่ระบบใหม่หรือปิดหน้าต่างไม่ได้ โปรดปิดหน้านี้ด้วยตนเอง</p>}
      {!pendingRecovery && (!recovery || recovery.run) && <button className="button primary" onClick={signIn} disabled={recoveryAction !== 'idle'}>{recovery?.kind === 'reopen-liff' ? 'ปิดหน้าต่าง LIFF' : 'เข้าสู่ระบบอีกครั้ง'}</button>}
    </>}
    {window.location.pathname === '/admin-invitation' && <>
      <p>หากการเข้าสู่ระบบถูกยกเลิก หรือคำเชิญไม่ปรากฏ โปรดเปิดลิงก์คำเชิญเดิมอีกครั้งหลังเข้าสู่ระบบ</p>
      {auth.kind !== 'signing-out' && auth.kind !== 'signed-out' && auth.kind !== 'invitation-cancelled' && <button className="button secondary" onClick={cancelInvitationLogin}>ยกเลิกการรับคำเชิญ</button>}
    </>}
    <p className="notice">ระบบทดสอบ Staging · ใช้ข้อมูลสมมติเท่านั้น อย่ากรอกข้อมูลผู้ป่วยจริง</p>
    <p className="small-copy">เฉพาะผู้ทดสอบที่ได้รับอนุญาต · ยังไม่มีการแจ้งเตือน LINE หรือรับนัดหมายจริง</p>
  </section></main>;
}

function VerifiedApp({ value, options, recovering, onEnd, onLogout }: {
  value: LiffSession; options: LiffBootstrapOptions; recovering: boolean;
  onEnd: (error: ApiRequestError) => void; onLogout: () => void;
}) {
  const [session, setSession] = useState(value.session);
  const [api] = useState(() => {
    const client = createBrowserApi({ fetch: options.fetch, now: options.now, accountId: value.session.accountId,
      onSession: fresh => setSession(old => old.isAdmin === fresh.isAdmin && old.expiresAt === fresh.expiresAt ? old : fresh),
      onSessionInvalid: error => { client.dispose(); onEnd(error instanceof SessionRefreshError ? new LiffAuthError('A09', error) : error); },
    });
    return client;
  });
  const [path, setPath] = useState(() => recovering && window.location.pathname !== '/admin-invitation' ? '/appointments' : window.location.pathname);
  const [initialService, setInitialService] = useState<Service>();
  const [bookingActive, setBookingActive] = useState(() => !recovering && window.location.pathname === '/booking');
  const [submitted, setSubmitted] = useState<Appointment>();
  const [receipt, setReceipt] = useState<{ appointment: Appointment; animate: boolean }>();
  const logoutGuard = useRef(false);
  const lifetime = useRef(0);
  const now = options.now ?? currentTime;
  useEffect(() => {
    const generation = ++lifetime.current;
    // StrictMode immediately re-acquires this instance; a real unmount does not.
    const disposeIfDetached = () => { if (lifetime.current === generation) api.dispose(); };
    return () => { queueMicrotask(disposeIfDetached); };
  }, [api]);
  useEffect(() => {
    if (recovering) window.history.replaceState(null, '', window.location.pathname === '/admin-invitation' ? '/admin-invitation' : '/appointments');
    const back = () => { setReceipt(undefined); setInitialService(undefined); setPath(window.location.pathname); if (window.location.pathname === '/booking') setBookingActive(true); };
    window.addEventListener('popstate', back); return () => window.removeEventListener('popstate', back);
  }, [recovering]);
  useEffect(() => {
    const expire = () => { api.dispose(); onEnd(new ApiRequestError('UNAUTHENTICATED', 401)); };
    const timeout = window.setTimeout(expire, Math.max(0, Date.parse(session.expiresAt) - now().getTime()));
    return () => window.clearTimeout(timeout);
  }, [api, session.expiresAt, now, onEnd]);
  useEffect(() => {
    let checking = false;
    let alive = true;
    async function refresh() {
      if (checking || logoutGuard.current) return;
      checking = true;
      try {
        const unchanged = value.sdk.isLoggedIn() && await fingerprintLiffToken(value.sdk.getIDToken()) === value.tokenFingerprint;
        if (!alive || logoutGuard.current) return;
        if (!unchanged) { api.dispose(); onEnd(new LiffAuthError('A08', new ApiRequestError('UNAUTHENTICATED', 401))); return; }
        await api.refreshSession();
      } catch (error) { if (alive && !logoutGuard.current) { api.dispose(); onEnd(new LiffAuthError('A08', error)); } }
      finally { checking = false; }
    }
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const foreground = () => { void refresh(); };
    window.addEventListener('focus', foreground); window.addEventListener('pageshow', foreground); document.addEventListener('visibilitychange', visible);
    return () => { alive = false; window.removeEventListener('focus', foreground); window.removeEventListener('pageshow', foreground); document.removeEventListener('visibilitychange', visible); };
  }, [api, value.sdk, value.tokenFingerprint, onEnd]);
  const refreshInvitationSession = useCallback(async () => {
    try { await api.refreshSession(); }
    catch (error) { api.dispose(); onEnd(error instanceof SessionRefreshError ? new LiffAuthError('A09', error) : new ApiRequestError('UNAVAILABLE', 503)); throw error; }
  }, [api, onEnd]);
  function navigate(next: string) { setReceipt(undefined); window.history.pushState(null, '', next); setPath(next); if (next === '/booking') setBookingActive(true); }
  function nav(next: NavigationItem) { setInitialService(undefined); navigate(next === 'home' ? '/' : `/${next}`); }
  function logout() { if (logoutGuard.current) return; logoutGuard.current = true; discardInvitationContext(); api.dispose(); onLogout(); }
  const adminSection = adminRoutes[path];
  const activeNav: NavigationItem = adminSection ? 'admin' : path.startsWith('/appointments') ? 'appointments' : path === '/booking' ? 'booking' : path === '/contact' ? 'contact' : 'home';
  const detailId = /^\/appointments\/([0-9a-f-]{36})$/i.exec(path)?.[1];
  return <AppShell mode="staging" activeNav={activeNav} onNavigate={nav} isAdmin={session.isAdmin}>
    <section className="runtime-session" aria-label="บัญชีที่ตรวจสอบแล้ว" hidden><span>เข้าสู่ระบบ LINE แล้ว · ข้อมูลสมมติบันทึกในระบบทดสอบ</span><div className="form-actions" hidden><button className="button secondary" onClick={logout}>ออกจากระบบ</button></div></section>
    {bookingActive && <div hidden={path !== '/booking'}><BookingFlow api={api} active={path === '/booking'} initialService={initialService} onSubmitted={(appointment, receiptOptions) => {
      setSubmitted(appointment); setBookingActive(false);
      // A response from a hidden flow must not take over more recent navigation.
      if (window.location.pathname === '/booking') {
        navigate(`/appointments/${appointment.id}`);
        setReceipt({ appointment, animate: receiptOptions.animate });
      }
    }} /></div>}
    <div key={adminSection ? '/admin' : path}>
      {path === '/' && <HomeScreen onStartBooking={() => { setInitialService(undefined); navigate('/booking'); }} onSelectService={service => { setInitialService(service); navigate('/booking'); }} />}
      {path === '/admin-invitation' && <InvitationPage api={api} accountId={session.accountId} onSessionRefresh={refreshInvitationSession} />}
      {path === '/appointments' && <MyAppointments api={api} now={now} onSelect={id => navigate(`/appointments/${id}`)} />}
      {detailId && receipt?.appointment.id === detailId ? <SubmittedReceipt appointment={receipt.appointment} animate={receipt.animate} dataMode="server" onAppointments={() => navigate('/appointments')} onHome={() => navigate('/')} /> : detailId && <AppointmentDetail api={api} id={detailId} now={now} showSubmitted={submitted?.id === detailId} onBack={() => navigate('/appointments')} onRebook={() => navigate('/booking')} />}
      {adminSection && (session.isAdmin ? <><Dashboard api={api} now={now} section={adminSection} onSectionChange={section => navigate(adminPath(section))} />{adminSection === 'notifications' && options.staging && session.accountId === 'f0000000-0000-4000-8000-000000000001' && <ManualApprovalControl api={api} />}</> : <section className="page-card"><h1>ไม่มีสิทธิ์ผู้ดูแล</h1><p>บัญชีนี้ยังไม่ได้รับสิทธิ์จากระบบ</p></section>)}
      {path === '/contact' && <section className="page-card"><h1>ติดต่อเรา</h1><p>{CLINIC_NAME} อยู่ระหว่างการทดสอบ ยังไม่เปิดรับผู้ป่วยจริง</p><p>โทรศัพท์คลินิก: <a href="tel:0981892216">098-189-2216</a></p><p>ที่อยู่และช่องทางติดต่ออื่น: ยังไม่ตั้งค่าช่องทางที่ตรวจสอบแล้ว</p><p>ยังไม่มีการส่งข้อความแจ้งเตือน LINE</p></section>}
      {!['/', '/booking', '/appointments', '/contact', '/admin-invitation'].includes(path) && !adminSection && !detailId && <section className="page-card"><h1>ไม่พบหน้า</h1><button className="button secondary" onClick={() => navigate('/')}>กลับหน้าหลัก</button></section>}
    </div>
  </AppShell>;
}
