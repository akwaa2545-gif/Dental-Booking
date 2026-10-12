import pg from 'pg';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { AdminNotificationFixture, localAdminConnection } from './admin-notification-postgres';
import { reservationFixtureTarget, type BackendSession } from './reservation-postgres';

export const COMBINED_MIGRATION = 'db/migrations/013_combined_notifications.sql';
export const COMBINED_START = '2026-10-08T05:00:00.000Z';
export const COMBINED_END = '2026-10-15T05:00:00.000Z';
export const ENROLLMENT_TABLE = 'dental.notification_booking_enrollments';

/** Clone the runner's pristine 011 fixture, then apply 012. Each caller owns a
 * fresh UUID-named database. Neither the runner's 011 nor 012 database changes. */
export async function combinedDatabase(applyCandidate = false) {
  const source = new URL(reservationFixtureTarget(process.env));
  const name = `dental_test_combined_${randomUUID().replaceAll('-', '')}`;
  const provisioner = await localAdminConnection();
  try {
    await provisioner.query(`create database "${name}" template "${source.pathname.slice(1)}_migration" owner postgres`);
  } finally { await provisioner.end(); }
  const target = new URL(source); target.pathname = `/${name}`;
  const connect = async () => {
    const client = new pg.Client({ connectionString: target.href, connectionTimeoutMillis: 5_000 });
    await client.connect();
    const { rows: [identity] } = await client.query("select session_user,current_database() as database,current_setting('server_version_num')::integer as version");
    if (identity.session_user !== 'dental_test_admin' || identity.database !== name || Math.floor(identity.version / 10000) !== 17) {
      await client.end(); throw new Error('Expected the exact disposable combined PostgreSQL 17 fixture.');
    }
    await client.query("set statement_timeout='120s'; set lock_timeout='7s'");
    return client;
  };
  const bootstrap = await connect();
  try {
    if ((await bootstrap.query("select to_regclass('dental.admin_notification_policy') as candidate")).rows[0].candidate !== null) {
      throw new Error('Combined tests require a pristine 011 template, not an adopted application database.');
    }
    await bootstrap.query('set session authorization postgres');
    await bootstrap.query(readFileSync('db/migrations/012_admin_booking_notifications.sql', 'utf8'));
    // An absent 013 deliberately leaves real 012 installed for feature-missing RED.
    if (applyCandidate && existsSync(COMBINED_MIGRATION)) await bootstrap.query(readFileSync(COMBINED_MIGRATION, 'utf8'));
  } finally { await bootstrap.end(); }
  return { name, target, connect, async close() {
    const cleanup = await localAdminConnection();
    try { await cleanup.query(`drop database "${name}"`); } finally { await cleanup.end(); }
  } };
}

export class CombinedNotificationFixture {
  private readonly accounts: string[] = [];
  private readonly sessions = new Set<BackendSession>();
  private constructor(readonly inner: AdminNotificationFixture, readonly database: Awaited<ReturnType<typeof combinedDatabase>>) {}
  get control() { return this.inner.control; }
  get base() { return this.inner.base; }

  static async create(migrations: string[] = [], beforeFixture?: (client: pg.Client) => Promise<void>) {
    const database = await combinedDatabase(true);
    if (migrations.length || beforeFixture) {
      const setup = await database.connect();
      try { await setup.query('set session authorization postgres'); for (const path of migrations) if (existsSync(path)) await setup.query(readFileSync(path, 'utf8')); await beforeFixture?.(setup); }
      catch (error) { await setup.end(); await database.close(); throw error; }
      await setup.end();
    }
    const oldPrimary = process.env.TEST_DATABASE_URL, oldAdmin = process.env.TEST_RESERVATION_ADMIN_URL;
    const primary = new URL(database.target); primary.username = 'postgres';
    try {
      process.env.TEST_DATABASE_URL = primary.href;
      process.env.TEST_RESERVATION_ADMIN_URL = database.target.href;
      return new CombinedNotificationFixture(await AdminNotificationFixture.create(), database);
    } catch (error) { await database.close(); throw error; }
    finally { process.env.TEST_DATABASE_URL = oldPrimary; process.env.TEST_RESERVATION_ADMIN_URL = oldAdmin; }
  }
  async account() { const id = await this.inner.account(); this.accounts.push(id); return id; }
  async admin() { return this.inner.admin(); }
  async session() { const session = await this.inner.session(); this.sessions.add(session); return session; }
  async closeSession(session: BackendSession) { try { await this.inner.closeSession(session); } finally { this.sessions.delete(session); } }
  async operatorCall<T>(sql: string, params: unknown[] = []) {
    const connection = await this.database.connect();
    try {
      await connection.query('set session authorization postgres');
      return (await connection.query(sql, params)).rows[0]?.result as T;
    } finally { await connection.end(); }
  }
  async policy(operator: string, enabled = true, activation: string | null = COMBINED_START, end: string | null = COMBINED_END) {
    const { rows: [{ version }] } = await this.control.query('select version from dental.admin_notification_policy');
    return this.operatorCall<number>('select dental.set_admin_notification_policy($1,$2,$3,$4,$5,$6) as result',
      [operator, version, enabled, activation, end, 'Approved synthetic combined fixture']);
  }
  async enrollments() { return (await this.control.query(`select * from ${ENROLLMENT_TABLE} order by appointment_id`)).rows; }
  async queueDigest() {
    return (await this.control.query(`select md5(coalesce(jsonb_agg(to_jsonb(o) order by o.id)::text,'[]')) as outbox,
      (select md5(coalesce(jsonb_agg(to_jsonb(a) order by a.id)::text,'[]')) from dental.notification_attempts a) as attempts from dental.outbox o`)).rows[0];
  }
  async reset() {
    for (const session of this.sessions) await this.closeSession(session);
    if ((await this.control.query("select to_regclass('dental.patient_dispatch_authorizations') is not null as present")).rows[0].present) {
      await this.control.query(`delete from dental.patient_dispatch_authorizations where outbox_id in(
        select o.id from dental.outbox o join dental.appointments a on a.id=o.appointment_id where a.owner_account_id=any($1::uuid[]))`, [this.accounts]);
    }
    if ((await this.control.query("select to_regclass('dental.patient_notification_budget_reservations') is not null as present")).rows[0].present) {
      await this.control.query(`delete from dental.patient_notification_budget_reservations where outbox_id in(
        select o.id from dental.outbox o join dental.appointments a on a.id=o.appointment_id where a.owner_account_id=any($1::uuid[]))`, [this.accounts]);
    }
    if ((await this.control.query('select to_regclass($1) is not null as present', [ENROLLMENT_TABLE])).rows[0].present) {
      await this.control.query(`delete from ${ENROLLMENT_TABLE} where appointment_id in(select id from dental.appointments where owner_account_id=any($1::uuid[]))`, [this.accounts]);
    }
    await this.inner.reset(); this.accounts.length = 0;
  }
  async close() { try { await this.reset(); await this.inner.close(); } finally { await this.database.close(); } }
}
