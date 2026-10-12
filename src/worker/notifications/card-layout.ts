import {z} from 'zod';
import {isISODate} from '../../shared/calendar';
/** Recovered from the verified deployed protocol; new versions only. */
export const cardNameSchema=z.string().min(1).max(120).refine(value=>value.trim().length>0);
export const cardPhoneSchema=z.string().min(7).max(30).regex(/^\+?[0-9().\s-]+$/).refine(value=>/[0-9]/.test(value));
const months=['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
export function cardDate(date:string){
 if(!isISODate(date))throw Error('Invalid notification date');
 const [year,month,day]=date.split('-');return `${Number(day)} ${months[Number(month)-1]} ${year}`;
}
const text=(value:string,size:string,color:string,weight='regular')=>({type:'text',text:value,size,color,weight,wrap:true});
export function identityCard(input:{title:string;date:string;fullName:string;phone?:string;patient:boolean;manageUrl:string}){
 const name=cardNameSchema.parse(input.fullName),phone=input.phone===undefined?undefined:cardPhoneSchema.parse(input.phone);
 return{type:'bubble',size:'mega',header:{type:'box',layout:'vertical',paddingAll:'20px',paddingBottom:'12px',backgroundColor:'#FFFFFF',contents:[text('TOOTHTALK','xs','#087F9D','bold'),text(input.title,'lg','#172C38','bold')]},
  body:{type:'box',layout:'vertical',paddingAll:'20px',paddingTop:'0px',paddingBottom:'0px',spacing:'md',contents:[
   {type:'box',layout:'vertical',paddingAll:'16px',cornerRadius:'12px',backgroundColor:'#EDF7FA',contents:[text(input.patient?'วันนัดหมาย':'วันที่ขอนัด','xs','#536F7C'),text(cardDate(input.date),'xl','#126078','bold'),...input.patient?[text('เวลา 08:30–09:30 น.','sm','#126078')]:[]]},
   {type:'box',layout:'vertical',spacing:'xs',contents:[text('ชื่อ–นามสกุล','xs','#536F7C'),text(name,'md','#172C38','bold'),...phone===undefined?[]:[text('เบอร์โทร','xs','#536F7C'),text(phone,'sm','#172C38')]]},
   {type:'separator',color:'#E8EEF1'},text(input.patient?'ตรวจสอบสถานะล่าสุดบนเว็บไซต์':'ตรวจสอบสถานะล่าสุดในหน้าแอดมิน','xs','#6A7B84'),
  ]},footer:{type:'box',layout:'vertical',paddingAll:'20px',contents:[{type:'button',style:'primary',color:'#087F9D',action:{type:'uri',label:input.patient?'ดูการนัดหมาย':'เปิดหน้าแอดมิน',uri:input.manageUrl}}]}};
}
