import {z} from 'zod';
import {handleBotInfoRequest} from '../notifications/bot-info';
import {quotaRead} from '../notifications/quota';
import type {QuotaObservation} from './types';
const units=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const limitSchema=z.object({type:z.literal('limited'),value:units});
const usageSchema=z.object({totalUsage:units});
/** Observation only, never a billing authorization: a verified finite DB epoch is
 * also mandatory. The API may include paid capacity; SQL caps it to verified free units. */
export async function readAdminQuota(options:{token:string;expectedBasicId:string;destination:string;fetcher?:typeof fetch}):Promise<QuotaObservation|null>{
 if(typeof options.token!=='string'||!options.token.trim()||typeof options.destination!=='string'||!/^U[0-9a-f]{32}$/.test(options.destination))return null;
 try{
  const info=await handleBotInfoRequest(new Request('https://local.invalid/api/admin/line/bot-info'),{enabled:true,token:options.token,expectedBasicId:options.expectedBasicId,fetcher:options.fetcher});
  if(!info||info.status!==200)return null;
  const identity=await info.json() as {botUserId?:unknown};
  if(identity.botUserId!==options.destination)return null;
  const quota=limitSchema.parse(await quotaRead('quota',options.token,options.fetcher??fetch));
  const usage=usageSchema.parse(await quotaRead('quota/consumption',options.token,options.fetcher??fetch));
  return{...quota,totalUsage:usage.totalUsage,observedAt:new Date().toISOString()};
 }catch{return null;}
}
