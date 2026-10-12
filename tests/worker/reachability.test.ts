// @vitest-environment node
import {createHmac} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {handleNotificationWebhook} from '../../src/worker/notifications/webhook';
import {makeApp} from '../../src/worker/index';
import {fixture,origin,req} from '../support/mock-line';

const channelSecret='synthetic-messaging-channel-secret';
const destination='U00000000000000000000000000000000';
const subject='U11111111111111111111111111111111';
const provider='line:synthetic';
const eventId='01K71NZY800000000000000001';
const now=Date.parse('2026-10-08T04:00:00.000Z');
const timestamp=now-1000;
function event(overrides:Record<string,unknown>={}){
  return {type:'follow',mode:'active',timestamp,source:{type:'user',userId:subject},webhookEventId:eventId,deliveryContext:{isRedelivery:false},...overrides};
}
function envelope(events:unknown[]=[event()],overrides:Record<string,unknown>={}){return {destination,events,...overrides};}
// Sign fixtures independently of the Web Crypto verifier, using synthetic data only.
function sign(raw:string,key=channelSecret){return createHmac('sha256',key).update(raw).digest('base64');}
function request(payload:unknown,options:{raw?:string;signature?:string|null;url?:string;method?:string}={}){
  const raw=options.raw??JSON.stringify(payload);
  const signature=options.signature===undefined?sign(raw):options.signature;
  const method=options.method??'POST';
  return new Request(options.url??'https://booking.example/api/line/webhook',{
    method,headers:signature===null?{}:{'x-line-signature':signature},...(method==='GET'||method==='HEAD'?{}:{body:raw}),
  });
}
function setup(){
  const calls:unknown[][]=[];
  const deps={channelSecret,destination,provider,db:{async recordReachability(...values:[string,string,string,string,boolean]){calls.push(values);}}};
  return {deps,calls};
}
async function expectError(response:Response|null,status:number,code:string){
  expect(response?.status).toBe(status);
  expect(response?.headers.get('Cache-Control')).toBe('no-store');
  expect(await response?.json()).toEqual({error:{code,correlationId:expect.any(String)}});
}
beforeEach(()=>vi.spyOn(Date,'now').mockReturnValue(now));
afterEach(()=>vi.restoreAllMocks());

describe('verified notification reachability webhook',()=>{
  it.each([['follow',true],['unfollow',false]] as const)('records %s with only verified event identity and normalized event time',async(type,reachable)=>{
    const {deps,calls}=setup();
    const response=await handleNotificationWebhook(request(envelope([event({type})])),deps);
    expect(response?.status).toBe(200);
    expect(response?.headers.get('Cache-Control')).toBe('no-store');
    expect(response?.headers.has('Set-Cookie')).toBe(false);
    expect(await response?.json()).toEqual({received:true});
    expect(calls).toEqual([[provider,subject,eventId,'2026-10-08T03:59:59.000Z',reachable]]);
  });

  it('accepts documented follow metadata without forwarding tokens or claims',async()=>{
    const {deps,calls}=setup();
    const payload=envelope([event({replyToken:'synthetic-reply-token',follow:{isUnblocked:true}})]);
    expect((await handleNotificationWebhook(request(payload),deps))?.status).toBe(200);
    expect(calls).toEqual([[provider,subject,eventId,'2026-10-08T03:59:59.000Z',true]]);
  });

  it('passes redelivery IDs and original times unchanged for durable SQL replay/order checks',async()=>{
    const {deps,calls}=setup();
    const old=event({timestamp:1,deliveryContext:{isRedelivery:true}});
    expect((await handleNotificationWebhook(request(envelope([old])),deps))?.status).toBe(200);
    expect((await handleNotificationWebhook(request(envelope([old])),deps))?.status).toBe(200);
    expect(calls).toEqual(Array.from({length:2},()=>[provider,subject,eventId,'1970-01-01T00:00:00.001Z',true]));
  });

  it('accepts an empty verification envelope without a reachability mutation',async()=>{
    const {deps,calls}=setup();
    expect((await handleNotificationWebhook(request(envelope([])),deps))?.status).toBe(200);
    expect(calls).toEqual([]);
  });

  it.each(['message','join','accountLink','futureEvent'])('ignores unrelated %s events without treating them as reachability',async type=>{
    const {deps,calls}=setup();
    const payload=envelope([{type,role:'admin',source:{type:'group',userId:subject},privateField:'PRIVATE_CANARY'},event()]);
    expect((await handleNotificationWebhook(request(payload),deps))?.status).toBe(200);
    expect(calls).toEqual([[provider,subject,eventId,'2026-10-08T03:59:59.000Z',true]]);
  });

  it.each([
    {method:'GET'}, {method:'PUT'}, {method:'DELETE'},
    {url:'https://booking.example/api/other'}, {url:'https://booking.example/api/line/webhook/extra'},
  ])('does not handle another route or method (%j)',async options=>{
    const {deps,calls}=setup();
    const incoming=request(envelope(),options);
    expect(await handleNotificationWebhook(incoming,deps)).toBeNull();
    expect(incoming.bodyUsed).toBe(false);
    expect(calls).toEqual([]);
  });

  it.each([null,'not-base64',sign('unrelated-body')])('rejects missing/forged signatures before parsing or writing (%s)',async signature=>{
    const {deps,calls}=setup();
    const incoming=request(null,{raw:'PRIVATE_MALFORMED_JSON',signature});
    const parse=vi.spyOn(JSON,'parse');
    const response=await handleNotificationWebhook(incoming,deps);
    expect(parse).not.toHaveBeenCalled();
    await expectError(response,401,'UNAUTHENTICATED');
    expect(calls).toEqual([]);
  });

  it('verifies the raw body rather than a JSON reserialization',async()=>{
    const {deps,calls}=setup();
    const raw=` \n ${JSON.stringify(envelope())}\r\n `;
    expect((await handleNotificationWebhook(request(null,{raw}),deps))?.status).toBe(200);
    const response=await handleNotificationWebhook(request(envelope(),{signature:sign(raw)}),deps);
    await expectError(response,401,'UNAUTHENTICATED');
    expect(calls).toHaveLength(1);
  });

  it('rejects a signature from another Messaging API channel',async()=>{
    const {deps,calls}=setup();
    const payload=envelope();
    await expectError(await handleNotificationWebhook(request(payload,{signature:sign(JSON.stringify(payload),'another-channel')}),deps),401,'UNAUTHENTICATED');
    expect(calls).toEqual([]);
  });

  it('rejects a signed event for another OA destination',async()=>{
    const {deps,calls}=setup();
    await expectError(await handleNotificationWebhook(request(envelope([event()],{destination:'U22222222222222222222222222222222'})),deps),401,'UNAUTHENTICATED');
    expect(calls).toEqual([]);
  });

  it.each([
    null, [], {}, {events:[]}, {destination}, {destination,events:{}},
    {destination:'PRIVATE_CANARY',events:[]}, {destination,events:[null]},
    {destination,events:[[]]}, {destination,events:[{}]}, {destination,events:[{type:''}]},
    {destination,events:[{type:7}]}, {destination,events:Array.from({length:101},()=>({type:'message'}))},
    {...envelope(),role:'admin'},
  ])('rejects malformed or unsupported envelopes before any mutation (%#)',async payload=>{
    const {deps,calls}=setup();
    await expectError(await handleNotificationWebhook(request(payload),deps),400,'VALIDATION');
    expect(calls).toEqual([]);
  });

  it.each([
    {timestamp:undefined}, {timestamp:'1791431999000'}, {timestamp:-1}, {timestamp:1.5},
    {timestamp:Number.MAX_SAFE_INTEGER}, {timestamp:now+300_001},
    {webhookEventId:undefined}, {webhookEventId:''}, {webhookEventId:'PRIVATE_CANARY'},
    {webhookEventId:'81K71NZY800000000000000001'}, {webhookEventId:'01K71NZY80000000000000000I'},
    {source:undefined}, {source:{type:'group',userId:subject}}, {source:{type:'room',userId:subject}},
    {source:{type:'user'}}, {source:{type:'user',userId:'PRIVATE_CANARY'}},
    {source:{type:'user',userId:'U'+'g'.repeat(32)}}, {source:{type:'user',userId:'U'+'A'.repeat(32)}}, {source:{type:'user',userId:'U'+'1'.repeat(31)}},
    {source:{type:'user',userId:subject,role:'admin'}},
    {deliveryContext:undefined}, {deliveryContext:{isRedelivery:'false'}},
    {mode:'invalid'}, {replyToken:7}, {follow:{isUnblocked:'true'}}, {role:'admin'},
  ])('validates every reachability event before mutating an earlier valid event (%#)',async overrides=>{
    const {deps,calls}=setup();
    await expectError(await handleNotificationWebhook(request(envelope([event(),event(overrides)])),deps),400,'VALIDATION');
    expect(calls).toEqual([]);
  });

  it('permits at most five minutes of forward clock skew',async()=>{
    const {deps,calls}=setup();
    expect((await handleNotificationWebhook(request(envelope([event({timestamp:now+300_000})])),deps))?.status).toBe(200);
    expect(calls).toEqual([[provider,subject,eventId,'2026-10-08T04:05:00.000Z',true]]);
  });

  it('rejects query parameters after authenticating the request',async()=>{
    const {deps,calls}=setup();
    await expectError(await handleNotificationWebhook(request(envelope(),{url:'https://booking.example/api/line/webhook?provider=attacker'}),deps),400,'VALIDATION');
    expect(calls).toEqual([]);
  });

  it.each([{channelSecret:''},{destination:''},{destination:'invalid'},{provider:''},{provider:'   '},{provider:'unscoped-provider'},{provider:'line:'},{provider:'line:'+ 'x'.repeat(101)}])('fails closed for missing or invalid trusted configuration (%j)',async overrides=>{
    const {deps,calls}=setup();
    await expectError(await handleNotificationWebhook(request(envelope()),{...deps,...overrides}),503,'UNAVAILABLE');
    expect(calls).toEqual([]);
  });

  it('returns a retryable, redacted failure when reachability persistence fails',async()=>{
    const {deps}=setup();
    deps.db.recordReachability=async()=>{throw new Error('PRIVATE_CANARY: database credentials and patient values');};
    const response=await handleNotificationWebhook(request(envelope()),deps);
    await expectError(response,503,'UNAVAILABLE');
  });
});


describe('optional composed notification webhook route',()=>{
  it('handles signed notifications before app sessions without creating identity or roles',async()=>{
    const base=fixture();
    const {deps:notificationWebhook,calls}=setup();
    const app=makeApp({...base.deps,notificationWebhook});
    const response=await app.fetch(request(envelope(),{url:origin+'/api/line/webhook'}));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(response.headers.has('Set-Cookie')).toBe(false);
    expect(calls).toEqual([[provider,subject,eventId,'2026-10-08T03:59:59.000Z',true]]);
    expect(base.deps.sessions.resolve).not.toHaveBeenCalled();
    expect(base.deps.sessions.create).not.toHaveBeenCalled();
    expect(base.deps.verifier.verify).not.toHaveBeenCalled();
    expect(base.deps.db.isAdmin).not.toHaveBeenCalled();
    expect((await app.fetch(req('/api/session'))).status).toBe(401);
    expect((await app.fetch(req('/api/admin/appointments'))).status).toBe(401);
  });

  it('uses the separate Messaging API channel secret, never the Login channel secret',async()=>{
    const base=fixture();
    const {deps:notificationWebhook,calls}=setup();
    expect(notificationWebhook.channelSecret).not.toBe(base.deps.line.channelSecret);
    const app=makeApp({...base.deps,notificationWebhook});
    const payload=envelope();
    const response=await app.fetch(request(payload,{url:origin+'/api/line/webhook',signature:sign(JSON.stringify(payload),base.deps.line.channelSecret)}));
    await expectError(response,401,'UNAUTHENTICATED');
    expect(calls).toEqual([]);
    expect(base.deps.sessions.create).not.toHaveBeenCalled();
    expect(base.deps.sessions.resolve).not.toHaveBeenCalled();
  });

  it('remains disabled unless the trusted server injects webhook dependencies',async()=>{
    const {app,deps}=fixture();
    const response=await app.fetch(request(envelope(),{url:origin+'/api/line/webhook'}));
    await expectError(response,401,'UNAUTHENTICATED');
    expect(deps.sessions.create).not.toHaveBeenCalled();
    expect(deps.verifier.verify).not.toHaveBeenCalled();
  });

  it('preserves the app-origin boundary even for a correctly signed webhook',async()=>{
    const base=fixture();
    const {deps:notificationWebhook,calls}=setup();
    const app=makeApp({...base.deps,notificationWebhook});
    await expectError(await app.fetch(request(envelope(),{url:'https://other.example/api/line/webhook'})),403,'FORBIDDEN');
    expect(calls).toEqual([]);
  });
});
