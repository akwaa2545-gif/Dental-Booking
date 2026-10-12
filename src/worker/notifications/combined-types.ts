import type {UUID} from '../../shared/contracts';
import type {QuotaObservation} from '../admin-notifications/types';
import type {OutboxEvent,PreparedDispatch,SendResult} from './types';
export type {QuotaObservation};
/** Backend-only authority metadata. None of it enters a frozen message payload. */
export type CombinedPatientEnvelope=PreparedDispatch&{provider:`line:${string}`;preparedAt:string;authorizationExpiresAt:string};
export type CombinedLaneCounts={accepted:number;suppressed:number;failed:number;paused:number};
export type CombinedTickResult={patient:CombinedLaneCounts;admin:CombinedLaneCounts};
export interface CombinedPatientDatabase{
 claimPatientEvent(workerId:UUID):Promise<OutboxEvent|null>;
 preparePatientDispatch(workerId:UUID,eventId:UUID,manageOrigin:string,quota:QuotaObservation|null):Promise<CombinedPatientEnvelope|{state:'paused_quota'}|null>;
 readPatientDispatchClock():Promise<number>;
 revalidatePatientDispatch(workerId:UUID,eventId:UUID):Promise<boolean>;
 finishPatientDispatch(workerId:UUID,eventId:UUID,result:SendResult):Promise<void>;
}
