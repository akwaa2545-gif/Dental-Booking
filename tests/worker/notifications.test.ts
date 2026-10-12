import {describe,it,expect,vi} from 'vitest';
import {notificationPayloadV1,notificationPayloadV2} from '../../src/worker/notifications/payload';
import {createLineTransport} from '../../src/worker/notifications/line';
import {dispatchDue} from '../../src/worker/notifications/outbox';
import {runNotificationTick} from '../../src/worker/notifications/scheduled';
const id='11111111-1111-4111-8111-111111111111';
const event={id,appointmentId:id,appointmentVersion:2,type:'approval' as const,retryKey:id,dueAt:'2026-10-08T11:00:00Z',expiresAt:'2026-10-08T17:00:00Z'};
const prepared={event,recipient:'U'+'a'.repeat(32),date:'2026-10-09',reference:'TT-SYNTHETIC',status:'approved' as const,manageUrl:'https://clinic.example/appointments',payloadVersion:1 as const};
describe('immutable private notification payload',()=>{
 it('uses only allowlisted neutral fields and fixed authenticated manage route',()=>{
  const payload=notificationPayloadV1({...prepared,fullName:'PRIVATE_NAME',phone:'PRIVATE_PHONE',age:72,address:'PRIVATE_ADDRESS',service:'PRIVATE_SERVICE'});
  expect(JSON.stringify(payload)).toContain('08:30–09:30');expect(JSON.stringify(payload)).toContain('2026-10-09');expect(JSON.stringify(payload)).not.toContain('PRIVATE');
  expect(payload.messages[0]).toMatchObject({type:'flex',altText:'การนัดหมายของคุณมีข้อมูลอัปเดต'});
  expect(JSON.stringify(payload.messages[0])).toContain('https://clinic.example/appointments');
  expect(payload.messages[0].altText).not.toContain(prepared.reference);
 });
 it.each(['http://clinic.example/appointments','https://clinic.example/appointments?token=x','https://clinic.example/appointments#patient','https://private@clinic.example/appointments','https://clinic.example/patients'])('rejects unsafe manage links %s',manageUrl=>{expect(()=>notificationPayloadV1({...prepared,manageUrl})).toThrow();});
 it.each(['PRIVATE\nNAME','<script>',''])('rejects unsafe opaque references %s',reference=>{expect(()=>notificationPayloadV1({...prepared,reference})).toThrow();});
 it('rejects mismatched event and status rather than emitting false confirmation',()=>{expect(()=>notificationPayloadV1({...prepared,event:{...event,type:'rejection'}})).toThrow();});
 it('refuses unrecognized payload version instead of changing a retry body',()=>{expect(()=>notificationPayloadV1({...prepared,payloadVersion:2})).toThrow();});
});
describe('LINE transport (synthetic only)',()=>{
 it('defaults disabled even with a token and makes no request',async()=>{const fetcher=vi.fn();expect(await createLineTransport({token:'synthetic',fetcher}).send(prepared.recipient,{},id)).toEqual({kind:'permanent',category:'forbidden'});expect(fetcher).not.toHaveBeenCalled();});
 it.each([[200,'accepted',undefined],[409,'accepted',undefined],[500,'retryable','server_error'],[429,'permanent','rate_limited'],[401,'permanent','unauthorized'],[403,'permanent','forbidden'],[400,'permanent','invalid_request']])('maps status %s safely',async(status,kind,category)=>{
  const fetcher=vi.fn(async()=>new Response('PRIVATE_PROVIDER_BODY',{status:status as number,headers:{'x-line-request-id':id,'x-line-accepted-request-id':id}}));
  const result=await createLineTransport({enabled:true,token:'synthetic',fetcher}).send(prepared.recipient,notificationPayloadV1(prepared),id);
  expect(result).toEqual({kind,requestId:id,...(category?{category}:{})});const [url,init]=fetcher.mock.calls[0] as unknown as [string,RequestInit];expect(url).toBe('https://api.line.me/v2/bot/message/push');expect(new Headers(init.headers).get('x-line-retry-key')).toBe(id);expect(init.redirect).toBe('manual');expect(JSON.parse(init.body as string).to).toBe(prepared.recipient);
 });
 it('never treats unrelated 409 as accepted without accepted request ID',async()=>{expect(await createLineTransport({enabled:true,token:'synthetic',fetcher:async()=>new Response('',{status:409})}).send(prepared.recipient,{},id)).toEqual({kind:'permanent',category:'invalid_request'});});
 it('sanitizes raw exception and unsafe provider IDs',async()=>{expect(await createLineTransport({enabled:true,token:'synthetic',fetcher:async()=>{throw Error('PRIVATE');}}).send(prepared.recipient,{},id)).toEqual({kind:'retryable',category:'transport'});});
 it('limits provider request to 15 seconds',async()=>{vi.useFakeTimers();try{const fetcher:typeof fetch=async(_url,init)=>new Promise((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new DOMException('timeout','AbortError'))));const promise=createLineTransport({enabled:true,token:'synthetic',fetcher}).send(prepared.recipient,{},id);await vi.advanceTimersByTimeAsync(15000);expect(await promise).toEqual({kind:'retryable',category:'timeout'});}finally{vi.useRealTimers();}});
});
describe('leased dispatcher',()=>{
 function setup(value:typeof prepared|null=prepared){return{db:{claimEvents:vi.fn(async()=>[event]),prepareDispatch:vi.fn(async()=>value),finishDispatch:vi.fn(async()=>{})},transport:{send:vi.fn(async()=>({kind:'accepted' as const}))},workerId:id,manageOrigin:'https://clinic.example'};}
 it('checks final eligibility immediately before sending and reports provider acceptance only',async()=>{const deps=setup();expect(await dispatchDue(deps)).toEqual({accepted:1,suppressed:0,failed:0});expect(deps.transport.send).toHaveBeenCalledWith(prepared.recipient,notificationPayloadV1(prepared),id);expect(deps.db.finishDispatch).toHaveBeenCalledWith(id,id,{kind:'accepted'});});
 it('does not send a cancelled or stale event rejected by final DB check',async()=>{const deps=setup(null);expect(await dispatchDue(deps)).toEqual({accepted:0,suppressed:1,failed:0});expect(deps.transport.send).not.toHaveBeenCalled();});
 it('crash after acceptance does not invent a key on retry',async()=>{const deps=setup();deps.db.finishDispatch.mockRejectedValueOnce(Error('database unavailable'));await expect(dispatchDue(deps)).rejects.toThrow();await dispatchDue({...deps,workerId:'22222222-2222-4222-8222-222222222222'});expect(deps.transport.send.mock.calls[0]).toEqual(deps.transport.send.mock.calls[1]);});
 it('quarantines unsupported frozen payloads without a provider request',async()=>{const deps=setup({...prepared,payloadVersion:2} as never);expect(await dispatchDue(deps)).toEqual({accepted:0,suppressed:0,failed:1});expect(deps.transport.send).not.toHaveBeenCalled();expect(deps.db.finishDispatch).toHaveBeenCalledWith(id,id,{kind:'permanent',category:'invalid_request'});});
 it('assigns distinct per-invocation worker IDs so late results cannot finalize a later lease',async()=>{const deps=setup();await runNotificationTick({...deps,enabled:true});await runNotificationTick({...deps,enabled:true});expect(deps.db.claimEvents.mock.calls[0]).not.toEqual(deps.db.claimEvents.mock.calls[1]);});
 it('does not prepare or claim while scheduled delivery disabled',async()=>{const deps=setup();expect(await runNotificationTick({...deps,enabled:false})).toEqual({accepted:0,suppressed:0,failed:0});expect(deps.db.claimEvents).not.toHaveBeenCalled();});
});
it('bounds transport even when provider ignores AbortSignal',async()=>{vi.useFakeTimers();try{const promise=createLineTransport({enabled:true,token:'synthetic',fetcher:()=>new Promise(()=>{})}).send(prepared.recipient,{},id);let resolved=false;void promise.then(()=>{resolved=true;});await vi.advanceTimersByTimeAsync(15001);expect(resolved).toBe(true);expect(await promise).toEqual({kind:'retryable',category:'timeout'});}finally{vi.useRealTimers();}});
it('does not await a nonsettling provider-body cleanup after acceptance',async()=>{vi.useFakeTimers();try{const body=new ReadableStream({cancel:()=>new Promise(()=>{})});const promise=createLineTransport({enabled:true,token:'synthetic',fetcher:async()=>new Response(body,{status:200})}).send(prepared.recipient,{},id);let resolved=false;void promise.then(()=>{resolved=true;});await vi.advanceTimersByTimeAsync(1);expect(resolved).toBe(true);expect(await promise).toEqual({kind:'accepted'});}finally{vi.useRealTimers();}});

 it('dispatches a frozen V2 cancellation with neutral status and rebooking guidance',async()=>{
  const cancellation={...prepared,event:{...event,type:'cancellation' as const,appointmentVersion:3},status:'cancelled' as const,payloadVersion:2 as const,reason:'PRIVATE_REASON',patient:'PRIVATE_PATIENT'};
  const send=vi.fn(async()=>({kind:'accepted' as const}));
  const db={claimEvents:vi.fn(async()=>[cancellation.event]),prepareDispatch:vi.fn(async()=>cancellation),finishDispatch:vi.fn(async()=>{})};
  expect(await dispatchDue({db,transport:{send},workerId:id,manageOrigin:'https://clinic.example'})).toEqual({accepted:1,suppressed:0,failed:0});
  const payload=JSON.stringify(send.mock.calls[0]);
  expect(payload).toContain('ยกเลิก');expect(payload).toContain('เลือกวันนัดใหม่');expect(payload).not.toContain('PRIVATE');
 });
it.each([
 {payloadVersion:1,event:{...event,type:'cancellation'},status:'cancelled'},
 {payloadVersion:2,event:{...event,type:'approval'},status:'approved'},
 {payloadVersion:2,event:{...event,type:'cancellation'},status:'approved'},
 {payloadVersion:2,event:{...event,type:'cancellation'},status:'cancelled',manageUrl:'https://clinic.example/appointments?reason=private'},
 {payloadVersion:2,event:{...event,type:'cancellation'},status:'cancelled',reference:'PRIVATE\nNAME'},
 {payloadVersion:3,event:{...event,type:'cancellation'},status:'cancelled'},
])('refuses invalid cancellation protocol envelope %#',async override=>{
 const db={claimEvents:vi.fn(async()=>[event]),prepareDispatch:vi.fn(async()=>({...prepared,...override} as never)),finishDispatch:vi.fn(async()=>{})};
 const send=vi.fn();
 expect(await dispatchDue({db,transport:{send},workerId:id,manageOrigin:'https://clinic.example'})).toEqual({accepted:0,suppressed:0,failed:1});
 expect(send).not.toHaveBeenCalled();
});

it('freezes V2 cancellation bytes independently of private fields and retry attempts',()=>{
 const input={...prepared,event:{...event,type:'cancellation' as const,appointmentVersion:3},status:'cancelled' as const,payloadVersion:2,reason:'PRIVATE_REASON',fullName:'PRIVATE_NAME',service:'PRIVATE_SERVICE'};
 expect(notificationPayloadV2(input)).toEqual({messages:[{type:'flex',altText:'การนัดหมายของคุณมีข้อมูลอัปเดต',contents:{type:'bubble',body:{type:'box',layout:'vertical',contents:[
  {type:'text',text:'การนัดหมาย',weight:'bold',wrap:true},
  {type:'text',text:'หมายเลข TT-SYNTHETIC',wrap:true},
  {type:'text',text:'วันที่ 2026-10-09 เวลา 08:30–09:30',wrap:true},
  {type:'text',text:'สถานะ: คลินิกยกเลิกนัดหมาย',wrap:true},
  {type:'text',text:'ตรวจสอบสถานะล่าสุดและเลือกวันนัดใหม่บนเว็บไซต์',wrap:true},
 ]},footer:{type:'box',layout:'vertical',contents:[{type:'button',action:{type:'uri',label:'ดูการนัดหมาย',uri:'https://clinic.example/appointments'}}]}}}]});
 expect(notificationPayloadV2({...input,reason:'CHANGED_PRIVATE_REASON'})).toEqual(notificationPayloadV2(input));
});
