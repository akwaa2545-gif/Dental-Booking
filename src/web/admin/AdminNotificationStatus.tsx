import type { AdminNotificationSummary } from '../../shared/contracts';

const STATE_LABELS: Record<AdminNotificationSummary['state'], string> = {
  queued: 'รอส่ง',
  leased: 'กำลังดำเนินการ',
  retry: 'รอลองใหม่',
  paused_quota: 'พักเพราะโควตา',
  accepted: 'LINE รับคำขอแล้ว',
  suppressed: 'หยุดส่ง',
  failed: 'ส่งไม่สำเร็จ',
};
const REASON_LABELS: Record<string, string> = {
  mapping_unavailable: 'ยังไม่มีบัญชี LINE ที่เชื่อมและยืนยันแล้ว',
  recipient_unavailable: 'บัญชีผู้รับยังไม่พร้อมรับข้อความ',
  duplicate_recipient: 'บัญชี LINE นี้มีรายการแจ้งเตือนสำหรับคำขอนี้แล้ว',
  policy_disabled: 'ยังไม่อนุญาตให้ส่งรายการนี้',
  expired: 'หมดอายุหลังบันทึกคำขอครบ 24 ชั่วโมง จะไม่ส่งย้อนหลัง',
  grant_revoked: 'สิทธิ์แอดมินเดิมถูกถอนแล้ว',
  mapping_changed: 'บัญชี LINE ที่เชื่อมไว้เปลี่ยนไป',
  quota_unknown: 'ยังยืนยันโควตาฟรีไม่ได้',
  quota_exhausted: 'โควตาฟรีที่ยืนยันไว้ไม่เพียงพอ',
  budget_expired: 'ข้อมูลยืนยันงบหมดอายุแล้ว',
  invalid_request: 'คำขอไม่ผ่านการตรวจสอบเพื่อส่ง',
  unknown: 'ยุติการลองส่งอัตโนมัติแล้ว ไม่สามารถยืนยันผลคำขอเดิม',
  timeout: 'คำขอใช้เวลานานเกินกำหนด ผลเดิมยังไม่แน่ชัด',
  transport: 'การเชื่อมต่อขัดข้อง ผลเดิมยังไม่แน่ชัด',
  server_error: 'ผู้ให้บริการขัดข้องชั่วคราว',
  rate_limited: 'ผู้ให้บริการจำกัดการส่ง จึงหยุดลองส่งอัตโนมัติ',
  unauthorized: 'ผู้ให้บริการไม่อนุญาตคำขอนี้',
  forbidden: 'ผู้ให้บริการปฏิเสธสิทธิ์การส่ง',
};

function safeLabel(labels: Record<string, string>, value: unknown, fallback: string): string {
  return typeof value === 'string' && Object.hasOwn(labels, value) ? labels[value] : fallback;
}
function recipientLabel(value: unknown): string {
  const match = typeof value === 'string' ? /^แอดมิน ([1-9]\d*)$/u.exec(value) : null;
  // Exact match also rejects a trailing newline, which JavaScript's $ can admit.
  return match && match[0] === value && Number.isSafeInteger(Number(match[1])) ? match[0] : 'แอดมิน (ไม่ระบุลำดับ)';
}
function validAttemptCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6;
}

export function AdminNotificationStatus({ items }: { items: AdminNotificationSummary[] }) {
  const partial = items.some(item => item.state === 'accepted') && items.some(item => item.state !== 'accepted');
  const paused = items.some(item => item.state === 'paused_quota');
  return <section className="small-copy admin-notifications" aria-label="แจ้งเตือนแอดมิน">
    <h3>แจ้งเตือนแอดมิน</h3>
    {items.length ? <>
      <p>สถานะ “LINE รับคำขอแล้ว” ไม่ได้ยืนยันว่าอุปกรณ์ได้รับข้อความหรือผู้รับอ่านแล้ว</p>
      {partial && <p>LINE รับคำขอแล้วสำหรับผู้รับบางราย โปรดตรวจสอบสถานะรายผู้รับด้านล่าง</p>}
      {paused && <p>ตรวจโควตาใหม่ไม่ถี่กว่าทุก 15 นาที รายการหมดอายุภายใน 24 ชั่วโมงนับจากบันทึกคำขอ และจะไม่ส่งย้อนหลังหลังหมดอายุ</p>}
      <ul>{items.map((item, index) => <li key={index}>
        <strong>{recipientLabel(item.recipientLabel)}</strong> · <span>{item.state === 'failed' && item.safeReason === 'unknown'
          ? 'ผลการส่งยังไม่แน่ชัด' : safeLabel(STATE_LABELS, item.state, 'ยังยืนยันสถานะไม่ได้')}</span>
        <p>{validAttemptCount(item.attemptCount) ? `พยายามส่ง ${item.attemptCount} ครั้ง` : 'ไม่ทราบจำนวนครั้งที่พยายามส่ง'}</p>
        {item.safeReason !== null && <p>{safeLabel(REASON_LABELS, item.safeReason, 'ไม่มีรายละเอียดเหตุผลที่แสดงได้')}</p>}
        {item.state === 'suppressed' && validAttemptCount(item.attemptCount) && item.attemptCount > 0 &&
          <p>หยุดการลองครั้งต่อไป คำขอที่เริ่มไปแล้วอาจได้รับการตอบรับและเรียกคืนไม่ได้</p>}
      </li>)}</ul>
      <p>สถานะแจ้งเตือนไม่เปลี่ยนผลการจอง โปรดใช้คิวคำขอเป็นข้อมูลหลัก</p>
    </> : <p>ยังไม่มีรายการแจ้งเตือนแอดมินสำหรับคำขอนี้</p>}
  </section>;
}
