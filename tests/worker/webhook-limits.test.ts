// @vitest-environment node
import {createHmac} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {verifyLineWebhook} from '../../src/worker/auth/webhook';
import {readJson} from '../../src/worker/http';
import {makeApp} from '../../src/worker/index';
import {createRuntime} from '../../src/worker/runtime';
import {fixture,origin} from '../support/mock-line';

const channelSecret='synthetic-messaging-channel-secret';
const destination='U'+'0'.repeat(32);
const webhookPath='/api/line/webhook';
const webhookLimit=2*1024*1024;
const appLimit=16*1024;
const env={APP_MODE:'production',AUTH_MODE:'line',MESSAGING_MODE:'disabled',APP_ORIGIN:origin,
 LINE_CHANNEL_ID:'123',LINE_PROVIDER_ID:'synthetic',DENTAL_DB:{connectionString:'postgres://synthetic'},
 LINE_WEBHOOK_ENABLED:'true',LINE_MESSAGING_CHANNEL_SECRET:channelSecret,LINE_MESSAGING_DESTINATION:destination,
 RATE_LIMIT_KEY_SECRET:'synthetic-rate-limit-key-with-at-least-32-bytes'};
function event(index=0){return {type:'follow',mode:'active',timestamp:1,
 source:{type:'user',userId:'U'+index.toString(16).padStart(32,'0')},
 webhookEventId:'01ARZ3NDEKTSV4RRFFQ69G'+index.toString().padStart(4,'0'),
 deliveryContext:{isRedelivery:false},replyToken:'synthetic-reply-token-'+index.toString().padStart(11,'0'),
 follow:{isUnblocked:false}};}
function envelope(events:unknown[]=[event()]){return JSON.stringify({destination,events});}
function padded(bytes:number){const raw=envelope();return raw+' '.repeat(bytes-Buffer.byteLength(raw));}
function sign(raw:string){return createHmac('sha256',channelSecret).update(raw).digest('base64');}
function request(raw:string,options:{signature?:string|null;length?:string;path?:string;method?:string;body?:ReadableStream<Uint8Array>}={}){
 const headers=new Headers({'Content-Type':'application/json'});
 const signature=options.signature===undefined?sign(raw):options.signature;
 if(signature!==null)headers.set('x-line-signature',signature);
 if(options.length!==undefined)headers.set('Content-Length',options.length);
 const init:RequestInit&{duplex?:'half'}={method:options.method??'POST',headers,body:options.body??raw};
 if(options.body)init.duplex='half';
 return new Request(origin+(options.path??webhookPath),init);
}
function setup(entry:'makeApp'|'createRuntime'){
 const base=fixture();
 const writes:unknown[][]=[];
 const recordReachability=vi.fn(async(...values:[string,string,string,string,boolean])=>{writes.push(values);});
 const client={on:vi.fn(),connect:vi.fn(),end:vi.fn(),query:vi.fn(async(_text:string,values:unknown[])=>{
  writes.push(values);return {rows:[{result:true}]};
 })};
 const clientFactory=vi.fn(()=>client);
 const providerFetch=vi.fn<typeof fetch>();
 const app=makeApp({...base.deps,notificationWebhook:{channelSecret,destination,provider:'line:synthetic',db:{recordReachability}}});
 const runtime=createRuntime({assets:{},clientFactory,fetch:providerFetch});
 return {writes,client,clientFactory,providerFetch,base,
  fetch:(incoming:Request)=>entry==='makeApp'?app.fetch(incoming):runtime.fetch(incoming,env)};
}
beforeEach(()=>vi.spyOn(console,'info').mockImplementation(()=>{}));
afterEach(()=>vi.restoreAllMocks());

describe.each(['makeApp','createRuntime'] as const)('%s signed webhook byte boundary',entry=>{
 it.each([false,true])('accepts a signed 100-user follow batch above 16 KiB (Content-Length: %s)',async declared=>{
  const s=setup(entry);
  const raw=envelope(Array.from({length:100},(_,index)=>event(index)));
  expect(Buffer.byteLength(raw)).toBeGreaterThan(appLimit);
  expect(Buffer.byteLength(raw)).toBeLessThan(40*1024);
  const response=await s.fetch(request(raw,{length:declared?String(Buffer.byteLength(raw)):undefined}));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({received:true});
  expect(s.writes).toEqual(Array.from({length:100},(_,index)=>['line:synthetic',event(index).source.userId,
   event(index).webhookEventId,'1970-01-01T00:00:00.001Z',true]));
  expect(s.base.deps.requestLimits.store.consume).not.toHaveBeenCalled();
  expect(s.base.deps.sessions.resolve).not.toHaveBeenCalled();
  expect(s.base.deps.sessions.create).not.toHaveBeenCalled();
  expect(s.providerFetch).not.toHaveBeenCalled();
  if(entry==='createRuntime'){
   expect(s.clientFactory).toHaveBeenCalledOnce();
   expect(s.client.query.mock.calls.every(([sql])=>sql.includes('record_line_reachability'))).toBe(true);
   expect(s.client.end).toHaveBeenCalledOnce();
  }
 });

 it.each([false,true])('accepts exactly 2 MiB of signed legal JSON whitespace (Content-Length: %s)',async declared=>{
  const s=setup(entry);const raw=padded(webhookLimit);
  expect(Buffer.byteLength(raw)).toBe(webhookLimit);
  const incoming=request(raw,{length:declared?String(webhookLimit):undefined});
  const originalVerify=crypto.subtle.verify.bind(crypto.subtle);
  let authenticated=false;
  vi.spyOn(crypto.subtle,'verify').mockImplementation(async(...args)=>{
   authenticated=await originalVerify(...args);return authenticated;
  });
  const originalParse=JSON.parse;
  const parse=vi.spyOn(JSON,'parse').mockImplementation((...args:Parameters<typeof JSON.parse>)=>{
   expect(authenticated).toBe(true);return originalParse(...args);
  });
  const response=await s.fetch(incoming);
  expect(response.status).toBe(200);
  expect(parse).toHaveBeenCalledOnce();
  expect(s.writes).toEqual([['line:synthetic',event().source.userId,event().webhookEventId,'1970-01-01T00:00:00.001Z',true]]);
 });

 it.each([undefined,'1',String(webhookLimit+1)])('rejects 2 MiB + 1 before HMAC, parsing or SQL (Content-Length: %s)',async length=>{
  const s=setup(entry);const incoming=request(padded(webhookLimit+1),{length});
  const verify=vi.spyOn(crypto.subtle,'verify');const parse=vi.spyOn(JSON,'parse');
  const response=await s.fetch(incoming);
  expect(response.status).toBe(401);
  expect(verify).not.toHaveBeenCalled();expect(parse).not.toHaveBeenCalled();
  expect(s.writes).toEqual([]);expect(s.clientFactory).not.toHaveBeenCalled();
 });

 it.each([null,sign('different raw bytes')])('rejects an absent or forged signature before parsing or SQL (%s)',async signature=>{
  const s=setup(entry);const incoming=request(padded(webhookLimit),{signature});
  const parse=vi.spyOn(JSON,'parse');const verify=vi.spyOn(crypto.subtle,'verify');
  const response=await s.fetch(incoming);
  expect(response.status).toBe(401);expect(parse).not.toHaveBeenCalled();
  expect(s.writes).toEqual([]);expect(s.clientFactory).not.toHaveBeenCalled();
  if(signature===null){expect(incoming.bodyUsed).toBe(false);expect(verify).not.toHaveBeenCalled();}
  else expect(verify).toHaveBeenCalledOnce();
  expect(await response.text()).not.toContain(channelSecret);
  expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(event().replyToken);
 });

 it.each(['-1','2e6','2097152x','2, 2','9007199254740992',String(webhookLimit+1)])('rejects malformed or over-limit declared length %s without reading',async length=>{
  const s=setup(entry);const incoming=request(envelope(),{length});
  const verify=vi.spyOn(crypto.subtle,'verify');const parse=vi.spyOn(JSON,'parse');
  expect((await s.fetch(incoming)).status).toBe(401);
  expect(incoming.bodyUsed).toBe(false);expect(verify).not.toHaveBeenCalled();expect(parse).not.toHaveBeenCalled();
  expect(s.writes).toEqual([]);expect(s.clientFactory).not.toHaveBeenCalled();
 });

 it('counts streamed UTF-8 bytes and cancels overflow despite a smaller declared length',async()=>{
  const s=setup(entry);
  const raw=envelope([{type:'message',message:{type:'text',text:'ก'.repeat(699_051)}}]);
  expect(raw.length).toBeLessThan(webhookLimit);expect(Buffer.byteLength(raw)).toBeGreaterThan(webhookLimit);
  const bytes=new TextEncoder().encode(raw);let offset=0;
  const cancel=vi.fn();
  const body=new ReadableStream<Uint8Array>({pull(controller){
   if(offset===bytes.byteLength){controller.close();return;}
   const next=Math.min(offset+8191,bytes.byteLength);controller.enqueue(bytes.subarray(offset,next));offset=next;
  },cancel},{highWaterMark:0});
  const incoming=request(raw,{length:'1',body});
  const parse=vi.spyOn(JSON,'parse');const verify=vi.spyOn(crypto.subtle,'verify');
  expect((await s.fetch(incoming)).status).toBe(401);
  expect(cancel).toHaveBeenCalledOnce();expect(parse).not.toHaveBeenCalled();expect(verify).not.toHaveBeenCalled();
  expect(s.writes).toEqual([]);expect(s.clientFactory).not.toHaveBeenCalled();
 });

 it.each([
  {path:'/api/other'}, {path:webhookPath+'/'}, {path:webhookPath+'/extra'},
  {path:'/api/line/%77ebhook'}, {method:'PUT'}, {method:'PATCH'},
 ])('does not extend the larger limit to another route or method %j',async options=>{
  const s=setup(entry);const incoming=request(padded(appLimit+1),{...options,length:String(appLimit+1)});
  const verify=vi.spyOn(crypto.subtle,'verify');const parse=vi.spyOn(JSON,'parse');
  expect([400,405]).toContain((await s.fetch(incoming)).status);
  expect(incoming.bodyUsed).toBe(false);expect(verify).not.toHaveBeenCalled();expect(parse).not.toHaveBeenCalled();
  expect(s.writes).toEqual([]);
 });

 it('does not let caller query parameters increase the fixed webhook ceiling',async()=>{
  const s=setup(entry);const incoming=request(padded(webhookLimit+1),{path:webhookPath+'?maxBodyBytes=4194304'});
  const parse=vi.spyOn(JSON,'parse');
  expect((await s.fetch(incoming)).status).toBe(401);expect(parse).not.toHaveBeenCalled();expect(s.writes).toEqual([]);
 });

 it('retains the local 100-event cap before any SQL even within 2 MiB',async()=>{
  const s=setup(entry);const raw=envelope(Array.from({length:101},(_,index)=>event(index)));
  expect((await s.fetch(request(raw))).status).toBe(400);
  expect(s.writes).toEqual([]);expect(s.clientFactory).not.toHaveBeenCalled();
 });

 it.each([false,true])('retains the 16 KiB application JSON cap (Content-Length: %s)',async declared=>{
  const s=setup(entry);const raw='{"idToken":"synthetic"}'+' '.repeat(appLimit);
  const incoming=request(raw,{path:'/api/auth/liff',length:declared?String(Buffer.byteLength(raw)):undefined});
  incoming.headers.set('Origin',origin);incoming.headers.set('CF-Connecting-IP','203.0.113.24');
  const parse=vi.spyOn(JSON,'parse');
  expect((await s.fetch(incoming)).status).toBe(400);expect(parse).not.toHaveBeenCalled();
  expect(s.base.deps.verifier.verify).not.toHaveBeenCalled();expect(s.providerFetch).not.toHaveBeenCalled();
  expect(s.client.query.mock.calls.every(([sql])=>sql.includes('consume_request_limit'))).toBe(true);
 });
});

describe('internal reader scope',()=>{
 it.each([{path:'/api/other'},{path:webhookPath+'/'},{method:'PUT'}])('refuses direct webhook verification on another route or method %j',async options=>{
  const incoming=request(envelope(),options);const parse=vi.spyOn(JSON,'parse');
  await expect(verifyLineWebhook(incoming,channelSecret)).rejects.toThrow('UNAUTHENTICATED');
  expect(incoming.bodyUsed).toBe(false);expect(parse).not.toHaveBeenCalled();
 });
 it('keeps ordinary readJson exactly bounded at 16 KiB, including on the webhook URL',async()=>{
  const exact='{}'+' '.repeat(appLimit-2);
  await expect(readJson(request(exact))).resolves.toEqual({});
  await expect(readJson(request(exact+' '))).rejects.toThrow('VALIDATION');
 });
});
