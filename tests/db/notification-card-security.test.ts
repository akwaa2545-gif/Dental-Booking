// Reconstructed regression coverage against the unchanged, byte-verified recovered migrations.
import {readFileSync} from 'node:fs';
import type pg from 'pg';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {adminManagementDatabase, managementBaseline} from '../support/admin-management-postgres';

const bridge=readFileSync('db/migrations/015_notification_card_versions.sql','utf8');
const activation=readFileSync('db/migrations/016_activate_notification_cards.sql','utf8');
const rpcs=['claim_admin_delivery_v2(uuid)','claim_patient_event_v3(uuid)','prepare_admin_dispatch_v2(uuid,uuid,text,jsonb)','prepare_patient_dispatch_v3(uuid,uuid,text,jsonb)'];
const helper='_pin_notification_card_version()';
let database:Awaited<ReturnType<typeof adminManagementDatabase>>,control:pg.Client;
async function authority(){return(await control.query(`select jsonb_build_object('memberships',(select jsonb_agg(to_jsonb(m) order by roleid,member,grantor) from pg_auth_members m),'defaults',(select jsonb_agg(to_jsonb(d) order by oid) from pg_default_acl d),'roles',(select jsonb_agg(to_jsonb(r)-'rolpassword' order by oid) from pg_roles r where rolname in('dental_function_owner','dental_backend','dental_runtime')),'settings',(select jsonb_agg(to_jsonb(s) order by setdatabase,setrole) from pg_db_role_setting s)) as value`)).rows[0].value;}

describe('recovered notification-card privilege boundaries',()=>{
 beforeAll(async()=>{database=await adminManagementDatabase(true);control=await database.connect();});
 afterAll(async()=>{await control?.end();await database?.close();});
 beforeEach(async()=>{await control.query('begin');});
 afterEach(async()=>{await control.query('rollback; reset session authorization');});
 it('adds exactly four backend RPCs and one owner-only trigger, preserving authority',async()=>{
  const before=await authority();const callable=async()=>(await control.query("select oid::regprocedure::text as signature from pg_proc where pronamespace='dental'::regnamespace and has_function_privilege('dental_backend',oid,'EXECUTE') order by 1")).rows.map(row=>row.signature);
  const beforeCallable=await callable();await control.query('set session authorization postgres');await control.query(bridge);
  expect((await callable()).filter(signature=>!beforeCallable.includes(signature))).toEqual(rpcs.map(signature=>`dental.${signature}`).sort());
  expect(await authority()).toEqual(before);
  for(const signature of [...rpcs,helper]){
   const {rows:[metadata]}=await control.query("select pg_get_userbyid(proowner) as owner,prosecdef,proconfig from pg_proc where oid=$1::regprocedure",[`dental.${signature}`]);
   expect(metadata).toEqual({owner:'dental_function_owner',prosecdef:true,proconfig:['search_path=""']});
   for(const role of ['dental_runtime','dental_backend','postgres','anon','authenticated','authenticator','service_role']){
    expect((await control.query("select has_function_privilege($1,$2,'EXECUTE') as allowed",[role,`dental.${signature}`])).rows[0].allowed).toBe(signature!==helper&&['dental_runtime','dental_backend'].includes(role));
   }
   const acl=(await control.query(`select pg_get_userbyid(a.grantor) as grantor,pg_get_userbyid(a.grantee) as grantee,a.privilege_type,a.is_grantable from pg_proc p cross join lateral aclexplode(p.proacl) a where p.oid=$1::regprocedure order by grantee`,[`dental.${signature}`])).rows;
   expect(acl).toEqual((signature===helper?['dental_function_owner']:['dental_backend','dental_function_owner']).map(grantee=>({grantor:'dental_function_owner',grantee,privilege_type:'EXECUTE',is_grantable:false})));
  }
  expect((await control.query("select count(*)::int as leaks from pg_class where relnamespace='dental'::regnamespace and relkind='r' and (not relrowsecurity or not relforcerowsecurity or has_table_privilege('dental_runtime',oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') or has_any_column_privilege('dental_runtime',oid,'SELECT,INSERT,UPDATE,REFERENCES'))")).rows[0].leaks).toBe(0);
  await control.query('reset session authorization; set role dental_runtime');
  await expect(control.query('select dental._pin_notification_card_version()')).rejects.toThrow(/permission denied/);
 });
});

for(const [label,candidate] of [['015',bridge],['016',activation]] as const){
 describe(`notification-card ${label} exact-baseline rejection`,()=>{
  let db:Awaited<ReturnType<typeof adminManagementDatabase>>,c:pg.Client,before:Record<string,string>;
  beforeAll(async()=>{db=await adminManagementDatabase(true);c=await db.connect();if(label==='016'){await c.query('set session authorization postgres');await c.query(bridge);await c.query('reset session authorization');}before=await managementBaseline(c);});
  afterAll(async()=>{await c?.end();await db?.close();});
  beforeEach(async()=>{await c.query('begin');});
  afterEach(async()=>{await c.query('rollback; reset session authorization');expect(await managementBaseline(c)).toEqual(before);});
  it.each([
   ['function metadata','alter function dental.clock_now() stable'],
   ['column access','grant select(subject) on dental.accounts to dental_backend'],
   ['private helper execute','grant execute on function dental._enroll_notification_booking(dental.appointments) to dental_backend'],
   ['API schema access','grant usage on schema dental to anon'],
   ['RLS','alter table dental.outbox disable row level security'],
   ['disabled constraint trigger','alter table dental.outbox disable trigger all'],
   ['runtime owner membership','grant dental_function_owner to dental_runtime'],
   ['runtime role setting',"alter role dental_runtime set statement_timeout='9s'"],
   ['latent API column access','grant select(subject) on dental.accounts to service_role'],
   ['default ACL','alter default privileges for role postgres in schema dental grant select on tables to anon'],
   ['API exposure',"set local pgrst.db_schemas='public,dental'"],
  ])('atomically rejects %s drift',async(_,drift)=>{
   await c.query(drift);await c.query('set session authorization postgres');
   await expect(c.query(candidate)).rejects.toThrow(/baseline|access|privilege|role|API-exposed|membership/i);
  });
  it('rejects replay instead of adopting its own changed catalog',async()=>{
   await c.query('set session authorization postgres');await c.query(candidate);
   await expect(c.query(candidate)).rejects.toThrow(/baseline|already-updated/i);
  });
  it.each(['0','121s'])('requires a pre-existing bounded statement timeout (%s rejected)',async timeout=>{
   await c.query(`set local statement_timeout='${timeout}'; set session authorization postgres`);
   await expect(c.query(candidate)).rejects.toThrow(/inherited statement timeout/);
  });
 });
}
