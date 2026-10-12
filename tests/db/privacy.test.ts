import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {Appointment,Patient,PatientInput} from '../../src/shared/contracts';
import {booking,ReservationFixture} from '../support/reservation-postgres';
import {leakedCanaries,privateCanaries} from '../support/leak-canaries';
let fixture:ReservationFixture,owner:string,other:string,patient:Patient;
const personal:PatientInput={fullName:privateCanaries.fullName,phone:privateCanaries.phone,age:privateCanaries.age,address:privateCanaries.address,relationship:'family',authorizationAcknowledged:true};
beforeAll(async()=>{fixture=await ReservationFixture.create();});
beforeEach(async()=>{owner=await fixture.account();other=await fixture.account();patient=await fixture.call<Patient>('select dental.create_patient($1,$2::jsonb) as result',[owner,personal]);});
afterEach(async()=>{await fixture?.reset();});afterAll(async()=>{await fixture?.close();});
describe('real PostgreSQL personal canary isolation and interruption recovery',()=>{
 it('public availability and another family never disclose stored patient canaries',async()=>{await fixture.reserve(owner,randomUUID(),booking(patient));const availability=await fixture.availability('2026-10-09','2026-10-09');expect(availability).toEqual([{date:'2026-10-09',state:'available'}]);const patients=await fixture.call<Patient[]>('select dental.list_patients($1) as result',[other]);const appointments=await fixture.call<Appointment[]>('select dental.list_appointments($1) as result',[other]);expect(patients).toEqual([]);expect(appointments).toEqual([]);expect(leakedCanaries([availability,patients,appointments])).toEqual([]);});
 it('foreign patient edits, booking, appointment reads and cancellation disclose the same generic failure as absent IDs',async()=>{const appointment=await fixture.reserve(owner,randomUUID(),booking(patient));for(const foreign of [true,false]){const patientId=foreign?patient.id:randomUUID(),appointmentId=foreign?appointment.id:randomUUID();for(const[sql,values]of [
  ['select dental.update_patient($1,$2,1,$3::jsonb) as result',[other,patientId,personal]],
  ['select dental.get_appointment($1,$2) as result',[other,appointmentId]],
  ['select dental.cancel($1,$2,1) as result',[other,appointmentId]],
 ] as const){await expect(fixture.call(sql,[...values])).rejects.toMatchObject({code:'P0001',message:'NOT_FOUND'});}await expect(fixture.reserve(other,randomUUID(),{...booking(patient),patientId})).rejects.toMatchObject({code:'P0001',message:'NOT_FOUND'});}expect(await fixture.call<Appointment>('select dental.get_appointment($1,$2) as result',[owner,appointment.id])).toMatchObject({status:'pending',version:1,patient:personal});});
 it('discarded booking and cancellation responses recover one committed appointment with current cancelled status',async()=>{const key=randomUUID();await fixture.reserve(owner,key,booking(patient));const committed=await fixture.call<Appointment>('select dental.submission($1,$2) as result',[owner,key]);await fixture.call('select dental.cancel($1,$2,$3) as result',[owner,committed.id,committed.version]);const recovered=await fixture.call<Appointment>('select dental.get_appointment($1,$2) as result',[owner,committed.id]);const all=await fixture.call<Appointment[]>('select dental.list_appointments($1) as result',[owner]);expect(recovered).toMatchObject({id:committed.id,status:'cancelled',version:2});expect(all.filter(a=>a.id===committed.id)).toEqual([recovered]);expect(await fixture.count(committed.date)).toBe(0);expect(await fixture.call('select dental.submission($1,$2) as result',[other,key])).toBeNull();});
});
