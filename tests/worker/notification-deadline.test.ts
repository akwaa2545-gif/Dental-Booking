// @vitest-environment node
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createLineTransport} from '../../src/worker/notifications/line';
import {dispatchDue} from '../../src/worker/notifications/outbox';

const id='11111111-1111-4111-8111-111111111111';
const recipient='U'+'b'.repeat(32);
const base=Date.parse('2026-10-11T11:00:00Z');
const event={id,appointmentId:id,appointmentVersion:2,type:'reminder' as const,retryKey:id,dueAt:'2026-10-11T11:00:00Z',expiresAt:'2026-10-11T17:00:00Z'};
const prepared={event,recipient,date:'2026-10-12',reference:'D-test',status:'approved' as const,manageUrl:'https://clinic.example/appointments',payloadVersion:1 as const,authorizationExpiresAt:'2026-10-11T11:10:00Z',preparedAt:'2026-10-11T11:00:00Z'};
afterEach(()=>vi.useRealTimers());

describe('authorization deadline at the provider boundary',()=>{
 it('never calls fetch for an expired authorization deadline',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(null,{status:200}));
  const clock={wall:()=>base+600000,monotonic:()=>100};
  const transport=createLineTransport({enabled:true,token:'synthetic',fetcher,clock});
  expect(await transport.send(recipient,{},id,{deadline:base+600000,monotonicDeadline:1000,refresh:async()=>base})).toEqual({kind:'permanent',category:'forbidden'});
  expect(fetcher).not.toHaveBeenCalled();
 });
 it.each([NaN,Infinity,-1])('fails closed for invalid timing %s',async deadline=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(null,{status:200}));
  expect(await createLineTransport({enabled:true,token:'synthetic',fetcher}).send(recipient,{},id,{deadline,monotonicDeadline:1000,refresh:async()=>base})).toEqual({kind:'permanent',category:'forbidden'});
  expect(fetcher).not.toHaveBeenCalled();
 });
 it('checks after serialization so payload work cannot cross the cutoff',async()=>{
  let wall=base,mono=0;const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(null,{status:200}));
  const payload={messages:{toJSON(){wall=base+600000;mono=600000;return [];}}};
  const transport=createLineTransport({enabled:true,token:'synthetic',fetcher,clock:{wall:()=>wall,monotonic:()=>mono}});
  expect(await transport.send(recipient,payload,id,{deadline:base+600000,monotonicDeadline:600000,refresh:async()=>base})).toEqual({kind:'permanent',category:'forbidden'});
  expect(fetcher).not.toHaveBeenCalled();
 });
 it('refreshes trusted database time even when both Worker clocks stay frozen',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(null,{status:200}));
  const refresh=vi.fn(async()=>base+2000);
  const transport=createLineTransport({enabled:true,token:'synthetic',fetcher,clock:{wall:()=>base,monotonic:()=>0}});
  const result=await transport.send(recipient,{},id,{deadline:base+2000,monotonicDeadline:2000,refresh});
  expect(result).toEqual({kind:'permanent',category:'forbidden'});expect(refresh).toHaveBeenCalledOnce();expect(fetcher).not.toHaveBeenCalled();
 });
 it.each([NaN,Infinity,-1,base-2000,base+2000])('rejects malformed or disagreeing final database time %s',async fresh=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(null,{status:200}));
  const transport=createLineTransport({enabled:true,token:'synthetic',fetcher,clock:{wall:()=>base,monotonic:()=>0}});
  expect(await transport.send(recipient,{},id,{deadline:base+600000,monotonicDeadline:600000,refresh:async()=>fresh})).toEqual({kind:'permanent',category:'forbidden'});
  expect(fetcher).not.toHaveBeenCalled();
 });
 it('does not send or retry when the final database read fails',async()=>{
  const fetcher=vi.fn<typeof fetch>();const refresh=vi.fn(async()=>{throw Error('database unavailable');});
  const transport=createLineTransport({enabled:true,token:'synthetic',fetcher,clock:{wall:()=>base,monotonic:()=>0}});
  expect(await transport.send(recipient,{},id,{deadline:base+600000,monotonicDeadline:600000,refresh})).toEqual({kind:'permanent',category:'forbidden'});
  expect(fetcher).not.toHaveBeenCalled();expect(refresh).toHaveBeenCalledOnce();
 });
 it('bounds a nonsettling final database read without starting a push',async()=>{
  vi.useFakeTimers();const fetcher=vi.fn<typeof fetch>();const refresh=vi.fn(()=>new Promise<number>(()=>{}));
  const transport=createLineTransport({enabled:true,token:'synthetic',fetcher,clock:{wall:()=>base,monotonic:()=>0}});
  let settled=false;const promise=transport.send(recipient,{},id,{deadline:base+600000,monotonicDeadline:600000,refresh});void promise.then(()=>{settled=true;});
  await vi.advanceTimersByTimeAsync(5000);expect(settled).toBe(true);expect(await promise).toEqual({kind:'permanent',category:'forbidden'});
  expect(fetcher).not.toHaveBeenCalled();expect(refresh).toHaveBeenCalledOnce();
 });
 it('keeps the monotonic deadline when the wall clock moves backwards',async()=>{
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(null,{status:200}));
  const transport=createLineTransport({enabled:true,token:'synthetic',fetcher,clock:{wall:()=>base-30000,monotonic:()=>600000}});
  expect(await transport.send(recipient,{},id,{deadline:base+600000,monotonicDeadline:600000,refresh:async()=>base})).toEqual({kind:'permanent',category:'forbidden'});
  expect(fetcher).not.toHaveBeenCalled();
 });
 it('aborts and returns by the smaller remaining window even if provider ignores abort',async()=>{
  vi.useFakeTimers();let signal:AbortSignal|undefined;const fetcher:typeof fetch=async(_url,init)=>{signal=init?.signal??undefined;return new Promise(()=>{});};
  const transport=createLineTransport({enabled:true,token:'synthetic',fetcher,clock:{wall:()=>base,monotonic:()=>0}});
  let settled=false;const result=transport.send(recipient,{},id,{deadline:base+2000,monotonicDeadline:2000,refresh:async()=>base});void result.then(()=>{settled=true;});
  await vi.advanceTimersByTimeAsync(1999);expect(settled).toBe(false);expect(signal?.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);expect(settled).toBe(true);expect(signal?.aborted).toBe(true);
  expect(await result).toEqual({kind:'retryable',category:'timeout'});
 });
});

describe('trusted restricted RPC timing',()=>{
 function setup(patch:Record<string,unknown>={}){
  const fetcher=vi.fn<typeof fetch>().mockResolvedValue(new Response(null,{status:200}));
  const clock={wall:()=>base,monotonic:()=>100};
  const db={claimEvents:vi.fn(async()=>[event]),prepareDispatch:vi.fn(async()=>({...prepared,...patch})),finishDispatch:vi.fn(async()=>{})};
  return {fetcher,clock,db,transport:createLineTransport({enabled:true,token:'synthetic',fetcher,clock}),workerId:id,manageOrigin:'https://clinic.example',requireAuthorizationWindow:true,refreshClock:async()=>base};
 }
 it.each([{authorizationExpiresAt:undefined},{preparedAt:undefined},{authorizationExpiresAt:'garbage'},{preparedAt:'garbage'},{authorizationExpiresAt:'2026-10-11T10:59:59Z'}])('rejects missing, invalid or DB-expired authorization timing %j',async patch=>{
  const s=setup(patch);expect(await dispatchDue(s)).toEqual({accepted:0,suppressed:0,failed:1});expect(s.fetcher).not.toHaveBeenCalled();
  expect(s.db.finishDispatch).toHaveBeenCalledWith(id,id,{kind:'permanent',category:'invalid_request'});
 });
 it.each([-2000,2000])('rejects DB/worker timing disagreement of %i ms',async offset=>{
  const s=setup({preparedAt:new Date(base+offset).toISOString()});await dispatchDue(s);expect(s.fetcher).not.toHaveBeenCalled();
 });
 it('rejects a DB-expired window even when worker clock still appears valid',async()=>{
  const s=setup({authorizationExpiresAt:new Date(base+500).toISOString(),preparedAt:new Date(base+500).toISOString()});await dispatchDue(s);expect(s.fetcher).not.toHaveBeenCalled();
 });
 it('deducts elapsed RPC time from the DB budget before the final send',async()=>{
  const s=setup({authorizationExpiresAt:new Date(base+2000).toISOString()});let mono=100;let wall=base;s.clock.wall=()=>wall;s.clock.monotonic=()=>mono;
  s.db.prepareDispatch.mockImplementation(async()=>{wall+=2000;mono+=2000;return {...prepared,authorizationExpiresAt:new Date(base+2000).toISOString()};});
  await dispatchDue(s);expect(s.fetcher).not.toHaveBeenCalled();
 });
 it('allows a valid window and keeps authorization metadata out of LINE payload',async()=>{
  const s=setup();expect(await dispatchDue(s)).toEqual({accepted:1,suppressed:0,failed:0});
  const body=String(s.fetcher.mock.calls[0][1]?.body);expect(body).not.toContain('authorizationExpiresAt');expect(body).not.toContain('preparedAt');expect(body).toContain('D-test');
 });
});
