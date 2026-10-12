import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile, rm} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath,URLSearchParams} from 'node:url';
import {build} from 'esbuild';
import {Miniflare, Log, LogLevel, convertV4MiniflareOptions} from 'miniflare';

// Exercise the real verifier under workerd fetch semantics. Every outbound call is intercepted.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await mkdir(join(root,'artifacts'),{recursive:true});
await rm(join(root,'artifacts/line-runtime-check.json'),{force:true});
const temporary=await mkdtemp(join(root,'artifacts/line-runtime-'));
const entry=join(temporary,'entry.ts'),bundle=join(temporary,'entry.js');
const source=join(root,'src/worker/auth/line.ts');
await writeFile(entry,`import {createLineVerifier,exchangeLineCode} from ${JSON.stringify(source)};
export default {async fetch(request){try{
 if(new URL(request.url).pathname==='/exchange'){
  const token=await exchangeLineCode({channelId:'123456',channelSecret:'synthetic-secret',redirectUri:'https://synthetic.example/callback',code:'synthetic-code',codeVerifier:'v'.repeat(43)});
  return Response.json({ok:token==='synthetic-returned-token'});
 }
 const identity=await createLineVerifier({channelId:'123456',provider:'line:synthetic',now:()=>new Date('2026-10-08T00:00:00Z')}).verify('synthetic-invalid-for-real-provider');
 return Response.json({ok:identity.provider==='line:synthetic'&&identity.subject==='synthetic-user'});
}catch(error){return Response.json({code:error.code??'UNAVAILABLE'},{status:error.code==='UNAUTHENTICATED'?401:503});}}};`);
let worker;
let mode='success';
let calls=[];
let checks=0;
try{
 await build({entryPoints:[entry],outfile:bundle,bundle:true,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
 const options=convertV4MiniflareOptions({name:'synthetic-line-runtime-check',modules:true,scriptPath:bundle,
  compatibilityDate:'2026-10-07',compatibilityFlags:['nodejs_compat'],cf:false,log:new Log(LogLevel.ERROR),
  outboundService:async request=>{
   const url=new URL(request.url);calls.push(url.href);
   assert.equal(url.origin,'https://api.line.me','No redirect target may receive the token or secret');
   assert.equal(request.method,'POST');
   assert.match(request.headers.get('Content-Type'),/^application\/x-www-form-urlencoded/);
   const form=new URLSearchParams(await request.text());assert.equal(form.get('client_id'),'123456');
   if(mode==='redirect')return new globalThis.Response(null,{status:302,headers:{Location:'https://redirect-target.invalid/'}});
   if(mode==='invalid')return globalThis.Response.json({error:'invalid_request'},{status:400});
   if(url.pathname==='/oauth2/v2.1/token'){
    assert.equal(form.get('client_secret'),'synthetic-secret');return globalThis.Response.json({id_token:'synthetic-returned-token'});
   }
   assert.equal(url.pathname,'/oauth2/v2.1/verify');assert.equal(form.get('id_token'),'synthetic-invalid-for-real-provider');
   return globalThis.Response.json({iss:'https://access.line.me',aud:mode==='wrong-audience'?'wrong':'123456',sub:'synthetic-user',exp:1791421200});
  }});
 worker=new Miniflare({...options,telemetry:{enabled:false}});await worker.ready;
 for(const test of [
  {mode:'success',path:'/verify',status:200},
  {mode:'redirect',path:'/verify',status:503},
  {mode:'invalid',path:'/verify',status:401},
  {mode:'wrong-audience',path:'/verify',status:401},
  {mode:'success',path:'/exchange',status:200},
  {mode:'redirect',path:'/exchange',status:503},
 ]){
  mode=test.mode;calls=[];
  const response=await worker.dispatchFetch('https://synthetic.example'+test.path);
  assert.equal(response.status,test.status,`${test.path} ${mode} must reach the intercepted provider with supported fetch options`);
  assert.equal(calls.length,1,'Exactly one intercepted provider request; redirects must never be followed');
  assert.equal(calls[0],`https://api.line.me/oauth2/v2.1/${test.path==='/exchange'?'token':'verify'}`);
  if(response.ok)assert.equal((await response.json()).ok,true);
  checks++;
 }
 const report={passed:true,checks,runtime:'actual local workerd',realProviderRequests:0,realTokensUsed:false,redirectsFollowed:0};
 await writeFile(join(root,'artifacts/line-runtime-check.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
}finally{if(worker)await worker.dispose();await rm(temporary,{recursive:true,force:true});}
