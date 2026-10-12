import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {reservationFixtureTarget} from './reservation-postgres';

/** Only synthetic local targets. This helper never restores into an existing DB,
 * uses --clean, strips ownership/ACLs, or fetches binaries. Keep dumps private. */
export async function restoreSyntheticDatabase(){
 if(process.env.ALLOW_DISPOSABLE_RESTORE_FIXTURES!=='true')throw new Error('Prior approval for disposable native restore fixtures required.');
 const source=new URL(reservationFixtureTarget(process.env));
 if(source.password)throw new Error('This synthetic local restore harness does not accept credentials.');
 const dump=process.env.TEST_PG_DUMP??'pg_dump',restore=process.env.TEST_PG_RESTORE??'pg_restore';
 const versions={dump:execFileSync(dump,['--version'],{encoding:'utf8'}).trim(),restore:execFileSync(restore,['--version'],{encoding:'utf8'}).trim()};
 if(!/PostgreSQL\) 17\./.test(versions.dump)||!/PostgreSQL\) 17\./.test(versions.restore))throw new Error('Reviewed native PostgreSQL 17 client tools required.');
 const sourceDatabase=source.pathname.slice(1),targetDatabase=`dental_test_restore_${randomUUID().replaceAll('-','')}`;
 const folder=await mkdtemp(join(tmpdir(),'dental-test-restore-')),archive=join(folder,'synthetic.dump');
 const passwordFile=join(folder,'empty.pgpass');await writeFile(passwordFile,'',{mode:0o600});
 const env={PATH:process.env.PATH,LANG:'C',PGHOST:source.hostname,PGPORT:source.port||'5432',PGUSER:source.username,PGDATABASE:sourceDatabase,PGPASSWORD:'',PGSERVICEFILE:'/dev/null',PGPASSFILE:passwordFile,PGOPTIONS:'',PGHOSTADDR:'',PGSSLMODE:'disable'};
 execFileSync(dump,['--no-password','--format=custom','--file',archive],{env,encoding:'utf8',timeout:30000});
 const archiveSha256=createHash('sha256').update(await readFile(archive)).digest('hex');
 const control=new pg.Client({connectionString:source.href});await control.connect();
 let created=false,db:pg.Client|undefined;
 const close=async()=>{
  try{await db?.end();if(created)await control.query(`drop database "${targetDatabase}"`);}
  finally{await control.end();}
 };
 try{
  // CREATE fails rather than adopting even an astronomically unlikely collision.
  await control.query(`create database "${targetDatabase}" owner postgres template template0`);created=true;
  execFileSync(restore,['--no-password','--exit-on-error','--single-transaction','--dbname',targetDatabase,archive],{env,encoding:'utf8',timeout:30000});
  source.pathname=`/${targetDatabase}`;db=new pg.Client({connectionString:source.href});await db.connect();
  return {db,sourceDatabase,targetDatabase,archiveSha256,versions,close};
 }catch(error){await close();throw error;}
}
