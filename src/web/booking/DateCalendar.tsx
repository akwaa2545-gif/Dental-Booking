import { useState } from 'react';
import type { Availability, ISODate } from '../../shared/contracts';
import { formatThaiDate } from '../copy.th';

const LABELS = { available: 'ว่าง', full: 'เต็ม', closed: 'ปิดรับนัด', paused: 'หยุดรับคำขอ', ineligible: 'นอกช่วงนัด' };
const MARKERS = { available: '●', full: '×', closed: '−', paused: 'Ⅱ', ineligible: '·' };
export function DateCalendar({ days, value, onChange }: { days: Availability[]; value: ISODate | null; onChange: (date: ISODate) => void }) {
  const months = [...new Set(days.map(d => d.date.slice(0, 7)))];
  const [index, setIndex] = useState(0);
  const [view, setView] = useState<'month' | 'list'>('month');
  const month = months[Math.min(index, months.length - 1)];
  if (!month) return <p role="status">กำลังโหลดวันนัดหมาย…</p>;
  const first = new Date(`${month}-01T12:00:00Z`);
  const count = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const dateMap = new Map(days.map(d => [d.date, d]));
  const dateFormatter = new Intl.DateTimeFormat('th-TH', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  return <section className="calendar" data-view={view} aria-label="ปฏิทินเลือกวันนัด">
    <div className="calendar-title">
      <button type="button" className="icon-button" aria-label="เดือนก่อนหน้า" disabled={index === 0} onClick={() => setIndex(index - 1)}>‹</button>
      <h3>{new Intl.DateTimeFormat('th-TH', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first)}</h3>
      <button type="button" className="icon-button" aria-label="เดือนถัดไป" disabled={index >= months.length - 1} onClick={() => setIndex(index + 1)}>›</button>
    </div>
    <div className="calendar-view" role="group" aria-label="รูปแบบแสดงวันนัด">
      <button type="button" aria-pressed={view === 'month'} onClick={() => setView('month')}>รายเดือน</button>
      <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>รายการ</button>
    </div>
    <p className="calendar-help">เลือกแบบรายการเพื่อดูวันที่เต็มและปุ่มขนาดใหญ่</p>
    <div className="calendar-grid">
      {['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'].map(label => <span className="weekday-label" key={label}>{label}</span>)}
      {Array.from({ length: first.getUTCDay() }, (_, i) => <span className="calendar-spacer" aria-hidden="true" key={`space-${i}`} />)}
      {Array.from({ length: count }, (_, i) => {
        const date = `${month}-${String(i + 1).padStart(2, '0')}`;
        const state = dateMap.get(date)?.state ?? 'ineligible';
        const fullDate = dateFormatter.format(new Date(`${date}T12:00:00Z`));
        const selected = value === date;
        return <button type="button" key={date} className={`calendar-day ${state} ${selected ? 'selected' : ''}`} aria-label={`${date} ${LABELS[state]} · ${fullDate}`} aria-pressed={selected} disabled={state !== 'available'} onClick={() => onChange(date)}>
          <strong className="day-number">{i + 1}</strong>
          <span className="compact-date" aria-hidden="true">{fullDate}</span>
          <small className="day-state-label" aria-hidden="true">{LABELS[state]}</small>
          <span className={`day-state-marker ${selected ? 'selected-check' : ''}`} aria-hidden="true">{selected ? '✓' : MARKERS[state]}</span>
        </button>;
      })}
    </div>
    <div className="calendar-legend" aria-label="ความหมายสถานะวันนัด">
      <span>● ว่าง</span><span className="full-text">× เต็ม</span><span>− ปิดรับนัด</span><span>Ⅱ หยุดรับคำขอ</span><span>· นอกช่วงนัด</span><span>✓ วันที่เลือก</span>
    </div>
    <div className="calendar-selection" role="status" aria-live="polite">
      <span>{value ? 'วันที่เลือก' : 'ยังไม่ได้เลือกวันนัด'}</span>
      {value ? <strong>{formatThaiDate(value)}</strong> : <p>เลือกวันที่ว่างเพื่อดำเนินการต่อ</p>}
    </div>
  </section>;
}
