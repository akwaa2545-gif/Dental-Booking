// @vitest-environment node
import {describe,it,expect,vi} from 'vitest';
import {DatabaseError} from '../../src/worker/db';
import {fixture,req} from '../support/mock-line';

describe('synthetic-staging opaque auth diagnostics',()=>{
 it.each(['verify','create','revoke'] as const)('labels only unavailable %s stage without private error data',async(stage)=>{
  const{app,deps}=fixture();deps.authDiagnostics='synthetic-staging';
  const error=new Error('PRIVATE_TOKEN_IDENTITY_SQL_CANARY');
  if(stage==='verify')vi.mocked(deps.verifier.verify).mockRejectedValue(error);
  else if(stage==='create')vi.mocked(deps.sessions.create).mockRejectedValue(error);
  else vi.mocked(deps.sessions.revoke).mockRejectedValue(error);
  const response=await app.fetch(req('/api/auth/liff',{idToken:'synthetic-token'},stage==='revoke'?{Cookie:'__Host-dental_session='+'o'.repeat(43)}:{}));
  expect(response.status).toBe(503);expect(response.headers.get('Cache-Control')).toBe('no-store');
  const body=await response.json();expect(body.error).toEqual({code:'UNAVAILABLE',correlationId:expect.any(String),diagnostic:stage==='verify'?'A10':'A11'});
  expect(JSON.stringify(body)).not.toMatch(/PRIVATE|synthetic-token|line:/);
 });
 it('keeps invalid-token 401 generic even with diagnostics enabled',async()=>{
  const{app,deps}=fixture();deps.authDiagnostics='synthetic-staging';vi.mocked(deps.verifier.verify).mockRejectedValue(new DatabaseError('UNAUTHENTICATED'));
  const response=await app.fetch(req('/api/auth/liff',{idToken:'synthetic'}));expect(response.status).toBe(401);expect((await response.json()).error).not.toHaveProperty('diagnostic');
 });
 it('does not expose stage tags unless explicitly enabled by server composition',async()=>{
  const{app,deps}=fixture();vi.mocked(deps.sessions.create).mockRejectedValue(new Error('PRIVATE'));
  const response=await app.fetch(req('/api/auth/liff',{idToken:'synthetic'}));expect(response.status).toBe(503);expect((await response.json()).error).not.toHaveProperty('diagnostic');
 });
 it('preserves client validation errors without diagnostic stages',async()=>{
  const{app,deps}=fixture();deps.authDiagnostics='synthetic-staging';
  const response=await app.fetch(req('/api/auth/liff',{idToken:'synthetic',diagnostic:'PRIVATE'}));expect(response.status).toBe(400);expect((await response.json()).error).not.toHaveProperty('diagnostic');expect(deps.verifier.verify).not.toHaveBeenCalled();
 });
});

it('serializes only the fixed diagnostic allowlist',async()=>{
 const {AuthUnavailableError,errorResponse}=await import('../../src/worker/http');
 const error=new AuthUnavailableError('A10');Object.assign(error,{diagnostic:'PRIVATE_FAKE_DIAGNOSTIC'});
 const response=errorResponse(error);expect(response.status).toBe(503);expect(await response.text()).not.toContain('PRIVATE');
});
