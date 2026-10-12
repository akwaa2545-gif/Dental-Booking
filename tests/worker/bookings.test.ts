import {describe,expect,it} from 'vitest';
import type {Appointment,BookingInput,ErrorCode,Session} from '../../src/shared/contracts';
import {handleBookingRequest} from '../../src/worker/bookings';
import {createDatabase,DatabaseError,type QueryPort} from '../../src/worker/db';

const actor='11111111-1111-4111-8111-111111111111';
const otherActor='44444444-4444-4444-8444-444444444444';
const patientId='22222222-2222-4222-8222-222222222222';
const key='33333333-3333-4333-8333-333333333333';
const session:Session={accountId:actor,csrfToken:'synthetic-csrf',expiresAt:'2099-01-01T00:00:00Z',isAdmin:false};
const input:BookingInput={patientId,patientVersion:1,service:'oral_check',date:'2026-10-09',ageConfirmed:42,authorizationAcknowledged:true};
const appointment:Appointment={id:key,reference:'SYNTHETIC',patientId,patient:{fullName:'Synthetic person',phone:'0000000000',age:42,address:'Fictional home',relationship:'self',authorizationAcknowledged:true},service:input.service,date:input.date,status:'pending',version:1,createdAt:'2026-10-08T00:00:00Z',approvedAt:null,cancelBefore:'2026-10-08T17:00:00Z'};
function recording(value:unknown){
 const calls:{text:string;values:unknown[]}[]=[];
 const port:QueryPort={async query(text,values){calls.push({text,values});return{rows:[{result:value}]};}};
 return{db:createDatabase(port),calls};
}
function request(path:string,init:RequestInit={}){return new Request(`https://fictional.invalid${path}`,init);}
function post(body:unknown=input,headers:Record<string,string>={}){return request('/api/appointments',{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key,...headers},body:JSON.stringify(body)});}
async function expectError(response:Response|null,code:ErrorCode,status:number){
 expect(response).toBeInstanceOf(Response);expect(response!.status).toBe(status);expect(response!.headers.get('Cache-Control')).toBe('no-store');
 const body=await response!.json();expect(body).toEqual({error:{code,correlationId:expect.stringMatching(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i)}});
}

describe('booking route handler',()=>{
 it('exposes only dates and states from public availability',async()=>{
  const{db,calls}=recording([{date:input.date,state:'available',patientName:'PRIVATE_CANARY',activeCount:2}]);
  const response=await handleBookingRequest(request('/api/availability?from=2026-10-09&to=2026-10-12'),null,db);
  expect(response!.status).toBe(200);expect(await response!.json()).toEqual([{date:input.date,state:'available'}]);
  expect(response!.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
  expect(response!.headers.get('Cache-Control')).toBe('no-store');
  expect(calls).toEqual([{text:'select dental.availability($1::date, $2::date) as result',values:['2026-10-09','2026-10-12']}]);
 });
 it.each([
  '', '?from=2026-10-09', '?to=2026-10-12', '?from=2026-02-30&to=2026-03-01', '?from=2026-10-12&to=2026-10-09',
  '?from=2026-10-08&to=2027-01-08', '?from=2026-10-09&to=2026-10-12&from=2026-10-10', '?from=2026-10-09&to=2026-10-12&owner=forged',
 ])('rejects invalid availability parameters %s without querying',async query=>{
  const{db,calls}=recording([]);await expectError(await handleBookingRequest(request(`/api/availability${query}`),null,db),'VALIDATION',400);expect(calls).toHaveLength(0);
 });
 it('submits the validated booking using the trusted server-session actor',async()=>{
  const{db,calls}=recording(appointment);const response=await handleBookingRequest(post(input,{'X-Account-Id':otherActor,'X-Role':'admin'}),session,db);
  expect(response!.status).toBe(200);expect(await response!.json()).toEqual(appointment);expect(response!.headers.get('Cache-Control')).toBe('no-store');
  expect(calls).toEqual([{text:'select dental.reserve($1::uuid, $2::uuid, $3::jsonb) as result',values:[actor,key,JSON.stringify(input)]}]);
 });
 it.each([
  {...input,accountId:otherActor},{...input,owner:otherActor},{...input,role:'admin'},{...input,lineUserId:'forged'},
  {...input,status:'approved'},{...input,approvedAt:'2026-10-08T00:00:00Z'},{...input,patientVersion:2147483648},
  {...input,service:'unknown'},{...input,authorizationAcknowledged:false},{...input,ageConfirmed:1.5},null,[],
 ])('rejects invalid booking fields before querying',async invalid=>{
  const{db,calls}=recording(appointment);await expectError(await handleBookingRequest(post(invalid),session,db),'VALIDATION',400);expect(calls).toHaveLength(0);
 });
 it.each([null,'not-a-uuid',`${key}, ${key}`])('requires a single valid Idempotency-Key %s',async invalidKey=>{
  const{db,calls}=recording(appointment);const req=post();if(invalidKey===null)req.headers.delete('Idempotency-Key');else req.headers.set('Idempotency-Key',invalidKey);
  await expectError(await handleBookingRequest(req,session,db),'VALIDATION',400);expect(calls).toHaveLength(0);
 });
 it('rejects malformed JSON without querying',async()=>{
  const{db,calls}=recording(appointment);const req=request('/api/appointments',{method:'POST',headers:{'Idempotency-Key':key,'Content-Type':'application/json'},body:'{"PRIVATE_CANARY":'});
  await expectError(await handleBookingRequest(req,session,db),'VALIDATION',400);expect(calls).toHaveLength(0);
 });
 it.each([
  ['POST','/api/appointments'],['GET','/api/appointments'],['GET',`/api/appointments/${key}`],['GET',`/api/submissions/${key}`],['POST',`/api/appointments/${key}/cancel`],
 ])('requires a session for %s %s before touching the database',async(method,path)=>{
  const{db,calls}=recording(appointment);await expectError(await handleBookingRequest(request(path,{method}),null,db),'UNAUTHENTICATED',401);expect(calls).toHaveLength(0);
 });
 it.each([
  ['/api/appointments','select dental.list_appointments($1::uuid) as result',[actor],[appointment]],
  [`/api/appointments/${key}`,'select dental.get_appointment($1::uuid, $2::uuid) as result',[actor,key],appointment],
  [`/api/submissions/${key}`,'select dental.submission($1::uuid, $2::uuid) as result',[actor,key],appointment],
 ] as const)('reads %s under the session actor',async(path,text,values,value)=>{
  const{db,calls}=recording(value);const response=await handleBookingRequest(request(path),session,db);
  expect(response!.status).toBe(200);expect(await response!.json()).toEqual(value);expect(response!.headers.get('Cache-Control')).toBe('no-store');expect(calls).toEqual([{text,values}]);
 });
 it('returns JSON null for an inaccessible or unknown submission without resubmitting',async()=>{
  const{db,calls}=recording(null);const response=await handleBookingRequest(request(`/api/submissions/${key}`),{...session,accountId:otherActor},db);
  expect(response!.status).toBe(200);expect(await response!.json()).toBeNull();expect(calls).toEqual([{text:'select dental.submission($1::uuid, $2::uuid) as result',values:[otherActor,key]}]);
 });
 it.each(['/api/appointments/invalid','/api/submissions/invalid','/api/appointments?owner=forged',`/api/appointments/${key}?role=admin`,`/api/submissions/${key}?owner=forged`])('rejects malformed private lookup %s',async path=>{
  const{db,calls}=recording(appointment);await expectError(await handleBookingRequest(request(path),session,db),'VALIDATION',400);expect(calls).toHaveLength(0);
 });
 it.each([
  ['VALIDATION',400],['UNAUTHENTICATED',401],['FORBIDDEN',403],['NOT_FOUND',404],['FULL',409],['INELIGIBLE_DATE',409],['INTAKE_CLOSED',409],
  ['DUPLICATE',409],['VERSION_CONFLICT',409],['IDEMPOTENCY_CONFLICT',409],['INVALID_TRANSITION',409],['CUTOFF_PASSED',409],['UNRESOLVED_BOOKINGS',409],['RATE_LIMITED',429],['UNAVAILABLE',503],
 ] as const)('maps trusted error %s to %s without exposing details',async(code,status)=>{
  const{db}=recording(appointment);db.reserve=async()=>{throw Object.assign(new DatabaseError(code),{detail:'PRIVATE_PATIENT_CANARY'});};
  await expectError(await handleBookingRequest(post(),session,db),code,status);
 });
 it.each([new Error('PRIVATE_CREDENTIAL_CANARY'),{code:'FULL',message:'PRIVATE_PATIENT_CANARY'}])('redacts unexpected failures',async failure=>{
  const{db}=recording(appointment);db.reserve=async()=>{throw failure;};await expectError(await handleBookingRequest(post(),session,db),'UNAVAILABLE',503);
 });
 it('generates a fresh correlation ID rather than reflecting request identifiers',async()=>{
  const{db}=recording(appointment);db.reserve=async()=>{throw new DatabaseError('FULL');};
  const first=await handleBookingRequest(post(input,{'X-Correlation-Id':'PRIVATE_CANARY'}),session,db);
  const second=await handleBookingRequest(post(),session,db);
  const a=await first!.json();const b=await second!.json();expect(a.error.correlationId).not.toBe('PRIVATE_CANARY');expect(a.error.correlationId).not.toBe(b.error.correlationId);
 });
 it.each([
  ['GET','/api/patients'],['PUT','/api/appointments'],['GET','/api/admin/appointments'],['GET',`/api/appointments/${key}/extra`],
 ])('leaves unmatched route %s %s to the composing application',async(method,path)=>{
  const{db,calls}=recording(appointment);expect(await handleBookingRequest(request(path,{method}),null,db)).toBeNull();expect(calls).toHaveLength(0);
 });
});
