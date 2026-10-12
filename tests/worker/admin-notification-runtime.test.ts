// @vitest-environment node
import {describe,expect,it,vi} from 'vitest';
import {createRuntime,type RuntimeEnv} from '../../src/worker/runtime';
import type {QueryPort} from '../../src/worker/db';
import {ADMIN_MANAGE_ORIGIN} from '../../src/worker/admin-notifications/payload';
const settings:RuntimeEnv={APP_MODE:'production',AUTH_MODE:'line',MESSAGING_MODE:'disabled',APP_ORIGIN:ADMIN_MANAGE_ORIGIN,LINE_CHANNEL_ID:'123456',LINE_PROVIDER_ID:'synthetic',DENTAL_DB:{connectionString:'postgres://synthetic'},ADMIN_BOOKING_NOTIFICATIONS_ENABLED:'true',LINE_MESSAGING_ACCESS_TOKEN:'synthetic',LINE_MESSAGING_BASIC_ID:'@clinic',LINE_MESSAGING_DESTINATION:'U'+'a'.repeat(32)};
function setup(){
 const client={on:vi.fn(),connect:vi.fn(),end:vi.fn(),query:vi.fn<QueryPort['query']>(async()=>({rows:[{result:null}]}))};
 const clientFactory=vi.fn(()=>client),fetcher=vi.fn<typeof fetch>();
 return{client,clientFactory,fetcher,runtime:createRuntime({assets:{},clientFactory,fetch:fetcher})};
}
describe('unsupported legacy admin scheduled composition',()=>{
 it('an old admin flag cannot partially activate the combined candidate',async()=>{
  const s=setup();await s.runtime.scheduled({},settings);
  expect(s.clientFactory).not.toHaveBeenCalled();expect(s.client.query).not.toHaveBeenCalled();expect(s.fetcher).not.toHaveBeenCalled();
 });
 it.each([{ADMIN_BOOKING_NOTIFICATIONS_ENABLED:undefined},{ADMIN_BOOKING_NOTIFICATIONS_ENABLED:'false'},{MESSAGING_MODE:'line',NOTIFICATION_DISPATCH_ENABLED:'true'},{NOTIFICATION_DISPATCH_ENABLED:'true'},{LINE_MANUAL_APPROVAL_ENABLED:'true'},{APP_ORIGIN:'https://other.example'},{LINE_MESSAGING_ACCESS_TOKEN:''},{LINE_MESSAGING_BASIC_ID:undefined},{LINE_MESSAGING_DESTINATION:'bad'}])('disabled or conflicting admin settings fail closed before opening PostgreSQL: %j',async change=>{
  const s=setup();await s.runtime.scheduled({},{...settings,...change});expect(s.clientFactory).not.toHaveBeenCalled();expect(s.fetcher).not.toHaveBeenCalled();
 });
 it('a complete restricted configuration cannot select a revoked legacy RPC',async()=>{
  const s=setup();await s.runtime.scheduled({},{...settings,APP_STAGE:'synthetic-staging',NOTIFICATION_TEST_ENABLED:'true',NOTIFICATION_TEST_EVENT_ID:'11111111-1111-4111-8111-111111111111',NOTIFICATION_TEST_OWNER_ID:'22222222-2222-4222-8222-222222222222',NOTIFICATION_TEST_FREE_MESSAGE_LIMIT:'200'});
  expect(s.clientFactory).not.toHaveBeenCalled();expect(s.fetcher).not.toHaveBeenCalled();
 });
 it('an invalid restricted configuration cannot fall through to admin dispatch',async()=>{
  const s=setup();await s.runtime.scheduled({},{...settings,NOTIFICATION_TEST_ENABLED:'true'});expect(s.clientFactory).not.toHaveBeenCalled();expect(s.fetcher).not.toHaveBeenCalled();
 });
});

it('manual HTTP approval fails closed under the enabled admin flag',async()=>{
 const {hashToken}=await import('../../src/worker/auth/session');const s=setup();const csrf=await hashToken('dental:csrf:v1:'+'o'.repeat(43)),csrfHash=await hashToken(csrf);
 s.client.query.mockImplementation(async sql=>({rows:[{result:sql.includes('resolve_session')?{accountId:'f0000000-0000-4000-8000-000000000001',csrfHash,expiresAt:'2099-01-01T00:00:00Z',isAdmin:true}:true}]}));
 s.fetcher.mockImplementation(async url=>Response.json(String(url).endsWith('/info')?{userId:settings.LINE_MESSAGING_DESTINATION,basicId:'@clinic'}:String(url).endsWith('/consumption')?{totalUsage:0}:{type:'limited',value:200}));
 const response=await s.runtime.fetch(new Request(ADMIN_MANAGE_ORIGIN+'/api/admin/line/test-approval',{method:'POST',headers:{Origin:ADMIN_MANAGE_ORIGIN,'Content-Type':'application/json',Cookie:'__Host-dental_session='+'o'.repeat(43),'X-CSRF-Token':csrf},body:'{}'}),{...settings,APP_STAGE:'synthetic-staging',LINE_MANUAL_APPROVAL_ENABLED:'true',RATE_LIMIT_KEY_SECRET:'synthetic-rate-limit-key-with-at-least-32-bytes'});
 expect(response.status).toBe(503);expect(s.fetcher).not.toHaveBeenCalled();expect(s.client.query.mock.calls.some(([sql])=>sql.includes('dental.claim_events(')||sql.includes('claim_admin_delivery'))).toBe(false);
});

it.each(['accepted','revoked','unknown_quota','exhausted_quota','wrong_oa','provider_mismatch','clock_stale','finish_stale'])('combined admin lane verifies OA, rechecks authorization and never selects legacy patient RPCs: %s',async scenario=>{
 const s=setup(),order:string[]=[];const start=Date.now(),id='11111111-1111-4111-8111-111111111111';
 const delivery={id,eventId:id,appointmentId:id,grantId:id,retryKey:id,createdAt:new Date(start-1000).toISOString(),dueAt:new Date(start-1000).toISOString(),expiresAt:new Date(start+86400000).toISOString()};
 const prepared={delivery,provider:scenario==='provider_mismatch'?'line:other':'line:synthetic',recipient:'U'+'b'.repeat(32),reference:'D-synthetic',date:'2026-10-20',manageUrl:ADMIN_MANAGE_ORIGIN+'/admin',payloadVersion:1,preparedAt:new Date(start).toISOString(),authorizationValidUntil:new Date(start+60000).toISOString()};
 s.client.query.mockImplementation(async(sql,values)=>{
  if(sql.includes('claim_patient_event'))return{rows:[{result:null}]};
  if(sql.includes('claim_admin_delivery'))return{rows:[{result:delivery}]};
  if(sql.includes('prepare_admin_dispatch')){const observation=JSON.parse(values[3] as string);if(['unknown_quota','wrong_oa'].includes(scenario))expect(observation).toBeNull();return{rows:[{result:['unknown_quota','exhausted_quota','wrong_oa'].includes(scenario)?{state:'paused_quota'}:prepared}]};}
  if(sql.includes('clock_timestamp')){order.push('clock');return{rows:[{result:Date.now()-(scenario==='clock_stale'?2000:0)}]};}
  if(sql.includes('revalidate_admin_dispatch')){order.push('revalidate');return{rows:[{result:scenario!=='revoked'}]};}
  if(sql.includes('finish_admin_dispatch'))return{rows:[{result:scenario!=='finish_stale'}]};
  throw Error('Unexpected SQL');
 });
 s.fetcher.mockImplementation(async(url,init)=>{
  if(String(url).endsWith('/push')){order.push('push');expect(JSON.parse(String(init?.body)).to).toBe(prepared.recipient);expect(String(init?.body)).not.toMatch(/preparedAt|authorizationValidUntil|grantId|appointmentId|provider/);return new Response(null,{status:200});}
  if(String(url).endsWith('/info'))return Response.json({userId:scenario==='wrong_oa'?'U'+'c'.repeat(32):settings.LINE_MESSAGING_DESTINATION,basicId:'@clinic'});
  if(String(url).endsWith('/consumption'))return Response.json({totalUsage:scenario==='exhausted_quota'?300:0});
  return Response.json(scenario==='unknown_quota'?{type:'unlimited'}:{type:'limited',value:300});
 });
 await s.runtime.scheduled({},{...settings,APP_STAGE:'synthetic-staging',COMBINED_NOTIFICATIONS_ENABLED:'true',ADMIN_BOOKING_NOTIFICATIONS_ENABLED:undefined});
 expect(order).toEqual(['accepted','finish_stale'].includes(scenario)?['clock','revalidate','push']:['revoked','clock_stale'].includes(scenario)?['clock','revalidate']:[]);
 expect(s.client.query.mock.calls.some(([sql])=>sql.includes('dental.claim_events(')||sql.includes('claim_restricted_event'))).toBe(false);
 expect(s.client.query.mock.calls.filter(([sql])=>sql.includes('claim_admin_delivery'))).toHaveLength(1);expect(s.client.end).toHaveBeenCalledOnce();
});
it.each([{LINE_PROVIDER_ID:undefined},{LINE_PROVIDER_ID:'line:other'},{LINE_CHANNEL_ID:'bad'},{AUTH_MODE:'mock'}])('invalid identity settings never open PostgreSQL or reach LINE: %j',async change=>{const s=setup();await expect(s.runtime.scheduled({},{...settings,APP_STAGE:'synthetic-staging',COMBINED_NOTIFICATIONS_ENABLED:'true',ADMIN_BOOKING_NOTIFICATIONS_ENABLED:undefined,...change})).rejects.toThrow('UNAVAILABLE');expect(s.clientFactory).not.toHaveBeenCalled();expect(s.fetcher).not.toHaveBeenCalled();});
it('contains both lane database failures and closes its client without provider replay',async()=>{const s=setup();s.client.query.mockRejectedValue(Error('PRIVATE_PASSWORD'));await s.runtime.scheduled({},{...settings,APP_STAGE:'synthetic-staging',COMBINED_NOTIFICATIONS_ENABLED:'true',ADMIN_BOOKING_NOTIFICATIONS_ENABLED:undefined});expect(s.client.query.mock.calls).toHaveLength(2);expect(s.client.end).toHaveBeenCalledOnce();expect(s.fetcher).not.toHaveBeenCalled();});
