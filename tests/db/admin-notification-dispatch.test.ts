import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { booking } from '../support/reservation-postgres';
import { AdminNotificationFixture, FIXTURE_END, FIXTURE_NOW, localAdminConnection, type AdminIdentity, type BudgetSettings } from '../support/admin-notification-postgres';

const ORIGIN = 'https://tooth-talk-staging.tooth-talk-staging-f7ff4a96.workers.dev';
const SIGNATURES = [
  'dental.claim_admin_delivery(uuid)', 'dental.prepare_admin_dispatch(uuid,uuid,text,jsonb)',
  'dental.revalidate_admin_dispatch(uuid,uuid)', 'dental.finish_admin_dispatch(uuid,uuid,jsonb)',
];
type Claimed = { id: string; eventId: string; appointmentId: string; grantId: string; retryKey: string; createdAt: string; dueAt: string; expiresAt: string };
type Envelope = { delivery: Claimed; provider: string; recipient: string; reference: string; date: string; manageUrl: string; payloadVersion: number; preparedAt: string; authorizationValidUntil: string };
type Preparation = Envelope | { state: 'paused_quota' } | null;
let fixture: AdminNotificationFixture;

async function observation(overrides: Record<string, unknown> = {}) {
  const { rows: [{ now }] } = await fixture.control.query('select dental.clock_now() as now');
  return { type: 'limited', value: 300, totalUsage: 0, observedAt: (now as Date).toISOString(), ...overrides };
}
async function queue(count = 1, options: { budget?: false | Partial<BudgetSettings>; policyEnd?: string } = {}) {
  const operator = await fixture.account(); await fixture.policy(operator, true, FIXTURE_NOW, options.policyEnd ?? FIXTURE_END);
  const admins: AdminIdentity[] = [];
  for (let i = 0; i < count; i++) admins.push(await fixture.admin());
  const appointment = await book();
  if (options.budget !== false) await fixture.budget(operator, options.budget);
  return { operator, admins, appointment, deliveries: await fixture.deliveries() };
}
async function book() {
  const actor = await fixture.account(); return fixture.base.reserve(actor, randomUUID(), booking(await fixture.base.patient(actor)));
}
async function claim(worker = randomUUID()) { return fixture.base.call<Claimed | null>('select dental.claim_admin_delivery($1) as result', [worker]); }
async function prepareOn(client: pg.Client, worker: string, delivery: string, quota: unknown, origin = ORIGIN): Promise<Preparation> {
  return (await client.query('select dental.prepare_admin_dispatch($1,$2,$3,$4::jsonb) as result', [worker, delivery, origin, JSON.stringify(quota)])).rows[0].result;
}
async function prepare(worker: string, delivery: string, quota?: unknown, origin = ORIGIN) {
  return fixture.base.call<Preparation>('select dental.prepare_admin_dispatch($1,$2,$3,$4::jsonb) as result',
    [worker, delivery, origin, JSON.stringify(quota === undefined ? await observation() : quota)]);
}
async function revalidate(worker: string, delivery: string) { return fixture.base.call<boolean>('select dental.revalidate_admin_dispatch($1,$2) as result', [worker, delivery]); }
async function finish(worker: string, delivery: string, result: unknown) { return fixture.base.call<boolean>('select dental.finish_admin_dispatch($1,$2,$3::jsonb) as result', [worker, delivery, JSON.stringify(result)]); }
async function row(id: string) { return (await fixture.control.query('select * from dental.admin_booking_deliveries where id=$1', [id])).rows[0]; }
async function attempts(id: string) { return (await fixture.control.query('select * from dental.admin_notification_attempts where delivery_id=$1 order by attempt_number', [id])).rows; }
async function ledger() { return {
  budgets: (await fixture.control.query('select * from dental.admin_notification_budget order by version')).rows,
  reservations: (await fixture.control.query('select * from dental.admin_notification_budget_reservations order by delivery_id')).rows,
}; }
function envelope(value: Preparation): Envelope { expect(value).not.toBeNull(); expect(value).not.toHaveProperty('state'); return value as Envelope; }
function frozenPayload(value: Envelope) { return { provider: value.provider, recipient: value.recipient, reference: value.reference,
  date: value.date, manageUrl: value.manageUrl, payloadVersion: value.payloadVersion, retryKey: value.delivery.retryKey,
  eventId: value.delivery.eventId, appointmentId: value.delivery.appointmentId, grantId: value.delivery.grantId }; }
async function started() { const worker = randomUUID(), delivery = await claim(worker); expect(delivery).not.toBeNull();
  const prepared = envelope(await prepare(worker, delivery!.id)); return { worker, delivery: delivery!, prepared }; }
async function afterLock<T>(lock: string, params: unknown[], run: (client: pg.Client) => Promise<T>, whileBlocked: () => Promise<void>) {
  const holder = await localAdminConnection(), worker = await fixture.session(); let pending: Promise<T> | undefined;
  try {
    await holder.query('begin'); await holder.query(lock, params);
    const { rows: [{ pid }] } = await holder.query('select pg_backend_pid() as pid');
    pending = run(worker.client); await fixture.base.waitForLockWaiters([worker.pid], pid);
    await whileBlocked(); await holder.query('commit'); const result = await pending; await worker.client.query('commit'); return result;
  } finally {
    await holder.query('rollback'); await pending?.catch(() => {});
    await fixture.closeSession(worker); await holder.end();
  }
}

// Regression targets: cross-audience claiming; missing live-grant checks;
// a reservation committed separately from its attempt; lock-wait clock staleness;
// mutable retry inputs; stale callback acceptance; and accidental budget refunds.
describe('real PostgreSQL isolated admin dispatch', () => {
  beforeAll(async () => { fixture = await AdminNotificationFixture.create(); });
  afterEach(async () => { await fixture?.reset(); });
  afterAll(async () => { await fixture?.close(); });

  it('installs exactly the four backend dispatch entry points', async () => {
    const { rows } = await fixture.control.query(`select signature,to_regprocedure(signature) is not null as installed
      from unnest($1::text[]) as signature order by signature`, [SIGNATURES]);
    expect(rows).toEqual([...SIGNATURES].sort().map(signature => ({ signature, installed: true })));
  });

  it('limits dispatch execute privileges to backend inheritance and pins every definer search path', async () => {
    for (const signature of SIGNATURES) {
      const { rows: [fn] } = await fixture.control.query(`select r.rolname as owner,p.prosecdef,p.proconfig,
        has_function_privilege('dental_backend',p.oid,'EXECUTE') as backend,
        has_function_privilege('dental_runtime',p.oid,'EXECUTE') as runtime,
        has_function_privilege('anon',p.oid,'EXECUTE') as anon,
        has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated,
        has_function_privilege('service_role',p.oid,'EXECUTE') as service_role
        from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=$1::regprocedure`, [signature]);
      expect(fn).toEqual({ owner: 'dental_function_owner', prosecdef: true, proconfig: ['search_path=""'], backend: true, runtime: true, anon: false, authenticated: false, service_role: false });
      expect((await fixture.control.query(`select a.privilege_type from pg_proc p cross join lateral aclexplode(p.proacl) a
        where p.oid=$1::regprocedure and a.grantee=0`, [signature])).rows).toEqual([]);
    }
    const { rows } = await fixture.control.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='dental' and p.proname like '%admin%' and has_function_privilege('dental_backend',p.oid,'EXECUTE')
      and p.proname not in ('admin_appointments','set_admin_grant','is_admin') order by p.proname`);
    expect(rows.map(r => r.proname)).toEqual(['claim_admin_delivery', 'finish_admin_dispatch', 'prepare_admin_dispatch', 'revalidate_admin_dispatch']);
  });

  it('does not claim while the database policy starts disabled', async () => {
    expect(await claim()).toBeNull(); expect((await fixture.control.query('select enabled from dental.admin_notification_policy')).rows[0].enabled).toBe(false);
    expect(await ledger()).toEqual({ budgets: [], reservations: [] });
  });

  it('pauses without a budget and creates neither an attempt nor a reservation', async () => {
    await queue(1, { budget: false }); const worker = randomUUID(), delivery = await claim(worker);
    expect(delivery).not.toBeNull(); expect(await prepare(worker, delivery!.id)).toEqual({ state: 'paused_quota' });
    expect(await row(delivery!.id)).toMatchObject({ state: 'paused_quota', safe_reason: 'budget_expired', attempt_count: 0, lease_owner: null });
    expect(await attempts(delivery!.id)).toEqual([]); expect(await ledger()).toEqual({ budgets: [], reservations: [] });
  });

  it('claims one delivery at a time in immutable FIFO order and gives it exactly sixty seconds', async () => {
    await queue(3); await fixture.base.setClock('2026-10-08T05:00:01Z'); await book();
    const expected = (await fixture.control.query('select id from dental.admin_booking_deliveries order by created_at,event_id,grant_id,id')).rows.map(r => r.id);
    for (const id of expected) {
      const worker = randomUUID(), delivery = await claim(worker); expect(delivery?.id).toBe(id);
      expect(await row(id)).toMatchObject({ state: 'leased', lease_owner: worker, lease_until: new Date('2026-10-08T05:01:01Z'), attempt_count: 0 });
    }
    expect(await claim()).toBeNull(); expect(await fixture.counts()).toMatchObject({ patient_outbox: 0, patient_attempts: 0 });
  });

  it('gives independent concurrent claim transactions distinct deliveries without waiting on a locked first row', async () => {
    await queue(2); const [a, b] = await Promise.all([fixture.session(), fixture.session()]);
    try {
      expect(a.pid).not.toBe(b.pid);
      const first = (await a.client.query('select dental.claim_admin_delivery($1) as result', [randomUUID()])).rows[0].result as Claimed;
      const second = (await b.client.query('select dental.claim_admin_delivery($1) as result', [randomUUID()])).rows[0].result as Claimed;
      expect(first).not.toBeNull(); expect(second).not.toBeNull(); expect(first.id).not.toBe(second.id);
      await Promise.all([a.client.query('commit'), b.client.query('commit')]); expect(await claim()).toBeNull();
    } finally { await Promise.all([fixture.closeSession(a), fixture.closeSession(b)]); }
  });

  it('prepares only the frozen administrator destination and minimum booking facts', async () => {
    const { admins: [admin], appointment } = await queue(); const { worker, delivery, prepared } = await started();
    expect(prepared).toMatchObject({ delivery: { id: delivery.id, appointmentId: appointment.id, grantId: admin.grant, retryKey: delivery.retryKey },
      provider: admin.provider, recipient: admin.recipient, reference: appointment.reference, date: appointment.date,
      manageUrl: `${ORIGIN}/admin`, payloadVersion: 1 });
    expect(Object.keys(prepared).sort()).toEqual(['authorizationValidUntil', 'date', 'delivery', 'manageUrl', 'payloadVersion', 'preparedAt', 'provider', 'recipient', 'reference']);
    expect(new Date(prepared.preparedAt)).toEqual(new Date(FIXTURE_NOW));
    expect(new Date(prepared.authorizationValidUntil)).toEqual(new Date('2026-10-08T05:01:00Z'));
    expect(await revalidate(worker, delivery.id)).toBe(true);
    expect(await attempts(delivery.id)).toMatchObject([{ attempt_number: 1, worker_id: worker, result: null, started_at: new Date(FIXTURE_NOW) }]);
    expect((await ledger()).reservations).toMatchObject([{ delivery_id: delivery.id, units: 1 }]);
  });

  it('does not acquire appointment or clinic-date locks during preparation', async () => {
    const { appointment } = await queue(); const worker = randomUUID(), delivery = await claim(worker), holder = await localAdminConnection();
    try {
      await holder.query('begin'); await holder.query('select id from dental.appointments where id=$1 for update', [appointment.id]);
      await holder.query('select date from dental.clinic_dates where date=$1 for update', [appointment.date]);
      expect(envelope(await prepare(worker, delivery!.id)).delivery.id).toBe(delivery!.id);
    } finally { await holder.query('rollback'); await holder.end(); }
  });

  it.each(['revoke', 'revoke-and-regrant'] as const)('suppresses the original grant after %s before prepare', async change => {
    const { operator, admins: [admin] } = await queue(); const worker = randomUUID(), delivery = await claim(worker);
    await fixture.revoke(operator, admin);
    if (change === 'revoke-and-regrant') await fixture.operatorCall('select dental.set_admin_grant($1,$2,true,$3) as result', [operator, admin.account, 'Synthetic replacement grant']);
    expect(await prepare(worker, delivery!.id)).toBeNull(); expect(await row(delivery!.id)).toMatchObject({ state: 'suppressed', safe_reason: 'grant_revoked', attempt_count: 0 });
    expect(await attempts(delivery!.id)).toEqual([]); expect((await ledger()).reservations).toEqual([]); expect(await claim()).toBeNull();
  });

  it.each(['mapping', 'unreachable', 'reachability-missing'] as const)('fails closed when live %s changes after enqueue', async change => {
    const { admins: [admin] } = await queue(); const worker = randomUUID(), delivery = await claim(worker);
    if (change === 'mapping') await fixture.control.query('update dental.accounts set subject=$2 where id=$1', [admin.account, `U${randomUUID().replaceAll('-', '')}`]);
    else if (change === 'unreachable') await fixture.control.query('update dental.line_reachability set reachable=false where provider=$1 and subject=$2', [admin.provider, admin.recipient]);
    else await fixture.control.query('delete from dental.line_reachability where provider=$1 and subject=$2', [admin.provider, admin.recipient]);
    expect(await prepare(worker, delivery!.id)).toBeNull(); expect(await row(delivery!.id)).toMatchObject({ state: 'suppressed', attempt_count: 0 });
    expect((await ledger()).reservations).toEqual([]);
  });

  it('never sends old pending deliveries after policy disable and a new activation boundary', async () => {
    const { operator, deliveries } = await queue(2); const worker = randomUUID(); await claim(worker);
    await fixture.policy(operator, false, null, null); expect(await claim()).toBeNull();
    await fixture.base.setClock('2026-10-08T05:00:01Z'); await fixture.policy(operator, true, '2026-10-08T05:00:01Z', FIXTURE_END);
    expect(await claim()).toBeNull();
    for (const delivery of deliveries) expect(await row(delivery.id)).toMatchObject({ state: 'suppressed', safe_reason: 'policy_disabled' });
    const appointment = await book(); expect((await claim())?.appointmentId).toBe(appointment.id);
  });

  it.each(['https://evil.example', `${ORIGIN}/patient`, `${ORIGIN}?secret=synthetic`, 'http://localhost'])('rejects unapproved manage origin %s before reserving or attempting', async origin => {
    await queue(); const worker = randomUUID(), delivery = await claim(worker);
    try { expect(await prepare(worker, delivery!.id, undefined, origin)).toBeNull(); }
    catch (error) { expect((error as Error).message).toMatch(/VALIDATION|INVALID|UNAVAILABLE/); }
    expect(await attempts(delivery!.id)).toEqual([]); expect((await ledger()).reservations).toEqual([]);
  });

  it('rolls reservation, budget counter and attempt back together if the prepare transaction aborts', async () => {
    await queue(); const worker = randomUUID(), delivery = await claim(worker), before = await ledger(), session = await fixture.session();
    try {
      expect(envelope(await prepareOn(session.client, worker, delivery!.id, await observation())).delivery.id).toBe(delivery!.id);
      await session.client.query('rollback'); expect(await ledger()).toEqual(before); expect(await attempts(delivery!.id)).toEqual([]);
      expect(await row(delivery!.id)).toMatchObject({ attempt_count: 0, first_attempt_at: null, manage_url: null });
    } finally { await fixture.closeSession(session); }
  });

  it('rolls a freshly reserved unit back when durable attempt insertion fails', async () => {
    await queue(); const worker = randomUUID(), delivery = await claim(worker), before = await ledger();
    await fixture.control.query(`alter table dental.admin_notification_attempts add constraint synthetic_reject_attempt check (worker_id<>'${worker}'::uuid) not valid`);
    try {
      await expect(prepare(worker, delivery!.id)).rejects.toMatchObject({ code: '23514' });
      expect(await ledger()).toEqual(before); expect(await attempts(delivery!.id)).toEqual([]); expect((await row(delivery!.id)).attempt_count).toBe(0);
    } finally { await fixture.control.query('alter table dental.admin_notification_attempts drop constraint synthetic_reject_attempt'); }
  });

  it.each(['accepted', 'retryable', 'permanent'] as const)('does not refund any unit after real finish records %s', async kind => {
    await queue(2, { budget: { freeLimit: 1 } }); const { worker, delivery } = await started(), before = await ledger();
    const category = kind === 'retryable' ? 'timeout' : kind === 'permanent' ? 'forbidden' : undefined;
    expect(await finish(worker, delivery.id, { kind, category, requestId: 'synthetic-provider-request' })).toBe(true);
    expect(await ledger()).toEqual(before); expect((await attempts(delivery.id))[0]).toMatchObject({ result: kind, provider_request_id: 'synthetic-provider-request' });
    const nextWorker = randomUUID(), next = await claim(nextWorker); expect(next?.id).not.toBe(delivery.id);
    expect(await prepare(nextWorker, next!.id)).toEqual({ state: 'paused_quota' });
    expect((await row(next!.id)).safe_reason).toBe('quota_exhausted'); expect(await ledger()).toEqual(before);
  });

  it.each(['rate_limited', 'invalid_request', 'recipient_unavailable', 'unauthorized', 'forbidden'] as const)('keeps permanent %s terminal without replay', async category => {
    await queue(); const { worker, delivery } = await started(); expect(await finish(worker, delivery.id, { kind: 'permanent', category })).toBe(true);
    expect(await row(delivery.id)).toMatchObject({ state: 'failed', safe_reason: category, lease_owner: null });
    await fixture.base.setClock('2026-10-08T05:15:00Z'); expect(await claim()).toBeNull();
  });

  it('recovers provider acceptance with a lost finish using the identical frozen payload and retry key', async () => {
    const { appointment } = await queue(); const first = await started(), before = await ledger();
    // The provider outcome is deliberately never committed, as after a process
    // crash. No external LINE request is performed by this fixture.
    await fixture.control.query("update dental.appointments set status='cancelled',version=version+1 where id=$1", [appointment.id]);
    await fixture.base.setClock('2026-10-08T05:01:00Z'); const secondWorker = randomUUID(), recovered = await claim(secondWorker);
    expect(recovered?.id).toBe(first.delivery.id); const second = envelope(await prepare(secondWorker, recovered!.id));
    expect(frozenPayload(second)).toEqual(frozenPayload(first.prepared)); expect(await ledger()).toEqual(before);
    expect(await finish(first.worker, first.delivery.id, { kind: 'accepted' })).toBe(false);
    expect(await finish(secondWorker, recovered!.id, { kind: 'accepted', requestId: 'synthetic-retry-409' })).toBe(true);
    expect(await row(recovered!.id)).toMatchObject({ state: 'accepted', attempt_count: 2 }); expect(await claim()).toBeNull();
  });

  it('prevents a worker UUID from becoming a later attempt after lease recovery', async () => {
    await queue(); const first = await started(); await fixture.base.setClock('2026-10-08T05:01:00Z');
    expect(await claim(first.worker)).toBeNull(); const worker = randomUUID(), delivery = await claim(worker); expect(delivery?.id).toBe(first.delivery.id);
    envelope(await prepare(worker, delivery!.id)); expect((await attempts(delivery!.id)).map(a => a.worker_id)).toEqual([first.worker, worker]);
    expect(await revalidate(first.worker, delivery!.id)).toBe(false); expect(await finish(first.worker, delivery!.id, { kind: 'accepted' })).toBe(false);
  });

  it('never creates two attempts for repeated preparation with the current worker', async () => {
    await queue(); const first = await started(), before = await ledger(); await prepare(first.worker, first.delivery.id);
    expect(await attempts(first.delivery.id)).toHaveLength(1); expect(await ledger()).toEqual(before);
  });

  it('uses 1, 2, 4, 8 and 16 minute delays then stops after six durable attempts', async () => {
    await queue(); let now = Date.parse(FIXTURE_NOW); let id: string | undefined;
    for (let attempt = 1; attempt <= 6; attempt++) {
      const startedAttempt = await started(); id ??= startedAttempt.delivery.id; expect(startedAttempt.delivery.id).toBe(id);
      expect(await finish(startedAttempt.worker, id, { kind: 'retryable', category: 'server_error' })).toBe(true);
      const state = await row(id); expect(state.attempt_count).toBe(attempt);
      if (attempt === 6) { expect(state.state).toBe('failed'); break; }
      now += 2 ** (attempt - 1) * 60_000; expect(state.due_at).toEqual(new Date(now));
      await fixture.base.setClock(new Date(now - 1).toISOString()); expect(await claim()).toBeNull();
      await fixture.base.setClock(new Date(now).toISOString());
    }
    expect(await attempts(id!)).toHaveLength(6); expect((await ledger()).reservations).toHaveLength(1); expect(await claim()).toBeNull();
  });

  it.each(['disable', 'revoke'] as const)('records a current already-started acceptance after %s without making new work', async boundary => {
    const { operator, admins: [admin] } = await queue(); const first = await started();
    if (boundary === 'disable') await fixture.policy(operator, false, null, null); else await fixture.revoke(operator, admin);
    expect(await revalidate(first.worker, first.delivery.id)).toBe(false);
    expect(await finish(first.worker, first.delivery.id, { kind: 'accepted', requestId: 'synthetic-late-acceptance' })).toBe(true);
    expect((await attempts(first.delivery.id))[0]).toMatchObject({ result: 'accepted', provider_request_id: 'synthetic-late-acceptance' });
    expect(['accepted', 'suppressed']).toContain((await row(first.delivery.id)).state); expect(await claim()).toBeNull();
  });

  it('rejects stale, malformed and repeated finish callbacks without rewriting accepted facts', async () => {
    await queue(); const first = await started(), before = await attempts(first.delivery.id);
    expect(await finish(randomUUID(), first.delivery.id, { kind: 'accepted' })).toBe(false); expect(await attempts(first.delivery.id)).toEqual(before);
    for (const invalid of [null, {}, { kind: 'bogus' }]) {
      try { expect(await finish(first.worker, first.delivery.id, invalid)).toBe(false); }
      catch (error) { expect((error as Error).message).toMatch(/VALIDATION|INVALID/); }
      expect(await attempts(first.delivery.id)).toEqual(before);
    }
    expect(await finish(first.worker, first.delivery.id, { kind: 'accepted', requestId: 'synthetic-original' })).toBe(true);
    const accepted = await attempts(first.delivery.id);
    expect(await finish(first.worker, first.delivery.id, { kind: 'permanent', category: 'forbidden' })).toBe(false);
    expect(await attempts(first.delivery.id)).toEqual(accepted); expect((await row(first.delivery.id)).state).toBe('accepted');
  });

  it('retains reservations when a finish transaction fails and recovers using the original key', async () => {
    await queue(); const first = await started(), before = await ledger(), session = await fixture.session();
    try {
      expect((await session.client.query('select dental.finish_admin_dispatch($1,$2,$3::jsonb) as result', [first.worker, first.delivery.id, { kind: 'accepted' }])).rows[0].result).toBe(true);
      await session.client.query('rollback'); expect((await attempts(first.delivery.id))[0].result).toBeNull(); expect(await ledger()).toEqual(before);
    } finally { await fixture.closeSession(session); }
    await fixture.base.setClock('2026-10-08T05:01:00Z'); const worker = randomUUID(), delivery = await claim(worker);
    expect(delivery?.retryKey).toBe(first.delivery.retryKey); envelope(await prepare(worker, delivery!.id)); expect(await ledger()).toEqual(before);
  });

  it.each([false, true])('classifies expiry safely when previously attempted=%s', async attempted => {
    await queue(1, { policyEnd: '2026-10-10T05:00:00Z', budget: { verifiedUntil: '2026-10-10T05:00:00Z' } }); let id: string;
    if (attempted) id = (await started()).delivery.id; else id = (await fixture.deliveries())[0].id;
    await fixture.base.setClock(FIXTURE_END); expect(await claim()).toBeNull();
    expect(await row(id)).toMatchObject({ state: attempted ? 'failed' : 'suppressed', safe_reason: attempted ? 'unknown' : 'expired', lease_owner: null });
    expect((await ledger()).reservations).toHaveLength(attempted ? 1 : 0);
  });

  it('keeps partial fan-out FIFO and does not reclaim quota pauses before fifteen minutes', async () => {
    await queue(3, { budget: { freeLimit: 1 } }); const first = await started(); await finish(first.worker, first.delivery.id, { kind: 'accepted' });
    const paused: string[] = [];
    for (let i = 0; i < 2; i++) { const worker = randomUUID(), delivery = await claim(worker); paused.push(delivery!.id); expect(await prepare(worker, delivery!.id)).toEqual({ state: 'paused_quota' }); }
    expect(await claim()).toBeNull(); await fixture.base.setClock('2026-10-08T05:14:59.999Z'); expect(await claim()).toBeNull();
    await fixture.base.setClock('2026-10-08T05:15:00Z'); expect((await claim())?.id).toBe(paused[0]);
    expect((await row(first.delivery.id)).state).toBe('accepted'); expect((await ledger()).reservations).toHaveLength(1);
  });

  it.each([
    ['policy', 'select singleton from dental.admin_notification_policy for update', { policyEnd: '2026-10-08T05:00:30Z' }, '2026-10-08T05:00:30Z'],
    ['budget', 'select epoch from dental.admin_notification_budget for update', { budget: { verifiedUntil: '2026-10-08T05:00:30Z' } }, '2026-10-08T05:00:30Z'],
    ['lease', 'select id from dental.admin_booking_deliveries for update', {}, '2026-10-08T05:01:00Z'],
    ['quota freshness', 'select id from dental.admin_booking_deliveries for update', {}, '2026-10-08T05:00:10.001Z'],
  ] as const)('rechecks %s after a real lock wait before persisting any send attempt', async (_label, lock, options, after) => {
    await queue(1, options); const worker = randomUUID(), delivery = await claim(worker), quota = await observation(_label === 'quota freshness' ? { observedAt: '2026-10-08T04:59:10Z' } : {});
    const result = await afterLock(lock, [], client => prepareOn(client, worker, delivery!.id, quota), () => fixture.base.setClock(after));
    expect(result === null || ('state' in result && result.state === 'paused_quota')).toBe(true);
    expect(await attempts(delivery!.id)).toEqual([]); expect((await ledger()).reservations).toEqual([]);
  });

  it('rechecks event TTL after waiting on reachability and rolls no send attempt forward', async () => {
    const { admins: [admin] } = await queue(1, { policyEnd: '2026-10-10T05:00:00Z', budget: { verifiedUntil: '2026-10-10T05:00:00Z' } });
    await fixture.base.setClock('2026-10-09T04:59:30Z');
    const worker = randomUUID(), delivery = await claim(worker), quota = await observation();
    const result = await afterLock('select subject from dental.line_reachability where provider=$1 and subject=$2 for update', [admin.provider, admin.recipient],
      client => prepareOn(client, worker, delivery!.id, quota), () => fixture.base.setClock(FIXTURE_END));
    expect(result).toBeNull(); expect(await row(delivery!.id)).toMatchObject({ state: 'suppressed', safe_reason: 'expired' });
    expect(await attempts(delivery!.id)).toEqual([]); expect((await ledger()).reservations).toEqual([]);
  });

  it.each([
    ['lease', {}, '2026-10-08T05:01:00Z'],
    ['policy', { policyEnd: '2026-10-08T05:00:20Z' }, '2026-10-08T05:00:20Z'],
    ['budget', { budget: { verifiedUntil: '2026-10-08T05:00:25Z' } }, '2026-10-08T05:00:25Z'],
  ] as const)('caps the authorization deadline at %s and never extends the original lease on revalidation', async (_label, options, deadline) => {
    await queue(1, options); const first = await started(); expect(new Date(first.prepared.authorizationValidUntil)).toEqual(new Date(deadline));
    const originalLease = (await row(first.delivery.id)).lease_until;
    await fixture.base.setClock(new Date(Date.parse(deadline) - 1).toISOString()); expect(await revalidate(first.worker, first.delivery.id)).toBe(true);
    expect((await row(first.delivery.id)).lease_until).toEqual(originalLease);
    const result = await afterLock('select id from dental.admin_booking_deliveries where id=$1 for update', [first.delivery.id],
      async client => (await client.query('select dental.revalidate_admin_dispatch($1,$2) as result', [first.worker, first.delivery.id])).rows[0].result as boolean,
      () => fixture.base.setClock(deadline));
    expect(result).toBe(false);
  });

  it('caps authorization by observation freshness even while the sixty-second lease remains live', async () => {
    await queue(); const worker = randomUUID(), delivery = await claim(worker);
    const prepared = envelope(await prepare(worker, delivery!.id, await observation({ observedAt: '2026-10-08T04:59:10Z' })));
    expect(new Date(prepared.authorizationValidUntil)).toEqual(new Date('2026-10-08T05:00:10Z'));
    await fixture.base.setClock('2026-10-08T05:00:10Z'); expect(await revalidate(worker, delivery!.id)).toBe(false);
    expect((await row(delivery!.id)).lease_until).toEqual(new Date('2026-10-08T05:01:00Z'));
  });

  it('rejects revoked grants at the final pre-HTTP revalidation', async () => {
    const { operator, admins: [admin] } = await queue(); const first = await started(); await fixture.revoke(operator, admin);
    expect(await revalidate(first.worker, first.delivery.id)).toBe(false); expect(await attempts(first.delivery.id)).toHaveLength(1);
    expect((await ledger()).reservations).toHaveLength(1);
  });

  it('does not touch queued patient messages while claiming and finishing admin deliveries', async () => {
    const { admins: [admin], appointment } = await queue();
    await fixture.base.call('select dental.decide($1,$2,$3,$4,$5) as result', [admin.account, appointment.id, appointment.version, 'approve', 'Synthetic patient-queue isolation']);
    const before = (await fixture.control.query('select * from dental.outbox order by id')).rows; expect(before.length).toBeGreaterThan(0);
    const first = await started(); await finish(first.worker, first.delivery.id, { kind: 'accepted' }); expect(await claim()).toBeNull();
    expect((await fixture.control.query('select * from dental.outbox order by id')).rows).toEqual(before);
    expect((await fixture.control.query('select * from dental.notification_attempts')).rows).toEqual([]);
  });

  it('requires the current worker and an actual preparation before revalidation or finish', async () => {
    await queue(); const worker = randomUUID(), delivery = await claim(worker), before = await ledger();
    expect(await revalidate(worker, delivery!.id)).toBe(false); expect(await finish(worker, delivery!.id, { kind: 'accepted' })).toBe(false);
    expect(await prepare(randomUUID(), delivery!.id)).toBeNull(); expect(await ledger()).toEqual(before); expect(await attempts(delivery!.id)).toEqual([]);
  });

  it('rechecks frozen account mapping after waiting for the recipient reachability lock', async () => {
    const { admins: [admin] } = await queue(); const worker = randomUUID(), delivery = await claim(worker), quota = await observation();
    const result = await afterLock('select subject from dental.line_reachability where provider=$1 and subject=$2 for update', [admin.provider, admin.recipient],
      client => prepareOn(client, worker, delivery!.id, quota), async () => {
        await fixture.control.query('update dental.accounts set subject=$2 where id=$1', [admin.account, `U${randomUUID().replaceAll('-', '')}`]);
      });
    expect(result).toBeNull(); expect(await row(delivery!.id)).toMatchObject({ state: 'suppressed', safe_reason: 'mapping_changed', attempt_count: 0 });
    expect((await ledger()).reservations).toEqual([]); expect(await attempts(delivery!.id)).toEqual([]);
  });

  it('creates neither reservation nor attempt when quota is exactly at its authorization deadline', async () => {
    await queue(); const worker = randomUUID(), delivery = await claim(worker);
    const result = await prepare(worker, delivery!.id, await observation({ observedAt: '2026-10-08T04:59:00Z' }));
    expect(result === null || ('state' in result && result.state === 'paused_quota')).toBe(true);
    expect((await ledger()).reservations).toEqual([]); expect((await ledger()).budgets[0].reserved_units).toBe('0');
    expect(await attempts(delivery!.id)).toEqual([]);
  });

  it('requires the reserved epoch and immutable credit at final revalidation', async () => {
    await queue(); const first = await started();
    // A synthetic integrity fault must fail closed; the retained budget counter
    // cannot alone authorize an HTTP request without its recipient reservation.
    await fixture.control.query('delete from dental.admin_notification_budget_reservations where delivery_id=$1', [first.delivery.id]);
    expect(await revalidate(first.worker, first.delivery.id)).toBe(false);
    expect(await row(first.delivery.id)).toMatchObject({ state: 'paused_quota', safe_reason: 'budget_expired' });
    expect((await ledger()).budgets[0].reserved_units).toBe('1');
  });

  it('rechecks shared high-water consumption before HTTP even after reservation succeeded', async () => {
    await queue(); const first = await started(), reservations = (await ledger()).reservations;
    await fixture.control.query('update dental.admin_notification_budget set usage_high_water=300');
    expect(await revalidate(first.worker, first.delivery.id)).toBe(false);
    expect(await row(first.delivery.id)).toMatchObject({ state: 'paused_quota', safe_reason: 'quota_exhausted' });
    expect((await ledger()).reservations).toEqual(reservations);
  });

  it('carries an unresolved real attempt into renewal without moving or refunding its old credit', async () => {
    const { operator } = await queue(2, { budget: { freeLimit: 1, verifiedUntil: '2026-10-08T05:00:30Z' } });
    const first = await started(), before = await ledger(); await fixture.base.setClock('2026-10-08T05:00:30Z');
    await fixture.budget(operator, { expectedVersion: 1, verifiedFrom: '2026-10-08T05:00:30Z', freeLimit: 1 });
    expect(await revalidate(first.worker, first.delivery.id)).toBe(false);
    const worker = randomUUID(), second = await claim(worker); expect(second?.id).not.toBe(first.delivery.id);
    expect(await prepare(worker, second!.id)).toEqual({ state: 'paused_quota' });
    const after = await ledger(); expect(after.reservations).toEqual(before.reservations);
    expect(after.budgets[1]).toMatchObject({ reserved_units: '0', carried_units: '1' });
  });


  it('waits for the real grant-revocation transaction and suppresses its original grant after commit', async () => {
    const { operator, admins: [admin] } = await queue(); const worker = randomUUID(), delivery = await claim(worker), quota = await observation();
    const revoker = await localAdminConnection(), sender = await fixture.session(); let pending: Promise<Preparation> | undefined;
    try {
      await revoker.query('set session authorization postgres; begin');
      await revoker.query('select dental.set_admin_grant($1,$2,false,$3)', [operator, admin.account, 'Synthetic dispatch revocation race']);
      const { rows: [{ pid }] } = await revoker.query('select pg_backend_pid() as pid');
      pending = prepareOn(sender.client, worker, delivery!.id, quota);
      await fixture.base.waitForLockWaiters([sender.pid], pid); await revoker.query('commit');
      expect(await pending).toBeNull(); await sender.client.query('commit');
      expect(await row(delivery!.id)).toMatchObject({ state: 'suppressed', safe_reason: 'grant_revoked', attempt_count: 0 });
      expect((await ledger()).reservations).toEqual([]);
    } finally { await revoker.query('rollback'); await pending?.catch(() => {}); await fixture.closeSession(sender); await revoker.end(); }
  });

  it('serializes real prepare transactions competing for the final free recipient unit', async () => {
    await queue(2, { budget: { freeLimit: 1 } }); const workers = [randomUUID(), randomUUID()];
    const deliveries = [await claim(workers[0]), await claim(workers[1])], quota = await observation();
    const [first, second] = await Promise.all([fixture.session(), fixture.session()]); let pending: Promise<Preparation> | undefined;
    try {
      envelope(await prepareOn(first.client, workers[0], deliveries[0]!.id, quota));
      pending = prepareOn(second.client, workers[1], deliveries[1]!.id, quota);
      await fixture.base.waitForLockWaiters([second.pid], first.pid); await first.client.query('commit');
      expect(await pending).toEqual({ state: 'paused_quota' }); await second.client.query('commit');
      expect((await ledger()).reservations).toMatchObject([{ delivery_id: deliveries[0]!.id, units: 1 }]);
      expect(await attempts(deliveries[0]!.id)).toHaveLength(1); expect(await attempts(deliveries[1]!.id)).toEqual([]);
    } finally { await first.client.query('rollback'); await pending?.catch(() => {}); await Promise.all([fixture.closeSession(first), fixture.closeSession(second)]); }
  });

  it.each(['disable', 'quota pause'] as const)('never lets a retryable callback revive a delivery after %s', async boundary => {
    const { operator } = await queue(); const first = await started();
    if (boundary === 'disable') await fixture.policy(operator, false, null, null);
    else {
      await fixture.control.query('update dental.admin_notification_budget set usage_high_water=300');
      expect(await revalidate(first.worker, first.delivery.id)).toBe(false);
    }
    const before = await row(first.delivery.id), budget = await ledger();
    expect(await finish(first.worker, first.delivery.id, { kind: 'retryable', category: 'timeout' })).toBe(true);
    expect(await row(first.delivery.id)).toEqual(before); expect(await ledger()).toEqual(budget);
    expect((await attempts(first.delivery.id))[0]).toMatchObject({ result: 'retryable', safe_error: 'timeout' });
  });

  it('checks changed reachability again before HTTP without refunding its reservation', async () => {
    const { admins: [admin] } = await queue(); const first = await started(), before = await ledger();
    await fixture.control.query('update dental.line_reachability set reachable=false where provider=$1 and subject=$2', [admin.provider, admin.recipient]);
    expect(await revalidate(first.worker, first.delivery.id)).toBe(false);
    expect(await row(first.delivery.id)).toMatchObject({ state: 'suppressed', safe_reason: 'recipient_unavailable' }); expect(await ledger()).toEqual(before);
  });

  it('will not reclaim an uncertain attempt after the first-attempt retry-key horizon', async () => {
    await queue(); const first = await started();
    // This narrow synthetic state independently tests the retry-key fence, even
    // if an imported event has a later event TTL than its first outbound attempt.
    await fixture.control.query("update dental.admin_booking_deliveries set first_attempt_at=dental.clock_now()-interval '24 hours' where id=$1", [first.delivery.id]);
    await fixture.base.setClock('2026-10-08T05:01:00Z'); expect(await claim()).toBeNull();
    expect(await row(first.delivery.id)).toMatchObject({ state: 'failed', safe_reason: 'unknown' }); expect((await ledger()).reservations).toHaveLength(1);
  });

  it('rejects unbounded provider details instead of saving raw error text', async () => {
    await queue(); const first = await started(), before = await attempts(first.delivery.id);
    for (const result of [
      { kind: 'permanent', category: 'Raw sensitive provider details' },
      { kind: 'permanent', error: 'Raw sensitive provider details' },
      { kind: 'accepted', requestId: 'https://provider.example/private?token=synthetic' },
      { kind: 'accepted', requestId: 'x'.repeat(129) },
    ]) {
      await expect(finish(first.worker, first.delivery.id, result)).rejects.toThrow(/VALIDATION/);
      expect(await attempts(first.delivery.id)).toEqual(before);
    }
  });


  it('rolls the reservation and attempt back when time expires after the budget helper at the attempt-write lock', async () => {
    await queue(); const worker = randomUUID(), delivery = await claim(worker), quota = await observation();
    // SHARE allows the preparation's early attempt SELECT, but blocks its later
    // UPDATE/INSERT after the private reservation helper has already returned.
    // The clock is advanced by an independent connection, so a subtransaction
    // rollback cannot itself undo the passage of trusted time.
    const result = await afterLock('lock table dental.admin_notification_attempts in share mode', [],
      client => prepareOn(client, worker, delivery!.id, quota), () => fixture.base.setClock('2026-10-08T05:01:00Z'));
    expect(result === null || ('state' in result && result.state === 'paused_quota')).toBe(true);
    expect((await ledger()).reservations).toEqual([]); expect((await ledger()).budgets[0].reserved_units).toBe('0');
    expect(await attempts(delivery!.id)).toEqual([]); expect((await row(delivery!.id)).attempt_count).toBe(0);
  });


  it('rolls a prepared attempt back if the frozen mapping changes during the final attempt-write lock', async () => {
    const { admins: [admin] } = await queue(); const worker = randomUUID(), delivery = await claim(worker), quota = await observation();
    const result = await afterLock('lock table dental.admin_notification_attempts in share mode', [],
      client => prepareOn(client, worker, delivery!.id, quota), async () => {
        await fixture.control.query('update dental.accounts set subject=$2 where id=$1', [admin.account, `U${randomUUID().replaceAll('-', '')}`]);
      });
    expect(result).toBeNull(); expect((await ledger()).reservations).toEqual([]); expect(await attempts(delivery!.id)).toEqual([]);
    expect(await row(delivery!.id)).toMatchObject({ state: 'suppressed', safe_reason: 'mapping_changed', attempt_count: 0 });
  });

});
