import { describe, expect, it } from 'vitest';
import { readConfig } from '../../src/worker/config';

describe('server-only runtime config', () => {
  it('defaults the prototype to explicit mock test modes', () => {
    expect(readConfig({})).toEqual({ mode: 'test', authMode: 'mock', messagingMode: 'mock', appOrigin: 'http://localhost:5173' });
  });
  it.each([{ APP_MODE: 'production', AUTH_MODE: 'mock', MESSAGING_MODE: 'line' }, { APP_MODE: 'production', AUTH_MODE: 'line', MESSAGING_MODE: 'mock' }])('rejects production with any mock adapter', (env) => {
    expect(() => readConfig({ ...env, APP_ORIGIN: 'https://dental.example' })).toThrow(/mock/i);
  });
  it('accepts explicit real production adapters and an HTTPS app origin', () => {
    expect(readConfig({ APP_MODE: 'production', AUTH_MODE: 'line', MESSAGING_MODE: 'line', APP_ORIGIN: 'https://dental.example', LINE_CHANNEL_ID:'123456', LINE_PROVIDER_ID:'synthetic', LINE_CHANNEL_SECRET:'synthetic-secret' })).toEqual({ mode: 'production', authMode: 'line', messagingMode: 'line', appOrigin: 'https://dental.example' });
  });
  it.each([{ APP_MODE: 'unknown' }, { AUTH_MODE: 'unknown' }, { MESSAGING_MODE: 'unknown' }, { APP_ORIGIN: 'invalid' }, { APP_ORIGIN: 'https://dental.example/private' }])('fails closed on malformed configuration %j', (env) => {
    expect(() => readConfig(env)).toThrow();
  });
});

import {readAuthConfig} from '../../src/worker/config';
describe('real identity configuration',()=>{
 const base={APP_ORIGIN:'https://dental.example',LINE_CHANNEL_ID:'123456',LINE_PROVIDER_ID:'synthetic-provider',LINE_CHANNEL_SECRET:'synthetic-secret-value'};
 it('production rejects missing LINE configuration',()=>{expect(()=>readConfig({APP_MODE:'production',AUTH_MODE:'line',MESSAGING_MODE:'line',APP_ORIGIN:base.APP_ORIGIN})).toThrow();});
 it('refuses missing required line settings',()=>{for(const key of Object.keys(base))expect(()=>readAuthConfig({...base,[key]:undefined})).toThrow();});
 it('rejects implicit mock or insecure origin',()=>{expect(()=>readAuthConfig({...base,APP_ORIGIN:'http://dental.example'})).toThrow();expect(()=>readAuthConfig({...base,AUTH_MODE:'mock'})).toThrow();});
 it('returns server-only exact callback settings',()=>{expect(readAuthConfig(base)).toEqual({appOrigin:'https://dental.example',channelId:'123456',provider:'line:synthetic-provider',channelSecret:'synthetic-secret-value'});});
});

it('accepts explicit disabled messaging and LIFF identity without an OAuth secret',()=>{
 expect(readConfig({APP_MODE:'production',AUTH_MODE:'line',MESSAGING_MODE:'disabled',APP_ORIGIN:'https://dental.example',LINE_CHANNEL_ID:'123456',LINE_PROVIDER_ID:'synthetic'})).toEqual({mode:'production',authMode:'line',messagingMode:'disabled',appOrigin:'https://dental.example'});
});
