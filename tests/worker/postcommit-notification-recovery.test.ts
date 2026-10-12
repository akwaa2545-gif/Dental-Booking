// @vitest-environment node
import {describe, expect, it, vi} from 'vitest';
import {createRuntime, type RequestClient, type RuntimeEnv} from '../../src/worker/runtime';
import {hashToken} from '../../src/worker/auth/session';
import {ADMIN_MANAGE_ORIGIN as origin} from '../../src/worker/admin-notifications/payload';
import type {QueryPort} from '../../src/worker/db';

const actor='11111111-1111-4111-8111-111111111111';
const id='22222222-2222-4222-8222-222222222222';
const key='33333333-3333-4333-8333-333333333333';
const token='o'.repeat(43);
const settings:RuntimeEnv={APP_MODE:'production',APP_STAGE:'synthetic-staging',AUTH_MODE:'line',MESSAGING_MODE:'disabled',APP_ORIGIN:origin,LINE_CHANNEL_ID:'123456',LINE_PROVIDER_ID:'synthetic',DENTAL_DB:{connectionString:'postgres://synthetic'},RATE_LIMIT_KEY_SECRET:'synthetic-rate-limit-key-with-at-least-32-bytes',COMBINED_NOTIFICATIONS_ENABLED:'true',LINE_MESSAGING_ACCESS_TOKEN:'synthetic-only',LINE_MESSAGING_BASIC_ID:'@clinic',LINE_MESSAGING_DESTINATION:'U'+'a'.repeat(32)};
type Context={waitUntil(promise:Promise<unknown>):void};
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
async function setup(){
 const csrf=await hashToken('dental:csrf:v1:'+token),csrfHash=await hashToken(csrf);
 const order:string[]=[];
 const result={id,status:'approved',version:2};
 const requestQuery=vi.fn<QueryPort['query']>(async sql=>{
  order.push(sql);
  if(sql.includes('resolve_session'))return{rows:[{result:{accountId:actor,csrfHash,expiresAt:'2099-01-01T00:00:00Z',isAdmin:true}}]};
  if(sql.includes('consume_request_limit')||sql.includes('is_admin'))return{rows:[{result:true}]};
  if(sql.includes('reserve(')||sql.includes('decide(')||sql.includes('cancel('))return{rows:[{result}]};
  if(sql.includes('list_appointments'))return{rows:[{result:[]}]};
  throw Error('Unexpected request SQL');
 });
 const backgroundQuery=vi.fn<QueryPort['query']>(async sql=>{order.push(sql);return{rows:[{result:null}]};});
 const client=(query:QueryPort['query'])=>({on:vi.fn(),connect:vi.fn(async()=>{}),end:vi.fn(async()=>{}),query});
 const foreground=client(requestQuery),background=client(backgroundQuery);
 const clientFactory=vi.fn<()=>RequestClient>().mockReturnValueOnce(foreground).mockReturnValue(background);
 const fetcher=vi.fn<typeof fetch>(async()=>{throw Error('Unexpected provider call');});
 const runtime=createRuntime({assets:{},clientFactory,fetch:fetcher});
 const tasks:Promise<unknown>[]=[];
 const context={waitUntil:vi.fn((task:Promise<unknown>)=>{order.push('waitUntil');tasks.push(task);})};
 // The recovered deployed interface accepts the optional Worker execution context.
 const run=(request:Request,env:RuntimeEnv=settings,ctx:Context|undefined=context)=>(runtime.fetch as (request:Request,env:RuntimeEnv,ctx?:Context)=>Promise<Response>)(request,env,ctx);
 const post=(path:string,body:unknown)=>new Request(origin+path,{method:'POST',headers:{Origin:origin,Cookie:'__Host-dental_session='+token,'X-CSRF-Token':csrf,'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify(body)});
 const booking=()=>post('/api/appointments',{patientId:id,patientVersion:1,service:'oral_check',date:'2026-10-20',ageConfirmed:42,authorizationAcknowledged:true});
 const decision=(action='approve')=>post(`/api/admin/appointments/${id}/decision`,{version:1,decision:action,reason:'Synthetic reason'});
 return{runtime,run,booking,decision,post,tasks,context,order,result,foreground,background,requestQuery,backgroundQuery,clientFactory,fetcher};
}

describe('recovered post-commit notification fast path',()=>{
 it.each(['booking','approval'] as const)('nudges only the %s lane after the committed mutation, with a fresh client and unfiltered FIFO claim',async kind=>{
  const s=await setup();
  const response=await s.run(kind==='booking'?s.booking():s.decision());
  expect(response.status).toBe(200);expect(await response.json()).toEqual(s.result);
  expect(s.context.waitUntil).toHaveBeenCalledOnce();await Promise.all(s.tasks);
  expect(s.clientFactory).toHaveBeenCalledTimes(2);
  const claim=kind==='booking'?'claim_admin_delivery':'claim_patient_event';
  expect(s.backgroundQuery.mock.calls).toHaveLength(1);
  expect(s.backgroundQuery.mock.calls[0][0]).toContain(claim);
  expect(s.backgroundQuery.mock.calls[0][1]).toEqual([expect.stringMatching(/^[0-9a-f-]{36}$/)]);
  expect(s.backgroundQuery.mock.calls[0][1]).not.toContain(id);
  expect(s.order.findIndex(value=>value.includes(kind==='booking'?'reserve(':'decide('))).toBeLessThan(s.order.indexOf('waitUntil'));
  expect(s.foreground.end).toHaveBeenCalledOnce();expect(s.background.end).toHaveBeenCalledOnce();
  expect(s.requestQuery.mock.calls.every(([sql])=>!sql.includes('claim_'))).toBe(true);
  expect(s.fetcher).not.toHaveBeenCalled();
 });
 it('does not wait for background connection or claim before returning a successful booking',async()=>{
  const s=await setup(),blocked=deferred();s.background.connect.mockImplementation(()=>blocked.promise);
  const response=await s.run(s.booking());
  expect(response.status).toBe(200);expect(s.background.connect).toHaveBeenCalledOnce();
  expect(s.foreground.end).toHaveBeenCalledOnce();expect(s.backgroundQuery).not.toHaveBeenCalled();
  blocked.resolve();await Promise.all(s.tasks);expect(s.backgroundQuery).toHaveBeenCalledOnce();
 });
 it.each(['booking','approval'] as const)('does not register background work while %s mutation is pending or after it fails',async kind=>{
  const s=await setup(),blocked=deferred(),started=deferred();const original=s.requestQuery.getMockImplementation()!;
  s.requestQuery.mockImplementation(async(sql,values)=>{if(sql.includes(kind==='booking'?'reserve(':'decide(')){started.resolve();await blocked.promise;throw Error('PRIVATE_SQL');}return original(sql,values);});
  const response=s.run(kind==='booking'?s.booking():s.decision());await started.promise;
  expect(s.context.waitUntil).not.toHaveBeenCalled();blocked.resolve();expect((await response).status).toBe(503);
  expect(s.context.waitUntil).not.toHaveBeenCalled();expect(s.clientFactory).toHaveBeenCalledOnce();
 });
 it.each(['reject','complete','no_show','cancel'])('does not nudge for the unrelated %s decision even if the returned status is approved',async decision=>{
  const s=await setup();expect((await s.run(s.decision(decision))).status).toBe(200);
  expect(s.context.waitUntil).not.toHaveBeenCalled();expect(s.clientFactory).toHaveBeenCalledOnce();
 });
 it('does not nudge approval unless the database returns approved',async()=>{
  const s=await setup();s.result.status='pending';expect((await s.run(s.decision())).status).toBe(200);
  expect(s.context.waitUntil).not.toHaveBeenCalled();
 });
 it('does not nudge a read or patient cancellation',async()=>{
  const s=await setup();expect((await s.run(s.post(`/api/appointments/${id}/cancel`,{version:1}))).status).toBe(200);
  expect(s.context.waitUntil).not.toHaveBeenCalled();
 });
 it.each(['missing','throws'] as const)('keeps a committed response successful and starts no background client when waitUntil %s',async mode=>{
  const s=await setup();const context=mode==='missing'?{}:{waitUntil:()=>{throw Error('PRIVATE_REGISTRATION');}};
  expect((await s.run(s.booking(),settings,context as Context)).status).toBe(200);
  await Promise.resolve();expect(s.clientFactory).toHaveBeenCalledOnce();expect(s.fetcher).not.toHaveBeenCalled();
 });
 it.each(['connect','query','cleanup'] as const)('contains background %s failures without changing the committed response or retrying',async phase=>{
  const s=await setup();if(phase==='connect')s.background.connect.mockRejectedValue(Error('PRIVATE_CONNECTION'));if(phase==='query')s.backgroundQuery.mockRejectedValue(Error('PRIVATE_QUERY'));if(phase==='cleanup')s.background.end.mockRejectedValue(Error('PRIVATE_CLEANUP'));
  const response=await s.run(s.booking());expect(response.status).toBe(200);expect(await response.json()).toEqual(s.result);
  expect(s.tasks).toHaveLength(1);await expect(Promise.all(s.tasks)).resolves.toEqual([undefined]);
  expect(s.clientFactory).toHaveBeenCalledTimes(2);expect(s.background.end).toHaveBeenCalledOnce();
  expect(s.requestQuery.mock.calls.filter(([sql])=>sql.includes('reserve('))).toHaveLength(1);
 });
 it.each([{COMBINED_NOTIFICATIONS_ENABLED:undefined},{COMBINED_NOTIFICATIONS_ENABLED:'false'},{APP_STAGE:'production'},{MESSAGING_MODE:'line'},{NOTIFICATION_DISPATCH_ENABLED:'true'},{ADMIN_BOOKING_NOTIFICATIONS_ENABLED:'true'},{NOTIFICATION_TEST_ENABLED:'true'},{LINE_MANUAL_APPROVAL_ENABLED:'true'},{LINE_MESSAGING_ACCESS_TOKEN:''},{LINE_MESSAGING_BASIC_ID:'bad'},{LINE_MESSAGING_DESTINATION:'bad'}])('retains the sending gate with a successful booking: %j',async change=>{
  const s=await setup();expect((await s.run(s.booking(),{...settings,...change})).status).toBe(200);await Promise.all(s.tasks);
  expect(s.clientFactory).toHaveBeenCalledOnce();expect(s.fetcher).not.toHaveBeenCalled();
 });
 it('keeps cron as the fallback with one claim per lane',async()=>{
  const s=await setup();s.clientFactory.mockReset().mockReturnValue(s.background);
  await s.runtime.scheduled({},settings);
  expect(s.backgroundQuery.mock.calls.map(([sql])=>sql)).toEqual([expect.stringContaining('claim_patient_event'),expect.stringContaining('claim_admin_delivery')]);
  expect(s.context.waitUntil).not.toHaveBeenCalled();expect(s.background.end).toHaveBeenCalledOnce();
 });
});
