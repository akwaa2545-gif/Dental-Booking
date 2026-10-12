import {notificationClock,refreshAuthorizationWindow,remainingWindow} from './deadline';
import type {NotificationTransport,SendClock,SendResult} from './types';
type Options={enabled?:boolean;token?:string;fetcher?:typeof fetch;clock?:SendClock};
const safeId=(value:string|null)=>value&&/^[A-Za-z0-9_-]{1,128}$/.test(value)?value:undefined;
/** No environment implicit activation: callers must explicitly enable sending. */
export function createLineTransport(options:Options={}):NotificationTransport{
 return{async send(recipient,payload,retryKey,window):Promise<SendResult>{
  if(options.enabled!==true||!options.token)return{kind:'permanent',category:'forbidden'};
  if(!/^U[0-9a-f]{32}$/.test(recipient)||! /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(retryKey))return{kind:'permanent',category:'invalid_request'};
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   // Serialize first: even synchronous payload work must not move a restricted
   // request past its authorization cutoff. Deployed Workers clocks only
   // advance after I/O, so read the trusted DB clock AFTER serialization.
   // No await separates the final check from fetch initiation. Abort limits local waiting;
   // it cannot recall a request already accepted by LINE or promise delivery time.
   const body=JSON.stringify({...payload as object,to:recipient});
   const clock=options.clock??notificationClock;
   if(window){
    if(!await refreshAuthorizationWindow(window,clock))return{kind:'permanent',category:'forbidden'};
   }
   const remaining=window?Math.floor(remainingWindow(window,clock)):15_000;
   if(remaining<=0)return{kind:'permanent',category:'forbidden'};
   const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Provider deadline'));},Math.min(15_000,remaining));});
   const operation=async():Promise<SendResult>=>{
   const response=await(options.fetcher??fetch)('https://api.line.me/v2/bot/message/push',{method:'POST',redirect:'manual',headers:{'content-type':'application/json','authorization':`Bearer ${options.token}`,'x-line-retry-key':retryKey},body,signal:controller.signal});
   // Workerd supports manual/follow, not error. Never follow a provider redirect.
   if(response.status>=300&&response.status<400){void response.body?.cancel().catch(()=>{});return{kind:'permanent',category:'invalid_request'};}
   const requestId=safeId(response.headers.get(response.status===409?'x-line-accepted-request-id':'x-line-request-id'));
   // Do not parse or persist provider bodies, which can echo input or user data.
   void response.body?.cancel().catch(()=>{});
   const meta=requestId?{requestId}:{};
   if(response.status>=200&&response.status<300||(response.status===409&&requestId))return{kind:'accepted',...meta};
   if(response.status>=500)return{kind:'retryable',category:'server_error',...meta};
   // LINE 429 conflates rate and message allowance: conservative terminal error;
   // operator inspects official quota/rate guidance rather than automated replay.
   return{kind:'permanent',category:response.status===429?'rate_limited':response.status===401?'unauthorized':response.status===403?'forbidden':'invalid_request',...meta};
   };return await Promise.race([operation(),deadline]);
  }catch{return{kind:'retryable',category:controller.signal.aborted?'timeout':'transport'};}
  finally{clearTimeout(timer);}
 }};
}
