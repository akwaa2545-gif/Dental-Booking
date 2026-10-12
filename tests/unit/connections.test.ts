import{describe,it,expect}from'vitest';
import{withTwoClients}from'../support/connections';
describe('database harness client cleanup',()=>{
 it('closes first client if second acquisition fails',async()=>{let opens=0,closed=0;await expect(withTwoClients(async()=>{if(opens++)throw new Error('connection failure');return{async end(){closed++;}};},async()=>{})).rejects.toThrow('connection failure');expect(closed).toBe(1);});
 it('attempts both closes if one fails',async()=>{let i=0;const closed:number[]=[];await expect(withTwoClients(async()=>{const n=i++;return{async end(){closed.push(n);if(n===0)throw new Error('close failure');}};},async()=>{})).rejects.toThrow('cleanup');expect(closed).toEqual([0,1]);});
 it('closes both after successful work',async()=>{let closed=0;expect(await withTwoClients(async()=>({async end(){closed++;}}),async()=>42)).toBe(42);expect(closed).toBe(2);});
});
