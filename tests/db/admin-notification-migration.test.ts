import pg from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { waitForLockWaiters } from '../support/wait-for-lock-waiters';
import { ADMIN_MIGRATION, ADMIN_TABLES, localAdminConnection, POLICY_SIGNATURE } from '../support/admin-notification-postgres';

const migration = existsSync(ADMIN_MIGRATION) ? readFileSync(ADMIN_MIGRATION, 'utf8') : '';
let control: pg.Client;
let actor: string;
let baselineTables: string[];

type JsonRow = { row: Record<string, unknown> };
async function snapshot() {
  const data: Record<string, unknown> = {};
  for (const table of baselineTables) data[table] = (await control.query(`select to_jsonb(t) as row from dental."${table}" t order by to_jsonb(t)::text`)).rows;
  return {
    data,
    functions: (await control.query<JsonRow>("select to_jsonb(p) as row from pg_proc p where pronamespace='dental'::regnamespace order by oid")).rows,
    roles: (await control.query("select to_jsonb(r)-'rolpassword' as row from pg_roles r order by oid")).rows,
    memberships: (await control.query('select to_jsonb(m) as row from pg_auth_members m order by roleid,member,grantor')).rows,
    defaults: (await control.query('select to_jsonb(d) as row from pg_default_acl d order by oid')).rows,
    tables: (await control.query("select to_jsonb(c) as row from pg_class c where relnamespace='dental'::regnamespace order by oid")).rows,
    columns: (await control.query("select to_jsonb(a) as row from pg_attribute a join pg_class c on c.oid=a.attrelid where c.relnamespace='dental'::regnamespace order by a.attrelid,a.attnum")).rows,
    policies: (await control.query("select to_jsonb(p) as row from pg_policy p join pg_class c on c.oid=p.polrelid where c.relnamespace='dental'::regnamespace order by p.oid")).rows,
    triggers: (await control.query("select to_jsonb(t) as row from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='dental'::regnamespace order by t.oid")).rows,
    constraints: (await control.query("select to_jsonb(c) as row from pg_constraint c where connamespace='dental'::regnamespace order by oid")).rows,
  };
}
async function migrate() {
  expect(migration, 'Migration 012 candidate must exist.').not.toBe('');
  await control.query('set session authorization postgres');
  await control.query(migration);
  await control.query('reset session authorization');
}
async function rejectedMigration(expected: RegExp) {
  await control.query('savepoint candidate');
  await expect(migrate()).rejects.toThrow(expected);
  await control.query('rollback to savepoint candidate; reset session authorization');
}

// All DDL and seeded records below live only in a fresh *_migration clone of
// baseline 011, under the same explicit disposable target guard, and roll back.
describe('real PostgreSQL bounded admin migration and private ACLs', () => {
  beforeAll(async () => {
    control = await localAdminConnection('_migration');
    expect((await control.query("select to_regclass('dental.admin_booking_events') as candidate")).rows[0].candidate).toBeNull();
    baselineTables = (await control.query("select relname from pg_class where relnamespace='dental'::regnamespace and relkind='r' order by relname")).rows.map(row => row.relname as string);
    for (const table of baselineTables) {
      // Reservation policy seed tables from old migrations are allowed, but
      // mutable business rows must never be adopted from an earlier test run.
      if (['accounts', 'patients', 'appointments', 'outbox', 'notification_attempts', 'admin_grants'].includes(table)) {
        expect((await control.query(`select count(*)::integer as count from dental.${table}`)).rows[0].count).toBe(0);
      }
    }
  });
  beforeEach(async () => {
    await control.query("begin; set local statement_timeout='120s'; set local lock_timeout='7s'");
    actor = randomUUID(); const patient = randomUUID(), appointment = randomUUID(), event = randomUUID();
    await control.query("insert into dental.accounts(id,provider,subject) values($1::uuid,'synthetic-migration',$1::text)", [actor]);
    await control.query('insert into dental.admin_grants(account_id) values($1)', [actor]);
    await control.query("insert into dental.patients(id,owner_account_id,full_name,phone,age,address,relationship,authorization_acknowledged) values($1,$2,'Synthetic migration patient','0000000',31,'Synthetic fixture','self',true)", [patient, actor]);
    await control.query("insert into dental.clinic_dates(date) values('2026-10-12')");
    await control.query(`insert into dental.appointments(id,owner_account_id,patient_id,patient_version,patient_snapshot,age_captured_on,service,date,status,idempotency_key,approved_at)
      values($1,$2,$3,1,'{"fullName":"Synthetic migration patient","phone":"0000000","age":31,"address":"Synthetic fixture","relationship":"self","authorizationAcknowledged":true}','2026-10-08','oral_check','2026-10-12','approved',$4,dental.clock_now())`, [appointment, actor, patient, randomUUID()]);
    await control.query(`insert into dental.outbox(id,appointment_id,appointment_version,type,due_at,expires_at,state,attempt_count,first_attempt_at,accepted_at,
      dispatch_provider,dispatch_recipient,dispatch_reference,dispatch_status,dispatch_manage_url)
      values($1,$2,1,'approval',dental.clock_now(),dental.clock_now()+interval '1 day','accepted',1,dental.clock_now(),dental.clock_now(),
      'line:synthetic','U00000000000000000000000000000000','D-SYNTHETIC','approved','https://clinic.example/appointments')`, [event, appointment]);
    await control.query(`insert into dental.notification_attempts(outbox_id,attempt_number,worker_id,started_at,finished_at,result,provider_request_id)
      values($1,1,$2,dental.clock_now(),dental.clock_now(),'accepted','synthetic-preserved-request')`, [event, randomUUID()]);
  });
  afterEach(async () => { await control?.query('rollback; reset session authorization'); });
  afterAll(async () => { await control?.end(); });

  it('is one bounded PG17 candidate without credentials, new login roles or hosted side effects', () => {
    expect(migration).toMatch(/^DO\s+\$[a-z_]+\$/m);
    expect(migration.trim()).toMatch(/END;\s*\$[a-z_]+\$;$/);
    expect(migration).toMatch(/v_major\s*<>\s*17/);
    expect(migration).not.toMatch(/CREATE\s+ROLE|\bPASSWORD\s+['"]|DISABLE ROW LEVEL SECURITY|https?:\/\/api\.line/i);
  });

  it('preserves every seeded patient row, frozen V1 bytes, restricted function, old ACL and role membership', async () => {
    const before = await snapshot(); await migrate(); const after = await snapshot();
    expect(after.data).toEqual(before.data);
    expect(after.roles).toEqual(before.roles); expect(after.memberships).toEqual(before.memberships); expect(after.defaults).toEqual(before.defaults);
    const oldOids = new Set(before.functions.map(({ row }) => row.oid));
    const existingAfter = after.functions.filter(({ row }) => oldOids.has(row.oid));
    const changed = existingAfter.filter(({ row }, i) => row.prosrc !== before.functions[i].row.prosrc);
    expect(changed.map(({ row }) => row.proname).sort()).toEqual(['admin_appointments', 'reserve']);
    const metadata = (rows: JsonRow[]) => rows.map(({ row }) => ({ ...row, prosrc: undefined }));
    expect(metadata(existingAfter)).toEqual(metadata(before.functions));
    for (const key of ['tables', 'columns', 'policies', 'triggers', 'constraints'] as const) {
      // Candidate adds objects, never alters any old table/index/column/policy.
      for (const existing of before[key]) expect(after[key]).toContainEqual(existing);
    }
    expect((await control.query("select current_setting('lock_timeout') as value")).rows[0].value).toBe('7s');
    expect((await control.query('select enabled,version,activation_at,authorized_end_at from dental.admin_notification_policy')).rows)
      .toEqual([{ enabled: false, version: 1, activation_at: null, authorized_end_at: null }]);
    expect((await control.query('select count(*)::integer as count from dental.admin_booking_events')).rows[0].count).toBe(0);
  });

  it('forces RLS and postgres ownership without PUBLIC, API-role or runtime table and column access', async () => {
    await migrate();
    const { rows } = await control.query(`select c.relname,r.rolname as owner,c.relrowsecurity,c.relforcerowsecurity
      from pg_class c join pg_roles r on r.oid=c.relowner where c.relnamespace='dental'::regnamespace and c.relname=any($1) order by c.relname`, [ADMIN_TABLES]);
    expect(rows).toHaveLength(6);
    for (const row of rows) expect(row).toMatchObject({ owner: 'postgres', relrowsecurity: true, relforcerowsecurity: true });
    for (const table of ADMIN_TABLES) {
      for (const role of ['anon', 'authenticated', 'service_role', 'dental_backend', 'dental_runtime']) {
        const { rows: [access] } = await control.query(`select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') as table_access,
          has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') as column_access`, [role, `dental.${table}`]);
        expect(access, `${role} must not access ${table} directly`).toEqual({ table_access: false, column_access: false });
      }
      const publicGrants = await control.query(`select a.privilege_type from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
        where c.oid=$1::regclass and a.grantee=0`, [`dental.${table}`]);
      expect(publicGrants.rows).toEqual([]);
    }
  });

  it('keeps enqueue internal and policy mutation operator-only, with hardened definer metadata', async () => {
    await migrate();
    for (const signature of [POLICY_SIGNATURE, 'dental._enqueue_admin_booking(dental.appointments)']) {
      const { rows: [fn] } = await control.query(`select p.prosecdef,p.proconfig,r.rolname as owner,
        has_function_privilege('dental_backend',p.oid,'EXECUTE') as backend,
        has_function_privilege('dental_runtime',p.oid,'EXECUTE') as runtime
        from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=$1::regprocedure`, [signature]);
      expect(fn).toMatchObject({ prosecdef: true, proconfig: ['search_path=""'], owner: 'dental_function_owner', backend: false, runtime: false });
      expect((await control.query("select a.privilege_type from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where p.oid=$1::regprocedure and a.grantee=0", [signature])).rows).toEqual([]);
    }
    await control.query('savepoint unauthorized; set local role dental_backend');
    await expect(control.query('select dental.set_admin_notification_policy($1,1,true,dental.clock_now(),dental.clock_now()+interval \'1 day\',$2)', [actor, 'Synthetic forbidden call'])).rejects.toMatchObject({ code: '42501' });
    await control.query('rollback to savepoint unauthorized');
  });

  it('rejects repeat application without any second data or catalog change', async () => {
    await migrate(); const before = await snapshot();
    await rejectedMigration(/baseline|already|012/i); expect(await snapshot()).toEqual(before);
  });

  it('rejects a modified reserve body atomically before replacing anything', async () => {
    const { rows: [{ definition }] } = await control.query("select pg_get_functiondef('dental.reserve(uuid,uuid,jsonb)'::regprocedure) as definition");
    await control.query(definition.replace('DECLARE ', 'DECLARE /* synthetic unreviewed drift */ '));
    const before = await snapshot(); await rejectedMigration(/baseline|reserve|unreviewed/i); expect(await snapshot()).toEqual(before);
  });

  it('rejects a PUBLIC execute leak on reserve instead of preserving unsafe baseline privileges', async () => {
    await control.query('grant execute on function dental.reserve(uuid,uuid,jsonb) to public');
    const before = await snapshot(); await rejectedMigration(/privilege|access|baseline|function|public|unreviewed/i); expect(await snapshot()).toEqual(before);
  });

  it('rejects drift in the admin grant function that dispatch authorization relies on', async () => {
    const { rows: [{ definition }] } = await control.query("select pg_get_functiondef('dental.set_admin_grant(uuid,uuid,boolean,text)'::regprocedure) as definition");
    await control.query(definition.replace('DECLARE ', 'DECLARE /* synthetic grant serialization drift */ '));
    const before = await snapshot(); await rejectedMigration(/baseline|grant|unreviewed/i); expect(await snapshot()).toEqual(before);
  });

  it('rejects drift in the admin read function before adding a privileged projection', async () => {
    const { rows: [{ definition }] } = await control.query("select pg_get_functiondef('dental.admin_appointments(uuid,date,text)'::regprocedure) as definition");
    await control.query(definition.replace('DECLARE ', 'DECLARE /* synthetic admin authorization drift */ '));
    const before = await snapshot(); await rejectedMigration(/baseline|admin|unreviewed/i); expect(await snapshot()).toEqual(before);
  });

  it('rejects direct runtime column privileges on the private account mapping', async () => {
    await control.query('grant select(subject) on dental.accounts to dental_runtime');
    const before = await snapshot(); await rejectedMigration(/access|baseline|unreviewed/i); expect(await snapshot()).toEqual(before);
  });

  it.each([
    ['anon table SELECT', 'grant select on dental.accounts to anon'],
    ['authenticated column SELECT', 'grant select(subject) on dental.accounts to authenticated'],
    ['anon schema USAGE', 'grant usage on schema dental to anon'],
  ])('rejects preexisting API-role access drift: %s', async (_label, grant) => {
    await control.query(grant);
    const before = await snapshot(); await rejectedMigration(/access|baseline|unreviewed|api|schema|privilege|browser|platform/i); expect(await snapshot()).toEqual(before);
  });

  it('rejects an unreviewed preexisting relation instead of partially installing 012', async () => {
    await control.query('create table dental.synthetic_unreviewed(id integer)');
    const before = await snapshot(); await rejectedMigration(/baseline|unreviewed/i); expect(await snapshot()).toEqual(before);
  });

  it('rejects changed private role attributes without retaining temporary memberships', async () => {
    await control.query('alter role dental_backend login');
    const before = await snapshot(); await rejectedMigration(/role|baseline|unreviewed/i); expect(await snapshot()).toEqual(before);
  });

  it.each(['0', '120001ms'])('rejects an inherited statement timeout of %s before any mutation', async timeout => {
    await control.query("select set_config('statement_timeout',$1,true)", [timeout]);
    const before = await snapshot(); await rejectedMigration(/statement timeout/i); expect(await snapshot()).toEqual(before);
  });

  it('rolls back partial DDL on a real lock timeout and restores the inherited lock bound', async () => {
    const before = await snapshot();
    const locker = await localAdminConnection('_migration'), observer = await localAdminConnection('_migration');
    try {
      await locker.query('begin; lock table dental.accounts in share update exclusive mode');
      const { rows: [{ pid: blocker }] } = await locker.query('select pg_backend_pid() as pid');
      const { rows: [{ pid }] } = await control.query('select pg_backend_pid() as pid');
      await control.query('savepoint candidate');
      const rejected = expect(migrate()).rejects.toMatchObject({ code: '55P03' });
      await waitForLockWaiters(observer, [pid], blocker);
      await rejected;
      await control.query('rollback to savepoint candidate; reset session authorization');
      expect(await snapshot()).toEqual(before);
      expect((await control.query("select current_setting('lock_timeout') as value")).rows[0].value).toBe('7s');
    } finally { await locker.query('rollback'); await locker.end(); await observer.end(); }
  });

  it('rejects an unreviewed executor session instead of treating superuser status as authorization', async () => {
    const before = await snapshot(); await control.query('savepoint candidate');
    await expect(control.query(migration)).rejects.toThrow(/baseline|operator|context|postgres/i);
    await control.query('rollback to savepoint candidate'); expect(await snapshot()).toEqual(before);
  });
});
