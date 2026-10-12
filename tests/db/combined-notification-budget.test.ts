import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { booking } from '../support/reservation-postgres';
import { CombinedNotificationFixture, COMBINED_END, COMBINED_START } from '../support/combined-notification-postgres';
import type { Appointment } from '../../src/shared/contracts';
import type { BudgetSettings } from '../support/admin-notification-postgres';

const PATIENT_TABLE = 'dental.patient_notification_budget_reservations';
const PATIENT_RESERVE = 'dental._reserve_patient_budget(uuid,jsonb)';
let fixture: CombinedNotificationFixture;
const quota = (overrides: Record<string, unknown> = {}) => ({ type: 'limited', value: 300, totalUsage: 0, observedAt: COMBINED_START, ...overrides });
async function installed() {
  expect((await fixture.control.query('select to_regclass($1) is not null as present', [PATIENT_TABLE])).rows[0].present,
    'Both lanes need one private shared budget reservation ledger.').toBe(true);
}
async function budget(operator: string, overrides: Partial<BudgetSettings> = {}) {
  const s = { expectedVersion: 0, verifiedFrom: COMBINED_START, verifiedUntil: '2026-10-08T06:00:00Z', freeLimit: 300,
    baselineUsage: 0, noOverageVerified: true, reason: 'Synthetic shared budget', ...overrides };
  return fixture.operatorCall<number>('select dental.set_admin_notification_budget($1,$2,$3,$4,$5,$6,$7,$8) as result',
    [operator,s.expectedVersion,s.verifiedFrom,s.verifiedUntil,s.freeLimit,s.baselineUsage,s.noOverageVerified,s.reason]);
}
async function queued(count = 1) {
  await installed(); const operator = await fixture.account(); await fixture.policy(operator); await fixture.admin();
  const patients: string[] = [];
  for (let i = 0; i < count; i++) {
    const actor = await fixture.account(); const a = await fixture.base.reserve(actor, randomUUID(), booking(await fixture.base.patient(actor), '2026-10-16'));
    const { rows: [o] } = await fixture.control.query(`insert into dental.outbox(appointment_id,appointment_version,type,due_at,expires_at,state)
      values($1,1,'approval',dental.clock_now(),dental.clock_now()+interval '1 day','queued') returning id`, [a.id]);
    patients.push(o.id);
  }
  const admins = (await fixture.inner.deliveries()).map(d => d.id); return { operator, patients, admins };
}
async function session() {
  const client = await fixture.database.connect();
  await client.query('begin; set local role dental_function_owner');
  return { client, pid: (await client.query('select pg_backend_pid() as pid')).rows[0].pid as number };
}
async function on(client: pg.Client, lane: 'patient' | 'admin', id: string, observation: unknown = quota()) {
  return (await client.query(`select dental._reserve_${lane}_budget($1,$2::jsonb) as result`, [id, observation === undefined ? null : JSON.stringify(observation)])).rows[0].result as boolean;
}
async function reserve(lane: 'patient' | 'admin', id: string, observation: unknown = quota()) {
  const s = await session();
  try { const result = await on(s.client,lane,id,observation); await s.client.query('commit'); return result; }
  finally { await s.client.query('rollback'); await s.client.end(); }
}
async function ledger() {
  return {
    epochs: (await fixture.control.query(`select epoch,version,baseline_usage::integer as baseline,usage_high_water::integer as high_water,
      reserved_units::integer as reserved,carried_units::integer as carried from dental.admin_notification_budget order by version`)).rows,
    patients: (await fixture.control.query(`select * from ${PATIENT_TABLE} order by outbox_id`)).rows,
    admins: (await fixture.control.query('select * from dental.admin_notification_budget_reservations order by delivery_id')).rows,
  };
}
async function attempted(lane: 'patient' | 'admin', id: string, acceptedAt: string | null = null) {
  const patient = lane === 'patient', table = patient ? 'outbox' : 'admin_booking_deliveries';
  await fixture.control.query(`update dental.${table} set attempt_count=1,first_attempt_at=$2,state=$3,accepted_at=$4,
    lease_owner=null,lease_until=null where id=$1`, [id,COMBINED_START,acceptedAt ? 'accepted' : 'retry',acceptedAt]);
  await fixture.control.query(`insert into dental.${patient ? 'notification_attempts' : 'admin_notification_attempts'}
    (${patient ? 'outbox_id' : 'delivery_id'},attempt_number,worker_id,started_at,finished_at,result)
    values($1,1,$2,$3,$4,$5)`, [id,randomUUID(),COMBINED_START,acceptedAt,acceptedAt ? 'accepted' : null]);
}

// Mutation targets: a separate patient ceiling, duplicate retry credits, mutable
// refunds/carry, optimistic quota parsing, early quota retries, legacy shutdown
// sweeps, and budget/policy locks acquired after delivery locks.
describe('real PostgreSQL combined notification budget', () => {
  beforeAll(async () => { fixture = await CombinedNotificationFixture.create(); });
  afterEach(async () => {
    if (!fixture) return;
    if ((await fixture.control.query('select to_regclass($1) is not null as present',[PATIENT_TABLE])).rows[0].present) {
      await fixture.control.query(`delete from ${PATIENT_TABLE}`);
    }
    await fixture.control.query('delete from dental.admin_notification_budget_reservations');
    await fixture.control.query('delete from dental.admin_notification_budget');
    await fixture.reset();
  });
  afterAll(async () => { await fixture?.close(); });

  it('installs only private immutable patient reservations and hardened internal helpers', async () => {
    await installed();
    expect((await fixture.control.query(`select r.rolname as owner,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_roles r on r.oid=c.relowner where c.oid=$1::regclass`,[PATIENT_TABLE])).rows[0])
      .toEqual({ owner:'postgres',relrowsecurity:true,relforcerowsecurity:true });
    for (const role of ['anon','authenticated','authenticator','service_role','dental_backend','dental_runtime']) {
      expect((await fixture.control.query(`select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') as table_access,
        has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') as column_access,has_function_privilege($1,$3,'EXECUTE') as execute`,[role,PATIENT_TABLE,PATIENT_RESERVE])).rows[0])
        .toEqual({table_access:false,column_access:false,execute:false});
      expect((await fixture.control.query("select has_function_privilege($1,'dental._reserve_notification_budget(text,uuid,jsonb)','EXECUTE') as execute",[role])).rows[0].execute).toBe(false);
    }
    expect((await fixture.control.query(`select has_table_privilege('dental_function_owner',$1,'SELECT,INSERT') as creates,
      has_table_privilege('dental_function_owner',$1,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') as mutates`,[PATIENT_TABLE])).rows[0])
      .toEqual({creates:true,mutates:false});
    expect((await fixture.control.query(`select p.prosecdef,p.provolatile,p.proconfig,r.rolname as owner from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=$1::regprocedure`,[PATIENT_RESERVE])).rows[0])
      .toEqual({prosecdef:true,provolatile:'v',proconfig:['search_path=""'],owner:'dental_function_owner'});
  });
  it.each(['patient','admin'] as const)('patientAndAdminCompeteForLastUnit: %s holds the real shared lock first', async first => {
    const q=await queued(); await budget(q.operator,{baselineUsage:299}); const a=await session(), b=await session();
    const second=first==='patient' ? 'admin' : 'patient', id=(lane:'patient'|'admin')=>lane==='patient' ? q.patients[0] : q.admins[0];
    let pending: Promise<boolean> | undefined;
    try {
      expect(await on(a.client,first,id(first))).toBe(true); pending=on(b.client,second,id(second));
      await fixture.base.waitForLockWaiters([b.pid],a.pid); await a.client.query('commit');
      expect(await pending).toBe(false); await b.client.query('commit');
      const l=await ledger(); expect(l.epochs[0].reserved).toBe(1); expect(l.patients.length+l.admins.length).toBe(1);
    } finally { await a.client.query('rollback'); await pending?.catch(()=>{}); await b.client.query('rollback'); await Promise.all([a.client.end(),b.client.end()]); }
  });
  it('retryKeepsOneReservation', async () => {
    const q=await queued(); await budget(q.operator); expect(await reserve('patient',q.patients[0])).toBe(true); const before=await ledger();
    await attempted('patient',q.patients[0]); expect(await reserve('patient',q.patients[0])).toBe(true); expect(await ledger()).toEqual(before);
  });
  it('timeoutNeverRefunds', async () => {
    const q=await queued(); await budget(q.operator,{freeLimit:1}); expect(await reserve('patient',q.patients[0])).toBe(true); const before=await ledger();
    await attempted('patient',q.patients[0]);
    await fixture.control.query("update dental.notification_attempts set finished_at=dental.clock_now(),result='retryable',error_category='timeout' where outbox_id=$1",[q.patients[0]]);
    expect(await reserve('admin',q.admins[0])).toBe(false); expect(await ledger()).toEqual(before);
  });
  it.each([
    ['unknown',null],['stale',quota({observedAt:'2026-10-08T04:58:59.999Z'})],['future',quota({observedAt:'2026-10-08T05:00:00.001Z'})],
    ['unlimited',quota({type:'unlimited'})],['fractional',quota({value:1.5})],['text usage',quota({totalUsage:'0'})],
    ['JSON array',[]],['string','quota'],['empty object',{}],['negative limit',quota({value:-1})],['text limit',quota({value:'300'})],
    ['unsafe limit',quota({value:Number.MAX_SAFE_INTEGER+1})],['negative usage',quota({totalUsage:-1})],
    ['fractional usage',quota({totalUsage:0.5})],['unsafe usage',quota({totalUsage:Number.MAX_SAFE_INTEGER+1})],
    ['missing observation',quota({observedAt:null})],['invalid observation',quota({observedAt:'nonsense'})],['infinite observation',quota({observedAt:'infinity'})],
  ])('staleFutureUnlimitedQuotaBlocks: %s', async (_name,observation) => {
    const q=await queued(); await budget(q.operator); expect(await reserve('patient',q.patients[0],observation)).toBe(false);
    expect((await ledger()).epochs[0].reserved).toBe(0); expect((await ledger()).patients).toEqual([]);
    expect((await fixture.control.query(`select state,failure_category,lease_owner,lease_until,due_at from dental.outbox where id=$1`,[q.patients[0]])).rows[0])
      .toEqual({state:'retry',failure_category:'quota',lease_owner:null,lease_until:null,due_at:new Date('2026-10-08T05:15:00Z')});
    expect((await fixture.control.query('select count(*)::integer as count from dental.notification_attempts')).rows[0].count).toBe(0);
  });
  it('never rechecks a patient quota pause before fifteen minutes', async () => {
    const q=await queued(); await budget(q.operator); expect(await reserve('patient',q.patients[0],null)).toBe(false); const before=await fixture.queueDigest();
    await fixture.base.setClock('2026-10-08T05:14:59.999Z'); expect(await reserve('patient',q.patients[0],quota({observedAt:'2026-10-08T05:14:59.999Z'}))).toBe(false);
    expect(await fixture.queueDigest()).toEqual(before); await fixture.base.setClock('2026-10-08T05:15:00Z');
    expect(await reserve('patient',q.patients[0],quota({observedAt:'2026-10-08T05:15:00Z'}))).toBe(true);
  });
  it('lowerUsageDoesNotReset', async () => {
    const q=await queued(); await budget(q.operator,{baselineUsage:10}); expect(await reserve('patient',q.patients[0],quota({totalUsage:299}))).toBe(true);
    expect(await reserve('admin',q.admins[0],quota({totalUsage:0}))).toBe(false); expect((await ledger()).epochs[0]).toMatchObject({baseline:10,high_water:299,reserved:1});
  });
  it.each([
    ['verified free ceiling',2,1000,1],['provider ceiling',300,2,1],['hard 300 ceiling',300,1000,299],
  ])('both lanes obey the lowest %s', async (_name,freeLimit,apiLimit,baselineUsage) => {
    const q=await queued(); await budget(q.operator,{freeLimit,baselineUsage});
    expect(await reserve('patient',q.patients[0],quota({value:apiLimit}))).toBe(true);
    expect(await reserve('admin',q.admins[0],quota({value:apiLimit}))).toBe(false); expect((await ledger()).epochs[0].reserved).toBe(1);
  });
  it('uses the greatest baseline or observation without adding both estimates', async () => {
    const q=await queued(); await budget(q.operator,{freeLimit:201,baselineUsage:150});
    expect(await reserve('patient',q.patients[0],quota({totalUsage:200}))).toBe(true);
    expect((await ledger()).epochs[0]).toMatchObject({baseline:150,high_water:200,reserved:1});
  });
  it('retains one reservation when a fresh retry observation exhausts the ceiling', async () => {
    const q=await queued(); await budget(q.operator); expect(await reserve('patient',q.patients[0])).toBe(true); const before=await ledger();
    expect(await reserve('patient',q.patients[0],quota({totalUsage:300}))).toBe(false);
    const after=await ledger(); expect(after.patients).toEqual(before.patients); expect(after.epochs[0]).toMatchObject({high_water:300,reserved:1});
    expect((await fixture.control.query('select count(*)::integer as count from dental.notification_attempts')).rows[0].count).toBe(0);
  });
  it('accepts an observation exactly sixty seconds old', async () => {
    const q=await queued(); await budget(q.operator); expect(await reserve('patient',q.patients[0],quota({observedAt:'2026-10-08T04:59:00Z'}))).toBe(true);
    expect((await ledger()).epochs[0].reserved).toBe(1);
  });
  it('policy shutdown preserves enrolled terminal outcomes', async () => {
    const q=await queued(); await budget(q.operator); const terminal:string[]=[];
    const {rows:[{appointment_id:appointment}]}=await fixture.control.query('select appointment_id from dental.outbox where id=$1',[q.patients[0]]);
    for(const [i,state] of ['accepted','suppressed','failed'].entries()) {
      const {rows:[o]}=await fixture.control.query(`insert into dental.outbox(appointment_id,appointment_version,type,due_at,expires_at,state,accepted_at)
        values($1,$2,'approval',dental.clock_now(),dental.clock_now()+interval '1 day',$3,case when $3='accepted' then dental.clock_now() else null end) returning id`,[appointment,i+2,state]);
      terminal.push(o.id);
    }
    const snapshot=async()=> (await fixture.control.query('select jsonb_agg(to_jsonb(o) order by id) as rows from dental.outbox o where id=any($1::uuid[])',[terminal])).rows[0].rows;
    const before=await snapshot(); await fixture.policy(q.operator,false,null,null); expect(await snapshot()).toEqual(before);
  });
  it('renewalCarriesBothLanesOnce', async () => {
    const q=await queued(2); await budget(q.operator,{freeLimit:3});
    expect(await reserve('patient',q.patients[0])).toBe(true); expect(await reserve('admin',q.admins[0])).toBe(true);
    await attempted('patient',q.patients[0]); await attempted('admin',q.admins[0]); const original=await ledger();
    await fixture.base.setClock('2026-10-08T06:00:00Z');
    await budget(q.operator,{expectedVersion:1,verifiedFrom:'2026-10-08T06:00:00Z',verifiedUntil:'2026-10-08T07:00:00Z',freeLimit:3});
    expect(await reserve('patient',q.patients[1],quota({observedAt:'2026-10-08T06:00:00Z'}))).toBe(true);
    expect(await reserve('admin',q.admins[1],quota({observedAt:'2026-10-08T06:00:00Z'}))).toBe(false);
    await fixture.control.query("update dental.outbox set state='accepted',accepted_at='2026-10-08T06:01:00Z' where id=$1",[q.patients[0]]);
    await fixture.control.query("update dental.admin_booking_deliveries set state='accepted',accepted_at='2026-10-08T06:01:00Z' where id=$1",[q.admins[0]]);
    await fixture.base.setClock('2026-10-08T07:00:00Z'); await budget(q.operator,{expectedVersion:2,verifiedFrom:'2026-10-08T07:00:00Z',verifiedUntil:'2026-10-08T08:00:00Z',freeLimit:3});
    const after=await ledger(); expect(after.epochs.map(e=>e.carried)).toEqual([0,2,2]); expect(after.epochs[0]).toEqual(original.epochs[0]);
    expect(after.patients).toContainEqual(original.patients[0]); expect(after.admins).toEqual(original.admins);
    expect(await reserve('patient',q.patients[0],quota({observedAt:'2026-10-08T07:00:00Z'}))).toBe(false);
  });
  it.each(['2026-10-08T05:59:59.999Z','2026-10-08T06:00:00Z'])('acceptanceAtBoundaryIsCarried: %s', async acceptedAt => {
    const q=await queued(); await budget(q.operator,{freeLimit:1}); expect(await reserve('patient',q.patients[0])).toBe(true);
    await fixture.base.setClock(acceptedAt); await attempted('patient',q.patients[0],acceptedAt); await fixture.base.setClock('2026-10-08T06:00:00Z');
    await budget(q.operator,{expectedVersion:1,verifiedFrom:'2026-10-08T06:00:00Z',verifiedUntil:'2026-10-08T07:00:00Z',freeLimit:1});
    expect((await ledger()).epochs[1].carried).toBe(acceptedAt==='2026-10-08T06:00:00Z' ? 1 : 0);
    expect(await reserve('admin',q.admins[0],quota({observedAt:'2026-10-08T06:00:00Z'}))).toBe(acceptedAt!=='2026-10-08T06:00:00Z');
  });
  it('does not carry an unused patient reservation or move it to a new epoch', async () => {
    const q=await queued(); await budget(q.operator); expect(await reserve('patient',q.patients[0])).toBe(true); const original=(await ledger()).patients;
    await fixture.base.setClock('2026-10-08T06:00:00Z'); await budget(q.operator,{expectedVersion:1,verifiedFrom:'2026-10-08T06:00:00Z',verifiedUntil:'2026-10-08T07:00:00Z'});
    expect((await ledger()).epochs[1].carried).toBe(0); expect(await reserve('patient',q.patients[0],quota({observedAt:'2026-10-08T06:00:00Z'}))).toBe(false);
    expect((await ledger()).patients).toEqual(original);
  });
  it('rolls back the patient reservation and shared counter together', async () => {
    const q=await queued(); await budget(q.operator); const before=await ledger(),s=await session();
    try { expect(await on(s.client,'patient',q.patients[0])).toBe(true); await s.client.query('rollback'); } finally { await s.client.end(); }
    expect(await ledger()).toEqual(before);
  });
  it('serializes renewal behind an uncommitted patient reservation and attempt', async () => {
    const q=await queued(); await budget(q.operator,{freeLimit:1});
    await fixture.base.setClock('2026-10-08T05:59:59Z'); const prior=await session(),operator=await fixture.database.connect();
    let renewal: Promise<pg.QueryResult> | undefined;
    try {
      expect(await on(prior.client,'patient',q.patients[0],quota({observedAt:'2026-10-08T05:59:59Z'}))).toBe(true);
      await prior.client.query('update dental.outbox set attempt_count=1,first_attempt_at=dental.clock_now() where id=$1',[q.patients[0]]);
      await prior.client.query('insert into dental.notification_attempts(outbox_id,attempt_number,worker_id,started_at) values($1,1,$2,dental.clock_now())',[q.patients[0],randomUUID()]);
      await fixture.base.setClock('2026-10-08T06:00:00Z'); await operator.query('set session authorization postgres');
      const {rows:[{pid}]}=await operator.query('select pg_backend_pid() as pid');
      renewal=operator.query(`select dental.set_admin_notification_budget($1,1,'2026-10-08T06:00:00Z','2026-10-08T07:00:00Z',1,0,true,'Synthetic patient renewal') as version`,[q.operator]);
      await fixture.base.waitForLockWaiters([pid],prior.pid); await prior.client.query('commit'); expect((await renewal).rows[0].version).toBe(2);
      const l=await ledger(); expect(l.epochs[1]).toMatchObject({carried:1,reserved:0}); expect(l.patients[0].budget_epoch).toBe(l.epochs[0].epoch);
      expect(await reserve('admin',q.admins[0],quota({observedAt:'2026-10-08T06:00:00Z'}))).toBe(false);
    } finally { await prior.client.query('rollback'); await renewal?.catch(()=>{}); await Promise.all([prior.client.end(),operator.end()]); }
  });
  it('rechecks patient quota age after waiting on the independent budget row lock', async () => {
    const q=await queued(); await budget(q.operator); const holder=await fixture.database.connect(),worker=await session(); let pending:Promise<boolean>|undefined;
    try {
      await holder.query('begin; select epoch from dental.admin_notification_budget for update'); const {rows:[{pid}]}=await holder.query('select pg_backend_pid() as pid');
      pending=on(worker.client,'patient',q.patients[0]); await fixture.base.waitForLockWaiters([worker.pid],pid);
      await fixture.base.setClock('2026-10-08T05:01:01Z'); await holder.query('commit'); expect(await pending).toBe(false); await worker.client.query('commit');
      expect((await ledger()).patients).toEqual([]); expect((await fixture.control.query('select due_at from dental.outbox where id=$1',[q.patients[0]])).rows[0].due_at)
        .toEqual(new Date('2026-10-08T05:16:01Z'));
    } finally { await holder.query('rollback'); await pending?.catch(()=>{}); await worker.client.query('rollback'); await Promise.all([holder.end(),worker.client.end()]); }
  });
  it('serializes independent concurrent retries into a single patient credit', async () => {
    const q=await queued(); await budget(q.operator); const a=await session(),b=await session(); let pending:Promise<boolean>|undefined;
    try {
      expect(await on(a.client,'patient',q.patients[0])).toBe(true); pending=on(b.client,'patient',q.patients[0]);
      await fixture.base.waitForLockWaiters([b.pid],a.pid); await a.client.query('commit'); expect(await pending).toBe(true); await b.client.query('commit');
      expect((await ledger()).epochs[0].reserved).toBe(1); expect((await ledger()).patients).toHaveLength(1);
    } finally { await a.client.query('rollback'); await pending?.catch(()=>{}); await b.client.query('rollback'); await Promise.all([a.client.end(),b.client.end()]); }
  });
  it('enforces one patient reservation, one unit, and existing outbox/epoch references', async () => {
    const q=await queued(2); await budget(q.operator); expect(await reserve('patient',q.patients[0])).toBe(true); const before=await ledger(),epoch=before.epochs[0].epoch;
    await expect(fixture.control.query(`insert into ${PATIENT_TABLE}(outbox_id,budget_epoch,created_at) values($1,$2,dental.clock_now())`,[q.patients[0],epoch])).rejects.toMatchObject({code:'23505'});
    await expect(fixture.control.query(`insert into ${PATIENT_TABLE}(outbox_id,budget_epoch,units,created_at) values($1,$2,2,dental.clock_now())`,[q.patients[1],epoch])).rejects.toMatchObject({code:'23514'});
    await expect(fixture.control.query(`insert into ${PATIENT_TABLE}(outbox_id,budget_epoch,created_at) values($1,$2,dental.clock_now())`,[q.patients[1],randomUUID()])).rejects.toMatchObject({code:'23503'});
    await expect(fixture.control.query(`insert into ${PATIENT_TABLE}(outbox_id,budget_epoch,created_at) values($1,$2,dental.clock_now())`,[randomUUID(),epoch])).rejects.toMatchObject({code:'23503'});
    expect(await ledger()).toEqual(before);
  });
  it('the disposable combined fixture cleans its own patient reservation before outbox teardown', async () => {
    const q=await queued(); await budget(q.operator); expect(await reserve('patient',q.patients[0])).toBe(true);
    await fixture.reset(); expect((await ledger()).patients).toEqual([]);
  });
  it.each(['patient','admin'] as const)('policy shutdown orders enrolled approval/reminder locks against %s cancellation', async path => {
    await installed();
    // Real approval produces the normal two-row queue shape. The synthetic UUIDs
    // keep physical insertion order (approval then reminder) opposite lock order.
    const admin=await fixture.admin(),operator=await fixture.account(),actor=await fixture.account();
    await fixture.base.setClock('2026-10-08T04:59:00Z');
    const legacy=await fixture.base.reserve(actor,randomUUID(),booking(await fixture.base.patient(actor),'2026-10-16'));
    const legacyEvents=(await fixture.control.query(`insert into dental.outbox(appointment_id,appointment_version,type,due_at,expires_at)
      values($1,1,'approval',dental.clock_now(),dental.clock_now()+interval '1 day'),
        ($1,1,'reminder',dental.clock_now(),dental.clock_now()+interval '1 day') returning id`,[legacy.id])).rows.map(o=>o.id as string);
    const legacyDigest=async()=> (await fixture.control.query('select jsonb_agg(to_jsonb(o) order by id) as rows from dental.outbox o where id=any($1::uuid[])',[legacyEvents])).rows[0].rows;
    const before=await legacyDigest(); await fixture.base.setClock(COMBINED_START); await fixture.policy(operator);
    const currentActor=await fixture.account(),created=await fixture.base.reserve(currentActor,randomUUID(),booking(await fixture.base.patient(currentActor),'2026-10-16'));
    const approved=await fixture.base.call<Appointment>('select dental.decide($1,$2,$3,$4,$5) as result',[admin.account,created.id,created.version,'approve','Synthetic approved queue']);
    const low='00000000-0000-4000-8000-000000000001',high='ffffffff-ffff-4fff-8fff-fffffffffff2';
    await fixture.control.query("update dental.outbox set id=case when type='approval' then $2::uuid else $3::uuid end where appointment_id=$1",[approved.id,high,low]);
    expect((await fixture.control.query('select id,type,state from dental.outbox where appointment_id=$1 order by ctid',[approved.id])).rows)
      .toEqual([{id:high,type:'approval',state:'queued'},{id:low,type:'reminder',state:'queued'}]);
    const barrier=await fixture.database.connect(),shutdown=await fixture.database.connect(),cancellation=await fixture.session();
    type Outcome={ok:true;result:unknown}|{ok:false;sqlState:string;message:string};
    let stopping:Promise<Outcome>|undefined,cancelling:Promise<Outcome>|undefined;
    const execute=async(client:pg.Client,sql:string,params:unknown[]):Promise<Outcome>=>{
      try { const {rows:[row]}=await client.query(sql,params); await client.query('commit'); return {ok:true,result:row.result}; }
      catch(error) { await client.query('rollback'); return {ok:false,sqlState:String((error as {code?:string}).code),message:String(error)}; }
    };
    try {
      await fixture.control.query(`create function dental_test_reservations.pause_policy_high() returns trigger language plpgsql set search_path='' as $probe$
        begin
          if pg_catalog.current_setting('dental_test.policy_lock_probe',true)='yes' and new.id='${high}'::uuid and new.state='suppressed' then
            perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('dental_test.policy-shutdown-row-order',0));
          end if;
          return new;
        end;
        $probe$;
        create trigger synthetic_policy_high_barrier before update on dental.outbox for each row execute function dental_test_reservations.pause_policy_high()`);
      await barrier.query("begin; select pg_advisory_xact_lock(hashtextextended('dental_test.policy-shutdown-row-order',0))");
      const barrierPid=(await barrier.query('select pg_backend_pid() as pid')).rows[0].pid as number;
      await shutdown.query("set deadlock_timeout='50ms'; set session authorization postgres; begin; set local lock_timeout='8s'; set local dental_test.policy_lock_probe='yes'; set local enable_indexscan=off; set local enable_bitmapscan=off; set local enable_seqscan=on");
      const shutdownPid=(await shutdown.query('select pg_backend_pid() as pid')).rows[0].pid as number;
      stopping=execute(shutdown,'select dental.set_admin_notification_policy($1,2,false,null,null,$2) as result',[operator,'Synthetic ordered shutdown']);
      await fixture.base.waitForLockWaiters([shutdownPid],barrierPid);
      cancelling=path==='patient'
        ? execute(cancellation.client,'select dental.cancel($1,$2,$3) as result',[currentActor,approved.id,approved.version])
        : execute(cancellation.client,'select dental.decide($1,$2,$3,$4,$5) as result',[admin.account,approved.id,approved.version,'cancel','Synthetic clinic cancellation']);
      await fixture.base.waitForLockWaiters([cancellation.pid],shutdownPid);
      await barrier.query('commit'); const outcomes=await Promise.all([stopping,cancelling]);
      expect(outcomes, 'Both real transactions must commit; an unordered shutdown can yield SQLSTATE 40P01.').toEqual([
        {ok:true,result:3},{ok:true,result:expect.objectContaining({status:'cancelled',version:3})},
      ]);
      expect((await fixture.control.query('select enabled,version from dental.admin_notification_policy')).rows[0]).toEqual({enabled:false,version:3});
      expect((await fixture.control.query('select state,lease_owner,lease_until from dental.outbox where id=any($1::uuid[]) order by id',[[low,high]])).rows)
        .toEqual([{state:'suppressed',lease_owner:null,lease_until:null},{state:'suppressed',lease_owner:null,lease_until:null}]);
      // The unchanged clinic-cancel path creates its own V2 event after the old
      // approval/reminder prelocks finish. Disabled policy still blocks claiming it.
      expect((await fixture.control.query("select type,appointment_version,state from dental.outbox where appointment_id=$1 and id<>all($2::uuid[])",[approved.id,[low,high]])).rows)
        .toEqual(path==='admin' ? [{type:'cancellation',appointment_version:3,state:'queued'}] : []);
      expect(await fixture.base.call('select dental.claim_patient_event($1) as result',[randomUUID()])).toBeNull();
      expect(await legacyDigest()).toEqual(before);
    } finally {
      await barrier.query('rollback'); await Promise.all([stopping?.catch(()=>{}),cancelling?.catch(()=>{})]);
      await shutdown.query('rollback'); await fixture.closeSession(cancellation);
      await Promise.all([barrier.end(),shutdown.end()]);
      await fixture.control.query('drop trigger if exists synthetic_policy_high_barrier on dental.outbox; drop function if exists dental_test_reservations.pause_policy_high()');
    }
  });
  it('legacyOutboxUnchangedOnPolicyDisable', async () => {
    await installed(); await fixture.base.setClock('2026-10-08T04:59:00Z'); const actor=await fixture.account(); const old=await fixture.base.reserve(actor,randomUUID(),booking(await fixture.base.patient(actor),'2026-10-16'));
    const oldIds:string[]=[];
    for(const [i,state] of ['queued','retry','leased','accepted','suppressed','failed'].entries()) {
      const {rows:[o]}=await fixture.control.query(`insert into dental.outbox(appointment_id,appointment_version,type,due_at,expires_at,state,lease_owner,lease_until,accepted_at)
        values($1,$2,'approval',dental.clock_now(),dental.clock_now()+interval '1 day',$3,
        case when $3='leased' then $4::uuid else null end,case when $3='leased' then dental.clock_now()+interval '1 minute' else null end,
        case when $3='accepted' then dental.clock_now() else null end) returning id`,[old.id,i+1,state,randomUUID()]); oldIds.push(o.id);
    }
    const digest=async()=> (await fixture.control.query('select jsonb_agg(to_jsonb(o) order by id) as rows from dental.outbox o where id=any($1::uuid[])',[oldIds])).rows[0].rows;
    const before=await digest(); await fixture.base.setClock(COMBINED_START); const q=await queued(); await budget(q.operator); expect(await reserve('patient',q.patients[0])).toBe(true); const l=await ledger();
    const enrollments=await fixture.enrollments(); await fixture.policy(q.operator,false,null,null);
    expect(await digest()).toEqual(before); expect(await fixture.enrollments()).toEqual(enrollments); expect(await ledger()).toEqual(l);
    expect((await fixture.control.query('select state,lease_owner,lease_until from dental.outbox where id=$1',[q.patients[0]])).rows[0]).toEqual({state:'suppressed',lease_owner:null,lease_until:null});
    expect((await fixture.inner.deliveries()).every(d=>d.state==='suppressed')).toBe(true);
    await fixture.policy(q.operator); expect(await reserve('patient',q.patients[0])).toBe(false); expect(await fixture.enrollments()).toEqual(enrollments);
  });
  it.each(['2026-10-09T05:00:00Z','2026-10-15T05:00:00.001Z'])('enforces the approved exact seven-day enabled window: %s', async end => {
    await installed(); const operator=await fixture.account(); await expect(fixture.policy(operator,true,COMBINED_START,end)).rejects.toThrow(/VALIDATION/);
    expect((await fixture.control.query('select enabled,version from dental.admin_notification_policy')).rows[0]).toEqual({enabled:false,version:1});
  });
  it('never reserves at E and does not retry an exhausted pause across E', async () => {
    const q=await queued(); await budget(q.operator,{verifiedUntil:COMBINED_END});
    await fixture.control.query('update dental.outbox set expires_at=$2 where id=$1',[q.patients[0],'2026-10-16T05:00:00Z']);
    await fixture.base.setClock('2026-10-15T04:50:00Z'); expect(await reserve('patient',q.patients[0],null)).toBe(false);
    expect((await fixture.control.query('select state,lease_owner,lease_until from dental.outbox where id=$1',[q.patients[0]])).rows[0]).toEqual({state:'suppressed',lease_owner:null,lease_until:null});
    await fixture.base.setClock(COMBINED_END); expect(await reserve('patient',q.patients[0],quota({observedAt:COMBINED_END}))).toBe(false);
    expect((await ledger()).patients).toEqual([]);
  });
});
