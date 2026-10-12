import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CombinedNotificationFixture, COMBINED_START, COMBINED_END } from '../support/combined-notification-postgres';
import { booking } from '../support/reservation-postgres';
import type { CombinedPatientEnvelope } from '../../src/worker/notifications/combined-types';
const origin = 'https://clinic.example', table = 'dental.patient_dispatch_authorizations';
let f: CombinedNotificationFixture;
const quota = (overrides: Record<string, unknown> = {}) => ({ type: 'limited', value: 300, totalUsage: 0, observedAt: COMBINED_START, ...overrides });
async function installed() {
    expect((await f.control.query("select to_regprocedure('dental.prepare_patient_dispatch(uuid,uuid,text,jsonb)') is not null as present")).rows[0].present, 'Patient preparation must enforce shared authorization.').toBe(true);
}
async function queue() {
    await installed();
    const operator = await f.account();
    await f.policy(operator);
    const admin = await f.admin();
    const actor = await f.account(), provider = 'line:synthetic-patient', recipient = 'U' + actor.replaceAll('-', '');
    await f.control.query('update dental.accounts set provider=$2,subject=$3 where id=$1', [actor, provider, recipient]);
    await f.control.query("insert into dental.line_reachability(provider,subject,reachable,event_at,event_id,updated_at) values($1,$2,true,dental.clock_now(),'01J00000000000000000000000',dental.clock_now())", [provider, recipient]);
    const appointment = await f.base.reserve(actor, randomUUID(), booking(await f.base.patient(actor), '2026-10-14'));
    await f.base.call('select dental.decide($1,$2,1,\'approve\',\'Synthetic approval\') as result', [admin.account, appointment.id]);
    await f.operatorCall('select dental.set_admin_notification_budget($1,0,$2,$3,300,0,true,\'Synthetic dispatch\') as result', [operator, COMBINED_START, COMBINED_END]);
    const { rows: [event] } = await f.control.query("select * from dental.outbox where appointment_id=$1 and type='approval'", [appointment.id]);
    return { operator, admin, actor, provider, recipient, appointment, event };
}
async function claim(worker = randomUUID()) {
    return f.base.call<{
        id: string;
    } | null>('select dental.claim_patient_event($1) as result', [worker]);
}
async function prepare(worker: string, event: string, observation: unknown = quota()) {
    return f.base.call<CombinedPatientEnvelope | {
        state: 'paused_quota';
    } | null>('select dental.prepare_patient_dispatch($1,$2,$3,$4::jsonb) as result', [worker, event, origin, JSON.stringify(observation)]);
}
async function revalidate(worker: string, event: string) {
    return f.base.call<boolean>('select dental.revalidate_patient_dispatch($1,$2) as result', [worker, event]);
}
async function finish(worker: string, event: string, result: unknown) {
    return f.base.call<boolean>('select dental.finish_dispatch($1,$2,$3::jsonb) as result', [worker, event, JSON.stringify(result)]);
}
async function started() {
    const q = await queue(), worker = randomUUID();
    expect((await claim(worker))?.id).toBe(q.event.id);
    const prepared = await prepare(worker, q.event.id);
    expect(prepared).not.toBeNull();
    expect(prepared).not.toHaveProperty('state');
    return { ...q, worker, prepared: prepared as CombinedPatientEnvelope };
}
async function counts() {
    return (await f.control.query(`select (select count(*)::int from dental.notification_attempts) as attempts,(select count(*)::int from dental.patient_notification_budget_reservations) as reservations,(select reserved_units::int from dental.admin_notification_budget order by version desc limit 1) as reserved`)).rows[0];
}
async function row(id: string) {
    return (await f.control.query('select * from dental.outbox where id=$1', [id])).rows[0];
}
async function afterLock<T>(lock: string, params: unknown[], run: (client: pg.Client) => Promise<T>, blocked: () => Promise<void>) {
    const holder = await f.database.connect(), worker = await f.session();
    let pending: Promise<T> | undefined;
    try {
        await holder.query('begin');
        await holder.query(lock, params);
        const { rows: [{ pid }] } = await holder.query('select pg_backend_pid() as pid');
        pending = run(worker.client);
        await f.base.waitForLockWaiters([worker.pid], pid);
        await blocked();
        await holder.query('commit');
        const result = await pending;
        await worker.client.query('commit');
        return result;
    }
    finally {
        await holder.query('rollback');
        await pending?.catch(() => {
        });
        await f.closeSession(worker);
        await holder.end();
    }
}
describe('real PG17 combined patient dispatch', () => {
    beforeAll(async () => {
        f = await CombinedNotificationFixture.create();
    });
    afterEach(async () => {
        if (!f)
            return;
        if ((await f.control.query('select to_regclass($1) is not null as present', [table])).rows[0].present)
            await f.control.query(`delete from ${table}`);
        await f.control.query('delete from dental.patient_notification_budget_reservations;delete from dental.admin_notification_budget_reservations;delete from dental.admin_notification_budget');
        await f.control.query("delete from dental.line_reachability where provider='line:synthetic-patient'");
        await f.reset();
    });
    afterAll(async () => {
        await f?.close();
    });
    it('installs hardened backend-only preparation/revalidation and private authorization metadata', async () => {
        await installed();
        for (const signature of ['dental.prepare_patient_dispatch(uuid,uuid,text,jsonb)', 'dental.revalidate_patient_dispatch(uuid,uuid)']) {
            expect((await f.control.query("select p.prosecdef,p.provolatile,p.proconfig,has_function_privilege('dental_runtime',p.oid,'EXECUTE') as runtime from pg_proc p where oid=$1::regprocedure", [signature])).rows[0]).toEqual({ prosecdef: true, provolatile: 'v', proconfig: ['search_path=""'], runtime: true });
            for (const role of ['anon', 'authenticated', 'authenticator', 'service_role'])
                expect((await f.control.query('select has_function_privilege($1,$2,\'EXECUTE\') as execute', [role, signature])).rows[0].execute).toBe(false);
        }
        for (const role of ['anon', 'authenticated', 'authenticator', 'service_role', 'dental_backend', 'dental_runtime'])
            expect((await f.control.query("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') as access", [role, table])).rows[0].access).toBe(false);
    });
    it('legacyUnbudgetedPrepareUnavailableToRuntime', async () => {
        for (const role of ['dental_backend', 'dental_runtime'])
            for (const signature of ['dental.claim_events(uuid,integer)', 'dental.prepare_dispatch(uuid,uuid,text)', 'dental.claim_restricted_event(uuid,uuid,uuid)', 'dental.prepare_restricted_dispatch(uuid,uuid,uuid,text)'])
                expect((await f.control.query("select has_function_privilege($1,$2,'EXECUTE') as execute", [role, signature])).rows[0].execute).toBe(false);
        await expect(f.base.call('select dental.claim_events($1,1) as result', [randomUUID()])).rejects.toThrow(/permission denied/i);
    });
    it('prepares unchanged envelope, one budget unit and attempt atomically', async () => {
        const q = await started();
        expect(q.prepared).toMatchObject({ provider: q.provider, recipient: q.recipient, date: '2026-10-14', status: 'approved', reference: q.appointment.reference, manageUrl: origin + '/appointments', payloadVersion: 1 });
        expect(Date.parse(q.prepared.authorizationExpiresAt)).toBe(Date.parse(COMBINED_START) + 60000);
        expect(await counts()).toEqual({ attempts: 1, reservations: 1, reserved: 1 });
        expect(await revalidate(q.worker, q.event.id)).toBe(true);
        expect(await prepare(q.worker, q.event.id)).toBeNull();
        expect(await counts()).toEqual({ attempts: 1, reservations: 1, reserved: 1 });
    });
    it.each(['missing', 'old-version'])('noEnrollmentNoHttp/oldPolicyVersionNoHttp: %s patient and admin lanes', async (mutation) => {
        const q = await queue();
        if (mutation === 'missing')
            await f.control.query('delete from dental.notification_booking_enrollments where appointment_id=$1', [q.appointment.id]);
        else
            await f.control.query('update dental.notification_booking_enrollments set policy_version=policy_version+1 where appointment_id=$1', [q.appointment.id]);
        const before = await f.queueDigest();
        expect(await claim()).toBeNull();
        expect(await f.base.call('select dental.claim_admin_delivery($1) as result', [randomUUID()])).toBeNull();
        expect(await f.queueDigest()).toEqual(before);
        const worker = randomUUID();
        await f.control.query("update dental.outbox set state='leased',lease_owner=$2,lease_until=dental.clock_now()+interval '1 minute' where id=$1", [q.event.id, worker]);
        expect(await prepare(worker, q.event.id)).toBeNull();
        const { rows: [d] } = await f.control.query('select id from dental.admin_booking_deliveries limit 1');
        await f.control.query("update dental.admin_booking_deliveries set state='leased',lease_owner=$2,lease_until=dental.clock_now()+interval '1 minute' where id=$1", [d.id, worker]);
        expect(await f.base.call('select dental.prepare_admin_dispatch($1,$2,$3,$4::jsonb) as result', [worker, d.id, 'https://tooth-talk-staging.tooth-talk-staging-f7ff4a96.workers.dev', JSON.stringify(quota())])).toBeNull();
        expect(await counts()).toEqual({ attempts: 0, reservations: 0, reserved: 0 });
    });
    it.each([null, quota({ observedAt: '2026-10-08T04:58:59Z' }), quota({ observedAt: '2026-10-08T05:00:01Z' }), quota({ type: 'unlimited' }), quota({ totalUsage: 300 })])('quotaPauseDoesNotCreateAttempt: %j', async (observation) => {
        const q = await queue(), worker = randomUUID();
        await claim(worker);
        expect(await prepare(worker, q.event.id, observation)).toEqual({ state: 'paused_quota' });
        expect(await counts()).toEqual({ attempts: 0, reservations: 0, reserved: 0 });
        expect(await row(q.event.id)).toMatchObject({ state: 'retry', due_at: new Date('2026-10-08T05:15:00Z'), lease_owner: null });
        await f.base.setClock('2026-10-08T05:14:59Z');
        expect(await claim()).toBeNull();
    });
    it('cancellationVersionMismatchSuppresses before attempt', async () => {
        const q = await queue(), worker = randomUUID();
        await claim(worker);
        await f.base.call('select dental.cancel($1,$2,2) as result', [q.actor, q.appointment.id]);
        expect(await prepare(worker, q.event.id)).toBeNull();
        expect(await row(q.event.id)).toMatchObject({ state: 'suppressed', attempt_count: 0 });
        expect(await counts()).toEqual({ attempts: 0, reservations: 0, reserved: 0 });
    });
    it('revokedReachabilityNoHttp after preparation without refund', async () => {
        const q = await started();
        await f.control.query('update dental.line_reachability set reachable=false where provider=$1 and subject=$2', [q.provider, q.recipient]);
        expect(await revalidate(q.worker, q.event.id)).toBe(false);
        expect(await row(q.event.id)).toMatchObject({ state: 'failed', failure_category: 'recipient_unavailable' });
        expect(await counts()).toEqual({ attempts: 1, reservations: 1, reserved: 1 });
    });
    it.each(['date', 'appointment', 'policy', 'budget', 'outbox', 'reachability'])('expiryDuringLockWaitNoHttp: %s', async (gate) => {
        const q = await queue(), worker = randomUUID();
        await claim(worker);
        const locks: Record<string, [
            string,
            unknown[]
        ]> = { date: ['select date from dental.clinic_dates where date=$1 for update', [q.appointment.date]], appointment: ['select id from dental.appointments where id=$1 for update', [q.appointment.id]], policy: ['select singleton from dental.admin_notification_policy for update', []], budget: ["select pg_advisory_xact_lock(hashtextextended('dental.admin-budget',0))", []], outbox: ['select id from dental.outbox where id=$1 for update', [q.event.id]], reachability: ['select provider from dental.line_reachability where provider=$1 and subject=$2 for update', [q.provider, q.recipient]] };
        const [sql, params] = locks[gate];
        expect(await afterLock(sql, params, async (client) => (await client.query('select dental.prepare_patient_dispatch($1,$2,$3,$4::jsonb) as result', [worker, q.event.id, origin, JSON.stringify(quota())])).rows[0].result, async () => {
            await f.base.setClock('2026-10-08T05:01:00Z');
        })).toBeNull();
        expect(await counts()).toEqual({ attempts: 0, reservations: 0, reserved: 0 });
    });
    it('crashAfterAcceptanceReusesKey and frozen fields with one credit', async () => {
        const q = await started();
        await f.base.setClock('2026-10-08T05:01:00Z');
        expect(await claim()).toBeNull();
        await f.base.setClock('2026-10-08T05:02:00Z');
        const worker = randomUUID();
        expect((await claim(worker))?.id).toBe(q.event.id);
        const next = await prepare(worker, q.event.id, quota({ observedAt: '2026-10-08T05:02:00Z' })) as CombinedPatientEnvelope;
        const frozen = (e: CombinedPatientEnvelope) => ({ recipient: e.recipient, provider: e.provider, date: e.date, reference: e.reference, status: e.status, manageUrl: e.manageUrl, payloadVersion: e.payloadVersion, retryKey: e.event.retryKey });
        expect(frozen(next)).toEqual(frozen(q.prepared));
        expect(await counts()).toEqual({ attempts: 2, reservations: 1, reserved: 1 });
        expect(await finish(worker, q.event.id, { kind: 'accepted' })).toBe(true);
        expect(await finish(q.worker, q.event.id, { kind: 'retryable', category: 'timeout' })).toBe(false);
        expect(await row(q.event.id)).toMatchObject({ state: 'accepted', attempt_count: 2 });
    });
    it('staleFinishCannotOverwrite a newer attempt', async () => {
        const q = await started();
        await finish(q.worker, q.event.id, { kind: 'retryable', category: 'timeout' });
        await f.base.setClock('2026-10-08T05:01:00Z');
        const worker = randomUUID();
        await claim(worker);
        await prepare(worker, q.event.id, quota({ observedAt: '2026-10-08T05:01:00Z' }));
        expect(await finish(q.worker, q.event.id, { kind: 'accepted' })).toBe(false);
        expect(await row(q.event.id)).toMatchObject({ state: 'leased', lease_owner: worker, attempt_count: 2 });
    });
    it('quota expiry revalidation pauses and permits a fresh worker after fifteen minutes', async () => {
        const q = await queue(), worker = randomUUID();
        await claim(worker);
        expect(await prepare(worker, q.event.id, quota({ observedAt: '2026-10-08T04:59:30Z' }))).not.toBeNull();
        await f.base.setClock('2026-10-08T05:00:30Z');
        expect(await revalidate(worker, q.event.id)).toBe(false);
        expect(await row(q.event.id)).toMatchObject({ state: 'retry', due_at: new Date('2026-10-08T05:15:30Z'), attempt_count: 1 });
        await f.base.setClock('2026-10-08T05:15:30Z');
        const next = randomUUID();
        expect((await claim(next))?.id).toBe(q.event.id);
        expect(await prepare(next, q.event.id, quota({ observedAt: '2026-10-08T05:15:30Z' }))).not.toBeNull();
        expect(await counts()).toEqual({ attempts: 2, reservations: 1, reserved: 1 });
    });
    it('admin revalidation also fences changed enrollment', async () => {
        const q = await queue(), worker = randomUUID(), delivery = await f.base.call<{
            id: string;
        }>('select dental.claim_admin_delivery($1) as result', [worker]);
        expect(await f.base.call('select dental.prepare_admin_dispatch($1,$2,$3,$4::jsonb) as result', [worker, delivery.id, 'https://tooth-talk-staging.tooth-talk-staging-f7ff4a96.workers.dev', JSON.stringify(quota())])).not.toBeNull();
        await f.control.query('update dental.notification_booking_enrollments set policy_version=policy_version+1 where appointment_id=$1', [q.appointment.id]);
        expect(await f.base.call('select dental.revalidate_admin_dispatch($1,$2) as result', [worker, delivery.id])).toBe(false);
    });
    it('final attempt lock wait rolls back credit, attempt, authorization and frozen fields', async () => {
        const q = await queue(), worker = randomUUID();
        await claim(worker);
        const barrier = await f.database.connect(), session = await f.session();
        let pending: Promise<pg.QueryResult> | undefined;
        const key = 'synthetic-task3-attempt-' + q.event.id;
        try {
            await f.control.query(`create function public.synthetic_task3_attempt_wait() returns trigger language plpgsql security definer set search_path='' as $body$ begin perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(TG_ARGV[0],0));return NEW;end;$body$`);
            await f.control.query(`create trigger synthetic_task3_attempt_wait before insert on dental.notification_attempts for each row execute function public.synthetic_task3_attempt_wait('${key}')`);
            await barrier.query('begin');
            await barrier.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
            const { rows: [{ pid }] } = await barrier.query('select pg_backend_pid() as pid');
            pending = session.client.query('select dental.prepare_patient_dispatch($1,$2,$3,$4::jsonb) as result', [worker, q.event.id, origin, JSON.stringify(quota({ totalUsage: 17 }))]);
            await f.base.waitForLockWaiters([session.pid], pid);
            await f.base.setClock('2026-10-08T05:01:00Z');
            await barrier.query('commit');
            expect((await pending).rows[0].result).toBeNull();
            await session.client.query('commit');
            expect(await counts()).toEqual({ attempts: 0, reservations: 0, reserved: 0 });
            expect(await row(q.event.id)).toMatchObject({ attempt_count: 0, first_attempt_at: null, dispatch_recipient: null, dispatch_provider: null, dispatch_reference: null, dispatch_status: null, dispatch_manage_url: null });
            expect((await f.control.query(`select count(*)::int as count from ${table}`)).rows[0].count).toBe(0);
            expect((await f.control.query('select usage_high_water::int as usage from dental.admin_notification_budget')).rows[0].usage).toBe(17);
        }
        finally {
            await barrier.query('rollback');
            await pending?.catch(() => {
            });
            await f.closeSession(session);
            await barrier.end();
            await f.control.query('drop trigger if exists synthetic_task3_attempt_wait on dental.notification_attempts;drop function if exists public.synthetic_task3_attempt_wait()');
        }
    });
    it('preparation quota deadline of exactly sixty seconds old creates no attempt or credit', async () => {
        const q = await queue(), worker = randomUUID();
        await claim(worker);
        expect(await prepare(worker, q.event.id, quota({ observedAt: '2026-10-08T04:59:00Z' }))).toEqual({ state: 'paused_quota' });
        expect(await counts()).toEqual({ attempts: 0, reservations: 0, reserved: 0 });
    });
    it.each(['event', 'budget', 'policy'])('bounds preparation by the earlier %s deadline', async (gate) => {
        const q = await queue(), worker = randomUUID();
        if (gate === 'event')
            await f.control.query("update dental.outbox set expires_at=dental.clock_now()+interval '20 seconds' where id=$1", [q.event.id]);
        if (gate === 'budget')
            await f.control.query("update dental.admin_notification_budget set verified_until=dental.clock_now()+interval '20 seconds'");
        if (gate === 'policy') {
            await f.base.setClock('2026-10-15T04:59:40Z');
            await f.control.query("update dental.admin_notification_budget set verified_until='2026-10-15T06:00:00Z'");
            await f.control.query("update dental.outbox set expires_at='2026-10-15T06:00:00Z' where id=$1", [q.event.id]);
        }
        await claim(worker);
        const now = (await f.control.query('select dental.clock_now() as now')).rows[0].now as Date;
        const value = await prepare(worker, q.event.id, quota({ observedAt: now.toISOString() })) as CombinedPatientEnvelope;
        expect(Date.parse(value.authorizationExpiresAt)).toBe(now.valueOf() + 20000);
        await f.base.setClock(new Date(now.valueOf() + 20000).toISOString());
        expect(await revalidate(worker, q.event.id)).toBe(false);
    });
    it('patient final revalidation detects cancellation and mapping changes without refund', async () => {
        const q = await started();
        await f.control.query('update dental.appointments set version=version+1 where id=$1', [q.appointment.id]);
        expect(await revalidate(q.worker, q.event.id)).toBe(false);
        expect(await row(q.event.id)).toMatchObject({ state: 'suppressed' });
        expect(await counts()).toEqual({ attempts: 1, reservations: 1, reserved: 1 });
    });
    it('retry refuses changed server mapping instead of altering frozen fields', async () => {
        const q = await started();
        await finish(q.worker, q.event.id, { kind: 'retryable', category: 'timeout' });
        await f.control.query('update dental.accounts set subject=$2 where id=$1', [q.actor, 'U' + '0'.repeat(32)]);
        await f.base.setClock('2026-10-08T05:01:00Z');
        const next = randomUUID();
        await claim(next);
        expect(await prepare(next, q.event.id, quota({ observedAt: '2026-10-08T05:01:00Z' }))).toBeNull();
        expect(await row(q.event.id)).toMatchObject({ state: 'failed', dispatch_provider: q.provider, dispatch_recipient: q.recipient, attempt_count: 1 });
        expect(await counts()).toEqual({ attempts: 1, reservations: 1, reserved: 1 });
    });
    it('clinic cancellation retains its frozen V2 envelope', async () => {
        const q = await queue();
        await f.base.call("select dental.decide($1,$2,2,'cancel','Synthetic cancellation') as result", [q.admin.account, q.appointment.id]);
        const worker = randomUUID(), event = await claim(worker);
        expect(event).not.toBeNull();
        const value = await prepare(worker, event!.id) as CombinedPatientEnvelope;
        expect(value).toMatchObject({ event: { type: 'cancellation', appointmentVersion: 3 }, status: 'cancelled', payloadVersion: 2 });
    });
    it('admin original snapshot remains eligible after appointment cancellation', async () => {
        const q = await queue();
        await f.base.call('select dental.cancel($1,$2,2) as result', [q.actor, q.appointment.id]);
        const worker = randomUUID(), d = await f.base.call<{
            id: string;
        }>('select dental.claim_admin_delivery($1) as result', [worker]);
        expect(await f.base.call('select dental.prepare_admin_dispatch($1,$2,$3,$4::jsonb) as result', [worker, d.id, 'https://tooth-talk-staging.tooth-talk-staging-f7ff4a96.workers.dev', JSON.stringify(quota())])).toMatchObject({ reference: q.appointment.reference, payloadVersion: 1 });
    });
    it('reserve, approve, cancel, policy and renewal serialize around actual patient preparation without a cycle', async () => {
        const q = await queue(), secondActor = await f.account(), thirdActor = await f.account();
        const second = await f.base.reserve(secondActor, randomUUID(), booking(await f.base.patient(secondActor), '2026-10-14'));
        const thirdInput = booking(await f.base.patient(thirdActor), '2026-10-14');
        // Close the first epoch soon, while keeping the actual preparation valid.
        await f.control.query("update dental.admin_notification_budget set verified_until='2026-10-08T05:00:30Z'");
        const worker = randomUUID();
        await claim(worker);
        const holder = await f.database.connect(), prepareSession = await f.session(), policy = await f.database.connect(), renewal = await f.database.connect();
        const business = await Promise.all([f.session(), f.session(), f.session()]);
        const pending: Promise<pg.QueryResult>[] = [];
        try {
            await holder.query('begin');
            await holder.query('select id from dental.outbox where id=$1 for update', [q.event.id]);
            const { rows: [{ pid: holderPid }] } = await holder.query('select pg_backend_pid() as pid');
            const prep = prepareSession.client.query('select dental.prepare_patient_dispatch($1,$2,$3,$4::jsonb) as result', [worker, q.event.id, origin, JSON.stringify(quota())]);
            pending.push(prep);
            await f.base.waitForLockWaiters([prepareSession.pid], holderPid);
            await policy.query('set session authorization postgres');
            await renewal.query('set session authorization postgres');
            const policyPid = (await policy.query('select pg_backend_pid() as pid')).rows[0].pid, renewalPid = (await renewal.query('select pg_backend_pid() as pid')).rows[0].pid;
            const disable = policy.query("select dental.set_admin_notification_policy($1,2,false,null,null,'Synthetic concurrent disable') as result", [q.operator]);
            pending.push(disable);
            const renew = renewal.query("select dental.set_admin_notification_budget($1,1,'2026-10-08T05:00:30Z','2026-10-08T06:00:30Z',300,0,true,'Synthetic concurrent renewal') as result", [q.operator]);
            pending.push(renew);
            pending.push(business[0].client.query('select dental.reserve($1,$2,$3::jsonb) as result', [thirdActor, randomUUID(), JSON.stringify(thirdInput)]));
            pending.push(business[1].client.query("select dental.decide($1,$2,1,'approve','Synthetic concurrent approval') as result", [q.admin.account, second.id]));
            pending.push(business[2].client.query('select dental.cancel($1,$2,2) as result', [q.actor, q.appointment.id]));
            for (const p of pending)
                p.catch(() => {
                });
            await f.base.waitForLockWaiters([policyPid, renewalPid], prepareSession.pid);
            // PostgreSQL tuple-lock queues can put later business waiters behind earlier
            // date waiters, so inspect real waits without inventing a common direct PID.
            await f.base.waitForLockWaiters(business.map(s => s.pid));
            await f.base.setClock('2026-10-08T05:00:30Z');
            await holder.query('commit');
            expect((await prep).rows[0].result).toEqual({ state: 'paused_quota' });
            await prepareSession.client.query('commit');
            // Business sessions must commit as soon as each statement finishes: they
            // share the date key, so waiting for all before commit would be a test cycle.
            await Promise.all(pending.slice(3).map(async (p, i) => {
                await p;
                await business[i].client.query('commit');
            }));
            expect((await disable).rows[0].result).toBe(3);
            expect((await renew).rows[0].result).toBe(2);
            expect(await revalidate(worker, q.event.id)).toBe(false);
            expect(await row(q.event.id)).toMatchObject({ state: 'suppressed', attempt_count: 0 });
        }
        finally {
            await holder.query('rollback');
            await prepareSession.client.query('rollback');
            for (const s of business)
                await s.client.query('rollback');
            await Promise.allSettled(pending);
            await Promise.all([holder.end(), policy.end(), renewal.end(), f.closeSession(prepareSession), ...business.map(s => f.closeSession(s))]);
        }
    });
});
