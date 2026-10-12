import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
// The real transport runs in workerd; every outbound request is intercepted.
// No actual LINE token, account, network request, database or Worker deployment.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await mkdir(join(root,'artifacts'),{recursive:true});
const reportPath=join(root,'artifacts/notification-runtime-check.json');
await rm(reportPath,{force:true});
const temporary=await mkdtemp(join(root,'artifacts/notification-runtime-'));
const entry=join(temporary,'entry.ts'),bundle=join(temporary,'entry.js');
const retryKey='11111111-1111-4111-8111-111111111111',recipient='U'+'a'.repeat(32);
await writeFile(entry,`import {createLineTransport} from ${JSON.stringify(join(root,'src/worker/notifications/line.ts'))};
export default {async fetch(request){
 const result=await createLineTransport({enabled:new URL(request.url).pathname!=='/disabled',token:'synthetic-invalid-for-real-provider'}).send(${JSON.stringify(recipient)},{messages:[{type:'text',text:'Synthetic fixture'}]},${JSON.stringify(retryKey)});
 return Response.json(result);
}};`);
let worker,status=200,calls=0,checks=0;
try{
 await build({entryPoints:[entry],outfile:bundle,bundle:true,format:'esm',platform:'browser',target:'es2022',logLevel:'silent'});
 const options=convertV4MiniflareOptions({name:'synthetic-notification-runtime-check',modules:true,scriptPath:bundle,compatibilityDate:'2026-10-07',compatibilityFlags:['nodejs_compat'],cf:false,log:new Log(LogLevel.ERROR),outboundService:async request=>{
  calls++;
  assert.equal(request.url,'https://api.line.me/v2/bot/message/push','No redirect target may receive recipient or bearer token');
  assert.equal(request.method,'POST');assert.equal(request.headers.get('authorization'),'Bearer synthetic-invalid-for-real-provider');assert.equal(request.headers.get('x-line-retry-key'),retryKey);
  assert.deepEqual(await request.json(),{messages:[{type:'text',text:'Synthetic fixture'}],to:recipient});
  const headers=status>=300&&status<400?{Location:'https://redirect-target.invalid/'}:status===409?{'x-line-accepted-request-id':retryKey}:{};
  return new globalThis.Response(null,{status,headers});
 }});
 worker=new Miniflare({...options,telemetry:{enabled:false}});await worker.ready;
 for(const test of [
  {status:200,result:{kind:'accepted'}},
  {status:409,result:{kind:'accepted',requestId:retryKey}},
  ...[301,302,303,307,308].map(status=>({status,result:{kind:'permanent',category:'invalid_request'}})),
  {status:500,result:{kind:'retryable',category:'server_error'}},
  {status:429,result:{kind:'permanent',category:'rate_limited'}},
 ]){
  status=test.status;calls=0;
  const response=await worker.dispatchFetch('https://synthetic.example/send');
  assert.deepEqual(await response.json(),test.result,`HTTP${status} under actual workerd`);
  assert.equal(calls,1,'Exactly one intercepted request; never follow redirects');checks++;
 }
 calls=0;
 assert.deepEqual(await(await worker.dispatchFetch('https://synthetic.example/disabled')).json(),{kind:'permanent',category:'forbidden'});
 assert.equal(calls,0);checks++;
 const report={passed:true,checks,runtime:'actual local workerd',realProviderRequests:0,realTokensUsed:false,redirectsFollowed:0};
 await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{if(worker)await worker.dispose();await rm(temporary,{recursive:true,force:true});}
