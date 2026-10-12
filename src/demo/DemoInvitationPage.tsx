import { useEffect, useRef, useState } from 'react';
import type { OwnClaim } from '../shared/admin-management';
import { claimAdminInvitation, listOwnAdminClaims, type ApiClient } from '../web/api';
import { INVITATION_STATE_LABELS } from '../web/copy.th';
import { safeInvitationUrl } from '../web/admin/management-api';

/** Explicitly synthetic recipient view. It never reads production invitation context or session storage. */
export function DemoInvitationPage({ api }: { api: ApiClient }) {
  const [claims, setClaims] = useState<OwnClaim[]>([]); const [link, setLink] = useState(''); const [busy, setBusy] = useState(true); const [error, setError] = useState('');
  const lifetime = useRef(0); const operation = useRef(false);
  useEffect(() => {
    const fence = lifetime, active = ++fence.current;
    listOwnAdminClaims(api).then(result => { if (fence.current === active) { setClaims(result.items); setBusy(false); } }).catch(() => { if (fence.current === active) { setError('ตรวจสอบตัวอย่างคำเชิญไม่ได้'); setBusy(false); } });
    return () => { ++fence.current; };
  }, [api]);
  async function act(claim: boolean) {
    if (operation.current || busy) return;
    const safe = safeInvitationUrl(link.trim()); if (claim && !safe) return;
    operation.current = true; setBusy(true); setError(''); const active = lifetime.current;
    try {
      if (claim) await claimAdminInvitation(api, new URL(safe!).hash.slice('#invite='.length));
      const result = await listOwnAdminClaims(api); if (lifetime.current === active) { setClaims(result.items); setLink(''); }
    } catch { if (lifetime.current === active) setError('ยังยืนยันผลตัวอย่างไม่ได้ โปรดตรวจสอบสถานะก่อนทำรายการใหม่'); }
    finally { if (lifetime.current === active) { operation.current = false; setBusy(false); } }
  }
  return <section className="page-card"><h1>คำเชิญผู้ดูแลจำลอง</h1><p className="notice">บัญชีและรหัสในหน้านี้เป็นข้อมูลสมมติในแท็บ ไม่มีการเข้าสู่ระบบ LINE หรือให้สิทธิ์จริง</p>
    {claims.map(claim => <article key={claim.invitation.id}><h2>{claim.invitation.label}</h2><p>{INVITATION_STATE_LABELS[claim.invitation.state]}</p>{claim.verificationCode && <><p>ยังไม่ได้รับสิทธิ์ผู้ดูแล นำรหัสนี้ไปบอกผู้ดูแลที่รู้จักกัน</p><p className="reference">{claim.verificationCode}</p></>}</article>)}
    {error && <p role="alert">{error}</p>}<button className="button secondary" disabled={busy} onClick={() => void act(false)}>ตรวจสอบสถานะอีกครั้ง</button>
    <form onSubmit={event => { event.preventDefault(); void act(true); }}><label className="field">ลิงก์คำเชิญสมมติ<input type="text" value={link} disabled={busy} onChange={event => setLink(event.target.value)} /></label>
      <p className="small-copy">ใช้ลิงก์ที่สร้างในเดโม HTTPS ต้นทางเดียวกันเท่านั้น เดโมบน HTTP ใช้ตัวอย่างที่เตรียมไว้ด้านบนได้</p><button className="button primary" disabled={busy || !safeInvitationUrl(link.trim())}>รับคำเชิญจำลองด้วยบัญชีนี้</button>
    </form></section>;
}
