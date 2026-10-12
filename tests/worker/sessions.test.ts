// @vitest-environment node
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {createSessionStore,hashToken,randomToken} from '../../src/worker/auth/session';
import {createOAuthStore,type OAuthPending} from '../../src/worker/auth/oauth-store';
import {DatabaseError,type QueryPort} from '../../src/worker/db';
import {cleanupSessionFixture} from '../support/session-fixture-cleanup';
import {waitForLockWaiters,type LockObservationPort} from '../support/wait-for-lock-waiters';

const accountId='11111111-1111-4111-8111-111111111111';
const now=()=>new Date('2026-10-08T00:00:00.000Z');
const identity={provider:'line:synthetic-provider',subject:'synthetic-subject',expiresAt:'2026-10-08T05:00:00.000Z'};
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const token='A'.repeat(43);
const csrfToken=sha(`dental:csrf:v1:${token}`);
const stored={accountId,csrfHash:sha(csrfToken),expiresAt:'2026-10-08T02:00:00.000Z',isAdmin:false};
function recording(answer:unknown|((values:unknown[])=>unknown)){
 const calls:{text:string;values:unknown[]}[]=[];
 const port:QueryPort={async query(text,values){calls.push({text,values});return{rows:[{result:typeof answer==='function'?answer(values):answer}]};}};
 return{port,calls};
}
function creates(){return recording((values:unknown[])=>({...stored,csrfHash:values[3],expiresAt:values[4]}));}

describe('private opaque session store',()=>{
 it('generates independent 256-bit tokens and standard SHA-256 hashes',async()=>{
  const first=randomToken(),second=randomToken();
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(Buffer.from(first,'base64url')).toHaveLength(32);
  expect(first).not.toBe(second);expect(await hashToken('abc')).toBe(sha('abc'));
 });
 it('persists only token and CSRF hashes with a default two-hour expiry',async()=>{
  const{port,calls}=creates();const result=await createSessionStore(port,now).create(identity);
  expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(result.session).toEqual({accountId,csrfToken:sha(`dental:csrf:v1:${result.token}`),expiresAt:stored.expiresAt,isAdmin:false});
  expect(calls).toEqual([{text:'select dental.create_session($1::text, $2::text, $3::text, $4::text, $5::timestamptz) as result',values:[identity.provider,identity.subject,sha(result.token),sha(result.session.csrfToken),stored.expiresAt]}]);
  expect(JSON.stringify(calls)).not.toContain(result.token);expect(JSON.stringify(calls)).not.toContain(result.session.csrfToken);
 });
 it('bounds the requested lifetime by the verified identity expiry',async()=>{
  const{port,calls}=creates();const expiresAt='2026-10-08T00:30:00.000Z';
  expect((await createSessionStore(port,now).create({...identity,expiresAt},7200)).session.expiresAt).toBe(expiresAt);
  expect(calls[0].values[4]).toBe(expiresAt);
 });
 it('caps even an explicit longer lifetime at two hours',async()=>{
  const{port}=creates();expect((await createSessionStore(port,now).create(identity,86400)).session.expiresAt).toBe(stored.expiresAt);
 });
 it.each([0,-1,1.5,Infinity,NaN])('rejects invalid session lifetime %s before persistence',async ttl=>{
  const{port,calls}=creates();await expect(createSessionStore(port,now).create(identity,ttl)).rejects.toEqual(new DatabaseError('VALIDATION'));expect(calls).toHaveLength(0);
 });
 it.each([
  {...identity,expiresAt:'2026-10-08T00:00:00.000Z'}, {...identity,expiresAt:'not-a-date'},
  {...identity,provider:''},{...identity,provider:'x'.repeat(121)},{...identity,subject:''},{...identity,subject:'x'.repeat(256)},
 ])('rejects invalid or expired verified identities before persistence',async bad=>{
  const{port,calls}=creates();await expect(createSessionStore(port,now).create(bad)).rejects.toMatchObject({code:'UNAUTHENTICATED'});expect(calls).toHaveLength(0);
 });
 it('resolves through a token hash and returns a session-bound CSRF token',async()=>{
  const{port,calls}=recording(stored);expect(await createSessionStore(port,now).resolve(token)).toEqual({accountId,csrfToken,expiresAt:stored.expiresAt,isAdmin:false});
  expect(calls).toEqual([{text:'select dental.resolve_session($1::text) as result',values:[sha(token)]}]);
 });
 it('does not cache administrative authority between resolves',async()=>{
  let isAdmin=true;const{port}=recording(()=>({...stored,isAdmin}));const store=createSessionStore(port,now);
  expect((await store.resolve(token))?.isAdmin).toBe(true);isAdmin=false;expect((await store.resolve(token))?.isAdmin).toBe(false);
 });
 it.each(['', 'forged', 'A'.repeat(42),'A'.repeat(44),' '.repeat(43)])('rejects malformed opaque token before persistence',async bad=>{
  const{port,calls}=recording(stored);expect(await createSessionStore(port,now).resolve(bad)).toBeNull();await createSessionStore(port,now).revoke(bad);expect(calls).toHaveLength(0);
 });
 it.each([null,{...stored,expiresAt:'2026-10-08T00:00:00.000Z'},{...stored,csrfHash:'0'.repeat(64)}])('fails closed for absent, expired, or mismatched sessions',async row=>{
  const{port}=recording(row);expect(await createSessionStore(port,now).resolve(token)).toBeNull();
 });
 it.each([{...stored,isAdmin:'true'},{...stored,accountId:'forged'},{...stored,expiresAt:'not-a-date'},{...stored,csrfHash:undefined}])('rejects malformed database session output',async row=>{
  const{port}=recording(row);await expect(createSessionStore(port,now).resolve(token)).rejects.toEqual(new DatabaseError('UNAVAILABLE'));
 });
 it('revokes only by hash without exposing the credential',async()=>{
  const{port,calls}=recording(null);await createSessionStore(port,now).revoke(token);
  expect(calls).toEqual([{text:'select dental.revoke_session($1::text) as result',values:[sha(token)]}]);
 });
 it('fails closed and redacts database transport errors for every session operation',async()=>{
  const port:QueryPort={async query(){throw new Error('PRIVATE_TOKEN_CANARY');}};const store=createSessionStore(port,now);
  for(const operation of[()=>store.create(identity),()=>store.resolve(token),()=>store.revoke(token)])await expect(operation()).rejects.toEqual(new DatabaseError('UNAVAILABLE'));
 });
 it('fails closed on a missing result row',async()=>{
  const port:QueryPort={async query(){return{rows:[]};}};await expect(createSessionStore(port,now).resolve(token)).rejects.toEqual(new DatabaseError('UNAVAILABLE'));
 });
});

const pending:OAuthPending={stateHash:sha('synthetic-state'),bindingHash:sha('synthetic-binding'),nonce:'N'.repeat(43),codeVerifier:'V'.repeat(43),returnPath:'/appointments',expiresAt:'2026-10-08T00:10:00.000Z'};
describe('durable OAuth pending store',()=>{
 it('stores browser-binding and state hashes through a parameterized private call',async()=>{
  const{port,calls}=recording(null);await createOAuthStore(port).save(pending);
  expect(calls).toEqual([{text:'select dental.save_oauth_pending($1::text, $2::text, $3::text, $4::text, $5::text, $6::timestamptz) as result',values:[pending.stateHash,pending.bindingHash,pending.nonce,pending.codeVerifier,pending.returnPath,pending.expiresAt]}]);
 });
 it('consumes state and browser binding atomically through one durable call',async()=>{
  const{port,calls}=recording(pending);expect(await createOAuthStore(port).consume(pending.stateHash,pending.bindingHash)).toEqual(pending);
  expect(calls).toEqual([{text:'select dental.consume_oauth_pending($1::text, $2::text) as result',values:[pending.stateHash,pending.bindingHash]}]);
 });
 it('preserves null for expired, replayed, or wrong-binding state',async()=>{
  const{port}=recording(null);expect(await createOAuthStore(port).consume(pending.stateHash,pending.bindingHash)).toBeNull();
 });
 it.each(['https://evil.example','//evil.example','/\\evil.example','/appointments\nLocation: x','/%2f%2fevil.example'])('rejects unsafe return path %s before persistence',async returnPath=>{
  const{port,calls}=recording(null);await expect(createOAuthStore(port).save({...pending,returnPath})).rejects.toEqual(new DatabaseError('VALIDATION'));expect(calls).toHaveLength(0);
 });
 it('rejects raw state in place of hashes',async()=>{
  const{port,calls}=recording(null);await expect(createOAuthStore(port).save({...pending,stateHash:'raw-state'})).rejects.toEqual(new DatabaseError('VALIDATION'));
  expect(await createOAuthStore(port).consume('raw-state',pending.bindingHash)).toBeNull();expect(calls).toHaveLength(0);
 });
 it('rejects malformed or substituted consumed records',async()=>{
  for(const row of[{...pending,codeVerifier:'short'},{...pending,stateHash:sha('another-state')},{...pending,bindingHash:sha('another-browser')},{...pending,returnPath:'//evil.example'}]){
   const{port}=recording(row);await expect(createOAuthStore(port).consume(pending.stateHash,pending.bindingHash)).rejects.toEqual(new DatabaseError('UNAVAILABLE'));
  }
 });
 it('redacts persistence failures for both pending operations',async()=>{
  const port:QueryPort={async query(){throw new Error('PRIVATE_VERIFIER_CANARY');}};const store=createOAuthStore(port);
  await expect(store.save(pending)).rejects.toEqual(new DatabaseError('UNAVAILABLE'));await expect(store.consume(pending.stateHash,pending.bindingHash)).rejects.toEqual(new DatabaseError('UNAVAILABLE'));
 });
});

describe('session migration source safety contract (not a database execution)',()=>{
 it('fails closed for stale authorization snapshots in every live authority lookup',()=>{
  const source=readFileSync('db/migrations/004_sessions.sql','utf8');
  for(const name of ['is_admin','resolve_session','create_session']){
   const body=source.split(`CREATE FUNCTION dental.${name}(`)[1]?.split('$body$;')[0];
   expect(body).toContain("pg_catalog.current_setting('transaction_isolation')<>'read committed'");
   expect(body).toContain("MESSAGE='UNAVAILABLE'");
  }
 });
});

describe('disposable session fixture cleanup',()=>{
 it('always restores the production clock after an earlier cleanup failure',async()=>{
  const events:string[]=[],failure=new Error('synthetic-delete-failure');
  await expect(cleanupSessionFixture([
   async()=>{events.push('rollback');},async()=>{events.push('close-session');throw failure;},async()=>{events.push('delete');},
  ],async()=>{events.push('restore-clock');})).rejects.toMatchObject({errors:[failure]});
  expect(events).toEqual(['rollback','close-session','delete','restore-clock']);
 });
 it('preserves both the row-cleanup failure and clock-restoration failure',async()=>{
  const deletion=new Error('synthetic-delete-failure'),restoration=new Error('synthetic-restore-failure');
  await expect(cleanupSessionFixture([async()=>{throw deletion;}],async()=>{throw restoration;})).rejects.toMatchObject({errors:[deletion,restoration]});
 });
 it('completes every cleanup in order when none fail',async()=>{
  const events:string[]=[];await cleanupSessionFixture([async()=>{events.push('delete');}],async()=>{events.push('restore-clock');});
  expect(events).toEqual(['delete','restore-clock']);
 });
});

describe('PostgreSQL lock observation',()=>{
 it('refreshes a transaction statistics snapshot before every lock-wait poll',async()=>{
  const events:string[]=[];let fresh=false,reads=0;
  const port:LockObservationPort={async query(sql){
   if(sql.includes('pg_stat_clear_snapshot')){events.push('clear');fresh=true;return{rows:[]};}
   if(!fresh)throw new Error('Stale transaction statistics snapshot');
   fresh=false;events.push('read');reads++;
   return{rows:reads===1?[]:[{pid:42,blockers:[84]}]};
  }};
  await waitForLockWaiters(port,[42],84);
  expect(events).toEqual(['clear','read','clear','read']);
 });
});
