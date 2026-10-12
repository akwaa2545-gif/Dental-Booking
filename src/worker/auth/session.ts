import type {Session} from '../../shared/contracts';
import {z} from 'zod';
import {DatabaseError,type QueryPort} from '../db';

export type VerifiedIdentity={provider:string;subject:string;expiresAt:string};
export interface SessionStore{
 create(identity:VerifiedIdentity,ttlSeconds?:number):Promise<{token:string;session:Session}>;
 resolve(token:string):Promise<Session|null>;
 revoke(token:string):Promise<void>;
}
const opaqueToken=/^[A-Za-z0-9_-]{43}$/;
const storedSession=z.object({accountId:z.uuid(),csrfHash:z.string().regex(/^[0-9a-f]{64}$/),expiresAt:z.iso.datetime({offset:true}),isAdmin:z.boolean()}).strict();
export const DEFAULT_SESSION_TTL_SECONDS=7200;

/** 256 random bits; the plaintext is returned to the cookie layer only. */
export function randomToken():string{
 const bytes=crypto.getRandomValues(new Uint8Array(32));
 return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}
export async function hashToken(value:string):Promise<string>{
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
 return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}
/** Domain separation keeps the public CSRF token distinct from the session's
 * DB lookup hash. A DB leak of either stored hash cannot authenticate a client. */
async function csrfFor(token:string){return hashToken(`dental:csrf:v1:${token}`);}

export function createSessionStore(port:QueryPort,now:()=>Date=()=>new Date()):SessionStore{
 async function query(text:string,values:unknown[]):Promise<unknown>{
  try{
   const{rows}=await port.query(text,values);
   if(rows.length!==1||rows[0].result===undefined)throw new Error();
   return rows[0].result;
  }catch{throw new DatabaseError('UNAVAILABLE');}
 }
 async function decode(value:unknown,token:string):Promise<Session|null>{
  if(value===null)return null;
  const parsed=storedSession.safeParse(value);
  if(!parsed.success)throw new DatabaseError('UNAVAILABLE');
  const row=parsed.data,csrfToken=await csrfFor(token);
  if(Date.parse(row.expiresAt)<=now().getTime()||await hashToken(csrfToken)!==row.csrfHash)return null;
  return{accountId:row.accountId,expiresAt:row.expiresAt,isAdmin:row.isAdmin,csrfToken};
 }
 return{
  async create(identity,ttlSeconds=DEFAULT_SESSION_TTL_SECONDS){
   if(!Number.isSafeInteger(ttlSeconds)||ttlSeconds<=0)throw new DatabaseError('VALIDATION');
   const current=now().getTime(),identityExpiry=Date.parse(identity.expiresAt);
   if(!/^[A-Za-z0-9][A-Za-z0-9:._-]{0,119}$/.test(identity.provider)
    ||identity.subject.length<1||identity.subject.length>255||Array.from(identity.subject).some(char=>char.charCodeAt(0)<32||char.charCodeAt(0)===127)
    ||!Number.isFinite(current)||!Number.isFinite(identityExpiry)||identityExpiry<=current)throw new DatabaseError('UNAUTHENTICATED');
   const token=randomToken(),csrfToken=await csrfFor(token);
   const expiresAt=new Date(Math.min(identityExpiry,current+Math.min(ttlSeconds,DEFAULT_SESSION_TTL_SECONDS)*1000)).toISOString();
   const session=await decode(await query('select dental.create_session($1::text, $2::text, $3::text, $4::text, $5::timestamptz) as result',
    [identity.provider,identity.subject,await hashToken(token),await hashToken(csrfToken),expiresAt]),token);
   if(!session||Date.parse(session.expiresAt)>Date.parse(expiresAt))throw new DatabaseError('UNAVAILABLE');
   return{token,session};
  },
  async resolve(token){
   if(!opaqueToken.test(token))return null;
   return decode(await query('select dental.resolve_session($1::text) as result',[await hashToken(token)]),token);
  },
  async revoke(token){
   if(!opaqueToken.test(token))return;
   await query('select dental.revoke_session($1::text) as result',[await hashToken(token)]);
  },
 };
}
