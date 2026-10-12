import pg from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { combinedDatabase, COMBINED_MIGRATION, ENROLLMENT_TABLE } from '../support/combined-notification-postgres';

const migration = existsSync(COMBINED_MIGRATION) ? readFileSync(COMBINED_MIGRATION, 'utf8') : '';
let database: Awaited<ReturnType<typeof combinedDatabase>>, control: pg.Client;
let baselineTables: string[];
type JsonRow = { row: Record<string, unknown> };
async function snapshot() {
  const data: Record<string, unknown> = {};
  for (const table of baselineTables) data[table] = (await control.query(`select to_jsonb(t) as row from dental."${table}" t order by to_jsonb(t)::text`)).rows;
  return { data,
    functions: (await control.query<JsonRow>("select to_jsonb(p) as row from pg_proc p where pronamespace='dental'::regnamespace order by oid")).rows,
    roles: (await control.query("select to_jsonb(r)-'rolpassword' as row from pg_roles r order by oid")).rows,
    memberships: (await control.query('select to_jsonb(m) as row from pg_auth_members m order by roleid,member,grantor')).rows,
    defaults: (await control.query('select to_jsonb(d) as row from pg_default_acl d order by oid')).rows,
    tables: (await control.query("select to_jsonb(c) as row from pg_class c where relnamespace='dental'::regnamespace order by oid")).rows,
    columns: (await control.query("select to_jsonb(a) as row from pg_attribute a join pg_class c on c.oid=a.attrelid where c.relnamespace='dental'::regnamespace order by a.attrelid,a.attnum")).rows,
    policies: (await control.query("select to_jsonb(p) as row from pg_policy p join pg_class c on c.oid=p.polrelid where c.relnamespace='dental'::regnamespace order by p.oid")).rows,
    triggers: (await control.query("select to_jsonb(t) as row from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='dental'::regnamespace order by t.oid")).rows,
    rules: (await control.query("select to_jsonb(r) as row from pg_rewrite r join pg_class c on c.oid=r.ev_class where c.relnamespace='dental'::regnamespace order by r.oid")).rows,
  };
}
async function migrate() {
  expect(migration, 'Migration 013 candidate must exist.').not.toBe('');
  await control.query('set session authorization postgres'); await control.query(migration); await control.query('reset session authorization');
}
async function rejected(expected: RegExp) {
  await control.query('savepoint candidate'); await expect(migrate()).rejects.toThrow(expected);
  await control.query('rollback to savepoint candidate; reset session authorization');
}

// Mutation targets: migration backfill, baseline-body drift, ACL leakage, retained
// temporary role membership, and changing legacy data/functions while adding 013.
describe('real PostgreSQL bounded combined enrollment migration', () => {
  beforeAll(async () => {
    database = await combinedDatabase(); control = await database.connect();
    baselineTables = (await control.query("select relname from pg_class where relnamespace='dental'::regnamespace and relkind='r' order by relname")).rows.map(row => row.relname as string);
  });
  beforeEach(async () => {
    await control.query("begin; set local statement_timeout='120s'; set local lock_timeout='7s'");
    const actor = randomUUID(), patient = randomUUID(), appointment = randomUUID(), event = randomUUID();
    await control.query("insert into dental.accounts(id,provider,subject) values($1::uuid,'synthetic-combined',$1::text)", [actor]);
    await control.query("insert into dental.patients(id,owner_account_id,full_name,phone,age,address,relationship,authorization_acknowledged) values($1,$2,'Synthetic patient','0000000',31,'Synthetic fixture','self',true)", [patient, actor]);
    await control.query("insert into dental.clinic_dates(date) values('2026-10-16')");
    await control.query(`insert into dental.appointments(id,owner_account_id,patient_id,patient_version,patient_snapshot,age_captured_on,service,date,status,idempotency_key)
      values($1,$2,$3,1,'{"fullName":"Synthetic patient","phone":"0000000","age":31,"address":"Synthetic fixture","relationship":"self","authorizationAcknowledged":true}','2026-10-08','oral_check','2026-10-16','pending',$4)`, [appointment, actor, patient, randomUUID()]);
    await control.query(`insert into dental.outbox(id,appointment_id,appointment_version,type,due_at,expires_at,state,attempt_count,first_attempt_at,accepted_at,
      dispatch_provider,dispatch_recipient,dispatch_reference,dispatch_status,dispatch_manage_url)
      values($1,$2,1,'approval',dental.clock_now(),dental.clock_now()+interval '1 day','accepted',1,dental.clock_now(),dental.clock_now(),
      'line:synthetic','U00000000000000000000000000000000','D-SYNTHETIC','approved','https://clinic.example/appointments')`, [event, appointment]);
    await control.query(`insert into dental.notification_attempts(outbox_id,attempt_number,worker_id,started_at,finished_at,result,provider_request_id)
      values($1,1,$2,dental.clock_now(),dental.clock_now(),'accepted','synthetic-preserved')`, [event, randomUUID()]);
  });
  afterEach(async () => { await control?.query('rollback; reset session authorization'); });
  afterAll(async () => { await control?.end(); await database?.close(); });

  it('is an atomic PG17-only candidate without account, credentials or provider changes', () => {
    expect(migration).toMatch(/^DO\s+\$[a-z_]+\$/m); expect(migration).toMatch(/v_major\s*<>\s*17/);
    expect(migration.trim()).toMatch(/END;\s*\$[a-z_]+\$;$/);
    expect(migration).not.toMatch(/CREATE\s+ROLE|\bPASSWORD\s+['"]|DISABLE ROW LEVEL SECURITY|https?:\/\/api\.line/i);
  });
  it('preserves all old data and catalogs with only exact combined source and four legacy ACL deltas', async () => {
    const before = await snapshot(); await migrate(); const after = await snapshot();
    expect(after.data).toEqual(before.data); expect(after.roles).toEqual(before.roles);
    expect(after.memberships).toEqual(before.memberships); expect(after.defaults).toEqual(before.defaults);
    const oldOids = new Set(before.functions.map(({ row }) => row.oid));
    const existing = after.functions.filter(({ row }) => oldOids.has(row.oid));
    expect(existing.filter(({ row }, i) => row.prosrc !== before.functions[i].row.prosrc).map(({ row }) => row.proname)).toEqual(['reserve', 'claim_admin_delivery', 'prepare_admin_dispatch', 'revalidate_admin_dispatch', 'set_admin_notification_budget', '_reserve_admin_budget', 'set_admin_notification_policy']);
    const revoked=['claim_events','prepare_dispatch','claim_restricted_event','prepare_restricted_dispatch'];
    const expected=before.functions.map(({row})=>({...row,prosrc:undefined,proacl:revoked.includes(row.proname as string)?(row.proacl as string[]).filter(acl=>!acl.startsWith('dental_backend=')):row.proacl}));
    expect(existing.map(({row})=>({...row,prosrc:undefined}))).toEqual(expected);
    for (const key of ['tables', 'columns', 'policies'] as const) for (const old of before[key]) expect(after[key]).toContainEqual(old);
    expect((await control.query(`select count(*)::integer as count from ${ENROLLMENT_TABLE}`)).rows[0].count).toBe(0);
    expect((await control.query('select enabled,version from dental.admin_notification_policy')).rows).toEqual([{ enabled: false, version: 1 }]);
    expect((await control.query("select current_setting('lock_timeout') as value,current_user,current_setting('role') as role")).rows[0])
      .toEqual({ value: '7s', current_user: 'dental_test_admin', role: 'none' });
  });
  it('forces private immutable enrollments and exposes only claim to inherited backend runtime', async () => {
    await migrate();
    expect((await control.query(`select r.rolname as owner,c.relrowsecurity,c.relforcerowsecurity from pg_class c join pg_roles r on r.oid=c.relowner where c.oid=$1::regclass`, [ENROLLMENT_TABLE])).rows[0])
      .toEqual({ owner: 'postgres', relrowsecurity: true, relforcerowsecurity: true });
    for (const role of ['anon', 'authenticated', 'authenticator', 'service_role', 'dental_backend', 'dental_runtime']) {
      expect((await control.query(`select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') as table_access,
        has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') as column_access`, [role, ENROLLMENT_TABLE])).rows[0]).toEqual({ table_access: false, column_access: false });
    }
    expect((await control.query(`select has_table_privilege('dental_function_owner',$1,'SELECT') as read,has_table_privilege('dental_function_owner',$1,'INSERT') as insert,
      has_table_privilege('dental_function_owner',$1,'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') as mutates`, [ENROLLMENT_TABLE])).rows[0]).toEqual({ read: true, insert: true, mutates: false });
    for (const [signature, runtime] of [['dental.claim_patient_event(uuid)', true], ['dental._enroll_notification_booking(dental.appointments)', false]] as const) {
      expect((await control.query(`select p.prosecdef,p.proconfig,r.rolname as owner,has_function_privilege('dental_backend',p.oid,'EXECUTE') as backend,
        has_function_privilege('dental_runtime',p.oid,'EXECUTE') as runtime from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=$1::regprocedure`, [signature])).rows[0])
        .toEqual({ prosecdef: true, proconfig: ['search_path=""'], owner: 'dental_function_owner', backend: runtime, runtime });
      expect((await control.query(`select a.privilege_type from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=$1::regprocedure and a.grantee=0`, [signature])).rows).toEqual([]);
    }
  });
  it('rejects repeat apply without catalog or data changes', async () => { await migrate(); const before = await snapshot(); await rejected(/baseline|already|013/i); expect(await snapshot()).toEqual(before); });
  it('rejects a changed reserve baseline atomically', async () => {
    const { rows: [{ definition }] } = await control.query("select pg_get_functiondef('dental.reserve(uuid,uuid,jsonb)'::regprocedure) as definition");
    await control.query(definition.replace('DECLARE ', 'DECLARE /* unreviewed synthetic drift */ '));
    const before = await snapshot(); await rejected(/baseline|reserve|unreviewed/i); expect(await snapshot()).toEqual(before);
  });
  it.each([
    ['missing restricted attempt fence', 'drop trigger fence_restricted_attempt on dental.notification_attempts'],
    ['disabled restricted attempt fence', 'alter table dental.notification_attempts disable trigger fence_restricted_attempt'],
    ['wrong-target restricted attempt fence', 'drop trigger fence_restricted_attempt on dental.notification_attempts; create trigger fence_restricted_attempt before insert on dental.outbox for each row execute function dental._fence_restricted_attempt()'],
    ['wrong-shape restricted attempt fence', 'drop trigger fence_restricted_attempt on dental.notification_attempts; create trigger fence_restricted_attempt after insert on dental.notification_attempts for each row execute function dental._fence_restricted_attempt()'],
    ['wrong-function restricted attempt fence', 'drop trigger fence_restricted_attempt on dental.notification_attempts; create trigger fence_restricted_attempt before insert on dental.notification_attempts for each row execute function dental._capture_outbox_date()'],
    ['conditional restricted attempt fence', 'drop trigger fence_restricted_attempt on dental.notification_attempts; create trigger fence_restricted_attempt before insert on dental.notification_attempts for each row when(false) execute function dental._fence_restricted_attempt()'],
    ['competing restricted attempt trigger', 'create trigger synthetic_competing_attempt before insert on dental.notification_attempts for each row execute function dental._fence_restricted_attempt()'],
    ['competing restricted attempt rule', 'create rule synthetic_competing_attempt as on insert to dental.notification_attempts do instead nothing'],
  ])('rejects restricted trigger baseline drift atomically: %s', async (_name, mutation) => {
    await control.query(mutation); const before = await snapshot();
    await rejected(/baseline|trigger|rule|unreviewed/i); expect(await snapshot()).toEqual(before);
  });
  it.each([
    ['reserve SECURITY INVOKER', 'alter function dental.reserve(uuid,uuid,jsonb) security invoker'],
    ['reserve STABLE', 'alter function dental.reserve(uuid,uuid,jsonb) stable'],
    ['clock SECURITY DEFINER', 'alter function dental.clock_now() security definer'],
    ['clock STABLE', 'alter function dental.clock_now() stable'],
    ['admin reserve SECURITY INVOKER', 'alter function dental._reserve_admin_budget(uuid,jsonb) security invoker'],
    ['admin reserve STABLE', 'alter function dental._reserve_admin_budget(uuid,jsonb) stable'],
    ['budget operator SECURITY INVOKER', 'alter function dental.set_admin_notification_budget(uuid,integer,timestamptz,timestamptz,integer,integer,boolean,text) security invoker'],
    ['admin claim SECURITY INVOKER','alter function dental.claim_admin_delivery(uuid) security invoker'],
    ['admin claim STRICT','alter function dental.claim_admin_delivery(uuid) strict'],
    ['admin prepare STRICT','alter function dental.prepare_admin_dispatch(uuid,uuid,text,jsonb) strict'],
    ['admin revalidate PARALLEL SAFE','alter function dental.revalidate_admin_dispatch(uuid,uuid) parallel safe'],
    ['admin claim STABLE','alter function dental.claim_admin_delivery(uuid) stable'],
    ['admin prepare SECURITY INVOKER','alter function dental.prepare_admin_dispatch(uuid,uuid,text,jsonb) security invoker'],
    ['admin prepare STABLE','alter function dental.prepare_admin_dispatch(uuid,uuid,text,jsonb) stable'],
    ['admin revalidate SECURITY INVOKER','alter function dental.revalidate_admin_dispatch(uuid,uuid) security invoker'],
    ['admin revalidate STABLE','alter function dental.revalidate_admin_dispatch(uuid,uuid) stable'],
    ['policy operator SECURITY INVOKER', 'alter function dental.set_admin_notification_policy(uuid,integer,boolean,timestamptz,timestamptz,text) security invoker'],
  ])('rejects execution metadata baseline drift atomically: %s', async (_name, mutation) => {
    await control.query(mutation); const before = await snapshot();
    await rejected(/baseline|metadata|execution|reserve|clock|unreviewed/i); expect(await snapshot()).toEqual(before);
  });
  it.each([
    ['runtime direct legacy prepare grant','grant execute on function dental.prepare_dispatch(uuid,uuid,text) to dental_runtime'],
    ['runtime direct restricted grant','grant execute on function dental.prepare_restricted_dispatch(uuid,uuid,uuid,text) to dental_runtime'],
    ['runtime column read', 'grant select(subject) on dental.accounts to dental_runtime'],
    ['PUBLIC reserve execute', 'grant execute on function dental.reserve(uuid,uuid,jsonb) to public'],
    ['backend internal helper execute', 'grant execute on function dental._enqueue_admin_booking(dental.appointments) to dental_backend'],
    ['API schema usage', 'grant usage on schema dental to anon'],
    ['function owner default leak', 'alter default privileges for role dental_function_owner grant execute on functions to anon'],
    ['unexpected private relation', 'create table dental.synthetic_unreviewed(id integer)'],
  ])('rejects unsafe baseline: %s', async (_name, mutation) => {
    await control.query(mutation); const before = await snapshot(); await rejected(/baseline|privilege|access|unreviewed|default|function|schema/i); expect(await snapshot()).toEqual(before);
  });
  it('sanitizes actual new-table ACLs while preserving postgres defaults', async () => {
    await control.query('alter default privileges for role postgres in schema dental grant select on tables to anon');
    const before = await snapshot(); await migrate(); expect((await snapshot()).defaults).toEqual(before.defaults);
    expect((await control.query('select has_table_privilege(\'anon\',$1,\'SELECT\') as access', [ENROLLMENT_TABLE])).rows[0].access).toBe(false);
  });
  it.each(['0', '120001ms'])('rejects unsafe statement timeout %s', async timeout => {
    await control.query("select set_config('statement_timeout',$1,true)", [timeout]); const before = await snapshot();
    await rejected(/statement timeout/i); expect(await snapshot()).toEqual(before);
  });
});
