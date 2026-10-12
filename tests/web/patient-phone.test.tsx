import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { createDemoApi } from '../../src/demo/api';
import { createDemoClock } from '../../src/demo/clock';
import type { Patient, PatientInput } from '../../src/shared/contracts';
import type { ApiClient } from '../../src/web/api';
import { PatientForm } from '../../src/web/booking/PatientForm';

const fields: PatientInput = { fullName: 'Synthetic patient', phone: '0800000000', age: 42, address: 'Fictional address', relationship: 'self', authorizationAcknowledged: true };
const legacy: Patient = { ...fields, id: '20000000-0000-4000-8000-000000000001', phone: '+66 (0) 800-0000', ageCapturedOn: '2026-10-08', version: 1 };

async function setup(phone = '') {
  const api = createDemoApi({ now: createDemoClock().now });
  const onContinue = vi.fn();
  const user = userEvent.setup();
  render(<PatientForm api={api} initialDraft={{ selected: 'new', fields: { ...fields, phone } }} onContinue={onContinue} onBack={() => {}} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'ถัดไป' })).toBeEnabled());
  return { api, user, onContinue, phone: screen.getByLabelText<HTMLInputElement>('เบอร์โทรศัพท์ *') };
}

describe('patient phone editing', () => {
  it('uses a telephone field with a numeric keyboard and ten-digit constraint', async () => {
    const { phone } = await setup();
    expect(phone).toHaveAttribute('type', 'tel');
    expect(phone).toHaveAttribute('inputmode', 'numeric');
    expect(phone).toHaveAttribute('minlength', '10');
    expect(phone).toHaveAttribute('maxlength', '10');
    expect(phone).toHaveAttribute('title', 'เบอร์โทรศัพท์ต้องเป็นตัวเลข 10 หลัก');
    expect(phone).toHaveAttribute('pattern', '[0-9]{10}');
  });

  it('filters typing to ten ASCII digits and preserves a leading zero', async () => {
    const { user, phone } = await setup();
    await user.type(phone, '0a8b๐０00000000123');
    expect(phone).toHaveValue('0800000000');
  });

  it('filters ASCII digits from a change event before truncating', async () => {
    const { phone } = await setup('1234567890');
    phone.focus();
    fireEvent.change(phone, { target: { value: '12a34567890', selectionStart: 3, selectionEnd: 3 } });
    expect(phone).toHaveValue('1234567890');
  });

  it('sanitizes the complete pasted text before applying the ten-digit limit', async () => {
    const { user, phone } = await setup();
    await user.click(phone);
    await user.paste('  (080) 123-4567 abc ๙９ 890 ');
    expect(phone).toHaveValue('0801234567');
    expect(phone.selectionStart).toBe(10);
  });

  it('keeps the unselected suffix when a long paste replaces a middle selection', async () => {
    const { user, phone } = await setup('1234567890');
    await user.click(phone);
    phone.setSelectionRange(2, 4);
    await user.paste(' (90) 12345 ');
    expect(phone).toHaveValue('1290567890');
    expect(phone.selectionStart).toBe(4);
    expect(phone.selectionEnd).toBe(4);
  });

  it('keeps the caret after the inserted digits through React rendering', async () => {
    const { user, phone } = await setup('123456');
    await user.click(phone);
    phone.setSelectionRange(2, 4);
    await user.paste('9-0');
    expect(phone).toHaveValue('129056');
    expect(phone.selectionStart).toBe(4);
    await user.keyboard('7');
    expect(phone).toHaveValue('1290756');
  });

  it('does not sacrifice an unselected suffix when a full field has no room', async () => {
    const { user, phone } = await setup('1234567890');
    await user.click(phone);
    phone.setSelectionRange(3, 3);
    await user.paste('999');
    expect(phone).toHaveValue('1234567890');
    expect(phone.selectionStart).toBe(3);
    expect(phone.selectionEnd).toBe(3);
  });

  it('saves the sanitized ten-digit value', async () => {
    const { api, user, phone, onContinue } = await setup();
    await user.click(phone);
    await user.paste('(080) 123-4567');
    await user.click(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }));
    await user.click(screen.getByRole('button', { name: 'ถัดไป' }));
    await waitFor(() => expect(onContinue).toHaveBeenCalledOnce());
    expect(onContinue.mock.calls[0][0]).toMatchObject({ phone: '0801234567' });
    expect(await api.request<Patient[]>('/api/patients')).toContainEqual(expect.objectContaining({ phone: '0801234567' }));
  });

  it('rejects a short phone even when native form validation is bypassed', async () => {
    const { api, user, phone, onContinue } = await setup('123456789');
    const before = await api.request('/api/patients');
    await user.click(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }));
    fireEvent.submit(phone.closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('เบอร์โทรศัพท์ต้องเป็นตัวเลข 10 หลัก');
    expect(onContinue).not.toHaveBeenCalled();
    expect(await api.request('/api/patients')).toEqual(before);
  });
});

describe('legacy patient phone loading', () => {
  it.each(['loaded profile', 'initial profile', 'saved draft'] as const)('preserves a %s verbatim until the user edits it', async scenario => {
    const writes: string[] = [];
    const api: ApiClient = { async request<T>(path: string, init?: RequestInit): Promise<T> {
      if (init?.method) { writes.push(String(init.body)); throw new Error('Unexpected profile write'); }
      expect(path).toBe('/api/patients');
      return [legacy] as T;
    } };
    const onContinue = vi.fn();
    const onBack = vi.fn();
    const user = userEvent.setup();
    render(<PatientForm api={api} initial={scenario === 'initial profile' ? legacy : undefined} initialDraft={scenario === 'saved draft' ? { selected: legacy.id, fields: legacy, source: legacy } : undefined} onContinue={onContinue} onBack={onBack} />);
    const phone = await screen.findByDisplayValue(legacy.phone);
    await waitFor(() => expect(screen.getByRole('button', { name: 'ถัดไป' })).toBeEnabled());
    expect(phone).toHaveValue(legacy.phone);
    expect(writes).toEqual([]);
    await user.click(screen.getByRole('checkbox', { name: /ยืนยันอายุและสิทธิ์/ }));
    fireEvent.submit(phone.closest('form')!);
    expect(await screen.findByRole('alert')).toHaveTextContent('เบอร์โทรศัพท์ต้องเป็นตัวเลข 10 หลัก');
    expect(onContinue).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'ย้อนกลับ' }));
    expect(onBack).toHaveBeenCalledWith(expect.objectContaining({ fields: expect.objectContaining({ phone: legacy.phone }) }));
  });
});
