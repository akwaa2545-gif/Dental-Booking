// @vitest-environment node
import {describe,it,expect,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {createRuntime} from '../../src/worker/runtime';
import {readLiffConfig} from '../../src/worker/config';
import {fixture,req} from '../support/mock-line';
const origin='https://dental.example';
const settings={RATE_LIMIT_KEY_SECRET:'synthetic-rate-limit-key-with-at-least-32-bytes',APP_MODE:'production',AUTH_MODE:'line',MESSAGING_MODE:'disabled',APP_ORIGIN:origin,LINE_CHANNEL_ID:'123456',LINE_PROVIDER_ID:'synthetic',DENTAL_DB:{connectionString:'postgres://synthetic'}};
const assets={'/index.html':{body:'<html>staging</html>',contentType:'text/html; charset=utf-8'},'/assets/app-abc.js':{body:'export{}',contentType:'text/javascript; charset=utf-8'}};
function setup(){const clients:{on:ReturnType<typeof vi.fn>;connect:ReturnType<typeof vi.fn>;query:ReturnType<typeof vi.fn>;end:ReturnType<typeof vi.fn>}[]=[];const clientFactory=vi.fn(()=>{const c={on:vi.fn(),connect:vi.fn().mockResolvedValue(undefined),query:vi.fn().mockResolvedValue({rows:[{result:[]}]}),end:vi.fn().mockResolvedValue(undefined)};clients.push(c);return c;});return{clients,clientFactory,runtime:createRuntime({assets,clientFactory})};}
describe('LIFF-only settings',()=>{
 it('requires public trusted identity settings but no OAuth secret',()=>{expect(readLiffConfig(settings)).toEqual({appOrigin:origin,channelId:'123456',provider:'line:synthetic'});});
 it('rejects insecure, missing or mock identity configuration',()=>{for(const env of [{...settings,APP_ORIGIN:'http://dental.example'},{...settings,LINE_CHANNEL_ID:undefined},{...settings,AUTH_MODE:'mock'}])expect(()=>readLiffConfig(env)).toThrow();});
 it.each(['/api/auth/line/start','/api/auth/line/callback'])('disables unconfigured OAuth before state consumption: %s',async path=>{const{app,deps}=fixture();deps.line.channelSecret=undefined;const r=await app.fetch(req(path));expect(r.status).toBe(503);expect(deps.oauth.save).not.toHaveBeenCalled();expect(deps.oauth.consume).not.toHaveBeenCalled();});
});
describe('request-scoped Worker runtime',()=>{
 it('fails closed without binding and never falls API through to SPA',async()=>{const{runtime,clientFactory}=setup();for(const path of ['/api/session','/api','/api/missing']){const r=await runtime.fetch(new Request(origin+path),{});expect(r.status).toBe(503);expect(r.headers.get('Cache-Control')).toBe('no-store');expect(await r.text()).not.toContain('<html>');}expect(clientFactory).not.toHaveBeenCalled();});
 it('serves HTML and immutable assets without opening a database',async()=>{const{runtime,clientFactory}=setup();const html=await runtime.fetch(new Request(origin+'/appointments'),{});expect(await html.text()).toContain('staging');expect(html.headers.get('Cache-Control')).toBe('no-store');const js=await runtime.fetch(new Request(origin+'/assets/app-abc.js'),{});expect(js.headers.get('Cache-Control')).toContain('immutable');expect(js.headers.get('X-Content-Type-Options')).toBe('nosniff');expect(clientFactory).not.toHaveBeenCalled();expect((await runtime.fetch(new Request(origin+'/missing.js'),{})).status).toBe(404);});
 it('creates and closes a client per API request',async()=>{const{runtime,clients}=setup();for(let i=0;i<2;i++)expect((await runtime.fetch(new Request(origin+'/api/session'),settings)).status).toBe(401);expect(clients).toHaveLength(2);for(const c of clients){expect(c.connect).toHaveBeenCalledOnce();expect(c.end).toHaveBeenCalledOnce();}});
 it('rejects wrong origin before database connection',async()=>{const{runtime,clientFactory}=setup();expect((await runtime.fetch(new Request('https://foreign.example/api/session'),settings)).status).toBe(403);expect(clientFactory).not.toHaveBeenCalled();});
 it('sanitizes connection errors and closes the failed client',async()=>{const c={on:vi.fn(),connect:vi.fn().mockRejectedValue(new Error('PRIVATE_CREDENTIAL')),query:vi.fn().mockResolvedValue({rows:[{result:true}]}),end:vi.fn().mockResolvedValue(undefined)};const runtime=createRuntime({assets,clientFactory:()=>c});const r=await runtime.fetch(new Request(origin+'/api/session'),settings);expect(r.status).toBe(503);expect(await r.text()).not.toContain('PRIVATE');expect(c.end).toHaveBeenCalledOnce();});
 it('does not turn successful dispatch into retryable failure when cleanup fails',async()=>{const c={on:vi.fn(),connect:vi.fn(),query:vi.fn().mockResolvedValue({rows:[{result:true}]}),end:vi.fn().mockRejectedValue(new Error('PRIVATE'))};const runtime=createRuntime({assets,clientFactory:()=>c});expect((await runtime.fetch(new Request(origin+'/api/session'),settings)).status).toBe(401);});
});

describe('LIFF runtime composition across verification and SQL session store',()=>{
 it('verifies the Login audience and creates a hashed SQL session without OAuth secret',async()=>{
  const now=()=>new Date('2026-10-08T00:00:00Z');
  const providerFetch=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({iss:'https://access.line.me',aud:'123456',sub:'synthetic-line-user',exp:Math.floor(now().getTime()/1000)+3600})));
  const c={on:vi.fn(),connect:vi.fn(),end:vi.fn(),query:vi.fn(async(_text:string,values:unknown[])=>({rows:[{result:_text.includes('consume_request_limit')?true:{accountId:'10000000-0000-4000-8000-000000000001',csrfHash:values[3],expiresAt:values[4],isAdmin:false}}]}))};
  const runtime=createRuntime({assets,clientFactory:()=>c,fetch:providerFetch,now});
  const response=await runtime.fetch(new Request(origin+'/api/auth/liff',{method:'POST',headers:{'CF-Connecting-IP':'203.0.113.24',Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({idToken:'synthetic-raw-token'})}),settings);
  expect(response.status).toBe(200);
  expect(providerFetch).toHaveBeenCalledWith('https://api.line.me/oauth2/v2.1/verify',expect.objectContaining({body:new URLSearchParams({id_token:'synthetic-raw-token',client_id:'123456'})}));
  expect(c.query).toHaveBeenCalledWith(expect.stringContaining('dental.create_session'),['line:synthetic','synthetic-line-user',expect.stringMatching(/^[0-9a-f]{64}$/),expect.stringMatching(/^[0-9a-f]{64}$/),'2026-10-08T01:00:00.000Z']);
  expect(response.headers.get('Set-Cookie')).toMatch(/__Host-dental_session=.+; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  expect(await response.json()).toEqual(expect.objectContaining({isAdmin:false,csrfToken:expect.stringMatching(/^[0-9a-f]{64}$/)}));
  expect(c.end).toHaveBeenCalledOnce();
 });
 it('does not write sessions for wrong audience or foreign login origin',async()=>{
  const c={on:vi.fn(),connect:vi.fn(),end:vi.fn(),query:vi.fn().mockResolvedValue({rows:[{result:true}]})};
  const providerFetch=vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({iss:'https://access.line.me',aud:'WRONG',sub:'synthetic',exp:9999999999})));
  const runtime=createRuntime({assets,clientFactory:()=>c,fetch:providerFetch});
  for(const requestOrigin of [origin,'https://evil.example']){
   const r=await runtime.fetch(new Request(origin+'/api/auth/liff',{method:'POST',headers:{'CF-Connecting-IP':'203.0.113.24',Origin:requestOrigin,'Content-Type':'application/json'},body:'{"idToken":"synthetic"}'}),settings);
   expect(r.status).toBe(requestOrigin===origin?401:403);
  }
  expect(c.query).toHaveBeenCalledTimes(1);expect(c.query).toHaveBeenCalledWith(expect.stringContaining('consume_request_limit'),expect.any(Array));expect(providerFetch).toHaveBeenCalledOnce();
 });
});


it('handles asynchronous pg errors without an uncaught error or leaked detail',async()=>{
 const events=new EventEmitter();
 const c={on:events.on.bind(events),connect:vi.fn(async()=>{events.emit('error',new Error('PRIVATE_SOCKET_ERROR'));}),query:vi.fn().mockResolvedValue({rows:[{result:true}]}),end:vi.fn()};
 const runtime=createRuntime({assets,clientFactory:()=>c});
 const r=await runtime.fetch(new Request(origin+'/api/session'),settings);
 expect(events.listenerCount('error')).toBe(1);
 expect(r.status).toBe(503);expect(await r.text()).not.toContain('PRIVATE_SOCKET_ERROR');
 expect(c.query).not.toHaveBeenCalled();expect(c.end).toHaveBeenCalledOnce();
});

it('contains a pg disconnect while awaiting LINE and prevents later session SQL',async()=>{
 const events=new EventEmitter();
 let release!:(response:Response)=>void;
 let verifying!:()=>void;
 const waiting=new Promise<void>(resolve=>{verifying=resolve;});
 const c={on:events.on.bind(events),connect:vi.fn(),query:vi.fn().mockResolvedValue({rows:[{result:true}]}),end:vi.fn()};
 const runtime=createRuntime({assets,clientFactory:()=>c,fetch:vi.fn(()=>{verifying();return new Promise<Response>(resolve=>{release=resolve;});})});
 const pending=runtime.fetch(new Request(origin+'/api/auth/liff',{method:'POST',headers:{'CF-Connecting-IP':'203.0.113.24',Origin:origin,'Content-Type':'application/json'},body:'{"idToken":"synthetic"}'}),settings);
 await waiting;
 expect(()=>events.emit('error',new Error('PRIVATE_ASYNC_SOCKET_ERROR'))).not.toThrow();
 release(new Response(JSON.stringify({iss:'https://access.line.me',aud:'123456',sub:'synthetic',exp:9999999999})));
 const r=await pending;
 expect(r.status).toBe(503);expect(await r.text()).not.toContain('PRIVATE_ASYNC_SOCKET_ERROR');
 expect(c.query).toHaveBeenCalledTimes(1);expect(c.query).toHaveBeenCalledWith(expect.stringContaining('consume_request_limit'),expect.any(Array));expect(c.end).toHaveBeenCalledOnce();
});

it.each([undefined,'production','synthetic-staging'])('enables opaque auth503 tags only for explicit synthetic-staging: %s',async stage=>{
 const c={on:vi.fn(),connect:vi.fn(),query:vi.fn().mockResolvedValue({rows:[{result:true}]}),end:vi.fn()};
 const runtime=createRuntime({assets,clientFactory:()=>c,fetch:vi.fn<typeof fetch>().mockResolvedValue(new Response('PRIVATE_PROVIDER_BODY',{status:503}))});
 const r=await runtime.fetch(new Request(origin+'/api/auth/liff',{method:'POST',headers:{'CF-Connecting-IP':'203.0.113.24',Origin:origin,'Content-Type':'application/json'},body:'{"idToken":"synthetic"}'}),{...settings,APP_STAGE:stage});
 expect(r.status).toBe(503);const body=await r.json();
 expect(body.error.diagnostic).toBe(stage==='synthetic-staging'?'A10':undefined);
 expect(JSON.stringify(body)).not.toContain('PRIVATE');expect(c.query).toHaveBeenCalledTimes(1);expect(c.query).toHaveBeenCalledWith(expect.stringContaining('consume_request_limit'),expect.any(Array));
});

it.each(['/admin-invitation','/admin/administrators'])('serves the exact %s SPA route without database access',async path=>{
 const {runtime,clientFactory}=setup();const response=await runtime.fetch(new Request(origin+path),{});
 expect(response.status).toBe(200);expect(await response.text()).toContain('staging');expect(response.headers.get('Cache-Control')).toBe('no-store');expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');expect(clientFactory).not.toHaveBeenCalled();
});
it.each(['/admin-invitation/','/admin-invitation/suffix','/admin/administrators/','/admin/administrators/suffix','/admin-invitation%3Ftoken=x'])('does not widen SPA fallback for %s',async path=>{
 const {runtime,clientFactory}=setup();expect((await runtime.fetch(new Request(origin+path),{})).status).toBe(404);expect(clientFactory).not.toHaveBeenCalled();
});

it('wires the management adapter to each request-scoped port after session and live admin verification',async()=>{
 const {hashToken}=await import('../../src/worker/auth/session');
 const actor='10000000-0000-4000-8000-000000000001',cookieToken='o'.repeat(43),csrfToken=await hashToken('dental:csrf:v1:'+cookieToken),csrfHash=await hashToken(csrfToken);
 const {clients}=setup();
 // Every client performs real session decoding and management adapter calls.
 const clientFactory=vi.fn(()=>{const c={on:vi.fn(),connect:vi.fn(),end:vi.fn(),query:vi.fn(async(text:string)=>{
  if(text.includes('resolve_session'))return{rows:[{result:{accountId:actor,csrfHash,expiresAt:'2026-10-09T00:00:00Z',isAdmin:false}}]};
  if(text.includes('is_admin'))return{rows:[{result:true}]};
  if(text.includes('admin_management_capabilities'))return{rows:[{result:{canRevokeAdmins:false}}]};
  throw Error('Unexpected query');
 })};clients.push(c);return c;});
 const app=createRuntime({assets,clientFactory,now:()=>new Date('2026-10-08T00:00:00Z')});
 for(let index=0;index<2;index++){
  const response=await app.fetch(new Request(origin+'/api/admin/management/capabilities',{headers:{Cookie:'__Host-dental_session='+cookieToken}}),settings);
  expect(response.status).toBe(200);expect(await response.json()).toEqual({canRevokeAdmins:false});
 }
 expect(clients).toHaveLength(2);
 for(const client of clients){expect(client.query).toHaveBeenCalledWith('select dental.admin_management_capabilities($1::uuid) as result',[actor]);expect(client.query).toHaveBeenCalledTimes(3);expect(client.end).toHaveBeenCalledOnce();}
});

it('maps durable SQL-result verification failures after autocommit without rollback or mutation retry',async()=>{
 const {hashToken}=await import('../../src/worker/auth/session');
 const actor='10000000-0000-4000-8000-000000000001',id='20000000-0000-4000-8000-000000000001',cookieToken='o'.repeat(43),csrfToken=await hashToken('dental:csrf:v1:'+cookieToken),csrfHash=await hashToken(csrfToken);
 let committed=0;const queries:string[]=[];
 const clientFactory=()=>({on:vi.fn(),connect:vi.fn(),end:vi.fn(),query:vi.fn(async(text:string)=>{
  queries.push(text);
  if(text.includes('resolve_session'))return{rows:[{result:{accountId:actor,csrfHash,expiresAt:'2026-10-09T00:00:00Z',isAdmin:false}}]};
  if(text.includes('is_admin')||text.includes('consume_request_limit'))return{rows:[{result:true}]};
  if(text.includes('admin_management_approve')){committed++;return{rows:[{result:{ok:false,code:'INVALID_TRANSITION',version:committed+1,attemptsRemaining:5-committed}}]};}
  throw Error('Unexpected query');
 })});
 const runtime=createRuntime({assets,clientFactory,now:()=>new Date('2026-10-08T00:00:00Z')});
 for(let attempt=1;attempt<=5;attempt++){
  const response=await runtime.fetch(new Request(origin+`/api/admin/management/invitations/${id}/approve`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:'__Host-dental_session='+cookieToken,'X-CSRF-Token':csrfToken},body:JSON.stringify({version:attempt,verificationCode:'99999999'})}),settings);
  expect(response.status).toBe(409);expect(await response.json()).toEqual({error:{code:'INVALID_TRANSITION',correlationId:expect.any(String),version:attempt+1,attemptsRemaining:5-attempt}});expect(committed).toBe(attempt);
 }
 expect(queries.filter(query=>query.includes('admin_management_approve'))).toHaveLength(5);expect(queries.join('\n')).not.toMatch(/BEGIN|ROLLBACK|COMMIT/);
});
