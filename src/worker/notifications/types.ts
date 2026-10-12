import type {ISODate,Status,UUID} from '../../shared/contracts';
export type NotificationType='approval'|'rejection'|'reminder'|'cancellation';
export type OutboxEvent={id:UUID;appointmentId:UUID;appointmentVersion:number;type:NotificationType;retryKey:UUID;dueAt:string;expiresAt:string};
export type SendCategory='timeout'|'transport'|'server_error'|'quota'|'rate_limited'|'recipient_unavailable'|'invalid_request'|'unauthorized'|'forbidden'|'unknown';
export type SendResult={kind:'accepted'|'retryable'|'permanent';requestId?:string;category?:SendCategory};
type PreparedDispatchBase={event:OutboxEvent;recipient:string;date:ISODate;reference:string;status:Status;manageUrl:string;authorizationExpiresAt?:string;preparedAt?:string};
export type PreparedDispatch=PreparedDispatchBase&({payloadVersion:1|2}|{payloadVersion:3;fullName:string});
export type SendClock={wall:()=>number;monotonic:()=>number};
export type SendWindow={deadline:number;monotonicDeadline:number;refresh:()=>Promise<number>};
export interface NotificationDatabase {
 claimEvents(workerId:UUID,limit:number):Promise<OutboxEvent[]>;
 prepareDispatch(workerId:UUID,eventId:UUID,manageOrigin:string):Promise<PreparedDispatch|null>;
 finishDispatch(workerId:UUID,eventId:UUID,result:SendResult):Promise<void>;
 recordReachability(provider:string,subject:string,eventId:string,eventAt:string,reachable:boolean):Promise<void>;
}
export interface RestrictedNotificationDatabase {
 readDispatchClock():Promise<number>;
 claimRestrictedEvent(workerId:UUID,eventId:UUID,ownerId:UUID):Promise<OutboxEvent[]>;
 prepareRestrictedDispatch(workerId:UUID,eventId:UUID,ownerId:UUID,manageOrigin:string):Promise<PreparedDispatch|null>;
 finishDispatch(workerId:UUID,eventId:UUID,result:SendResult):Promise<void>;
}
export interface NotificationTransport {send(recipient:string,payload:unknown,retryKey:UUID,window?:SendWindow):Promise<SendResult>;}
