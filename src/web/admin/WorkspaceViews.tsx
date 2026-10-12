import { useState } from 'react';
import type { AdminAppointment, Appointment, Availability } from '../../shared/contracts';
import { formatThaiDate } from '../copy.th';
import { AdminNotificationStatus } from './AdminNotificationStatus';

import { ADMIN_SECTIONS, DAY_LABELS, type AdminSection } from './workspace';
type RecordItem = Appointment & Partial<AdminAppointment>;
export function AdminMenu({section,onChange}:{section:AdminSection;onChange:(section:AdminSection)=>void}) {
 return <aside className="admin-sidebar"><p className="admin-sidebar-title">CLINIC ADMINISTRATION</p><nav aria-label="เมนูแอดมิน">{ADMIN_SECTIONS.map(item=><button key={item.id} aria-current={section===item.id?'page':undefined} onClick={()=>onChange(item.id)}><span aria-hidden="true">{item.icon}</span>{item.label}</button>)}</nav><p className="small-copy admin-sidebar-note">สำหรับเจ้าหน้าที่ที่ได้รับสิทธิ์<br/>ระบบทดสอบ · ข้อมูลสมมติเท่านั้น</p></aside>;
}
export function Overview({items,days,onChange}:{items:RecordItem[];days:Availability[];onChange:(section:AdminSection)=>void}) {
 const counts=[['รอการอนุมัติ',items.filter(i=>i.status==='pending').length],['อนุมัติแล้ว',items.filter(i=>i.status==='approved').length],['คำขอทั้งหมด',items.length],['วันเปิดรับในปฏิทิน',days.filter(d=>d.state==='available'||d.state==='full').length]];
 return <><section className="admin-stats" aria-label="ภาพรวมข้อมูลที่โหลดจากระบบ">{counts.map(([label,count])=><div className="admin-stat" key={label}><span>{label}</span><strong>{count}</strong></div>)}</section><div className="admin-overview-heading"><h2>คำขอรอพิจารณา</h2><button className="button secondary" onClick={()=>onChange('queue')}>ดูคำขอทั้งหมด</button></div></>;
}
export function UpcomingDays({days,items,onSelect}:{days:Availability[];items:RecordItem[];onSelect:(date:string)=>void}) {
 return <section className="admin-upcoming"><h2>วันรับนัดถัดไป</h2>{days.slice(0,5).map(day=><button key={day.date} onClick={()=>onSelect(day.date)}><span>{formatThaiDate(day.date)}<small>{DAY_LABELS[day.state]}</small></span><strong>{items.filter(i=>i.date===day.date&&(i.status==='pending'||i.status==='approved')).length}/3</strong></button>)}<p className="small-copy">จำนวนรวมคำขอรออนุมัติและนัดที่อนุมัติแล้ว</p></section>;
}
export function AdminCalendar({days,items,date,onSelect}:{days:Availability[];items:RecordItem[];date:string;onSelect:(date:string)=>void}) {
 const months=[...new Set(days.map(day=>day.date.slice(0,7)))];
 const [requestedMonth,setMonth]=useState('');
 const month=months.includes(requestedMonth)?requestedMonth:months.includes(date.slice(0,7))?date.slice(0,7):months[0];
 if(!month)return <p className="notice">ยังไม่มีข้อมูลปฏิทินสำหรับตรวจสอบ</p>;
 const first=new Date(`${month}-01T12:00:00Z`);
 const count=new Date(Date.UTC(first.getUTCFullYear(),first.getUTCMonth()+1,0)).getUTCDate();
 const index=months.indexOf(month);
 return <section className="admin-calendar" aria-label="ปฏิทินนัดสำหรับผู้ดูแล"><div className="admin-calendar-heading"><button className="button secondary" aria-label="เดือนก่อนหน้า" disabled={index<=0} onClick={()=>setMonth(months[index-1])}>‹</button><h2>{new Intl.DateTimeFormat('th-TH',{month:'long',year:'numeric',timeZone:'UTC'}).format(first)}</h2><button className="button secondary" aria-label="เดือนถัดไป" disabled={index>=months.length-1} onClick={()=>setMonth(months[index+1])}>›</button></div><div className="admin-month-grid">{['อา.','จ.','อ.','พ.','พฤ.','ศ.','ส.'].map(d=><span className="admin-weekday" key={d}>{d}</span>)}{Array.from({length:first.getUTCDay()},(_,i)=><span key={`blank-${i}`} aria-hidden="true"/>)}{Array.from({length:count},(_,i)=>{
 const value=`${month}-${String(i+1).padStart(2,'0')}`,day=days.find(d=>d.date===value);
 const used=items.filter(a=>a.date===value&&(a.status==='pending'||a.status==='approved')).length;
 return <button key={value} className={`admin-calendar-day ${day?.state??'unknown'}`} disabled={!day} aria-pressed={date===value} aria-label={`${formatThaiDate(value)} · ${day?DAY_LABELS[day.state]:'ไม่มีข้อมูล'}${day?` · ${used}/3`:''}`} onClick={()=>onSelect(value)}><strong>{i+1}</strong><span>{day?`${used}/3`:'—'}</span><small>{day?DAY_LABELS[day.state]:'ไม่มีข้อมูล'}</small></button>;
 })}</div><p className="small-copy">จำนวนในมุมมองเจ้าหน้าที่เท่านั้น · เลือกวันเพื่อดูนัด ไม่ได้สร้างการจอง</p></section>;
}
export function NotificationHistory({items}:{items:RecordItem[]}) {
 const notices=items.flatMap(item=>(item.notificationAttempts??[]).map((notice,index)=>({item,notice,index})));
 const adminNotices=items.filter(item=>item.adminNotificationAttempts?.length);
 return <><section className="admin-line-planned" aria-label="ผลการแจ้งเตือนแอดมิน">
   <h2>แจ้งเตือนแอดมินผ่าน LINE</h2>
   <p>รองรับการแสดงสถานะรายแอดมินแล้ว ระบบแจ้งเตือนนี้ปิดโดยค่าเริ่มต้น การเปิดส่งต้องได้รับอนุมัติแยกต่างหาก</p>
   {adminNotices.length ? adminNotices.map(item=><div key={item.id}>
     <p><strong>{item.reference}</strong> · {formatThaiDate(item.date)}</p>
     <AdminNotificationStatus items={item.adminNotificationAttempts ?? []} />
   </div>) : <p className="empty-state">ยังไม่มีรายการแจ้งเตือนแอดมินในข้อมูลที่โหลด</p>}
 </section><section className="admin-notification-history" aria-label="ผลการแจ้งเตือนผู้รับบริการ"><h2>ผลการแจ้งเตือนผู้รับบริการ</h2><p className="small-copy">สถานะจากระบบส่งเดิม ผู้ให้บริการรับแล้วไม่ได้ยืนยันว่าผู้รับอ่านแล้ว</p>{notices.length?notices.map(({item,notice,index})=><article key={`${item.id}-${index}`}><div><strong>{item.patient.fullName}</strong><p>{item.reference} · {formatThaiDate(item.date)}</p></div><div>{({approval:'ยืนยันอนุมัติ',rejection:'แจ้งไม่อนุมัติ',cancellation:'แจ้งคลินิกยกเลิก',reminder:'เตือนก่อนนัด'})[notice.kind]}<p>{({queued:'รอส่ง',leased:'กำลังดำเนินการ',retry:'รอลองใหม่',accepted:'ผู้ให้บริการรับแล้ว',suppressed:'ระงับการส่ง',failed:'ส่งไม่สำเร็จ'})[notice.state]} · พยายามส่ง {notice.attemptCount} ครั้ง</p></div></article>):<p className="empty-state">ยังไม่มีรายการส่ง</p>}</section></>;
}
