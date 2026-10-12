import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Appointment } from '../../src/shared/contracts';
import { booking, ReservationFixture } from '../support/reservation-postgres';

type Event = { id: string; appointmentId: string; appointmentVersion: number; type: 'approval' | 'rejection' | 'reminder'; retryKey: string; dueAt: string; expiresAt: string };
type Prepared = { event: Event; recipient: string; date: string; reference: string; status: string; manageUrl: string; payloadVersion: 1 };
let fixture: ReservationFixture, owner: string, admin: string;
const actors: string[] = [];
const provider = 'line:1234567890', origin = 'https://clinic.example', day = '2026-10-09';
const worker = () => randomUUID();
const subjectOf = (account: string) => `U${account.replaceAll('-', '')}`;
const eventId = () => `01${randomUUID().replaceAll('-', '').slice(0, 24).toUpperCase()}`;
const claim = (id: string, limit = 10) => fixture.call<Event[]>('select dental.claim_events($1,$2) as result', [id, limit]);
const prepare = (id: string, event: Event, manageOrigin = origin) => fixture.call<Prepared | null>('select dental.prepare_dispatch($1,$2,$3) as result', [id, event.id, manageOrigin]);
const finish = (id: string, event: Event, result: unknown) => fixture.call<boolean>('select dental.finish_dispatch($1,$2,$3::jsonb) as result', [id, event.id, result]);
const reachability = (reachable: boolean, at = '2026-10-08T04:59:59Z', subject = owner, namespace = provider, webhookId = eventId()) => fixture.call<boolean>(
  'select dental.record_line_reachability($1,$2,$3,$4::timestamptz,$5) as result', [namespace, subjectOf(subject), webhookId, at, reachable]);
const reserve = async () => fixture.reserve(owner, randomUUID(), booking(await fixture.patient(owner), day));
const decide = (appointment: Appointment, decision = 'approve') => fixture.call<Appointment>('select dental.decide($1,$2,$3,$4,$5) as result', [admin, appointment.id, appointment.version, decision, 'Synthetic review']);
const approve = async () => decide(await reserve());
const cancel = (appointment: Appointment) => fixture.call<Appointment>('select dental.cancel($1,$2,$3) as result', [owner, appointment.id, appointment.version]);
const state = async (event: Event) => (await fixture.control.query("select *,to_char(appointment_date,'YYYY-MM-DD') as appointment_date from dental.outbox where id=$1", [event.id])).rows[0];

describe('durable private PostgreSQL notification outbox', () => {
  beforeAll(async () => {
    fixture = await ReservationFixture.create();
    for (const signature of ['claim_events(uuid,integer)', 'prepare_dispatch(uuid,uuid,text)', 'finish_dispatch(uuid,uuid,jsonb)', 'record_line_reachability(text,text,text,timestamptz,boolean)']) {
      expect((await fixture.control.query('select to_regprocedure($1) is not null as present', [`dental.${signature}`])).rows[0].present,
        `Separately reviewed Task 8 migration must already be applied: ${signature}`).toBe(true);
    }
  });
  beforeEach(async () => {
    owner = await fixture.account(); admin = await fixture.account(); actors.push(owner, admin);
    await fixture.control.query('update dental.accounts set provider=$2,subject=$3 where id=$1', [owner, provider, subjectOf(owner)]);
    await fixture.control.query('insert into dental.admin_grants(account_id) values($1)', [admin]);
    await reachability(true);
  });
  afterEach(async () => {
    if (!fixture) return;
    // Each race closes its own transactions in finally before child cleanup.
    await fixture.control.query('delete from dental.notification_attempts where outbox_id in (select o.id from dental.outbox o join dental.appointments a on a.id=o.appointment_id where a.owner_account_id=any($1::uuid[]))', [actors]);
    await fixture.control.query('delete from dental.outbox where appointment_id in (select id from dental.appointments where owner_account_id=any($1::uuid[]))', [actors]);
    await fixture.control.query('delete from dental.line_webhook_events where subject=any($1::text[])', [actors.map(subjectOf)]);
    await fixture.control.query('delete from dental.line_reachability where subject=any($1::text[])', [actors.map(subjectOf)]);
    await fixture.control.query('delete from dental.admin_grants where account_id=any($1::uuid[])', [actors]);
    await fixture.reset(); actors.length = 0;
  });
  afterAll(async () => { await fixture?.close(); });

  // This suite uses real independent PostgreSQL connections and a guarded,
  // separately approved disposable target. It never applies migrations itself.
  it('commits decision, unique logical event, stable retry UUID and immutable date together', async () => {
    const pending = await reserve(), session = await fixture.session();
    try {
      await session.client.query('select dental.decide($1,$2,1,$3,$4)', [admin, pending.id, 'approve', 'Synthetic review']);
      await session.client.query('rollback');
    } finally { await fixture.closeSession(session); }
    expect((await fixture.control.query('select count(*)::integer as count from dental.outbox')).rows[0].count).toBe(0);
    const approved = await decide(pending), id = worker(), events = await claim(id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ appointmentId: approved.id, appointmentVersion: 2, type: 'approval' });
    expect(String((await state(events[0])).appointment_date)).toBe(day);
    expect(await claim(worker())).toEqual([]);
    const duplicate = fixture.control.query(`insert into dental.outbox(appointment_id,appointment_version,type,due_at,expires_at)
      values($1,2,'approval','2026-10-08T05:00:00Z','2026-10-08T06:00:00Z')`, [approved.id]);
    await expect(duplicate).rejects.toMatchObject({ code: '23505' });
  });

  it('uses SKIP LOCKED to give competing committed claims disjoint events', async () => {
    await approve(); await approve();
    const a = await fixture.session(), b = await fixture.session();
    try {
      expect(a.pid).not.toBe(b.pid);
      const first = (await a.client.query('select dental.claim_events($1,1) as result', [worker()])).rows[0].result as Event[];
      const second = (await b.client.query('select dental.claim_events($1,1) as result', [worker()])).rows[0].result as Event[];
      expect(first).toHaveLength(1); expect(second).toHaveLength(1); expect(first[0].id).not.toBe(second[0].id);
      await a.client.query('commit'); await b.client.query('commit');
    } finally { await fixture.closeSession(a); await fixture.closeSession(b); }
  });

  it('suppresses cancelled work before its final check and never consumes a send attempt', async () => {
    const appointment = await approve(), id = worker(), [event] = await claim(id);
    await cancel(appointment);
    expect(await prepare(id, event)).toBeNull();
    expect(await state(event)).toMatchObject({ state: 'suppressed', attempt_count: 0, lease_owner: null });
  });

  it('suppresses a leased reminder when a competing cancellation commits before the final check', async () => {
    const appointment = await approve(), first = worker(), [approval] = await claim(first);
    await prepare(first, approval); await finish(first, approval, { kind: 'accepted' });
    await fixture.setClock('2026-10-08T11:00:00Z'); const id = worker(), [reminder] = await claim(id);
    expect(reminder.type).toBe('reminder');
    const locker = await fixture.lockDate(day), session = await fixture.session();
    let released = false;
    try {
      await locker.query('set local role dental_backend');
      // Keep date, appointment and outbox cancellation writes uncommitted.
      await locker.query('select dental.cancel($1,$2,$3)', [owner, appointment.id, appointment.version]);
      const pending = session.client.query('select dental.prepare_dispatch($1,$2,$3) as result', [id, reminder.id, origin]);
      await fixture.waitForLockWaiters([session.pid]);
      await fixture.unlock(locker, 'commit'); released = true;
      expect((await pending).rows[0].result).toBeNull();
      await session.client.query('commit');
    } finally {
      if (!released) await fixture.unlock(locker);
      await fixture.closeSession(session);
    }
    expect(await state(reminder)).toMatchObject({ state: 'suppressed', attempt_count: 0 });
    expect((await fixture.control.query('select id from dental.notification_attempts where outbox_id=$1', [reminder.id])).rows).toEqual([]);
    expect((await fixture.call<Appointment>('select dental.get_appointment($1,$2) as result', [owner, appointment.id])).status).toBe('cancelled');
  });

  it('rechecks appointment-midnight expiry after a blocked final eligibility check', async () => {
    await approve(); const first = worker(), [approval] = await claim(first); await prepare(first, approval); await finish(first, approval, { kind: 'accepted' });
    await fixture.setClock('2026-10-08T16:59:30Z'); const id = worker(), [reminder] = await claim(id);
    const locker = await fixture.lockDate(day), session = await fixture.session();
    const pending = session.client.query('select dental.prepare_dispatch($1,$2,$3) as result', [id, reminder.id, origin]);
    try { await fixture.waitForLockWaiters([session.pid]); await fixture.setClock('2026-10-08T17:00:00Z'); }
    finally { await fixture.unlock(locker); }
    try { expect((await pending).rows[0].result).toBeNull(); await session.client.query('commit'); }
    finally { await fixture.closeSession(session); }
    expect(await state(reminder)).toMatchObject({ state: 'suppressed', attempt_count: 0 });
  });

  it('rechecks lease time after waiting for the date lock', async () => {
    await approve(); const id = worker(), [event] = await claim(id), locker = await fixture.lockDate(day), session = await fixture.session();
    const pending = session.client.query('select dental.prepare_dispatch($1,$2,$3) as result', [id, event.id, origin]);
    try {
      await fixture.waitForLockWaiters([session.pid]); await fixture.setClock('2026-10-08T05:01:00Z');
    } finally { await fixture.unlock(locker); }
    try { expect((await pending).rows[0].result).toBeNull(); }
    finally { await fixture.closeSession(session); }
    expect((await state(event)).attempt_count).toBe(0);
  });

  it('suppresses stale appointment versions and dates at final dispatch', async () => {
    await approve(); const id = worker(), [event] = await claim(id);
    await fixture.control.query('update dental.appointments set version=version+1 where id=$1', [event.appointmentId]);
    expect(await prepare(id, event)).toBeNull();
    expect((await state(event)).state).toBe('suppressed');
    await approve(); const another = worker(), [nextEvent] = await claim(another);
    await fixture.date('2026-10-12');
    await fixture.control.query("update dental.outbox set appointment_date='2026-10-12' where id=$1", [nextEvent.id]);
    expect(await prepare(another, nextEvent)).toBeNull();
    expect((await state(nextEvent)).state).toBe('suppressed');
  });

  it.each(['2026-10-08T11:00:00Z', '2026-10-08T14:00:00Z'])('catches up the due reminder at %s but not before 18:00 Bangkok', async now => {
    await approve(); let id = worker(); const [approval] = await claim(id); await prepare(id, approval); await finish(id, approval, { kind: 'accepted' });
    await fixture.setClock('2026-10-08T10:59:59.999Z'); expect(await claim(worker())).toEqual([]);
    await fixture.setClock(now); id = worker(); const [reminder] = await claim(id);
    expect(reminder.type).toBe('reminder');
    expect(await prepare(id, reminder)).toMatchObject({ date: day, status: 'approved' });
  });

  it('never sends a prior-day reminder from appointment-day midnight onward', async () => {
    await approve(); await fixture.setClock('2026-10-08T17:00:00Z');
    const events = await claim(worker()); expect(events.every(event => event.type !== 'reminder')).toBe(true);
    expect((await fixture.control.query("select state from dental.outbox where type='reminder'")).rows).toEqual([{ state: 'suppressed' }]);
  });

  it('keeps the established strict approval cutoff: pending at 18:00 gets confirmation only', async () => {
    const pending = await reserve(); await fixture.setClock('2026-10-08T11:00:00Z'); await decide(pending);
    expect((await fixture.control.query('select type from dental.outbox')).rows).toEqual([{ type: 'approval' }]);
  });

  it('freezes recipient, V1 payload input and retry key across uncertain acceptance and changed configuration', async () => {
    await approve(); const firstWorker = worker(), [event] = await claim(firstWorker), first = await prepare(firstWorker, event);
    expect(first).toMatchObject({ recipient: subjectOf(owner), date: day, status: 'approved', manageUrl: `${origin}/appointments`, payloadVersion: 1 });
    expect(await prepare(firstWorker, event)).toBeNull(); // Same claim cannot start another send.
    await fixture.control.query('update dental.accounts set subject=$2 where id=$1', [owner, subjectOf(randomUUID())]);
    await fixture.setClock('2026-10-08T05:01:00Z'); expect(await claim(worker())).toEqual([]);
    await fixture.setClock('2026-10-08T05:02:00Z'); const secondWorker = worker(), [retried] = await claim(secondWorker);
    const second = await prepare(secondWorker, retried, 'https://changed.example');
    expect(retried.retryKey).toBe(event.retryKey);
    expect(second && { ...second, event: first?.event }).toEqual(first);
    expect(await finish(secondWorker, retried, { kind: 'accepted', requestId: 'accepted-request-id' })).toBe(true);
    expect((await state(event)).state).toBe('accepted');
    expect((await fixture.control.query('select attempt_number,result,error_category from dental.notification_attempts where outbox_id=$1 order by attempt_number', [event.id])).rows)
      .toEqual([{ attempt_number: 1, result: 'retryable', error_category: 'timeout' }, { attempt_number: 2, result: 'accepted', error_category: null }]);
  });

  it('fences old results by refusing to reuse a worker UUID for an event after lease recovery', async () => {
    await approve(); const oldWorker = worker(), [event] = await claim(oldWorker); await prepare(oldWorker, event);
    await fixture.setClock('2026-10-08T05:02:00Z');
    expect(await claim(oldWorker)).toEqual([]);
    const newWorker = worker(), [retried] = await claim(newWorker);
    expect(retried.id).toBe(event.id); expect(await prepare(newWorker, retried)).not.toBeNull();
    expect(await finish(oldWorker, event, { kind: 'accepted', requestId: 'stale-request' })).toBe(false);
    expect((await state(event)).state).toBe('leased');
    expect(await finish(newWorker, retried, { kind: 'accepted', requestId: 'current-request' })).toBe(true);
    expect(await finish(newWorker, retried, { kind: 'accepted' })).toBe(false);
  });

  it('retains the provider result of a send that began before cancellation without resurrecting work', async () => {
    const appointment = await approve(), id = worker(), [event] = await claim(id); await prepare(id, event);
    await cancel(appointment);
    expect(await finish(id, event, { kind: 'accepted', requestId: 'after-cancel-request' })).toBe(true);
    expect((await state(event)).state).toBe('suppressed');
    expect((await fixture.control.query('select result from dental.notification_attempts where outbox_id=$1', [event.id])).rows).toEqual([{ result: 'accepted' }]);
    expect((await fixture.call<Appointment>('select dental.get_appointment($1,$2) as result', [owner, appointment.id])).status).toBe('cancelled');
  });

  it('fails a crashed attempt whose next backoff exceeds expiry without poisoning the claim transaction', async () => {
    await approve(); const id = worker(), [event] = await claim(id); await prepare(id, event);
    await fixture.control.query("update dental.outbox set expires_at='2026-10-08T05:01:30Z' where id=$1", [event.id]);
    await fixture.setClock('2026-10-08T05:01:00Z');
    expect(await claim(worker())).toEqual([]);
    expect(await state(event)).toMatchObject({ state: 'failed', lease_owner: null, failure_category: 'timeout' });
  });

  it('enforces 1/5/15/60/180 minute delays and six attempts without changing booking status', async () => {
    const appointment = await approve(); let now = Date.parse('2026-10-08T05:00:00Z');
    const delays = [1, 5, 15, 60, 180]; let event!: Event;
    for (let attempt = 1; attempt <= 6; attempt++) {
      const id = worker(); [event] = await claim(id); expect(event).toBeDefined(); await prepare(id, event);
      await finish(id, event, { kind: 'retryable', category: 'server_error', requestId: `request-${attempt}` });
      const current = await state(event); expect(current.attempt_count).toBe(attempt);
      if (attempt < 6) {
        now += delays[attempt - 1] * 60_000; expect(current.due_at.toISOString()).toBe(new Date(now).toISOString());
        expect(await claim(worker())).toEqual([]); await fixture.setClock(new Date(now).toISOString());
      } else expect(current.state).toBe('failed');
    }
    expect((await fixture.call<Appointment>('select dental.get_appointment($1,$2) as result', [owner, appointment.id])).status).toBe('approved');
    expect(await claim(worker())).toEqual([]);
  });

  it('never reuses the key outside its 24-hour first-attempt horizon', async () => {
    const appointment = await decide(await reserve(), 'reject'), id = worker(), [event] = await claim(id); await prepare(id, event);
    // Isolate provider-key horizon from an earlier event expiry.
    await fixture.control.query("update dental.outbox set expires_at='2026-10-10T05:00:00Z' where id=$1", [event.id]);
    await fixture.setClock('2026-10-09T05:00:00Z'); expect(await claim(worker())).toEqual([]);
    expect((await state(event)).state).toBe('failed');
    expect((await fixture.call<Appointment>('select dental.get_appointment($1,$2) as result', [owner, appointment.id])).status).toBe('rejected');
  });

  it('fails unknown, blocked and cross-provider recipients closed; stale follow cannot reopen reachability', async () => {
    await reachability(false, '2026-10-08T05:00:00Z');
    await reachability(true, '2026-10-08T04:59:59Z');
    await reachability(true, '2026-10-08T05:00:00Z'); // Conservative equal-time tie.
    await reachability(true, '2026-10-08T05:00:01Z', owner, 'line:9876543210');
    await approve(); const id = worker(), [event] = await claim(id); expect(await prepare(id, event)).toBeNull();
    expect(await state(event)).toMatchObject({ state: 'failed', failure_category: 'recipient_unavailable', attempt_count: 0 });
    await reachability(true, '2026-10-08T05:00:01Z');
    const next = await approve(), nextWorker = worker(), [nextEvent] = await claim(nextWorker);
    expect(nextEvent.appointmentId).toBe(next.id); expect(await prepare(nextWorker, nextEvent)).not.toBeNull();
  });

  it('fails an unknown recipient closed without consuming an outbound attempt', async () => {
    await fixture.control.query('delete from dental.line_reachability where subject=$1', [subjectOf(owner)]);
    await approve(); const id = worker(), [event] = await claim(id);
    expect(await prepare(id, event)).toBeNull();
    expect(await state(event)).toMatchObject({ state: 'failed', failure_category: 'recipient_unavailable', attempt_count: 0 });
  });

  it('deduplicates webhook IDs and never creates accounts or grants from a follow event', async () => {
    const unknown = randomUUID(); actors.push(unknown); const duplicateId = eventId();
    await reachability(false, '2026-10-08T05:00:00Z', unknown, provider, duplicateId);
    await reachability(true, '2026-10-08T05:00:01Z', unknown, provider, duplicateId);
    expect((await fixture.control.query('select reachable from dental.line_reachability where provider=$1 and subject=$2', [provider, subjectOf(unknown)])).rows).toEqual([{ reachable: false }]);
    expect((await fixture.control.query('select id from dental.accounts where subject=$1', [subjectOf(unknown)])).rows).toEqual([]);
  });

  it('stores safe categories and request IDs, never arbitrary provider error text', async () => {
    await approve(); const id = worker(), [event] = await claim(id); await prepare(id, event);
    await finish(id, event, { kind: 'permanent', category: 'secret patient detail', requestId: 'private\nphone 0000000', rawBody: 'never persist' });
    const { rows: [attempt] } = await fixture.control.query('select result,error_category,provider_request_id from dental.notification_attempts where outbox_id=$1', [event.id]);
    expect(attempt).toEqual({ result: 'permanent', error_category: 'unknown', provider_request_id: null });
    expect((await state(event)).state).toBe('failed');
  });

  it('denies direct backend notification reads and unsafe origin payload construction', async () => {
    await expect(fixture.call('select count(*) as result from dental.line_reachability')).rejects.toMatchObject({ code: '42501' });
    await expect(fixture.call('select count(*) as result from dental.notification_attempts')).rejects.toMatchObject({ code: '42501' });
    await approve(); const id = worker(), [event] = await claim(id);
    for (const invalid of ['http://clinic.example', 'https://user:secret@clinic.example', 'https://clinic.example/private?patient=1']) {
      await expect(prepare(id, event, invalid)).rejects.toMatchObject({ code: 'P0001', message: 'VALIDATION' });
    }
    expect((await state(event)).attempt_count).toBe(0);
  });
});

// Source contracts are separately runnable without claiming PostgreSQL proof.
describe('Task 8 notification migration source contract', () => {
  const path = 'db/migrations/006_notifications.sql';
  const sql = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const body = (name: string) => sql.split(`CREATE FUNCTION dental.${name}(`)[1]?.split('$body$;')[0] ?? '';
  it('is one guarded candidate that preserves the existing function surface and role memberships', () => {
    expect(sql).toContain('DO $task8$');
    expect(sql.trim()).toMatch(/END;\s*\$task8\$;$/);
    expect(sql).toContain('v_existing_functions IS DISTINCT FROM v_existing_functions_after');
    expect(sql).toContain('v_memberships IS DISTINCT FROM v_memberships_after');
    expect(sql).toContain('v_defaults IS DISTINCT FROM v_defaults_after');
    expect(sql).not.toMatch(/CREATE ROLE|PASSWORD|DISABLE ROW LEVEL SECURITY|GRANT[^;]*TO (?:anon|authenticated|service_role)/);
  });
  it('claims using SKIP LOCKED and enforces the six attempts, lease and provider horizon', () => {
    expect(body('claim_events')).toContain('FOR UPDATE SKIP LOCKED');
    expect(body('claim_events')).toContain("interval '60 seconds'");
    expect(body('claim_events')).toContain("interval '24 hours'");
    expect(body('claim_events')).toContain('attempt_count>=6');
    expect(sql).toContain('ARRAY[1,5,15,60,180]');
  });
  it('performs final date, appointment, outbox locks before reading fresh time and freezes V1 payload inputs', () => {
    const text = body('prepare_dispatch');
    const date = text.indexOf('FROM dental.clinic_dates');
    const appointment = text.indexOf('FROM dental.appointments', date);
    const outbox = text.indexOf('FROM dental.outbox', appointment);
    expect(date).toBeGreaterThan(0); expect(appointment).toBeGreaterThan(date); expect(outbox).toBeGreaterThan(appointment);
    expect(text.lastIndexOf('v_now:=dental.clock_now()')).toBeGreaterThan(outbox);
    expect(text).toContain('v_appointment.date IS DISTINCT FROM v_event.appointment_date');
    expect(text).toContain('v_event.dispatch_recipient IS NULL');
    expect(text).toContain("'payloadVersion',1");
    expect(text).not.toMatch(/patient_snapshot|full_name|phone|address|service/);
  });
  it('fences each worker identity to at most one send attempt per event', () => {
    expect(body('claim_events')).toContain('a.outbox_id=o.id AND a.worker_id=p_worker');
    expect(body('prepare_dispatch')).toContain('outbox_id=p_event AND worker_id=p_worker');
  });
  it('does not persist a crash backoff until event expiry and retry-key horizon are checked', () => {
    const text = body('claim_events');
    const expiry = text.indexOf('v_event.due_at>=v_event.expires_at');
    const persist = text.indexOf('SET state=\'retry\',due_at=');
    expect(text).not.toContain('UPDATE dental.outbox SET due_at=v_retry_at');
    expect(expiry).toBeGreaterThan(0); expect(persist).toBeGreaterThan(expiry);
  });
  it('keeps private helpers ungranted and browser roles off notification functions and tables', () => {
    expect(sql).toContain('ALTER TABLE dental.line_reachability FORCE ROW LEVEL SECURITY');
    expect(sql).toContain('Unsafe new private notification function ownership, search path or execute ACL');
    expect(sql).toContain('Notification owner access exceeds the reviewed column surface');
    expect(sql).toContain("FOREACH v_role IN ARRAY ARRAY['anon','authenticated','authenticator','service_role']");
  });
});
