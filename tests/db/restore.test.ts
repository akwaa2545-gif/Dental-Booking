import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import pg from 'pg';
import {booking,ReservationFixture} from '../support/reservation-postgres';
import {syntheticPatient} from '../support/fixtures';
import {restoreSyntheticDatabase} from '../support/restore-postgres';
import {cleanupSessionFixture} from '../support/session-fixture-cleanup';
import {makeApp} from '../../src/worker';
import {createDatabase} from '../../src/worker/db';
import {createSessionStore} from '../../src/worker/auth/session';
import {createOAuthStore} from '../../src/worker/auth/oauth-store';
import {createRequestLimitStore} from '../../src/worker/security';

let fixture:ReservationFixture;
beforeAll(async()=>{fixture=await ReservationFixture.create();});
afterAll(async()=>{await fixture?.close();});
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
async function snapshot(db:pg.Client){
 const result:Record<string,unknown>={};
 const {rows:tables}=await db.query("select tablename from pg_tables where schemaname='dental' order by tablename");
 for(const {tablename} of tables){
  const quoted='"'+String(tablename).replaceAll('"','""')+'"';
  result[tablename]=(await db.query(`select to_jsonb(t) as row from dental.${quoted} t order by to_jsonb(t)::text`)).rows;
 }
 result.schema=(await db.query("select nspname,pg_get_userbyid(nspowner) as owner,nspacl::text from pg_namespace where nspname='dental'")).rows;
 result.defaults=(await db.query("select pg_get_userbyid(defaclrole) as owner,defaclobjtype,defaclacl::text from pg_default_acl where defaclnamespace='dental'::regnamespace order by owner,defaclobjtype")).rows;
 result.objects=(await db.query("select c.relname,pg_get_userbyid(c.relowner) as owner,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='dental' order by c.relname")).rows;
 result.policies=(await db.query("select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='dental' order by tablename,policyname")).rows;
 result.functions=(await db.query("select p.oid::regprocedure::text as signature,pg_get_userbyid(p.proowner) as owner,p.proacl::text,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='dental' order by signature")).rows;
 return result;
}
it('restore_preserves_capacity_and_access_controls',async()=>{
 const counterHash=hash(randomUUID());
 let owner:string|undefined,admin:string|undefined;
 let restored:Awaited<ReturnType<typeof restoreSyntheticDatabase>>|undefined;
 try{
 owner=await fixture.account();admin=await fixture.account();const outsider=await fixture.account();
 const patient=await fixture.patient(owner);
 const date='2026-10-09';await fixture.date(date);
 await fixture.control.query('insert into dental.admin_grants(account_id) values($1)',[admin]);
 const first=await fixture.reserve(owner,randomUUID(),booking(patient,date));
 await fixture.call('select dental.decide($1,$2,$3,$4,$5) as result',[admin,first.id,first.version,'approve','Synthetic recovery approval']);
 // Snapshot both pending and approved states, with durable audit and retry keys.
 for(let i=1;i<3;i++){const p=await fixture.patient(owner);await fixture.reserve(owner,randomUUID(),booking(p,date));}
 const rawToken='r'.repeat(43),token=hash(rawToken);
 await fixture.control.query("insert into dental.sessions(token_hash,csrf_hash,account_id,expires_at) values($1,$2,$3,'2026-10-08T06:00:00Z')",[token,hash(hash(`dental:csrf:v1:${rawToken}`)),admin]);
 expect(await fixture.call('select dental.consume_request_limit($1,$2) as result',['login',counterHash])).toBe(true);
 const original=await snapshot(fixture.control);
  restored=await restoreSyntheticDatabase();
  expect(await snapshot(restored.db)).toEqual(original);
  const call=async(sql:string,values:unknown[]=[])=>{
   await restored!.db.query('begin; set local role dental_backend');
   try{const result=await restored!.db.query(sql,values);await restored!.db.query('commit');return result.rows[0]?.result;}
   catch(error){await restored!.db.query('rollback');throw error;}
  };
  const port={query:async(text:string,values:unknown[])=>({rows:[{result:await call(text,values)}]})};
  const now=()=>new Date('2026-10-08T05:00:00Z');
  const requestLimits={store:createRequestLimitStore(port),keySecret:'synthetic-recovery-key-at-least-32-bytes'};
  const app=makeApp({requestLimits,db:createDatabase(port),sessions:createSessionStore(port,now),oauth:createOAuthStore(port),now,appOrigin:'https://synthetic.example',line:{channelId:'synthetic',provider:'line:synthetic-provider'},verifier:{verify:async()=>{throw new Error('External authentication forbidden in restore test');}}});
  const adminRequest=()=>app.fetch(new Request('https://synthetic.example/api/admin/appointments',{headers:{Cookie:`__Host-dental_session=${rawToken}`}}));
  expect((await adminRequest()).status).toBe(200);
  for(let i=1;i<10;i++)expect(await requestLimits.store.consume('login',counterHash)).toBe(true);
  expect(await requestLimits.store.consume('login',counterHash)).toBe(false);
  await expect(call('select dental.get_appointment($1,$2) as result',[outsider,first.id])).rejects.toMatchObject({message:'NOT_FOUND'});
  const extra=await call('select dental.create_patient($1,$2) as result',[owner,syntheticPatient]);
  await expect(call('select dental.reserve($1,$2,$3) as result',[owner,randomUUID(),booking(extra,date)])).rejects.toMatchObject({message:'FULL'});
  expect((await call('select dental.resolve_session($1) as result',[token])).isAdmin).toBe(true);
  await restored.db.query('update dental.admin_grants set revoked_at=dental.clock_now() where account_id=$1',[admin]);
  expect((await call('select dental.resolve_session($1) as result',[token])).isAdmin).toBe(false);
  const revokedAdminRequest=await adminRequest();expect(revokedAdminRequest.status).toBe(403);
  await expect(call('select dental.admin_appointments($1,null,null) as result',[admin])).rejects.toMatchObject({message:'FORBIDDEN'});
  await call('select dental.revoke_session($1) as result',[token]);
  expect(await call('select dental.resolve_session($1) as result',[token])).toBeNull();
  expect((await adminRequest()).status).toBe(401);
  await expect(call('select dental.create_session($1,$2,$3,$4,$5) as result',['line:synthetic-provider','synthetic-recovery',hash('new'),hash('csrf'),'infinity'])).rejects.toMatchObject({message:'VALIDATION'});
  for(const role of ['anon','authenticated','dental_backend']){
   await restored.db.query(`begin;set local role ${role}`);
   await expect(restored.db.query('select * from dental.patients')).rejects.toMatchObject({code:'42501'});
   await restored.db.query('rollback');
  }
  console.info(JSON.stringify({evidence:'native_pg_dump_restore',toolVersions:restored.versions,originalDatabase:restored.sourceDatabase,restoredDatabase:restored.targetDatabase,archiveSha256:restored.archiveSha256,profiles:3,appointments:3,checks:['exact-data-states-audit-retry-keys','object-owners-acls-rls','function-definitions-owners-acls','ownership','capacity','admin-revocation-http403','session-revocation-http401','session-lifetime','restored-request-limit-budget','direct-table-denial']}));
 }finally{
  await cleanupSessionFixture([
   async()=>{await restored?.close();},
   ()=>fixture.control.query('delete from dental.request_counters where key_hash=$1',[counterHash]),
   ()=>fixture.control.query('delete from dental.sessions where account_id=$1',[admin]),
   ()=>fixture.control.query('delete from dental.notification_attempts where outbox_id in (select o.id from dental.outbox o join dental.appointments a on a.id=o.appointment_id where a.owner_account_id=$1)',[owner]),
   ()=>fixture.control.query('delete from dental.outbox where appointment_id in (select id from dental.appointments where owner_account_id=$1)',[owner]),
   ()=>fixture.control.query('delete from dental.admin_grants where account_id=$1',[admin]),
  ],()=>fixture.reset());
 }
},60000);
