// Disposable new local PG17 cluster only; called by validate-restricted-postgres.sh.
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {assembleMigration} from './migration-bundle.ts';
if(process.env.ALLOW_DISPOSABLE_MIGRATION_FIXTURES!=='true')throw new Error('Prior disposable local validation approval required');
const port=Number(process.env.RESTRICTED_TEST_PORT);if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid loopback test port');
const base={host:'127.0.0.1',port};
const admin=new pg.Client({...base,user:'supabase_admin',database:'postgres'});await admin.connect();
await admin.query(`CREATE ROLE dental_test_admin LOGIN SUPERUSER;
CREATE ROLE postgres LOGIN NOSUPERUSER CREATEROLE CREATEDB BYPASSRLS;
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE authenticator NOLOGIN; CREATE ROLE service_role NOLOGIN;
GRANT anon, authenticated TO postgres WITH INHERIT FALSE, SET TRUE;
CREATE DATABASE dental_test_restricted OWNER postgres;` .replace('CREATE DATABASE dental_test_restricted OWNER postgres;',''));
await admin.query('CREATE DATABASE dental_test_restricted OWNER postgres'); await admin.end();
const db=new pg.Client({...base,user:'postgres',database:'dental_test_restricted'});await db.connect();
await db.query("set statement_timeout='120s'");
const path=new URL('../db/migrations/',import.meta.url).pathname;
const bundle=assembleMigration(await Promise.all(['001_private_schema.sql','002_identity_patients.sql'].map(n=>readFile(path+n,'utf8'))));
await db.query(bundle);console.log('APPLIED 001+002 bundle');
for(const n of ['003_reservations.sql','004_sessions.sql','005_transitions.sql']){await db.query(await readFile(path+n,'utf8'));console.log('APPLIED '+n);}
await db.query('CREATE ROLE dental_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT; GRANT dental_backend TO dental_runtime WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY postgres');
await db.query(await readFile(path+'006_notifications.sql','utf8'));console.log('APPLIED 006_notifications.sql');
await db.query(await readFile(path+'008_request_limits.sql','utf8')); await db.end();
