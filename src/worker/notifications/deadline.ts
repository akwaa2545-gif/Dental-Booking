import {z} from 'zod';
import type {PreparedDispatch,SendClock,SendWindow} from './types';

export const notificationClock:SendClock={wall:()=>Date.now(),monotonic:()=>performance.now()};
// Preparation time must fall within the RPC interval +/- one second. The final
// provider boundary separately compares a fresh DB clock with the Worker clock.
// Subtract the skew allowance from the wall deadline, plus deduct RPC elapsed
// time conservatively. performance.now is NOT an independent clock in Workers:
// both clocks are I/O-refreshed there; no hard real-time guarantee is claimed.
const CLOCK_SKEW_MS=1000;
const instant=z.iso.datetime({offset:true});
const timing=z.object({authorizationExpiresAt:instant,preparedAt:instant,event:z.object({dueAt:instant,expiresAt:instant})});
export function authorizationWindow(prepared:PreparedDispatch,started:{wall:number;monotonic:number},clock:SendClock,refresh:()=>Promise<number>):SendWindow{
 const value=timing.parse(prepared);
 const databaseNow=Date.parse(value.preparedAt),expiry=Math.min(Date.parse(value.authorizationExpiresAt),Date.parse(value.event.expiresAt));
 const end={wall:clock.wall(),monotonic:clock.monotonic()};
 if(![databaseNow,expiry,started.wall,started.monotonic,end.wall,end.monotonic].every(Number.isFinite)
  ||started.monotonic<0||end.wall<started.wall||end.monotonic<started.monotonic
  ||databaseNow<started.wall-CLOCK_SKEW_MS||databaseNow>end.wall+CLOCK_SKEW_MS
  ||Date.parse(value.event.dueAt)>databaseNow||expiry<=databaseNow)throw new Error('Invalid authorization timing');
 if(typeof refresh!=='function')throw new Error('Missing trusted clock refresh');
 const window={deadline:expiry-CLOCK_SKEW_MS,monotonicDeadline:started.monotonic+(expiry-databaseNow),refresh};
 if(remainingWindow(window,clock)<=0)throw new Error('Expired authorization timing');
 return window;
}
export function remainingWindow(window:SendWindow,clock:SendClock):number{
 const wall=clock.wall(),monotonic=clock.monotonic();
 if(![window.deadline,window.monotonicDeadline,wall,monotonic].every(Number.isFinite)
  ||window.deadline<=0||window.monotonicDeadline<0||monotonic<0)return 0;
 return Math.min(window.deadline-wall,window.monotonicDeadline-monotonic);
}
/** Genuine bounded database I/O, never a timer used as a clock-refresh proxy. */
export async function refreshAuthorizationWindow(window:SendWindow,clock:SendClock):Promise<boolean>{
 const remaining=Math.floor(remainingWindow(window,clock));
 if(remaining<=0||typeof window.refresh!=='function')return false;
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Clock read deadline')),Math.min(5000,remaining));});
  const databaseNow=await Promise.race([window.refresh(),timeout]);
  const wall=clock.wall();
  return Number.isFinite(databaseNow)&&databaseNow>0&&Number.isFinite(wall)
   &&Math.abs(databaseNow-wall)<=CLOCK_SKEW_MS&&databaseNow<window.deadline&&remainingWindow(window,clock)>0;
 }catch{return false;}finally{clearTimeout(timer);}
}
