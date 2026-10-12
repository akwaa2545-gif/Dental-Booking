import { existsSync, readFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import type pg from 'pg';
import { combinedDatabase } from './combined-notification-postgres';
import { ReservationFixture } from './reservation-postgres';
import { createAdminManagementStore } from '../../src/worker/admin-management/db';

export const MANAGEMENT_MIGRATION = 'db/migrations/014_admin_invitations.sql';
export const MANAGEMENT_TABLES = ['admin_invitations', 'admin_management_owner', 'admin_management_audit'];
export const MANAGEMENT_READS = ['admin_management_capabilities(uuid)', 'admin_management_roster(uuid,text)',
  'admin_management_invitations(uuid,text)', 'admin_management_history(uuid,text)', 'admin_invitation_own_claims(uuid,text)'];
export const OWNER_SIGNATURE = 'dental.set_admin_management_owner(uuid,uuid,text)';

/** All connections and clones inherit the existing exact loopback/PG17 gate. */
export async function adminManagementDatabase(applyCandidate = false) {
  const database = await combinedDatabase(true);
  if (applyCandidate && existsSync(MANAGEMENT_MIGRATION)) {
    const control = await database.connect();
    try { await control.query('set session authorization postgres'); await control.query(readFileSync(MANAGEMENT_MIGRATION, 'utf8')); }
    catch (error) { await control.end(); await database.close(); throw error; }
    await control.end();
  }
  return database;
}

export type ManagementIdentity = { account: string; grant: string };
export class AdminManagementFixture {
  private readonly accounts: string[] = [];
  private constructor(readonly base: ReservationFixture, readonly database: Awaited<ReturnType<typeof adminManagementDatabase>>) {}
  get control() { return this.base.control; }
  readonly store = createAdminManagementStore({ query: async (sql, values) => ({ rows: [{ result: await this.base.call(sql, values) }] }) });

  static async create() {
    // Install candidate before synthetic data or test-clock replacement.
    const database = await adminManagementDatabase(true);
    const oldPrimary = process.env.TEST_DATABASE_URL, oldAdmin = process.env.TEST_RESERVATION_ADMIN_URL;
    const primary = new URL(database.target); primary.username = 'postgres';
    try {
      process.env.TEST_DATABASE_URL = primary.href; process.env.TEST_RESERVATION_ADMIN_URL = database.target.href;
      return new AdminManagementFixture(await ReservationFixture.create(), database);
    } catch (error) { await database.close(); throw error; }
    finally { process.env.TEST_DATABASE_URL = oldPrimary; process.env.TEST_RESERVATION_ADMIN_URL = oldAdmin; }
  }
  async account() { const account = await this.base.account(); this.accounts.push(account); return account; }
  async admin(): Promise<ManagementIdentity> {
    const account = await this.account();
    const { rows: [{ id: grant }] } = await this.control.query('insert into dental.admin_grants(account_id) values($1) returning id', [account]);
    return { account, grant };
  }
  async owner(): Promise<ManagementIdentity> {
    const identity = await this.admin();
    await this.operatorCall('select dental.set_admin_management_owner($1,$1,$2) as result', [identity.account, 'Synthetic owner fixture']);
    return identity;
  }
  async backendHasExecute(signature: string): Promise<boolean> {
    return (await this.control.query("select pg_catalog.has_function_privilege('dental_backend', $1, 'EXECUTE') as value", [signature])).rows[0].value as boolean;
  }
  async operatorCall<T>(sql: string, values: unknown[] = []): Promise<T> {
    const client = await this.database.connect();
    try { await client.query('set session authorization postgres'); return (await client.query(sql, values)).rows[0]?.result as T; }
    finally { await client.end(); }
  }
  async invitation(issuer: ManagementIdentity, claimant: string | null = null, at = '2026-10-08T05:00:00.000001Z') {
    const id = randomUUID();
    await this.control.query(`insert into dental.admin_invitations(id,request_id,token_hash,label,issuer_account_id,issuer_grant_id,
      created_at,expires_at,state,claimant_account_id,claimed_at,claim_reference,verification_code)
      values($1::uuid,$2,$3,'Synthetic colleague',$4,$5,$6::timestamptz,$6::timestamptz+interval '24 hours',
        case when $7::uuid is null then 'issued' else 'claimed' end,$7,
        case when $7::uuid is null then null else $6::timestamptz end,
        case when $7::uuid is null then null else 'I-'||replace($1::text,'-','') end,
        case when $7::uuid is null then null else '00123456' end)`,
    [id, randomUUID(), randomBytes(32).toString('hex'), issuer.account, issuer.grant, at, claimant]);
    return id;
  }
  async close() {
    // Close all test sessions first; clean only rows in this fixture-owned clone
    // before base account cleanup. The independent template remains unchanged.
    const failures: unknown[] = [];
    try { await this.base.closeSessions(); } catch (error) { failures.push(error); }
    const sessions = await this.control.query("select pid from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid()");
    if (sessions.rowCount) {
      // A failed rollback on an ended owned client is recoverable; an actually
      // live manually owned connection is not ours to terminate or discard.
      const blocked = new Error('Close backend sessions before closing the management fixture.');
      if (failures.length) throw new AggregateError([...failures, blocked], blocked.message);
      throw blocked;
    }
    try {
      // An invitation RPC can grant a base-owned account without .admin().
      // Capture those exact grant IDs before removing their invitation FKs.
      const lifecycleGrants: string[] = (await this.control.query('select approved_grant_id from dental.admin_invitations where approved_grant_id is not null')).rows.map(row => row.approved_grant_id);
      for (const table of [...MANAGEMENT_TABLES].reverse()) {
        if ((await this.control.query('select to_regclass($1) is not null as present', [`dental.${table}`])).rows[0].present) {
          await this.control.query(`delete from dental.${table}`);
        }
      }
      await this.control.query('delete from dental.admin_grants where account_id=any($1::uuid[]) or id=any($2::uuid[])', [this.accounts, lifecycleGrants]);
    } catch (error) { failures.push(error); }
    // Like base.reset(), finish every safe cleanup stage before reporting an
    // earlier failure. Keep all errors if a later restoration/drop also fails.
    try { await this.base.close(); } catch (error) { failures.push(error); }
    try { await this.database.close(); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Management fixture cleanup and/or clock restoration failed; inspect the disposable target before retrying.');
  }
}

/** OID-independent, reviewed-baseline fingerprints. No account rows are pinned. */
export const MANAGEMENT_BASELINE_SQL = `select jsonb_build_object(
 'functions', (select md5(jsonb_agg(jsonb_build_object('definition',pg_get_functiondef(p.oid),'owner',pg_get_userbyid(p.proowner),
   'acl',p.proacl::text,'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,'cost',p.procost,'rows',p.prorows)
   order by p.oid::regprocedure::text collate "C")::text) from pg_proc p where p.pronamespace='dental'::regnamespace),
 'tables', (select md5(jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'owner',pg_get_userbyid(c.relowner),
  'rls',c.relrowsecurity,'force',c.relforcerowsecurity,'acl',c.relacl::text,'options',c.reloptions,
  'columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'null',a.attnotnull,
    'acl',a.attacl::text,'default',pg_get_expr(d.adbin,d.adrelid),'generated',a.attgenerated,'identity',a.attidentity)
    order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
  'constraints',(select jsonb_agg(jsonb_build_object('name',k.conname,'definition',pg_get_constraintdef(k.oid),'validated',k.convalidated)
    order by k.conname collate "C") from pg_constraint k where k.conrelid=c.oid),
  'indexes',(select jsonb_agg(pg_get_indexdef(i.indexrelid) order by pg_get_indexdef(i.indexrelid) collate "C") from pg_index i where i.indrelid=c.oid),
  'policies',(select jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
    'roles',(select array_agg(pg_get_userbyid(r) order by pg_get_userbyid(r) collate "C") from unnest(p.polroles) r),
    'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid)) order by p.polname collate "C") from pg_policy p where p.polrelid=c.oid),
  'triggers',(select jsonb_agg(jsonb_build_object('definition',pg_get_triggerdef(t.oid),'enabled',t.tgenabled) order by t.tgname collate "C") from pg_trigger t where t.tgrelid=c.oid and not t.tgisinternal),
  'rules',(select jsonb_agg(pg_get_ruledef(r.oid) order by r.rulename collate "C") from pg_rewrite r where r.ev_class=c.oid)
 ) order by c.relname collate "C")::text) from pg_class c where c.relnamespace='dental'::regnamespace and c.relkind in('r','v','m','f','p')),
 'defaults',(select md5(coalesce(jsonb_agg(jsonb_build_object('role',pg_get_userbyid(d.defaclrole),'schema',coalesce(n.nspname,''),'type',d.defaclobjtype,'acl',d.defaclacl::text)
  order by pg_get_userbyid(d.defaclrole) collate "C",coalesce(n.nspname,'') collate "C",d.defaclobjtype),'[]'::jsonb)::text)
  from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace where d.defaclrole in('postgres'::regrole,'dental_function_owner'::regrole)),
 'schema',(select md5(jsonb_build_object('owner',pg_get_userbyid(nspowner),'acl',nspacl::text)::text) from pg_namespace where nspname='dental')
) as fingerprint`;
export async function managementBaseline(client: pg.Client) {
  return (await client.query(MANAGEMENT_BASELINE_SQL)).rows[0].fingerprint as Record<string, string>;
}
