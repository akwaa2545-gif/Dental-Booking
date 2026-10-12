import {timingSafeEqual} from 'node:crypto';
import {readBoundedBody,safeLog,type RequestLimitDeps} from './security';
import type {Session,ErrorCode} from '../shared/contracts';
import type {AdminManagementStore} from '../shared/admin-management';
import {DatabaseError,type Database} from './db';
import type {SessionStore} from './auth/session';
import type {LineIdentityVerifier,exchangeLineCode} from './auth/line';
import type {OAuthStore} from './auth/oauth-store';
import type {ManualApprovalOptions} from './notifications/manual-approval';
import type {BotInfoOptions} from './notifications/bot-info';
import type {ReadinessOptions} from './notifications/readiness';
import type {NotificationWebhookDeps} from './notifications/webhook';
export interface AppDeps {adminManagement?:AdminManagementStore;requestLimits:RequestLimitDeps;manualApproval?:ManualApprovalOptions;botInfo?:BotInfoOptions;notificationReadiness?:ReadinessOptions;notificationWebhook?:NotificationWebhookDeps;db:Database;sessions:SessionStore;verifier:LineIdentityVerifier;appOrigin:string;now:()=>Date;oauth:OAuthStore;line:{channelId:string;channelSecret?:string;provider:string};exchangeCode?:typeof exchangeLineCode;authDiagnostics?:'synthetic-staging';}
export class AuthUnavailableError extends DatabaseError { constructor(readonly diagnostic:'A10'|'A11'){super('UNAVAILABLE');} }

export const SESSION_COOKIE='__Host-dental_session';
export const OAUTH_COOKIE='__Host-dental_oauth';
export function cookie(request:Request,name:string):string|null{const entries=(request.headers.get('Cookie')??'').split(';').map(v=>v.trim()).filter(v=>v.startsWith(name+'='));if(entries.length!==1)return null;const value=entries[0].slice(name.length+1);return /^[A-Za-z0-9_-]{43}$/.test(value)?value:null;}
export function setCookie(name:string,value:string,maxAge:number):string{return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;}
export function json(value:unknown,status=200):Response{return new Response(status===204?null:JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});}
export function errorResponse(error:unknown,details?:{version?:number;attemptsRemaining?:number}):Response{
 const code=error instanceof DatabaseError?error.code:'UNAVAILABLE';
 const statuses:Record<ErrorCode,number>={VALIDATION:400,UNAUTHENTICATED:401,FORBIDDEN:403,NOT_FOUND:404,FULL:409,INELIGIBLE_DATE:409,INTAKE_CLOSED:409,DUPLICATE:409,VERSION_CONFLICT:409,IDEMPOTENCY_CONFLICT:409,INVALID_TRANSITION:409,CUTOFF_PASSED:409,UNRESOLVED_BOOKINGS:409,RATE_LIMITED:429,UNAVAILABLE:503};
 const diagnostic=error instanceof AuthUnavailableError&&['A10','A11'].includes(error.diagnostic)?error.diagnostic:undefined;
 const correlationId=crypto.randomUUID();safeLog({name:'request_failed',correlationId,code});
 const version=details?.version,attemptsRemaining=details?.attemptsRemaining;
 // Explicit bounded primitives only. SQL diagnostics and matching codes cannot
 // be serialized even if a caller supplies extra properties at runtime.
 return json({error:{code,correlationId,...(diagnostic?{diagnostic}:{}),
  ...(typeof version==='number'&&Number.isInteger(version)&&version>=1&&version<=2147483647?{version}:{}),
  ...(typeof attemptsRemaining==='number'&&Number.isInteger(attemptsRemaining)&&attemptsRemaining>=0&&attemptsRemaining<=5?{attemptsRemaining}:{}),
 }},statuses[code]);
}
export function requireOrigin(request:Request,deps:Pick<AppDeps,'appOrigin'>):void{if(request.headers.get('Origin')!==deps.appOrigin)throw new DatabaseError('FORBIDDEN');}
export async function requireSession(request:Request,deps:AppDeps):Promise<Session>{const token=cookie(request,SESSION_COOKIE);const session=token?await deps.sessions.resolve(token):null;if(!session||!Number.isFinite(Date.parse(session.expiresAt))||Date.parse(session.expiresAt)<=deps.now().getTime())throw new DatabaseError('UNAUTHENTICATED');return session;}
export function requireCsrf(request:Request,session:Session,deps:AppDeps):void{requireOrigin(request,deps);const supplied=new TextEncoder().encode(request.headers.get('X-CSRF-Token')??'');const expected=new TextEncoder().encode(session.csrfToken);if(!expected.length||supplied.length!==expected.length||!timingSafeEqual(supplied,expected))throw new DatabaseError('FORBIDDEN');}
export async function requireAdmin(session:Session,db:Database):Promise<void>{if(!await db.isAdmin(session.accountId))throw new DatabaseError('FORBIDDEN');}
export async function readJson(request:Request):Promise<unknown>{
 if(request.headers.get('Content-Type')?.split(';')[0].trim()!=='application/json')throw new DatabaseError('VALIDATION');
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await readBoundedBody(request)));}catch{throw new DatabaseError('VALIDATION');}
}
