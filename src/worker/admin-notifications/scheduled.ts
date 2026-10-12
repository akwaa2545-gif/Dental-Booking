import {dispatchAdminDue,type AdminDispatchDependencies,type AdminDispatchCounts} from './outbox';
/** Composition only: no cron registration and no implicit activation. */
export async function runAdminNotificationTick(deps:AdminDispatchDependencies&{enabled?:boolean}):Promise<AdminDispatchCounts>{
 if(deps.enabled!==true)return{accepted:0,suppressed:0,failed:0,paused:0};
 return dispatchAdminDue(deps);
}
