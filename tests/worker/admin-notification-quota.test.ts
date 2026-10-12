import {describe,it,expect,vi,afterEach} from 'vitest';
import {readAdminQuota} from '../../src/worker/admin-notifications/quota';
const destination=`U${'a'.repeat(32)}`;
const makeFetcher=(quota:unknown={type:'limited',value:300},usage:unknown={totalUsage:7},bot:unknown={userId:destination,basicId:'@synthetic'})=>{
 const urls:string[]=[];
 const fetcher:typeof fetch=async(input,init)=>{const url=String(input);urls.push(url);expect(init?.method).toBe('GET');expect(init?.redirect).toBe('manual');return Response.json(url.endsWith('/info')?bot:url.endsWith('/consumption')?usage:quota);};
 return {fetcher,urls};
};
afterEach(()=>vi.useRealTimers());
describe('admin free-only quota observation',()=>{
 it('reads only fixed identity/quota/consumption endpoints and stamps a bounded observation',async()=>{
  vi.useFakeTimers();vi.setSystemTime('2026-10-10T05:00:00Z');const {fetcher,urls}=makeFetcher();
  expect(await readAdminQuota({token:'synthetic-token',expectedBasicId:'@synthetic',destination,fetcher})).toEqual({type:'limited',value:300,totalUsage:7,observedAt:'2026-10-10T05:00:00.000Z'});
  expect(urls).toEqual(['https://api.line.me/v2/bot/info','https://api.line.me/v2/bot/message/quota','https://api.line.me/v2/bot/message/quota/consumption']);
 });
 it.each([{type:'unlimited'},{type:'limited',value:-1},{type:'limited',value:1.5},{type:'limited',value:'300'},{type:'limited',value:Infinity},null])('fails closed on unknown/invalid quota %j',async quota=>{
  const {fetcher}=makeFetcher(quota);expect(await readAdminQuota({token:'synthetic-token',expectedBasicId:'@synthetic',destination,fetcher})).toBeNull();
 });
 it.each([{totalUsage:-1},{totalUsage:1.2},{totalUsage:'1'},null,{}])('fails closed on invalid consumption %j',async usage=>{
  const {fetcher}=makeFetcher(undefined,usage);expect(await readAdminQuota({token:'synthetic-token',expectedBasicId:'@synthetic',destination,fetcher})).toBeNull();
 });
 it.each([{userId:`U${'b'.repeat(32)}`,basicId:'@synthetic'},{userId:destination,basicId:'@other'}])('rejects an unexpected OA identity before reading quota',async bot=>{
  const {fetcher,urls}=makeFetcher(undefined,undefined,bot);expect(await readAdminQuota({token:'synthetic-token',expectedBasicId:'@synthetic',destination,fetcher})).toBeNull();expect(urls).toHaveLength(1);
 });
 it('fails closed without a credential or valid expected destination and never requests',async()=>{
  const {fetcher,urls}=makeFetcher();expect(await readAdminQuota({token:'',expectedBasicId:'@synthetic',destination,fetcher})).toBeNull();expect(await readAdminQuota({token:'synthetic-token',expectedBasicId:'@synthetic',destination:'invalid',fetcher})).toBeNull();expect(urls).toEqual([]);
 });
 it.each([undefined,null,123])('fails closed on a malformed credential %s',async token=>{
  const {fetcher,urls}=makeFetcher();expect(await readAdminQuota({token:token as unknown as string,expectedBasicId:'@synthetic',destination,fetcher})).toBeNull();expect(urls).toEqual([]);
 });
 it('returns no provider diagnostic on a failed read',async()=>{
  const fetcher:typeof fetch=async()=>{throw new Error('synthetic sensitive provider response');};expect(await readAdminQuota({token:'synthetic-token',expectedBasicId:'@synthetic',destination,fetcher})).toBeNull();
 });
});
