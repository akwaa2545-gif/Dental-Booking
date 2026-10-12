import {describe,expect,it} from 'vitest';
// @ts-expect-error JavaScript CLI exports the pure gate evaluator.
import {checkLaunch} from '../../scripts/check-launch.mjs';
import {readConfig} from '../../src/worker/config';
const approved={testReportPassed:true,productionConfigComplete:true,clinicInputsApproved:true,privacyPolicyApproved:true,operationsApproved:true,providerSetupAuthorized:true,publicationAuthorized:true};
describe('launch gates never grant authorization',()=>{
 it('allows only all explicitly satisfied gates',()=>expect(checkLaunch(approved)).toEqual({ready:true,missing:[]}));
 it.each(Object.keys(approved))('blocks when %s is false',key=>expect(checkLaunch({...approved,[key]:false})).toEqual({ready:false,missing:[key]}));
 it.each([undefined,null,{},true,'true',[]])('fails closed for incomplete input %j',input=>expect(checkLaunch(input).ready).toBe(false));
 it.each([undefined,null,1,'true',{},[]])('requires literal true for each gate %j',value=>expect(checkLaunch({...approved,publicationAuthorized:value})).toEqual({ready:false,missing:['publicationAuthorized']}));
 it('ignores inherited approval properties',()=>expect(checkLaunch(Object.create(approved)).ready).toBe(false));
 it('returns every missing gate',()=>expect(checkLaunch({...approved,testReportPassed:false,publicationAuthorized:false}).missing).toEqual(['testReportPassed','publicationAuthorized']));
 it.each([{AUTH_MODE:'mock',MESSAGING_MODE:'line'},{AUTH_MODE:'line',MESSAGING_MODE:'mock'}])('rejects production mocks %j',modes=>expect(()=>readConfig({APP_MODE:'production',APP_ORIGIN:'https://synthetic.example',...modes})).toThrow(/mock/i));
});
