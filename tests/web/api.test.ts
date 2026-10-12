import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import * as apiModule from '../../src/web/api';
// This file's synthetic sessions must not expire with the calendar date.
// Only Date is fixed; real async timers and explicit per-test clocks are retained.
beforeEach(()=>{vi.useFakeTimers({toFake:['Date']});vi.setSystemTime('2026-10-08T00:00:00Z');});
afterEach(()=>vi.useRealTimers());
const session={accountId:'10000000-0000-4000-8000-000000000001',csrfToken:'synthetic-csrf',expiresAt:'2026-10-09T00:00:00Z',isAdmin:false};
function response(value:unknown,status=200){return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});}
describe('same-origin browser API with synthetic fetch',()=>{
 it('exports the real network adapter',()=>{expect(typeof apiModule.createBrowserApi).toBe('function');});
 it('identifies server persistence so the UI never promises reload deletes saved data',()=>{expect(apiModule.createBrowserApi({fetch:vi.fn()}).dataMode).toBe('server');});
 it('adds session csrf, JSON content type and safe fetch controls to mutations',async()=>{const fetcher=vi.fn().mockResolvedValueOnce(response(session)).mockResolvedValueOnce(response({id:'synthetic'}));const api=apiModule.createBrowserApi({fetch:fetcher});expect(await api.request('/api/patients',{method:'POST',body:'{}',headers:{'Idempotency-Key':'key','X-CSRF-Token':'forged'}})).toEqual({id:'synthetic'});expect(fetcher).toHaveBeenCalledTimes(2);expect(fetcher.mock.calls[0][0]).toBe('/api/session');const [path,init]=fetcher.mock.calls[1];expect(path).toBe('/api/patients');expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('synthetic-csrf');expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');expect(new Headers(init.headers).get('Idempotency-Key')).toBe('key');expect(init).toMatchObject({credentials:'same-origin',cache:'no-store',redirect:'error',referrerPolicy:'no-referrer'});});
 it('uses the inclusive Bangkok range when availability has no query',async()=>{const fetcher=vi.fn().mockResolvedValue(response([]));const api=apiModule.createBrowserApi({fetch:fetcher,now:()=>new Date('2026-10-07T17:00:00Z')});await api.request('/api/availability');expect(fetcher.mock.calls[0][0]).toBe('/api/availability?from=2026-10-09&to=2027-01-06');});
 it('preserves explicit availability query and never fetches a session for reads',async()=>{const fetcher=vi.fn().mockResolvedValue(response([]));await apiModule.createBrowserApi({fetch:fetcher}).request('/api/availability?from=2026-10-09&to=2026-10-10');expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0][0]).toBe('/api/availability?from=2026-10-09&to=2026-10-10');});
 it.each(['https://evil.example/api/patients','//evil.example/api/patients','/api/../outside','/api/patients#secret','/api/\\evil','/api/%2e%2e/outside'])('refuses non-api or ambiguous request path %s before transmission',async(path)=>{const fetcher=vi.fn();await expect(apiModule.createBrowserApi({fetch:fetcher}).request(path,{method:'POST',body:'private'})).rejects.toMatchObject({code:'VALIDATION'});expect(fetcher).not.toHaveBeenCalled();});
 it('does not send a mutation when session preflight fails',async()=>{const fetcher=vi.fn().mockResolvedValue(response({error:{code:'UNAUTHENTICATED'}},401));await expect(apiModule.createBrowserApi({fetch:fetcher}).request('/api/appointments',{method:'POST',body:'{}'})).rejects.toMatchObject({code:'UNAUTHENTICATED',status:401});expect(fetcher).toHaveBeenCalledTimes(1);});
 it('never replays an uncertain write, even on auth failure',async()=>{const fetcher=vi.fn().mockResolvedValueOnce(response(session)).mockResolvedValueOnce(response({error:{code:'UNAUTHENTICATED'}},401));await expect(apiModule.createBrowserApi({fetch:fetcher}).request('/api/appointments',{method:'POST',body:'{}'})).rejects.toMatchObject({code:'UNAUTHENTICATED'});expect(fetcher).toHaveBeenCalledTimes(2);});
 it('redacts malformed errors and transport exceptions into uncertainty',async()=>{for(const outcome of [()=>Promise.resolve(response({error:{code:'PRIVATE_CANARY'}},500)),()=>Promise.reject(new Error('PRIVATE_CANARY')),()=>Promise.resolve(new Response('<html>private</html>',{status:502}))]){const api=apiModule.createBrowserApi({fetch:vi.fn().mockResolvedValueOnce(response(session)).mockImplementation(outcome)});await expect(api.request('/api/appointments')).rejects.toMatchObject({code:'UNAVAILABLE',message:'UNAVAILABLE'});}});
 it('requires a well-formed csrf value before writing',async()=>{const fetcher=vi.fn().mockResolvedValue(response({...session,csrfToken:null}));await expect(apiModule.createBrowserApi({fetch:fetcher}).request('/api/patients',{method:'POST',body:'{}'})).rejects.toMatchObject({code:'UNAVAILABLE'});expect(fetcher).toHaveBeenCalledTimes(1);});
 it('does not allow fetch options to override safe controls',async()=>{const fetcher=vi.fn().mockResolvedValueOnce(response(session)).mockResolvedValue(response([]));await apiModule.createBrowserApi({fetch:fetcher}).request('/api/patients',{credentials:'include',redirect:'follow',cache:'force-cache'});expect(fetcher.mock.calls[0][1]).toMatchObject({credentials:'same-origin',cache:'no-store',redirect:'error'});});
 it('binds lookup and retry to the original verified account after reauthentication',async()=>{const fetcher=vi.fn().mockResolvedValueOnce(response(session)).mockResolvedValueOnce(response({error:{code:'UNAVAILABLE'}},503)).mockResolvedValueOnce(response({...session,accountId:'10000000-0000-4000-8000-000000000002'}));const api=apiModule.createBrowserApi({fetch:fetcher});await expect(api.request('/api/appointments',{method:'POST',body:'{}'})).rejects.toMatchObject({code:'UNAVAILABLE'});await expect(api.request('/api/submissions/original-key')).rejects.toMatchObject({code:'UNAUTHENTICATED'});expect(fetcher).toHaveBeenCalledTimes(3);expect(fetcher.mock.calls[2][0]).toBe('/api/session');});
 it('allows explicit lookup after same-account reauthentication with fresh csrf',async()=>{const fetcher=vi.fn().mockResolvedValueOnce(response(session)).mockResolvedValueOnce(response({error:{code:'UNAVAILABLE'}},503)).mockResolvedValueOnce(response({...session,csrfToken:'rotated'})).mockResolvedValueOnce(response(null));const api=apiModule.createBrowserApi({fetch:fetcher});await expect(api.request('/api/appointments',{method:'POST',body:'{}'})).rejects.toMatchObject({code:'UNAVAILABLE'});expect(await api.request('/api/submissions/original-key')).toBeNull();expect(fetcher).toHaveBeenCalledTimes(4);});
 it('does not treat an availability mutation as a public read',async()=>{const fetcher=vi.fn().mockResolvedValueOnce(response(session)).mockResolvedValueOnce(response({error:{code:'NOT_FOUND'}},404));await expect(apiModule.createBrowserApi({fetch:fetcher}).request('/api/availability',{method:'POST',body:'{}'})).rejects.toMatchObject({code:'NOT_FOUND'});expect(fetcher.mock.calls[0][0]).toBe('/api/session');expect(new Headers(fetcher.mock.calls[1][1].headers).get('X-CSRF-Token')).toBe('synthetic-csrf');});
 it('handles an empty successful response',async()=>{const fetcher=vi.fn().mockResolvedValueOnce(response(session)).mockResolvedValueOnce(new Response(null,{status:204}));expect(await apiModule.createBrowserApi({fetch:fetcher}).request('/api/logout',{method:'POST',body:'{}'})).toBeUndefined();});
});

describe('verified session lifecycle boundary', () => {
 it('binds the first request to the bootstrap account before transmitting private data', async () => {
  const onSessionInvalid = vi.fn(); const fetcher = vi.fn().mockResolvedValue(response({...session,accountId:'10000000-0000-4000-8000-000000000002'}));
  const api = apiModule.createBrowserApi({fetch:fetcher,accountId:session.accountId,onSessionInvalid});
  await expect(api.request('/api/patients',{method:'POST',body:'private'})).rejects.toMatchObject({code:'UNAUTHENTICATED'});
  expect(onSessionInvalid).toHaveBeenCalledWith(expect.objectContaining({code:'UNAUTHENTICATED'})); expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('reports denied resource responses so the shell can discard private screens', async () => {
  const onSessionInvalid = vi.fn(); const fetcher = vi.fn().mockResolvedValueOnce(response(session)).mockResolvedValueOnce(response({error:{code:'FORBIDDEN'}},403));
  await expect(apiModule.createBrowserApi({fetch:fetcher,onSessionInvalid}).request('/api/admin/appointments')).rejects.toMatchObject({code:'FORBIDDEN'});
  expect(onSessionInvalid).toHaveBeenCalledOnce();
 });
 it('fails closed when session refresh is unavailable, without sending the private request', async () => {
  const onSessionInvalid=vi.fn(); const fetcher=vi.fn().mockRejectedValue(new Error('offline'));
  await expect(apiModule.createBrowserApi({fetch:fetcher,onSessionInvalid}).request('/api/patients')).rejects.toMatchObject({code:'UNAVAILABLE'});
  expect(onSessionInvalid).toHaveBeenCalledOnce(); expect(fetcher).toHaveBeenCalledOnce();
 });
 it('reports fresh server roles and rejects invalid expiry before exposing private data', async () => {
  const onSession=vi.fn(); const fetcher=vi.fn().mockImplementation(async()=>response(session));
  const api=apiModule.createBrowserApi({fetch:fetcher,now:()=>new Date('2026-10-08T00:00:00Z'),onSession});
  await api.request('/api/session'); expect(onSession).toHaveBeenCalledWith(session);
  await expect(apiModule.createBrowserApi({fetch:fetcher,now:()=>new Date('2026-10-10T00:00:00Z')}).request('/api/patients')).rejects.toMatchObject({code:'UNAVAILABLE'});
 });
 it('disposal blocks further transmission and discards a pending private response', async () => {
  let finish!: (value:Response)=>void; const pending=new Promise<Response>(resolve=>{finish=resolve;});
  const fetcher=vi.fn().mockResolvedValueOnce(response(session)).mockReturnValueOnce(pending);
  const api=apiModule.createBrowserApi({fetch:fetcher}); const request=api.request('/api/patients');
  await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(2)); api.dispose(); finish(response([{fullName:'private'}]));
  await expect(request).rejects.toMatchObject({code:'UNAUTHENTICATED'});
  await expect(api.request('/api/patients',{method:'POST',body:'private'})).rejects.toMatchObject({code:'UNAUTHENTICATED'}); expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('disposal during session preflight prevents an in-flight mutation from being dispatched', async () => {
  let finish!: (value:Response)=>void; const fetcher=vi.fn().mockImplementation(()=>new Promise<Response>(resolve=>{finish=resolve;}));
  const api=apiModule.createBrowserApi({fetch:fetcher}); const pending=api.request('/api/patients',{method:'POST',body:'private'});
  api.dispose(); finish(response(session)); await expect(pending).rejects.toMatchObject({code:'UNAUTHENTICATED'}); expect(fetcher).toHaveBeenCalledOnce();
 });
});

describe('retired API generations', () => {
 it.each(['preflight', 'resource'])('does not invalidate a newer session when an old %s request settles after disposal', async stage => {
  let finish!: (value: Response) => void; const pending = new Promise<Response>(resolve => { finish = resolve; });
  const onSessionInvalid = vi.fn(); const fetcher = stage === 'preflight' ? vi.fn().mockReturnValue(pending) : vi.fn().mockResolvedValueOnce(response(session)).mockReturnValueOnce(pending);
  const api = apiModule.createBrowserApi({ fetch: fetcher, onSessionInvalid }); const result = api.request('/api/patients');
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(stage === 'preflight' ? 1 : 2)); api.dispose(); finish(response({ error: { code: 'UNAUTHENTICATED' } }, 401));
  await expect(result).rejects.toMatchObject({ code: 'UNAUTHENTICATED' }); expect(onSessionInvalid).not.toHaveBeenCalled();
 });
});

describe('safe fresh-session error context', () => {
 it.each(['transport', 'http', 'json', 'session'])('keeps %s fresh-session failure separate from the requested resource', async stage => {
  const fetcher=vi.fn(async()=>{
   if(stage==='transport') throw new Error('PRIVATE_CANARY');
   if(stage==='http') return response({error:{code:'UNAVAILABLE',diagnostic:'A10'}},503);
   if(stage==='json') return new Response('PRIVATE_CANARY',{status:502});
   return response({...session,csrfToken:null});
  });
  const onSessionInvalid=vi.fn(); const api=apiModule.createBrowserApi({fetch:fetcher,onSessionInvalid,now:()=>new Date('2026-10-08T00:00:00Z')});
  const failure=await api.request('/api/patients').catch((error:unknown)=>error);
  expect(failure).toMatchObject({phase:'session-refresh',code:'UNAVAILABLE'});
  expect(failure).toHaveProperty('responseStatus',stage==='transport'?undefined:stage==='http'?503:stage==='json'?502:200);
  expect(JSON.stringify(failure)).not.toMatch(/PRIVATE_CANARY|A10/); expect(fetcher).toHaveBeenCalledOnce(); expect(onSessionInvalid).toHaveBeenCalledWith(failure);
 });
 it('lets the foreground boundary own its refresh failure without an earlier invalidation callback', async () => {
  const fetcher=vi.fn().mockResolvedValue(response({error:{code:'UNAVAILABLE'}},503)); const onSessionInvalid=vi.fn();
  const api=apiModule.createBrowserApi({fetch:fetcher,onSessionInvalid});
  await expect(api.refreshSession()).rejects.toMatchObject({phase:'session-refresh',code:'UNAVAILABLE',responseStatus:503});
  expect(onSessionInvalid).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledOnce();
 });
});
