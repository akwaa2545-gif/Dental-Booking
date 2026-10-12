import {DatabaseError} from '../db';

import {readBoundedBody} from '../security';

// Preserve the existing local webhook ceiling; application JSON stays at 16 KiB.
const MAX_WEBHOOK_BYTES=2*1024*1024;

/**
 * Authenticating a webhook does not authenticate an application user or grant a
 * role. This parser deliberately returns unknown; no follow/unfollow mutations
 * are implemented here. Callers must validate any event shape before using it.
 * https://developers.line.biz/en/docs/messaging-api/verify-webhook-signature/
 */
export async function verifyLineWebhook(request:Request,channelSecret:string):Promise<unknown>{
  if(request.method!=='POST'||new URL(request.url).pathname!=='/api/line/webhook')throw new DatabaseError('UNAUTHENTICATED');
  if(typeof channelSecret!=='string'||!channelSecret.trim())throw new DatabaseError('UNAVAILABLE');
  const signature=request.headers.get('x-line-signature');
  if(!signature||!/^[A-Za-z0-9+/]{43}=$/.test(signature))throw new DatabaseError('UNAUTHENTICATED');
  let bytes:Uint8Array<ArrayBuffer>;
  let decodedSignature:Uint8Array<ArrayBuffer>;
  try{
    decodedSignature=Uint8Array.from(atob(signature),character=>character.charCodeAt(0));
    bytes=await readBoundedBody(request,MAX_WEBHOOK_BYTES);
  }catch{throw new DatabaseError('UNAUTHENTICATED');}
  let valid:boolean;
  try{
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(channelSecret),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    // Web Crypto does the MAC verification; never compare signatures as strings.
    valid=await crypto.subtle.verify('HMAC',key,decodedSignature,bytes);
  }catch{throw new DatabaseError('UNAVAILABLE');}
  if(!valid)throw new DatabaseError('UNAUTHENTICATED');
  // No decoding, JSON parsing or event handling is allowed before authentication.
  try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;}
  catch{throw new DatabaseError('UNAUTHENTICATED');}
}
