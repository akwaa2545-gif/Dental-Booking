import pg from 'pg';
import { ReservationFixture, reservationFixtureTarget, type BackendSession } from './reservation-postgres';

export const ADMIN_MIGRATION = 'db/migrations/012_admin_booking_notifications.sql';
export const FIXTURE_NOW = '2026-10-08T05:00:00.000Z';
export const FIXTURE_END = '2026-10-09T05:00:00.000Z';
export const POLICY_SIGNATURE = 'dental.set_admin_notification_policy(uuid,integer,boolean,timestamp with time zone,timestamp with time zone,text)';
export const ADMIN_TABLES = ['admin_booking_events', 'admin_booking_deliveries', 'admin_notification_attempts', 'admin_notification_policy', 'admin_notification_budget', 'admin_notification_budget_reservations'];
export type BudgetSettings = {
  expectedVersion: number; verifiedFrom: string; verifiedUntil: string;
  freeLimit: number; baselineUsage: number; noOverageVerified: boolean; reason: string;
};

export type AdminIdentity = { account: string; grant: string; provider: string; recipient: string };
export type DeliveryRow = {
  id: string; event_id: string; grant_id: string; account_id: string;
  frozen_provider: string | null; frozen_recipient: string | null;
  retry_key: string; state: string; safe_reason: string | null;
  due_at: Date; lease_owner: string | null; lease_until: Date | null; attempt_count: number;
};

/** Every control connection goes through the established synthetic-loopback gate.
 * This helper cannot create a hosted target, a real role or a provider send. */
export async function localAdminConnection(databaseSuffix = ''): Promise<pg.Client> {
  const url = new URL(reservationFixtureTarget(process.env));
  if (databaseSuffix !== '' && databaseSuffix !== '_migration') throw new Error('Unreviewed local fixture database suffix.');
  url.pathname += databaseSuffix;
  const client = new pg.Client({ connectionString: url.href, connectionTimeoutMillis: 5_000 });
  await client.connect();
  const { rows: [identity] } = await client.query('select session_user,current_database() as database,current_setting(\'server_version_num\')::integer as version');
  if (identity.session_user !== 'dental_test_admin' || identity.database !== url.pathname.slice(1) || Math.floor(identity.version / 10000) !== 17) {
    await client.end(); throw new Error('Expected the exact approved synthetic PostgreSQL 17 fixture.');
  }
  await client.query("set statement_timeout='10s'; set lock_timeout='5s'");
  return client;
}

export class AdminNotificationFixture {
  private readonly accounts: string[] = [];
  private readonly sessions = new Set<BackendSession>();
  private readonly mappings: { provider: string; recipient: string }[] = [];
  private readonly budgetEpochs = new Set<string>();
  private constructor(readonly base: ReservationFixture) {}
  get control() { return this.base.control; }

  static async create(): Promise<AdminNotificationFixture> {
    const base = await ReservationFixture.create();
    const fixture = new AdminNotificationFixture(base);
    try {
      for (const table of ADMIN_TABLES.filter(table => table !== 'admin_notification_policy')) {
        const { rows: [{ present }] } = await base.control.query('select to_regclass($1) is not null as present', [`dental.${table}`]);
        if (present && (await base.control.query(`select exists(select from dental.${table}) as occupied`)).rows[0].occupied) {
          throw new Error(`Refusing to adopt existing dental.${table} fixture rows.`);
        }
      }
      return fixture;
    } catch (error) { await base.close(); throw error; }
  }

  async session(): Promise<BackendSession> {
    const session = await this.base.session(); this.sessions.add(session); return session;
  }

  async closeSession(session: BackendSession): Promise<void> {
    try { await this.base.closeSession(session); } finally { this.sessions.delete(session); }
  }

  async account(): Promise<string> {
    const id = await this.base.account(); this.accounts.push(id); return id;
  }

  async admin(options: { mapped?: boolean; reachable?: boolean | null; provider?: string; recipient?: string } = {}): Promise<AdminIdentity> {
    const account = await this.account();
    const provider = options.provider ?? 'line:synthetic-admin';
    const recipient = options.recipient ?? `U${account.replaceAll('-', '')}`;
    if (options.mapped !== false) {
      await this.control.query('update dental.accounts set provider=$2,subject=$3 where id=$1', [account, provider, recipient]);
      if (options.reachable !== null) {
        await this.control.query(`insert into dental.line_reachability(provider,subject,reachable,event_at,event_id,updated_at)
          values($1,$2,$3,dental.clock_now(),'01J00000000000000000000000',dental.clock_now())`, [provider, recipient, options.reachable ?? true]);
        this.mappings.push({ provider, recipient });
      }
    }
    const { rows: [{ id: grant }] } = await this.control.query('insert into dental.admin_grants(account_id) values($1) returning id', [account]);
    return { account, grant, provider, recipient };
  }

  async operatorCall<T>(sql: string, params: unknown[] = []): Promise<T> {
    const connection = await localAdminConnection();
    try {
      await connection.query('set session authorization postgres');
      const { rows: [row] } = await connection.query(sql, params);
      return row?.result as T;
    } finally { await connection.end(); }
  }

  async policy(operator: string, enabled = true, activation: string | null = FIXTURE_NOW, end: string | null = FIXTURE_END): Promise<unknown> {
    const { rows: [{ version }] } = await this.control.query('select version from dental.admin_notification_policy');
    return this.operatorCall('select dental.set_admin_notification_policy($1,$2,$3,$4,$5,$6) as result', [operator, version, enabled, activation, end, 'Approved synthetic fixture only']);
  }

  async budget(operator: string, overrides: Partial<BudgetSettings> = {}): Promise<number> {
    const settings: BudgetSettings = { expectedVersion: 0, verifiedFrom: FIXTURE_NOW, verifiedUntil: FIXTURE_END,
      freeLimit: 300, baselineUsage: 0, noOverageVerified: true, reason: 'Approved synthetic free-only budget', ...overrides };
    const version = await this.operatorCall<number>('select dental.set_admin_notification_budget($1,$2,$3,$4,$5,$6,$7,$8) as result',
      [operator, settings.expectedVersion, settings.verifiedFrom, settings.verifiedUntil, settings.freeLimit,
        settings.baselineUsage, settings.noOverageVerified, settings.reason]);
    const { rows: [{ epoch }] } = await this.control.query('select epoch from dental.admin_notification_budget where version=$1', [version]);
    this.budgetEpochs.add(epoch);
    return version;
  }

  async revoke(operator: string, identity: AdminIdentity): Promise<void> {
    await this.operatorCall('select dental.set_admin_grant($1,$2,false,$3) as result', [operator, identity.account, 'Synthetic revoke boundary']);
  }

  async deliveries(): Promise<DeliveryRow[]> {
    return (await this.control.query<DeliveryRow>('select * from dental.admin_booking_deliveries order by grant_id')).rows;
  }

  async counts() {
    return (await this.control.query(`select
      (select count(*)::integer from dental.admin_booking_events) as events,
      (select count(*)::integer from dental.admin_booking_deliveries) as deliveries,
      (select count(*)::integer from dental.appointments) as appointments,
      (select count(*)::integer from dental.submission_keys) as keys,
      (select count(*)::integer from dental.outbox) as patient_outbox,
      (select count(*)::integer from dental.notification_attempts) as patient_attempts`)).rows[0];
  }

  async reset(): Promise<void> {
    // Release in-flight reservation locks before deleting only our own rows.
    for (const session of this.sessions) await this.closeSession(session);
    await this.control.query('rollback; reset session authorization');
    for (const table of ['admin_notification_budget_reservations', 'admin_notification_attempts', 'admin_booking_deliveries', 'admin_booking_events']) {
      const { rows: [{ present }] } = await this.control.query('select to_regclass($1) is not null as present', [`dental.${table}`]);
      if (!present) continue;
      const ownedEvents = 'select e.id from dental.admin_booking_events e join dental.appointments a on a.id=e.appointment_id where a.owner_account_id=any($1::uuid[])';
      const predicate = ['admin_notification_budget_reservations', 'admin_notification_attempts'].includes(table) ? `delivery_id in(select id from dental.admin_booking_deliveries where event_id in(${ownedEvents}))`
        : table === 'admin_booking_deliveries' ? `event_id in(${ownedEvents})` : `id in(${ownedEvents})`;
      await this.control.query(`delete from dental.${table} where ${predicate}`, [this.accounts]);
    }
    if (this.budgetEpochs.size) await this.control.query('delete from dental.admin_notification_budget where epoch=any($1::uuid[])', [[...this.budgetEpochs]]);
    await this.control.query('delete from dental.notification_attempts where outbox_id in(select o.id from dental.outbox o join dental.appointments a on a.id=o.appointment_id where a.owner_account_id=any($1::uuid[]))', [this.accounts]);
    await this.control.query('delete from dental.outbox where appointment_id in(select id from dental.appointments where owner_account_id=any($1::uuid[]))', [this.accounts]);
    await this.control.query('delete from dental.admin_grants where account_id=any($1::uuid[])', [this.accounts]);
    for (const mapping of this.mappings) await this.control.query('delete from dental.line_reachability where provider=$1 and subject=$2', [mapping.provider, mapping.recipient]);
    const { rows: [{ policyPresent }] } = await this.control.query("select to_regclass('dental.admin_notification_policy') is not null as \"policyPresent\"");
    if (policyPresent) await this.control.query('update dental.admin_notification_policy set enabled=false,version=1,activation_at=null,authorized_end_at=null');
    await this.base.reset(); this.accounts.length = 0; this.mappings.length = 0; this.budgetEpochs.clear();
  }

  async close(): Promise<void> { try { await this.reset(); } finally { await this.base.close(); } }
}
