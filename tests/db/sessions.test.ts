import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import type pg from 'pg';
import {beginSynthetic,connect,expectedFailure,inspectDatabase} from '../support/postgres';
import {ReservationFixture} from '../support/reservation-postgres';
import {cleanupSessionFixture} from '../support/session-fixture-cleanup';

let db:pg.Client,subject:string,expiresAt:string;
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const tokenHash=hash('synthetic-session-token'),csrfHash=hash('synthetic-session-csrf');
const stateHash=hash('synthetic-oauth-state'),bindingHash=hash('synthetic-browser-binding');
const nonce='N'.repeat(43),verifier='V'.repeat(43);
beforeAll(async()=>{await inspectDatabase();db=await connect();});
afterAll(async()=>{await db?.end();});
beforeEach(async()=>{
 await beginSynthetic(db);subject=`synthetic-${randomUUID()}`;
 expiresAt=(await db.query("select dental.clock_now()+interval '30 minutes' as expiry")).rows[0].expiry.toISOString();
 await db.query('set local role dental_backend');
});
afterEach(async()=>{await db?.query('rollback');});
async function createSession(token=tokenHash){return(await db.query('select dental.create_session($1,$2,$3,$4,$5) as result',['line:synthetic-provider',subject,token,csrfHash,expiresAt])).rows[0].result;}
async function resolve(token=tokenHash){return(await db.query('select dental.resolve_session($1) as result',[token])).rows[0].result;}
async function savePending(){
 const expiry=new Date(Date.parse(expiresAt)-25*60000).toISOString();
 await db.query('select dental.save_oauth_pending($1,$2,$3,$4,$5,$6)',[stateHash,bindingHash,nonce,verifier,'/appointments',expiry]);return expiry;
}
async function consume(binding=bindingHash){return(await db.query('select dental.consume_oauth_pending($1,$2) as result',[stateHash,binding])).rows[0].result;}

describe('real PostgreSQL private sessions',()=>{
 it('bootstraps only the verified provider/subject account and stores hashes',async()=>{
  const session=await createSession();expect(session).toMatchObject({csrfHash,isAdmin:false});expect(session).not.toHaveProperty('token');
  expect(await resolve()).toEqual(session);
  await db.query('reset role');
  const{rows:[row]}=await db.query('select a.provider,a.subject,s.token_hash,s.csrf_hash from dental.sessions s join dental.accounts a on a.id=s.account_id where s.token_hash=$1',[tokenHash]);
  expect(row).toEqual({provider:'line:synthetic-provider',subject,token_hash:tokenHash,csrf_hash:csrfHash});
 });
 it('reuses account identity but scopes the same subject by provider',async()=>{
  const first=await createSession(),second=await createSession(hash('another-synthetic-token'));
  expect(second.accountId).toBe(first.accountId);
  const{rows:[{result:other}]}=await db.query('select dental.create_session($1,$2,$3,$4,$5) as result',['line:other-provider',subject,hash('third-token'),csrfHash,expiresAt]);
  expect(other.accountId).not.toBe(first.accountId);
 });
 it('revokes immediately and repeatedly without revealing session existence',async()=>{
  await createSession();for(let i=0;i<2;i++)await db.query('select dental.revoke_session($1)',[tokenHash]);
  expect(await resolve()).toBeNull();expect(await resolve(hash('unknown'))).toBeNull();
 });
 it('expires sessions using the database clock',async()=>{
  await createSession();await db.query('reset role');
  await db.query("update dental.sessions set created_at=dental.clock_now()-interval '2 hours',expires_at=dental.clock_now()-interval '1 hour' where token_hash=$1",[tokenHash]);
  await db.query('set local role dental_backend');expect(await resolve()).toBeNull();
 });
 it('reads admin grants live and never grants authority from provider identity',async()=>{
  const session=await createSession();expect(session.isAdmin).toBe(false);
  await db.query('reset role');await db.query('insert into dental.admin_grants(account_id) values($1)',[session.accountId]);
  await db.query('set local role dental_backend');expect((await resolve()).isAdmin).toBe(true);
  expect((await db.query('select dental.is_admin($1) as result',[session.accountId])).rows[0].result).toBe(true);
  await db.query('reset role');await db.query('update dental.admin_grants set revoked_at=dental.clock_now() where account_id=$1',[session.accountId]);
  await db.query('set local role dental_backend');expect((await resolve()).isAdmin).toBe(false);
  expect((await db.query('select dental.is_admin($1) as result',[session.accountId])).rows[0].result).toBe(false);
 });
 it('refuses authorization reads under a stale repeatable-read snapshot',async()=>{
  await db.query('rollback');await db.query("set default_transaction_isolation='repeatable read'");
  try{
   await beginSynthetic(db);await db.query('set local role dental_backend');
   for(const sql of["select dental.resolve_session(repeat('a',64))",'select dental.is_admin(null)'])expect(await expectedFailure(db,sql)).toMatchObject({code:'P0001',message:'UNAVAILABLE'});
  }finally{await db.query('rollback');await db.query("set default_transaction_isolation='read committed'");}
 });
 it('concurrent first logins reuse exactly one provider-scoped account',async()=>{
  await db.query('rollback');
  if(process.env.ALLOW_DISPOSABLE_SESSION_FIXTURES!=='true')throw new Error('Explicit prior approval of disposable Task 5 session fixtures is required; no session concurrency fixture ran.');
  const fixture=await ReservationFixture.create(),syntheticSubject=`synthetic-concurrent-${randomUUID()}`;
  const sessions:Awaited<ReturnType<typeof fixture.session>>[]=[];
  const attempts:Promise<{accountId:string}>[]=[];
  const hashes=[hash(`synthetic-${randomUUID()}`),hash(`synthetic-${randomUUID()}`)];
  try{
   sessions.push(await fixture.session(),await fixture.session());expect(sessions[0].pid).not.toBe(sessions[1].pid);
   // Block both INSERTs until the two independent clients are demonstrably in
   // flight, then let the unique provider/subject constraint arbitrate creation.
   await fixture.control.query('begin; lock table dental.accounts in share mode');
   for(const[index,session]of sessions.entries())attempts.push(session.client.query('select dental.create_session($1,$2,$3,$4,$5) as result',
    ['line:synthetic-provider',syntheticSubject,hashes[index],csrfHash,'2026-10-08T06:00:00Z']).then(async result=>{await session.client.query('commit');return result.rows[0].result;}));
   try{await fixture.waitForLockWaiters(sessions.map(session=>session.pid));}finally{await fixture.control.query('commit');}
   const results=await Promise.all(attempts);expect(results[0].accountId).toBe(results[1].accountId);
   expect((await fixture.control.query('select count(*)::integer as count from dental.sessions where account_id=$1',[results[0].accountId])).rows[0].count).toBe(2);
   expect((await fixture.control.query('select count(*)::integer as count from dental.accounts where provider=$1 and subject=$2',['line:synthetic-provider',syntheticSubject])).rows[0].count).toBe(1);
  }finally{
   await cleanupSessionFixture([
    ()=>fixture.control.query('rollback'),()=>Promise.allSettled(attempts),
    ...sessions.map(session=>()=>fixture.closeSession(session)),
    ()=>fixture.control.query('delete from dental.sessions where token_hash=any($1::text[])',[hashes]),
    ()=>fixture.control.query('delete from dental.accounts where provider=$1 and subject=$2',['line:synthetic-provider',syntheticSubject]),
   ],()=>fixture.close());
  }
 });
 it('rejects plaintext tokens, expired creation, and overlong lifetime',async()=>{
  const payloads=[['line:synthetic-provider',subject,'raw-token',csrfHash,expiresAt],['line:synthetic-provider',subject,tokenHash,csrfHash,'2000-01-01T00:00:00Z'],['line:synthetic-provider',subject,tokenHash,csrfHash,'infinity']];
  for(const values of payloads)expect(await expectedFailure(db,'select dental.create_session($1,$2,$3,$4,$5)',values)).toMatchObject({code:'P0001',message:'VALIDATION'});
 });
 it.each(['anon','authenticated'])('denies all new functions and OAuth/session tables to %s',async role=>{
  await db.query('reset role');await db.query(`set local role ${role}`);
  for(const sql of['select * from dental.sessions','select * from dental.oauth_pending',"select dental.resolve_session('x')","select dental.consume_oauth_pending('x','y')",'select dental.is_admin(null)'])expect(await expectedFailure(db,sql)).toMatchObject({code:'42501'});
 });
 it('keeps backend access confined to functions with no direct credential-table access',async()=>{
  for(const sql of['select * from dental.sessions','select * from dental.oauth_pending','insert into dental.admin_grants default values'])expect(await expectedFailure(db,sql)).toMatchObject({code:'42501'});
 });
});

describe('real PostgreSQL durable OAuth pending state',()=>{
 it('returns the server-held verifier once and then rejects replay',async()=>{
  const expiry=await savePending(),pending=await consume();
  expect(pending).toMatchObject({stateHash,bindingHash,nonce,codeVerifier:verifier,returnPath:'/appointments'});expect(Date.parse(pending.expiresAt)).toBe(Date.parse(expiry));
  expect(await consume()).toBeNull();
 });
 it('requires the browser binding without destroying a valid pending login',async()=>{
  await savePending();expect(await consume(hash('wrong-browser'))).toBeNull();expect(await consume()).not.toBeNull();
 });
 it('deletes expired matching state without returning the verifier',async()=>{
  await savePending();await db.query('reset role');await db.query("update dental.oauth_pending set created_at=pg_catalog.statement_timestamp()-interval '20 minutes',expires_at=pg_catalog.statement_timestamp()-interval '10 minutes' where state_hash=$1",[stateHash]);
  await db.query('set local role dental_backend');expect(await consume()).toBeNull();expect(await consume()).toBeNull();
 });
 it('rejects unsafe return paths and plaintext state',async()=>{
  for(const path of['https://evil.example','//evil.example','/\\evil.example','/%2fevil.example'])expect(await expectedFailure(db,'select dental.save_oauth_pending($1,$2,$3,$4,$5,$6)',[stateHash,bindingHash,nonce,verifier,path,new Date(Date.parse(expiresAt)-25*60000)])).toMatchObject({code:'P0001',message:'VALIDATION'});
 });
 it('pins definer ownership, empty search paths, RLS and a private execute surface',async()=>{
  await db.query('reset role');
  const names=['create_session','resolve_session','revoke_session','is_admin','save_oauth_pending','consume_oauth_pending'];
  const{rows}=await db.query("select p.proname,p.prosecdef,p.proconfig,r.rolname,has_function_privilege('dental_backend',p.oid,'EXECUTE') as backend,has_function_privilege('anon',p.oid,'EXECUTE') as anon,has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_roles r on r.oid=p.proowner where n.nspname='dental' and p.proname=any($1::text[])",[names]);
  expect(rows).toHaveLength(6);for(const row of rows){expect(row).toMatchObject({prosecdef:true,rolname:'dental_function_owner',backend:true,anon:false,authenticated:false});expect(row.proconfig).toContain('search_path=""');}
  expect((await db.query("select relrowsecurity,relforcerowsecurity from pg_class where oid='dental.oauth_pending'::regclass")).rows[0]).toEqual({relrowsecurity:true,relforcerowsecurity:true});
 });
 it('allows exactly one callback across two independent concurrent consumers',async()=>{
  await runConcurrentConsume(false);
 });
 it('rejects a pending login that expires while consume waits for its row lock',async()=>{
  await runConcurrentConsume(true);
 });
});

/** This fixture path is deliberately local-only and separately gated. It uses
 * synthetic committed state and restores the existing test-only clock. It must
 * never be selected merely because a hosted PostgreSQL connection is available. */
async function runConcurrentConsume(expireWhileWaiting:boolean){
 await db.query('rollback');
 if(process.env.ALLOW_DISPOSABLE_SESSION_FIXTURES!=='true')throw new Error('Explicit prior approval of disposable Task 5 OAuth fixtures is required; no session concurrency fixture ran.');
 const fixture=await ReservationFixture.create();
 const syntheticState=hash(`synthetic-${randomUUID()}`);
 const sessions:Awaited<ReturnType<typeof fixture.session>>[]=[];
 const attempts:Promise<unknown>[]=[];
 try{
  await fixture.call('select dental.save_oauth_pending($1,$2,$3,$4,$5,$6) as result',[syntheticState,bindingHash,nonce,verifier,'/appointments','2026-10-08T05:05:00Z']);
  sessions.push(await fixture.session(),await fixture.session());
  expect(new Set(sessions.map(session=>session.pid)).size).toBe(2);
  await fixture.control.query('begin');
  await fixture.control.query('select state_hash from dental.oauth_pending where state_hash=$1 for update',[syntheticState]);
  for(const session of sessions){
   attempts.push(session.client.query('select dental.consume_oauth_pending($1,$2) as result',[syntheticState,bindingHash]).then(async result=>{await session.client.query('commit');return result.rows[0].result;}));
  }
  try{
   await fixture.waitForLockWaiters(sessions.map(session=>session.pid));
   if(expireWhileWaiting)await fixture.setClock('2026-10-08T05:06:00Z');
  }finally{await fixture.control.query('commit');}
  const results=await Promise.all(attempts);
  expect(results.filter(result=>result!==null)).toHaveLength(expireWhileWaiting?0:1);
  expect(results.filter(result=>result===null)).toHaveLength(expireWhileWaiting?2:1);
 }finally{
  await cleanupSessionFixture([
   ()=>fixture.control.query('rollback'),()=>Promise.allSettled(attempts),
   ...sessions.map(session=>()=>fixture.closeSession(session)),
   ()=>fixture.control.query('delete from dental.oauth_pending where state_hash=$1',[syntheticState]),
  ],()=>fixture.close());
 }
}
