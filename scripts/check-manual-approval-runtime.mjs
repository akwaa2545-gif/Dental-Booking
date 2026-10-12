import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
// Final candidate deliberately has no manual legacy sending path. Preserve
// session, current grant, CSRF and rate-limit enforcement before denying it.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');await mkdir(join(root,'artifacts'),{recursive:true});const temp=await mkdtemp(join(root,'artifacts/manual-runtime-')),reportPath=join(root,'artifacts/manual-approval-runtime-check.json');await rm(reportPath,{force:true});
const origin='https://tooth-talk-staging.tooth-talk-staging-f7ff4a96.workers.dev';
await writeFile(join(temp,'entry.ts'),`import {createRuntime} from ${JSON.stringify(join(root,'src/worker/runtime.ts'))};import {hashToken} from ${JSON.stringify(join(root,'src/worker/auth/session.ts'))};
export default {async fetch(request){
 const mode=request.headers.get('X-Test-Mode'),calls=[];let closed=0;const csrf=await hashToken('dental:csrf:v1:'+'o'.repeat(43)),csrfHash=await hashToken(csrf);
 const runtime=createRuntime({assets:{},clientFactory:()=>({on(){},async connect(){},async end(){closed++;},async query(sql){calls.push(sql);if(sql.includes('consume_request_limit'))return{rows:[{result:mode!=='rate-limited'}]};if(sql.includes('resolve_session'))return{rows:[{result:{accountId:'f0000000-0000-4000-8000-000000000001',csrfHash,expiresAt:'2099-01-01T00:00:00Z',isAdmin:true}}]};if(sql.includes('is_admin'))return{rows:[{result:mode!=='revoked-admin'}]};throw Error('Any notification/business SQL forbidden');}})});
 const r=await runtime.fetch(new Request(${JSON.stringify(origin)}+'/api/admin/line/test-approval',{method:'POST',headers:{Origin:${JSON.stringify(origin)},'Content-Type':'application/json',...(mode==='bad-csrf'?{}:{'X-CSRF-Token':csrf}),...(mode==='unauthenticated'?{}:{Cookie:'__Host-dental_session='+'o'.repeat(43)})},body:'{}'}),{APP_MODE:'production',APP_STAGE:'synthetic-staging',AUTH_MODE:'line',MESSAGING_MODE:'disabled',APP_ORIGIN:${JSON.stringify(origin)},LINE_CHANNEL_ID:'123456',LINE_PROVIDER_ID:'synthetic',DENTAL_DB:{connectionString:'synthetic-only'},RATE_LIMIT_KEY_SECRET:'synthetic-rate-limit-key-with-at-least-32-bytes',COMBINED_NOTIFICATIONS_ENABLED:mode==='combined'?'true':undefined,LINE_MANUAL_APPROVAL_ENABLED:mode==='flag-off'?undefined:'true',LINE_MESSAGING_ACCESS_TOKEN:'synthetic-only',LINE_MESSAGING_BASIC_ID:'@clinic',LINE_MESSAGING_DESTINATION:'U'+'a'.repeat(32)});
 r.headers.set('X-Synthetic-Sql',calls.join('|'));r.headers.set('X-Synthetic-Closed',String(closed));return r;
}};`);
let worker,checks=0,outbound=0;
try{
 await build({entryPoints:[join(temp,'entry.ts')],outfile:join(temp,'entry.js'),bundle:true,format:'esm',platform:'browser',external:['node:*'],target:'es2022',logLevel:'silent',plugins:[{name:'deny-live-pg',setup(b){b.onResolve({filter:/^pg$/},()=>({path:'pg',namespace:'deny-live-pg'}));b.onLoad({filter:/.*/,namespace:'deny-live-pg'},()=>({contents:'export class Client { constructor(){ throw new Error("Live DB forbidden"); } }',loader:'js'}));}}]});
 const opts=convertV4MiniflareOptions({name:'synthetic-disabled-manual-approval',modules:true,scriptPath:join(temp,'entry.js'),compatibilityDate:'2026-10-07',compatibilityFlags:['nodejs_compat'],cf:false,log:new Log(LogLevel.ERROR),outboundService:async()=>{outbound++;throw Error('All manual outbound requests forbidden');}});worker=new Miniflare({...opts,telemetry:{enabled:false}});await worker.ready;
 for(const[mode,status]of [['unauthenticated',401],['bad-csrf',403],['rate-limited',429],['revoked-admin',403],['flag-off',503],['legacy-enabled',503],['combined',503]]){
  const r=await worker.dispatchFetch(origin+'/api/admin/line/test-approval',{headers:{'X-Test-Mode':mode}});assert.equal(r.status,status);assert.equal(r.headers.get('Cache-Control'),'no-store');assert.equal(r.headers.get('X-Synthetic-Closed'),'1');const sql=r.headers.get('X-Synthetic-Sql');assert(!/claim_|prepare_|finish_|BEGIN|COMMIT|ROLLBACK/.test(sql));if(!['unauthenticated','bad-csrf'].includes(mode))assert(sql.includes('consume_request_limit'));assert.equal(outbound,0);checks++;
 }
 const report={passed:true,checks,runtime:'actual local workerd',realProviderRequests:0,realDatabaseConnections:0,syntheticSqlPort:true,scope:'manual legacy sending unavailable with combined off/on; live grant/CSRF/rate-limit checks preserved',notificationWrites:0,sends:0};await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{if(worker)await worker.dispose();await rm(temp,{recursive:true,force:true});}
