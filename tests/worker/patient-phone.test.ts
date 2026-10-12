// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createDatabase } from '../../src/worker/db';
import type { PatientInput } from '../../src/shared/contracts';
import { fixture, origin, session } from '../support/mock-line';

const id = '20000000-0000-4000-8000-000000000001';
const input: PatientInput = { fullName: 'Synthetic patient', phone: '0800000000', age: 42, address: 'Fictional address', relationship: 'self', authorizationAcknowledged: true };
const patient = { ...input, id, version: 1, ageCapturedOn: '2026-10-08' };
const invalidPhones = ['123456789', '12345678901', '080-000-0000', '+66800000000', ' 0800000000 ', '0800000000\n', '๐๘๐๐๐๐๐๐๐๐', '０８００００００００'];
function request(method: 'POST' | 'PATCH', phone: string) {
  return new Request(origin + '/api/patients' + (method === 'PATCH' ? `/${id}` : ''), {
    method,
    headers: { Cookie: '__Host-dental_session=' + 'o'.repeat(43), Origin: origin, 'X-CSRF-Token': 'csrf', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, phone, ...(method === 'PATCH' ? { version: 1 } : {}) }),
  });
}

describe.each(['POST', 'PATCH'] as const)('Worker %s patient phone validation', method => {
  it.each(invalidPhones)('rejects %j before the database port', async phone => {
    const { app, deps } = fixture();
    const create = vi.fn(async () => patient);
    const update = vi.fn(async () => ({ ...patient, version: 2 }));
    Object.assign(deps.db, { createPatient: create, updatePatient: update });
    const response = await app.fetch(request(method, phone));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION' } });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('accepts ten ASCII digits without normalization', async () => {
    const { app, deps } = fixture();
    const create = vi.fn(async () => patient);
    const update = vi.fn(async () => ({ ...patient, version: 2 }));
    Object.assign(deps.db, { createPatient: create, updatePatient: update });
    const response = await app.fetch(request(method, input.phone));
    expect(response.status).toBe(method === 'POST' ? 201 : 200);
    expect(await response.json()).toMatchObject({ phone: input.phone });
    if (method === 'POST') expect(create).toHaveBeenCalledWith(session.accountId, input);
    else expect(update).toHaveBeenCalledWith(session.accountId, id, 1, input);
  });
});

describe.each(['create', 'update'] as const)('database adapter %s patient phone validation', operation => {
  it.each(invalidPhones)('rejects %j before issuing SQL', async phone => {
    const query = vi.fn(async () => ({ rows: [{ result: patient }] }));
    const db = createDatabase({ query });
    const result = operation === 'create' ? db.createPatient(session.accountId, { ...input, phone }) : db.updatePatient(session.accountId, id, 1, { ...input, phone });
    await expect(result).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(query).not.toHaveBeenCalled();
  });
});
