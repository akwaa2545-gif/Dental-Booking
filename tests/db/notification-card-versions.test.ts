import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {afterEach,beforeEach,describe,it,expect} from 'vitest';
import {CombinedNotificationFixture,COMBINED_START,COMBINED_END} from '../support/combined-notification-postgres';
import {syntheticPatient} from '../support/fixtures';
import {booking} from '../support/reservation-postgres';
import type {Patient} from '../../src/shared/contracts';
import {adminBookingPayload} from '../../src/worker/admin-notifications/payload';
import {notificationPayload} from '../../src/worker/notifications/payload';
import type {AdminEnvelope} from '../../src/worker/admin-notifications/types';
import type {PreparedDispatch} from '../../src/worker/notifications/types';
const origin='https://tooth-talk-staging.tooth-talk-staging-f7ff4a96.workers.dev';
const migrations=['db/migrations/014_admin_invitations.sql','db/migrations/015_notification_card_versions.sql','db/migrations/016_activate_notification_cards.sql'];
const quota={type:'limited',value:300,totalUsage:0,observedAt:COMBINED_START};
let f:CombinedNotificationFixture;
async function queue(decision='approve',guardian=false){
 const operator=await f.account();await f.policy(operator);const admin=await f.admin();
 const actor=await f.account(),provider='line:synthetic-owner',recipient='U'+actor.replaceAll('-','');
 await f.control.query('update dental.accounts set provider=$2,subject=$3 where id=$1',[actor,provider,recipient]);
 await f.control.query("insert into dental.line_reachability(provider,subject,reachable,event_at,event_id,updated_at) values($1,$2,true,dental.clock_now(),'01J00000000000000000000000',dental.clock_now())",[provider,recipient]);
 const patient=guardian?await f.base.call<Patient>('select dental.create_patient($1,$2::jsonb) as result',[actor,{...syntheticPatient,fullName:'Synthetic child patient',age:12,relationship:'guardian'}]):await f.base.patient(actor);
 const appointment=await f.base.reserve(actor,randomUUID(),booking(patient,'2026-10-14'));
 await f.base.call("select dental.decide($1,$2,1,$3,'Synthetic decision') as result",[admin.account,appointment.id,decision]);
 await f.operatorCall("select dental.set_admin_notification_budget($1,0,$2,$3,300,0,true,'Synthetic recovery') as result",[operator,COMBINED_START,COMBINED_END]);
 return{actor,recipient,appointment,patient,admin};
}
async function patientPrepare(legacy=false){const worker=randomUUID();const event=await f.base.call<{id:string;retryKey:string}>(`select dental.claim_patient_event${legacy?'':'_v3'}($1) as result`,[worker]);const payload=await f.base.call<PreparedDispatch>(`select dental.prepare_patient_dispatch${legacy?'':'_v3'}($1,$2,$3,$4::jsonb) as result`,[worker,event.id,origin,JSON.stringify({...quota,observedAt:(await f.control.query('select dental.clock_now() as now')).rows[0].now.toISOString()})]);return{event,payload,worker};}
async function adminPrepare(legacy=false){const worker=randomUUID();const delivery=await f.base.call<{id:string;retryKey:string}>(`select dental.claim_admin_delivery${legacy?'':'_v2'}($1) as result`,[worker]);const payload=await f.base.call<AdminEnvelope>(`select dental.prepare_admin_dispatch${legacy?'':'_v2'}($1,$2,$3,$4::jsonb) as result`,[worker,delivery.id,origin,JSON.stringify({...quota,observedAt:(await f.control.query('select dental.clock_now() as now')).rows[0].now.toISOString()})]);return{delivery,payload,worker};}
describe('recovered card protocol against exact applied migrations',()=>{
 beforeEach(async()=>{f=await CombinedNotificationFixture.create(migrations);});
 afterEach(async()=>{if(f)await f.close();});
 it('pins only future approval3/admin2 and preserves reminder1',async()=>{const q=await queue();expect((await patientPrepare()).payload.payloadVersion).toBe(3);expect((await adminPrepare()).payload.payloadVersion).toBe(2);expect((await f.control.query('select type,payload_version from dental.outbox where appointment_id=$1 order by type',[q.appointment.id])).rows).toEqual([{type:'approval',payload_version:3},{type:'reminder',payload_version:1}]);});
 it('projects only immutable booking identity and intended recipients',async()=>{const q=await queue();const snapshot=(await f.control.query('select patient_snapshot from dental.appointments where id=$1',[q.appointment.id])).rows[0].patient_snapshot;await f.control.query("update dental.patients set full_name='Changed profile',phone='0899999999',version=version+1 where id=$1",[q.patient.id]);const p=await patientPrepare(),a=await adminPrepare();expect(p.payload).toMatchObject({fullName:snapshot.fullName,recipient:q.recipient});expect(a.payload).toMatchObject({fullName:snapshot.fullName,phone:snapshot.phone,recipient:q.admin.recipient});expect(p.payload).not.toHaveProperty('phone');for(const envelope of [p.payload,a.payload])for(const field of ['age','address','relationship','service','patient'])expect(envelope).not.toHaveProperty(field);expect(JSON.stringify(notificationPayload(p.payload))).not.toContain(q.appointment.reference);expect(JSON.stringify(adminBookingPayload(a.payload))).not.toContain(q.appointment.reference);});
 it('uses booked child identity with guardian booking-owner recipient',async()=>{const q=await queue('approve',true);expect((await patientPrepare()).payload).toMatchObject({fullName:'Synthetic child patient',recipient:q.recipient});expect((await adminPrepare()).payload).toMatchObject({fullName:'Synthetic child patient',recipient:q.admin.recipient});expect(q.recipient).not.toBe(q.admin.recipient);});
 it('preserves retry bytes and retry key',async()=>{await queue();const p=await patientPrepare(),bytes=JSON.stringify(notificationPayload(p.payload));await f.base.call('select dental.finish_dispatch($1,$2,$3::jsonb) as result',[p.worker,p.event.id,JSON.stringify({kind:'retryable',category:'transport'})]);await f.base.setClock('2026-10-08T05:01:00.000Z');const next=await patientPrepare();expect(next.event.retryKey).toBe(p.event.retryKey);expect(JSON.stringify(notificationPayload(next.payload))).toBe(bytes);});
 it('keeps rejection on1 and cancellation on2',async()=>{await queue('reject');expect((await patientPrepare()).payload.payloadVersion).toBe(1);await f.close();f=await CombinedNotificationFixture.create(migrations);const q=await queue();await f.base.call("select dental.decide($1,$2,2,'cancel','Synthetic cancellation') as result",[q.admin.account,q.appointment.id]);expect((await patientPrepare()).payload.payloadVersion).toBe(2);});
 it('withholds identity on unknown quota or revoked admin grant',async()=>{const q=await queue(),worker=randomUUID();const event=await f.base.call<{id:string}>('select dental.claim_patient_event_v3($1) as result',[worker]);expect(await f.base.call('select dental.prepare_patient_dispatch_v3($1,$2,$3,null) as result',[worker,event.id,origin])).toEqual({state:'paused_quota'});const delivery=await f.base.call<{id:string}>('select dental.claim_admin_delivery_v2($1) as result',[worker]);await f.control.query('update dental.admin_grants set revoked_at=dental.clock_now() where id=$1',[q.admin.grant]);expect(await f.base.call('select dental.prepare_admin_dispatch_v2($1,$2,$3,$4::jsonb) as result',[worker,delivery.id,origin,JSON.stringify(quota)])).toBeNull();});
 it.each(['queued','retry','leased','exhausted','expired'])('old RPCs leave unsupported %s rows and spending untouched',async state=>{
  await queue();const worker=randomUUID();
  if(state==='retry')await f.control.query("update dental.outbox set state='retry';update dental.admin_booking_deliveries set state='retry'");
  if(state==='leased'){await f.control.query("update dental.outbox set state='leased',lease_owner=$1,lease_until=dental.clock_now()-interval '1 second' where type='approval'",[worker]);await f.control.query("update dental.admin_booking_deliveries set state='leased',lease_owner=$1,lease_until=dental.clock_now()-interval '1 second'",[worker]);}
  if(state==='exhausted')await f.control.query("update dental.outbox set attempt_count=6 where type='approval';update dental.admin_booking_deliveries set attempt_count=6,first_attempt_at=dental.clock_now()");
  if(state==='expired')await f.base.setClock('2026-10-09T06:00:00.000Z');
  const digest=async()=>(await f.control.query(`select jsonb_build_object('outbox',(select jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text) from dental.outbox t),'deliveries',(select jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text) from dental.admin_booking_deliveries t),'patientAttempts',(select jsonb_agg(to_jsonb(t)) from dental.notification_attempts t),'adminAttempts',(select jsonb_agg(to_jsonb(t)) from dental.admin_notification_attempts t),'patientBudget',(select jsonb_agg(to_jsonb(t)) from dental.patient_notification_budget_reservations t),'adminBudget',(select jsonb_agg(to_jsonb(t)) from dental.admin_notification_budget t)) as value`)).rows[0].value;
  const before=await digest();expect(await f.base.call('select dental.claim_patient_event($1) as result',[worker])).toBeNull();expect(await f.base.call('select dental.claim_admin_delivery($1) as result',[worker])).toBeNull();
  const event=(await f.control.query("select id from dental.outbox where type='approval'")).rows[0].id,delivery=(await f.control.query('select id from dental.admin_booking_deliveries')).rows[0].id;
  expect(await f.base.call('select dental.prepare_patient_dispatch($1,$2,$3,$4::jsonb) as result',[worker,event,origin,JSON.stringify(quota)])).toBeNull();expect(await f.base.call('select dental.prepare_admin_dispatch($1,$2,$3,$4::jsonb) as result',[worker,delivery,origin,JSON.stringify(quota)])).toBeNull();expect(await digest()).toEqual(before);
 });
 it('resumes pre015 prepared retries byte-identically in both lanes',async()=>{
  await f.close();let originalClock='';f=await CombinedNotificationFixture.create([migrations[0]],async c=>{originalClock=(await c.query("select pg_get_functiondef('dental.clock_now()'::regprocedure) as definition")).rows[0].definition;});
  await queue();const p=await patientPrepare(true),a=await adminPrepare(true),pBytes=JSON.stringify(notificationPayload(p.payload)),aBytes=JSON.stringify(adminBookingPayload(a.payload));
  await f.base.call('select dental.finish_dispatch($1,$2,$3::jsonb) as result',[p.worker,p.event.id,JSON.stringify({kind:'retryable',category:'transport'})]);await f.base.call('select dental.finish_admin_dispatch($1,$2,$3::jsonb) as result',[a.worker,a.delivery.id,JSON.stringify({kind:'retryable',category:'transport'})]);
  const fakeClock=(await f.control.query("select pg_get_functiondef('dental.clock_now()'::regprocedure) as definition")).rows[0].definition;await f.control.query(originalClock);try{await f.operatorCall(readFileSync(migrations[1],'utf8'));await f.operatorCall(readFileSync(migrations[2],'utf8'));}finally{await f.control.query(fakeClock);}
  await f.base.setClock('2026-10-08T05:05:00.000Z');const p2=await patientPrepare(),a2=await adminPrepare();expect(p2.event.retryKey).toBe(p.event.retryKey);expect(a2.delivery.retryKey).toBe(a.delivery.retryKey);expect(JSON.stringify(notificationPayload(p2.payload))).toBe(pBytes);expect(JSON.stringify(adminBookingPayload(a2.payload))).toBe(aBytes);
 });
});
