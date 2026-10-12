import type { Patient, Service } from '../../shared/contracts';
import { FIXED_WINDOW, SERVICE_LABELS, formatThaiDate } from '../copy.th';
export function ReviewRequest({ patient, service, date, dataMode = 'demo' }: { patient: Patient; service: Service; date: string; dataMode?: 'demo' | 'server' }) {
  return <section>
    <h2 tabIndex={-1}>ตรวจสอบคำขอนัดหมาย</h2>
    <p className="small-copy">การส่งคำขอยังไม่ใช่การยืนยัน ต้องรอคลินิกอนุมัติ</p>
    <div className="review-cards">
      <section className="review-card review-appointment" aria-labelledby="review-appointment-heading">
        <h3 id="review-appointment-heading">รายละเอียดนัดหมาย</h3>
        <dl className="detail-grid">
          <dt>บริการ</dt><dd>{SERVICE_LABELS[service]}</dd>
          <dt>วันนัด</dt><dd>{formatThaiDate(date)}</dd>
          <dt>เวลาคงที่</dt><dd>{FIXED_WINDOW} น. · Asia/Bangkok</dd>
        </dl>
      </section>
      <section className="review-card review-patient" aria-labelledby="review-patient-heading">
        <h3 id="review-patient-heading">ข้อมูลผู้รับบริการ</h3>
        <dl className="detail-grid">
          <dt>ผู้รับบริการสมมติ</dt><dd>{patient.fullName}</dd>
          <dt>เบอร์โทรศัพท์</dt><dd>{patient.phone}</dd>
          <dt>อายุที่ยืนยัน</dt><dd>{patient.age} ปี</dd>
          <dt>ที่อยู่บ้าน</dt><dd>{patient.address}</dd>
        </dl>
      </section>
      <section className="review-card review-conditions" aria-labelledby="review-conditions-heading">
        <h3 id="review-conditions-heading">เงื่อนไขและความเป็นส่วนตัว</h3>
        <dl className="detail-grid">
          <dt>กำหนดยกเลิก</dt><dd>ก่อน 00:00 น. ของวันนัด ({date}) ตามเวลาไทย</dd>
        </dl>
        <div className="notice">{dataMode === 'server' ? 'ความเป็นส่วนตัว: ข้อมูลสมมติถูกบันทึกในระบบทดสอบ โหลดหน้าใหม่ไม่ลบข้อมูล ห้ามใช้ข้อมูลผู้ป่วยจริง ยังไม่เปิดรับนัดหมายจริง' : 'ความเป็นส่วนตัว: ข้อมูลนี้อยู่ในหน่วยความจำของแท็บเท่านั้น โหลดหน้าใหม่เพื่อล้าง ห้ามใช้ข้อมูลผู้ป่วยจริง'}</div>
        <p className="small-copy">ติดต่อคลินิก: ยังไม่ตั้งค่าช่องทางที่ตรวจสอบแล้ว{dataMode === 'demo' && ' การเข้าสู่ระบบ LINE และข้อความทั้งหมดเป็นการจำลอง'}</p>
      </section>
    </div>
  </section>;
}
