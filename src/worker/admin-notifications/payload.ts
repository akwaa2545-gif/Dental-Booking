import {cardNameSchema,cardPhoneSchema,identityCard} from '../notifications/card-layout';
import {isISODate} from '../../shared/calendar';
import type {AdminEnvelope} from './types';
/** Exact approved destination; changing deployment origins requires review. */
export const ADMIN_MANAGE_ORIGIN='https://tooth-talk-staging.tooth-talk-staging-f7ff4a96.workers.dev';
/** Immutable V1 protocol. Never add patient fields or a bearer link here. */
export function adminBookingPayloadV1(input:Extract<AdminEnvelope,{payloadVersion:1}>){
 if(input.payloadVersion!==1||!isISODate(input.date)||typeof input.reference!=='string'||!/^[-A-Za-z0-9]{1,80}$/.test(input.reference))throw new Error('Invalid admin notification envelope');
 if(input.manageUrl!==`${ADMIN_MANAGE_ORIGIN}/admin`)throw new Error('Invalid admin notification URL');
 return{messages:[{type:'flex',altText:'มีคำขอนัดหมายใหม่',contents:{type:'bubble',body:{type:'box',layout:'vertical',contents:[
  {type:'text',text:'มีคำขอนัดหมายใหม่',weight:'bold',wrap:true},
  {type:'text',text:`หมายเลข ${input.reference}`,wrap:true},
  {type:'text',text:`วันที่ขอนัด ${input.date}`,wrap:true},
  {type:'text',text:'ตรวจสอบสถานะล่าสุดในหน้าแอดมิน',wrap:true},
 ]},footer:{type:'box',layout:'vertical',contents:[{type:'button',action:{type:'uri',label:'เปิดหน้าแอดมิน',uri:input.manageUrl}}]}}}]};
}

/** V2 identity card; V1 keeps its original serialized output. */
export function adminBookingPayload(input:AdminEnvelope){
 if(input.payloadVersion===1)return adminBookingPayloadV1(input);
 if(input.payloadVersion!==2)throw Error('Invalid admin notification version');
 adminBookingPayloadV1({...input,payloadVersion:1});
 const fullName=cardNameSchema.parse(input.fullName),phone=cardPhoneSchema.parse(input.phone);
 return{messages:[{type:'flex',altText:'มีคำขอนัดหมายใหม่',contents:identityCard({title:'มีคำขอนัดหมายใหม่',date:input.date,fullName,phone,patient:false,manageUrl:input.manageUrl})}]};
}
