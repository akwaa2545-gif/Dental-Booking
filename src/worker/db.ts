import type {NotificationDatabase,RestrictedNotificationDatabase,OutboxEvent,PreparedDispatch} from './notifications/types';
import type {Pool} from 'pg';
import {z} from 'zod';
import type {AdminAppointment,Appointment,Availability,BookingInput,Decision,ErrorCode,Intake,ISODate,Patient,PatientInput,Status,UUID} from '../shared/contracts';
import {isISODate} from '../shared/calendar';
import {parseBooking,parsePatient} from '../shared/validation';
/** Actor IDs come only from verified server sessions, never client owner claims. */
export interface Database {
  isAdmin(actor:UUID):Promise<boolean>;
  listPatients(actor:UUID):Promise<Patient[]>;
  createPatient(actor:UUID,input:PatientInput):Promise<Patient>;
  updatePatient(actor:UUID,id:UUID,version:number,input:PatientInput):Promise<Patient>;
  availability(from:ISODate,to:ISODate):Promise<Availability[]>;
  reserve(actor:UUID,key:UUID,input:BookingInput):Promise<Appointment>;
  submission(actor:UUID,key:UUID):Promise<Appointment|null>;
  listAppointments(actor:UUID):Promise<Appointment[]>;
  getAppointment(actor:UUID,id:UUID):Promise<Appointment>;
  cancel(actor:UUID,id:UUID,version:number):Promise<Appointment>;
  decide(actor:UUID,id:UUID,version:number,decision:Decision,reason:string):Promise<Appointment>;
  setIntake(actor:UUID,date:ISODate,intake:Intake,reason:string):Promise<{date:ISODate;intake:Intake;unresolved:number}>;
  adminAppointments(actor:UUID,date:ISODate|null,status:Status|null):Promise<AdminAppointment[]>;
}
export interface QueryPort {query(text:string,values:unknown[]):Promise<{rows:{result:unknown}[]}>;}
export class DatabaseError extends Error {constructor(readonly code:ErrorCode){super(code);this.name='DatabaseError';}}
const safeErrors=new Set<ErrorCode>(['VALIDATION','UNAUTHENTICATED','FORBIDDEN','NOT_FOUND','VERSION_CONFLICT','FULL','INELIGIBLE_DATE','INTAKE_CLOSED','DUPLICATE','IDEMPOTENCY_CONFLICT','INVALID_TRANSITION','CUTOFF_PASSED','UNRESOLVED_BOOKINGS']);
function validate<T>(operation:()=>T):T{try{return operation();}catch{throw new DatabaseError('VALIDATION');}}
function uuid(value:string){return validate(()=>z.uuid().parse(value));}
function expectedVersion(value:number){return validate(()=>z.number().int().min(1).max(2147483647).parse(value));}
function reason(value:string){return validate(()=>z.string().trim().min(1).max(500).parse(value));}
export function createDatabase(port:QueryPort):Database & NotificationDatabase & RestrictedNotificationDatabase{
  async function call<T>(sql:string,values:unknown[],nullable=false):Promise<T>{
    try{
      const{rows}=await port.query(sql,values);
      if(rows.length!==1||rows[0].result===undefined||(!nullable&&rows[0].result===null))throw new DatabaseError('UNAVAILABLE');
      return rows[0].result as T;
    }catch(error){
      if(error&&typeof error==='object'&&'code'in error&&'message'in error&&error.code==='P0001'&&safeErrors.has(error.message as ErrorCode))throw new DatabaseError(error.message as ErrorCode);
      // Never propagate PostgreSQL detail, statements, credentials or patient values.
      throw new DatabaseError('UNAVAILABLE');
    }
  }
  return{
    async readDispatchClock(){
      // Fixed read-only built-in on the existing runtime connection: no new
      // credential, privilege, clock mutation, patient data, or budget spend.
      const value=await call<unknown>('select (extract(epoch from pg_catalog.clock_timestamp()) * 1000)::double precision as result',[]);
      if(typeof value!=='number'||!Number.isFinite(value)||value<=0)throw new DatabaseError('UNAVAILABLE');
      return value;
    },
    async claimRestrictedEvent(workerId,eventId,ownerId){
      return call<OutboxEvent[]>('select dental.claim_restricted_event($1::uuid, $2::uuid, $3::uuid) as result',[uuid(workerId),uuid(eventId),uuid(ownerId)]);
    },
    async prepareRestrictedDispatch(workerId,eventId,ownerId,manageOrigin){
      validate(()=>{const url=new URL(manageOrigin);if(url.protocol!=='https:'||url.origin!==manageOrigin||url.username||url.password)throw new Error();});
      return call<PreparedDispatch|null>('select dental.prepare_restricted_dispatch($1::uuid, $2::uuid, $3::uuid, $4::text) as result',[uuid(workerId),uuid(eventId),uuid(ownerId),manageOrigin],true);
    },
    async claimEvents(workerId,limit){
      const size=validate(()=>z.number().int().min(1).max(100).parse(limit));
      return call<OutboxEvent[]>('select dental.claim_events($1::uuid, $2::integer) as result',[uuid(workerId),size]);
    },
    async prepareDispatch(workerId,eventId,manageOrigin){
      validate(()=>{const url=new URL(manageOrigin);if(url.protocol!=='https:'||url.origin!==manageOrigin||url.username||url.password)throw new Error();});
      return call<PreparedDispatch|null>('select dental.prepare_dispatch($1::uuid, $2::uuid, $3::text) as result',[uuid(workerId),uuid(eventId),manageOrigin],true);
    },
    async finishDispatch(workerId,eventId,result){
      const safe=validate(()=>z.strictObject({kind:z.enum(['accepted','retryable','permanent']),requestId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),category:z.enum(['timeout','transport','server_error','quota','rate_limited','recipient_unavailable','invalid_request','unauthorized','forbidden','unknown']).optional()}).parse(result));
      if(await call<boolean>('select dental.finish_dispatch($1::uuid, $2::uuid, $3::jsonb) as result',[uuid(workerId),uuid(eventId),JSON.stringify(safe)])!==true)throw new DatabaseError('UNAVAILABLE');
    },
    async recordReachability(provider,subject,eventId,eventAt,reachable){
      const values=validate(()=>[z.string().regex(/^line:[A-Za-z0-9_-]{1,100}$/).parse(provider),z.string().regex(/^U[0-9a-f]{32}$/).parse(subject),z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/).parse(eventId),z.iso.datetime({offset:true}).parse(eventAt),z.boolean().parse(reachable)]);
      await call<boolean>('select dental.record_line_reachability($1::text, $2::text, $3::text, $4::timestamptz, $5::boolean) as result',values);
    },
    async isAdmin(actor){return (await call<unknown>('select dental.is_admin($1::uuid) as result',[uuid(actor)]))===true;},
    async listPatients(actor){return call<Patient[]>('select dental.list_patients($1::uuid) as result',[uuid(actor)]);},
    async createPatient(actor,input){return call<Patient>('select dental.create_patient($1::uuid, $2::jsonb) as result',[uuid(actor),JSON.stringify(validate(()=>parsePatient(input)))]);},
    async updatePatient(actor,id,version,input){
      if(!Number.isSafeInteger(version)||version<1||version>2147483647)throw new DatabaseError('VALIDATION');
      return call<Patient>('select dental.update_patient($1::uuid, $2::uuid, $3::integer, $4::jsonb) as result',[uuid(actor),uuid(id),version,JSON.stringify(validate(()=>parsePatient(input)))]);
    },
    async availability(from,to){
      if(!isISODate(from)||!isISODate(to)||from>to||Date.parse(to)-Date.parse(from)>91*86_400_000)throw new DatabaseError('VALIDATION');
      return call<Availability[]>('select dental.availability($1::date, $2::date) as result',[from,to]);
    },
    async reserve(actor,key,input){
      const parsed=validate(()=>parseBooking(input));
      if(parsed.patientVersion>2147483647)throw new DatabaseError('VALIDATION');
      return call<Appointment>('select dental.reserve($1::uuid, $2::uuid, $3::jsonb) as result',[uuid(actor),uuid(key),JSON.stringify(parsed)]);
    },
    async submission(actor,key){return call<Appointment|null>('select dental.submission($1::uuid, $2::uuid) as result',[uuid(actor),uuid(key)],true);},
    async listAppointments(actor){return call<Appointment[]>('select dental.list_appointments($1::uuid) as result',[uuid(actor)]);},
    async getAppointment(actor,id){return call<Appointment>('select dental.get_appointment($1::uuid, $2::uuid) as result',[uuid(actor),uuid(id)]);},
    async cancel(actor,id,version){
      return call<Appointment>('select dental.cancel($1::uuid, $2::uuid, $3::integer) as result',[uuid(actor),uuid(id),expectedVersion(version)]);
    },
    async decide(actor,id,version,decision,requestedReason){
      const action=validate(()=>z.enum(['approve','reject','complete','no_show','cancel']).parse(decision));
      return call<Appointment>('select dental.decide($1::uuid, $2::uuid, $3::integer, $4::text, $5::text) as result',[uuid(actor),uuid(id),expectedVersion(version),action,reason(requestedReason)]);
    },
    async setIntake(actor,date,intake,requestedReason){
      if(!isISODate(date))throw new DatabaseError('VALIDATION');
      const state=validate(()=>z.enum(['open','paused','closed']).parse(intake));
      return call<{date:ISODate;intake:Intake;unresolved:number}>('select dental.set_intake($1::uuid, $2::date, $3::text, $4::text) as result',[uuid(actor),date,state,reason(requestedReason)]);
    },
    async adminAppointments(actor,date,status){
      if(date!==null&&!isISODate(date))throw new DatabaseError('VALIDATION');
      const filter=validate(()=>z.enum(['pending','approved','rejected','cancelled','completed','no_show']).nullable().parse(status));
      return call<AdminAppointment[]>('select dental.admin_appointments($1::uuid, $2::date, $3::text) as result',[uuid(actor),date,filter]);
    },
  };
}
/** Pool lifecycle and restricted connection provisioning belong to the trusted server. */
export function createPgDatabase(pool:Pick<Pool,'query'>):Database & NotificationDatabase & RestrictedNotificationDatabase{
  return createDatabase({async query(text,values){return pool.query<{result:unknown}>(text,values);}});
}
