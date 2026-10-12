import {z} from 'zod';
import {cardNameSchema,cardPhoneSchema} from '../notifications/card-layout';
import {isISODate} from '../../shared/calendar';
import {DatabaseError,type QueryPort} from '../db';
import {ADMIN_MANAGE_ORIGIN} from './payload';
import type {AdminNotificationDatabase} from './types';
const instant=z.iso.datetime({offset:true});
export const adminDeliverySchema=z.strictObject({id:z.uuid(),eventId:z.uuid(),appointmentId:z.uuid(),grantId:z.uuid(),retryKey:z.uuid(),createdAt:instant,dueAt:instant,expiresAt:instant});
export const adminQuotaSchema=z.strictObject({type:z.literal('limited'),value:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),totalUsage:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),observedAt:instant});
const legacyAdminEnvelopeSchema=z.strictObject({delivery:adminDeliverySchema,provider:z.string().regex(/^line:[A-Za-z0-9_-]{1,100}$/),recipient:z.string().regex(/^U[0-9a-f]{32}$/),reference:z.string().regex(/^[-A-Za-z0-9]{1,80}$/),date:z.string().refine(isISODate),manageUrl:z.literal(`${ADMIN_MANAGE_ORIGIN}/admin`),payloadVersion:z.literal(1),preparedAt:instant,authorizationValidUntil:instant});
export const adminEnvelopeSchema=z.discriminatedUnion('payloadVersion',[legacyAdminEnvelopeSchema,legacyAdminEnvelopeSchema.extend({payloadVersion:z.literal(2),fullName:cardNameSchema,phone:cardPhoneSchema})]);
export const adminPreparationSchema=z.union([adminEnvelopeSchema,z.strictObject({state:z.literal('paused_quota')})]).nullable();
const sendResultSchema=z.strictObject({kind:z.enum(['accepted','retryable','permanent']),requestId:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/).optional(),category:z.enum(['timeout','transport','server_error','quota','rate_limited','recipient_unavailable','invalid_request','unauthorized','forbidden','unknown']).optional()});
function input<T>(schema:z.ZodType<T>,value:unknown):T{try{return schema.parse(value);}catch{throw new DatabaseError('VALIDATION');}}
/** Admin-only RPC surface. It cannot call the patient queue or extend a lease. */
export function createAdminNotificationDatabase(port:QueryPort):AdminNotificationDatabase{
 async function call<T>(sql:string,values:unknown[],schema:z.ZodType<T>):Promise<T>{
  try{const {rows}=await port.query(sql,values);if(rows.length!==1)throw Error();return schema.parse(rows[0].result);}catch{throw new DatabaseError('UNAVAILABLE');}
 }
 return{
  async claimAdminDelivery(workerId){return call('select dental.claim_admin_delivery_v2($1::uuid) as result',[input(z.uuid(),workerId)],adminDeliverySchema.nullable());},
  async prepareAdminDispatch(workerId,deliveryId,manageOrigin,quota){
   const result=await call('select dental.prepare_admin_dispatch_v2($1::uuid, $2::uuid, $3::text, $4::jsonb) as result',[input(z.uuid(),workerId),input(z.uuid(),deliveryId),input(z.literal(ADMIN_MANAGE_ORIGIN),manageOrigin),JSON.stringify(input(adminQuotaSchema.nullable(),quota))],adminPreparationSchema);
   return result as Awaited<ReturnType<AdminNotificationDatabase['prepareAdminDispatch']>>;
  },
  async readAdminDispatchClock(){return call('select (extract(epoch from pg_catalog.clock_timestamp()) * 1000)::double precision as result',[],z.number().positive().finite());},
  async revalidateAdminDispatch(workerId,deliveryId){return call('select dental.revalidate_admin_dispatch($1::uuid, $2::uuid) as result',[input(z.uuid(),workerId),input(z.uuid(),deliveryId)],z.boolean());},
  async finishAdminDispatch(workerId,deliveryId,result){
   // A false result is a fenced/stale callback. Never replay a provider request.
   await call('select dental.finish_admin_dispatch($1::uuid, $2::uuid, $3::jsonb) as result',[input(z.uuid(),workerId),input(z.uuid(),deliveryId),JSON.stringify(input(sendResultSchema,result))],z.boolean());
  },
 };
}
