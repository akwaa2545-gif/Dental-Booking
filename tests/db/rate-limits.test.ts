import {randomUUID,createHash} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type pg from 'pg';
import {beginSynthetic,connect,expectedFailure,inspectDatabase} from '../support/postgres';
import {ReservationFixture} from '../support/reservation-postgres';
const hash=()=>createHash('sha256').update(randomUUID()).digest('hex');
const sql='select dental.consume_request_limit($1::text,$2::text) as result';
let db:pg.Client;
beforeAll(async()=>{await inspectDatabase();db=await connect();});
afterAll(async()=>{await db?.end();});
beforeEach(async()=>{await beginSynthetic(db);await db.query('set local role dental_backend');});
afterEach(async()=>{await db?.query('rollback');});
async function consume(scope:string,key:string){return (await db.query(sql,[scope,key])).rows[0].result as boolean;}

describe('real PostgreSQL persisted request counters',()=>{
 it.each([['login',10],['mutation',30]] as const)('permits exactly the %s budget of %i per anchored minute',async(scope,limit)=>{
  const key=hash();for(let i=0;i<limit;i++)expect(await consume(scope,key)).toBe(true);
  for(let i=0;i<3;i++)expect(await consume(scope,key)).toBe(false);
  await db.query('reset role');const {rows:[row]}=await db.query('select scope,key_hash,request_count from dental.request_counters where scope=$1 and key_hash=$2',[scope,key]);
  expect(row).toEqual({scope,key_hash:key,request_count:limit});
 });
 it('separates scopes and identifiers',async()=>{
  const key=hash();for(let i=0;i<10;i++)await consume('login',key);expect(await consume('login',key)).toBe(false);
  expect(await consume('login',hash())).toBe(true);expect(await consume('mutation',key)).toBe(true);
 });
 it('resets only after its database-clock minute expires',async()=>{
  const key=hash();for(let i=0;i<10;i++)await consume('login',key);
  await db.query('reset role');await db.query("update dental.request_counters set window_started_at=clock_timestamp()-interval '61 seconds' where key_hash=$1",[key]);
  await db.query('set local role dental_backend');expect(await consume('login',key)).toBe(true);
  await db.query('reset role');expect((await db.query('select request_count from dental.request_counters where key_hash=$1',[key])).rows[0].request_count).toBe(1);
 });
 it('prunes at most100 expired keys per decision without deleting active counters',async()=>{
  const active=hash();await consume('login',active);await db.query('reset role');
  await db.query("insert into dental.request_counters(scope,key_hash,window_started_at,request_count) select 'login',md5(i::text)||md5(i::text),clock_timestamp()-interval '2 days',1 from generate_series(1,101) i");
  await db.query('set local role dental_backend');await consume('mutation',hash());await db.query('reset role');
  expect((await db.query("select count(*)::integer as n from dental.request_counters where window_started_at<clock_timestamp()-interval '1 day'")).rows[0].n).toBe(1);
  expect((await db.query('select request_count from dental.request_counters where key_hash=$1',[active])).rows[0].request_count).toBe(1);
 });
 it.each([['invalid', 'a'.repeat(64)],['login','203.0.113.1'],['login','A'.repeat(64)],['login',null],[null,'a'.repeat(64)]])('rejects invalid scope/key rather than persisting identifying text: %j %j',async(scope,key)=>{
  expect(await expectedFailure(db,sql,[scope,key])).toMatchObject({code:'P0001',message:'VALIDATION'});
 });
 it.each(['anon','authenticated'])('denies actual table and function access to %s',async role=>{
  await db.query('reset role');await db.query(`set local role ${role}`);
  expect(await expectedFailure(db,'select * from dental.request_counters')).toMatchObject({code:'42501'});
  expect(await expectedFailure(db,sql,['login',hash()])).toMatchObject({code:'42501'});
 });
 it('denies backend direct counter reset or read',async()=>{
  expect(await expectedFailure(db,'select * from dental.request_counters')).toMatchObject({code:'42501'});
  expect(await expectedFailure(db,'delete from dental.request_counters')).toMatchObject({code:'42501'});
 });
 it('rejects repeatable-read snapshots',async()=>{
  await db.query('rollback');await db.query("set default_transaction_isolation='repeatable read'");
  try{await beginSynthetic(db);await db.query('set local role dental_backend');expect(await expectedFailure(db,sql,['login',hash()])).toMatchObject({code:'P0001',message:'UNAVAILABLE'});}
  finally{await db.query('rollback');await db.query("set default_transaction_isolation='read committed'");}
 });
 it('arbitrates20 independent clients atomically with exactly10 accepted logins',async()=>{
  await db.query('rollback');const fixture=await ReservationFixture.create();const key=hash();const sessions:Awaited<ReturnType<typeof fixture.session>>[]=[];const attempts:Promise<boolean>[]=[];
  try{
   for(let i=0;i<20;i++)sessions.push(await fixture.session());
   await fixture.control.query('begin; lock table dental.request_counters in share mode');
   for(const session of sessions)attempts.push(session.client.query(sql,['login',key]).then(async result=>{await session.client.query('commit');return result.rows[0].result as boolean;}));
   try{await fixture.waitForLockWaiters(sessions.map(s=>s.pid));}finally{await fixture.control.query('commit');}
   const outcomes=await Promise.all(attempts);expect(outcomes.filter(Boolean)).toHaveLength(10);expect(outcomes.filter(v=>!v)).toHaveLength(10);
   expect((await fixture.control.query('select request_count from dental.request_counters where key_hash=$1',[key])).rows[0].request_count).toBe(10);
   console.info(JSON.stringify({test:'twenty_clients_request_limit',backendConnectionIds:sessions.map(s=>s.pid),allowed:10,limited:10}));
  }finally{await fixture.control.query('rollback');await Promise.allSettled(attempts);for(const session of sessions)await fixture.closeSession(session);try{await fixture.control.query('delete from dental.request_counters where key_hash=$1',[key]);}finally{await fixture.close();}}
 });
 it('keeps opposite-batch expired targets live under concurrent bounded cleanup',async()=>{
  await db.query('rollback');const fixture=await ReservationFixture.create();
  const keys=Array.from({length:201},(_,i)=>i.toString(16).padStart(64,'0'));
  const sessions:Awaited<ReturnType<typeof fixture.session>>[]=[];
  const attempts:Promise<{allowed:boolean}|{error:string}>[]=[];
  const barrier=7438022;
  try{
   await fixture.control.query("insert into dental.request_counters(scope,key_hash,window_started_at,request_count) select 'login',key,'2026-10-06T00:00:00Z',1 from unnest($1::text[]) key",[keys]);
   // Disposable-only scheduling hook: pause each real RPC at its target write,
   // then release both. A shared lock permits real concurrency after release.
   await fixture.control.query(`create function dental_test_reservations.counter_insert_barrier() returns trigger
    language plpgsql security invoker set search_path='' as $test$
    begin perform pg_catalog.pg_advisory_xact_lock_shared(${barrier}); return new; end; $test$;
    revoke all on function dental_test_reservations.counter_insert_barrier() from public;
    create trigger counter_insert_barrier before insert or update on dental.request_counters
    for each row execute function dental_test_reservations.counter_insert_barrier()`);
   await fixture.control.query('select pg_advisory_lock($1)',[barrier]);
   const {rows:[{pid:blocker}]}=await fixture.control.query('select pg_backend_pid() as pid');
   for(const target of [keys[150],keys[50]]){
    const session=await fixture.session();sessions.push(session);
    attempts.push(session.client.query(sql,['login',target]).then(async result=>{await session.client.query('commit');return{allowed:result.rows[0].result as boolean};},async(error:unknown)=>{await session.client.query('rollback');return{error:String((error as {code?:string}).code)};}));
    await fixture.waitForLockWaiters([session.pid],blocker);
   }
   await fixture.control.query('select pg_advisory_unlock($1)',[barrier]);
   const results=await Promise.all(attempts);
   console.info(JSON.stringify({test:'opposite_batch_counter_cleanup',backendConnectionIds:sessions.map(session=>session.pid),results}));
   expect(results).toEqual([{allowed:true},{allowed:true}]);
   expect((await fixture.control.query('select key_hash,request_count from dental.request_counters where key_hash=any($1::text[]) order by key_hash',[[keys[50],keys[150]]])).rows).toEqual([{key_hash:keys[50],request_count:1},{key_hash:keys[150],request_count:1}]);
  }finally{
   await fixture.control.query('rollback');await fixture.control.query('select pg_advisory_unlock($1)',[barrier]);
   await Promise.allSettled(attempts);for(const session of sessions)await fixture.closeSession(session);
   try{await fixture.control.query('drop trigger if exists counter_insert_barrier on dental.request_counters; drop function if exists dental_test_reservations.counter_insert_barrier()');await fixture.control.query('delete from dental.request_counters where key_hash=any($1::text[])',[keys]);}finally{await fixture.close();}
  }
 });
 it('retains an expired target when another cleanup runs during its acquisition',async()=>{
  await db.query('rollback');const fixture=await ReservationFixture.create();
  const keys=Array.from({length:201},(_,i)=>i.toString(16).padStart(64,'0')),target=keys[150],other=hash();
  const sessions:Awaited<ReturnType<typeof fixture.session>>[]=[];
  let first:Promise<{allowed:boolean}|{error:string}>|undefined;
  const barrier=7438023;
  try{
   await fixture.control.query("insert into dental.request_counters(scope,key_hash,window_started_at,request_count) select 'login',key,'2026-10-06T00:00:00Z',1 from unnest($1::text[]) key",[keys]);
   // On the buggy function this pauses after conflict detection but before its
   // STRICT lookup. On target-first code it pauses with an already-locked row.
   await fixture.control.query(`create function dental_test_reservations.counter_decision_barrier() returns trigger
    language plpgsql security invoker set search_path='' as $test$
    begin if pg_catalog.current_setting('dental_test.pause_counter',true)='yes' then perform pg_catalog.pg_advisory_xact_lock_shared(${barrier}); end if; return null; end; $test$;
    revoke all on function dental_test_reservations.counter_decision_barrier() from public;
    create trigger counter_decision_barrier after insert or update on dental.request_counters
    for each statement execute function dental_test_reservations.counter_decision_barrier()`);
   await fixture.control.query('select pg_advisory_lock($1)',[barrier]);
   const {rows:[{pid:blocker}]}=await fixture.control.query('select pg_backend_pid() as pid');
   const contender=await fixture.session();sessions.push(contender);
   await contender.client.query("set local dental_test.pause_counter='yes'");
   first=contender.client.query(sql,['login',target]).then(async result=>{await contender.client.query('commit');return{allowed:result.rows[0].result as boolean};},async(error:unknown)=>{await contender.client.query('rollback');return{error:String((error as {code?:string}).code)};});
   await fixture.waitForLockWaiters([contender.pid],blocker);
   expect(await fixture.call<boolean>(sql,['login',other])).toBe(true);
   await fixture.control.query('select pg_advisory_unlock($1)',[barrier]);
   const result=await first;console.info(JSON.stringify({test:'counter_cleanup_during_target_acquisition',backendConnectionId:contender.pid,result}));
   expect(result).toEqual({allowed:true});
   expect((await fixture.control.query('select request_count from dental.request_counters where key_hash=$1',[target])).rows).toEqual([{request_count:1}]);
  }finally{
   await fixture.control.query('rollback');await fixture.control.query('select pg_advisory_unlock($1)',[barrier]);
   await first;for(const session of sessions)await fixture.closeSession(session);
   try{await fixture.control.query('drop trigger if exists counter_decision_barrier on dental.request_counters; drop function if exists dental_test_reservations.counter_decision_barrier()');await fixture.control.query('delete from dental.request_counters where key_hash=any($1::text[])',[[...keys,other]]);}finally{await fixture.close();}
  }
 });
 it('rechecks time after waiting for a contested row lock',async()=>{
  await db.query('rollback');const fixture=await ReservationFixture.create();const key=hash();let pending:Promise<boolean>|undefined;const session=await fixture.session();
  try{
   await fixture.control.query("insert into dental.request_counters(scope,key_hash,window_started_at,request_count) values('login',$1,'2026-10-08T04:00:00Z',10)",[key]);
   await fixture.setClock('2026-10-08T04:00:59Z');
   await fixture.control.query('begin');await fixture.control.query('select * from dental.request_counters where key_hash=$1 for update',[key]);
   pending=session.client.query(sql,['login',key]).then(async result=>{await session.client.query('commit');return result.rows[0].result as boolean;});
   await fixture.waitForLockWaiters([session.pid]);
   // Clock changes and row release commit together, after the contender has begun.
   await fixture.setClock('2026-10-08T04:01:00Z');await fixture.control.query('commit');
   expect(await pending).toBe(true);
   expect((await fixture.control.query('select request_count from dental.request_counters where key_hash=$1',[key])).rows[0].request_count).toBe(1);
  }finally{await fixture.control.query('rollback');await pending?.catch(()=>{});await fixture.closeSession(session);try{await fixture.control.query('delete from dental.request_counters where key_hash=$1',[key]);}finally{await fixture.close();}}
 });
});
