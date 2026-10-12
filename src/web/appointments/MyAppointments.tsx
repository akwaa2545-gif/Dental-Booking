import { useEffect, useState } from 'react';
import type { Appointment } from '../../shared/contracts';
import { bangkokDate } from '../../shared/calendar';
import { errorText, type ApiClient } from '../api';
import { FIXED_WINDOW, SERVICE_LABELS, STATUS_LABELS, formatThaiDate } from '../copy.th';

export function MyAppointments({ api, now = () => new Date(), onSelect }: { api: ApiClient; now?: () => Date; onSelect?: (id: string) => void }) {
  const [items, setItems] = useState<Appointment[]>([]); const [error, setError] = useState('');
  const [loading, setLoading] = useState(true); const [revision, setRevision] = useState(0);
  useEffect(() => { let alive = true; api.request<Appointment[]>('/api/appointments').then(data => { if (alive) { setItems(data); setError(''); } }).catch(e => { if (alive) setError(errorText(e)); }).finally(() => { if (alive) setLoading(false); }); return () => { alive = false; }; }, [api, revision]);
  const today = bangkokDate(now());
  const upcoming = items.filter(a => a.date >= today && (a.status === 'pending' || a.status === 'approved')).sort((a, b) => a.date.localeCompare(b.date));
  const past = items.filter(a => !upcoming.includes(a)).sort((a, b) => b.date.localeCompare(a.date));
  return <section><div className="page-title"><h1>นัดหมายของฉัน</h1><p>รวมโปรไฟล์ของคุณและครอบครัวสมมติ</p></div>{loading && <p role="status">กำลังโหลดนัดหมาย…</p>}{error && <><p role="alert">{error}</p><button className="button secondary" disabled={loading} onClick={() => { setLoading(true); setRevision(v => v + 1); }}>โหลดนัดหมายใหม่</button></>}{!loading && !error && [{ title: 'นัดหมายที่กำลังจะมาถึง', data: upcoming }, { title: 'ประวัติและคำขอที่สิ้นสุด', data: past }].map(group => <section className="appointment-group" key={group.title}><h2>{group.title}</h2>{!group.data.length && <p className="empty-state">ยังไม่มีนัดหมายในกลุ่มนี้</p>}<div className="appointment-grid">{group.data.map(a => <article className="appointment-card" key={a.id}><div className="card-top"><span className="reference">{a.reference}</span><span className={`status-badge ${a.status}`}>{STATUS_LABELS[a.status]}</span></div><h3>{a.patient.fullName}</h3><p>{SERVICE_LABELS[a.service]}</p><p>{formatThaiDate(a.date)}</p><p className="small-copy">{FIXED_WINDOW} น. · เวลาไทย</p><button className="button secondary" onClick={() => onSelect ? onSelect(a.id) : window.location.assign(`/appointments/${a.id}`)}>ดูรายละเอียด</button></article>)}</div></section>)}</section>;
}
