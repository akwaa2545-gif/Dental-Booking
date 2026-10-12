import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { Appointment } from '../../src/shared/contracts';
import { createDatabase } from '../../src/worker/db';
import { fixture as httpFixture, origin, session as syntheticSession } from '../support/mock-line';
import { booking, ReservationFixture } from '../support/reservation-postgres';

let fixture:ReservationFixture;
let owner:string,admin:string,outsider:string,approved:Appointment;
let http:ReturnType<typeof httpFixture>;
const actors:string[]=[];
const csrf=syntheticSession.csrfToken;
const cookie='__Host-dental_session='+'o'.repeat(43);
function request(path:string,body?:unknown,headers:Record<string,string>={}){
 return new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,Origin:origin,'X-CSRF-Token':csrf,'Content-Type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
}
function actAs(actor:string){vi.mocked(http.deps.sessions.resolve).mockResolvedValue({...syntheticSession,accountId:actor,isAdmin:true});}
function cancel(body:unknown={version:approved.version,decision:'cancel',reason:'Synthetic clinic closure'}){
 return http.app.fetch(request(`/api/admin/appointments/${approved.id}/decision`,body));
}
beforeAll(async()=>{fixture=await ReservationFixture.create();});
beforeEach(async()=>{
 owner=await fixture.account();admin=await fixture.account();outsider=await fixture.account();actors.push(owner,admin,outsider);
 await fixture.control.query('insert into dental.admin_grants(account_id) values($1)',[admin]);
 const patient=await fixture.patient(owner);await fixture.date('2026-10-09');
 const pending=await fixture.reserve(owner,randomUUID(),booking(patient));
 approved=await fixture.call<Appointment>('select dental.decide($1,$2,$3,$4,$5) as result',[admin,pending.id,1,'approve','Synthetic approval']);
 http=httpFixture();
 http.deps.db=createDatabase({async query(sql,values){return{rows:[{result:await fixture.call(sql,values)}]};}});
 actAs(admin);
});
afterEach(async()=>{
 await fixture.control.query('delete from dental.notification_attempts where outbox_id in(select o.id from dental.outbox o join dental.appointments a on a.id=o.appointment_id where a.owner_account_id=any($1::uuid[]))',[actors]);
 await fixture.control.query('delete from dental.outbox where appointment_id in(select id from dental.appointments where owner_account_id=any($1::uuid[]))',[actors]);
 await fixture.control.query('delete from dental.admin_grants where account_id=any($1::uuid[])',[actors]);
 await fixture.reset();actors.length=0;
});
afterAll(async()=>{await fixture?.close();});

it('HTTP decision persists cancellation, exposes owner status and refuses cross-owner access',async()=>{
 const response=await cancel();expect(response.status).toBe(200);expect(await response.json()).toMatchObject({id:approved.id,status:'cancelled',version:3});
 actAs(owner);
 const visible=await http.app.fetch(request(`/api/appointments/${approved.id}`));expect(visible.status).toBe(200);expect(await visible.json()).toMatchObject({status:'cancelled',version:3});
 actAs(outsider);
 const foreign=await http.app.fetch(request(`/api/appointments/${approved.id}`));expect(foreign.status).toBe(404);expect(await foreign.json()).toMatchObject({error:{code:'NOT_FOUND'}});
 const events=(await fixture.control.query('select type,state,appointment_version from dental.outbox where appointment_id=$1 order by type',[approved.id])).rows;
 expect(events).toEqual([{type:'approval',state:'suppressed',appointment_version:2},{type:'cancellation',state:'queued',appointment_version:3},{type:'reminder',state:'suppressed',appointment_version:2}]);
});
it('HTTP simultaneous duplicate admin decisions produce one event and one version conflict',async()=>{
 const results=await Promise.all([cancel(),cancel()]);expect(results.map(r=>r.status).sort()).toEqual([200,409]);
 expect(await results.find(r=>r.status===409)!.json()).toMatchObject({error:{code:'VERSION_CONFLICT'}});
 expect((await fixture.control.query("select count(*)::integer as n from dental.outbox where appointment_id=$1 and type='cancellation'",[approved.id])).rows[0].n).toBe(1);
});
it('HTTP rejects cached revoked admin, blank reason, forged actor and CSRF bypass',async()=>{
 expect((await cancel({version:2,decision:'cancel',reason:' '})).status).toBe(400);
 expect((await cancel({version:2,decision:'cancel',reason:'Closure',accountId:admin})).status).toBe(400);
 expect((await http.app.fetch(request(`/api/admin/appointments/${approved.id}/decision`,{version:2,decision:'cancel',reason:'Closure'},{'X-CSRF-Token':'wrong'}))).status).toBe(403);
 await fixture.control.query('update dental.admin_grants set revoked_at=clock_timestamp() where account_id=$1',[admin]);
 expect((await cancel()).status).toBe(403);
 expect(await fixture.call('select dental.get_appointment($1,$2) as result',[owner,approved.id])).toMatchObject({status:'approved',version:2});
});
it('HTTP clinic action works after midnight while patient cutoff remains enforced',async()=>{
 await fixture.setClock('2026-10-09T01:00:00Z');actAs(owner);
 const patient=await http.app.fetch(request(`/api/appointments/${approved.id}/cancel`,{version:2}));expect(patient.status).toBe(409);expect(await patient.json()).toMatchObject({error:{code:'CUTOFF_PASSED'}});
 actAs(admin);expect((await cancel()).status).toBe(200);
});
