import {z} from 'zod';
import {DatabaseError} from '../db';
import {notificationClock} from '../notifications/deadline';
import type {NotificationTransport,SendClock,SendResult,SendWindow} from '../notifications/types';
import {adminDeliverySchema,adminPreparationSchema,adminQuotaSchema} from './db';
import {adminAuthorizationWindow} from './deadline';
import {adminBookingPayload,ADMIN_MANAGE_ORIGIN} from './payload';
import type {AdminEnvelope,AdminNotificationDatabase,QuotaObservation} from './types';
export type AdminDispatchDependencies={db:AdminNotificationDatabase;transport:NotificationTransport;manageOrigin:string;expectedProvider:string;quotaReader:()=>Promise<QuotaObservation|null>;workerId:string;clock?:SendClock};
export type AdminDispatchCounts={accepted:number;suppressed:number;failed:number;paused:number};
/** Exactly one claim per tick. SQL owns FIFO, leases, attempt fencing and backoff. */
export async function dispatchAdminDue(deps:AdminDispatchDependencies):Promise<AdminDispatchCounts>{
 const counts={accepted:0,suppressed:0,failed:0,paused:0};
 if(!z.uuid().safeParse(deps.workerId).success||deps.manageOrigin!==ADMIN_MANAGE_ORIGIN||!/^line:[A-Za-z0-9_-]{1,100}$/.test(deps.expectedProvider))throw new DatabaseError('UNAVAILABLE');
 const claimed=await deps.db.claimAdminDelivery(deps.workerId);
 if(claimed===null)return counts;
 const parsed=adminDeliverySchema.safeParse(claimed);if(!parsed.success)throw new DatabaseError('UNAVAILABLE');
 const delivery=parsed.data;
 // An unknown observation is persisted as a 15-minute quota pause by prepare.
 let quota:QuotaObservation|null=null;
 try{const observation=adminQuotaSchema.safeParse(await deps.quotaReader());if(observation.success)quota=observation.data;}catch{/* Unknown quota never authorizes a push. */}
 const clock=deps.clock??notificationClock,started={wall:clock.wall(),monotonic:clock.monotonic()};
 const raw=await deps.db.prepareAdminDispatch(deps.workerId,delivery.id,deps.manageOrigin,quota);
 let prepared:AdminEnvelope,payload:ReturnType<typeof adminBookingPayload>,window:SendWindow;
 try{
  const value=adminPreparationSchema.parse(raw);
  if(value===null){counts.suppressed++;return counts;}
  if('state'in value){counts.paused++;return counts;}
  if(value.provider!==deps.expectedProvider||Object.entries(delivery).some(([key,field])=>value.delivery[key as keyof typeof delivery]!==field))throw Error('Mismatched admin envelope');
  prepared=value as AdminEnvelope;
  payload=adminBookingPayload(prepared);
  window=adminAuthorizationWindow(prepared,started,clock,async()=>{
   // Read first; revalidation must be the last async DB check before fetch. Its
   // latency is charged to clock freshness by the existing LINE transport.
   const databaseNow=await deps.db.readAdminDispatchClock();
   if(await deps.db.revalidateAdminDispatch(deps.workerId,delivery.id)!==true)throw Error('Revoked admin authorization');
   return databaseNow;
  });
 }catch{
  await deps.db.finishAdminDispatch(deps.workerId,delivery.id,{kind:'permanent',category:'invalid_request'});counts.failed++;return counts;
 }
 let result:SendResult;
 try{result=await deps.transport.send(prepared.recipient,payload,delivery.retryKey,window);}catch{result={kind:'retryable',category:'transport'};}
 // Failure deliberately bubbles out. Recovery retains the frozen key and bytes.
 await deps.db.finishAdminDispatch(deps.workerId,delivery.id,result);
 if(result.kind==='accepted')counts.accepted++;else counts.failed++;
 return counts;
}
