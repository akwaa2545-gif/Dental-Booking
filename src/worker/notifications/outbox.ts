import {notificationPayload} from './payload';
import {authorizationWindow,notificationClock} from './deadline';
import type {NotificationDatabase,NotificationTransport,SendClock,SendResult,SendWindow} from './types';
export type DispatchDependencies={db:Pick<NotificationDatabase,'claimEvents'|'prepareDispatch'|'finishDispatch'>;transport:NotificationTransport;workerId:string;manageOrigin:string;requireAuthorizationWindow?:boolean;clock?:SendClock;refreshClock?:()=>Promise<number>};
/** Claim only one event at a time: a 60s lease must not expire in a batch queue. */
export async function dispatchDue(deps:DispatchDependencies):Promise<{accepted:number;suppressed:number;failed:number}>{
 const counts={accepted:0,suppressed:0,failed:0};
 const events=await deps.db.claimEvents(deps.workerId,1);
 for(const event of events){
  const clock=deps.clock??notificationClock;
  const started={wall:clock.wall(),monotonic:clock.monotonic()};
  const prepared=await deps.db.prepareDispatch(deps.workerId,event.id,deps.manageOrigin);
  if(!prepared){counts.suppressed++;continue;}
  let result:SendResult;
  let payload:ReturnType<typeof notificationPayload>;
  let window:SendWindow|undefined;
  try{
   payload=notificationPayload(prepared);
   if(deps.requireAuthorizationWindow){
    if(!deps.refreshClock)throw new Error('Missing trusted database clock');
    window=authorizationWindow(prepared,started,clock,deps.refreshClock);
   }
  }
  catch{await deps.db.finishDispatch(deps.workerId,event.id,{kind:'permanent',category:'invalid_request'});counts.failed++;continue;}
  try{result=window?await deps.transport.send(prepared.recipient,payload,prepared.event.retryKey,window):await deps.transport.send(prepared.recipient,payload,prepared.event.retryKey);}
  catch{result={kind:'retryable',category:'transport'};}
  // Failure here deliberately bubbles out. The same frozen envelope and retry key
  // are recovered after lease expiry, including uncertain provider acceptance.
  await deps.db.finishDispatch(deps.workerId,event.id,result);
  if(result.kind==='accepted')counts.accepted++;else counts.failed++;
 }
 return counts;
}
