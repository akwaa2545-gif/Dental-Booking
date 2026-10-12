// @vitest-environment node
import {createHmac} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {verifyLineWebhook} from '../../src/worker/auth/webhook';
import {DatabaseError} from '../../src/worker/db';

const secret='synthetic-messaging-channel-secret';
const body='{"destination":"synthetic-bot","events":[{"type":"follow","source":{"type":"user","userId":"U11111111111111111111111111111111"},"timestamp":1791414000000,"webhookEventId":"synthetic-event","deliveryContext":{"isRedelivery":false}}]}';
// Independent Node implementation signs fixtures; production uses Web Crypto.
function signature(value:string|Uint8Array,key=secret){return createHmac('sha256',key).update(value).digest('base64');}
function request(value:string,header:string|null=signature(value)){
  return new Request('https://booking.example/api/line/webhook',{method:'POST',headers:header===null?{}:{'x-line-signature':header},body:value});
}
afterEach(()=>vi.restoreAllMocks());

describe('LINE webhook authentication',()=>{
  it('returns a verified webhook only after HMAC-SHA256 authentication',async()=>{
    expect(await verifyLineWebhook(request(body),secret)).toEqual({destination:'synthetic-bot',events:[{type:'follow',source:{type:'user',userId:'U11111111111111111111111111111111'},timestamp:1791414000000,webhookEventId:'synthetic-event',deliveryContext:{isRedelivery:false}}]});
  });

  it('verifies the exact raw bytes rather than reserialized JSON',async()=>{
    const raw=' {\r\n "destination": "synthetic-bot", "events": [], "text": "ทดสอบ\\n\\u0e01"\r\n} ';
    await expect(verifyLineWebhook(request(raw),secret)).resolves.toEqual({destination:'synthetic-bot',events:[],text:'ทดสอบ\nก'});
    await expect(verifyLineWebhook(request(JSON.stringify(JSON.parse(raw)),signature(raw)),secret)).rejects.toEqual(new DatabaseError('UNAUTHENTICATED'));
  });

  it.each([null,'','not-base64','a'.repeat(43)+'=','a'.repeat(42)+'=='])('rejects absent or forged signatures (%s)',async header=>{
    await expect(verifyLineWebhook(request(body,header),secret)).rejects.toEqual(new DatabaseError('UNAUTHENTICATED'));
  });

  it('fails authentication before parsing a forged JSON body',async()=>{
    const forged=request('PRIVATE_MALFORMED_JSON',signature(body));
    const parse=vi.spyOn(JSON,'parse');
    await expect(verifyLineWebhook(forged,secret)).rejects.toEqual(new DatabaseError('UNAUTHENTICATED'));
    expect(parse).not.toHaveBeenCalled();
  });

  it('rejects a body signed by a different channel',async()=>{
    await expect(verifyLineWebhook(request(body,signature(body,'wrong-channel-secret')),secret)).rejects.toEqual(new DatabaseError('UNAUTHENTICATED'));
  });

  it('rejects a one-byte change in an otherwise signed payload',async()=>{
    await expect(verifyLineWebhook(request(body.replace('follow','unfollow'),signature(body)),secret)).rejects.toEqual(new DatabaseError('UNAUTHENTICATED'));
  });

  it('accepts the empty events envelope used to verify a webhook URL',async()=>{
    await expect(verifyLineWebhook(request('{"destination":"synthetic-bot","events":[]}'),secret)).resolves.toEqual({destination:'synthetic-bot',events:[]});
  });

  it('does not grant application identity or an admin role from webhook claims',async()=>{
    const raw='{"events":[{"type":"follow","role":"admin","source":{"userId":"synthetic-user"}}],"role":"admin"}';
    // The verifier returns only the authenticated external payload, never a Session.
    const result=await verifyLineWebhook(request(raw),secret);
    expect(result).not.toHaveProperty('accountId');
    expect(result).not.toHaveProperty('isAdmin');
    expect(result).not.toHaveProperty('csrfToken');
  });

  it('redacts signed malformed JSON errors',async()=>{
    await expect(verifyLineWebhook(request('PRIVATE_MALFORMED_JSON'),secret)).rejects.toEqual(new DatabaseError('UNAUTHENTICATED'));
  });

  it('rejects invalid UTF-8 after authenticating the original bytes',async()=>{
    const raw=new Uint8Array([0x7b,0x22,0x61,0x22,0x3a,0x22,0xff,0x22,0x7d]);
    const incoming=new Request('https://booking.example/api/line/webhook',{method:'POST',headers:{'x-line-signature':signature(raw)},body:raw});
    await expect(verifyLineWebhook(incoming,secret)).rejects.toEqual(new DatabaseError('UNAUTHENTICATED'));
  });

  it('bounds raw body consumption even when Content-Length is missing',async()=>{
    const raw=JSON.stringify({events:[],padding:'x'.repeat(2_097_152)});
    await expect(verifyLineWebhook(request(raw),secret)).rejects.toEqual(new DatabaseError('UNAUTHENTICATED'));
  });

  it('fails closed if the Messaging API channel secret is unavailable',async()=>{
    await expect(verifyLineWebhook(request(body),'')).rejects.toEqual(new DatabaseError('UNAVAILABLE'));
  });
});
