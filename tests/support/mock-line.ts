import {makeApp} from '../../src/worker/index';
import {vi} from 'vitest';
import {createDatabase} from '../../src/worker/db';
import type {OAuthPending} from '../../src/worker/auth/oauth-store';
import type {AppDeps} from '../../src/worker/http';
/** Synthetic server-selected fixtures only; never imported by production. */
export const origin='https://dental.example';
export const session={accountId:'10000000-0000-4000-8000-000000000001',csrfToken:'csrf',expiresAt:'2026-10-09T00:00:00Z',isAdmin:false};
export function fixture(){
 const saved=new Map<string,OAuthPending>();
 const activeSessions=new Map([['o'.repeat(43),session]]);
 const deps:AppDeps={requestLimits:{store:{consume:vi.fn(async()=>true)},keySecret:"synthetic-rate-limit-key-with-at-least-32-bytes"},appOrigin:origin,now:()=>new Date('2026-10-08T00:00:00Z'),db:{...createDatabase({query:async()=>{throw new Error('Unexpected database call in synthetic fixture');}}),isAdmin:vi.fn(async()=>false),listAppointments:vi.fn(async()=>[])},sessions:{create:vi.fn(async()=>{activeSessions.set('n'.repeat(43),session);return{token:'n'.repeat(43),session};}),resolve:vi.fn(async(t:string)=>activeSessions.get(t)??null),revoke:vi.fn(async(t:string)=>{activeSessions.delete(t);})},verifier:{verify:vi.fn(async()=>({provider:'line:synthetic',subject:'verified',expiresAt:'2026-10-09T00:00:00Z'}))},oauth:{save:vi.fn(async(p:OAuthPending)=>{saved.set(p.stateHash,p);}),consume:vi.fn(async(s:string,b:string)=>{const p=saved.get(s);if(!p||p.bindingHash!==b)return null;saved.delete(s);return p;})},line:{channelId:'123',channelSecret:'synthetic-secret',provider:'line:synthetic'},exchangeCode:vi.fn(async()=> 'verified-token')};
 return{deps,app:makeApp(deps)};
}
export function req(path:string,body?:unknown,headers:Record<string,string>={}){return new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{'CF-Connecting-IP':'203.0.113.24',...(body===undefined?{}:{Origin:origin,'Content-Type':'application/json'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});}
