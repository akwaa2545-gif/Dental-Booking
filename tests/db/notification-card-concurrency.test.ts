// Reconstructed regression coverage against the unchanged, byte-verified recovered migrations.
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import type pg from 'pg';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {adminManagementDatabase,managementBaseline} from '../support/admin-management-postgres';
import {waitForLockWaiters} from '../support/wait-for-lock-waiters';

const bridge=readFileSync('db/migrations/015_notification_card_versions.sql','utf8');
const activation=readFileSync('db/migrations/016_activate_notification_cards.sql','utf8');
let database:Awaited<ReturnType<typeof adminManagementDatabase>>,control:pg.Client;
const connections:pg.Client[]=[];
const prepared=new Set<string>();
async function connection(operator=false){const c=await database.connect();connections.push(c);if(operator)await c.query('set session authorization postgres');return c;}
async function pid(c:pg.Client){return(await c.query('select pg_backend_pid() as pid')).rows[0].pid as number;}
function run(c:pg.Client,sql:string,params:unknown[]=[]){return c.query(sql,params).then(result=>({result,error:undefined}),error=>({result:undefined,error: error as Error}));}
async function draining(migrationPid:number){
 const deadline=Date.now()+5000;
 while(Date.now()<deadline){
  await control.query('select pg_stat_clear_snapshot()');
  const state=(await control.query('select state,wait_event from pg_stat_activity where pid=$1',[migrationPid])).rows[0];
  if(state?.state==='active'&&state.wait_event==='PgSleep')return;
  await delay(10);
 }
 throw new Error('Activation did not enter its actual finite virtual-transaction drain.');
}
async function noQueueLock(migrationPid:number){
 expect((await control.query("select count(*)::int as locks from pg_locks where pid=$1 and relation in('dental.outbox'::regclass,'dental.admin_booking_deliveries'::regclass)",[migrationPid])).rows[0].locks).toBe(0);
}
async function commitBridge(){const c=await connection(true);await c.query(bridge);}
async function preparedEnabled(){expect(Number((await control.query('show max_prepared_transactions')).rows[0].max_prepared_transactions),'The isolated local runner must enable prepared transactions for these regression cases.').toBeGreaterThan(0);}
async function prepare(c:pg.Client){const gid=`synthetic_card_${randomUUID().replaceAll('-','')}`;await c.query(`prepare transaction '${gid}'`);prepared.add(gid);return gid;}
async function rollbackPrepared(gid:string){await control.query(`rollback prepared '${gid}'`);prepared.delete(gid);}
async function seed(){
 const account=randomUUID(),patient=randomUUID(),appointment=randomUUID(),event=randomUUID(),grant=randomUUID(),adminEvent=randomUUID(),delivery=randomUUID();
 await control.query("insert into dental.accounts(id,provider,subject) values($1::uuid,'synthetic-card-drain',$1::text)",[account]);
 await control.query("insert into dental.patients(id,owner_account_id,full_name,phone,age,address,relationship,authorization_acknowledged) values($1,$2,'Synthetic drain patient','0800000000',30,'Synthetic address','self',true)",[patient,account]);
 await control.query('insert into dental.clinic_dates(date) values(current_date+10) on conflict do nothing');
 await control.query("insert into dental.appointments(id,owner_account_id,patient_id,patient_version,patient_snapshot,age_captured_on,service,date,idempotency_key) values($1,$2,$3,1,$5::jsonb,current_date,'oral_check',current_date+10,$4)",[appointment,account,patient,randomUUID(),JSON.stringify({fullName:"Synthetic card patient",phone:"0800000000",age:30,address:"Synthetic address",relationship:"self",authorizationAcknowledged:true})]);
 await control.query("update dental.admin_notification_policy set enabled=true,activation_at=dental.clock_now()-interval '1 hour',authorized_end_at=dental.clock_now()+interval '6 days'");
 await control.query('insert into dental.notification_booking_enrollments(appointment_id,policy_version,activation_at,authorized_end_at,enrolled_at) select $1,version,activation_at,authorized_end_at,dental.clock_now() from dental.admin_notification_policy',[appointment]);
 await control.query("insert into dental.outbox(id,appointment_id,appointment_version,type,due_at,expires_at) values($1,$2,1,'approval',dental.clock_now(),dental.clock_now()+interval '24 hours')",[event,appointment]);
 await control.query('insert into dental.admin_grants(id,account_id) values($1,$2)',[grant,account]);
 await control.query("insert into dental.admin_booking_events(id,appointment_id,created_at,expires_at,reference,requested_date) values($1,$2,statement_timestamp(),statement_timestamp()+interval '24 hours','D-synthetic-drain',current_date+10)",[adminEvent,appointment]);
 await control.query("insert into dental.admin_booking_deliveries(id,event_id,grant_id,account_id,recipient_index,state,frozen_provider,frozen_recipient,created_at,due_at) values($1,$2,$3,$4,1,'queued','line:synthetic-card-drain',$5,dental.clock_now(),dental.clock_now())",[delivery,adminEvent,grant,account,'U'+account.replaceAll('-','')]);
 return{appointment,event,delivery};
}

describe('notification-card committed bridge and transaction-drain races on PostgreSQL 17',()=>{
 beforeEach(async()=>{database=await adminManagementDatabase(true);control=await database.connect();});
 afterEach(async()=>{
  // Release the test-owned session gate before ending potentially blocked clients.
  await control?.query('select pg_advisory_unlock_all()');
  await control?.query("select pg_cancel_backend(pid) from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and state='active'");
  for(const c of connections){await c.query('rollback').catch(()=>{});await c.end();}connections.length=0;
  for(const gid of prepared)await rollbackPrepared(gid);
  await control?.end();await database?.close();
 });
 it.each(['idle','read-only','blocked'])('captures a pre-existing %s virtual transaction before acquiring queue locks',async kind=>{
  await commitBridge();const old=await connection();const oldPid=await pid(old),controlPid=await pid(control);
  let blocked:ReturnType<typeof run>|undefined;
  if(kind==='blocked'){
   await control.query('select pg_advisory_lock(1501601)');
   blocked=run(old,'select pg_advisory_xact_lock(1501601)');await waitForLockWaiters(control,[oldPid],controlPid);
  }else await old.query(kind==='read-only'?'begin read only; select 1':'begin; select 1');
  const migration=await connection(true),migrationPid=await pid(migration),pending=run(migration,activation);
  await draining(migrationPid);await noQueueLock(migrationPid);
  if(blocked){await control.query('select pg_advisory_unlock(1501601)');expect((await blocked).error).toBeUndefined();}else await old.query('commit');
  expect((await pending).error).toBeUndefined();
  expect((await managementBaseline(control)).tables).toBe('c9b0784fec8b33ab77b8aa7f128f6a7e');
 });
 it('drains the captured VXID only and does not chase later transactions on the same backend',async()=>{
  await commitBridge();const old=await connection();await old.query('begin; select 1');
  const oldPid=await pid(old),migration=await connection(true),migrationPid=await pid(migration),pending=run(migration,activation);
  await draining(migrationPid);
  const first=(await control.query("select virtualxid from pg_locks where pid=$1 and locktype='virtualxid' and mode='ExclusiveLock'",[oldPid])).rows[0].virtualxid;
  await old.query('commit; begin; select 1');
  const second=(await control.query("select virtualxid from pg_locks where pid=$1 and locktype='virtualxid' and mode='ExclusiveLock'",[oldPid])).rows[0].virtualxid;
  expect(second).not.toBe(first);expect((await pending).error).toBeUndefined();
  expect((await control.query('select state from pg_stat_activity where pid=$1',[oldPid])).rows[0].state).toBe('idle in transaction');
  await old.query('rollback');
 });
 it('times out the actual drain atomically and leaves the bridge, grants, and defaults unchanged',async()=>{
  await commitBridge();const before=await managementBaseline(control),old=await connection();await old.query('begin read only; select 1');
  const migration=await connection(true);await migration.query("set statement_timeout='400ms'");
  const migrationPid=await pid(migration),pending=run(migration,activation);await draining(migrationPid);await noQueueLock(migrationPid);
  expect((await pending).error?.message).toMatch(/statement timeout/);expect(await managementBaseline(control)).toEqual(before);await old.query('rollback');
  await migration.query("set statement_timeout='120s'");await migration.query(activation);
  expect((await managementBaseline(control)).tables).toBe('c9b0784fec8b33ab77b8aa7f128f6a7e');
 });
 it('rejects a prepared transaction already present before capture without touching the bridge',async()=>{
  await preparedEnabled();await commitBridge();const before=await managementBaseline(control),old=await connection();
  await old.query('begin; select pg_current_xact_id()');const gid=await prepare(old),migration=await connection(true);
  await expect(migration.query(activation)).rejects.toThrow(/Prepared transactions prevent/);expect(await managementBaseline(control)).toEqual(before);await rollbackPrepared(gid);
 });
 it('rejects a captured transaction that becomes prepared during the drain',async()=>{
  await preparedEnabled();await commitBridge();const before=await managementBaseline(control),old=await connection();await old.query('begin; select pg_current_xact_id()');
  const migration=await connection(true),migrationPid=await pid(migration),pending=run(migration,activation);await draining(migrationPid);await noQueueLock(migrationPid);
  const gid=await prepare(old);expect((await pending).error?.message).toMatch(/Prepared transactions prevent/);expect(await managementBaseline(control)).toEqual(before);await rollbackPrepared(gid);
 });
 it.each(['patient','admin'])('drains an already-compiled pre015 %s claim blocked before its first queue read with the exact catalog restored',async lane=>{
  const seeded=await seed(),before=await managementBaseline(control);
  const signature=lane==='patient'?'dental.claim_patient_event(uuid)':'dental.claim_admin_delivery(uuid)';
  const table=lane==='patient'?'dental.outbox':'dental.admin_booking_deliveries',id=lane==='patient'?seeded.event:seeded.delivery;
  const {rows:[original]}=await control.query("select prosrc,pg_get_functiondef(oid) as definition from pg_proc where oid=$1::regprocedure",[signature]);
  const gated=original.prosrc.replace('BEGIN', 'BEGIN\n PERFORM pg_catalog.pg_advisory_xact_lock(1501602);');
  expect(gated).not.toBe(original.prosrc);
  await control.query(original.definition.replace(original.prosrc,gated));await control.query('select pg_advisory_lock(1501602)');
  const old=await connection(),oldPid=await pid(old),controlPid=await pid(control);await old.query('set role dental_runtime');
  const claim=run(old,`select ${signature.split('(')[0]}($1) as event`,[randomUUID()]);await waitForLockWaiters(control,[oldPid],controlPid);
  // CREATE OR REPLACE invalidates future calls, but this blocked invocation keeps
  // its already-compiled PL/pgSQL body. Neither migration text is instrumented.
  await control.query(original.definition);expect(await managementBaseline(control)).toEqual(before);
  expect((await control.query("select count(*)::int as locks from pg_locks where pid=$1 and relation=$2::regclass",[oldPid,table])).rows[0].locks).toBe(0);
  await commitBridge();const migration=await connection(true),migrationPid=await pid(migration),pending=run(migration,activation);
  await draining(migrationPid);await noQueueLock(migrationPid);
  await control.query('select pg_advisory_unlock(1501602)');const claimed=await claim;expect(claimed.error).toBeUndefined();expect(claimed.result?.rows[0].event.id).toBe(id);
  expect((await pending).error).toBeUndefined();
  expect((await control.query(`select payload_version,state from ${table} where id=$1`,[id])).rows[0]).toEqual({payload_version:1,state:'leased'});
 });
 it('allows a late producer to wait behind the cutover table lock and pins its new approval to 3',async()=>{
  const {appointment}=await seed();await commitBridge();const old=await connection();await old.query('begin; select 1');
  const migration=await connection(true),migrationPid=await pid(migration);await migration.query('begin');const pending=run(migration,activation);await draining(migrationPid);
  // This queue reader begins after capture. It is not drained, so the cutover
  // must still acquire a real table lock after the old VXID finishes.
  const reader=await connection(),readerPid=await pid(reader);await reader.query('begin; lock dental.outbox in access share mode');await old.query('commit');
  await waitForLockWaiters(control,[migrationPid],readerPid);
  const producer=await connection(),producerPid=await pid(producer);
  const inserted=run(producer,"insert into dental.outbox(appointment_id,appointment_version,type,due_at,expires_at) values($1,2,'approval',dental.clock_now(),dental.clock_now()+interval '24 hours') returning payload_version",[appointment]);
  await waitForLockWaiters(control,[producerPid],migrationPid);await reader.query('commit');expect((await pending).error).toBeUndefined();
  await waitForLockWaiters(control,[producerPid],migrationPid);await migration.query('commit');
  const result=await inserted;expect(result.error).toBeUndefined();expect(result.result?.rows).toEqual([{payload_version:3}]);
 });
});
