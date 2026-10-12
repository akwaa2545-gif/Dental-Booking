import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Patient, PatientInput, Relationship } from '../../shared/contracts';
import { parsePatient, requiresAgeReview } from '../../shared/validation';
import { ApiRequestError, errorText, type ApiClient } from '../api';

export type PatientDraft = { selected: string; fields: Partial<PatientInput>; source?: Patient };

export function PatientForm({ api, initial, initialDraft, onContinue, onBack }: { api: ApiClient; initial?: Patient; initialDraft?: PatientDraft; onContinue: (patient: Patient) => void; onBack: (draft: PatientDraft) => void }) {
  const [patients, setPatients] = useState<Patient[]>([]);
  const [patientsReady, setPatientsReady] = useState(false);
  const [source, setSource] = useState<Patient | undefined>(initialDraft?.source ?? initial);
  const [selected, setSelected] = useState(initialDraft?.selected ?? initial?.id ?? '');
  const [fields, setFields] = useState<Partial<PatientInput>>(initialDraft?.fields ?? initial ?? {});
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const guard = useRef(false);
  const edited = useRef(false);
  const phoneInput = useRef<HTMLInputElement>(null);
  const pendingPhoneCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingPhoneCaret.current !== null) {
      phoneInput.current?.setSelectionRange(pendingPhoneCaret.current, pendingPhoneCaret.current);
      pendingPhoneCaret.current = null;
    }
  });
  useEffect(() => { let alive = true; api.request<Patient[]>('/api/patients').then(items => { if (alive) { setPatients(items); setPatientsReady(true); if (!edited.current && !initial && !initialDraft && items[0]) { setSelected(items[0].id); setFields(items[0]); setSource(items[0]); } } }).catch(e => { if (alive) setError(errorText(e)); }); return () => { alive = false; }; }, [api, initial, initialDraft]);
  const update = (key: keyof PatientInput, value: string | number | undefined) => { edited.current = true; setFields(old => ({ ...old, [key]: value })); setAcknowledged(false); };
  async function submit() {
    if (guard.current || !patientsReady) return;
    if (!/^[0-9]{10}$/.test(fields.phone ?? '') || fields.phone?.length !== 10) { setError('เบอร์โทรศัพท์ต้องเป็นตัวเลข 10 หลัก'); return; }
    guard.current = true;
    setBusy(true); setError('');
    try {
      const input = parsePatient({ fullName: fields.fullName, phone: fields.phone, age: fields.age, address: fields.address, relationship: fields.relationship, authorizationAcknowledged: acknowledged });
      const existing = patients.find(p => p.id === selected);
      if (selected && selected !== 'new' && !existing) { setError('ไม่พบโปรไฟล์ที่เลือก โปรดเลือกผู้รับบริการใหม่'); return; }
      if (existing && (!source || source.id !== existing.id || source.version !== existing.version)) throw new ApiRequestError('VERSION_CONFLICT');
      const changed = existing && Object.keys(input).some(key => input[key as keyof PatientInput] !== existing[key as keyof PatientInput]);
      const patient = existing && !changed ? existing : await api.request<Patient>(existing ? `/api/patients/${existing.id}` : '/api/patients', { method: existing ? 'PATCH' : 'POST', body: JSON.stringify(existing ? { version: existing.version, ...input } : input) });
      onContinue(patient);
    } catch (e) { setError(e instanceof Error && e.name === 'ZodError' ? 'กรอกชื่อ เบอร์โทร อายุ ที่อยู่ ความสัมพันธ์ และยืนยันสิทธิ์ให้ครบ' : errorText(e)); } finally { guard.current = false; setBusy(false); }
  }
  return <form onSubmit={e => { e.preventDefault(); void submit(); }} className="patient-form">
    <h2 tabIndex={-1}>ข้อมูลผู้รับบริการ</h2><p className="small-copy">เลือกโปรไฟล์สมมติของคุณหรือครอบครัว ทุกช่องแก้ไขได้เพื่อทดสอบ ห้ามกรอกข้อมูลจริง</p>
    <label className="field">ผู้รับบริการสมมติ<select disabled={busy} value={selected} onChange={e => { edited.current = true; const p = patients.find(p => p.id === e.target.value); setSelected(e.target.value); setSource(p); setFields(p ?? { fullName: '', phone: '', age: 0, address: '', relationship: 'family' }); setAcknowledged(false); }}>{patients.map(p => <option value={p.id} key={p.id}>{p.fullName} · {p.relationship === 'self' ? 'ตนเอง' : 'ครอบครัว'}</option>)}<option value="new">เพิ่มผู้รับบริการสมมติ</option></select></label>
    <div className="form-grid"><label className="field">ชื่อ–นามสกุล *<input disabled={busy} required maxLength={120} autoComplete="off" value={fields.fullName ?? ''} onChange={e => update('fullName', e.target.value)} /></label><label className="field">เบอร์โทรศัพท์ *<input disabled={busy} ref={phoneInput} required type="tel" inputMode="numeric" pattern="[0-9]{10}" minLength={10} maxLength={10} title="เบอร์โทรศัพท์ต้องเป็นตัวเลข 10 หลัก" autoComplete="off" value={fields.phone ?? ''} onChange={e => update('phone', e.target.value.replace(/[^0-9]/g, '').slice(0, 10))} onPaste={e => {
      e.preventDefault();
      const input = e.currentTarget;
      const digits = e.clipboardData.getData('text').replace(/[^0-9]/g, '');
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      const prefix = input.value.slice(0, start).replace(/[^0-9]/g, '');
      const suffix = input.value.slice(end).replace(/[^0-9]/g, '');
      const capacity = 10 - prefix.length - suffix.length;
      if (capacity < 0) return;
      const inserted = digits.slice(0, capacity);
      pendingPhoneCaret.current = prefix.length + inserted.length;
      update('phone', prefix + inserted + suffix);
    }} /></label><label className="field">อายุ (ปี) *<input disabled={busy} required type="number" min={0} max={150} value={fields.age ?? ''} onChange={e => update('age', e.target.value === '' ? undefined : Number(e.target.value))} /></label><label className="field">ความสัมพันธ์ *<select disabled={busy} value={fields.relationship ?? ''} required onChange={e => update('relationship', e.target.value as Relationship)}><option value="" disabled>เลือกความสัมพันธ์</option><option value="self">ตนเอง</option><option value="parent">บิดา/มารดา</option><option value="guardian">ผู้ปกครอง</option><option value="family">สมาชิกครอบครัว</option></select></label></div>
    <label className="field">ที่อยู่บ้าน *<textarea disabled={busy} required rows={3} autoComplete="off" maxLength={500} value={fields.address ?? ''} onChange={e => update('address', e.target.value)} /></label>
    {requiresAgeReview(Number(fields.age)) && <p className="notice">อายุนี้ต้องให้คลินิกตรวจสอบเพิ่มเติม</p>}
    <label className="checkbox-field"><input disabled={busy} type="checkbox" checked={acknowledged} onChange={e => { edited.current = true; setAcknowledged(e.target.checked); }} required /><span>ยืนยันอายุและสิทธิ์ในการนัดหมายให้ผู้รับบริการนี้ อายุ {Number.isFinite(fields.age) ? fields.age : '—'} ปี (ข้อมูลสมมติ)</span></label>
    {error && <p role="alert" className="error-text">{error}</p>}<div className="form-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => onBack({ selected, fields, source })}>ย้อนกลับ</button><button className="button primary" disabled={busy || !patientsReady}>{busy ? 'กำลังตรวจสอบ…' : 'ถัดไป'}</button></div>
  </form>;
}
