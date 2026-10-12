import {ApiRequestError, SessionRefreshError, type ApiClient} from '../api';

export type NotificationReadinessResult =
 | {matched:false;quota:null}
 | {matched:true;quota:{type:'limited';value:number;totalUsage:number;observedAt:string};fresh:boolean};
export class NotificationReadinessError extends Error {}
function record(value:unknown):value is Record<string,unknown>{return typeof value==='object'&&!!value&&!Array.isArray(value);}
function units(value:unknown):value is number{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;}
function timestamp(value:unknown):string|undefined{
 if(typeof value!=='string'||value.length>29||!/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)||value.trim()!==value)return;
 const year=Number(value.slice(0,4)),month=Number(value.slice(5,7)),day=Number(value.slice(8,10));
 const days=[31,year%4===0&&(year%100!==0||year%400===0)?29:28,31,30,31,30,31,31,30,31,30,31];
 const time=Date.parse(value);
 return day<=days[month-1]&&Number.isFinite(time)?new Date(time).toISOString():undefined;
}
/** Read-only endpoint and allowlisted primitives only; a quota observation does
 * not imply that notification policy is enabled or that a plan is free. */
export async function readNotificationReadiness(api:ApiClient,now:()=>Date):Promise<NotificationReadinessResult>{
 const value=await api.request<unknown>('/api/admin/line/notification-readiness',{method:'GET'});
 if(!record(value)||typeof value.matched!=='boolean')throw new NotificationReadinessError();
 if(!value.matched){if(value.quota!==null)throw new NotificationReadinessError();return{matched:false,quota:null};}
 const quota=value.quota;
 if(!record(quota)||quota.type!=='limited'||!units(quota.value)||!units(quota.totalUsage))throw new NotificationReadinessError();
 const observedAt=timestamp(quota.observedAt);if(!observedAt)throw new NotificationReadinessError();
 const age=now().getTime()-Date.parse(observedAt);
 return{matched:true,quota:{type:'limited',value:quota.value,totalUsage:quota.totalUsage,observedAt},fresh:Number.isFinite(age)&&age>=0&&age<=60_000};
}
export function notificationReadinessError(error:unknown):string{
 if(error instanceof ApiRequestError&&error.status===401)return 'เซสชันสิ้นสุด กรุณาเข้าสู่ระบบอีกครั้ง';
 if(error instanceof ApiRequestError&&error.status===403)return 'ไม่มีสิทธิ์ตรวจระบบนี้ กรุณาตรวจสอบบัญชีและสิทธิ์ผู้ดูแล';
 if(error instanceof SessionRefreshError)return 'ยังตรวจสอบเซสชันไม่ได้ กรุณาเข้าสู่ระบบอีกครั้ง';
 if(error instanceof ApiRequestError&&error.status===429)return 'ตรวจระบบบ่อยเกินไป โปรดลองใหม่ภายหลัง';
 if(error instanceof NotificationReadinessError)return 'ยังยืนยันข้อมูลตรวจระบบไม่ได้ โปรดลองตรวจใหม่ภายหลัง';
 return 'ยังเชื่อมต่อเพื่อตรวจระบบไม่ได้ โปรดลองใหม่ภายหลัง';
}
