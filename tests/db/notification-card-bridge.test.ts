// Reconstructed regression coverage against the unchanged, byte-verified recovered migrations.
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import type pg from 'pg';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {adminManagementDatabase, managementBaseline} from '../support/admin-management-postgres';

const bridge = readFileSync('db/migrations/015_notification_card_versions.sql', 'utf8');
const activation = readFileSync('db/migrations/016_activate_notification_cards.sql', 'utf8');
const baseline014 = {schema:'4ae008106c89761f7c6d1788e7cdf716', tables:'ef5b33f72b16f612071b5efba83f0ce6', defaults:'4146858b1996fc4459bbe6f4feaddbc3', functions:'5600e8b53eecf933b01f286e5f480b5a'};
const baseline015 = {...baseline014, tables:'c8f9ee91a2a130dab6a0158552ae1209', functions:'4e565fc02c7471fd2c738b8e01bcdf08'};
const baseline016 = {...baseline014, tables:'c9b0784fec8b33ab77b8aa7f128f6a7e', functions:'2e6eb693262007ee7ba243e413300609'};
let database: Awaited<ReturnType<typeof adminManagementDatabase>>, control: pg.Client;

async function seed() {
 const account=randomUUID(), patient=randomUUID(), appointment=randomUUID(), grant=randomUUID(), event=randomUUID();
 await control.query("insert into dental.accounts(id,provider,subject) values($1::uuid,'synthetic-card-bridge',$1::text)",[account]);
 await control.query("insert into dental.patients(id,owner_account_id,full_name,phone,age,address,relationship,authorization_acknowledged) values($1,$2,'Synthetic card patient','0800000000',30,'Synthetic address','self',true)",[patient,account]);
 await control.query("insert into dental.clinic_dates(date) values(current_date+10) on conflict do nothing");
 await control.query("insert into dental.appointments(id,owner_account_id,patient_id,patient_version,patient_snapshot,age_captured_on,service,date,idempotency_key) values($1,$2,$3,1,$5::jsonb,current_date,'oral_check',current_date+10,$4)",[appointment,account,patient,randomUUID(),JSON.stringify({fullName:"Synthetic card patient",phone:"0800000000",age:30,address:"Synthetic address",relationship:"self",authorizationAcknowledged:true})]);
 await control.query('insert into dental.admin_grants(id,account_id) values($1,$2)',[grant,account]);
 await control.query("insert into dental.admin_booking_events(id,appointment_id,created_at,expires_at,reference,requested_date) values($1,$2,statement_timestamp(),statement_timestamp()+interval '24 hours','D-synthetic',current_date+10)",[event,appointment]);
 await control.query("insert into dental.admin_booking_deliveries(event_id,grant_id,account_id,recipient_index,state,created_at,due_at) values($1,$2,$3,1,'suppressed',dental.clock_now(),dental.clock_now())",[event,grant,account]);
 return appointment;
}
async function insertEvent(appointment:string,type:string,version=1) {
 return (await control.query("insert into dental.outbox(appointment_id,appointment_version,type,due_at,expires_at) values($1,$2,$3,dental.clock_now(),dental.clock_now()+interval '24 hours') returning *",[appointment,version,type])).rows[0];
}
async function queueRows() {
 return (await control.query(`select jsonb_build_object('patient',(select jsonb_agg(to_jsonb(o) order by o.id) from dental.outbox o),'admin',(select jsonb_agg(to_jsonb(d) order by d.id) from dental.admin_booking_deliveries d)) as rows`)).rows[0].rows;
}

describe('recovered notification-card compatibility bridge on PostgreSQL 17',()=>{
 beforeEach(async()=>{database=await adminManagementDatabase(true);control=await database.connect();});
 afterEach(async()=>{await control?.query('rollback; reset session authorization');await control?.end();await database?.close();});
 it('uses the byte-exact recovered migrations and reviewed committed catalog generations',async()=>{
  expect(createHash('sha256').update(bridge).digest('hex')).toBe('afd501787a7189e5e6f12424eff036195bc1c98a1e157102145a8299e1ee3445');
  expect(createHash('sha256').update(activation).digest('hex')).toBe('27e510126696ab821d6d2312e5d8d213f4563070e1e6ae2fd2faeda814b2974b');
  expect(await managementBaseline(control)).toEqual(baseline014);
  await control.query('set session authorization postgres');await control.query(bridge);
  expect(await managementBaseline(control)).toEqual(baseline015);
  await control.query(activation);expect(await managementBaseline(control)).toEqual(baseline016);
 });
 it('pins historical rows without changing keys, states, timestamps, or any other row bytes',async()=>{
  const appointment=await seed();for(const type of ['approval','rejection','reminder','cancellation'])await insertEvent(appointment,type);
  const before=await queueRows();await control.query('set session authorization postgres');await control.query(bridge);
  const pinned=await queueRows();await control.query('reset session authorization');
  expect(pinned.patient.map((row:Record<string,unknown>)=>{const copy={...row};delete copy.payload_version;return copy;})).toEqual(before.patient);
  expect(pinned.admin).toEqual(before.admin);
  expect(pinned.patient.map((row:{type:string;payload_version:number})=>[row.type,row.payload_version]).sort()).toEqual([['approval',1],['cancellation',2],['rejection',1],['reminder',1]]);
  expect((await insertEvent(appointment,'approval',2)).payload_version).toBe(1);
  const preActivation=await queueRows();await control.query('set session authorization postgres');await control.query(activation);await control.query('reset session authorization');expect(await queueRows()).toEqual(preActivation);
  expect((await insertEvent(appointment,'approval',3)).payload_version).toBe(3);
  expect((await insertEvent(appointment,'cancellation',3)).payload_version).toBe(2);
 });
 it.each([false,true])('rejects activation in the bridge transaction (released savepoint: %s) and rolls back the bridge',async savepoint=>{
  await control.query('set session authorization postgres; begin');if(savepoint)await control.query('savepoint compatibility');
  await control.query(bridge);if(savepoint)await control.query('release savepoint compatibility');
  await expect(control.query(activation)).rejects.toThrow(/must commit in a separate transaction/);
  await control.query('rollback');expect(await managementBaseline(control)).toEqual(baseline014);
  expect((await control.query("select to_regprocedure('dental.claim_patient_event_v3(uuid)') as rpc")).rows[0].rpc).toBeNull();
 });
 it('keeps an old prepared insert that omits the new column safe for cancellation after activation',async()=>{
  const appointment=await seed();
  await control.query("prepare synthetic_old_cancel(uuid) as insert into dental.outbox(appointment_id,appointment_version,type,due_at,expires_at) values($1,2,'cancellation',dental.clock_now(),dental.clock_now()+interval '24 hours')");
  await control.query('set session authorization postgres');await control.query(bridge);await control.query(activation);
  await control.query('reset session authorization');await control.query(`execute synthetic_old_cancel('${appointment}')`);
  expect((await control.query("select payload_version from dental.outbox where appointment_id=$1 and type='cancellation'",[appointment])).rows).toEqual([{payload_version:2}]);
 });
 it('rejects invalid type/version combinations and keeps the patient default absent',async()=>{
  const appointment=await seed();await control.query('set session authorization postgres');await control.query(bridge);await control.query(activation);
  await control.query('reset session authorization');
  for(const [type,version] of [['approval',2],['rejection',3],['reminder',3],['cancellation',3]]){
   await expect(control.query("insert into dental.outbox(appointment_id,appointment_version,type,payload_version,due_at,expires_at) values($1,9,$2,$3,dental.clock_now(),dental.clock_now()+interval '24 hours')",[appointment,type,version])).rejects.toThrow(/outbox_payload_version_type/);
  }
  expect((await control.query("select column_default from information_schema.columns where table_schema='dental' and table_name='outbox' and column_name='payload_version'")).rows[0].column_default).toBeNull();
 });
});
