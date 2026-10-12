import{beforeAll,afterAll,beforeEach,afterEach,describe,it,expect}from'vitest';
import{randomUUID}from'node:crypto';
import type pg from'pg';
import{connect,inspectDatabase,beginSynthetic,expectedFailure}from'../support/postgres';
import{syntheticPatient as input}from'../support/fixtures';
let db:pg.Client,a:string,b:string;
beforeAll(async()=>{await inspectDatabase();db=await connect();});
afterAll(async()=>{await db?.end();});
beforeEach(async()=>{await beginSynthetic(db);a=randomUUID();b=randomUUID();await db.query("insert into dental.accounts(id,provider,subject) values($1::uuid,'synthetic',$1::text),($2::uuid,'synthetic',$2::text)",[a,b]);await db.query('set local role dental_backend');});
afterEach(async()=>{await db?.query('rollback');});
async function create(actor=a){return(await db.query('select dental.create_patient($1,$2) as result',[actor,input])).rows[0].result;}
describe('real PostgreSQL family isolation',()=>{
 it('keeps equal name/phone profiles separate',async()=>{const pa=await create();const pb=await create(b);expect(pa.id).not.toBe(pb.id);expect((await db.query('select dental.list_patients($1) as result',[b])).rows[0].result).toEqual([pb]);});
 it('returns indistinguishable foreign and missing failures',async()=>{const p=await create();for(const id of[p.id,randomUUID()])expect(await expectedFailure(db,'select dental.update_patient($1,$2,1,$3)',[b,id,input])).toMatchObject({code:'P0001',message:'NOT_FOUND'});});
 it('rejects unknown actor',async()=>{expect(await expectedFailure(db,'select dental.create_patient($1,$2)',[randomUUID(),input])).toMatchObject({message:'UNAUTHENTICATED'});});
 it('increments version and rejects stale writes',async()=>{const p=await create();const updated=(await db.query('select dental.update_patient($1,$2,1,$3) as result',[a,p.id,{...input,age:43}])).rows[0].result;expect(updated).toMatchObject({age:43,version:2});expect(await expectedFailure(db,'select dental.update_patient($1,$2,1,$3)',[a,p.id,input])).toMatchObject({message:'VERSION_CONFLICT'});});
 it.each([{...input,owner:'forged'},{...input,age:1.5},{...input,authorizationAcknowledged:false},{...input,fullName:''}])('validates raw SQL input',async payload=>{expect(await expectedFailure(db,'select dental.create_patient($1,$2)',[a,payload])).toMatchObject({message:'VALIDATION'});});
 it('preserves appointment snapshot after profile update',async()=>{const p=await create();await db.query('reset role');await db.query("insert into dental.clinic_dates(date) values('2026-10-09') on conflict do nothing");const{rows:[appointment]}=await db.query("insert into dental.appointments(owner_account_id,patient_id,patient_version,patient_snapshot,age_captured_on,service,date,idempotency_key) values($1,$2,1,$3,'2026-10-08','oral_check','2026-10-09',$4) returning id",[a,p.id,input,randomUUID()]);await db.query('set local role dental_backend');await db.query('select dental.update_patient($1,$2,1,$3)',[a,p.id,{...input,age:43}]);await db.query('reset role');expect((await db.query('select patient_snapshot,age_captured_on::text from dental.appointments where id=$1',[appointment.id])).rows[0]).toEqual({patient_snapshot:input,age_captured_on:'2026-10-08'});expect(await expectedFailure(db,'update dental.appointments set patient_snapshot=$2 where id=$1',[appointment.id,{...input,age:99}])).toMatchObject({message:'INVALID_TRANSITION'});});
});
