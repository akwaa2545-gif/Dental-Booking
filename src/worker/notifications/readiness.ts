import {z} from 'zod';
import {DatabaseError} from '../db';
import {json} from '../http';
import {handleBotInfoRequest} from './bot-info';
import {quotaRead} from './quota';
import type {QuotaObservation} from '../admin-notifications/types';
export type ReadinessOptions={enabled?:boolean;token?:string;expectedBasicId?:string;destination?:string;fetcher?:typeof fetch};
export type ReadinessResult={matched:boolean;quota:QuotaObservation|null};
const units=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const quotaSchema=z.object({type:z.literal('limited'),value:units});
const usageSchema=z.object({totalUsage:units});
/** Fixed read-only LINE checks. Bound upstream reads never expose identifiers,
 * credentials, raw diagnostics or imply that SQL policy/budget is enabled. */
export async function readNotificationReadiness(options:{token:string;expectedBasicId:string;destination:string;fetcher?:typeof fetch}):Promise<ReadinessResult>{
 if(typeof options.token!=='string'||!options.token.trim()||!/^@[A-Za-z0-9._-]{1,100}$/.test(options.expectedBasicId)||!/^U[0-9a-f]{32}$/.test(options.destination))throw new DatabaseError('UNAVAILABLE');
 try{
  const response=await handleBotInfoRequest(new Request('https://local.invalid/api/admin/line/bot-info'),{enabled:true,token:options.token,expectedBasicId:options.expectedBasicId,fetcher:options.fetcher});
  if(!response||response.status!==200)throw new DatabaseError('UNAVAILABLE');
  const identity=await response.json() as {botUserId:string};
  if(identity.botUserId!==options.destination)return{matched:false,quota:null};
  const quota=quotaSchema.parse(await quotaRead('quota',options.token,options.fetcher??fetch));
  const usage=usageSchema.parse(await quotaRead('quota/consumption',options.token,options.fetcher??fetch));
  return{matched:true,quota:{...quota,totalUsage:usage.totalUsage,observedAt:new Date().toISOString()}};
 }catch{throw new DatabaseError('UNAVAILABLE');}
}
/** Auth and live admin grant are enforced by makeApp before reaching this route. */
export async function handleNotificationReadinessRequest(request:Request,options:ReadinessOptions={}):Promise<Response|null>{
 const url=new URL(request.url);if(url.pathname!=='/api/admin/line/notification-readiness')return null;
 if(request.method!=='GET')return new Response(null,{status:405,headers:{Allow:'GET','Cache-Control':'no-store'}});
 if(url.search)throw new DatabaseError('VALIDATION');
 if(options.enabled!==true||!options.token||!options.expectedBasicId||!options.destination)throw new DatabaseError('UNAVAILABLE');
 return json(await readNotificationReadiness({token:options.token,expectedBasicId:options.expectedBasicId,destination:options.destination,fetcher:options.fetcher}));
}
