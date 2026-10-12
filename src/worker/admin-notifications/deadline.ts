import {remainingWindow} from '../notifications/deadline';
import type {SendClock,SendWindow} from '../notifications/types';
import type {AdminEnvelope} from './types';
const CLOCK_SKEW_MS=1000;
/** Separate admin authorization contract; existing patient timing stays unchanged. */
export function adminAuthorizationWindow(prepared:AdminEnvelope,started:{wall:number;monotonic:number},clock:SendClock,refresh:()=>Promise<number>):SendWindow{
 const databaseNow=Date.parse(prepared.preparedAt),due=Date.parse(prepared.delivery.dueAt);
 const expiry=Math.min(Date.parse(prepared.authorizationValidUntil),Date.parse(prepared.delivery.expiresAt));
 const end={wall:clock.wall(),monotonic:clock.monotonic()};
 if(![databaseNow,due,expiry,started.wall,started.monotonic,end.wall,end.monotonic].every(Number.isFinite)
  ||started.monotonic<0||end.wall<started.wall||end.monotonic<started.monotonic
  ||databaseNow<started.wall-CLOCK_SKEW_MS||databaseNow>end.wall+CLOCK_SKEW_MS
  ||due>databaseNow||expiry<=databaseNow||typeof refresh!=='function')throw Error('Invalid admin authorization timing');
 const window={deadline:expiry-CLOCK_SKEW_MS,monotonicDeadline:started.monotonic+(expiry-databaseNow),refresh};
 if(remainingWindow(window,clock)<=0)throw Error('Expired admin authorization timing');
 return window;
}
