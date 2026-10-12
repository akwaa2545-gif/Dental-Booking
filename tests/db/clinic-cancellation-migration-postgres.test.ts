import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { booking, ReservationFixture } from '../support/reservation-postgres';
import type { Appointment } from '../../src/shared/contracts';

const migration = readFileSync('db/migrations/011_clinic_cancellation.sql', 'utf8');
const originalFunction = (file: string, name: string) => {
  const source = readFileSync(`db/migrations/${file}`, 'utf8');
  return `CREATE OR REPLACE FUNCTION dental.${name}(${source.split(`CREATE FUNCTION dental.${name}(`)[1].split('$body$;')[0]}$body$;`;
};
const originalEnvelope = readFileSync('db/migrations/006_notifications.sql', 'utf8')
  .split('ADD CONSTRAINT outbox_frozen_v1 CHECK(')[1].split(';')[0];
let fixture: ReservationFixture, owner: string, admin: string;

// This exceptional migration suite is guarded by the local disposable fixture
// checks. Historical baseline restoration and candidate application occur only
// inside a rolled-back transaction. No hosted target or persistent DDL is used.
async function snapshot() {
  const data: Record<string, unknown> = {};
  const { rows: tables } = await fixture.control.query("select relname from pg_class where relnamespace='dental'::regnamespace and relkind='r' order by relname");
  for (const { relname } of tables) data[relname] = (await fixture.control.query(`select to_jsonb(t) as row from dental."${relname}" t order by to_jsonb(t)::text`)).rows;
  return {
    data,
    functions: (await fixture.control.query("select to_jsonb(p) as row from pg_proc p where pronamespace='dental'::regnamespace order by oid")).rows,
    roles: (await fixture.control.query("select to_jsonb(r)-'rolpassword' as row from pg_roles r where rolname in ('postgres','dental_function_owner','dental_backend','dental_runtime') order by oid")).rows,
    memberships: (await fixture.control.query('select to_jsonb(m) as row from pg_auth_members m order by roleid,member,grantor')).rows,
    defaults: (await fixture.control.query('select to_jsonb(d) as row from pg_default_acl d order by oid')).rows,
    objects: (await fixture.control.query("select relname,relowner,relacl,relrowsecurity,relforcerowsecurity from pg_class where relnamespace='dental'::regnamespace order by oid")).rows,
    columns: (await fixture.control.query("select to_jsonb(a) as row from pg_attribute a join pg_class c on c.oid=a.attrelid where c.relnamespace='dental'::regnamespace order by a.attrelid,a.attnum")).rows,
    policies: (await fixture.control.query("select to_jsonb(p) as row from pg_policy p join pg_class c on c.oid=p.polrelid where c.relnamespace='dental'::regnamespace order by p.oid")).rows,
    triggers: (await fixture.control.query("select to_jsonb(t) as row from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.relnamespace='dental'::regnamespace order by t.oid")).rows,
    constraints: (await fixture.control.query("select conname,pg_get_constraintdef(oid) as definition,convalidated from pg_constraint where connamespace='dental'::regnamespace order by conrelid,conname")).rows,
  };
}
async function migrate() {
  await fixture.control.query('set session authorization postgres');
  await fixture.control.query(migration);
}
async function rejectedMigration(message: RegExp) {
  await fixture.control.query('savepoint candidate');
  await expect(migrate()).rejects.toThrow(message);
  await fixture.control.query('rollback to savepoint candidate; reset session authorization');
}

describe('real PostgreSQL bounded clinic migration preservation', () => {
  beforeAll(async () => { fixture = await ReservationFixture.create(); });
  beforeEach(async () => {
    owner = await fixture.account(); admin = await fixture.account();
    await fixture.control.query('insert into dental.admin_grants(account_id) values($1)', [admin]);
    const pending = await fixture.reserve(owner, randomUUID(), booking(await fixture.patient(owner)));
    const approved = await fixture.call<Appointment>('select dental.decide($1,$2,$3,$4,$5) as result', [admin, pending.id, 1, 'approve', 'Synthetic migration preservation']);
    // A previously frozen V1 payload and provider history must survive the DDL.
    await fixture.control.query("update dental.outbox set state='accepted',attempt_count=1,accepted_at=clock_timestamp(),dispatch_provider='line:synthetic',dispatch_recipient=$2,dispatch_reference=$3,dispatch_status='approved',dispatch_manage_url='https://clinic.example/appointments' where appointment_id=$1 and type='approval'", [approved.id, `U${owner.replaceAll('-', '')}`, approved.reference]);
    await fixture.control.query("begin; set local statement_timeout='120s'; set local lock_timeout='7s'");
    await fixture.control.query(originalFunction('005_transitions.sql', 'decide'));
    await fixture.control.query(originalFunction('006_notifications.sql', 'prepare_dispatch'));
    await fixture.control.query(`alter table dental.outbox drop constraint outbox_type_check, drop constraint outbox_frozen_envelope;
      alter table dental.outbox add constraint outbox_type_check check (type in ('approval','rejection','reminder'));
      alter table dental.outbox add constraint outbox_frozen_v1 check (${originalEnvelope};`);
  });
  afterEach(async () => {
    if (!fixture) return;
    await fixture.control.query('rollback; reset session authorization');
    await fixture.control.query('delete from dental.notification_attempts where outbox_id in (select o.id from dental.outbox o join dental.appointments a on a.id=o.appointment_id where a.owner_account_id=$1)', [owner]);
    await fixture.control.query('delete from dental.outbox where appointment_id in (select id from dental.appointments where owner_account_id=$1)', [owner]);
    await fixture.control.query('delete from dental.admin_grants where account_id=$1', [admin]);
    await fixture.reset();
  });
  afterAll(async () => { await fixture?.close(); });

  it('changes only two bodies/two checks and preserves seeded business rows, V1 payload, memberships and every security catalog', async () => {
    const before = await snapshot();
    await migrate(); await fixture.control.query('reset session authorization');
    const after = await snapshot();
    const beforeFunctions = before.functions.map(({ row }) => row);
    const afterFunctions = after.functions.map(({ row }) => row);
    const changed = afterFunctions.filter((row, index) => row.prosrc !== beforeFunctions[index].prosrc);
    expect(changed.map(row => row.proname).sort()).toEqual(['decide', 'prepare_dispatch']);
    const metadata = (rows: Record<string, unknown>[]) => rows.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'prosrc')));
    expect(metadata(afterFunctions)).toEqual(metadata(beforeFunctions));
    const untouched = (rows: typeof before.constraints) => rows.filter(row => !['outbox_type_check', 'outbox_frozen_v1', 'outbox_frozen_envelope'].includes(row.conname));
    expect(untouched(after.constraints)).toEqual(untouched(before.constraints));
    expect(after.constraints.filter(row => ['outbox_type_check', 'outbox_frozen_envelope'].includes(row.conname))).toHaveLength(2);
    expect(after.constraints.every(row => row.convalidated)).toBe(true);
    expect({ ...after, functions: undefined, constraints: undefined }).toEqual({ ...before, functions: undefined, constraints: undefined });
    expect((await fixture.control.query("select current_setting('lock_timeout') as timeout")).rows[0].timeout).toBe('7s');
  });

  it('rejects repeat application without any second catalog or data change', async () => {
    await migrate(); await fixture.control.query('reset session authorization');
    const before = await snapshot(); await rejectedMigration(/already-updated clinic cancellation baseline/);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects a changed decision body before replacing any catalog or data', async () => {
    await fixture.control.query(originalFunction('005_transitions.sql', 'decide').replace('DECLARE\n', 'DECLARE\n-- synthetic drift\n'));
    const before = await snapshot(); await rejectedMigration(/already-updated clinic cancellation baseline/);
    expect(await snapshot()).toEqual(before);
  });

  it('rejects unreviewed envelope constraints before replacing any catalog or data', async () => {
    await fixture.control.query("alter table dental.outbox drop constraint outbox_frozen_v1; alter table dental.outbox add constraint outbox_frozen_v1 check (true)");
    const before = await snapshot(); await rejectedMigration(/outbox type\/envelope constraints/);
    expect(await snapshot()).toEqual(before);
  });

  it('requires an inherited statement timer before changing anything', async () => {
    await fixture.control.query("set local statement_timeout='0'");
    const before = await snapshot(); await rejectedMigration(/inherited statement timeout/);
    expect(await snapshot()).toEqual(before);
  });
});
