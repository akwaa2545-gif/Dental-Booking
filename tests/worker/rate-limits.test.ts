// @vitest-environment node
import {describe,it,expect,vi} from 'vitest';
import {createRequestLimitStore,enforceRequestLimits,readBoundedBody,safeLog,secureResponse,type RequestLimitStore} from '../../src/worker/security';
import {makeApp} from '../../src/worker/index';
import {createRuntime} from '../../src/worker/runtime';
import {fixture,req,origin,session} from '../support/mock-line';

const secret='synthetic-rate-limit-key-with-at-least-32-bytes';
const ip='203.0.113.24';
const login=()=>req('/api/auth/liff',{idToken:'synthetic'},{'CF-Connecting-IP':ip});
function limits(){return {store:{consume:vi.fn<RequestLimitStore["consume"]>(async()=>true)},keySecret:secret};}

describe('persisted request limit boundary',()=>{
 it('calls the persisted SQL counter for every attempt with only keyed identifiers',async()=>{
  const query=vi.fn(async()=>({rows:[{result:true}]}));
  const deps={store:createRequestLimitStore({query}),keySecret:secret};
  await enforceRequestLimits(login(),null,deps);
  await enforceRequestLimits(login(),null,deps);
  expect(query).toHaveBeenCalledTimes(2);
  expect(query).toHaveBeenCalledWith('select dental.consume_request_limit($1::text, $2::text) as result',['login',expect.stringMatching(/^[a-f0-9]{64}$/)]);
  expect(JSON.stringify(query.mock.calls)).not.toContain(ip);
  expect(query.mock.calls[0]).toEqual(query.mock.calls[1]);
 });
 it('separates keyed IPs, secrets and account-mutation scope without trusting caller identity',async()=>{
  const deps=limits();
  await enforceRequestLimits(login(),null,deps);
  await enforceRequestLimits(req('/api/auth/liff',{}, {'CF-Connecting-IP':'203.0.113.25'}),null,deps);
  await enforceRequestLimits(login(),null,{...deps,keySecret:'another-synthetic-key-with-at-least-32-bytes'});
  await enforceRequestLimits(req('/api/patients',{}, {'X-Account-Id':'forged','X-Forwarded-For':ip}),session,deps);
  expect(new Set(deps.store.consume.mock.calls.map(call=>call[1])).size).toBe(4);
  expect(deps.store.consume).toHaveBeenLastCalledWith('mutation',expect.stringMatching(/^[a-f0-9]{64}$/));
  expect(JSON.stringify(deps.store.consume.mock.calls)).not.toContain(session.accountId);
 });
 it.each([undefined,'','short'])('fails login and mutations closed when the HMAC secret is absent or weak: %s',async keySecret=>{
  const deps={...limits(),keySecret};
  for(const [request,current] of [[login(),null],[req('/api/patients',{}),session]] as const)await expect(enforceRequestLimits(request,current,deps)).rejects.toThrow('UNAVAILABLE');
  expect(deps.store.consume).not.toHaveBeenCalled();
 });
 it.each([undefined,'not-an-ip','203.0.113.24, 203.0.113.25'])('never falls back to spoofable forwarded headers: %s',async address=>{
  const request=login();request.headers.delete('CF-Connecting-IP');if(address!==undefined)request.headers.set('CF-Connecting-IP',address);
  request.headers.set('X-Forwarded-For',ip);
  await expect(enforceRequestLimits(request,null,limits())).rejects.toThrow('UNAVAILABLE');
 });
 it('normalizes equivalent IPv6 addresses to the same bucket',async()=>{
  const deps=limits();for(const address of ['2001:db8::1','2001:0db8:0:0:0:0:0:1']){const r=login();r.headers.set('CF-Connecting-IP',address);await enforceRequestLimits(r,null,deps);}
  expect(deps.store.consume.mock.calls[0]).toEqual(deps.store.consume.mock.calls[1]);
 });
 it('shares persisted results across new application instances and blocks before LINE verification',async()=>{
  let count=0;const store={consume:vi.fn(async()=>++count<=10)};
  for(let index=0;index<11;index++){
   const {deps}=fixture();deps.requestLimits={store,keySecret:secret};
   const response=await makeApp(deps).fetch(login());
   expect(response.status).toBe(index<10?200:429);
   if(index===10){expect(deps.verifier.verify).not.toHaveBeenCalled();expect(response.headers.get('Cache-Control')).toBe('no-store');}
  }
  expect(store.consume).toHaveBeenCalledTimes(11);
 });
 it.each(['/api/auth/line/start','/api/auth/line/callback?state=synthetic&code=synthetic'])('counts OAuth endpoint %s before provider or state work',async path=>{
  const {deps}=fixture();deps.requestLimits={store:{consume:vi.fn(async()=>false)},keySecret:secret};
  expect((await makeApp(deps).fetch(req(path,undefined,{'CF-Connecting-IP':ip}))).status).toBe(429);
  expect(deps.oauth.save).not.toHaveBeenCalled();expect(deps.oauth.consume).not.toHaveBeenCalled();expect(deps.exchangeCode).not.toHaveBeenCalled();
 });
 it.each(['/api/patients','/api/appointments','/api/logout','/api/admin/intake'])('counts valid-CSRF authenticated mutation %s before business changes',async path=>{
  const {deps}=fixture();deps.requestLimits={store:{consume:vi.fn(async()=>false)},keySecret:secret};
  const response=await makeApp(deps).fetch(req(path,{}, {Cookie:'__Host-dental_session='+'o'.repeat(43),'X-CSRF-Token':'csrf'}));
  expect(response.status).toBe(429);expect(deps.sessions.revoke).not.toHaveBeenCalled();
  expect(deps.requestLimits.store.consume).toHaveBeenCalledWith('mutation',expect.stringMatching(/^[a-f0-9]{64}$/));
 });
 it('does not spend account budgets for missing-CSRF or foreign-origin attempts',async()=>{
  const {deps}=fixture();deps.requestLimits=limits();
  for(const headers of [{},{Origin:'https://foreign.example','X-CSRF-Token':'csrf'}] as Record<string,string>[])expect((await makeApp(deps).fetch(req('/api/patients',{}, {Cookie:'__Host-dental_session='+'o'.repeat(43),...headers}))).status).toBe(403);
  expect(deps.requestLimits.store.consume).not.toHaveBeenCalled();
 });
 it('leaves read-only requests outside mutation limits',async()=>{
  const deps=limits();await enforceRequestLimits(req('/api/session'),session,deps);expect(deps.store.consume).not.toHaveBeenCalled();
 });
 it.each([{rows:[]},{rows:[{result:'true'}]},{rows:[{result:true},{result:true}]}])('fails invalid database results closed: %j',async result=>{
  await expect(createRequestLimitStore({query:vi.fn(async()=>result)}).consume('login','a'.repeat(64))).rejects.toThrow('UNAVAILABLE');
 });
 it('contains database errors and does not call business work on failure',async()=>{
  const {deps}=fixture();deps.requestLimits={store:createRequestLimitStore({query:async()=>{throw new Error('RAW_IP_OR_DB_CANARY');}}),keySecret:secret};
  const response=await makeApp(deps).fetch(login());expect(response.status).toBe(503);expect(await response.text()).not.toContain('CANARY');expect(deps.verifier.verify).not.toHaveBeenCalled();
 });
});

describe('bounded body and safe response primitives',()=>{
 it('allows exactly 16KiB and rejects bytes beyond it even without Content-Length',async()=>{
  expect((await readBoundedBody(new Request(origin,{method:'POST',body:'x'.repeat(16384)}))).byteLength).toBe(16384);
  await expect(readBoundedBody(new Request(origin,{method:'POST',body:'x'.repeat(16385)}))).rejects.toThrow('VALIDATION');
 });
 it('counts UTF-8 bytes and checks declared length before reading',async()=>{
  await expect(readBoundedBody(new Request(origin,{method:'POST',body:'ก'.repeat(5500)}))).rejects.toThrow('VALIDATION');
  const r=new Request(origin,{method:'POST',headers:{'Content-Length':'16385'},body:'{}'});
  await expect(enforceRequestLimits(r,null,limits())).rejects.toThrow('VALIDATION');expect(r.bodyUsed).toBe(false);
 });
 it('rejects a padded otherwise-valid booking before touching reserve',async()=>{
  const {deps}=fixture();deps.db.reserve=vi.fn();
  const body=JSON.stringify({patientId:'20000000-0000-4000-8000-000000000002',patientVersion:1,service:'oral_check',date:'2026-10-09',ageConfirmed:42,authorizationAcknowledged:true})+' '.repeat(16384);
  const response=await makeApp(deps).fetch(new Request(origin+'/api/appointments',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:'__Host-dental_session='+'o'.repeat(43),'X-CSRF-Token':'csrf','Idempotency-Key':'30000000-0000-4000-8000-000000000003'},body}));
  expect(response.status).toBe(400);expect(deps.db.reserve).not.toHaveBeenCalled();
 });
 it('adds strict headers to runtime and composed API errors',async()=>{
  const {app}=fixture();const responses=[await app.fetch(req('/api/session')),secureResponse(new Response('x')),await createRuntime({assets:{}}).fetch(req('/api/session'),{})];
  for(const response of responses){expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');expect(response.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");expect(response.headers.get('Content-Security-Policy')).not.toContain('unsafe-inline');expect(response.headers.get('Permissions-Policy')).toContain('geolocation=()');}
 });
 it('logs only allowlisted event names, generated UUIDs and error codes, never extra fields',()=>{
  const log=vi.spyOn(console,'info').mockImplementation(()=>{});const correlationId=crypto.randomUUID();
  safeLog(Object.assign({name:'request_failed',correlationId,code:'UNAVAILABLE' as const},{ip,patientName:'PRIVATE_PATIENT_CANARY',token:'PRIVATE_TOKEN_CANARY'}));
  expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({name:'request_failed',correlationId,code:'UNAVAILABLE'}));
  safeLog({name:'PRIVATE_EVENT_CANARY',correlationId:'PRIVATE_ID_CANARY'});expect(JSON.stringify(log.mock.calls)).not.toContain('CANARY');
  log.mockRestore();
 });
});
