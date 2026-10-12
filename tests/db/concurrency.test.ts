import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { Appointment, Patient, Service } from '../../src/shared/contracts';
import { booking, ReservationFixture, type ReservationOutcome } from '../support/reservation-postgres';

let fixture: ReservationFixture;
beforeAll(async () => { fixture = await ReservationFixture.create(); });
afterEach(async () => { await fixture?.reset(); });
afterAll(async () => { await fixture?.close(); });

const services: Service[] = ['oral_check', 'scaling', 'filling'];
const created = (outcome: ReservationOutcome): outcome is Extract<ReservationOutcome, { kind: 'created' }> => outcome.kind === 'created';

async function contenders(count: number): Promise<{ actor: string; patient: Patient }[]> {
  const people: { actor: string; patient: Patient }[] = [];
  for (let index = 0; index < count; index++) {
    const actor = await fixture.account();
    people.push({ actor, patient: await fixture.patient(actor) });
  }
  return people;
}

/** The gate releases only after all independent connections have been checked.
 * A server-side lock then proves each query is really in flight before release. */
async function competeForDate(date: string, locker: pg.Client) {
  const people = await contenders(20);
  const sessions = await Promise.all(people.map(() => fixture.session()));
  const backendConnectionIds = sessions.map(session => session.pid);
  expect(new Set(backendConnectionIds).size).toBe(20);
  expect(sessions.map(session => session.role)).toEqual(Array(20).fill('dental_backend'));
  let start!: () => void;
  const barrier = new Promise<void>(resolve => { start = resolve; });
  const attempts = sessions.map(async (session, index) => {
    await barrier;
    return fixture.attempt(session, people[index].actor, randomUUID(), booking(people[index].patient, date, services[index % services.length]));
  });
  start();
  let waitFailure: unknown;
  try { await fixture.waitForLockWaiters(backendConnectionIds); }
  catch (error) { waitFailure = error; }
  finally { await fixture.unlock(locker); }
  const outcomes = await Promise.all(attempts);
  if (waitFailure) throw waitFailure;
  return { backendConnectionIds, outcomes };
}

// Removing the date lock, omitting the upsert for an absent date, serializing
// only by date rather than key, or caching time before a lock must fail these.
describe('real PostgreSQL reservation concurrency', () => {
  it('twenty_postgres_clients_compete_for_one_place across mixed services', async () => {
    const date = '2026-10-09';
    for (const [index, person] of (await contenders(2)).entries()) {
      const appointment = await fixture.reserve(person.actor, randomUUID(), booking(person.patient, date, services[index]));
      if (index === 1) await fixture.control.query("update dental.appointments set status = 'approved', version = 2, approved_at = dental.clock_now() where id = $1", [appointment.id]);
    }
    expect(await fixture.count(date)).toBe(2);
    const { backendConnectionIds, outcomes } = await competeForDate(date, await fixture.lockDate(date));
    const createdCount = outcomes.filter(created).length;
    const full = outcomes.filter(outcome => outcome.kind === 'error' && outcome.code === 'FULL' && outcome.sqlState === 'P0001').length;
    const activeCount = await fixture.count(date);
    expect(createdCount).toBe(1);
    expect(full).toBe(19);
    expect(activeCount).toBe(3);
    expect(new Set(backendConnectionIds).size).toBe(20);
    console.info(JSON.stringify({ test: 'twenty_postgres_clients_compete_for_one_place', backendConnectionIds, observedLockWaiters: 20, created: createdCount, full, activeCount }));
  });

  it('creates one missing date row while twenty independent sessions compete for three places', async () => {
    const date = '2026-10-12';
    expect((await fixture.control.query('select count(*)::integer as count from dental.clinic_dates where date = $1::date', [date])).rows[0].count).toBe(0);
    // An absent date cannot already have two bookings because of the FK. Start
    // from zero, block INSERTs behind a table barrier, and expect exactly three.
    const { backendConnectionIds, outcomes } = await competeForDate(date, await fixture.lockMissingDateInsert());
    const createdCount = outcomes.filter(created).length;
    const full = outcomes.filter(outcome => outcome.kind === 'error' && outcome.code === 'FULL' && outcome.sqlState === 'P0001').length;
    const activeCount = await fixture.count(date);
    expect(createdCount).toBe(3);
    expect(full).toBe(17);
    expect(activeCount).toBe(3);
    expect((await fixture.control.query('select count(*)::integer as count from dental.clinic_dates where date = $1::date', [date])).rows[0].count).toBe(1);
    console.info(JSON.stringify({ test: 'twenty_postgres_clients_create_missing_date', backendConnectionIds, observedLockWaiters: 20, created: createdCount, full, activeCount, dateRows: 1 }));
  });

  it('serializes the same key before different date locks and creates only the winning payload', async () => {
    const [{ actor, patient }] = await contenders(1);
    const key = randomUUID();
    const firstDate = '2026-10-09';
    const secondDate = '2026-10-12';
    await fixture.date(firstDate);
    await fixture.date(secondDate);
    const sessions = await Promise.all([fixture.session(), fixture.session()]);
    expect(sessions[0].pid).not.toBe(sessions[1].pid);
    const locker = await fixture.lockDate(firstDate);
    const firstAttempt = fixture.attempt(sessions[0], actor, key, booking(patient, firstDate));
    let secondAttempt: Promise<ReservationOutcome> | undefined;
    let waitFailure: unknown;
    try {
      await fixture.waitForLockWaiters([sessions[0].pid]);
      secondAttempt = fixture.attempt(sessions[1], actor, key, booking(patient, secondDate, 'filling'));
      // B must wait on A's submission key, despite targeting another date.
      await fixture.waitForLockWaiters([sessions[1].pid], sessions[0].pid);
    } catch (error) { waitFailure = error; }
    finally { await fixture.unlock(locker); }
    const first = await firstAttempt;
    const second = secondAttempt ? await secondAttempt : undefined;
    if (waitFailure) throw waitFailure;
    expect(first.kind).toBe('created');
    expect(second).toEqual({ kind: 'error', code: 'IDEMPOTENCY_CONFLICT', sqlState: 'P0001' });
    expect(await fixture.count(firstDate)).toBe(1);
    expect(await fixture.count(secondDate)).toBe(0);
    expect((await fixture.control.query('select count(*)::integer as count from dental.submission_keys where owner_account_id = $1 and key = $2', [actor, key])).rows[0].count).toBe(1);
    if (!created(first)) throw new Error('The first reservation did not commit.');
    expect(await fixture.call<Appointment>('select dental.submission($1, $2) as result', [actor, key])).toEqual(first.appointment);
  });

  it('returns exactly one committed appointment to concurrent identical-key retries', async () => {
    const [{ actor, patient }] = await contenders(1);
    const key = randomUUID();
    const input = booking(patient);
    await fixture.date(input.date);
    const sessions = await Promise.all([fixture.session(), fixture.session()]);
    const locker = await fixture.lockDate(input.date);
    const firstAttempt = fixture.attempt(sessions[0], actor, key, input);
    let retryAttempt: Promise<ReservationOutcome> | undefined;
    let waitFailure: unknown;
    try {
      await fixture.waitForLockWaiters([sessions[0].pid]);
      retryAttempt = fixture.attempt(sessions[1], actor, key, input);
      await fixture.waitForLockWaiters([sessions[1].pid], sessions[0].pid);
    } catch (error) { waitFailure = error; }
    finally { await fixture.unlock(locker); }
    const first = await firstAttempt;
    const retry = retryAttempt ? await retryAttempt : undefined;
    if (waitFailure) throw waitFailure;
    expect(first.kind).toBe('created');
    expect(retry).toEqual(first);
    expect(await fixture.count(input.date)).toBe(1);
  });

  it('rechecks Bangkok midnight after an observed date-lock wait', async () => {
    await fixture.setClock('2026-10-08T16:59:59.999Z');
    const [{ actor, patient }] = await contenders(1);
    const date = '2026-10-09';
    const key = randomUUID();
    await fixture.date(date);
    const session = await fixture.session();
    const locker = await fixture.lockDate(date);
    const attempt = fixture.attempt(session, actor, key, booking(patient, date));
    let waitFailure: unknown;
    try {
      await fixture.waitForLockWaiters([session.pid]);
      // Committed on a different session while the request remains blocked.
      await fixture.setClock('2026-10-08T17:00:00.000Z');
    } catch (error) { waitFailure = error; }
    finally { await fixture.unlock(locker); }
    const outcome = await attempt;
    if (waitFailure) throw waitFailure;
    expect(outcome).toEqual({ kind: 'error', code: 'INELIGIBLE_DATE', sqlState: 'P0001' });
    expect(await fixture.count(date)).toBe(0);
    expect(await fixture.call('select dental.submission($1, $2) as result', [actor, key])).toBeNull();
    console.info(JSON.stringify({ test: 'date_lock_cutoff_recheck', backendConnectionIds: [session.pid], observedLockWaiters: 1, outcome: 'INELIGIBLE_DATE', activeCount: 0 }));
  });

  it('rechecks Bangkok midnight after waiting on the patient snapshot lock', async () => {
    await fixture.setClock('2026-10-08T16:59:59.999Z');
    const [{ actor, patient }] = await contenders(1);
    const date = '2026-10-09';
    await fixture.date(date);
    const session = await fixture.session();
    const locker = await fixture.lockPatient(patient.id);
    const attempt = fixture.attempt(session, actor, randomUUID(), booking(patient, date));
    let waitFailure: unknown;
    try {
      await fixture.waitForLockWaiters([session.pid]);
      await fixture.setClock('2026-10-08T17:00:00.000Z');
    } catch (error) { waitFailure = error; }
    finally { await fixture.unlock(locker); }
    const outcome = await attempt;
    if (waitFailure) throw waitFailure;
    expect(outcome).toEqual({ kind: 'error', code: 'INELIGIBLE_DATE', sqlState: 'P0001' });
    expect(await fixture.count(date)).toBe(0);
    console.info(JSON.stringify({ test: 'patient_lock_cutoff_recheck', backendConnectionIds: [session.pid], observedLockWaiters: 1, outcome: 'INELIGIBLE_DATE', activeCount: 0 }));
  });

  it('validates the profile version after a concurrent edit releases its lock', async () => {
    const [{ actor, patient }] = await contenders(1);
    const date = '2026-10-09';
    await fixture.date(date);
    const session = await fixture.session();
    const locker = await fixture.lockPatient(patient.id);
    await locker.query('update dental.patients set age = age + 1, version = version + 1, updated_at = dental.clock_now() where id = $1', [patient.id]);
    const attempt = fixture.attempt(session, actor, randomUUID(), booking(patient, date));
    let waitFailure: unknown;
    try { await fixture.waitForLockWaiters([session.pid]); }
    catch (error) { waitFailure = error; }
    finally { await fixture.unlock(locker, 'commit'); }
    const outcome = await attempt;
    if (waitFailure) throw waitFailure;
    expect(outcome).toEqual({ kind: 'error', code: 'VERSION_CONFLICT', sqlState: 'P0001' });
    expect(await fixture.count(date)).toBe(0);
    expect((await fixture.control.query('select version from dental.patients where id = $1', [patient.id])).rows[0].version).toBe(2);
  });
});
