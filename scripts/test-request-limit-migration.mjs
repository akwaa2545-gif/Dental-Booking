// Separately authorized disposable PG17 migration tests. This is deliberately
// outside test:db, whose contract is never to apply a migration.
import assert from 'node:assert/strict';
import {Buffer} from 'node:buffer';
import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import pg from 'pg';

assert.equal(process.env.ALLOW_DISPOSABLE_MIGRATION_FIXTURES,'true','Explicit disposable migration-fixture approval is required');
const operatorUrl=new URL(process.env.TEST_DATABASE_URL);
const adminUrl=new URL(process.env.TEST_RESERVATION_ADMIN_URL);
for(const url of [operatorUrl,adminUrl]){
 assert.equal(url.hostname,'127.0.0.1','Migration safety harness is loopback-only');
 assert.match(url.pathname,/^\/dental_test_[a-z0-9_]+$/);
}
assert.equal(operatorUrl.host,adminUrl.host);
assert.equal(operatorUrl.pathname,adminUrl.pathname);
assert.equal(operatorUrl.username,'postgres');
assert.equal(adminUrl.username,'dental_test_admin');
const sql=await readFile('db/migrations/008_request_limits.sql','utf8');
const sha256=createHash('sha256').update(sql).digest('hex');
assert.equal(sha256,process.env.MIGRATION_008_SHA256,'Exact reviewed candidate SHA-256 required');
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
  functions:"select p.oid::regprocedure::text as signature,p.proowner,p.proacl::text,pg_get_functiondef(p.oid) as definition from pg_proc p where pronamespace='dental'::regnamespace order by 1",
  policies:"select to_jsonb(p) as policy from pg_policy p join pg_class c on c.oid=p.polrelid where c.relnamespace='dental'::regnamespace order by p.oid",
 }))result[key]=(await client.query(query)).rows;
 return result;
}
async function settings(){return (await db.query("select current_user,session_user,current_setting('role') as role,current_setting('lock_timeout') as lock_timeout,current_setting('statement_timeout') as statement_timeout")).rows[0];}
async function test(name,run){
 const result={name};
 try{Object.assign(result,await run(),{passed:true});}
 catch(error){result.passed=false;result.error=String(error);console.error(name,error);}
 report.cases.push(result);console.log(JSON.stringify(result));
}
async function assertAbsentAndUnchanged(baseline){
 assert.deepEqual(await snapshot(db),baseline,'Failed/rolled-back migration must preserve every existing catalog snapshot');
 assert.deepEqual((await db.query("select to_regclass('dental.request_counters')::text as counter,to_regprocedure('dental.consume_request_limit(text,text)')::text as rpc")).rows,[{counter:null,rpc:null}]);
}
async function contend(inCallerTransaction){
 await db.query("set statement_timeout='10s';set lock_timeout='0'");
 if(inCallerTransaction)await db.query("begin;set local lock_timeout='7s';savepoint before_migration");
 const before=await settings(),baseline=await snapshot(db);
 const operatorPid=(await db.query('select pg_backend_pid() as pid')).rows[0].pid;
 const blockerPid=(await blocker.query('select pg_backend_pid() as pid')).rows[0].pid;
 let outcome,waiting,pending;
 try{
  // This real uncommitted ACL change locks the namespace catalog row. The
  // contender's MVCC preflight still sees the exact committed managed baseline.
  await blocker.query("begin;set local statement_timeout='15s';GRANT CREATE ON SCHEMA dental TO dental_function_owner");
  assert.deepEqual(await snapshot(db),baseline);
  const started=performance.now();
  pending=db.query(sql).then(()=>({code:null,elapsedMs:performance.now()-started}),error=>({code:error.code,message:error.message,where:error.where,elapsedMs:performance.now()-started}));
  for(let i=0;i<100;i++){
   const row=(await observer.query('select pid,wait_event_type,wait_event,pg_blocking_pids(pid) as blockers from pg_stat_activity where pid=$1',[operatorPid])).rows[0];
   if(row?.wait_event_type==='Lock'&&row.blockers.includes(blockerPid)){waiting=row;break;}
   await delay(20);
  }
  outcome=await pending;
 }finally{
  await blocker.query('rollback');
  if(pending)await pending;
  if(inCallerTransaction)await db.query('rollback to savepoint before_migration');
 }
 const restored=await settings();
 await assertAbsentAndUnchanged(baseline);
 if(inCallerTransaction)await db.query('rollback');
 const evidence={inCallerTransaction,operatorPid,blockerPid,waiting,outcome,before,restored,catalogRestored:true,tableAbsent:true,rpcAbsent:true};
 console.log(JSON.stringify({contentionEvidence:evidence}));
 assert.ok(waiting,'Must observe real independent-session lock contention');
 assert.deepEqual(restored,before,'Failure must restore caller GUCs and role');
 assert.equal(outcome.code,'55P03','Migration must hit its lock timeout, not the inherited statement timeout');
 assert.ok(outcome.elapsedMs>=2500&&outcome.elapsedMs<6000,`Expected approximately 3s lock bound, observed ${outcome.elapsedMs}ms`);
 return evidence;
}

try{
 await Promise.all([db.connect(),blocker.connect(),observer.connect()]);
 report.configuration=(await observer.query("select current_setting('server_version') as version,current_setting('server_version_num')::integer as version_num,current_setting('listen_addresses') as listen,current_setting('unix_socket_directories') as unix_sockets")).rows[0];
 assert.equal(Math.floor(report.configuration.version_num/10000),17);
 assert.equal(report.configuration.listen,'127.0.0.1');assert.equal(report.configuration.unix_sockets,'');
 const baseline=await snapshot(db);
 assert.equal(baseline.tables.length,13);assert.equal(baseline.functions.length,30);assert.equal(baseline.memberships.length,4);
 report.baseline=baseline;
 for(const timeout of ['0','120001ms'])await test(`reject inherited statement_timeout ${timeout} before mutations`,async()=>{
  await db.query("select set_config('statement_timeout',$1,false),set_config('lock_timeout','7s',false)",[timeout]);
  const before=await settings();
  await assert.rejects(db.query(sql),{code:'P0001',message:'Task 10 requires an inherited statement timeout between 1ms and 2min'});
  await assertAbsentAndUnchanged(baseline);assert.deepEqual(await settings(),before);
  return {settingsPreserved:true,catalogRestored:true};
 });
 await test('autocommit single DO aborts contention at 3s and rolls back temporary access',()=>contend(false));
 await test('caller transaction savepoint restores state after 3s contention failure',()=>contend(true));
 await test('successful DO restores original 7s timeout before caller transaction ends',async()=>{
  await db.query("set statement_timeout='10s';set lock_timeout='11s'");
  await db.query("begin;set local lock_timeout='7s'");
  const before=await settings();
  try{
   await db.query(sql);assert.deepEqual(await settings(),before);
   assert.ok((await db.query("select to_regclass('dental.request_counters') is not null as present")).rows[0].present);
   // A successful DO must not COMMIT its caller's transaction. ROLLBACK below
   // must remove the new table/function and preserve the original catalogs.
  }finally{await db.query('rollback');}
  await assertAbsentAndUnchanged(baseline);
  assert.equal((await settings()).lock_timeout,'11s');
  return {insideTransaction:before,afterRollback:await settings(),catalogRestored:true};
 });
 await test('standalone autocommit DO succeeds and preserves original 7s timeout',async()=>{
  await db.query("set statement_timeout='10s';set lock_timeout='7s'");const before=await settings();
  await db.query(sql);assert.deepEqual(await settings(),before);
  const after=await snapshot(db);
  assert.equal(after.tables.length,14);assert.equal(after.functions.length,31);
  for(const key of ['memberships','roles','roleSettings','schema','defaults'])assert.deepEqual(after[key],baseline[key]);
  assert.deepEqual(after.functions.filter(f=>!f.signature.startsWith('dental.consume_request_limit(')),baseline.functions);
  assert.deepEqual(after.tables.filter(t=>t.relname!=='request_counters'),baseline.tables);
  assert.deepEqual(after.policies.filter(p=>!p.policy.polname.startsWith('request_counters_')),baseline.policies);
  report.applied=after;
  return {restored:await settings(),privateTables:14,functions:31,memberships:4};
 });
}finally{
 await Promise.allSettled([db.end(),blocker.end(),observer.end()]);
 report.passed=report.cases.length===6&&report.cases.every(result=>result.passed);
 await writeFile(process.env.MIGRATION_SAFETY_REPORT??'/tmp/request-limit-migration-safety.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({summary:{passed:report.passed,cases:report.cases.length,sha256}}));
}
if(!report.passed)process.exitCode=1;
