import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { booking } from '../support/reservation-postgres';
import { AdminNotificationFixture, FIXTURE_NOW, localAdminConnection } from '../support/admin-notification-postgres';

const BUDGET_SIGNATURE = 'dental.set_admin_notification_budget(uuid,integer,timestamp with time zone,timestamp with time zone,integer,integer,boolean,text)';
const RESERVE_SIGNATURE = 'dental._reserve_admin_budget(uuid,jsonb)';
let fixture: AdminNotificationFixture;
const quota = (overrides: Record<string, unknown> = {}) => ({ type: 'limited', value: 300, totalUsage: 0, observedAt: FIXTURE_NOW, ...overrides });

async function queued(count = 1) {
  const operator = await fixture.account(); await fixture.policy(operator);
  for (let i = 0; i < count; i++) await fixture.admin();
  const actor = await fixture.account();
  await fixture.base.reserve(actor, randomUUID(), booking(await fixture.base.patient(actor)));
  const deliveries = await fixture.deliveries();
  for (const delivery of deliveries) await lease(delivery.id);
  return { operator, deliveries };
}

async function lease(delivery: string) {
  await fixture.control.query(`update dental.admin_booking_deliveries set state='leased',safe_reason=null,
    lease_owner=$2,lease_until=dental.clock_now()+interval '60 seconds',authorization_valid_until=dental.clock_now()+interval '60 seconds'
    where id=$1`, [delivery, randomUUID()]);
}

async function budgetSession(): Promise<{ client: pg.Client; pid: number }> {
  const client = await localAdminConnection();
  try {
    // A disposable superuser may assume the existing function owner. The
    // production backend never receives EXECUTE on this private helper.
    await client.query('begin; set local role dental_function_owner');
    const { rows: [identity] } = await client.query('select current_user as role,pg_backend_pid() as pid');
    expect(identity.role).toBe('dental_function_owner');
    return { client, pid: identity.pid };
  } catch (error) { await client.end(); throw error; }
}

async function reserveOn(client: pg.Client, delivery: string, observation: unknown) {
  return (await client.query('select dental._reserve_admin_budget($1,$2::jsonb) as allowed',
    [delivery, observation === undefined ? null : JSON.stringify(observation)])).rows[0].allowed as boolean;
}

async function reserve(delivery: string, ...observations: [] | [unknown]) {
  const observation = observations.length ? observations[0] : quota();
  const { client } = await budgetSession();
  try { const allowed = await reserveOn(client, delivery, observation); await client.query('commit'); return allowed; }
  finally { await client.query('rollback'); await client.end(); }
}

async function ledger() {
  return {
    epochs: (await fixture.control.query(`select epoch,version,baseline_usage::double precision as baseline_usage,
      usage_high_water::double precision as usage_high_water,reserved_units::double precision as reserved_units,
      carried_units::double precision as carried_units
      from dental.admin_notification_budget order by version`)).rows,
    reservations: (await fixture.control.query('select delivery_id,budget_epoch,units from dental.admin_notification_budget_reservations order by delivery_id')).rows,
  };
}

async function expectPaused(delivery: string, reason?: string) {
  const { rows: [row] } = await fixture.control.query(`select state,safe_reason,lease_owner,lease_until,authorization_valid_until,
    due_at>=dental.clock_now()+interval '15 minutes' as waits_fifteen_minutes from dental.admin_booking_deliveries where id=$1`, [delivery]);
  expect(row).toMatchObject({ state: 'paused_quota', lease_owner: null, lease_until: null, authorization_valid_until: null, waits_fifteen_minutes: true });
  if (reason) expect(row.safe_reason).toBe(reason);
}

async function recordPriorAttempt(delivery: string, outcome: 'in_flight' | 'timeout' | 'accepted', acceptedAt: string | null = null) {
  await fixture.control.query(`update dental.admin_booking_deliveries set state=$2,safe_reason=$3,
    lease_owner=case when $2='leased' then lease_owner else null end,
    lease_until=case when $2='leased' then lease_until else null end,
    authorization_valid_until=case when $2='leased' then authorization_valid_until else null end,
    attempt_count=1,first_attempt_at=$4,accepted_at=$5 where id=$1`,
  [delivery, outcome === 'in_flight' ? 'leased' : outcome === 'accepted' ? 'accepted' : 'retry',
    outcome === 'timeout' ? 'timeout' : null, FIXTURE_NOW, acceptedAt]);
  await fixture.control.query(`insert into dental.admin_notification_attempts(delivery_id,attempt_number,worker_id,result,started_at,finished_at,safe_error)
    values($1,1,$2,$3,$4,case when $3::text is null then null else dental.clock_now() end,$5)`,
  [delivery, randomUUID(), outcome === 'in_flight' ? null : outcome === 'accepted' ? 'accepted' : 'retryable',
    FIXTURE_NOW, outcome === 'timeout' ? 'timeout' : null]);
}

async function observeRenewalWait(blocker: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    await fixture.control.query('select pg_stat_clear_snapshot()');
    const { rows } = await fixture.control.query(`select pid,pg_blocking_pids(pid) as blockers from pg_stat_activity
      where datname=current_database() and query like 'select dental.set_admin_notification_budget(%'
        and state='active' and wait_event_type='Lock' and $1=any(pg_blocking_pids(pid))`, [blocker]);
    if (rows.length === 1) return rows[0].pid as number;
    await delay(10);
  }
  throw new Error('Did not observe renewal waiting behind the independent prior-epoch preparation transaction.');
}

// Regression target: a missing local budget fence must never leave sending
// eligible based only on a provider quota observation.
describe('real PostgreSQL conservative admin free-only budget', () => {
  beforeAll(async () => { fixture = await AdminNotificationFixture.create(); });
  afterEach(async () => { await fixture?.reset(); });
  afterAll(async () => { await fixture?.close(); });

  it('installs the private epoch ledger and operator-only budget reservation gate', async () => {
    const { rows: [installed] } = await fixture.control.query(`select
      to_regclass('dental.admin_notification_budget') is not null as budget,
      to_regclass('dental.admin_notification_budget_reservations') is not null as reservations,
      to_regprocedure($1) is not null as configure,
      to_regprocedure($2) is not null as reserve`, [BUDGET_SIGNATURE, RESERVE_SIGNATURE]);
    expect(installed).toEqual({ budget: true, reservations: true, configure: true, reserve: true });
  });

  it('preserves the original admin-only generic operator window on pristine 012', async () => {
    const operator = await fixture.account();
    expect(await fixture.policy(operator, true, FIXTURE_NOW, '2026-10-09T05:00:00Z')).toBe(2);
    expect((await fixture.control.query('select authorized_end_at from dental.admin_notification_policy')).rows[0].authorized_end_at)
      .toEqual(new Date('2026-10-09T05:00:00Z'));
  });

  it('starts without an epoch and pauses a leased delivery when verification is missing', async () => {
    const { deliveries: [delivery] } = await queued();
    expect(await ledger()).toEqual({ epochs: [], reservations: [] });
    expect(await reserve(delivery.id)).toBe(false); await expectPaused(delivery.id);
    expect(await ledger()).toEqual({ epochs: [], reservations: [] });
  });

  it('creates version one only from expected version zero, with its verified baseline intact', async () => {
    const operator = await fixture.account();
    expect(await fixture.budget(operator, { baselineUsage: 47 })).toBe(1);
    const { epochs, reservations } = await ledger();
    expect(epochs).toMatchObject([{ version: 1, baseline_usage: 47, usage_high_water: 47, reserved_units: 0, carried_units: 0 }]);
    expect(epochs[0].epoch).toMatch(/^[0-9a-f-]{36}$/); expect(reservations).toEqual([]);
    await expect(fixture.budget(operator)).rejects.toThrow(/VERSION_CONFLICT/);
    expect((await ledger()).epochs).toEqual(epochs);
  });

  it.each([
    ['unverified no-overage', { noOverageVerified: false }],
    ['zero free limit', { freeLimit: 0 }], ['paid free limit', { freeLimit: 301 }],
    ['negative baseline', { baselineUsage: -1 }], ['past start', { verifiedFrom: '2026-10-08T04:59:59Z' }],
    ['expired end', { verifiedUntil: FIXTURE_NOW }], ['infinite end', { verifiedUntil: 'infinity' }],
    ['reversed window', { verifiedFrom: '2026-10-10T05:00:00Z' }], ['missing reason', { reason: '  ' }],
  ])('rejects operator configuration with %s without creating an epoch', async (_label, overrides) => {
    const operator = await fixture.account();
    await expect(fixture.budget(operator, overrides)).rejects.toThrow(/VALIDATION/);
    expect(await ledger()).toEqual({ epochs: [], reservations: [] });
  });

  it('requires the real operator session identity even when the fixture superuser can execute', async () => {
    const operator = await fixture.account();
    await expect(fixture.control.query('select dental.set_admin_notification_budget($1,0,$2,$3,300,0,true,$4)',
      [operator, FIXTURE_NOW, '2026-10-09T05:00:00Z', 'Synthetic unauthorized session'])).rejects.toThrow(/FORBIDDEN/);
    expect((await ledger()).epochs).toEqual([]);
  });

  it('forces RLS with no direct runtime access and no mutation or deletion of reservations', async () => {
    for (const table of ['admin_notification_budget', 'admin_notification_budget_reservations']) {
      const { rows: [metadata] } = await fixture.control.query(`select r.rolname as owner,c.relrowsecurity,c.relforcerowsecurity
        from pg_class c join pg_roles r on r.oid=c.relowner where c.oid=$1::regclass`, [`dental.${table}`]);
      expect(metadata).toEqual({ owner: 'postgres', relrowsecurity: true, relforcerowsecurity: true });
      for (const role of ['anon', 'authenticated', 'authenticator', 'service_role', 'dental_backend', 'dental_runtime']) {
        const { rows: [access] } = await fixture.control.query(`select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') as table_access,
          has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') as column_access`, [role, `dental.${table}`]);
        expect(access, `${role} on ${table}`).toEqual({ table_access: false, column_access: false });
      }
      expect((await fixture.control.query("select has_table_privilege('dental_function_owner',$1,'DELETE,TRUNCATE') as can_erase", [`dental.${table}`])).rows[0].can_erase).toBe(false);
    }
    expect((await fixture.control.query("select has_table_privilege('dental_function_owner','dental.admin_notification_budget_reservations','UPDATE') as can_change")).rows[0].can_change).toBe(false);
    for (const column of ['epoch', 'version', 'verified_from', 'verified_until', 'free_limit', 'baseline_usage', 'no_overage_verified', 'carried_units']) {
      expect((await fixture.control.query("select has_column_privilege('dental_function_owner','dental.admin_notification_budget',$1,'UPDATE') as can_change", [column])).rows[0].can_change, column).toBe(false);
    }
  });

  it('keeps reserve internal and budget configuration operator-only with fixed definer search paths', async () => {
    for (const signature of [BUDGET_SIGNATURE, RESERVE_SIGNATURE]) {
      const { rows: [fn] } = await fixture.control.query(`select r.rolname as owner,p.prosecdef,p.proconfig,
        has_function_privilege('dental_function_owner',p.oid,'EXECUTE') as internal,
        has_function_privilege('dental_backend',p.oid,'EXECUTE') as backend,
        has_function_privilege('dental_runtime',p.oid,'EXECUTE') as runtime,
        has_function_privilege('postgres',p.oid,'EXECUTE') as operator
        from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=$1::regprocedure`, [signature]);
      expect(fn).toEqual({ owner: 'dental_function_owner', prosecdef: true, proconfig: ['search_path=""'], internal: true,
        backend: false, runtime: false, operator: signature === BUDGET_SIGNATURE });
      expect((await fixture.control.query("select a.privilege_type from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=$1::regprocedure and a.grantee=0", [signature])).rows).toEqual([]);
    }
    const { operator, deliveries: [delivery] } = await queued();
    await expect(fixture.base.call('select dental._reserve_admin_budget($1,$2::jsonb) as result', [delivery.id, quota()])).rejects.toMatchObject({ code: '42501' });
    await expect(fixture.base.call('select dental.set_admin_notification_budget($1,0,$2,$3,300,0,true,$4) as result',
      [operator, FIXTURE_NOW, '2026-10-09T05:00:00Z', 'Synthetic forbidden backend'])).rejects.toMatchObject({ code: '42501' });
  });

  it('reserves exactly one recipient unit and keeps the same epoch and credit through retry', async () => {
    const { operator, deliveries: [delivery] } = await queued(); await fixture.budget(operator, { baselineUsage: 299 });
    expect(await reserve(delivery.id)).toBe(true); const before = await ledger();
    expect(before.epochs[0].reserved_units).toBe(1);
    expect(before.reservations).toEqual([{ delivery_id: delivery.id, budget_epoch: before.epochs[0].epoch, units: 1 }]);
    await fixture.control.query("update dental.admin_booking_deliveries set state='retry',safe_reason='timeout',lease_owner=null,lease_until=null,authorization_valid_until=null where id=$1", [delivery.id]);
    await lease(delivery.id);
    expect(await reserve(delivery.id)).toBe(true); expect(await ledger()).toEqual(before);
  });

  it('serializes independent sessions competing for the final free unit', async () => {
    const { operator, deliveries } = await queued(2); await fixture.budget(operator, { baselineUsage: 299 });
    const [first, second] = await Promise.all([budgetSession(), budgetSession()]);
    let secondResult: Promise<boolean> | undefined;
    try {
      expect(first.pid).not.toBe(second.pid);
      expect(await reserveOn(first.client, deliveries[0].id, quota())).toBe(true);
      secondResult = reserveOn(second.client, deliveries[1].id, quota());
      await fixture.base.waitForLockWaiters([second.pid], first.pid);
      await first.client.query('commit'); expect(await secondResult).toBe(false); await second.client.query('commit');
      const state = await ledger(); expect(state.epochs[0].reserved_units).toBe(1);
      expect(state.reservations).toEqual([{ delivery_id: deliveries[0].id, budget_epoch: state.epochs[0].epoch, units: 1 }]);
      await expectPaused(deliveries[1].id, 'quota_exhausted');
    } finally {
      await first.client.query('rollback'); await secondResult?.catch(() => {});
      await second.client.query('rollback'); await Promise.all([first.client.end(), second.client.end()]);
    }
  });

  it('serializes two independent retries of one delivery into the same single credit', async () => {
    const { operator, deliveries: [delivery] } = await queued(); await fixture.budget(operator, { baselineUsage: 299 });
    const [first, second] = await Promise.all([budgetSession(), budgetSession()]); let pending: Promise<boolean> | undefined;
    try {
      expect(first.pid).not.toBe(second.pid); expect(await reserveOn(first.client, delivery.id, quota())).toBe(true);
      pending = reserveOn(second.client, delivery.id, quota()); await fixture.base.waitForLockWaiters([second.pid], first.pid);
      await first.client.query('commit'); expect(await pending).toBe(true); await second.client.query('commit');
      expect((await ledger()).reservations).toHaveLength(1); expect((await ledger()).epochs[0].reserved_units).toBe(1);
    } finally {
      await first.client.query('rollback'); await pending?.catch(() => {});
      await second.client.query('rollback'); await Promise.all([first.client.end(), second.client.end()]);
    }
  });

  it.each(['accepted', 'timeout'] as const)('never refunds a reserved credit when delivery state records %s', async outcome => {
    const { operator, deliveries } = await queued(2); await fixture.budget(operator, { freeLimit: 1 });
    expect(await reserve(deliveries[0].id)).toBe(true); const before = await ledger();
    // This stage exercises the ledger/state boundary only. Stage 4 separately
    // drives the real finish RPC; this seed does not simulate an HTTP request.
    await fixture.control.query(`update dental.admin_booking_deliveries set state=$2,safe_reason=$3,lease_owner=null,lease_until=null,
      authorization_valid_until=null,attempt_count=1,first_attempt_at=dental.clock_now(),
      accepted_at=case when $2='accepted' then dental.clock_now() else null end where id=$1`,
    [deliveries[0].id, outcome === 'accepted' ? 'accepted' : 'retry', outcome === 'accepted' ? null : 'timeout']);
    await fixture.control.query(`insert into dental.admin_notification_attempts(delivery_id,attempt_number,worker_id,result,started_at,finished_at,safe_error)
      values($1,1,$2,$3,dental.clock_now(),dental.clock_now(),$4)`,
    [deliveries[0].id, randomUUID(), outcome === 'accepted' ? 'accepted' : 'retryable', outcome === 'accepted' ? null : 'timeout']);
    expect(await reserve(deliveries[1].id)).toBe(false); expect(await ledger()).toEqual(before);
    await expectPaused(deliveries[1].id, 'quota_exhausted');
  });

  it.each([
    ['verified free ceiling', 2, 1000, 1], ['provider ceiling', 300, 2, 1], ['hard 300 ceiling', 300, 1000, 299],
  ])('uses the lowest %s even when another limit permits paid traffic', async (_label, freeLimit, apiLimit, baselineUsage) => {
    const { operator, deliveries } = await queued(2); await fixture.budget(operator, { freeLimit, baselineUsage });
    expect(await reserve(deliveries[0].id, quota({ value: apiLimit }))).toBe(true);
    expect(await reserve(deliveries[1].id, quota({ value: apiLimit }))).toBe(false);
    expect((await ledger()).epochs[0].reserved_units).toBe(1); await expectPaused(deliveries[1].id, 'quota_exhausted');
  });

  it('keeps the maximum consumption observation when later reported usage falls', async () => {
    const { operator, deliveries } = await queued(2); await fixture.budget(operator, { baselineUsage: 10 });
    expect(await reserve(deliveries[0].id, quota({ totalUsage: 299 }))).toBe(true);
    expect(await reserve(deliveries[1].id, quota({ totalUsage: 0 }))).toBe(false);
    expect((await ledger()).epochs[0]).toMatchObject({ baseline_usage: 10, usage_high_water: 299, reserved_units: 1 });
  });

  it('retains high-water evidence even when a valid observation already exhausts the budget', async () => {
    const { operator, deliveries: [delivery] } = await queued(); await fixture.budget(operator);
    expect(await reserve(delivery.id, quota({ totalUsage: 300 }))).toBe(false); await lease(delivery.id);
    expect(await reserve(delivery.id, quota({ totalUsage: 0 }))).toBe(false);
    expect((await ledger()).epochs[0]).toMatchObject({ usage_high_water: 300, reserved_units: 0 });
  });

  it('uses the greatest baseline or observed usage, rather than adding both estimates', async () => {
    const { operator, deliveries: [delivery] } = await queued(); await fixture.budget(operator, { freeLimit: 201, baselineUsage: 150 });
    expect(await reserve(delivery.id, quota({ totalUsage: 200 }))).toBe(true);
    expect((await ledger()).epochs[0]).toMatchObject({ usage_high_water: 200, reserved_units: 1 });
  });

  it('fails an existing reservation closed when new shared usage exceeds its remaining ceiling', async () => {
    const { operator, deliveries: [delivery] } = await queued(); await fixture.budget(operator);
    expect(await reserve(delivery.id)).toBe(true);
    expect(await reserve(delivery.id, quota({ totalUsage: 300 }))).toBe(false);
    expect((await ledger()).epochs[0]).toMatchObject({ usage_high_water: 300, reserved_units: 1 });
    expect((await ledger()).reservations).toHaveLength(1); await expectPaused(delivery.id, 'quota_exhausted');
  });

  const invalidObservations: [string, unknown][] = [
    ['SQL NULL', undefined], ['JSON null', null], ['array', []], ['string', 'quota'], ['empty object', {}],
    ['unlimited', quota({ type: 'unlimited' })], ['negative limit', quota({ value: -1 })],
    ['fractional limit', quota({ value: 2.5 })], ['text limit', quota({ value: '300' })],
    ['unsafe limit', quota({ value: Number.MAX_SAFE_INTEGER + 1 })], ['negative usage', quota({ totalUsage: -1 })],
    ['fractional usage', quota({ totalUsage: 0.5 })], ['text usage', quota({ totalUsage: '0' })],
    ['unsafe usage', quota({ totalUsage: Number.MAX_SAFE_INTEGER + 1 })], ['missing observation time', quota({ observedAt: null })],
    ['invalid observation time', quota({ observedAt: 'nonsense' })], ['infinite time', quota({ observedAt: 'infinity' })],
    ['future time', quota({ observedAt: '2026-10-08T05:00:00.001Z' })], ['stale time', quota({ observedAt: '2026-10-08T04:58:59.999Z' })],
  ];
  it.each(invalidObservations)('pauses safely for %s without creating or refunding a reservation', async (_label, observation) => {
    const { operator, deliveries: [delivery] } = await queued(); await fixture.budget(operator);
    expect(await reserve(delivery.id, observation)).toBe(false); await expectPaused(delivery.id, 'quota_unknown');
    expect((await ledger()).reservations).toEqual([]); expect((await ledger()).epochs[0].reserved_units).toBe(0);
  });

  it('accepts an observation exactly sixty seconds old but not one millisecond older', async () => {
    const { operator, deliveries } = await queued(2); await fixture.budget(operator);
    expect(await reserve(deliveries[0].id, quota({ observedAt: '2026-10-08T04:59:00Z' }))).toBe(true);
    expect(await reserve(deliveries[1].id, quota({ observedAt: '2026-10-08T04:58:59.999Z' }))).toBe(false);
    expect((await ledger()).epochs[0].reserved_units).toBe(1);
  });

  it('requires a fresh quota observation on every retry without refunding its old reservation', async () => {
    const { operator, deliveries: [delivery] } = await queued(); await fixture.budget(operator);
    expect(await reserve(delivery.id)).toBe(true); const before = await ledger();
    await fixture.base.setClock('2026-10-08T05:01:01Z'); await lease(delivery.id);
    expect(await reserve(delivery.id)).toBe(false); expect(await ledger()).toEqual(before);
    await expectPaused(delivery.id, 'quota_unknown');
  });

  it('does not retry a quota pause before fifteen minutes even when a fresh observation is available', async () => {
    const { operator, deliveries: [delivery] } = await queued(); await fixture.budget(operator);
    expect(await reserve(delivery.id, null)).toBe(false); const before = await fixture.deliveries();
    await fixture.base.setClock('2026-10-08T05:14:59.999Z');
    expect(await reserve(delivery.id, quota({ observedAt: '2026-10-08T05:14:59.999Z' }))).toBe(false);
    expect(await fixture.deliveries()).toEqual(before); expect((await ledger()).reservations).toEqual([]);
    await fixture.base.setClock('2026-10-08T05:15:00Z');
    expect(await reserve(delivery.id, quota({ observedAt: '2026-10-08T05:15:00Z' }))).toBe(true);
    expect((await ledger()).epochs[0].reserved_units).toBe(1);
  });

  it.each([
    ['future', { verifiedFrom: '2026-10-08T06:00:00Z' }, FIXTURE_NOW],
    ['expired', { verifiedUntil: '2026-10-08T06:00:00Z' }, '2026-10-08T06:00:00Z'],
  ])('pauses against a %s epoch even with a fresh available provider quota', async (_label, settings, now) => {
    const { operator, deliveries: [delivery] } = await queued(); await fixture.budget(operator, settings);
    await fixture.base.setClock(now); await lease(delivery.id);
    expect(await reserve(delivery.id, quota({ observedAt: now }))).toBe(false); await expectPaused(delivery.id);
    expect((await ledger()).reservations).toEqual([]);
  });

  it('rechecks trusted time after waiting for the epoch row lock', async () => {
    const { operator, deliveries: [delivery] } = await queued(); await fixture.budget(operator);
    const holder = await localAdminConnection(), worker = await budgetSession(); let pending: Promise<boolean> | undefined;
    try {
      await holder.query('begin; select epoch from dental.admin_notification_budget for update');
      const { rows: [{ pid }] } = await holder.query('select pg_backend_pid() as pid');
      pending = reserveOn(worker.client, delivery.id, quota()); await fixture.base.waitForLockWaiters([worker.pid], pid);
      await fixture.base.setClock('2026-10-08T05:01:01Z'); await holder.query('commit');
      expect(await pending).toBe(false); await worker.client.query('commit'); await expectPaused(delivery.id, 'quota_unknown');
      expect((await ledger()).reservations).toEqual([]);
    } finally {
      await holder.query('rollback'); await pending?.catch(() => {}); await worker.client.query('rollback');
      await Promise.all([holder.end(), worker.client.end()]);
    }
  });

  it('refuses early renewal and does not overwrite a still-active verified epoch', async () => {
    const operator = await fixture.account(); await fixture.budget(operator); const before = await ledger();
    await expect(fixture.budget(operator, { expectedVersion: 1 })).rejects.toThrow(/VALIDATION|BUDGET_ACTIVE|UNAVAILABLE/);
    expect(await ledger()).toEqual(before);
  });

  it('appends a reverified epoch after expiry without transferring an old delivery reservation', async () => {
    const { operator, deliveries } = await queued(2); await fixture.budget(operator, { verifiedUntil: '2026-10-08T06:00:00Z' });
    expect(await reserve(deliveries[0].id)).toBe(true); const old = await ledger();
    await fixture.base.setClock('2026-10-08T06:00:00Z');
    expect(await fixture.budget(operator, { expectedVersion: 1, verifiedFrom: '2026-10-08T06:00:00Z' })).toBe(2);
    await lease(deliveries[0].id); await lease(deliveries[1].id);
    const observation = quota({ observedAt: '2026-10-08T06:00:00Z' });
    expect(await reserve(deliveries[0].id, observation)).toBe(false);
    expect(await reserve(deliveries[1].id, observation)).toBe(true);
    const after = await ledger(); expect(after.epochs).toHaveLength(2); expect(after.epochs[0]).toEqual(old.epochs[0]);
    expect(after.epochs[1]).toMatchObject({ version: 2, reserved_units: 1 }); expect(after.epochs[1].epoch).not.toBe(old.epochs[0].epoch);
    expect(after.reservations).toContainEqual(old.reservations[0]);
    expect(after.reservations).toContainEqual({ delivery_id: deliveries[1].id, budget_epoch: after.epochs[1].epoch, units: 1 });
  });

  it('does not reset or renew an exhausted ledger merely because a calendar month changes', async () => {
    const start = '2026-10-31T23:59:00Z'; await fixture.base.setClock(start);
    const operator = await fixture.account(); await fixture.policy(operator, true, start, '2026-11-02T00:00:00Z');
    await fixture.admin(); const actor = await fixture.account();
    await fixture.base.reserve(actor, randomUUID(), booking(await fixture.base.patient(actor), '2026-11-03'));
    const [delivery] = await fixture.deliveries();
    await fixture.budget(operator, { baselineUsage: 300, verifiedFrom: start, verifiedUntil: '2026-12-01T00:00:00Z' });
    const before = await ledger(); await fixture.base.setClock('2026-11-01T00:00:00Z'); await lease(delivery.id);
    expect(await reserve(delivery.id, quota({ observedAt: '2026-11-01T00:00:00Z', totalUsage: 0 }))).toBe(false);
    expect(await ledger()).toEqual(before); await expectPaused(delivery.id, 'quota_exhausted');
  });

  it('enforces one reservation per delivery, exactly one unit, and an existing epoch', async () => {
    const { operator, deliveries } = await queued(2); await fixture.budget(operator);
    expect(await reserve(deliveries[0].id)).toBe(true); const before = await ledger(), epoch = before.epochs[0].epoch;
    await expect(fixture.control.query('insert into dental.admin_notification_budget_reservations(delivery_id,budget_epoch,created_at) values($1,$2,dental.clock_now())',
      [deliveries[0].id, epoch])).rejects.toMatchObject({ code: '23505' });
    await expect(fixture.control.query('insert into dental.admin_notification_budget_reservations(delivery_id,budget_epoch,units,created_at) values($1,$2,2,dental.clock_now())',
      [deliveries[1].id, epoch])).rejects.toMatchObject({ code: '23514' });
    await expect(fixture.control.query('insert into dental.admin_notification_budget_reservations(delivery_id,budget_epoch,created_at) values($1,$2,dental.clock_now())',
      [deliveries[1].id, randomUUID()])).rejects.toMatchObject({ code: '23503' });
    expect(await ledger()).toEqual(before);
  });

  // Regression target: renewal must not treat estimated new-period usage as
  // proof that a previously initiated but unresolved request used old-period
  // quota. These fixture records do not initiate an external provider request.
  it.each(['in_flight', 'timeout'] as const)('carries one prior %s uncertainty into the next verified epoch without moving its reservation', async outcome => {
    const { operator, deliveries } = await queued(3);
    await fixture.budget(operator, { freeLimit: 2, verifiedUntil: '2026-10-08T06:00:00Z' });
    expect(await reserve(deliveries[0].id)).toBe(true); await recordPriorAttempt(deliveries[0].id, outcome);
    const before = await ledger(); await fixture.base.setClock('2026-10-08T06:00:00Z');
    await fixture.budget(operator, { expectedVersion: 1, verifiedFrom: '2026-10-08T06:00:00Z', freeLimit: 2 });
    await lease(deliveries[1].id); await lease(deliveries[2].id);
    const observation = quota({ observedAt: '2026-10-08T06:00:00Z', totalUsage: 0 });
    expect(await reserve(deliveries[1].id, observation)).toBe(true);
    expect(await reserve(deliveries[2].id, observation), 'One old uncertain recipient still consumes the new free-only allowance.').toBe(false);
    const after = await ledger(); expect(after.epochs[0]).toEqual(before.epochs[0]);
    expect(after.reservations).toContainEqual(before.reservations[0]);
    expect(after.epochs[1]).toMatchObject({ reserved_units: 1, carried_units: 1 }); expect(after.reservations).toHaveLength(2);
    await expectPaused(deliveries[2].id, 'quota_exhausted');
  });

  it('does not carry a known acceptance recorded strictly before the previous epoch boundary', async () => {
    const { operator, deliveries } = await queued(2);
    await fixture.budget(operator, { freeLimit: 1, verifiedUntil: '2026-10-08T06:00:00Z' });
    expect(await reserve(deliveries[0].id)).toBe(true);
    await fixture.base.setClock('2026-10-08T05:59:59.999Z');
    await recordPriorAttempt(deliveries[0].id, 'accepted', '2026-10-08T05:59:59.999Z');
    await fixture.base.setClock('2026-10-08T06:00:00Z');
    await fixture.budget(operator, { expectedVersion: 1, verifiedFrom: '2026-10-08T06:00:00Z', freeLimit: 1 });
    await lease(deliveries[1].id);
    expect(await reserve(deliveries[1].id, quota({ observedAt: '2026-10-08T06:00:00Z' }))).toBe(true);
    expect((await ledger()).epochs[1]).toMatchObject({ reserved_units: 1, carried_units: 0 });
  });

  it('does not carry an unused reservation when no attempt was ever initiated', async () => {
    const { operator, deliveries } = await queued(2);
    await fixture.budget(operator, { freeLimit: 1, verifiedUntil: '2026-10-08T06:00:00Z' });
    expect(await reserve(deliveries[0].id)).toBe(true); await fixture.base.setClock('2026-10-08T06:00:00Z');
    await fixture.budget(operator, { expectedVersion: 1, verifiedFrom: '2026-10-08T06:00:00Z', freeLimit: 1 });
    await lease(deliveries[1].id);
    expect(await reserve(deliveries[1].id, quota({ observedAt: '2026-10-08T06:00:00Z' }))).toBe(true);
    expect((await ledger()).epochs[1]).toMatchObject({ carried_units: 0, reserved_units: 1 });
    expect((await ledger()).reservations).toHaveLength(2);
  });

  it('carries an acceptance at the exact epoch boundary because old-period consumption is not established', async () => {
    const { operator, deliveries } = await queued(2);
    await fixture.budget(operator, { freeLimit: 1, verifiedUntil: '2026-10-08T06:00:00Z' });
    expect(await reserve(deliveries[0].id)).toBe(true); await fixture.base.setClock('2026-10-08T06:00:00Z');
    await recordPriorAttempt(deliveries[0].id, 'accepted', '2026-10-08T06:00:00Z');
    await fixture.budget(operator, { expectedVersion: 1, verifiedFrom: '2026-10-08T06:00:00Z', freeLimit: 1 });
    await lease(deliveries[1].id);
    expect(await reserve(deliveries[1].id, quota({ observedAt: '2026-10-08T06:00:00Z' }))).toBe(false);
    expect((await ledger()).epochs[1].reserved_units).toBe(0); await expectPaused(deliveries[1].id, 'quota_exhausted');
  });

  it.each(['unresolved', 'accepted_later'] as const)('retains %s carry across later renewals even when intervening epochs send nothing', async outcome => {
    const { operator, deliveries } = await queued(2);
    await fixture.budget(operator, { freeLimit: 1, verifiedUntil: '2026-10-08T06:00:00Z' });
    expect(await reserve(deliveries[0].id)).toBe(true); await recordPriorAttempt(deliveries[0].id, 'timeout');
    const original = (await ledger()).reservations[0]; await fixture.base.setClock('2026-10-08T06:00:00Z');
    await fixture.budget(operator, { expectedVersion: 1, verifiedFrom: '2026-10-08T06:00:00Z', verifiedUntil: '2026-10-08T07:00:00Z', freeLimit: 1 });
    if (outcome === 'accepted_later') {
      await fixture.control.query("update dental.admin_booking_deliveries set state='accepted',accepted_at='2026-10-08T06:01:00Z',safe_reason=null where id=$1", [deliveries[0].id]);
    }
    await fixture.base.setClock('2026-10-08T07:00:00Z');
    await fixture.budget(operator, { expectedVersion: 2, verifiedFrom: '2026-10-08T07:00:00Z', freeLimit: 1 });
    await lease(deliveries[1].id);
    expect(await reserve(deliveries[1].id, quota({ observedAt: '2026-10-08T07:00:00Z' }))).toBe(false);
    const after = await ledger(); expect(after.epochs).toHaveLength(3);
    expect(after.epochs.slice(1).map(row => row.reserved_units)).toEqual([0, 0]);
    expect(after.epochs.map(row => row.carried_units)).toEqual([0, 1, 1]);
    expect(after.reservations).toEqual([original]); await expectPaused(deliveries[1].id, 'quota_exhausted');
  });

  it('serializes renewal behind a prior-epoch reservation and attempt that have not committed yet', async () => {
    const { operator, deliveries } = await queued(2);
    await fixture.budget(operator, { freeLimit: 1, verifiedUntil: '2026-10-08T06:00:00Z' });
    await fixture.base.setClock('2026-10-08T05:59:59Z'); await lease(deliveries[0].id);
    const prior = await budgetSession(); let renewal: Promise<number> | undefined;
    try {
      expect(await reserveOn(prior.client, deliveries[0].id, quota({ observedAt: '2026-10-08T05:59:59Z' }))).toBe(true);
      // Stage 4 prepare will commit these together. The test-only transaction
      // holds the real helper's locks until both durable records exist.
      await prior.client.query('update dental.admin_booking_deliveries set attempt_count=1,first_attempt_at=dental.clock_now() where id=$1', [deliveries[0].id]);
      await prior.client.query(`insert into dental.admin_notification_attempts(delivery_id,attempt_number,worker_id,started_at)
        values($1,1,$2,dental.clock_now())`, [deliveries[0].id, randomUUID()]);
      await fixture.base.setClock('2026-10-08T06:00:00Z');
      renewal = fixture.budget(operator, { expectedVersion: 1, verifiedFrom: '2026-10-08T06:00:00Z', freeLimit: 1 });
      const renewingPid = await observeRenewalWait(prior.pid); expect(renewingPid).not.toBe(prior.pid);
      await fixture.base.waitForLockWaiters([renewingPid], prior.pid);
      await prior.client.query('commit'); expect(await renewal).toBe(2);
      await lease(deliveries[1].id);
      expect(await reserve(deliveries[1].id, quota({ observedAt: '2026-10-08T06:00:00Z' }))).toBe(false);
      const after = await ledger(); expect(after.epochs[1]).toMatchObject({ carried_units: 1, reserved_units: 0 });
      expect(after.reservations).toEqual([{ delivery_id: deliveries[0].id, budget_epoch: after.epochs[0].epoch, units: 1 }]);
    } finally {
      await prior.client.query('rollback'); await renewal?.catch(() => {}); await prior.client.end();
    }
  });

  it('rolls back a reservation and its counter atomically when prepare is rolled back before HTTP', async () => {
    const { operator, deliveries: [delivery] } = await queued(); await fixture.budget(operator);
    const before = await ledger(), { client } = await budgetSession();
    try { expect(await reserveOn(client, delivery.id, quota())).toBe(true); await client.query('rollback'); }
    finally { await client.end(); }
    expect(await ledger()).toEqual(before);
  });
});
