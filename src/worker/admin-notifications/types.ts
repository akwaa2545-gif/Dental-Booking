import type {UUID,ISODate,AdminNotificationSummary} from '../../shared/contracts';
import type {SendResult} from '../notifications/types';
export type AdminState=AdminNotificationSummary['state'];
export type AdminDelivery={id:UUID;eventId:UUID;appointmentId:UUID;grantId:UUID;retryKey:UUID;createdAt:string;dueAt:string;expiresAt:string};
export type QuotaObservation={type:'limited';value:number;totalUsage:number;observedAt:string};
type AdminEnvelopeBase={delivery:AdminDelivery;provider:`line:${string}`;recipient:string;reference:string;date:ISODate;manageUrl:string;preparedAt:string;authorizationValidUntil:string};
export type AdminEnvelope=AdminEnvelopeBase&({payloadVersion:1}|{payloadVersion:2;fullName:string;phone:string});
export interface AdminNotificationDatabase{
 claimAdminDelivery(workerId:UUID):Promise<AdminDelivery|null>;
 prepareAdminDispatch(workerId:UUID,deliveryId:UUID,manageOrigin:string,quota:QuotaObservation|null):Promise<AdminEnvelope|{state:'paused_quota'}|null>;
 readAdminDispatchClock():Promise<number>;
 revalidateAdminDispatch(workerId:UUID,deliveryId:UUID):Promise<boolean>;
 finishAdminDispatch(workerId:UUID,deliveryId:UUID,result:SendResult):Promise<void>;
}
