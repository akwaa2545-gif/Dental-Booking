import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Appointment, BookingInput, Patient } from '../../src/shared/contracts';
import { syntheticPatient } from '../support/fixtures';
import { booking, ReservationFixture } from '../support/reservation-postgres';

let fixture: ReservationFixture;
let actor: string;
let otherActor: string;
let patient: Patient;

beforeAll(async () => { fixture = await ReservationFixture.create(); });
beforeEach(async () => {
  actor = await fixture.account();
  otherActor = await fixture.account();
  patient = await fixture.patient(actor);
});
afterEach(async () => { await fixture?.reset(); });
afterAll(async () => { await fixture?.close(); });

const reserve = (input = booking(patient), key = randomUUID(), account = actor) => fixture.reserve(account, key, input);
const domainFailure = (code: string) => ({ code: 'P0001', message: code });

// Regression targets: range endpoints or Bangkok date arithmetic, missing key
// serialization, service-scoped capacity, skipped ownership/version checks, and
// incomplete reservation transactions must each break a behavioral assertion.
describe('real PostgreSQL reservation rules', () => {
  it.each(['2026-10-09', '2027-01-06'])('accepts the open tomorrow/+90 endpoint %s', async date => {
    const result = await reserve(booking(patient, date));
    expect(result).toMatchObject({ patientId: patient.id, date, service: 'oral_check', status: 'pending', version: 1, approvedAt: null });
    expect(result.patient).toEqual(syntheticPatient);
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.reference).toMatch(/^D-/);
  });

  it.each(['2026-10-08', '2027-01-07', '2026-10-10', '2026-10-11'])('rejects today/+91/weekend %s', async date => {
    await expect(reserve(booking(patient, date))).rejects.toMatchObject(domainFailure('INELIGIBLE_DATE'));
    expect(await fixture.count(date)).toBe(0);
  });

  it.each(['paused', 'closed'] as const)('rejects an otherwise eligible %s date', async intake => {
    await fixture.date('2026-10-09', intake);
    await expect(reserve()).rejects.toMatchObject(domainFailure('INTAKE_CLOSED'));
  });

  it('crosses the year with calendar-day arithmetic in Bangkok, independent of session timezone', async () => {
    await fixture.setClock('2026-12-31T05:00:00Z');
    const nextDay = await reserve(booking(patient, '2027-01-01'));
    const day90 = await reserve(booking(patient, '2027-03-31'));
    expect(nextDay.date).toBe('2027-01-01');
    expect(day90.date).toBe('2027-03-31');
    await expect(reserve(booking(patient, '2026-12-31'))).rejects.toMatchObject(domainFailure('INELIGIBLE_DATE'));
    await expect(reserve(booking(patient, '2027-04-01'))).rejects.toMatchObject(domainFailure('INELIGIBLE_DATE'));
  });

  it('changes tomorrow eligibility at Bangkok midnight rather than UTC midnight', async () => {
    await fixture.setClock('2026-10-08T16:59:59.999Z');
    await expect(fixture.availability('2026-10-09', '2026-10-09')).resolves.toEqual([{ date: '2026-10-09', state: 'available' }]);
    await fixture.setClock('2026-10-08T17:00:00.000Z');
    await expect(reserve()).rejects.toMatchObject(domainFailure('INELIGIBLE_DATE'));
    await expect(fixture.availability('2026-10-09', '2026-10-09')).resolves.toEqual([{ date: '2026-10-09', state: 'ineligible' }]);
  });

  it('returns one persisted result for one key and semantically identical JSON payload', async () => {
    const key = randomUUID();
    const input = booking(patient);
    const first = await reserve(input, key);
    const reordered: BookingInput = { authorizationAcknowledged: true, ageConfirmed: input.ageConfirmed, date: input.date, service: input.service, patientVersion: input.patientVersion, patientId: input.patientId };
    expect(await reserve(reordered, key)).toEqual(first);
    const { rows: [counts] } = await fixture.control.query(`
      select (select count(*)::integer from dental.appointments where owner_account_id = $1) as appointments,
        (select count(*)::integer from dental.submission_keys where owner_account_id = $1) as keys,
        (select count(*)::integer from dental.audit_events where appointment_id = $2) as audits
    `, [actor, first.id]);
    expect(counts).toEqual({ appointments: 1, keys: 1, audits: 1 });
  });

  it.each([
    { service: 'filling' as const },
    { date: '2026-10-12' },
  ])('rejects a reused key with changed payload %j', async change => {
    const key = randomUUID();
    const input = booking(patient);
    const first = await reserve(input, key);
    await expect(reserve({ ...input, ...change }, key)).rejects.toMatchObject(domainFailure('IDEMPOTENCY_CONFLICT'));
    expect(await fixture.call<Appointment>('select dental.submission($1, $2) as result', [actor, key])).toEqual(first);
    expect(await fixture.count('2026-10-12')).toBe(0);
  });

  it('replays the original response after the appointment changes status and the date expires', async () => {
    const key = randomUUID();
    const input = booking(patient);
    const first = await reserve(input, key);
    await fixture.control.query("update dental.appointments set status = 'cancelled', version = 2, cancelled_at = dental.clock_now(), cancelled_by = $2 where id = $1", [first.id, actor]);
    await fixture.setClock('2026-10-09T17:00:00Z');
    expect(await reserve(input, key)).toEqual(first);
    expect(await fixture.call<Appointment>('select dental.submission($1, $2) as result', [actor, key])).toEqual(first);
    expect(await fixture.call<Appointment>('select dental.get_appointment($1, $2) as result', [actor, first.id])).toMatchObject({ id: first.id, status: 'cancelled', version: 2 });
  });

  it('recovers a committed result after losing its response without exposing it to another account', async () => {
    const key = randomUUID();
    await reserve(booking(patient), key); // Discard the response, as if the network lost it after COMMIT.
    const recovered = await fixture.call<Appointment>('select dental.submission($1, $2) as result', [actor, key]);
    expect(recovered).toMatchObject({ patientId: patient.id, status: 'pending' });
    expect(await reserve(booking(patient), key)).toEqual(recovered);
    expect(await fixture.call('select dental.submission($1, $2) as result', [otherActor, key])).toBeNull();
    expect(await fixture.call('select dental.submission($1, $2) as result', [actor, randomUUID()])).toBeNull();
    expect(await fixture.count('2026-10-09')).toBe(1);
  });

  it('scopes the same idempotency key to its authenticated account', async () => {
    const key = randomUUID();
    const otherPatient = await fixture.patient(otherActor);
    const first = await reserve(booking(patient), key);
    const second = await reserve(booking(otherPatient), key, otherActor);
    expect(second.id).not.toBe(first.id);
    expect(await fixture.count('2026-10-09')).toBe(2);
  });

  it('rejects an active patient/date duplicate even when service and key differ', async () => {
    await reserve();
    await expect(reserve(booking(patient, '2026-10-09', 'filling'))).rejects.toMatchObject(domainFailure('DUPLICATE'));
    expect(await fixture.count('2026-10-09')).toBe(1);
  });

  it('counts distinct family profiles separately even with identical names and phones', async () => {
    const family = [patient, await fixture.patient(actor), await fixture.patient(actor)];
    const appointments = await Promise.all(family.map((profile, index) => reserve(booking(profile, '2026-10-09', ['oral_check', 'scaling', 'filling'][index] as BookingInput['service']))));
    expect(new Set(appointments.map(item => item.patientId)).size).toBe(3);
    const fourth = await fixture.patient(actor);
    await expect(reserve(booking(fourth))).rejects.toMatchObject(domainFailure('FULL'));
    expect(await fixture.count('2026-10-09')).toBe(3);
  });

  it.each(['cancelled', 'rejected'] as const)('counts pending and approved together while a %s booking releases its place', async releasedStatus => {
    const profiles = [patient, await fixture.patient(actor), await fixture.patient(actor), await fixture.patient(actor)];
    const pending = await reserve(booking(profiles[0]));
    const approved = await reserve(booking(profiles[1]));
    await fixture.control.query("update dental.appointments set status = 'approved', version = 2, approved_at = dental.clock_now() where id = $1", [approved.id]);
    await reserve(booking(profiles[2]));
    await expect(reserve(booking(profiles[3]))).rejects.toMatchObject(domainFailure('FULL'));
    if (releasedStatus === 'cancelled') {
      await fixture.control.query("update dental.appointments set status = 'cancelled', version = 2, cancelled_at = dental.clock_now(), cancelled_by = $2 where id = $1", [pending.id, actor]);
    } else {
      await fixture.control.query("update dental.appointments set status = 'rejected', version = 2 where id = $1", [pending.id]);
    }
    await expect(reserve(booking(profiles[3]))).resolves.toMatchObject({ status: 'pending' });
    expect(await fixture.count('2026-10-09')).toBe(3);
  });

  it('keeps ownership errors indistinguishable for foreign and absent profiles', async () => {
    for (const patientId of [patient.id, randomUUID()]) {
      await expect(reserve({ ...booking(patient), patientId }, randomUUID(), otherActor)).rejects.toMatchObject(domainFailure('NOT_FOUND'));
    }
  });

  it('rejects unknown actors and stale profile versions or age confirmations', async () => {
    await expect(reserve(booking(patient), randomUUID(), randomUUID())).rejects.toMatchObject(domainFailure('UNAUTHENTICATED'));
    await expect(reserve({ ...booking(patient), patientVersion: 2 })).rejects.toMatchObject(domainFailure('VERSION_CONFLICT'));
    await expect(reserve({ ...booking(patient), ageConfirmed: patient.age + 1 })).rejects.toMatchObject(domainFailure('VERSION_CONFLICT'));
  });

  it.each([
    { authorizationAcknowledged: false },
    { actor: 'forged' },
    { service: 'unrecognized' },
    { patientVersion: 1.5 },
    { ageConfirmed: 42.5 },
    { date: '2026-02-30' },
    { date: '2026-10-09T00:00:00Z' },
  ])('validates direct SQL payloads %j', async change => {
    await fixture.date('2026-10-09');
    const input = { ...booking(patient), ...change } as BookingInput;
    // Track only the valid date: malformed input must not insert any date row.
    await expect(fixture.call('select dental.reserve($1, $2, $3::jsonb) as result', [actor, randomUUID(), input])).rejects.toMatchObject(domainFailure('VALIDATION'));
  });

  it('rolls back a rejected reservation without leaving a claimed key, appointment, or audit', async () => {
    const key = randomUUID();
    await fixture.date('2026-10-09', 'closed');
    await expect(reserve(booking(patient), key)).rejects.toMatchObject(domainFailure('INTAKE_CLOSED'));
    const { rows: [counts] } = await fixture.control.query(`
      select (select count(*)::integer from dental.submission_keys where owner_account_id = $1 and key = $2) as keys,
        (select count(*)::integer from dental.appointments where owner_account_id = $1) as appointments,
        (select count(*)::integer from dental.audit_events where actor_account_id = $1 and appointment_id is not null) as audits
    `, [actor, key]);
    expect(counts).toEqual({ keys: 0, appointments: 0, audits: 0 });
    await fixture.date('2026-10-09', 'open');
    await expect(reserve(booking(patient), key)).resolves.toMatchObject({ status: 'pending' });
  });

  it('captures the current immutable patient snapshot, Bangkok date, and exact cancellation cutoff', async () => {
    const result = await reserve();
    await fixture.call('select dental.update_patient($1, $2, $3, $4::jsonb) as result', [actor, patient.id, patient.version, { ...syntheticPatient, age: 43 }]);
    expect(result.patient).toEqual(syntheticPatient);
    expect(Date.parse(result.cancelBefore)).toBe(Date.parse('2026-10-08T17:00:00Z'));
    const { rows: [snapshot] } = await fixture.control.query('select patient_snapshot, age_captured_on::text, patient_version from dental.appointments where id = $1', [result.id]);
    expect(snapshot).toEqual({ patient_snapshot: syntheticPatient, age_captured_on: '2026-10-08', patient_version: 1 });
    expect(await fixture.call<Appointment>('select dental.get_appointment($1, $2) as result', [actor, result.id])).toEqual(result);
  });

  it('lists only owned appointments and hides foreign and missing detail IDs alike', async () => {
    const owned = await reserve();
    const otherPatient = await fixture.patient(otherActor);
    const foreign = await reserve(booking(otherPatient), randomUUID(), otherActor);
    expect(await fixture.call<Appointment[]>('select dental.list_appointments($1) as result', [actor])).toEqual([owned]);
    for (const id of [foreign.id, randomUUID()]) {
      await expect(fixture.call('select dental.get_appointment($1, $2) as result', [actor, id])).rejects.toMatchObject(domainFailure('NOT_FOUND'));
    }
  });

  it('rejects higher isolation levels rather than counting a stale transaction snapshot', async () => {
    const session = await fixture.session();
    try {
      await session.client.query('rollback; begin isolation level repeatable read; set local role dental_backend');
      await expect(session.client.query('select dental.reserve($1, $2, $3::jsonb)', [actor, randomUUID(), booking(patient)])).rejects.toMatchObject(domainFailure('UNAVAILABLE'));
    } finally { await fixture.closeSession(session); }
  });
});

describe('real PostgreSQL privacy-safe availability', () => {
  it('returns only ordered dates and states without creating clinic rows', async () => {
    expect(await fixture.availability('2026-10-08', '2026-10-12')).toEqual([
      { date: '2026-10-08', state: 'ineligible' },
      { date: '2026-10-09', state: 'available' },
      { date: '2026-10-10', state: 'ineligible' },
      { date: '2026-10-11', state: 'ineligible' },
      { date: '2026-10-12', state: 'available' },
    ]);
    expect((await fixture.control.query('select count(*)::integer as count from dental.clinic_dates')).rows[0].count).toBe(0);
  });

  it('prioritizes ineligible before closed/paused before full before available', async () => {
    await fixture.date('2026-10-08', 'closed');
    await fixture.date('2026-10-10', 'paused');
    await fixture.date('2026-10-12', 'closed');
    await fixture.date('2026-10-13', 'paused');
    for (const profile of [patient, await fixture.patient(actor), await fixture.patient(actor)]) await reserve(booking(profile));
    await expect(fixture.availability('2026-10-08', '2026-10-14')).resolves.toEqual([
      { date: '2026-10-08', state: 'ineligible' },
      { date: '2026-10-09', state: 'full' },
      { date: '2026-10-10', state: 'ineligible' },
      { date: '2026-10-11', state: 'ineligible' },
      { date: '2026-10-12', state: 'closed' },
      { date: '2026-10-13', state: 'paused' },
      { date: '2026-10-14', state: 'available' },
    ]);
    await fixture.date('2026-10-09', 'paused');
    expect(await fixture.availability('2026-10-09', '2026-10-09')).toEqual([{ date: '2026-10-09', state: 'paused' }]);
    await fixture.date('2026-10-09', 'closed');
    expect(await fixture.availability('2026-10-09', '2026-10-09')).toEqual([{ date: '2026-10-09', state: 'closed' }]);
  });

  it('bounds the public availability query and rejects reversed ranges', async () => {
    await expect(fixture.availability('2026-10-09', '2026-10-08')).rejects.toMatchObject(domainFailure('VALIDATION'));
    await expect(fixture.availability('2026-10-08', '2027-01-08')).rejects.toMatchObject(domainFailure('VALIDATION'));
  });
});
