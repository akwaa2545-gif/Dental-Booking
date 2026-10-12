import {dispatchDue,type DispatchDependencies} from './outbox';
/** Runtime composition seam. No cron is registered; explicit dispatch gates apply.
 * Future explicitly authorized cron: every minute (UTC), DB owns Bangkok due time.
 */
export async function runNotificationTick(deps:Omit<DispatchDependencies,'workerId'>&{enabled?:boolean}){
 if(deps.enabled!==true)return{accepted:0,suppressed:0,failed:0};
 return dispatchDue({...deps,workerId:crypto.randomUUID()});
}

import {z} from 'zod';
import {DatabaseError} from '../db';
import {handleBotInfoRequest} from './bot-info';
import {quotaRead} from './quota';
import type {RestrictedNotificationDatabase} from './types';
export type RestrictedTickOptions=Omit<DispatchDependencies,'db'|'workerId'>&{
 db:RestrictedNotificationDatabase;enabled?:boolean;eventId?:string;ownerId?:string;
 token?:string;expectedBasicId?:string;destination?:string;freeMessageLimit?:number;fetcher?:typeof fetch;
};
/** A reusable, explicitly approved single-event lane. No global queue claims.
 * SQL commits its one-attempt budget before returning a prepared envelope.
 * Quota is a fail-closed snapshot, not a billing lock against other senders.
 */
export async function runRestrictedNotificationTick(options:RestrictedTickOptions){
 if(options.enabled!==true)return{accepted:0,suppressed:0,failed:0};
 const identifiers=z.object({eventId:z.uuid(),ownerId:z.uuid()}).safeParse(options);
 if(!identifiers.success||!options.token?.trim()||!/^U[0-9a-f]{32}$/.test(options.destination??'')||!Number.isSafeInteger(options.freeMessageLimit)||options.freeMessageLimit!<=0)throw new DatabaseError('UNAVAILABLE');
 const fetcher=options.fetcher??fetch;
 try{
  const info=await handleBotInfoRequest(new Request(options.manageOrigin+'/api/admin/line/bot-info'),{enabled:true,token:options.token,expectedBasicId:options.expectedBasicId,fetcher});
  if((await info!.json() as {botUserId:string}).botUserId!==options.destination)throw new DatabaseError('UNAVAILABLE');
  const quota=z.object({type:z.literal('limited'),value:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).parse(await quotaRead('quota',options.token,fetcher));
  const usage=z.object({totalUsage:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).parse(await quotaRead('quota/consumption',options.token,fetcher));
  if(usage.totalUsage>=Math.min(quota.value,options.freeMessageLimit!))throw new DatabaseError('UNAVAILABLE');
 }catch{throw new DatabaseError('UNAVAILABLE');}
 const {eventId,ownerId}=identifiers.data;
 // Reuse the normal payload/send/finish pipeline; only selection, durable budget,
 // and terminal uncertainty policy differ from future production retries.
 return dispatchDue({...options,requireAuthorizationWindow:true,refreshClock:()=>options.db.readDispatchClock(),workerId:crypto.randomUUID(),db:{
  async claimEvents(worker){const events=await options.db.claimRestrictedEvent(worker,eventId,ownerId);if(events.length>1||events.some(event=>event.id!==eventId))throw new DatabaseError('UNAVAILABLE');return events;},
  async prepareDispatch(worker,event,origin){const prepared=await options.db.prepareRestrictedDispatch(worker,event,ownerId,origin);if(prepared&&prepared.event.id!==eventId)throw new DatabaseError('UNAVAILABLE');return prepared;},
  finishDispatch(worker,event,result){return options.db.finishDispatch(worker,event,{...result,kind:result.kind==='retryable'?'permanent':result.kind});},
 }});
}
