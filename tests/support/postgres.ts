import pg from 'pg';
import{readFile}from'node:fs/promises';
import{createHash}from'node:crypto';
import{databaseTarget}from'./database-target';
import{assembleMigration}from'../../scripts/migration-bundle';
import{withTwoClients}from'./connections';
export async function connect(){
 const connectionString=databaseTarget(process.env);const host=new URL(connectionString).hostname;
 const client=new pg.Client({connectionString,connectionTimeoutMillis:5000,ssl:host.endsWith('.supabase.co')?{rejectUnauthorized:true}:undefined});
 try{await client.connect();return client;}catch(error){await client.end().catch(()=>{});throw error;}
}
/** This runner never applies migrations. Use a separately authorized applied candidate. */
export async function inspectDatabase(){
 return withTwoClients(connect,async([db,other])=>{
  const{rows:[operator]}=await db.query("select current_user,session_user,current_setting('server_version_num')::integer as version,pg_backend_pid() as pid");
  if(operator.current_user!=='postgres'||operator.session_user!=='postgres')throw new Error('Verified postgres operator session required.');
  const{rows:[{pid}]}=await other.query('select pg_backend_pid() as pid');if(pid===operator.pid)throw new Error('Independent database clients required.');
  const{rows:[{schema}]}=await db.query("select to_regnamespace('dental')::text as schema");if(!schema)throw new Error('Schema missing; apply reviewed migration only after separate authorization.');
  const source=assembleMigration(await Promise.all(['001_private_schema.sql','002_identity_patients.sql'].map(name=>readFile(`db/migrations/${name}`,'utf8'))));
  const reservationSource=await readFile('db/migrations/003_reservations.sql','utf8');
  const sessionSource=await readFile('db/migrations/004_sessions.sql','utf8');
  for(const signature of['dental.create_session(text,text,text,text,timestamptz)','dental.resolve_session(text)','dental.revoke_session(text)','dental.is_admin(uuid)','dental.save_oauth_pending(text,text,text,text,text,timestamptz)','dental.consume_oauth_pending(text,text)']){
   const{rows:[{present}]}=await db.query('select to_regprocedure($1) is not null as present',[signature]);
   if(!present)throw new Error(`Apply the reviewed Task 3 bundle, then Task 4, then the separately approved Task 5 candidate before the complete DB suite: missing ${signature}. This runner never applies migrations.`);
  }
  const{rows:definitions}=await db.query("select pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='dental' order by p.oid::regprocedure::text");
  console.info(JSON.stringify({version:operator.version,connectionIds:[operator.pid,pid],candidateHash:createHash('sha256').update(source).digest('hex'),reservationCandidateHash:createHash('sha256').update(reservationSource).digest('hex'),sessionCandidateHash:createHash('sha256').update(sessionSource).digest('hex'),actualFunctionHash:createHash('sha256').update(JSON.stringify(definitions)).digest('hex')}));
 });
}
/** Every membership/helper grant and synthetic row is rolled back. Flags record
 * previously obtained approval; they are not a substitute for that approval. */
export async function beginSynthetic(db:pg.Client){
 if(process.env.ALLOW_TEST_ROLE_GRANTS!=='true')throw new Error('Synthetic role tests require explicit prior approval of temporary postgres role/helper grants.');
 await db.query('begin');
 try{
  await db.query("set local statement_timeout='10s';set local lock_timeout='3s'");
  const{rows:[{version}]}=await db.query("select current_setting('server_version_num')::integer as version");
  if(version>=170000&&version<180000){
   await db.query('grant dental_function_owner to postgres with admin false, inherit false, set true granted by postgres');
   await db.query('grant dental_backend to postgres with admin false, inherit false, set true granted by postgres');
  }else if(version>=150000&&version<160000){await db.query('grant dental_function_owner to postgres;grant dental_backend to postgres');}
  else throw new Error('PostgreSQL version needs reviewed compatibility adaptation.');
  await db.query('set local role dental_function_owner');
  await db.query('grant execute on function dental.clock_now(), dental._normalize_patient_input(jsonb) to postgres');
  await db.query('reset role');
 }catch(error){await db.query('rollback');throw error;}
}
export async function expectedFailure(db:pg.Client,sql:string,values:unknown[]=[]){
 await db.query('savepoint expected_failure');
 try{await db.query(sql,values);return null;}catch(error){return error;}finally{await db.query('rollback to savepoint expected_failure');}
}
