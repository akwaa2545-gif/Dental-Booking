// @vitest-environment node
import {describe,expect,it,vi} from 'vitest';
import type {Appointment,Decision,ErrorCode,Intake,Status} from '../../src/shared/contracts';
import {createDatabase,DatabaseError,type Database,type QueryPort} from '../../src/worker/db';
import {fixture,origin,session} from '../support/mock-line';

const actor=session.accountId;
const otherActor='10000000-0000-4000-8000-000000000099';
const id='20000000-0000-4000-8000-000000000001';
const date='2026-10-09';
const appointment:Appointment={id,reference:'SYNTHETIC',patientId:'30000000-0000-4000-8000-000000000001',patient:{fullName:'Synthetic Patient',phone:'0000000000',age:42,address:'Fictional home',relationship:'self',authorizationAcknowledged:true},service:'oral_check',date,status:'approved',version:2,createdAt:'2026-10-08T00:00:00Z',approvedAt:'2026-10-08T01:00:00Z',cancelBefore:'2026-10-08T17:00:00Z'};
const summary={date,intake:'paused' as const,unresolved:1};
const adminAppointment={...appointment,notificationAttempts:[{kind:'approval',state:'queued',attemptCount:0}]};
const cookie='__Host-dental_session='+'o'.repeat(43);
const cancelPath=`/api/appointments/${id}/cancel`;
const decisionPath=`/api/admin/appointments/${id}/decision`;
const intakePath=`/api/admin/dates/${date}`;
const cancelSql='select dental.cancel($1::uuid, $2::uuid, $3::integer) as result';
const decisionSql='select dental.decide($1::uuid, $2::uuid, $3::integer, $4::text, $5::text) as result';
const intakeSql='select dental.set_intake($1::uuid, $2::date, $3::text, $4::text) as result';
const listSql='select dental.admin_appointments($1::uuid, $2::date, $3::text) as result';
const routes=[
 {method:'POST',path:cancelPath,body:{version:1},sql:cancelSql,values:[actor,id,1],result:appointment},
 {method:'POST',path:decisionPath,body:{version:2,decision:'cancel',reason:' Emergency closure '},sql:decisionSql,values:[actor,id,2,'cancel','Emergency closure'],result:{...appointment,status:'cancelled',version:3}},
 {method:'POST',path:decisionPath,body:{version:1,decision:'approve',reason:'Reviewed'},sql:decisionSql,values:[actor,id,1,'approve','Reviewed'],result:appointment},
 {method:'PUT',path:intakePath,body:{intake:'paused',reason:' Clinic unavailable '},sql:intakeSql,values:[actor,date,'paused','Clinic unavailable'],result:summary},
 {method:'GET',path:`/api/admin/appointments?date=${date}&status=pending`,body:undefined,sql:listSql,values:[actor,date,'pending'],result:[adminAppointment]},
];
function recording(result:unknown){
 const calls:{text:string;values:unknown[]}[]=[];
 const access={admin:true,failure:null as unknown};
 const port:QueryPort={async query(text,values){
  calls.push({text,values});
  if(text==='select dental.is_admin($1::uuid) as result')return{rows:[{result:access.admin}]};
  if(access.failure)throw access.failure;
  return{rows:[{result}]};
 }};
 const db=createDatabase(port);
 const f=fixture();f.deps.db=db;
 return{...f,db,calls,access,operations:()=>calls.filter(call=>!call.text.includes('is_admin'))};
}
function request(method:string,path:string,body?:unknown,headers:Record<string,string>={}){
 return new Request(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'X-CSRF-Token':session.csrfToken,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
}
async function expectError(response:Response,code:ErrorCode,status:number){
 expect(response.status).toBe(status);
 expect(response.headers.get('Cache-Control')).toBe('no-store');
 expect(await response.json()).toEqual({error:{code,correlationId:expect.stringMatching(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i)}});
}

describe('authenticated cancellation and admin routes',()=>{
 it.each(routes)('$method $path uses only the trusted actor and parameterized private operation',async route=>{
  const{app,calls,operations}=recording(route.result);
  const response=await app.fetch(request(route.method,route.path,route.body,{'X-Account-Id':otherActor,'X-Role':'admin'}));
  expect(response.status).toBe(200);expect(await response.json()).toEqual(route.result);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(operations()).toEqual([{text:route.sql,values:route.values}]);
  expect(calls.filter(call=>call.text.includes('is_admin'))).toHaveLength(route.path.includes('/admin/')?1:0);
 });
 it.each(routes)('$method $path requires an unexpired server session',async route=>{
  const{app,deps,calls}=recording(route.result);
  await expectError(await app.fetch(request(route.method,route.path,route.body,{Cookie:''})),'UNAUTHENTICATED',401);
  vi.mocked(deps.sessions.resolve).mockResolvedValue({...session,expiresAt:'2026-10-07T00:00:00Z'});
  await expectError(await app.fetch(request(route.method,route.path,route.body)),'UNAUTHENTICATED',401);
  expect(calls).toHaveLength(0);
 });
 it.each(routes.filter(route=>route.method!=='GET'))('$method $path enforces Origin and CSRF before database access',async route=>{
  const invalidHeaders:Record<string,string>[]=[{Origin:''},{Origin:'https://foreign.invalid'},{'X-CSRF-Token':''},{'X-CSRF-Token':'wrong'}];
  for(const headers of invalidHeaders){
   const{app,calls}=recording(route.result);
   await expectError(await app.fetch(request(route.method,route.path,route.body,headers)),'FORBIDDEN',403);
   expect(calls).toHaveLength(0);
  }
 });
 it.each(routes.filter(route=>route.path.includes('/admin/')))('$method $path rejects removed admin grants despite a cached claim',async route=>{
  const{app,deps,access,operations}=recording(route.result);
  vi.mocked(deps.sessions.resolve).mockResolvedValue({...session,isAdmin:true});
  expect((await app.fetch(request(route.method,route.path,route.body))).status).toBe(200);
  access.admin=false;
  await expectError(await app.fetch(request(route.method,route.path,route.body)),'FORBIDDEN',403);
  expect(operations()).toHaveLength(1);
 });
 it('does not require or accept admin authority for self-cancellation',async()=>{
  const{app,access,calls}=recording({...appointment,status:'cancelled'});access.admin=false;
  expect((await app.fetch(request('POST',cancelPath,{version:1}))).status).toBe(200);
  expect(calls).toEqual([{text:cancelSql,values:[actor,id,1]}]);
 });
 it.each([
  ['POST',cancelPath,{version:0}],['POST',cancelPath,{version:1.5}],['POST',cancelPath,{version:2147483648}],['POST',cancelPath,{version:'1'}],['POST',cancelPath,{version:1,accountId:otherActor}],['POST',cancelPath,{version:1,reason:'not accepted'}],
  ['POST',decisionPath,{version:1,decision:'reschedule',reason:'unsupported'}],['POST',decisionPath,{version:1,decision:'reject',reason:' '}],['POST',decisionPath,{version:1,decision:'approve'}],['POST',decisionPath,{version:1,decision:'approve',reason:'x'.repeat(501)}],['POST',decisionPath,{version:1,decision:'approve',reason:'Reviewed',role:'admin'}],['POST',decisionPath,{version:-1,decision:'approve',reason:'Reviewed'}],
  ['PUT',intakePath,{intake:'paused',reason:' '}],['PUT',intakePath,{intake:'closed',reason:''}],['PUT',intakePath,{intake:'closed',reason:'x'.repeat(501)}],['PUT',intakePath,{intake:'invalid',reason:'test'}],['PUT',intakePath,{intake:'open'}],['PUT',intakePath,{intake:'open',reason:'',accountId:otherActor}],
  ['POST',cancelPath,null],['POST',decisionPath,[]],['PUT',intakePath,null],
 ] as const)('rejects invalid mutation fields %s %s',async(method,path,body)=>{
  const{app,operations}=recording(appointment);
  await expectError(await app.fetch(request(method,path,body)),'VALIDATION',400);expect(operations()).toHaveLength(0);
 });
 it.each(routes.filter(route=>route.method!=='GET'))('$method $path requires bounded well-formed JSON',async route=>{
  for(const [body,type] of [['{','application/json'],[JSON.stringify(route.body),'text/plain'],['x'.repeat(16385),'application/json']]){
   const{app,operations}=recording(route.result);
   const req=new Request(origin+route.path,{method:route.method,headers:{Cookie:cookie,Origin:origin,'X-CSRF-Token':session.csrfToken,'Content-Type':type},body});
   await expectError(await app.fetch(req),'VALIDATION',400);expect(operations()).toHaveLength(0);
  }
 });
 it.each([
  ['POST','/api/appointments/not-a-uuid/cancel',{version:1}],['POST','/api/admin/appointments/not-a-uuid/decision',{version:1,decision:'approve',reason:'Reviewed'}],
  ['PUT','/api/admin/dates/2026-02-30',{intake:'open',reason:''}],['POST',cancelPath+'?owner=forged',{version:1}],['POST',decisionPath+'?role=admin',{version:1,decision:'approve',reason:'Reviewed'}],['PUT',intakePath+'?force=true',{intake:'open',reason:''}],
 ] as const)('rejects invalid mutation URL %s %s',async(method,path,body)=>{
  const{app,operations}=recording(appointment);await expectError(await app.fetch(request(method,path,body)),'VALIDATION',400);expect(operations()).toHaveLength(0);
 });
 it.each([
  ['',null,null],[`?date=${date}`,date,null],['?status=no_show',null,'no_show'],[`?status=approved&date=${date}`,date,'approved'],
 ] as const)('validates optional admin filters %s',async(query,expectedDate,status)=>{
  const{app,operations}=recording([adminAppointment]);const response=await app.fetch(request('GET','/api/admin/appointments'+query));
  expect(response.status).toBe(200);expect(await response.json()).toEqual([adminAppointment]);expect(operations()).toEqual([{text:listSql,values:[actor,expectedDate,status]}]);
 });
 it.each(['?date=2026-02-30','?date=','?status=','?status=cancel','?date=2026-10-09&date=2026-10-10','?status=pending&status=approved','?owner=forged'])('rejects invalid admin filters %s',async query=>{
  const{app,operations}=recording([]);await expectError(await app.fetch(request('GET','/api/admin/appointments'+query)),'VALIDATION',400);expect(operations()).toHaveLength(0);
 });
 it.each([
  ['NOT_FOUND',404],['VERSION_CONFLICT',409],['INVALID_TRANSITION',409],['CUTOFF_PASSED',409],['INTAKE_CLOSED',409],['UNRESOLVED_BOOKINGS',409],['FORBIDDEN',403],
 ] as const)('returns safe database failure %s with no private details',async(code,status)=>{
  const{app,access}=recording(appointment);access.failure={code:'P0001',message:code,detail:'PRIVATE_PATIENT_CANARY'};
  await expectError(await app.fetch(request('POST',decisionPath,{version:1,decision:'approve',reason:'Reviewed'})),code,status);
 });
 it.each([new Error('PRIVATE_CONNECTION_CANARY'),{code:'P0001',message:'PRIVATE_PATIENT_CANARY'},{code:'08006',message:'FORBIDDEN',detail:'PRIVATE_CONNECTION_CANARY'}])('redacts unknown database failures',async failure=>{
  const{app,access}=recording(appointment);access.failure=failure;
  await expectError(await app.fetch(request('POST',cancelPath,{version:1})),'UNAVAILABLE',503);
 });
 it('returns the same not-found representation for foreign or missing appointments',async()=>{
  const{app,access}=recording(appointment);access.failure={code:'P0001',message:'NOT_FOUND',detail:'PRIVATE_OWNER_CANARY'};
  for(const target of [id,otherActor])await expectError(await app.fetch(request('POST',`/api/appointments/${target}/cancel`,{version:1})),'NOT_FOUND',404);
 });
});

describe('private transition adapter',()=>{
 it.each([
  {run:(db:Database)=>db.cancel(actor,id,1),sql:cancelSql,values:[actor,id,1],result:appointment},
  {run:(db:Database)=>db.decide(actor,id,2,'cancel',' Emergency closure '),sql:decisionSql,values:[actor,id,2,'cancel','Emergency closure'],result:{...appointment,status:'cancelled',version:3}},
  {run:(db:Database)=>db.decide(actor,id,1,'reject','  unavailable  '),sql:decisionSql,values:[actor,id,1,'reject','unavailable'],result:appointment},
  {run:(db:Database)=>db.setIntake(actor,date,'paused','  unavailable  '),sql:intakeSql,values:[actor,date,'paused','unavailable'],result:summary},
  {run:(db:Database)=>db.adminAppointments(actor,date,'pending'),sql:listSql,values:[actor,date,'pending'],result:[adminAppointment]},
 ])('calls $sql with normalized, parameterized values',async({run,sql,values,result})=>{
  const{db,calls}=recording(result);expect(await run(db)).toEqual(result);expect(calls).toEqual([{text:sql,values}]);
 });
 it.each([0,-1,1.5,Infinity,2147483648])('rejects invalid transition versions %s without querying',async version=>{
  const{db,calls}=recording(appointment);
  await expect(db.cancel(actor,id,version)).rejects.toEqual(new DatabaseError('VALIDATION'));
  await expect(db.decide(actor,id,version,'approve','Reviewed')).rejects.toEqual(new DatabaseError('VALIDATION'));
  expect(calls).toHaveLength(0);
 });
 it.each([
  (db:Database)=>db.cancel('invalid',id,1),(db:Database)=>db.cancel(actor,'invalid',1),
  (db:Database)=>db.decide(actor,id,1,'reschedule' as Decision,'reason'),(db:Database)=>db.decide(actor,id,1,'reject',' '),(db:Database)=>db.decide(actor,id,1,'approve','x'.repeat(501)),(db:Database)=>db.decide(actor,id,1,'approve',''),
  (db:Database)=>db.setIntake(actor,'2026-02-30','open',''),(db:Database)=>db.setIntake(actor,date,'bad' as Intake,'reason'),(db:Database)=>db.setIntake(actor,date,'closed',''),(db:Database)=>db.setIntake(actor,date,'paused','x'.repeat(501)),
  (db:Database)=>db.adminAppointments('invalid',null,null),(db:Database)=>db.adminAppointments(actor,'2026-02-30',null),(db:Database)=>db.adminAppointments(actor,null,'bad' as Status),
 ])('validates adapter inputs before querying',async run=>{
  const{db,calls}=recording(appointment);await expect(run(db)).rejects.toEqual(new DatabaseError('VALIDATION'));expect(calls).toHaveLength(0);
 });
 it.each(['FORBIDDEN','INVALID_TRANSITION','CUTOFF_PASSED','UNRESOLVED_BOOKINGS'] as const)('preserves trusted transition error %s only',async code=>{
  const{db,access}=recording(appointment);access.failure={code:'P0001',message:code,detail:'PRIVATE_CANARY'};
  await expect(db.cancel(actor,id,1)).rejects.toEqual(new DatabaseError(code));
 });
});
