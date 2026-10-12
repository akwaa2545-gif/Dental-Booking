import { describe, expect, it } from 'vitest';
import { createDemoApi } from '../../src/demo/api';
import { createDemoClock } from '../../src/demo/clock';
import type { Patient } from '../../src/shared/contracts';
import { syntheticPatient } from '../support/fixtures';

const invalidPhones = ['123456789', '12345678901', '080-000-0000', '+66800000000', ' 0800000000 ', '0800000000\n', '๐๘๐๐๐๐๐๐๐๐', '０８００００００００'];
const makeApi = () => createDemoApi({ now: createDemoClock().now });

describe('demo patient phone writes', () => {
  it.each(invalidPhones)('rejects invalid phone %j without creating a profile', async phone => {
    const api = makeApi();
    const before = await api.request<Patient[]>('/api/patients');
    await expect(api.request('/api/patients', { method: 'POST', body: JSON.stringify({ ...syntheticPatient, phone }) })).rejects.toMatchObject({ code: 'VALIDATION', status: 400 });
    expect(await api.request('/api/patients')).toEqual(before);
  });

  it.each(invalidPhones)('rejects invalid phone %j without changing a profile or version', async phone => {
    const api = makeApi();
    const before = await api.request<Patient[]>('/api/patients');
    const patient = before[0];
    await expect(api.request(`/api/patients/${patient.id}`, { method: 'PATCH', body: JSON.stringify({ ...syntheticPatient, phone, version: patient.version }) })).rejects.toMatchObject({ code: 'VALIDATION', status: 400 });
    expect(await api.request('/api/patients')).toEqual(before);
  });

  it('creates and updates ten-digit phones without removing leading zeros', async () => {
    const api = makeApi();
    const created = await api.request<Patient>('/api/patients', { method: 'POST', body: JSON.stringify(syntheticPatient) });
    expect(created).toMatchObject({ phone: '0000000000', version: 1 });
    const updated = await api.request<Patient>(`/api/patients/${created.id}`, { method: 'PATCH', body: JSON.stringify({ ...syntheticPatient, phone: '0800000000', version: created.version }) });
    expect(updated).toMatchObject({ id: created.id, phone: '0800000000', version: 2 });
  });
});
