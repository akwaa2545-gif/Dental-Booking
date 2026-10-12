import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { createDemoApi } from '../../src/demo/api';
import { createDemoClock } from '../../src/demo/clock';
import { FIXTURE_IDS } from '../../src/demo/fixtures';
import type { Appointment, Patient } from '../../src/shared/contracts';
import { ApiRequestError, type ApiClient } from '../../src/web/api';
import { BookingFlow } from '../../src/web/booking/BookingFlow';
import { PatientForm } from '../../src/web/booking/PatientForm';

// These are UI-only synthetic fixtures. They do not establish PostgreSQL or LINE behavior.
const makeApi = () => createDemoApi({ now: createDemoClock().now });
async function reachReview(user: ReturnType<typeof userEvent.setup>, date = '2026-10-08') {
  await screen.findByDisplayValue('คุณยิ้ม ทดลอง');
  await user.click(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }));
  await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
  await user.click(await screen.findByRole('button', { name: new RegExp(`^${date} ว่าง`) }));
  await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
}

describe('family booking recovery', () => {
  it.each(['UNAVAILABLE', 'UNAUTHENTICATED'] as const)('freezes the original key and payload through %s, back navigation and an explicit continuation', async code => {
    const real = makeApi();
    const attempts: { key: string | null; body: BodyInit | null | undefined }[] = [];
    const lookups: string[] = [];
    const api: ApiClient = { async request<T>(path: string, init?: RequestInit): Promise<T> {
      if (path === '/api/appointments' && init?.method === 'POST') {
        attempts.push({ key: new Headers(init.headers).get('Idempotency-Key'), body: init.body });
        if (attempts.length === 1) throw new ApiRequestError(code, code === 'UNAUTHENTICATED' ? 401 : 503);
      }
      if (path.startsWith('/api/submissions/')) lookups.push(path.split('/').at(-1)!);
      return real.request<T>(path, init);
    } };
    let result: Appointment | undefined;
    const user = userEvent.setup();
    render(<BookingFlow api={api} initialService="filling" onSubmitted={value => { result = value; }} />);
    await reachReview(user);
    await user.click(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' }));
    const back = screen.getByRole('button', { name: 'ย้อนกลับ' });
    expect(back).toBeDisabled();
    await user.click(back);
    expect(screen.getByRole('heading', { name: 'ตรวจสอบคำขอนัดหมาย' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'ส่งคำขอนัดหมาย' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'ตรวจสอบคำขอเดิม' }));
    expect(screen.getByRole('alert')).toHaveTextContent('ไม่มีการส่งซ้ำอัตโนมัติ');
    expect(attempts).toHaveLength(1);
    expect(result).toBeUndefined();
    expect(screen.getByRole('button', { name: 'ย้อนกลับ' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' }));
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(lookups).toEqual([attempts[0]!.key]);
    expect(result?.status).toBe('pending');
    expect((await real.request<Appointment[]>('/api/appointments')).filter(a => a.patientId === FIXTURE_IDS.self && a.date === '2026-10-08')).toHaveLength(1);
  });

  it('keeps recovery locked after a failed lookup and recovers a committed request without another write', async () => {
    const real = makeApi(); let writes = 0; let checks = 0; let result: Appointment | undefined;
    const api: ApiClient = { async request<T>(path: string, init?: RequestInit): Promise<T> {
      if (path === '/api/appointments' && init?.method === 'POST') {
        writes++; await real.request(path, init); throw new TypeError('Synthetic lost response');
      }
      if (path.startsWith('/api/submissions/') && ++checks === 1) throw new ApiRequestError('UNAUTHENTICATED', 401);
      return real.request<T>(path, init);
    } };
    const user = userEvent.setup();
    render(<BookingFlow api={api} initialService="oral_check" onSubmitted={value => { result = value; }} />);
    await reachReview(user); await user.click(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' }));
    await user.click(screen.getByRole('button', { name: 'ตรวจสอบคำขอเดิม' }));
    expect(screen.getByRole('button', { name: 'ย้อนกลับ' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'ส่งคำขอนัดหมาย' })).not.toBeInTheDocument();
    expect(result).toBeUndefined();
    await user.click(screen.getByRole('button', { name: 'ตรวจสอบคำขอเดิม' }));
    expect(result?.status).toBe('pending'); expect(writes).toBe(1);
  });

  it('blocks rapid duplicate submissions while the first response is outstanding', async () => {
    const real = makeApi(); let release!: () => void; let writes = 0;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const api: ApiClient = { async request<T>(path: string, init?: RequestInit): Promise<T> {
      if (path === '/api/appointments' && init?.method === 'POST') { writes++; await waiting; }
      return real.request<T>(path, init);
    } };
    let result: Appointment | undefined; const user = userEvent.setup();
    render(<BookingFlow api={api} initialService="oral_check" onSubmitted={value => { result = value; }} />);
    await reachReview(user); await user.dblClick(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' }));
    expect(writes).toBe(1); expect(screen.getByRole('button', { name: 'ย้อนกลับ' })).toBeDisabled();
    await act(async () => { release(); await waiting; });
    await waitFor(() => expect(result?.status).toBe('pending'));
  });

  it('refreshes a full date with a fresh request key, while retaining the patient and service', async () => {
    const real = makeApi(); const keys: (string | null)[] = [];
    const api: ApiClient = { async request<T>(path: string, init?: RequestInit): Promise<T> {
      if (path === '/api/appointments' && init?.method === 'POST') keys.push(new Headers(init.headers).get('Idempotency-Key'));
      return real.request<T>(path, init);
    } };
    const user = userEvent.setup(); let result: Appointment | undefined;
    render(<BookingFlow api={api} initialService="scaling" onSubmitted={value => { result = value; }} />);
    await reachReview(user);
    for (const [patientId, ageConfirmed] of [[FIXTURE_IDS.parent, 65], [FIXTURE_IDS.child, 12]] as const) {
      await real.request('/api/appointments', { method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ patientId, patientVersion: 1, service: 'filling', date: '2026-10-08', ageConfirmed, authorizationAcknowledged: true }) });
    }
    await user.click(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' }));
    const full = await screen.findByRole('button', { name: /^2026-10-08 เต็ม/ });
    expect(full).toBeDisabled(); expect(full).toHaveClass('full'); expect(full).toHaveTextContent('เต็ม');
    await user.click(screen.getByRole('button', { name: 'ย้อนกลับ' }));
    expect(await screen.findByRole('textbox', { name: 'ชื่อ–นามสกุล *' })).toHaveValue('คุณยิ้ม ทดลอง');
    expect(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ })).not.toBeChecked();
    await user.click(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }));
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    await user.click(screen.getByRole('button', { name: /^2026-10-14 ว่าง/ }));
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    expect(screen.getByText('ขูดหินปูน')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' }));
    expect(keys).toHaveLength(2); expect(keys[1]).not.toBe(keys[0]); expect(result?.status).toBe('pending');
  });

  it('moves keyboard focus to each new step heading', async () => {
    const user = userEvent.setup(); render(<BookingFlow api={makeApi()} onSubmitted={() => {}} />);
    expect(screen.getByRole('heading', { name: 'เลือกบริการที่ต้องการ' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: /ตรวจสุขภาพช่องปาก/ }));
    expect(screen.getByRole('heading', { name: 'ข้อมูลผู้รับบริการ' })).toHaveFocus();
    await screen.findByDisplayValue('คุณยิ้ม ทดลอง');
    await user.click(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }));
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    expect(screen.getByRole('heading', { name: 'เลือกวันนัดหมาย' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: /^2026-10-08 ว่าง/ }));
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    expect(screen.getByRole('heading', { name: 'ตรวจสอบคำขอนัดหมาย' })).toHaveFocus();
  });

  it('preserves an unsaved family draft when going back to change the service, but requires age acknowledgement again', async () => {
    const user = userEvent.setup(); const api = makeApi();
    render(<BookingFlow api={api} initialService="filling" onSubmitted={() => {}} />);
    await screen.findByDisplayValue('คุณยิ้ม ทดลอง');
    await user.selectOptions(screen.getByRole('combobox', { name: 'ผู้รับบริการสมมติ' }), 'new');
    await user.type(screen.getByLabelText('ชื่อ–นามสกุล *'), 'ครอบครัวทดสอบ');
    await user.type(screen.getByLabelText('เบอร์โทรศัพท์ *'), '0990000000');
    await user.clear(screen.getByLabelText('อายุ (ปี) *')); await user.type(screen.getByLabelText('อายุ (ปี) *'), '18');
    await user.type(screen.getByLabelText('ที่อยู่บ้าน *'), 'ถนนสมมติ');
    await user.selectOptions(screen.getByLabelText('ความสัมพันธ์ *'), 'guardian');
    await user.click(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }));
    await user.click(screen.getByRole('button', { name: 'ย้อนกลับ' }));
    await user.click(screen.getByRole('button', { name: /ขูดหินปูน/ }));
    expect(screen.getByLabelText('ชื่อ–นามสกุล *')).toHaveValue('ครอบครัวทดสอบ');
    expect(screen.getByLabelText('เบอร์โทรศัพท์ *')).toHaveValue('0990000000');
    expect(screen.getByLabelText('อายุ (ปี) *')).toHaveValue(18);
    expect(screen.getByLabelText('ที่อยู่บ้าน *')).toHaveValue('ถนนสมมติ');
    expect(screen.getByLabelText('ความสัมพันธ์ *')).toHaveValue('guardian');
    expect(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ })).not.toBeChecked();
    expect((await api.request<Patient[]>('/api/patients')).some(patient => patient.fullName === 'ครอบครัวทดสอบ')).toBe(false);
  });
  it.each(['RATE_LIMITED', 'FULL'] as const)('does not release a frozen request when an explicit retry returns %s', async code => {
    const real = makeApi(); let writes = 0; const keys: (string | null)[] = [];
    const api: ApiClient = { async request<T>(path: string, init?: RequestInit): Promise<T> {
      if (path === '/api/appointments' && init?.method === 'POST') {
        keys.push(new Headers(init.headers).get('Idempotency-Key'));
        if (++writes === 1) throw new ApiRequestError('UNAVAILABLE', 503);
        throw new ApiRequestError(code, code === 'FULL' ? 409 : 429);
      }
      return real.request<T>(path, init);
    } };
    const user = userEvent.setup(); render(<BookingFlow api={api} initialService="filling" onSubmitted={() => {}} />);
    await reachReview(user); await user.click(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' }));
    await user.click(screen.getByRole('button', { name: 'ตรวจสอบคำขอเดิม' }));
    await user.click(screen.getByRole('button', { name: 'ส่งคำขอนัดหมาย' }));
    expect(screen.getByRole('button', { name: 'ย้อนกลับ' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'ตรวจสอบคำขอเดิม' })).toBeVisible();
    expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
  });

  it('explains server-backed synthetic data retention without claiming tab-only storage or simulated identity', async () => {
    const real = makeApi(); const api: ApiClient = { dataMode: 'server', request: real.request };
    const user = userEvent.setup(); render(<BookingFlow api={api} initialService="oral_check" onSubmitted={() => {}} />);
    await reachReview(user);
    expect(screen.getByText(/ข้อมูลสมมติถูกบันทึกในระบบ/)).toBeVisible();
    expect(screen.getByText(/โหลดหน้าใหม่ไม่ลบข้อมูล/)).toBeVisible();
    expect(screen.queryByText(/ข้อมูลนี้อยู่ในหน่วยความจำของแท็บเท่านั้น/)).not.toBeInTheDocument();
    expect(screen.queryByText(/การเข้าสู่ระบบ LINE และข้อความทั้งหมดเป็นการจำลอง/)).not.toBeInTheDocument();
    expect(screen.getByText(/ยังไม่ตั้งค่าช่องทางที่ตรวจสอบแล้ว/)).toBeVisible();
  });

  it.each(['navigation', 'duplicate submission'] as const)('guards a pending profile save against %s', async scenario => {
    const real = makeApi(); let release!: () => void; let saves = 0;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const api: ApiClient = { async request<T>(path: string, init?: RequestInit): Promise<T> {
      if (path.startsWith('/api/patients') && init?.method === 'PATCH') { saves++; await waiting; }
      return real.request<T>(path, init);
    } };
    const user = userEvent.setup(); render(<BookingFlow api={api} initialService="filling" onSubmitted={() => {}} />);
    await screen.findByDisplayValue('คุณยิ้ม ทดลอง');
    await user.type(screen.getByLabelText('ชื่อ–นามสกุล *'), ' ทดสอบ');
    await user.click(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }));
    const form = screen.getByLabelText('ชื่อ–นามสกุล *').closest('form')!;
    act(() => { fireEvent.submit(form); if (scenario === 'duplicate submission') fireEvent.submit(form); });
    if (scenario === 'navigation') {
      expect(screen.getByRole('button', { name: 'ย้อนกลับ' })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: 'ย้อนกลับ' }));
      expect(screen.getByRole('heading', { name: 'ข้อมูลผู้รับบริการ' })).toBeVisible();
    } else expect(saves).toBe(1);
    await act(async () => { release(); await waiting; });
    expect(await screen.findByRole('heading', { name: 'เลือกวันนัดหมาย' })).toBeVisible();
  });

  it('never replaces an edited draft when the initial patient list arrives late', async () => {
    const real = makeApi(); let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const api: ApiClient = { async request<T>(path: string, init?: RequestInit): Promise<T> {
      if (path === '/api/patients' && !init?.method) await waiting;
      return real.request<T>(path, init);
    } };
    const user = userEvent.setup(); render(<BookingFlow api={api} initialService="filling" onSubmitted={() => {}} />);
    await user.type(screen.getByLabelText('ชื่อ–นามสกุล *'), 'ร่างใหม่ สมมติ');
    await act(async () => { release(); await waiting; });
    expect(screen.getByLabelText('ชื่อ–นามสกุล *')).toHaveValue('ร่างใหม่ สมมติ');
  });

  it('locks every editable patient field until a pending save resolves', async () => {
    const real = makeApi(); let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const api: ApiClient = { async request<T>(path: string, init?: RequestInit): Promise<T> {
      if (path.startsWith('/api/patients') && init?.method === 'PATCH') await waiting;
      return real.request<T>(path, init);
    } };
    const user = userEvent.setup(); render(<BookingFlow api={api} initialService="filling" onSubmitted={() => {}} />);
    await screen.findByDisplayValue('คุณยิ้ม ทดลอง');
    await user.type(screen.getByLabelText('ชื่อ–นามสกุล *'), ' ทดสอบ');
    await user.click(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }));
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    for (const control of screen.getByLabelText('ชื่อ–นามสกุล *').closest('form')!.querySelectorAll('input,select,textarea')) expect(control).toBeDisabled();
    await act(async () => { release(); await waiting; });
    expect(await screen.findByRole('heading', { name: 'เลือกวันนัดหมาย' })).toBeVisible();
  });

  it('never creates a duplicate of an existing selected patient before its list has loaded', async () => {
    const real = makeApi(); const initial = (await real.request<Patient[]>('/api/patients'))[0]!;
    let release!: () => void; let writes = 0;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const api: ApiClient = { async request<T>(path: string, init?: RequestInit): Promise<T> {
      if (init?.method) writes++; else await waiting;
      return real.request<T>(path, init);
    } };
    const user = userEvent.setup(); let continued = false;
    render(<PatientForm api={api} initial={initial} onContinue={() => { continued = true; }} onBack={() => {}} />);
    await user.click(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }));
    fireEvent.submit(screen.getByLabelText('ชื่อ–นามสกุล *').closest('form')!);
    expect(writes).toBe(0); expect(continued).toBe(false);
    await act(async () => { release(); await waiting; });
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    expect(continued).toBe(true); expect(writes).toBe(0);
  });

  it('never turns an unavailable selected profile into a new one after list resolution', async () => {
    const initial = (await makeApi().request<Patient[]>('/api/patients'))[0]!;
    let writes = 0;
    const api: ApiClient = { async request<T>(_path: string, init?: RequestInit): Promise<T> { if (init?.method) writes++; return [] as T; } };
    const user = userEvent.setup();
    render(<PatientForm api={api} initial={initial} onContinue={() => {}} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'ถัดไป' })).toBeEnabled());
    await user.click(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }));
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    expect(writes).toBe(0);
    expect(screen.getByRole('alert')).toBeVisible();
  });

  it('never overwrites a newer server profile using an older displayed snapshot', async () => {
    const initial = (await makeApi().request<Patient[]>('/api/patients'))[0]!;
    const newer = { ...initial, version: initial.version + 1, fullName: 'แก้ไขพร้อมกัน สมมติ' };
    let writes = 0; let continued = false;
    const api: ApiClient = { async request<T>(_path: string, init?: RequestInit): Promise<T> { if (init?.method) writes++; return (init?.method ? newer : [newer]) as T; } };
    const user = userEvent.setup();
    render(<PatientForm api={api} initial={initial} onContinue={() => { continued = true; }} onBack={() => {}} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'ถัดไป' })).toBeEnabled());
    await user.click(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }));
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    expect(writes).toBe(0); expect(continued).toBe(false);
    expect(screen.getByRole('alert')).toHaveTextContent('สถานะเปลี่ยนแล้ว');
    await user.selectOptions(screen.getByLabelText('ผู้รับบริการสมมติ'), 'new');
    await user.selectOptions(screen.getByLabelText('ผู้รับบริการสมมติ'), initial.id);
    expect(screen.getByLabelText('ชื่อ–นามสกุล *')).toHaveValue(newer.fullName);
    expect(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ })).not.toBeChecked();
  });

});
