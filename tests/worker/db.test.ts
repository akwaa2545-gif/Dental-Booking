import {describe,it,expect} from 'vitest';
import {createDatabase,DatabaseError,type QueryPort} from '../../src/worker/db';
const actor='11111111-1111-4111-8111-111111111111';
const id='22222222-2222-4222-8222-222222222222';
const input={fullName:'Synthetic person',phone:'0000000000',age:42,address:'Fictional home',relationship:'self' as const,authorizationAcknowledged:true as const};
const patient={...input,id,version:1,ageCapturedOn:'2026-10-08'};
const key='33333333-3333-4333-8333-333333333333';
const booking={patientId:id,patientVersion:1,service:'oral_check' as const,date:'2026-10-09',ageConfirmed:42,authorizationAcknowledged:true as const};
const appointment={id:key,reference:'SYNTHETIC',patientId:id,patient:input,service:'oral_check' as const,date:booking.date,status:'pending' as const,version:1,createdAt:'2026-10-08T00:00:00Z',approvedAt:null,cancelBefore:'2026-10-08T17:00:00Z'};
function recording(value:unknown){const calls:{text:string;values:unknown[]}[]=[];const port:QueryPort={async query(text,values){calls.push({text,values});return{rows:[{result:value}]};}};return{port,calls};}
describe('private PostgreSQL adapter',()=>{
 it('lists through owner-scoped private function',async()=>{const{port,calls}=recording([patient]);expect(await createDatabase(port).listPatients(actor)).toEqual([patient]);expect(calls).toEqual([{text:'select dental.list_patients($1::uuid) as result',values:[actor]}]);});
 it('parameterizes normalized patient input',async()=>{const{port,calls}=recording(patient);const malicious="Robert'); DROP TABLE dental.patients;--";await createDatabase(port).createPatient(actor,{...input,fullName:' '+malicious+' '});expect(calls).toEqual([{text:'select dental.create_patient($1::uuid, $2::jsonb) as result',values:[actor,JSON.stringify({...input,fullName:malicious})]}]);});
 it('includes actor, ID and expected version in update',async()=>{const{port,calls}=recording(patient);expect(await createDatabase(port).updatePatient(actor,id,1,input)).toEqual(patient);expect(calls).toEqual([{text:'select dental.update_patient($1::uuid, $2::uuid, $3::integer, $4::jsonb) as result',values:[actor,id,1,JSON.stringify(input)]}]);});
 it.each([0,-1,1.5,Infinity,2147483648])('rejects unsafe version%s',async version=>{const{port,calls}=recording(patient);await expect(createDatabase(port).updatePatient(actor,id,version,input)).rejects.toMatchObject({code:'VALIDATION'});expect(calls).toHaveLength(0);});
 it('rejects forged ownership without querying',async()=>{const{port,calls}=recording(patient);await expect(createDatabase(port).createPatient(actor,{...input,owner:actor} as typeof input)).rejects.toMatchObject({code:'VALIDATION'});expect(calls).toHaveLength(0);});
 it('rejects malformed actor without querying',async()=>{const{port,calls}=recording([]);await expect(createDatabase(port).listPatients('forged')).rejects.toMatchObject({code:'VALIDATION'});expect(calls).toHaveLength(0);});
 it.each(['VALIDATION','UNAUTHENTICATED','NOT_FOUND','VERSION_CONFLICT'] as const)('returns only safe error %s',async code=>{const port:QueryPort={async query(){throw{code:'P0001',message:code,detail:'PRIVATE_CANARY'};}};await expect(createDatabase(port).listPatients(actor)).rejects.toEqual(new DatabaseError(code));});
 it.each([{code:'08006',message:'PRIVATE_CREDENTIAL'},{code:'P0001',message:'PRIVATE_PATIENT'}])('redacts unknown errors',async failure=>{const port:QueryPort={async query(){throw failure;}};await expect(createDatabase(port).listPatients(actor)).rejects.toEqual(new DatabaseError('UNAVAILABLE'));});
 it('fails closed on missing result',async()=>{const port:QueryPort={async query(){return{rows:[]};}};await expect(createDatabase(port).listPatients(actor)).rejects.toMatchObject({code:'UNAVAILABLE'});});
});

describe('reservation PostgreSQL adapter',()=>{
 it('calls the private availability function with parameterized date bounds',async()=>{
  const days=[{date:'2026-10-09',state:'available'}];const{port,calls}=recording(days);
  expect(await createDatabase(port).availability('2026-10-09','2026-10-12')).toEqual(days);
  expect(calls).toEqual([{text:'select dental.availability($1::date, $2::date) as result',values:['2026-10-09','2026-10-12']}]);
 });
 it.each([
  ['2026-02-30','2026-03-01'],['2026-10-10','2026-10-09'],['2026-10-08','2027-01-08'],['2026-1-01','2026-01-02'],['0000-01-01','0000-01-02'],
 ])('rejects invalid or excessively broad availability %s to %s before querying',async(from,to)=>{
  const{port,calls}=recording([]);await expect(createDatabase(port).availability(from,to)).rejects.toEqual(new DatabaseError('VALIDATION'));expect(calls).toHaveLength(0);
 });
 it('reserves through one atomic private function call with actor and idempotency key',async()=>{
  const{port,calls}=recording(appointment);
  expect(await createDatabase(port).reserve(actor,key,booking)).toEqual(appointment);
  expect(calls).toEqual([{text:'select dental.reserve($1::uuid, $2::uuid, $3::jsonb) as result',values:[actor,key,JSON.stringify(booking)]}]);
 });
 it.each([
  {...booking,owner:actor},{...booking,status:'approved'},{...booking,patientVersion:2147483648},{...booking,authorizationAcknowledged:false},{...booking,date:'2026-02-30'},
 ])('rejects invalid booking input before any query',async badInput=>{
  const{port,calls}=recording(appointment);await expect(createDatabase(port).reserve(actor,key,badInput as typeof booking)).rejects.toEqual(new DatabaseError('VALIDATION'));expect(calls).toHaveLength(0);
 });
 it.each([[actor,'invalid'],['invalid',key]])('rejects malformed reserve identities %s %s before querying',async(owner,submissionKey)=>{
  const{port,calls}=recording(appointment);await expect(createDatabase(port).reserve(owner,submissionKey,booking)).rejects.toEqual(new DatabaseError('VALIDATION'));expect(calls).toHaveLength(0);
 });
 it('looks up a committed submission only for the supplied actor',async()=>{
  const{port,calls}=recording(appointment);expect(await createDatabase(port).submission(actor,key)).toEqual(appointment);
  expect(calls).toEqual([{text:'select dental.submission($1::uuid, $2::uuid) as result',values:[actor,key]}]);
 });
 it('preserves a null submission result for a key with no accessible booking',async()=>{
  const{port}=recording(null);expect(await createDatabase(port).submission(actor,key)).toBeNull();
 });
 it('still fails closed when submission returns no result row',async()=>{
  const port:QueryPort={async query(){return{rows:[]};}};await expect(createDatabase(port).submission(actor,key)).rejects.toEqual(new DatabaseError('UNAVAILABLE'));
 });
 it('lists actor-owned appointments through the private function',async()=>{
  const{port,calls}=recording([appointment]);expect(await createDatabase(port).listAppointments(actor)).toEqual([appointment]);
  expect(calls).toEqual([{text:'select dental.list_appointments($1::uuid) as result',values:[actor]}]);
 });
 it('retrieves one appointment with both actor and opaque ID',async()=>{
  const{port,calls}=recording(appointment);expect(await createDatabase(port).getAppointment(actor,id)).toEqual(appointment);
  expect(calls).toEqual([{text:'select dental.get_appointment($1::uuid, $2::uuid) as result',values:[actor,id]}]);
 });
 it.each(['FULL','INELIGIBLE_DATE','INTAKE_CLOSED','DUPLICATE','VERSION_CONFLICT','IDEMPOTENCY_CONFLICT'] as const)('preserves the safe reservation error %s',async code=>{
  const port:QueryPort={async query(){throw{code:'P0001',message:code,detail:'PRIVATE_PATIENT_CANARY'};}};
  await expect(createDatabase(port).reserve(actor,key,booking)).rejects.toEqual(new DatabaseError(code));
 });
 it('does not expose a database failure that happens to contain a public error word',async()=>{
  const port:QueryPort={async query(){throw{code:'08006',message:'FULL',detail:'PRIVATE_CONNECTION_CANARY'};}};
  await expect(createDatabase(port).reserve(actor,key,booking)).rejects.toEqual(new DatabaseError('UNAVAILABLE'));
 });
});
