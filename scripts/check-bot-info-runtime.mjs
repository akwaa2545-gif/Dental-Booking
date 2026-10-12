import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await mkdir(join(root,'artifacts'),{recursive:true});
const temporary=await mkdtemp(join(root,'artifacts/bot-info-runtime-'));
const reportPath=join(root,'artifacts/bot-info-runtime-check.json');
await rm(reportPath,{force:true});
await writeFile(join(temporary,'entry.ts'),`import {createRuntime} from ${JSON.stringify(join(root,'src/worker/runtime.ts'))};
import {hashToken} from ${JSON.stringify(join(root,'src/worker/auth/session.ts'))};
export default {async fetch(request){
 const scenario=request.headers.get('X-Synthetic-Scenario');
 const csrfHash=await hashToken(await hashToken('dental:csrf:v1:'+'o'.repeat(43)));
 const runtime=createRuntime({assets:{},clientFactory:()=>({on(){},async connect(){},async end(){},async query(sql){if(sql.includes('resolve_session'))return{rows:[{result:{accountId:'11111111-1111-4111-8111-111111111111',csrfHash,expiresAt:'2099-01-01T00:00:00Z',isAdmin:true}}]};if(sql.includes('is_admin'))return{rows:[{result:scenario!=='forbidden'}]};throw new Error('Any write or other SQL forbidden');}})});
 return runtime.fetch(request,{APP_MODE:'production',AUTH_MODE:'line',MESSAGING_MODE:'disabled',APP_ORIGIN:'https://synthetic.example',LINE_CHANNEL_ID:'123456',LINE_PROVIDER_ID:'synthetic',DENTAL_DB:{connectionString:'synthetic'},LINE_BOT_INFO_ENABLED:scenario==='disabled'?undefined:'true',LINE_MESSAGING_ACCESS_TOKEN:scenario==='missing-token'?undefined:'synthetic-only',LINE_MESSAGING_BASIC_ID:'@example-clinic'});
}};`);
let worker,calls=0,checks=0,status=200,wrong=false;
try{
 await build({entryPoints:[join(temporary,'entry.ts')],outfile:join(temporary,'entry.js'),bundle:true,format:'esm',platform:'browser',external:['node:*'],target:'es2022',logLevel:'silent',plugins:[{name:'deny-live-pg',setup(build){build.onResolve({filter:/^pg$/},()=>({path:'pg',namespace:'deny-live-pg'}));build.onLoad({filter:/.*/,namespace:'deny-live-pg'},()=>({contents:'export class Client { constructor(){ throw new Error("Live DB forbidden"); } }',loader:'js'}));}}]});
 const options=convertV4MiniflareOptions({name:'synthetic-bot-info-runtime',modules:true,scriptPath:join(temporary,'entry.js'),compatibilityDate:'2026-10-07',compatibilityFlags:['nodejs_compat'],cf:false,log:new Log(LogLevel.ERROR),outboundService:async request=>{
  calls++;assert.equal(request.url,'https://api.line.me/v2/bot/info');assert.equal(request.method,'GET');assert.equal(request.headers.get('authorization'),'Bearer synthetic-only');assert.equal(await request.text(),'');
  return new globalThis.Response(JSON.stringify({userId:'U'+'a'.repeat(32),basicId:wrong?'@wrong':'@example-clinic',displayName:'PRIVATE_UNUSED'}),{status,headers:status===302?{Location:'https://never-follow.invalid/'}:{}});
 }});
 worker=new Miniflare({...options,telemetry:{enabled:false}});await worker.ready;
 for(const [scenario,expected] of [['unauthenticated',401],['forbidden',403],['disabled',503],['missing-token',503],['valid',200]]){calls=0;const headers={'X-Synthetic-Scenario':scenario,...(scenario==='unauthenticated'?{}:{Cookie:'__Host-dental_session='+'o'.repeat(43)})};const r=await worker.dispatchFetch('https://synthetic.example/api/admin/line/bot-info',{headers});assert.equal(r.status,expected);assert.equal(calls,expected===200?1:0);const body=await r.json();if(expected===200)assert.deepEqual(body,{botUserId:'U'+'a'.repeat(32),basicId:'@example-clinic'});checks++;}
 for(const mode of ['redirect','wrong-bot']){status=mode==='redirect'?302:200;wrong=mode==='wrong-bot';calls=0;const r=await worker.dispatchFetch('https://synthetic.example/api/admin/line/bot-info',{headers:{Cookie:'__Host-dental_session='+'o'.repeat(43)}});assert.equal(r.status,503);assert.equal(calls,1);assert(!JSON.stringify(await r.json()).includes('PRIVATE'));checks++;}
 const report={passed:true,checks,runtime:'actual local workerd',realProviderRequests:0,realDatabaseConnections:0,syntheticSqlPort:true,providerOperations:'fixed GET bot/info only; all intercepted',writes:0,sends:0};await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{if(worker)await worker.dispose();await rm(temporary,{recursive:true,force:true});}
