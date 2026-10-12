import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {databaseTarget} from '../support/database-target';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {booking,ReservationFixture} from '../support/reservation-postgres';
let f:ReservationFixture, owner:string, admin:string;
const call=(fn:string,args:unknown[])=>f.call<unknown>(`select dental.${fn}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as result`,args);
const claim=(w:string,e:string,o=owner)=>call('claim_restricted_event',[w,e,o]);
const prepare=(w:string,e:string,o=owner)=>call('prepare_restricted_dispatch',[w,e,o,'https://clinic.example']);
async function event(){const a=await f.reserve(owner,randomUUID(),booking(await f.patient(owner)));await call('decide',[admin,a.id,a.version,'approve','Synthetic review']);return (await f.control.query("select id from dental.outbox where appointment_id=$1 and type='approval'",[a.id])).rows[0].id as string;}
async function allow(e:string,expiry='2026-10-08T06:00:00Z'){await f.control.query('insert into dental.restricted_dispatch_authorizations(event_id,owner_id,expires_at) values($1,$2,$3)',[e,owner,expiry]);}
async function snapshot(){return (await f.control.query('select to_jsonb(o) as row from dental.outbox o order by id')).rows;}
describe('restricted dispatch real PostgreSQL boundary',()=>{
 beforeAll(async()=>{f=await ReservationFixture.create();expect((await f.control.query("select to_regprocedure('dental.claim_restricted_event(uuid,uuid,uuid)') is not null as present")).rows[0].present).toBe(true);});
 beforeEach(async()=>{owner=await f.account();admin=await f.account();await f.control.query('insert into dental.admin_grants(account_id) values($1)',[admin]);await f.control.query("update dental.accounts set provider='line:1234567890',subject=$2 where id=$1",[owner,'U'+owner.replaceAll('-','')]);await call('record_line_reachability',['line:1234567890','U'+owner.replaceAll('-',''),'01000000000000000000000000','2026-10-08T04:59:59Z',true]);});
 afterEach(async()=>{if(!f)return;await f.control.query('delete from dental.restricted_dispatch_authorizations;delete from dental.notification_attempts;delete from dental.outbox;delete from dental.line_webhook_events;delete from dental.line_reachability;delete from dental.admin_grants');await f.reset();});
 afterAll(async()=>{await f?.close();});
 it('leaves the complete queue unchanged for absent, wrong-owner and expired authorization',async()=>{const e=await event();const before=await snapshot();expect(await claim(randomUUID(),e)).toEqual([]);await allow(e,'2026-10-08T04:59:59Z');expect(await claim(randomUUID(),e)).toEqual([]);await f.control.query("update dental.restricted_dispatch_authorizations set expires_at='2026-10-08T06:00:00Z'");expect(await claim(randomUUID(),e,admin)).toEqual([]);expect(await snapshot()).toEqual(before);});
 it('mutates only the approved event and spends one durable attempt across workers',async()=>{const e=await event(),other=await event(),w=randomUUID();await allow(e);const before=(await snapshot()).find(x=>x.row.id===other);expect(await claim(w,e)).toHaveLength(1);expect((await snapshot()).find(x=>x.row.id===other)).toEqual(before);expect(await prepare(w,e)).toMatchObject({event:{id:e},payloadVersion:1});expect(await prepare(w,e)).toBeNull();await f.setClock('2026-10-08T05:02:00Z');expect(await claim(randomUUID(),e)).toEqual([]);expect(await call('claim_events',[randomUUID(),10])).toMatchObject([{id:other}]);expect((await f.control.query('select consumed_at,consumed_by from dental.restricted_dispatch_authorizations')).rows[0]).toMatchObject({consumed_by:w});expect((await f.control.query('select count(*)::int n from dental.notification_attempts')).rows[0].n).toBe(1);});
 it('lets the existing runtime login read the exact builtin send-boundary clock without new grants',async()=>{
  const url=new URL(databaseTarget(process.env));url.username='dental_runtime';url.password='';
  const runtime=new pg.Client({connectionString:url.href,connectionTimeoutMillis:5000});
  try{
   await runtime.connect();
   expect((await runtime.query('select current_user,session_user')).rows[0]).toEqual({current_user:'dental_runtime',session_user:'dental_runtime'});
   const before=Date.now();
   const result=(await runtime.query('select (extract(epoch from pg_catalog.clock_timestamp()) * 1000)::double precision as result')).rows[0].result;
   const after=Date.now();
   expect(typeof result).toBe('number');expect(Number.isFinite(result)).toBe(true);
   expect(result).toBeGreaterThanOrEqual(before);expect(result).toBeLessThan(after+1);
  }finally{await runtime.end();}
 });
 it('returns trusted authorization expiry and the final database preparation time',async()=>{
  const e=await event(),w=randomUUID(),expiry='2026-10-08T05:00:10Z';
  await allow(e,expiry);await claim(w,e);
  const result=await prepare(w,e) as {authorizationExpiresAt:string;preparedAt:string;event:{expiresAt:string}};
  expect(result).not.toBeNull();
  expect(result).toHaveProperty('authorizationExpiresAt');
  expect(result).toHaveProperty('preparedAt');
  expect(new Date(result.authorizationExpiresAt).toISOString()).toBe('2026-10-08T05:00:10.000Z');
  expect(new Date(result.preparedAt).toISOString()).toBe('2026-10-08T05:00:00.000Z');
  expect(Date.parse(result.preparedAt)).toBeLessThan(Date.parse(result.authorizationExpiresAt));
  expect(Date.parse(result.authorizationExpiresAt)).toBeLessThan(Date.parse(result.event.expiresAt));
 });
 it('uses the database clock to reject authorization expiry even while the event and worker lease remain valid',async()=>{
  const e=await event(),w=randomUUID();await allow(e,'2026-10-08T05:00:10Z');await claim(w,e);
  await f.setClock('2026-10-08T05:00:10Z');
  expect((await f.control.query('select expires_at>dental.clock_now() as event_valid,lease_until>dental.clock_now() as lease_valid from dental.outbox where id=$1',[e])).rows[0]).toEqual({event_valid:true,lease_valid:true});
  expect(await prepare(w,e)).toBeNull();
  expect((await f.control.query('select consumed_at from dental.restricted_dispatch_authorizations')).rows[0].consumed_at).toBeNull();
  expect((await f.control.query('select count(*)::int n from dental.notification_attempts')).rows[0].n).toBe(0);
 });
 it('samples preparedAt after final eligibility lock waits and before authorization expiry',async()=>{
  const e=await event(),w=randomUUID();await allow(e,'2026-10-08T05:00:10Z');await claim(w,e);
  const locker=await f.lockDate('2026-10-09'),session=await f.session();let released=false;
  try{
   const pending=session.client.query('select dental.prepare_restricted_dispatch($1,$2,$3,$4) result',[w,e,owner,'https://clinic.example']);
   await f.waitForLockWaiters([session.pid]);await f.setClock('2026-10-08T05:00:09.999Z');
   await f.unlock(locker,'commit');released=true;
   const result=(await pending).rows[0].result;
   expect(result).not.toBeNull();expect(result).toHaveProperty('preparedAt');
   expect(new Date(result.preparedAt).toISOString()).toBe('2026-10-08T05:00:09.999Z');
   expect(new Date(result.authorizationExpiresAt).toISOString()).toBe('2026-10-08T05:00:10.000Z');
   expect(Date.parse(result.preparedAt)).toBeLessThan(Date.parse(result.authorizationExpiresAt));
   await session.client.query('commit');
  }finally{if(!released)await f.unlock(locker);await f.closeSession(session);}
  expect((await f.control.query('select consumed_by from dental.restricted_dispatch_authorizations')).rows[0].consumed_by).toBe(w);
 });
 it('does not consume a budget when final cancellation prevents preparation',async()=>{const e=await event(),w=randomUUID();await allow(e);await claim(w,e);const a=(await f.control.query('select a.* from dental.appointments a join dental.outbox o on o.appointment_id=a.id where o.id=$1',[e])).rows[0];await call('cancel',[owner,a.id,a.version]);expect(await prepare(w,e)).toBeNull();expect((await f.control.query('select consumed_at from dental.restricted_dispatch_authorizations')).rows[0].consumed_at).toBeNull();});
 it('rolls preparation and budget back together before commit',async()=>{const e=await event(),w=randomUUID();await allow(e);await claim(w,e);const s=await f.session();try{expect((await s.client.query('select dental.prepare_restricted_dispatch($1,$2,$3,$4) result',[w,e,owner,'https://clinic.example'])).rows[0].result).not.toBeNull();await s.client.query('rollback');}finally{await f.closeSession(s);}expect((await f.control.query('select consumed_at from dental.restricted_dispatch_authorizations')).rows[0].consumed_at).toBeNull();expect(await prepare(w,e)).not.toBeNull();});
 it('rechecks approval expiry after waiting for final date lock',async()=>{const e=await event(),w=randomUUID();await allow(e,'2026-10-08T05:00:10Z');await claim(w,e);const locker=await f.lockDate('2026-10-09'),session=await f.session();let released=false;try{const pending=session.client.query('select dental.prepare_restricted_dispatch($1,$2,$3,$4) result',[w,e,owner,'https://clinic.example']);await f.waitForLockWaiters([session.pid]);await f.setClock('2026-10-08T05:00:11Z');await f.unlock(locker,'commit');released=true;expect((await pending).rows[0].result).toBeNull();await session.client.query('commit');}finally{if(!released)await f.unlock(locker);await f.closeSession(session);}expect((await f.control.query('select consumed_at from dental.restricted_dispatch_authorizations')).rows[0].consumed_at).toBeNull();expect((await f.control.query('select count(*)::int n from dental.notification_attempts')).rows[0].n).toBe(0);});
 it('excludes authorized events from general claim and denies general prepare bypass',async()=>{const e=await event(),other=await event(),w=randomUUID();await allow(e);const result=await call('claim_events',[w,10]);expect(result).toHaveLength(1);expect(result).toMatchObject([{id:other}]);const rw=randomUUID();await claim(rw,e);await expect(call('prepare_dispatch',[rw,e,'https://clinic.example'])).rejects.toMatchObject({code:'P0001',message:'RESTRICTED_DISPATCH_REQUIRED'});expect((await f.control.query('select count(*)::int n from dental.notification_attempts')).rows[0].n).toBe(0);});
 it('rejects a previously attempted event even with fresh operator authorization',async()=>{const e=await event(),w=randomUUID();await allow(e);await claim(w,e);await prepare(w,e);await f.control.query('delete from dental.restricted_dispatch_authorizations');await allow(e);await f.setClock('2026-10-08T05:02:00Z');expect(await claim(randomUUID(),e)).toEqual([]);expect(await prepare(w,e)).toBeNull();});
 it('preserves unrelated accepted, queued, future outbox and historical attempt rows byte-for-byte',async()=>{const historical=await event(),oldWorker=randomUUID();await call('claim_events',[oldWorker,10]);await call('prepare_dispatch',[oldWorker,historical,'https://clinic.example']);await call('finish_dispatch',[oldWorker,historical,{kind:'accepted',requestId:'synthetic-historical'}]);await event();const e=await event(),w=randomUUID();await allow(e);const unrelated=async()=>({outbox:(await f.control.query('select to_jsonb(o) row from dental.outbox o where id<>$1 order by id',[e])).rows,attempts:(await f.control.query('select to_jsonb(a) row from dental.notification_attempts a where outbox_id<>$1 order by id',[e])).rows});const before=await unrelated();expect(before.attempts).toHaveLength(1);await claim(w,e);await prepare(w,e);expect(await unrelated()).toEqual(before);});
 it('gives distinct concurrent workers only one exact claim',async()=>{const e=await event();await allow(e);const results=await Promise.all([claim(randomUUID(),e),claim(randomUUID(),e)]);expect(results.filter(x=>Array.isArray(x)&&x.length===1)).toHaveLength(1);});
 it('rejects authorization for an event already attempted through general dispatch',async()=>{const e=await event(),w=randomUUID();await call('claim_events',[w,10]);await call('prepare_dispatch',[w,e,'https://clinic.example']);await allow(e);await f.setClock('2026-10-08T05:02:00Z');expect(await claim(randomUUID(),e)).toEqual([]);expect(await prepare(w,e)).toBeNull();});
 it('uses the existing reminder eligibility boundaries',async()=>{const e=await event();const reminder=(await f.control.query("select id from dental.outbox where type='reminder' and appointment_id=(select appointment_id from dental.outbox where id=$1)",[e])).rows[0].id;await allow(reminder,'2026-10-08T18:00:00Z');expect(await claim(randomUUID(),reminder)).toEqual([]);await f.setClock('2026-10-08T11:00:00Z');const w=randomUUID();expect(await claim(w,reminder)).toHaveLength(1);expect(await prepare(w,reminder)).toMatchObject({event:{id:reminder,type:'reminder'}});});
 it('does not claim a reminder past the appointment-day boundary',async()=>{const e=await event();const reminder=(await f.control.query("select id from dental.outbox where type='reminder' and appointment_id=(select appointment_id from dental.outbox where id=$1)",[e])).rows[0].id;await allow(reminder,'2026-10-09T18:00:00Z');await f.setClock('2026-10-08T17:00:00Z');const before=await snapshot();expect(await claim(randomUUID(),reminder)).toEqual([]);expect(await snapshot()).toEqual(before);});
 it('retains suppression when cancellation follows prepared dispatch',async()=>{const e=await event(),w=randomUUID();await allow(e);await claim(w,e);await prepare(w,e);const a=(await f.control.query('select a.* from dental.appointments a join dental.outbox o on o.appointment_id=a.id where o.id=$1',[e])).rows[0];await call('cancel',[owner,a.id,a.version]);expect(await call('finish_dispatch',[w,e,{kind:'accepted'}])).toBe(true);expect((await f.control.query('select state from dental.outbox where id=$1',[e])).rows[0].state).toBe('suppressed');expect(await prepare(randomUUID(),e)).toBeNull();});
 it('rolls back the prepared envelope when authorization expires at reachability lock',async()=>{const e=await event(),w=randomUUID();await allow(e,'2026-10-08T05:00:10Z');await claim(w,e);const locker=await f.session(),session=await f.session();try{await locker.client.query('reset role');await locker.client.query('select * from dental.line_reachability for update');const pending=session.client.query('select dental.prepare_restricted_dispatch($1,$2,$3,$4) result',[w,e,owner,'https://clinic.example']);await f.waitForLockWaiters([session.pid]);await f.setClock('2026-10-08T05:00:11Z');await locker.client.query('commit');expect((await pending).rows[0].result).toBeNull();await session.client.query('commit');}finally{await f.closeSession(locker);await f.closeSession(session);}expect((await f.control.query('select attempt_count,dispatch_recipient from dental.outbox where id=$1',[e])).rows[0]).toEqual({attempt_count:0,dispatch_recipient:null});expect((await f.control.query('select consumed_at from dental.restricted_dispatch_authorizations')).rows[0].consumed_at).toBeNull();});
 it('allows only one competing prepare and cannot provision through runtime',async()=>{const e=await event(),w=randomUUID();await allow(e);await claim(w,e);const results=await Promise.all([prepare(w,e),prepare(w,e)]);expect(results.filter(Boolean)).toHaveLength(1);for(const role of ['dental_runtime','dental_backend','dental_function_owner']){expect((await f.control.query("select has_table_privilege($1,'dental.restricted_dispatch_authorizations','INSERT,DELETE') allowed",[role])).rows[0].allowed).toBe(false);}await expect(call('prepare_restricted_dispatch',[randomUUID(),e,admin,'https://clinic.example'])).resolves.toBeNull();});
});
