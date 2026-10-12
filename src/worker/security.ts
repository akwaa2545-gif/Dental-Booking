import {isIP} from 'node:net';
import type {ErrorCode,Session} from '../shared/contracts';
import {DatabaseError,type QueryPort} from './db';

export const MAX_BODY_BYTES=16*1024;
export type RequestLimitScope='login'|'mutation';
export interface RequestLimitStore {consume(scope:RequestLimitScope,keyHash:string):Promise<boolean>}
export interface RequestLimitDeps {store:RequestLimitStore;keySecret:string|undefined}
const loginPaths=new Set(['/api/auth/liff','/api/auth/line/start','/api/auth/line/callback']);
const readMethods=new Set(['GET','HEAD','OPTIONS']);

/** Every decision is persisted. Never replace this with an isolate-local cache. */
export function createRequestLimitStore(port:QueryPort):RequestLimitStore {
 return {async consume(scope,keyHash){
  try{
   const {rows}=await port.query('select dental.consume_request_limit($1::text, $2::text) as result',[scope,keyHash]);
   if(rows.length!==1||typeof rows[0].result!=='boolean')throw new Error();
   return rows[0].result;
  }catch{throw new DatabaseError('UNAVAILABLE');}
 }};
}
function checkLength(request:Request,maxBytes=MAX_BODY_BYTES):void {
 const declared=request.headers.get('Content-Length');
 if(declared!==null&&(!/^\d+$/.test(declared)||!Number.isSafeInteger(Number(declared))||Number(declared)>maxBytes))throw new DatabaseError('VALIDATION');
}
/** Bounded streaming reader. Only trusted server code may choose a byte limit. */
export async function readBoundedBody(request:Request,maxBytes=MAX_BODY_BYTES):Promise<Uint8Array<ArrayBuffer>> {
 checkLength(request,maxBytes);
 const reader=request.body?.getReader();if(!reader)throw new DatabaseError('VALIDATION');
 const chunks:Uint8Array[]=[];let length=0;
 try{
  for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;
   if(length>maxBytes){await reader.cancel();throw new DatabaseError('VALIDATION');}chunks.push(value);
  }
 }catch{throw new DatabaseError('VALIDATION');}finally{reader.releaseLock();}
 const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
}
async function keyHash(scope:RequestLimitScope,identity:string,secret:string|undefined):Promise<string>{
 if(typeof secret!=='string'||new TextEncoder().encode(secret).byteLength<32||secret.length>1024)throw new DatabaseError('UNAVAILABLE');
 const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const mac=await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(`toothtalk:request-limit:v1:${scope}:${identity}`));
 return Array.from(new Uint8Array(mac),byte=>byte.toString(16).padStart(2,'0')).join('');
}
/** CF-Connecting-IP is trusted only on the deployed Cloudflare ingress. Local
 * runners must supply a synthetic address. Never trust X-Forwarded-For. */
function connectingIp(request:Request):string {
 const address=request.headers.get('CF-Connecting-IP');
 if(!address||!isIP(address))throw new DatabaseError('UNAVAILABLE');
 return isIP(address)===6?new URL(`http://[${address}]/`).hostname:address;
}
export async function enforceRequestLimits(request:Request,session:Session|null,deps:RequestLimitDeps):Promise<void>{
 checkLength(request);
 const path=new URL(request.url).pathname;
 let scope:RequestLimitScope;let identity:string;
 if(!session&&loginPaths.has(path)){scope='login';identity=connectingIp(request);}
 else if(session&&!readMethods.has(request.method)){scope='mutation';identity=session.accountId;}
 else return;
 try{
  if(!await deps.store.consume(scope,await keyHash(scope,identity,deps.keySecret)))throw new DatabaseError('RATE_LIMITED');
 }catch(error){if(error instanceof DatabaseError&&error.code==='RATE_LIMITED')throw error;throw new DatabaseError('UNAVAILABLE');}
}

// The installed LINE SDK is bundled into same-origin JS; no remote script,
// inline-script, eval, tracker or patient-data origin is authorized by this CSP.
const csp="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://api.line.me https://access.line.me https://liff.line.me; frame-src https://access.line.me https://liff.line.me; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self' https://access.line.me";
export function secureResponse(response:Response):Response {
 response.headers.set('X-Content-Type-Options','nosniff');
 response.headers.set('Referrer-Policy','no-referrer');
 response.headers.set('Content-Security-Policy',csp);
 response.headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
 response.headers.set('X-Frame-Options','DENY');
 return response;
}
const logNames=new Set(['request_failed']);
const errorCodes=new Set<ErrorCode>(['VALIDATION','UNAUTHENTICATED','FORBIDDEN','NOT_FOUND','FULL','INELIGIBLE_DATE','INTAKE_CLOSED','DUPLICATE','VERSION_CONFLICT','IDEMPOTENCY_CONFLICT','INVALID_TRANSITION','CUTOFF_PASSED','UNRESOLVED_BOOKINGS','RATE_LIMITED','UNAVAILABLE']);
/** Project explicit primitives only; no error, URL, headers, identity or payload. */
export function safeLog(event:{name:string;correlationId:string;code?:ErrorCode}):void {
 if(!logNames.has(event.name)||! /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(event.correlationId))return;
 console.info(JSON.stringify({name:event.name,correlationId:event.correlationId,...(event.code&&errorCodes.has(event.code)?{code:event.code}:{})}));
}
