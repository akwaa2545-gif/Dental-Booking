import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Appointment, Availability, BookingInput, Intake, Patient, Service } from '../../src/shared/contracts';
import { syntheticPatient } from './fixtures';
import { databaseTarget } from './database-target';
import {waitForLockWaiters} from './wait-for-lock-waiters';

const FIXTURE_SCHEMA = 'dental_test_reservations';
const FIXTURE_LOCK = 7_438_021;
const ENTRY_POINTS = [
  'dental.availability(date,date)',
  'dental.reserve(uuid,uuid,jsonb)',
  'dental.submission(uuid,uuid)',
  'dental.list_appointments(uuid)',
  'dental.get_appointment(uuid,uuid)',
];

/** Flags record approval obtained elsewhere; setting one never grants consent.
 * This suite intentionally cannot mutate a hosted Supabase project. */
export function reservationFixtureTarget(env: NodeJS.ProcessEnv): string {
  const primary = new URL(databaseTarget(env));
  if (!['localhost', '127.0.0.1', '[::1]'].includes(primary.hostname)
    || !/^\/dental_test_[a-zA-Z0-9_]+$/.test(primary.pathname)) {
    throw new Error('Reservation fixtures require a separately approved disposable local dental_test_* database; hosted targets are forbidden.');
  }
  if (env.ALLOW_DISPOSABLE_RESERVATION_FIXTURES !== 'true') {
    throw new Error('Explicit prior approval of disposable committed fixtures and the test-only clock replacement is required. No reservation fixtures ran.');
  }
  let admin: URL;
  try {
    admin = new URL(env.TEST_RESERVATION_ADMIN_URL ?? '');
  } catch {
    throw new Error('TEST_RESERVATION_ADMIN_URL required for the same disposable local database.');
  }
  if (!['postgres:', 'postgresql:'].includes(admin.protocol) || admin.search || admin.hash
    || admin.hostname !== primary.hostname || (admin.port || '5432') !== (primary.port || '5432')
    || admin.pathname !== primary.pathname || admin.username !== 'dental_test_admin') {
    throw new Error('Fixture administrator must be dental_test_admin on the exact approved disposable local database, without connection overrides.');
  }
  return admin.href;
}

export type ReservationOutcome =
  | { kind: 'created'; appointment: Appointment }
  | { kind: 'error'; code: string; sqlState: string };

export type BackendSession = { client: pg.Client; pid: number; role: string };

export function booking(patient: Patient, date = '2026-10-09', service: Service = 'oral_check'): BookingInput {
  return { patientId: patient.id, patientVersion: patient.version, service, date, ageConfirmed: patient.age, authorizationAcknowledged: true };
}

/** Independent pg.Client instances, never a pool or 20 promises on one session.
 * The superuser exists only inside the disposable test cluster. Every request
 * executes SET LOCAL ROLE dental_backend before application code is entered. */
export class ReservationFixture {
  private constructor(private readonly connectionString: string, readonly control: pg.Client) {}
  private readonly accounts = new Set<string>();
  private readonly dates = new Set<string>();
  private readonly sessions = new Set<pg.Client>();
  private clockDefinition: string | undefined;
  private installed = false;

  static async create(): Promise<ReservationFixture> {
    const connectionString = reservationFixtureTarget(process.env);
    const control = new pg.Client({ connectionString, connectionTimeoutMillis: 5_000, application_name: 'dental-disposable-fixture' });
    await control.connect();
    const fixture = new ReservationFixture(connectionString, control);
    try {
      await fixture.install();
      return fixture;
    } catch (error) {
      await control.query('rollback').catch(() => {});
      await control.end();
      throw error;
    }
  }

  private async install(): Promise<void> {
    const { rows: [operator] } = await this.control.query(`
      select current_user, session_user, r.rolsuper, current_database() as database,
        current_setting('server_version_num')::integer as version
      from pg_roles r where r.rolname = session_user
    `);
    if (operator.current_user !== 'dental_test_admin' || operator.session_user !== 'dental_test_admin'
      || !operator.rolsuper || !/^dental_test_[a-zA-Z0-9_]+$/.test(operator.database)) {
      throw new Error('A verified isolated dental_test_admin superuser is required; no fixtures were installed.');
    }
    const { rows: [{ locked }] } = await this.control.query('select pg_try_advisory_lock($1) as locked', [FIXTURE_LOCK]);
    if (!locked) throw new Error('Another reservation suite owns this disposable database.');
    for (const signature of ENTRY_POINTS) {
      const { rows: [{ present }] } = await this.control.query('select to_regprocedure($1) is not null as present', [signature]);
      if (!present) throw new Error(`Apply the separately reviewed Task 4 migration first: missing ${signature}.`);
    }
    const { rows: [{ exists }] } = await this.control.query('select to_regnamespace($1) is not null as exists', [FIXTURE_SCHEMA]);
    if (exists) throw new Error('A prior test clock fixture exists; inspect that disposable database before retrying.');
    // Never adopt or erase an existing application's rows, even on loopback.
    for (const table of ['accounts', 'sessions', 'patients', 'clinic_dates', 'appointments', 'submission_keys', 'admin_grants', 'audit_events', 'outbox', 'notification_attempts']) {
      const { rows: [{ occupied }] } = await this.control.query(`select exists(select 1 from dental.${table}) as occupied`);
      if (occupied) throw new Error(`Disposable reservation suite requires empty dental.${table}; no cleanup or overwrite attempted.`);
    }
    const { rows: [clock] } = await this.control.query(`
      select pg_get_functiondef(p.oid) as definition, p.provolatile, p.prosecdef,
        r.rolname as owner, p.proconfig
      from pg_proc p join pg_roles r on r.oid = p.proowner
      where p.oid = 'dental.clock_now()'::regprocedure
    `);
    if (clock.owner !== 'dental_function_owner' || clock.provolatile !== 'v' || clock.prosecdef
      || !clock.proconfig?.includes('search_path=""') || !clock.definition.includes('pg_catalog.clock_timestamp()')) {
      throw new Error('Expected the reviewed production clock before installing the disposable-only test clock.');
    }
    this.clockDefinition = clock.definition;
    // Capture real installed definitions before replacing the production clock.
    // Hashes are evidence, not proof that an unapplied candidate has executed.
    const candidate = await readFile('db/migrations/003_reservations.sql', 'utf8');
    const { rows: definitions } = await this.control.query(`
      select p.oid::regprocedure::text as signature, pg_get_functiondef(p.oid) as definition
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'dental' order by p.oid::regprocedure::text
    `);
    console.info(JSON.stringify({
      evidence: 'reservation_database_before_test_clock',
      environment: 'optional_disposable_local_postgresql',
      serverVersion: operator.version,
      candidate003Hash: createHash('sha256').update(candidate).digest('hex'),
      actualFunctionHash: createHash('sha256').update(JSON.stringify(definitions)).digest('hex'),
    }));
    await this.control.query('begin');
    try {
      // All fixture objects are new and outside the production schema. Ownership
      // supplies the helper's access without changing any application role grant.
      await this.control.query(`
        create schema ${FIXTURE_SCHEMA} authorization dental_function_owner;
        revoke all on schema ${FIXTURE_SCHEMA} from public;
        create table ${FIXTURE_SCHEMA}.clock (
          singleton boolean primary key check (singleton),
          value timestamptz not null
        );
        alter table ${FIXTURE_SCHEMA}.clock owner to dental_function_owner;
        revoke all on table ${FIXTURE_SCHEMA}.clock from public;
        insert into ${FIXTURE_SCHEMA}.clock values (true, '2026-10-08T05:00:00Z');
        create or replace function dental.clock_now() returns timestamptz
        language sql volatile security invoker set search_path = ''
        as $test_clock$ select value from ${FIXTURE_SCHEMA}.clock where singleton $test_clock$;
      `);
      await this.control.query('commit');
      this.installed = true;
    } catch (error) {
      await this.control.query('rollback');
      throw error;
    }
  }

  async setClock(instant: string): Promise<void> {
    await this.control.query(`update ${FIXTURE_SCHEMA}.clock set value = $1::timestamptz where singleton`, [instant]);
  }

  async account(): Promise<string> {
    const id = randomUUID();
    this.accounts.add(id);
    await this.control.query("insert into dental.accounts(id, provider, subject) values ($1::uuid, 'synthetic-task4', $1::text)", [id]);
    return id;
  }

  async patient(actor: string): Promise<Patient> {
    return this.call<Patient>('select dental.create_patient($1, $2::jsonb) as result', [actor, syntheticPatient]);
  }

  async date(date: string, intake: Intake = 'open'): Promise<void> {
    this.dates.add(date);
    await this.control.query(`insert into dental.clinic_dates(date, intake) values ($1::date, $2)
      on conflict (date) do update set intake = excluded.intake`, [date, intake]);
  }

  async session(): Promise<BackendSession> {
    const client = new pg.Client({ connectionString: this.connectionString, connectionTimeoutMillis: 5_000, application_name: 'dental-disposable-reservation' });
    try {
      await client.connect();
      this.sessions.add(client);
      await client.query("begin; set local role dental_backend; set local statement_timeout = '10s'; set local lock_timeout = '9s'; set local timezone = 'Pacific/Honolulu'");
      const { rows: [identity] } = await client.query('select pg_backend_pid() as pid, current_user as role');
      if (identity.role !== 'dental_backend') throw new Error('Reservation did not assume the restricted runtime role.');
      return { client, pid: identity.pid, role: identity.role };
    } catch (error) {
      await client.end().catch(() => {});
      this.sessions.delete(client);
      throw error;
    }
  }

  async closeSession(session: BackendSession): Promise<void> {
    try { await session.client.query('rollback'); }
    finally { await session.client.end(); this.sessions.delete(session.client); }
  }

  async call<T>(sql: string, values: unknown[] = []): Promise<T> {
    const session = await this.session();
    try {
      const { rows: [row] } = await session.client.query(sql, values);
      await session.client.query('commit');
      return row.result as T;
    } catch (error) {
      await session.client.query('rollback');
      throw error;
    } finally {
      await this.closeSession(session);
    }
  }

  async reserve(actor: string, key: string, input: BookingInput): Promise<Appointment> {
    this.dates.add(input.date);
    return this.call<Appointment>('select dental.reserve($1, $2, $3::jsonb) as result', [actor, key, input]);
  }

  async attempt(session: BackendSession, actor: string, key: string, input: BookingInput): Promise<ReservationOutcome> {
    this.dates.add(input.date);
    try {
      const { rows: [row] } = await session.client.query('select dental.reserve($1, $2, $3::jsonb) as result', [actor, key, input]);
      await session.client.query('commit');
      return { kind: 'created', appointment: row.result as Appointment };
    } catch (error) {
      await session.client.query('rollback');
      // Return the actual server outcome; unexpected infrastructure failures fail
      // exact FULL/IDEMPOTENCY_CONFLICT assertions instead of counting as losers.
      if (error instanceof Error && 'code' in error) {
        return { kind: 'error', code: error.message, sqlState: String(error.code) };
      }
      throw error;
    }
  }

  async availability(from: string, to: string): Promise<Availability[]> {
    return this.call<Availability[]>('select dental.availability($1::date, $2::date) as result', [from, to]);
  }

  async count(date: string): Promise<number> {
    const { rows: [{ count }] } = await this.control.query("select count(*)::integer as count from dental.appointments where date = $1::date and status in ('pending', 'approved')", [date]);
    return count;
  }

  async lockDate(date: string): Promise<pg.Client> {
    this.dates.add(date);
    const locker = new pg.Client({ connectionString: this.connectionString, connectionTimeoutMillis: 5_000 });
    try {
      await locker.connect();
      this.sessions.add(locker);
      await locker.query("begin; set local statement_timeout = '10s'");
      const result = await locker.query('select date from dental.clinic_dates where date = $1::date for update', [date]);
      if (result.rowCount !== 1) throw new Error('The cutoff/date-lock fixture must lock an existing row.');
      return locker;
    } catch (error) {
      await locker.end().catch(() => {});
      this.sessions.delete(locker);
      throw error;
    }
  }

  async lockPatient(id: string): Promise<pg.Client> {
    const locker = new pg.Client({ connectionString: this.connectionString, connectionTimeoutMillis: 5_000 });
    try {
      await locker.connect();
      this.sessions.add(locker);
      await locker.query("begin; set local statement_timeout = '10s'");
      const result = await locker.query('select id from dental.patients where id = $1::uuid for update', [id]);
      if (result.rowCount !== 1) throw new Error('The patient-lock fixture must lock an existing row.');
      return locker;
    } catch (error) {
      await locker.end().catch(() => {});
      this.sessions.delete(locker);
      throw error;
    }
  }

  async lockMissingDateInsert(): Promise<pg.Client> {
    const locker = new pg.Client({ connectionString: this.connectionString, connectionTimeoutMillis: 5_000 });
    try {
      await locker.connect();
      this.sessions.add(locker);
      await locker.query("begin; set local statement_timeout = '10s'; lock table dental.clinic_dates in share mode");
      return locker;
    } catch (error) {
      await locker.end().catch(() => {});
      this.sessions.delete(locker);
      throw error;
    }
  }

  async unlock(locker: pg.Client, outcome: 'commit' | 'rollback' = 'rollback'): Promise<void> {
    try { await locker.query(outcome); }
    finally { await locker.end(); this.sessions.delete(locker); }
  }

  /** Observe server lock waits, never infer contention from an arbitrary sleep. */
  async waitForLockWaiters(pids: number[], blocker?: number): Promise<void> {
    return waitForLockWaiters(this.control,pids,blocker);
  }

  /** Release every owned request connection before a dependent fixture cleans
   * its foreign-key rows. Attempt every close even if one rollback fails. */
  async closeSessions(): Promise<void> {
    const sessions = [...this.sessions];
    this.sessions.clear();
    const closed = await Promise.allSettled(sessions.map(async client => {
      try { await client.query('rollback'); } finally { await client.end(); }
    }));
    if (closed.some(result => result.status === 'rejected')) throw new Error('A database session failed to close during fixture cleanup.');
  }

  async reset(): Promise<void> {
    // Preserve row cleanup even if one request close fails.
    let sessionError: unknown;
    try { await this.closeSessions(); } catch (error) { sessionError = error; }
    const ids = [...this.accounts];
    await this.control.query('begin');
    try {
      await this.control.query('delete from dental.audit_events where actor_account_id = any($1::uuid[])', [ids]);
      await this.control.query('delete from dental.submission_keys where owner_account_id = any($1::uuid[])', [ids]);
      await this.control.query('delete from dental.appointments where owner_account_id = any($1::uuid[])', [ids]);
      await this.control.query('delete from dental.patients where owner_account_id = any($1::uuid[])', [ids]);
      await this.control.query('delete from dental.clinic_dates where date = any($1::date[])', [[...this.dates]]);
      await this.control.query('delete from dental.accounts where id = any($1::uuid[])', [ids]);
      await this.control.query('commit');
      this.accounts.clear();
      this.dates.clear();
      await this.setClock('2026-10-08T05:00:00Z');
    } catch (error) {
      await this.control.query('rollback');
      throw error;
    }
    if (sessionError) throw sessionError;
  }

  async close(): Promise<void> {
    const failures: unknown[] = [];
    try {
      if (this.installed) {
        // reset awaits every client rollback/end attempt before it can reject.
        // A row-cleanup failure must not leave the committed test clock installed.
        try { await this.reset(); } catch (error) { failures.push(error); }
        try {
          await this.control.query('begin');
          await this.control.query("set local statement_timeout = '10s'; set local lock_timeout = '3s'");
          await this.control.query(this.clockDefinition!);
          await this.control.query(`drop table ${FIXTURE_SCHEMA}.clock; drop schema ${FIXTURE_SCHEMA}`);
          await this.control.query('commit');
          const { rows: [{ definition }] } = await this.control.query("select pg_get_functiondef('dental.clock_now()'::regprocedure) as definition");
          if (definition !== this.clockDefinition) throw new Error('Production clock restoration did not match its original definition.');
          this.installed = false;
        } catch (error) {
          failures.push(error);
          try { await this.control.query('rollback'); } catch (rollbackError) { failures.push(rollbackError); }
        }
      }
    } finally {
      try { await this.control.end(); } catch (error) { failures.push(error); }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Reservation fixture cleanup and/or clock restoration failed; inspect the disposable target before retrying.');
  }
}
