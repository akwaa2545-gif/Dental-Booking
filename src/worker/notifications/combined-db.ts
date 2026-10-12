import {z} from 'zod';
import {cardNameSchema} from './card-layout';
import {isISODate} from '../../shared/calendar';
import {DatabaseError,type QueryPort} from '../db';
import {adminQuotaSchema} from '../admin-notifications/db';
import type {CombinedPatientDatabase} from './combined-types';
const instant=z.iso.datetime({offset:true});
export const combinedOriginSchema=z.string().max(2048).regex(/^https:\/\/[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$/).refine(value=>{try{return new URL(value).origin===value;}catch{return false;}});
export const combinedEventSchema=z.strictObject({id:z.uuid(),appointmentId:z.uuid(),appointmentVersion:z.number().int().positive().max(2147483647),type:z.enum(['approval','rejection','reminder','cancellation']),retryKey:z.uuid(),dueAt:instant,expiresAt:instant});
const legacyPatientEnvelopeSchema=z.strictObject({event:combinedEventSchema,provider:z.string().regex(/^line:[A-Za-z0-9_-]{1,100}$/),recipient:z.string().regex(/^U[0-9a-f]{32}$/),date:z.string().refine(isISODate),reference:z.string().regex(/^[-A-Za-z0-9]{1,80}$/),status:z.enum(['approved','rejected','cancelled']),manageUrl:z.string(),payloadVersion:z.union([z.literal(1),z.literal(2)]),preparedAt:instant,authorizationExpiresAt:instant});
export const combinedPatientEnvelopeSchema=z.union([legacyPatientEnvelopeSchema,legacyPatientEnvelopeSchema.extend({payloadVersion:z.literal(3),fullName:cardNameSchema,status:z.literal('approved'),event:combinedEventSchema.extend({type:z.literal('approval')})})]);
export const combinedPatientPreparationSchema=z.union([combinedPatientEnvelopeSchema,z.strictObject({state:z.literal('paused_quota')})]).nullable();
const sendResultSchema=z.strictObject({kind:z.enum(['accepted','retryable','permanent']),requestId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),category:z.enum(['timeout','transport','server_error','quota','rate_limited','recipient_unavailable','invalid_request','unauthorized','forbidden','unknown']).optional()});
function input<T>(schema:z.ZodType<T>,value:unknown):T{try{return schema.parse(value);}catch{throw new DatabaseError('VALIDATION');}}
/** This adapter has no legacy claim or unbudgeted preparation route. */
export function createCombinedPatientDatabase(port:QueryPort):CombinedPatientDatabase{
 async function call<T>(sql:string,values:unknown[],schema:z.ZodType<T>):Promise<T>{try{const{rows}=await port.query(sql,values);if(rows.length!==1)throw Error();return schema.parse(rows[0].result);}catch{throw new DatabaseError('UNAVAILABLE');}}
 return{
  async claimPatientEvent(workerId){return call('select dental.claim_patient_event_v3($1::uuid) as result',[input(z.uuid(),workerId)],combinedEventSchema.nullable());},
  async preparePatientDispatch(workerId,eventId,manageOrigin,quota){return await call('select dental.prepare_patient_dispatch_v3($1::uuid, $2::uuid, $3::text, $4::jsonb) as result',[input(z.uuid(),workerId),input(z.uuid(),eventId),input(combinedOriginSchema,manageOrigin),JSON.stringify(input(adminQuotaSchema.nullable(),quota))],combinedPatientPreparationSchema) as Awaited<ReturnType<CombinedPatientDatabase['preparePatientDispatch']>>;},
  async readPatientDispatchClock(){return call('select (extract(epoch from pg_catalog.clock_timestamp()) * 1000)::double precision as result',[],z.number().positive().finite());},
  async revalidatePatientDispatch(workerId,eventId){return call('select dental.revalidate_patient_dispatch($1::uuid, $2::uuid) as result',[input(z.uuid(),workerId),input(z.uuid(),eventId)],z.boolean());},
  async finishPatientDispatch(workerId,eventId,result){await call('select dental.finish_dispatch($1::uuid, $2::uuid, $3::jsonb) as result',[input(z.uuid(),workerId),input(z.uuid(),eventId),JSON.stringify(input(sendResultSchema,result))],z.boolean());},
 };
}
