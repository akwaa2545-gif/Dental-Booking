import type { Availability } from '../../shared/contracts';

export type AdminSection = 'overview' | 'queue' | 'schedule' | 'intake' | 'notifications' | 'administrators';
export const ADMIN_SECTIONS: {id: AdminSection; label: string; icon: string}[] = [
  {id:'overview',label:'ภาพรวม',icon:'▦'}, {id:'queue',label:'คำขอนัดหมาย',icon:'☷'},
  {id:'schedule',label:'ตารางนัด',icon:'▦'}, {id:'intake',label:'วันปิด / การรับจอง',icon:'◷'},
  {id:'notifications',label:'ประวัติแจ้งเตือน',icon:'♧'}, {id:'administrators',label:'จัดการผู้ดูแล',icon:'♙'},
];
export const DAY_LABELS: Record<Availability['state'], string> = {available:'เปิดรับคำขอ',full:'เต็ม',paused:'หยุดรับคำขอ',closed:'ปิดรับนัด',ineligible:'นอกวันรับนัด'};
