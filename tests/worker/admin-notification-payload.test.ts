import {describe,it,expect} from 'vitest';
import {adminBookingPayload,ADMIN_MANAGE_ORIGIN} from '../../src/worker/admin-notifications/payload';
import type {AdminEnvelope} from '../../src/worker/admin-notifications/types';
const envelope=():Extract<AdminEnvelope,{payloadVersion:1}>=>({delivery:{id:'delivery',eventId:'event',appointmentId:'appointment',grantId:'grant',retryKey:'retry',createdAt:'2026-10-10T00:00:00Z',dueAt:'2026-10-10T00:00:00Z',expiresAt:'2026-10-11T00:00:00Z'},provider:'line:synthetic',recipient:'private-line-id',reference:'D-EXAMPLE',date:'2026-10-20',manageUrl:`${ADMIN_MANAGE_ORIGIN}/admin`,payloadVersion:1,preparedAt:'2026-10-10T00:00:00Z',authorizationValidUntil:'2026-10-10T00:01:00Z'});
describe('admin frozen payload V1',()=>{
 it('omits patient and destination while containing only approved historical copy',()=>{
  const json=JSON.stringify(adminBookingPayload({...envelope(),name:'Sensitive Name',phone:'999',service:'scaling',reason:'private'} as AdminEnvelope));
  for(const value of ['Sensitive Name','999','scaling','private','recipient','grant','appointment'])expect(json).not.toContain(value);
  for(const value of ['มีคำขอนัดหมายใหม่','หมายเลข D-EXAMPLE','วันที่ขอนัด 2026-10-20','ตรวจสอบสถานะล่าสุดในหน้าแอดมิน','เปิดหน้าแอดมิน'])expect(json).toContain(value);
  expect(JSON.parse(json).messages[0].contents.footer.contents[0].action.uri).toBe(`${ADMIN_MANAGE_ORIGIN}/admin`);
 });
 it.each(['http://evil.test/admin','https://evil.test/admin',`${ADMIN_MANAGE_ORIGIN}/appointments`,`${ADMIN_MANAGE_ORIGIN}/admin?token=secret`,`${ADMIN_MANAGE_ORIGIN}/admin#secret`,`${ADMIN_MANAGE_ORIGIN}/x/../admin`,`${ADMIN_MANAGE_ORIGIN}:443/admin`])('rejects unsafe or noncanonical URL %s',(manageUrl)=>expect(()=>adminBookingPayload({...envelope(),manageUrl})).toThrow());
 it.each(['2026-02-30','not-date','2026-1-01'])('rejects invalid date %s',date=>expect(()=>adminBookingPayload({...envelope(),date})).toThrow());
 it.each(['','secret reference','<script>','x'.repeat(81)])('rejects invalid reference %s',reference=>expect(()=>adminBookingPayload({...envelope(),reference})).toThrow());
 it.each([undefined,null,123,true])('rejects non-string reference %s',reference=>expect(()=>adminBookingPayload({...envelope(),reference} as unknown as AdminEnvelope)).toThrow());
 it('matches frozen serialized V1 bytes',()=>expect(JSON.stringify(adminBookingPayload(envelope()))).toBe('{"messages":[{"type":"flex","altText":"มีคำขอนัดหมายใหม่","contents":{"type":"bubble","body":{"type":"box","layout":"vertical","contents":[{"type":"text","text":"มีคำขอนัดหมายใหม่","weight":"bold","wrap":true},{"type":"text","text":"หมายเลข D-EXAMPLE","wrap":true},{"type":"text","text":"วันที่ขอนัด 2026-10-20","wrap":true},{"type":"text","text":"ตรวจสอบสถานะล่าสุดในหน้าแอดมิน","wrap":true}]},"footer":{"type":"box","layout":"vertical","contents":[{"type":"button","action":{"type":"uri","label":"เปิดหน้าแอดมิน","uri":"https://tooth-talk-staging.tooth-talk-staging-f7ff4a96.workers.dev/admin"}}]}}}]}'));
 it('rejects unknown protocol version',()=>expect(()=>adminBookingPayload({...envelope(),payloadVersion:2} as unknown as AdminEnvelope)).toThrow());
 it('reproduces identical bytes after status changes and ignores extraneous fields',()=>expect(adminBookingPayload({...envelope(),status:'cancelled'} as AdminEnvelope)).toEqual(adminBookingPayload(envelope())));
});
