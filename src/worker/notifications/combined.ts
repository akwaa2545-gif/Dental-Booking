import {z} from 'zod';
import {DatabaseError} from '../db';
import {adminQuotaSchema} from '../admin-notifications/db';
import {combinedEventSchema,combinedOriginSchema,combinedPatientPreparationSchema} from './combined-db';
import type {CombinedPatientDatabase,CombinedPatientEnvelope,CombinedTickResult,QuotaObservation} from './combined-types';
import {authorizationWindow,notificationClock} from './deadline';
import {notificationPayload} from './payload';
import type {NotificationTransport,SendClock,SendResult,SendWindow} from './types';
export type CombinedPatientDependencies={db:CombinedPatientDatabase;transport:NotificationTransport;workerId:string;manageOrigin:string;expectedProvider:string;quotaReader:()=>Promise<QuotaObservation|null>;clock?:SendClock};
/** One committed claim, one atomic budgeted preparation, one final authority check. */
export async function dispatchCombinedPatient(deps:CombinedPatientDependencies):Promise<CombinedTickResult['patient']>{
 const counts={accepted:0,suppressed:0,failed:0,paused:0};
 if(!z.uuid().safeParse(deps.workerId).success||!combinedOriginSchema.safeParse(deps.manageOrigin).success||!/^line:[A-Za-z0-9_-]{1,100}$/.test(deps.expectedProvider))throw new DatabaseError('UNAVAILABLE');
 const claimed=await deps.db.claimPatientEvent(deps.workerId);if(claimed===null)return counts;
 const parsed=combinedEventSchema.safeParse(claimed);if(!parsed.success)throw new DatabaseError('UNAVAILABLE');const event=parsed.data;
 let quota:QuotaObservation|null=null;try{const observation=adminQuotaSchema.safeParse(await deps.quotaReader());if(observation.success)quota=observation.data;}catch{/* Unknown quota is durably paused by SQL. */}
 const clock=deps.clock??notificationClock,started={wall:clock.wall(),monotonic:clock.monotonic()};
 const raw=await deps.db.preparePatientDispatch(deps.workerId,event.id,deps.manageOrigin,quota);
 let prepared:CombinedPatientEnvelope,payload:ReturnType<typeof notificationPayload>,window:SendWindow;
 try{
  const value=combinedPatientPreparationSchema.parse(raw);if(value===null){counts.suppressed++;return counts;}if('state'in value){counts.paused++;return counts;}
  if(value.provider!==deps.expectedProvider||value.manageUrl!==deps.manageOrigin+'/appointments'||Object.entries(event).some(([key,field])=>value.event[key as keyof typeof event]!==field))throw Error('Mismatched patient envelope');
  prepared=value as CombinedPatientEnvelope;payload=notificationPayload(prepared);
  window=authorizationWindow(prepared,started,clock,async()=>{const now=await deps.db.readPatientDispatchClock();if(await deps.db.revalidatePatientDispatch(deps.workerId,event.id)!==true)throw Error('Revoked patient authorization');return now;});
 }catch{await deps.db.finishPatientDispatch(deps.workerId,event.id,{kind:'permanent',category:'invalid_request'});counts.failed++;return counts;}
 let result:SendResult;try{result=await deps.transport.send(prepared.recipient,payload,event.retryKey,window);}catch{result={kind:'retryable',category:'transport'};}
 // A lost/uncertain finish bubbles out. Recovery keeps its frozen key and bytes.
 await deps.db.finishPatientDispatch(deps.workerId,event.id,result);if(result.kind==='accepted')counts.accepted++;else counts.failed++;return counts;
}

/** Both bounded lanes start once. An uncertain lane outcome never prevents the
 * other lane's turn or becomes a provider retry in this composition layer. */
export async function runCombinedNotificationTick(options:{enabled?:boolean;patientTick:()=>Promise<CombinedTickResult['patient']>;adminTick:()=>Promise<CombinedTickResult['admin']>}):Promise<CombinedTickResult>{
 const empty=()=>({accepted:0,suppressed:0,failed:0,paused:0});
 if(options.enabled!==true)return{patient:empty(),admin:empty()};
 async function turn(tick:()=>Promise<CombinedTickResult['patient']>){
  try{return await tick();}catch{return{...empty(),failed:1};}
 }
 const [patient,admin]=await Promise.all([turn(options.patientTick),turn(options.adminTick)]);
 return{patient,admin};
}
