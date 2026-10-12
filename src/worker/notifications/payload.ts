import {cardNameSchema,identityCard} from './card-layout';
import {isISODate} from '../../shared/calendar';
import type {PreparedDispatch} from './types';
/** Frozen protocol V1: never change its output. Introduce a new version for new copy.
 * Persisted V1 envelopes must reproduce byte-identical messages after redeploys.
 * No patient, service, reason, contact, account ID, or bearer access link is rendered.
 */
export function notificationPayloadV1(input:Omit<PreparedDispatch,'payloadVersion'>&{payloadVersion:number;[key:string]:unknown}){
 if(input.payloadVersion!==1||!isISODate(input.date)||!/^[-A-Za-z0-9]{1,80}$/.test(input.reference))throw new Error('Invalid notification envelope');
 const url=new URL(input.manageUrl);
 if(url.protocol!=='https:'||url.username||url.password||url.pathname!=='/appointments'||url.search||url.hash)throw new Error('Invalid notification manage URL');
 const status=input.status==='approved'?'อนุมัติแล้ว':input.status==='rejected'?'ไม่อนุมัติ':null;
 if(!status||!['approval','rejection','reminder'].includes(input.event.type)||(input.event.type==='rejection')!==(input.status==='rejected'))throw new Error('Invalid notification status');
 const prefix=input.event.type==='reminder'?'แจ้งเตือนการนัดหมาย':'การนัดหมาย';
 return{messages:[{type:'flex',altText:'การนัดหมายของคุณมีข้อมูลอัปเดต',contents:{
  type:'bubble',body:{type:'box',layout:'vertical',contents:[
   {type:'text',text:prefix,weight:'bold',wrap:true},
   {type:'text',text:`หมายเลข ${input.reference}`,wrap:true},
   {type:'text',text:`วันที่ ${input.date} เวลา 08:30–09:30`,wrap:true},
   {type:'text',text:`สถานะ: ${status}`,wrap:true},
   {type:'text',text:'ตรวจสอบสถานะล่าสุดบนเว็บไซต์',wrap:true},
  ]},footer:{type:'box',layout:'vertical',contents:[{type:'button',action:{type:'uri',label:'ดูการนัดหมาย',uri:input.manageUrl}}]},
 }}]};
}

/** V2 is reserved for clinic cancellations. Existing V1 bytes stay unchanged. */
export function notificationPayloadV2(input:Omit<PreparedDispatch,'payloadVersion'>&{payloadVersion:number;[key:string]:unknown}){
 if(input.payloadVersion!==2||input.event.type!=='cancellation'||input.status!=='cancelled')throw new Error('Invalid cancellation envelope');
 // Reuse V1 validation and layout without changing its persisted protocol.
 const payload=notificationPayloadV1({...input,payloadVersion:1,status:'rejected',event:{...input.event,type:'rejection'}});
 payload.messages[0].contents.body.contents[3].text='สถานะ: คลินิกยกเลิกนัดหมาย';
 payload.messages[0].contents.body.contents[4].text='ตรวจสอบสถานะล่าสุดและเลือกวันนัดใหม่บนเว็บไซต์';
 return payload;
}
/** V3 is only for approved appointments and the booking-snapshot name. */
export function notificationPayloadV3(input:Omit<PreparedDispatch,'payloadVersion'>&{payloadVersion:number;[key:string]:unknown}){
 if(input.payloadVersion!==3||input.event.type!=='approval'||input.status!=='approved')throw Error('Invalid approval envelope');
 notificationPayloadV1({...input,payloadVersion:1});
 const fullName=cardNameSchema.parse(input.fullName);
 return{messages:[{type:'flex',altText:'การนัดหมายของคุณมีข้อมูลอัปเดต',contents:identityCard({title:'นัดหมายได้รับอนุมัติแล้ว',date:input.date,fullName,patient:true,manageUrl:input.manageUrl})}]};
}
export function notificationPayload(input:PreparedDispatch){
 return input.payloadVersion===3?notificationPayloadV3(input):input.payloadVersion===2?notificationPayloadV2(input):notificationPayloadV1(input);
}
