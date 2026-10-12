import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {adminBookingPayload,ADMIN_MANAGE_ORIGIN} from '../../src/worker/admin-notifications/payload';
import {notificationPayload} from '../../src/worker/notifications/payload';
import {adminEnvelopeSchema,createAdminNotificationDatabase} from '../../src/worker/admin-notifications/db';
import {combinedPatientEnvelopeSchema,createCombinedPatientDatabase} from '../../src/worker/notifications/combined-db';
import type {AdminEnvelope} from '../../src/worker/admin-notifications/types';
import type {PreparedDispatch} from '../../src/worker/notifications/types';
const id='12345678-1234-4234-8234-123456789012';
const date='2026-10-20',instant='2026-10-12T05:00:00.000Z';
const fullName='ผู้รับบริการ ตัวอย่าง',phone='0800000000';
const delivery={id,eventId:id,appointmentId:id,grantId:id,retryKey:id,createdAt:instant,dueAt:instant,expiresAt:'2026-10-13T05:00:00.000Z'};
const event={id,appointmentId:id,appointmentVersion:1,type:'approval' as const,retryKey:id,dueAt:instant,expiresAt:delivery.expiresAt};
const admin={delivery,provider:'line:synthetic',recipient:'U'+'a'.repeat(32),reference:'D-SYNTHETIC',date,manageUrl:ADMIN_MANAGE_ORIGIN+'/admin',payloadVersion:2,preparedAt:instant,authorizationValidUntil:instant,fullName,phone};
const patient={event,provider:'line:synthetic',recipient:'U'+'b'.repeat(32),reference:'D-SYNTHETIC',date,manageUrl:ADMIN_MANAGE_ORIGIN+'/appointments',status:'approved',payloadVersion:3,preparedAt:instant,authorizationExpiresAt:instant,fullName};
function texts(value:unknown):Record<string,unknown>[]{if(!value||typeof value!=='object')return[];if(Array.isArray(value))return value.flatMap(texts);const o=value as Record<string,unknown>;return[o,...Object.values(o).flatMap(texts)].filter(v=>v.type==='text');}
describe('recovered notification-card protocol',()=>{
 it('matches exact serialized golden bytes extracted from verified live functions',()=>{
  const cases={
   'admin-v1':adminBookingPayload({...admin,payloadVersion:1} as unknown as AdminEnvelope),
   'admin-v2':adminBookingPayload(admin as unknown as AdminEnvelope),
   'patient-approval-v1':notificationPayload({...patient,payloadVersion:1} as unknown as PreparedDispatch),
   'patient-cancellation-v2':notificationPayload({...patient,payloadVersion:2,status:'cancelled',event:{...event,type:'cancellation'}} as unknown as PreparedDispatch),
   'patient-approval-v3':notificationPayload(patient as unknown as PreparedDispatch),
  };
  for(const [name,value] of Object.entries(cases))expect(JSON.stringify(value)).toBe(readFileSync(`tests/fixtures/notification-cards/${name}.json`,'utf8').trim());
 });
 it('renders adminV2 and patientapprovalV3 without visible references',()=>{const a=adminBookingPayload(admin as unknown as AdminEnvelope),p=notificationPayload(patient as unknown as PreparedDispatch);expect(JSON.stringify(a)).toContain(fullName);expect(JSON.stringify(a)).toContain(phone);expect(JSON.stringify(p)).toContain(fullName);for(const card of [a,p]){expect(JSON.stringify(card)).not.toContain('D-SYNTHETIC');expect(card.messages[0].altText).not.toContain(fullName);}expect(JSON.stringify(p)).not.toContain(phone);});
 it('keeps all identity text wrapping without fixed-line truncation',()=>{const name='ผู้รับบริการ '.repeat(10).slice(0,120);for(const card of [adminBookingPayload({...admin,fullName:name} as unknown as AdminEnvelope),notificationPayload({...patient,fullName:name} as unknown as PreparedDispatch)])for(const node of texts(card).filter(n=>n.text===name||n.text===phone)){expect(node.wrap).toBe(true);expect(node).not.toHaveProperty('maxLines');}});
 it('strictly accepts only version-specific identity projections',()=>{expect(adminEnvelopeSchema.safeParse(admin).success).toBe(true);expect(combinedPatientEnvelopeSchema.safeParse(patient).success).toBe(true);expect(combinedPatientEnvelopeSchema.safeParse({...patient,phone}).success).toBe(false);expect(adminEnvelopeSchema.safeParse({...admin,age:12}).success).toBe(false);expect(combinedPatientEnvelopeSchema.safeParse({...patient,status:'rejected'}).success).toBe(false);expect(combinedPatientEnvelopeSchema.safeParse({...patient,event:{...event,type:'reminder'}}).success).toBe(false);});
 it.each(['','   ','x'.repeat(121)])('rejects invalid name %j',name=>{expect(()=>adminBookingPayload({...admin,fullName:name} as unknown as AdminEnvelope)).toThrow();expect(()=>notificationPayload({...patient,fullName:name} as unknown as PreparedDispatch)).toThrow();});
 it.each(['','abcdefg','+'.repeat(10),'x'.repeat(31)])('rejects invalid admin phone %j',bad=>expect(()=>adminBookingPayload({...admin,phone:bad} as unknown as AdminEnvelope)).toThrow());
 it('does not promote old versions into identity cards',()=>{const {fullName:unusedName,phone:unusedPhone,...oldAdmin}=admin;void unusedName;void unusedPhone;const {fullName:unusedPatient,...oldPatient}=patient;void unusedPatient;expect(JSON.stringify(adminBookingPayload({...oldAdmin,payloadVersion:1} as unknown as AdminEnvelope))).toContain('หมายเลข D-SYNTHETIC');expect(JSON.stringify(notificationPayload({...oldPatient,payloadVersion:1} as unknown as PreparedDispatch))).toContain('หมายเลข D-SYNTHETIC');});
 it('uses explicit capable claim and prepare RPCs without fallback',async()=>{const calls:string[]=[];const port={query:async(sql:string)=>{calls.push(sql);return{rows:[{result:null}]};}};const a=createAdminNotificationDatabase(port),p=createCombinedPatientDatabase(port);await a.claimAdminDelivery(id);await a.prepareAdminDispatch(id,id,ADMIN_MANAGE_ORIGIN,null);await p.claimPatientEvent(id);await p.preparePatientDispatch(id,id,ADMIN_MANAGE_ORIGIN,null);expect(calls.map(s=>s.match(/dental\.([a-z0-9_]+)/)?.[1])).toEqual(['claim_admin_delivery_v2','prepare_admin_dispatch_v2','claim_patient_event_v3','prepare_patient_dispatch_v3']);});
});
