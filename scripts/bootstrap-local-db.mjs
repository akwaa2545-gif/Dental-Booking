// Local fixture provisioning only. Run through run-local-db.sh in a fresh cluster.
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { assembleMigration } from './migration-bundle.ts';

const port = Number(process.env.ADMIN_NOTIFICATION_PG_PORT ?? '55483');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Expected a non-privileged local test port.');
const base = { host: '127.0.0.1', port };
const operator = new pg.Client({ ...base, user: 'supabase_admin', database: 'postgres' });
await operator.connect();
try {
  await operator.query(`CREATE ROLE dental_test_admin LOGIN SUPERUSER;
    CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE CREATEDB BYPASSRLS;
    CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE authenticator NOLOGIN; CREATE ROLE service_role NOLOGIN;
    GRANT anon,authenticated TO postgres WITH INHERIT FALSE, SET TRUE;`);
  await operator.query('CREATE DATABASE dental_test_admin_notifications OWNER postgres');
} finally { await operator.end(); }
const db = new pg.Client({ ...base, user: 'postgres', database: 'dental_test_admin_notifications' });
await db.connect();
try {
  await db.query("set statement_timeout='120s'");
  const read = name => readFile(new URL(`../db/migrations/${name}`, import.meta.url), 'utf8');
  const bundle = assembleMigration(await Promise.all(['001_private_schema.sql', '002_identity_patients.sql'].map(read)));
  await db.query(bundle);
  console.info(JSON.stringify({ local: true, migration: '001+002 bundle', sha256: createHash('sha256').update(bundle).digest('hex') }));
  for (const name of ['003_reservations.sql', '004_sessions.sql', '005_transitions.sql']) {
    const source = await read(name); await db.query(source);
    console.info(JSON.stringify({ local: true, migration: name, sha256: createHash('sha256').update(source).digest('hex') }));
  }
  await db.query('CREATE ROLE dental_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT; GRANT dental_backend TO dental_runtime WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY postgres');
  for (const name of ['006_notifications.sql', '008_request_limits.sql', '009_restricted_dispatch.sql', '010_restricted_dispatch_deadline.sql', '011_clinic_cancellation.sql']) {
    const source = await read(name); await db.query(source);
    console.info(JSON.stringify({ local: true, migration: name, sha256: createHash('sha256').update(source).digest('hex') }));
  }
} finally { await db.end(); }
// A separate pristine 011 database is needed because migration tests deliberately
// roll DDL back; legacy exact-catalog tests must never run against the new lane.
const clone = new pg.Client({ ...base, user: 'supabase_admin', database: 'postgres' });
await clone.connect();
try { await clone.query('CREATE DATABASE dental_test_admin_notifications_migration TEMPLATE dental_test_admin_notifications OWNER postgres'); }
finally { await clone.end(); }
if (process.env.ADMIN_NOTIFICATION_APPLY_012 !== 'false') {
  const candidate = new URL('../db/migrations/012_admin_booking_notifications.sql', import.meta.url);
  let source;
  try { source = await readFile(candidate, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; console.info('Migration 012 is absent: running RED against reviewed baseline 011.'); }
  if (source) {
    const candidateDb = new pg.Client({ ...base, user: 'postgres', database: 'dental_test_admin_notifications' });
    await candidateDb.connect();
    try {
      await candidateDb.query("set statement_timeout='120s'");
      await candidateDb.query(source);
      console.info(JSON.stringify({ local: true, migration: '012_admin_booking_notifications.sql', sha256: createHash('sha256').update(source).digest('hex') }));
    } finally { await candidateDb.end(); }
  }
}
