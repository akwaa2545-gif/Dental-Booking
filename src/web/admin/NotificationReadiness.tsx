import {useEffect,useRef,useState} from 'react';
import type {ApiClient} from '../api';
import {notificationReadinessError,readNotificationReadiness,type NotificationReadinessResult} from './notification-readiness';

type ReadinessState={api:ApiClient;busy:boolean;result?:NotificationReadinessResult;error?:string};
export function NotificationReadiness({api,now}:{api:ApiClient;now:()=>Date}){
 const [state,setState]=useState<ReadinessState>({api,busy:false});
 const generation=useRef(0);
 const pending=useRef<{generation:number}|undefined>(undefined);
 useEffect(()=>()=>{generation.current++;pending.current=undefined;},[api]);
 if(state.api!==api)setState({api,busy:false});
 async function check(){
  if(pending.current||api.dataMode!=='server')return;
  const current={generation:++generation.current};pending.current=current;setState({api,busy:true});
  const active=()=>pending.current===current&&generation.current===current.generation;
  try{const result=await readNotificationReadiness(api,now);if(active())setState({api,busy:false,result});}
  catch(error){if(active())setState({api,busy:false,error:notificationReadinessError(error)});}
  finally{if(active())pending.current=undefined;}
 }
 if(api.dataMode!=='server')return null;
 const view=state.api===api?state:{api,busy:false};const result=view.result;
 return <section className="page-card" aria-label="ตรวจการเชื่อมต่อและโควตา LINE" aria-busy={view.busy}>
  <h2>ตรวจการเชื่อมต่อและโควตา LINE</h2>
  <p className="small-copy">ตรวจเฉพาะการเชื่อมต่อและโควตา ไม่ส่งข้อความ ไม่เปิดการแจ้งเตือน และไม่ยืนยันว่าเป็นแพ็กเกจฟรี</p>
  <button className="button secondary" disabled={view.busy} onClick={()=>void check()}>{view.busy?'กำลังตรวจระบบ…':'ตรวจระบบแจ้งเตือน'}</button>
  <div role="status" aria-live="polite">{result&&(result.matched?<>
   <p>บัญชี LINE ตรงกับที่กำหนด</p>
   <p>{result.fresh?'ยืนยันการเชื่อมต่อ ณ เวลาตรวจ':'เวลาตรวจยังยืนยันไม่ได้ โปรดลองตรวจใหม่ภายหลัง'}</p>
   <p>ขีดจำกัดจาก API: {result.quota.value} ข้อความ</p>
   <p>การใช้จาก API: {result.quota.totalUsage} ข้อความ</p>
   <p>ตรวจเมื่อ <time dateTime={result.quota.observedAt}>{new Date(result.quota.observedAt).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'})}</time> · เวลาไทย</p>
  </>:<p>บัญชี LINE ไม่ตรงกับที่กำหนด ยังยืนยันการเชื่อมต่อไม่ได้</p>)}</div>
  {view.error&&<p role="alert" className="error-text">{view.error}</p>}
 </section>;
}
