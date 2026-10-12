// @vitest-environment node
import {it,expect,vi} from 'vitest';
import {requireAdmin,requireCsrf} from '../../src/worker/http';
import {createDatabase} from '../../src/worker/db';
import type {AppDeps} from '../../src/worker/http';
const session={accountId:'10000000-0000-4000-8000-000000000001',csrfToken:'synthetic-csrf',expiresAt:'2099-01-01T00:00:00Z',isAdmin:true};
it('uses live grant for every admin action despite cached admin claim',async()=>{let admin=true;const query=vi.fn(async()=>({rows:[{result:admin}]}));const db=createDatabase({query});await expect(requireAdmin(session,db)).resolves.toBeUndefined();admin=false;await expect(requireAdmin(session,db)).rejects.toMatchObject({code:'FORBIDDEN'});expect(query).toHaveBeenCalledTimes(2);expect(query).toHaveBeenLastCalledWith('select dental.is_admin($1::uuid) as result',[session.accountId]);});
it('OA manager without explicit app grant stays nonadmin',async()=>{await expect(requireAdmin(session,createDatabase({query:async()=>({rows:[{result:false}]})}))).rejects.toMatchObject({code:'FORBIDDEN'});});
it.each([null,{},'true',1])('malformed admin result never grants access %j',async result=>{await expect(requireAdmin(session,createDatabase({query:async()=>({rows:[{result}]})}))).rejects.toBeDefined();});
it.each<Record<string,string>>([{}, {'Origin':'https://evil.example','X-CSRF-Token':'synthetic-csrf'}, {'Origin':'https://dental.example','X-CSRF-Token':'wrong'}])('mutation csrf/origin fails closed %j',headers=>{expect(()=>requireCsrf(new Request('https://dental.example/api/appointments',{method:'POST',headers}),session,{appOrigin:'https://dental.example'} as AppDeps)).toThrow('FORBIDDEN');});
