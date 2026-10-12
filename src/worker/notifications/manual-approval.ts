import {z} from 'zod';
import {quotaRead} from './quota';
import {DatabaseError,type QueryPort} from '../db';
import {json,readJson} from '../http';
import {handleBotInfoRequest} from './bot-info';
import {createLineTransport} from './line';
import {notificationPayloadV1} from './payload';
import type {NotificationDatabase,OutboxEvent,PreparedDispatch} from './types';
export const APPROVED_EVENT='f0000000-0000-4000-8000-000000000002';
// Permanent operation identifier. NEVER regenerate for clicks, retries or deploys.
// Existing SQL excludes/denies a second attempt for this event + worker pair.
export const MANUAL_WORKER=APPROVED_EVENT;
const actorId='f0000000-0000-4000-8000-000000000001';
const bookingId='f0000000-0000-4000-8000-000000000003';
const manageOrigin='https://tooth-talk-staging.tooth-talk-staging-f7ff4a96.workers.dev';
export type ManualApprovalOptions={enabled?:boolean;token?:string;expectedBasicId?:string;destination?:string;manageOrigin:string;fetcher?:typeof fetch;port:QueryPort;db:Pick<NotificationDatabase,'claimEvents'|'prepareDispatch'|'finishDispatch'>};
function approved(event:OutboxEvent){return event.id===APPROVED_EVENT&&event.appointmentId===bookingId&&event.appointmentVersion===2&&event.type==='approval';}
function exactCard(value:PreparedDispatch){return approved(value.event)&&value.payloadVersion===1&&value.date==='2026-10-14'&&value.reference==='D-00000000000000000000000000000003'&&value.status==='approved'&&value.manageUrl===manageOrigin+'/appointments';}
/** One approved normal card. No cron, generic tick, arbitrary event or new SQL capability. */
export async function handleManualApprovalRequest(request:Request,actor:string,options?:ManualApprovalOptions):Promise<Response|null>{
 const url=new URL(request.url);if(url.pathname!=='/api/admin/line/test-approval')return null;
 if(request.method!=='POST')return new Response(null,{status:405,headers:{Allow:'POST','Cache-Control':'no-store'}});
 if(actor!==actorId)throw new DatabaseError('FORBIDDEN');
 if(!options?.enabled||!options.token?.trim()||options.manageOrigin!==manageOrigin||!/^U[0-9a-f]{32}$/.test(options.destination??''))throw new DatabaseError('UNAVAILABLE');
 if(url.search||!z.strictObject({}).safeParse(await readJson(request)).success)throw new DatabaseError('VALIDATION');
 const fetcher=options.fetcher??fetch;
 const info=await handleBotInfoRequest(new Request(url.origin+'/api/admin/line/bot-info'),{enabled:true,token:options.token,expectedBasicId:options.expectedBasicId,fetcher});
 if((await info!.json() as {botUserId:string}).botUserId!==options.destination)throw new DatabaseError('UNAVAILABLE');
 const quota=z.object({type:z.literal('limited'),value:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).parse(await quotaRead('quota',options.token,fetcher));
 const usage=z.object({totalUsage:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)}).parse(await quotaRead('quota/consumption',options.token,fetcher));
 if(usage.totalUsage>=quota.value)throw new DatabaseError('UNAVAILABLE');
 let transactionOpen=false;
 try{
  await options.port.query('BEGIN ISOLATION LEVEL READ COMMITTED',[]);transactionOpen=true;
  const events=await options.db.claimEvents(MANUAL_WORKER,1);
  if(events.length!==1||!approved(events[0])){await options.port.query('ROLLBACK',[]);transactionOpen=false;return json({status:'not_sent',attempted:false});}
  await options.port.query('COMMIT',[]);transactionOpen=false;
 }finally{if(transactionOpen){try{await options.port.query('ROLLBACK',[]);}catch{/* Never prepare/send after an uncertain claim transaction. */}}}
 // prepare_dispatch commits its durable same-worker attempt record before HTTP.
 // If its result is lost, later same-worker calls are denied rather than resent.
 const prepared=await options.db.prepareDispatch(MANUAL_WORKER,APPROVED_EVENT,manageOrigin);
 if(!prepared)return json({status:'not_sent',attempted:false});
 if(!exactCard(prepared)){await options.db.finishDispatch(MANUAL_WORKER,APPROVED_EVENT,{kind:'permanent',category:'invalid_request'});return json({status:'failed',attempted:false});}
 const result=await createLineTransport({enabled:true,token:options.token,fetcher}).send(prepared.recipient,notificationPayloadV1(prepared),prepared.event.retryKey);
 // This approved manual test must not schedule retries. Unknown provider outcome
 // is reported honestly while persisted terminal failure prevents normal retries.
 const status=result.kind==='accepted'?'accepted':result.kind==='retryable'?'unknown':'failed';
 await options.db.finishDispatch(MANUAL_WORKER,APPROVED_EVENT,{...result,kind:result.kind==='retryable'?'permanent':result.kind});
 return json({status,attempted:true});
}
