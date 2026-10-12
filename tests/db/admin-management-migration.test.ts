import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { adminManagementDatabase, managementBaseline, MANAGEMENT_MIGRATION, MANAGEMENT_READS, MANAGEMENT_TABLES, OWNER_SIGNATURE } from '../support/admin-management-postgres';

const migration = existsSync(MANAGEMENT_MIGRATION) ? readFileSync(MANAGEMENT_MIGRATION, 'utf8') : '';
let database: Awaited<ReturnType<typeof adminManagementDatabase>>, control: pg.Client;
async function tableData(tableNames: string[]) {
  const data = [];
  for (const table of tableNames) data.push((await control.query(`select to_jsonb(t) as row from dental."${table}" t order by to_jsonb(t)::text`)).rows);
  return data;
}
async function migrate() {
  expect(migration, 'Migration 014 candidate must exist').not.toBe('');
  await control.query('set session authorization postgres');
  try { await control.query(migration); } finally { await control.query('reset session authorization').catch(() => {}); }
}
// Mutation targets: missing private tables/read functions, leaked execute/table
// rights, accidental owner seed, baseline drift/replay and retained grants.
describe('real PostgreSQL admin management foundation migration', () => {
  beforeAll(async () => { database = await adminManagementDatabase(); control = await database.connect(); });
  beforeEach(async () => { await control.query("begin; set local statement_timeout='120s'"); });
  afterEach(async () => { await control.query('rollback; reset session authorization'); });
  afterAll(async () => { await control?.end(); await database?.close(); });
  it('records the committed 013 catalog baseline without adopting drift', async () => {
    const baseline = await managementBaseline(control);
    writeFileSync('/tmp/admin-management-013-baseline.json', JSON.stringify(baseline, null, 2));
    expect(baseline).toEqual({ schema: '4ae008106c89761f7c6d1788e7cdf716', tables: 'aa1389f8ca59101cad612ab44cb147cb', defaults: '4146858b1996fc4459bbe6f4feaddbc3', functions: '33106746d4c95b00c6d9a2deda5ee1d7' });
    expect((await control.query("select pg_get_functiondef('dental.set_admin_grant(uuid,uuid,boolean,text)'::regprocedure) as definition")).rows[0].definition).toContain("SESSION_USER<>'postgres'");
  });
  it('adds empty forced-RLS private tables and narrow functions without changing existing definitions or authority', async () => {
    const account = randomUUID();
    await control.query("insert into dental.accounts(id,provider,subject) values($1::uuid,'synthetic-preservation',$1::text)", [account]);
    await control.query('insert into dental.admin_grants(account_id) values($1)', [account]);
    const tableNames = (await control.query("select relname from pg_class where relnamespace='dental'::regnamespace and relkind='r' order by relname")).rows.map(row => row.relname as string);
    const data = await tableData(tableNames);
    const catalogBefore = await managementBaseline(control);
    const functions = (await control.query("select to_jsonb(p) as row from pg_proc p where pronamespace='dental'::regnamespace order by oid")).rows;
    const memberships = (await control.query('select to_jsonb(m) as row from pg_auth_members m order by roleid,member,grantor')).rows;
    const defaults = (await control.query('select to_jsonb(d) as row from pg_default_acl d order by oid')).rows;
    await migrate();
    expect((await control.query('select to_jsonb(p) as row from pg_proc p where oid=any($1::oid[]) order by oid', [functions.map(({ row }) => row.oid)])).rows).toEqual(functions);
    expect((await control.query('select to_jsonb(m) as row from pg_auth_members m order by roleid,member,grantor')).rows).toEqual(memberships);
    expect((await control.query('select to_jsonb(d) as row from pg_default_acl d order by oid')).rows).toEqual(defaults);
    expect(await tableData(tableNames)).toEqual(data);
    expect((await managementBaseline(control)).schema).toEqual(catalogBefore.schema);
    for (const table of MANAGEMENT_TABLES) {
      expect((await control.query(`select pg_get_userbyid(relowner) as owner,relrowsecurity,relforcerowsecurity from pg_class where oid=$1::regclass`, [`dental.${table}`])).rows[0]).toEqual({ owner: 'postgres', relrowsecurity: true, relforcerowsecurity: true });
      expect((await control.query(`select count(*)::integer as count from dental.${table}`)).rows[0].count).toBe(0);
      for (const role of ['anon', 'authenticated', 'authenticator', 'service_role', 'dental_backend', 'dental_runtime']) {
        expect((await control.query("select has_table_privilege($1,$2,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN') or has_any_column_privilege($1,$2,'SELECT,INSERT,UPDATE,REFERENCES') as access", [role, `dental.${table}`])).rows[0].access).toBe(false);
      }
    }
    for (const signature of MANAGEMENT_READS) {
      expect((await control.query("select has_function_privilege('dental_backend',$1,'EXECUTE') as access", [`dental.${signature}`])).rows[0].access).toBe(true);
      for (const role of ['anon', 'authenticated', 'authenticator', 'service_role']) expect((await control.query("select has_function_privilege($1,$2,'EXECUTE') as access", [role, `dental.${signature}`])).rows[0].access).toBe(false);
    }
    for (const signature of [OWNER_SIGNATURE, 'dental.set_admin_grant(uuid,uuid,boolean,text)']) {
      expect((await control.query("select has_function_privilege('dental_backend',$1,'EXECUTE') as access", [signature])).rows[0].access).toBe(false);
      expect((await control.query("select has_function_privilege('postgres',$1,'EXECUTE') as access", [signature])).rows[0].access).toBe(true);
    }
    expect((await control.query(`select count(*)::integer as count from pg_proc p cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where p.pronamespace='dental'::regnamespace and a.grantee=0`)).rows[0].count).toBe(0);
  });
  it('rejects replay rather than accepting a changed baseline', async () => {
    await migrate(); await control.query('savepoint replay'); await expect(migrate()).rejects.toThrow(/baseline|already/i);
    await control.query('rollback to savepoint replay');
  });
  it.each([
    ['function metadata', "alter function dental.clock_now() stable"],
    ['table constraint', "alter table dental.admin_grants drop constraint admin_grants_check"],
    ['function ACL', "grant execute on function dental.set_admin_grant(uuid,uuid,boolean,text) to dental_backend"],
    ['column ACL', "grant select(subject) on dental.accounts to dental_backend"],
    ['foreign key trigger', 'alter table dental.admin_grants disable trigger all'],
    ['RLS', 'alter table dental.admin_grants disable row level security'],
    ['membership', 'grant dental_function_owner to dental_backend'],
    ['runtime role', 'alter role dental_runtime bypassrls'],
    ['API exposure', "set local pgrst.db_schemas='public,dental'"],
    ['default ACL', "alter default privileges for role postgres in schema dental grant select on tables to anon"],
  ])('fails atomically for %s drift', async (_, drift) => {
    await control.query(drift); await control.query('savepoint candidate');
    await expect(migrate()).rejects.toThrow(/baseline|drift|privilege|access|role|API-exposed/i);
    await control.query('rollback to savepoint candidate; reset session authorization');
    expect((await control.query("select to_regclass('dental.admin_invitations') as candidate")).rows[0].candidate).toBeNull();
  });
});
