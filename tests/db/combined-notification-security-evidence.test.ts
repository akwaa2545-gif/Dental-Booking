import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type pg from 'pg';
import { expect, it } from 'vitest';
import { combinedDatabase, COMBINED_MIGRATION } from '../support/combined-notification-postgres';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
async function catalog(client: pg.Client) {
  const functions = (await client.query(`select p.oid::regprocedure::text as signature,p.proname as name,r.rolname as owner,
    p.prosecdef as security_definer,p.provolatile as volatility,p.proisstrict as strict,p.proparallel as parallel,p.proconfig as config,
    p.prosrc as source,pg_get_function_result(p.oid) as returns,
    (select jsonb_agg(jsonb_build_object('grantee',coalesce(g.rolname,'PUBLIC'),'grantor',q.rolname,'privilege',a.privilege_type,'grantable',a.is_grantable)
      order by coalesce(g.rolname,'PUBLIC'),q.rolname,a.privilege_type) from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      left join pg_roles g on g.oid=a.grantee join pg_roles q on q.oid=a.grantor) as acl
    from pg_proc p join pg_roles r on r.oid=p.proowner where p.pronamespace='dental'::regnamespace order by signature`)).rows
    .map(({ source, ...row }) => ({ ...row, source_sha256: sha256(source) }));
  const tables = (await client.query(`select c.relname as name,r.rolname as owner,c.relrowsecurity as rls,c.relforcerowsecurity as force_rls,
    (select jsonb_agg(jsonb_build_object('grantee',coalesce(g.rolname,'PUBLIC'),'grantor',q.rolname,'privilege',a.privilege_type,'grantable',a.is_grantable)
      order by coalesce(g.rolname,'PUBLIC'),q.rolname,a.privilege_type) from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      left join pg_roles g on g.oid=a.grantee join pg_roles q on q.oid=a.grantor) as acl,
    (select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'not_null',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attnum)
      from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) as columns,
    (select jsonb_agg(jsonb_build_object('name',x.conname,'definition',pg_get_constraintdef(x.oid)) order by x.conname)
      from pg_constraint x where x.conrelid=c.oid) as constraints,
    (select jsonb_agg(jsonb_build_object('name',p.policyname,'permissive',p.permissive,'roles',p.roles,'command',p.cmd,'using',p.qual,'with_check',p.with_check) order by p.policyname)
      from pg_policies p where p.schemaname='dental' and p.tablename=c.relname) as policies
    from pg_class c join pg_roles r on r.oid=c.relowner where c.relnamespace='dental'::regnamespace and c.relkind='r' order by c.relname`)).rows;
  const memberships = (await client.query(`select r.rolname as role,u.rolname as member,g.rolname as grantor,m.admin_option as admin,m.inherit_option as inherit,m.set_option as set
    from pg_auth_members m join pg_roles r on r.oid=m.roleid join pg_roles u on u.oid=m.member join pg_roles g on g.oid=m.grantor
    order by r.rolname,u.rolname,g.rolname`)).rows;
  const schema = (await client.query(`select n.nspname as name,r.rolname as owner,
    (select jsonb_agg(jsonb_build_object('grantee',coalesce(g.rolname,'PUBLIC'),'grantor',q.rolname,'privilege',a.privilege_type,'grantable',a.is_grantable)
      order by coalesce(g.rolname,'PUBLIC'),q.rolname,a.privilege_type) from aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a
      left join pg_roles g on g.oid=a.grantee join pg_roles q on q.oid=a.grantor) as acl
    from pg_namespace n join pg_roles r on r.oid=n.nspowner where n.nspname='dental'`)).rows;
  const defaults = (await client.query(`select r.rolname as role,coalesce(n.nspname,'*') as schema,d.defaclobjtype as type,d.defaclacl::text as acl
    from pg_default_acl d join pg_roles r on r.oid=d.defaclrole left join pg_namespace n on n.oid=d.defaclnamespace order by r.rolname,n.nspname,d.defaclobjtype`)).rows;
  return { functions, tables, memberships, schema, defaults };
}

it('exports an exact deterministic 012-to-013 security delta from a pristine local catalog', async () => {
  const database = await combinedDatabase(), client = await database.connect();
  try {
    await client.query('set session authorization postgres');
    const before = await catalog(client), lockTimeout = (await client.query("select current_setting('lock_timeout') as value")).rows[0].value;
    const migration = readFileSync(COMBINED_MIGRATION, 'utf8'); await client.query(migration);
    const after = await catalog(client);
    const oldFunctions = new Map(before.functions.map(f => [f.signature, f]));
    const addedFunctions = after.functions.filter(f => !oldFunctions.has(f.signature));
    const changedFunctions = after.functions.filter(f => oldFunctions.has(f.signature) && JSON.stringify(f) !== JSON.stringify(oldFunctions.get(f.signature)))
      .map(f => ({ before: oldFunctions.get(f.signature)!, after: f }));
    const oldTables = new Map(before.tables.map(t => [t.name, t]));
    const addedTables = after.tables.filter(t => !oldTables.has(t.name));
    expect(addedTables.map(t => t.name)).toEqual(['notification_booking_enrollments', 'patient_dispatch_authorizations', 'patient_notification_budget_reservations']);
    expect(addedFunctions.map(f => f.name).sort()).toEqual(['_enroll_notification_booking', '_reserve_notification_budget', '_reserve_patient_budget', 'claim_patient_event', 'prepare_patient_dispatch', 'revalidate_patient_dispatch']);
    expect(changedFunctions.filter(f => f.before.source_sha256 !== f.after.source_sha256).map(f => f.after.name).sort())
      .toEqual(['_reserve_admin_budget', 'claim_admin_delivery', 'prepare_admin_dispatch', 'reserve', 'revalidate_admin_dispatch', 'set_admin_notification_budget', 'set_admin_notification_policy']);
    expect(changedFunctions.filter(f => JSON.stringify(f.before.acl) !== JSON.stringify(f.after.acl)).map(f => f.after.name).sort())
      .toEqual(['claim_events', 'claim_restricted_event', 'prepare_dispatch', 'prepare_restricted_dispatch']);
    for (const table of before.tables) expect(after.tables.find(t => t.name === table.name)).toEqual(table);
    expect(after.memberships).toEqual(before.memberships); expect(after.schema).toEqual(before.schema); expect(after.defaults).toEqual(before.defaults);
    expect((await client.query("select current_setting('lock_timeout') as value")).rows[0].value).toBe(lockTimeout);
    for (const table of addedTables) expect(table).toMatchObject({ owner: 'postgres', rls: true, force_rls: true });
    const evidence = { evidence: 'synthetic-local-PG17-pristine-012-to-013-not-live', migration: COMBINED_MIGRATION, migration_sha256: sha256(migration),
      tables_added: addedTables, functions_added: addedFunctions, functions_changed: changedFunctions,
      memberships_before: before.memberships, memberships_after: after.memberships, schema_before: before.schema, schema_after: after.schema,
      defaults_before: before.defaults, defaults_after: after.defaults, old_tables_unchanged: true,
      temporary_access_restored: true, inherited_lock_timeout_restored: true };
    const path = process.env.COMBINED_SECURITY_EVIDENCE_PATH;
    if (path) {
      const directory = resolve('artifacts/combined-notifications');
      if (resolve(path) !== resolve(directory, 'security-delta.json')) throw new Error('Evidence output must be the exact local combined-notifications/security-delta.json path.');
      writeFileSync(path, JSON.stringify(evidence, null, 2) + '\n');
    }
  } finally { await client.end(); await database.close(); }
});
