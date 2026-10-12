import {useEffect,useRef,useState} from 'react';
import {sendApprovedNotificationTest,type ApiClient,type ApprovedNotificationTestResult} from '../api';
const marker='toothtalk:approved-card-test:attempted:v1';
function attemptedInTab(){try{return window.sessionStorage.getItem(marker)==='true';}catch{return false;}}
/** Staging control only. The server's durable attempt fence is authoritative. */
export function ManualApprovalControl({api}:{api:ApiClient}){
 const [used,setUsed]=useState(attemptedInTab);
 const [pending,setPending]=useState(false);
 const [status,setStatus]=useState<ApprovedNotificationTestResult['status']|null>(null);
 const consumed=useRef(used),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 async function send(){
  if(consumed.current)return;
  consumed.current=true;setUsed(true);setPending(true);
  // Non-sensitive attempt marker only: never persist cookies, CSRF or booking data.
  try{window.sessionStorage.setItem(marker,'true');}catch{/* Server still permanently fences this operation. */}
  try{const result=await sendApprovedNotificationTest(api);if(alive.current)setStatus(result.status);}
  catch{if(alive.current)setStatus('unknown');}
  finally{if(alive.current)setPending(false);}
 }
 return <section className="page-card" aria-labelledby="approved-notification-test-title">
  <h2 id="approved-notification-test-title">ทดสอบแจ้งเตือนที่อนุมัติ · Staging</h2>
  <p>ส่งเฉพาะบัตรอนุมัตินัดหมายทดสอบเดิม วันที่ 14 ตุลาคม 2569 เวลา 08:30–09:30 ไปยังบัญชี LINE ที่อนุมัติไว้ 1 ครั้ง</p>
  <p className="small-copy">ไม่ส่งข้อความเตือนในอนาคตหรือรายการอื่น และยังไม่เปิดการส่งอัตโนมัติ</p>
  <button className="button secondary" disabled={used||pending} onClick={()=>void send()}>{pending?'กำลังตรวจสอบและส่งคำขอ…':'ส่งการแจ้งเตือนทดสอบที่อนุมัติ'}</button>
  <div role="status" aria-live="polite">
   {status==='accepted'&&<p>LINE รับคำขอแล้ว โปรดตรวจสอบแชต ยังไม่ได้ยืนยันว่าข้อความส่งถึงหรืออ่านแล้ว</p>}
   {status==='failed'&&<p>ส่งไม่สำเร็จ หยุดการทดสอบแล้ว ไม่มีการส่งซ้ำอัตโนมัติ</p>}
   {status==='not_sent'&&<p>ไม่มีการส่งเพิ่ม คำขออาจถูกใช้แล้วหรือไม่พร้อมส่ง โปรดตรวจสอบผลเดิมก่อน</p>}
   {(status==='unknown'||used&&!pending&&!status)&&<p>ยังยืนยันผลไม่ได้ โปรดตรวจสอบแชตและผลเดิม ปุ่มถูกปิดเพื่อป้องกันการส่งซ้ำ</p>}
  </div>
 </section>;
}
