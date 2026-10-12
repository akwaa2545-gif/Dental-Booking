// Separately authorized disposable PG17 migration tests. This is deliberately
// outside test:db, whose contract is never to apply a migration.
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import pg from 'pg';
import {databaseTarget} from '../tests/support/database-target.ts';

assert.equal(process.env.ALLOW_DISPOSABLE_MIGRATION_FIXTURES,'true','Explicit disposable migration-fixture approval is required');
const operatorUrl=new URL(process.env.TEST_DATABASE_URL);
const adminUrl=new URL(process.env.TEST_RESERVATION_ADMIN_URL);
for(const url of [operatorUrl,adminUrl]){
 databaseTarget({TEST_DATABASE_URL:url.href});
 assert.equal(url.hostname,'127.0.0.1','Migration safety harness is loopback-only');
 assert.match(url.pathname,/^\/dental_test_[a-z0-9_]+$/);
}
assert.equal(operatorUrl.host,adminUrl.host);
assert.equal(operatorUrl.pathname,adminUrl.pathname);
assert.equal(operatorUrl.username,'postgres');
assert.equal(adminUrl.username,'dental_test_admin');
const sql=await readFile('db/migrations/010_restricted_dispatch_deadline.sql','utf8');
const sha256=createHash('sha256').update(sql).digest('hex');
assert.equal(sha256,process.env.MIGRATION_010_SHA256,'Exact reviewed candidate SHA-256 required');
const db=new pg.Client({connectionString:operatorUrl.href});
const blocker=new pg.Client({connectionString:adminUrl.href});
const observer=new pg.Client({connectionString:adminUrl.href});
const report={sha256,bytes:Buffer.byteLength(sql),cases:[]};

async function snapshot(client){
 const result={};
 for(const [key,query] of Object.entries({
  memberships:`select r.rolname as role,u.rolname as member,g.rolname as grantor,m.admin_option,m.inherit_option,m.set_option
   from pg_auth_members m join pg_roles r on r.oid=m.roleid join pg_roles u on u.oid=m.member join pg_roles g on g.oid=m.grantor
   where r.rolname in ('dental_backend','dental_function_owner','dental_runtime') or u.rolname in ('dental_backend','dental_function_owner','dental_runtime') order by 1,2,3`,
  roles:"select to_jsonb(r)-'rolpassword' as role from pg_roles r where rolname in ('dental_backend','dental_function_owner','dental_runtime') order by oid",
  roleSettings:"select to_jsonb(s) as setting from pg_db_role_setting s where setrole in ('dental_backend'::regrole,'dental_function_owner'::regrole,'dental_runtime'::regrole) order by setdatabase,setrole",
  schema:"select nspowner,nspacl::text from pg_namespace where nspname='dental'",
  defaults:"select to_jsonb(d) as acl from pg_default_acl d where defaclrole in ('postgres'::regrole,'dental_function_owner'::regrole) order by oid",
  tables:"select c.relname,c.relowner,c.relacl::text,c.relrowsecurity,c.relforcerowsecurity from pg_class c where relnamespace='dental'::regnamespace and relkind='r' order by relname",
  functions:"select p.oid::regprocedure::text as signature,to_jsonb(p) as attributes,pg_get_functiondef(p.oid) as definition from pg_proc p where pronamespace='dental'::regnamespace order by 1",
  triggers:"select t.tgname,t.tgrelid::regclass::text as relation,t.tgfoid::regprocedure::text as function,t.tgtype,t.tgenabled,pg_get_triggerdef(t.oid) as definition from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='dental'::regnamespace and not t.tgisinternal order by t.tgname",
  policies:"select to_jsonb(p) as policy from pg_policy p join pg_class c on c.oid=p.polrelid where c.relnamespace='dental'::regnamespace order by p.oid",
 }))result[key]=(await client.query(query)).rows;
 result.data=[];
 for(const {relname} of result.tables){
  // Approved empty disposable DB is populated with synthetic preservation rows.
  const rows=(await observer.query(`select to_jsonb(t) as row from dental."${relname}" t order by to_jsonb(t)::text`)).rows;
  result.data.push({table:relname,rows});
 }
 return result;
}
async function settings(){return (await db.query("select current_user,session_user,current_setting('role') as role,current_setting('lock_timeout') as lock_timeout,current_setting('statement_timeout') as statement_timeout")).rows[0];}
async function test(name,run){
 const result={name};
 try{Object.assign(result,await run(),{passed:true});}
 catch(error){result.passed=false;result.error=String(error);console.error(name,error);}
 report.cases.push(result);console.log(JSON.stringify(result));
}
const signature='dental.prepare_restricted_dispatch(uuid,uuid,uuid,text)';
const oldDeclaration='DECLARE v_auth dental.restricted_dispatch_authorizations; v_result jsonb;';
const oldFinalCheck="  IF v_auth.expires_at<=dental.clock_now() THEN RAISE EXCEPTION USING ERRCODE='RD001',MESSAGE='NO_RESTRICTED_DISPATCH'; END IF;";
function updated(source){
 return source.replace(oldDeclaration,oldDeclaration+' v_now timestamptz;')
  .replace(oldFinalCheck,"  v_now:=dental.clock_now();\n"+oldFinalCheck.replace('dental.clock_now()','v_now'))
  .replace(' RETURN v_result;',' RETURN v_result||pg_catalog.jsonb_build_object(\'authorizationExpiresAt\',v_auth.expires_at,\'preparedAt\',v_now);');
}
function expectedAfter(baseline){
 return {...baseline,functions:baseline.functions.map(f=>f.signature===signature?{
  ...f,definition:updated(f.definition),attributes:{...f.attributes,prosrc:updated(f.attributes.prosrc)},
 }:f)};
}
async function assertUnchanged(baseline){assert.deepEqual(await snapshot(db),baseline,'Migration must preserve all catalogs and every synthetic row');}
async function contend(inCallerTransaction){
 await db.query("set statement_timeout='10s';set lock_timeout='0'");
 if(inCallerTransaction)await db.query("begin;set local lock_timeout='7s';savepoint before_migration");
 const before=await settings(),baseline=await snapshot(db);
 const operatorPid=(await db.query('select pg_backend_pid() as pid')).rows[0].pid;
 const blockerPid=(await blocker.query('select pg_backend_pid() as pid')).rows[0].pid;
 let outcome,waiting,pending;
 try{
  await blocker.query("begin;set local statement_timeout='15s';GRANT CREATE ON SCHEMA dental TO dental_function_owner");
  assert.deepEqual(await snapshot(db),baseline);
  const started=performance.now();
  pending=db.query(sql).then(()=>({code:null,elapsedMs:performance.now()-started}),error=>({code:error.code,message:error.message,elapsedMs:performance.now()-started}));
  for(let i=0;i<100;i++){
   const row=(await observer.query('select pid,wait_event_type,wait_event,pg_blocking_pids(pid) as blockers from pg_stat_activity where pid=$1',[operatorPid])).rows[0];
   if(row?.wait_event_type==='Lock'&&row.blockers.includes(blockerPid)){waiting=row;break;}
   await delay(20);
  }
  outcome=await pending;
 }finally{
  await blocker.query('rollback');if(pending)await pending;
  if(inCallerTransaction)await db.query('rollback to savepoint before_migration');
 }
 const restored=await settings();await assertUnchanged(baseline);
 if(inCallerTransaction)await db.query('rollback');
 assert.ok(waiting,'Must observe independent-session lock contention');assert.deepEqual(restored,before);
 assert.equal(outcome.code,'55P03');assert.ok(outcome.elapsedMs>=2500&&outcome.elapsedMs<6000);
 return {inCallerTransaction,waiting,outcome,restored,catalogAndDataPreserved:true};
}
let seeded=false;
try{
 await Promise.all([db.connect(),blocker.connect(),observer.connect()]);
 report.configuration=(await observer.query("select current_setting('server_version') as version,current_setting('server_version_num')::integer as version_num,current_setting('listen_addresses') as listen,current_setting('unix_socket_directories') as unix_sockets")).rows[0];
 assert.equal(Math.floor(report.configuration.version_num/10000),17);assert.equal(report.configuration.listen,'127.0.0.1');assert.equal(report.configuration.unix_sockets,'');
 const empty=await snapshot(db);assert.equal(empty.tables.length,15);assert.equal(empty.functions.length,34);assert.equal(empty.memberships.length,4);
 assert.ok(empty.data.every(t=>t.rows.length===0),'Refuse to adopt or modify pre-existing data');
 await observer.query(`
  insert into dental.accounts(id,provider,subject) values('10000000-0000-4000-8000-000000000001','synthetic-migration-010','preservation');
  insert into dental.patients(id,owner_account_id,full_name,phone,age,address,relationship,authorization_acknowledged)
   values('10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','Synthetic preservation','0000000000',42,'Fictional','self',true);
  insert into dental.clinic_dates(date) values('2026-10-09');
  insert into dental.appointments(id,owner_account_id,patient_id,patient_version,patient_snapshot,age_captured_on,service,date,status,approved_at,idempotency_key)
   values('10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000002',1,'{"fullName":"Synthetic preservation","phone":"0000000000","age":42,"address":"Fictional","relationship":"self","authorizationAcknowledged":true}','2026-10-08','oral_check','2026-10-09','approved','2026-10-08T05:00Z','10000000-0000-4000-8000-000000000004');
  insert into dental.outbox(id,appointment_id,appointment_version,type,due_at,expires_at,state,attempt_count,accepted_at)
   values('10000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000003',1,'approval','2026-10-08T05:00Z','2026-10-09T05:00Z','accepted',1,'2026-10-08T05:01Z'),
    ('10000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000003',1,'reminder','2026-10-08T11:00Z','2026-10-08T17:00Z','queued',0,null);
  insert into dental.notification_attempts(outbox_id,attempt_number,worker_id,started_at,finished_at,result)
   values('10000000-0000-4000-8000-000000000005',1,'10000000-0000-4000-8000-000000000007','2026-10-08T05:00Z','2026-10-08T05:01Z','accepted');
  insert into dental.restricted_dispatch_authorizations(event_id,owner_id,expires_at)
   values('10000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000001','2026-10-08T12:00Z');
 `);seeded=true;
 const baseline=await snapshot(db);report.baseline=baseline;
 for(const timeout of ['0','120001ms'])await test(`reject inherited statement_timeout ${timeout} before mutations`,async()=>{
  await db.query("select set_config('statement_timeout',$1,false),set_config('lock_timeout','7s',false)",[timeout]);const before=await settings();
  await assert.rejects(db.query(sql),{code:'P0001',message:'Restricted deadline requires an inherited statement timeout between 1ms and 2min'});
  await assertUnchanged(baseline);assert.deepEqual(await settings(),before);return {catalogAndDataPreserved:true};
 });
 await db.query("set statement_timeout='10s';set lock_timeout='7s'");
 const original=baseline.functions.find(f=>f.signature===signature).definition;
 for(const [name,alter,restore] of [
  ['unreviewed source',original.replace(' RETURN v_result;'," RETURN v_result||'{}'::jsonb;"),original],
  ['unreviewed function setting',`alter function ${signature} set search_path='public'`,original],
  ['unreviewed execute ACL',`grant execute on function ${signature} to anon`,`revoke execute on function ${signature} from anon`],
  ['unreviewed runtime membership',"grant dental_function_owner to dental_runtime with inherit false,set true","revoke dental_function_owner from dental_runtime"],
 ])await test(`reject ${name} without mutation`,async()=>{
  try{
   await observer.query(alter);const changed=await snapshot(db),before=await settings();
   await assert.rejects(db.query(sql),{code:'P0001'});await assertUnchanged(changed);assert.deepEqual(await settings(),before);
  }finally{await observer.query(restore);}
  await assertUnchanged(baseline);return {catalogAndDataPreserved:true};
 });
 await test('reject API-exposed private schema without mutations',async()=>{
  await db.query("begin;set local pgrst.db_schemas='public,dental';savepoint before_migration");
  try{await assert.rejects(db.query(sql),{code:'P0001'});await db.query('rollback to savepoint before_migration');await assertUnchanged(baseline);}
  finally{await db.query('rollback');}
  return {catalogAndDataPreserved:true};
 });
 await test('autocommit bounds contention and rolls back temporary access',()=>contend(false));
 await test('caller savepoint bounds contention and preserves caller settings',()=>contend(true));
 await test('successful caller transaction can rollback the exact one-function change',async()=>{
  await db.query("set statement_timeout='10s';set lock_timeout='11s'");await db.query("begin;set local lock_timeout='7s'");const before=await settings();
  try{await db.query(sql);assert.deepEqual(await settings(),before);assert.deepEqual(await snapshot(db),expectedAfter(baseline));}
  finally{await db.query('rollback');}
  await assertUnchanged(baseline);assert.equal((await settings()).lock_timeout,'11s');return {catalogAndDataPreserved:true};
 });
 await test('standalone migration changes only target body and retains all rows and security attributes',async()=>{
  await db.query("set statement_timeout='10s';set lock_timeout='7s'");const before=await settings();
  await db.query(sql);assert.deepEqual(await settings(),before);
  const after=await snapshot(db);assert.deepEqual(after,expectedAfter(baseline));report.applied=after;
  return {privateTables:15,functions:34,memberships:4,syntheticRows:baseline.data.reduce((sum,t)=>sum+t.rows.length,0)};
 });
 await test('reject an already-applied candidate without mutation',async()=>{
  const before=await snapshot(db);await assert.rejects(db.query(sql),{code:'P0001'});await assertUnchanged(before);return {catalogAndDataPreserved:true};
 });
}finally{
 if(seeded)await observer.query(`delete from dental.restricted_dispatch_authorizations;delete from dental.notification_attempts;delete from dental.outbox;delete from dental.appointments;delete from dental.patients;delete from dental.clinic_dates;delete from dental.accounts;`);
 await Promise.allSettled([db.end(),blocker.end(),observer.end()]);
 report.passed=report.cases.length===12&&report.cases.every(result=>result.passed);
 await writeFile(process.env.MIGRATION_SAFETY_REPORT??'/tmp/restricted-deadline-migration-safety.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({summary:{passed:report.passed,cases:report.cases.length,sha256}}));
}
if(!report.passed)process.exitCode=1;
