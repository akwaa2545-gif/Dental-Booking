import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHmac} from 'node:crypto';
import {build} from 'esbuild';
import {Miniflare,Log,LogLevel,convertV4MiniflareOptions} from 'miniflare';
// Actual local workerd and final composition. SQL and every outbound request are
// intercepted; this does not establish PostgreSQL semantics or live readiness.
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await mkdir(join(root,'artifacts'),{recursive:true});
const temporary=await mkdtemp(join(root,'artifacts/notification-integration-'));
const reportPath=join(root,'artifacts/notification-integration-check.json');await rm(reportPath,{force:true});
const origin='https://tooth-talk-staging.tooth-talk-staging-f7ff4a96.workers.dev',id='11111111-1111-4111-8111-111111111111',adminId='22222222-2222-4222-8222-222222222222',destination='U'+'b'.repeat(32),recipient='U'+'a'.repeat(32);
await writeFile(join(temporary,'entry.ts'),`import {createRuntime} from ${JSON.stringify(join(root,'src/worker/runtime.ts'))};
import {hashToken} from ${JSON.stringify(join(root,'src/worker/auth/session.ts'))};
const origin=${JSON.stringify(origin)},id=${JSON.stringify(id)},adminId=${JSON.stringify(adminId)};
const settings={APP_MODE:'production',APP_STAGE:'synthetic-staging',AUTH_MODE:'line',MESSAGING_MODE:'disabled',APP_ORIGIN:origin,LINE_CHANNEL_ID:'123456',LINE_PROVIDER_ID:'synthetic',DENTAL_DB:{connectionString:'synthetic-only'},COMBINED_NOTIFICATIONS_ENABLED:'true',NOTIFICATION_READINESS_ENABLED:'true',LINE_MESSAGING_ACCESS_TOKEN:'synthetic-invalid-for-provider',LINE_MESSAGING_BASIC_ID:'@clinic',LINE_MESSAGING_DESTINATION:${JSON.stringify(destination)}};
export default {async fetch(request){
 const calls=[];let connected=0,closed=0;const path=new URL(request.url).pathname,mode=request.headers.get('X-Synthetic-Scenario')??'normal',start=Date.now();
 const event={id,appointmentId:id,appointmentVersion:mode==='cancellation'?3:2,type:mode==='cancellation'?'cancellation':'approval',retryKey:id,dueAt:new Date(start-1000).toISOString(),expiresAt:new Date(start+3600000).toISOString()};
 const delivery={id:adminId,eventId:adminId,appointmentId:id,grantId:adminId,retryKey:adminId,createdAt:event.dueAt,dueAt:event.dueAt,expiresAt:event.expiresAt};
 const patient={event,provider:mode==='wrong-provider'?'line:other':'line:synthetic',recipient:${JSON.stringify(recipient)},date:'2026-10-20',reference:'TT-SYNTHETIC',status:mode==='cancellation'?'cancelled':'approved',manageUrl:origin+'/appointments',payloadVersion:mode==='cancellation'?2:1,preparedAt:new Date(start).toISOString(),authorizationExpiresAt:new Date(start+60000).toISOString()};
 const admin={delivery,provider:'line:synthetic',recipient:${JSON.stringify(recipient)},date:'2026-10-20',reference:'TT-SYNTHETIC',manageUrl:origin+'/admin',payloadVersion:1,preparedAt:new Date(start).toISOString(),authorizationValidUntil:new Date(start+60000).toISOString()};
 const csrfHash=await hashToken(await hashToken('dental:csrf:v1:'+'o'.repeat(43)));
 const runtime=createRuntime({assets:{},clientFactory:()=>({on(){},async connect(){connected++;},async end(){closed++;},async query(sql,values){
  calls.push({sql,values});const result=value=>({rows:[{result:value}]});
  if(sql.includes('resolve_session'))return result({accountId:id,csrfHash,expiresAt:'2099-01-01T00:00:00Z',isAdmin:true});
  if(sql.includes('is_admin'))return result(mode!=='revoked-admin');
  if(path.startsWith('/api/'))throw Error('Readiness business/notification writes forbidden');
  if(sql.includes('claim_patient_event')){if(mode==='patient-fails')throw Error('PRIVATE_SQL');return result(event);}
  if(sql.includes('claim_admin_delivery')){if(mode==='admin-fails')throw Error('PRIVATE_SQL');return result(delivery);}
  if(sql.includes('prepare_patient_dispatch'))return result(mode==='suppressed'?null:patient);
  if(sql.includes('prepare_admin_dispatch'))return result(mode==='suppressed'?null:admin);
  if(sql.includes('clock_timestamp'))return result(Date.now());
  if(sql.includes('revalidate_patient_dispatch'))return result(mode!=='revoked-patient');
  if(sql.includes('revalidate_admin_dispatch'))return result(true);
  if(sql.includes('finish_dispatch')||sql.includes('finish_admin_dispatch'))return result(true);
  throw Error('Legacy or unapproved SQL forbidden');
 }})});
 if(path==='/api/line/webhook')return runtime.fetch(request,{...settings,LINE_WEBHOOK_ENABLED:'true',LINE_MESSAGING_CHANNEL_SECRET:'synthetic-secret'});
 if(path.startsWith('/api/')){const r=await runtime.fetch(request,{...settings,NOTIFICATION_READINESS_ENABLED:mode==='disabled'?undefined:'true'});r.headers.set('X-Synthetic-Sql',calls.map(c=>c.sql).join('|'));return r;}
 const change=path==='/absent'?{COMBINED_NOTIFICATIONS_ENABLED:undefined}:path==='/disabled'?{COMBINED_NOTIFICATIONS_ENABLED:'false'}:path==='/missing-token'?{LINE_MESSAGING_ACCESS_TOKEN:undefined}:path==='/legacy-general'?{COMBINED_NOTIFICATIONS_ENABLED:undefined,MESSAGING_MODE:'line',NOTIFICATION_DISPATCH_ENABLED:'true'}:path==='/legacy-admin'?{COMBINED_NOTIFICATIONS_ENABLED:undefined,ADMIN_BOOKING_NOTIFICATIONS_ENABLED:'true'}:path==='/restricted-conflict'?{NOTIFICATION_TEST_ENABLED:'true'}:path==='/manual-conflict'?{LINE_MANUAL_APPROVAL_ENABLED:'true'}:{};
 await runtime.scheduled({}, {...settings,...change});return Response.json({calls,connected,closed});
}};`);
let worker,checks=0,status=200,upstreamMode='normal',outbound=[];
try{
 await build({entryPoints:[join(temporary,'entry.ts')],outfile:join(temporary,'entry.js'),bundle:true,format:'esm',platform:'browser',external:['node:*'],target:'es2022',logLevel:'silent',plugins:[{name:'deny-live-pg',setup(b){b.onResolve({filter:/^pg$/},()=>({path:'pg',namespace:'deny-live-pg'}));b.onLoad({filter:/.*/,namespace:'deny-live-pg'},()=>({contents:'export class Client { constructor(){ throw new Error("Real DB forbidden"); } }',loader:'js'}));}}]});
 const opts=convertV4MiniflareOptions({name:'synthetic-combined-notification-integration',modules:true,scriptPath:join(temporary,'entry.js'),compatibilityDate:'2026-10-07',compatibilityFlags:['nodejs_compat'],cf:false,log:new Log(LogLevel.ERROR),outboundService:async request=>{
  assert.equal(new URL(request.url).origin,'https://api.line.me');assert.equal(request.headers.get('authorization'),'Bearer synthetic-invalid-for-provider');const path=new URL(request.url).pathname;outbound.push(path);
  if(path==='/v2/bot/info'){assert.equal(request.method,'GET');return upstreamMode==='malformed'?new globalThis.Response('PRIVATE_RAW_PROVIDER'):globalThis.Response.json({userId:upstreamMode==='wrong-destination'?'U'+'c'.repeat(32):destination,basicId:'@clinic',displayName:'PRIVATE_UNUSED'});}
  if(path==='/v2/bot/message/quota'){assert.equal(request.method,'GET');return globalThis.Response.json({type:'limited',value:300});}
  if(path==='/v2/bot/message/quota/consumption'){assert.equal(request.method,'GET');return globalThis.Response.json({totalUsage:17});}
  assert.equal(path,'/v2/bot/message/push');assert.equal(request.method,'POST');assert([id,adminId].includes(request.headers.get('x-line-retry-key')));const body=await request.text();assert.equal(JSON.parse(body).to,recipient);assert(!/PRIVATE|preparedAt|authorization|provider|grantId|appointmentId/.test(body));return new globalThis.Response(null,{status,headers:status===409?{'x-line-accepted-request-id':id}:status===302?{Location:'https://never-follow.invalid/'}:{}});
 }});
 worker=new Miniflare({...opts,telemetry:{enabled:false}});await worker.ready;
 for(const path of ['/absent','/disabled','/missing-token','/legacy-general','/legacy-admin','/restricted-conflict','/manual-conflict']){outbound=[];const result=await(await worker.dispatchFetch(origin+path)).json();assert.deepEqual(result,{calls:[],connected:0,closed:0});assert.deepEqual(outbound,[]);checks++;}
 for(const item of [{status:200,kind:'accepted'},{status:409,kind:'accepted'},{status:429,kind:'permanent'},{status:302,kind:'permanent'},{status:500,kind:'retryable'}]){
  status=item.status;outbound=[];const result=await(await worker.dispatchFetch(origin+'/tick')).json();assert.equal(result.connected,1);assert.equal(result.closed,1);assert.equal(result.calls.filter(c=>c.sql.includes('claim_')).length,2);assert(!result.calls.some(c=>/claim_events|claim_restricted|prepare_dispatch\(/.test(c.sql)));assert.equal(outbound.filter(p=>p.endsWith('/info')).length,2);assert.equal(outbound.filter(p=>p.endsWith('/consumption')).length,2);assert.equal(outbound.filter(p=>p.endsWith('/push')).length,2);const preparations=result.calls.filter(c=>c.sql.includes('prepare_'));assert.equal(preparations.length,2);for(const c of preparations)assert.equal(JSON.parse(c.values[3]).totalUsage,17);const finishes=result.calls.filter(c=>c.sql.includes('finish_'));assert.equal(finishes.length,2);for(const c of finishes)assert.equal(JSON.parse(c.values[2]).kind,item.kind);checks++;
 }
 status=200;
 for(const [scenario,pushes]of [['patient-fails',1],['admin-fails',1],['wrong-provider',1],['revoked-patient',1],['suppressed',0],['cancellation',2]]){outbound=[];const result=await(await worker.dispatchFetch(origin+'/tick',{headers:{'X-Synthetic-Scenario':scenario}})).json();assert.equal(result.calls.filter(c=>c.sql.includes('claim_')).length,2);assert.equal(result.closed,1);assert.equal(outbound.filter(p=>p.endsWith('/push')).length,pushes);checks++;}
 for(const [scenario,expected]of [['unauthenticated',401],['revoked-admin',403],['disabled',503],['normal',200]]){outbound=[];const r=await worker.dispatchFetch(origin+'/api/admin/line/notification-readiness',{headers:{'X-Synthetic-Scenario':scenario,...(scenario==='unauthenticated'?{}:{Cookie:'__Host-dental_session='+'o'.repeat(43)})}});assert.equal(r.status,expected);assert.equal(r.headers.get('Cache-Control'),'no-store');assert(!/claim_|prepare_|finish_|budget|policy|consume_request_limit/.test(r.headers.get('X-Synthetic-Sql')??''));assert.equal(outbound.length,expected===200?3:0);if(expected===200){const body=await r.json();assert.deepEqual({...body,quota:{...body.quota,observedAt:'clock'}},{matched:true,quota:{type:'limited',value:300,totalUsage:17,observedAt:'clock'}});}checks++;}
 for(const mode of ['malformed','wrong-destination']){upstreamMode=mode;outbound=[];const r=await worker.dispatchFetch(origin+'/api/admin/line/notification-readiness',{headers:{Cookie:'__Host-dental_session='+'o'.repeat(43)}});assert.equal(r.status,mode==='malformed'?503:200);const body=await r.text();assert(!/PRIVATE|U[a-f0-9]{32}|@clinic/.test(body));if(mode==='wrong-destination')assert.deepEqual(JSON.parse(body),{matched:false,quota:null});assert.equal(outbound.length,1);checks++;}upstreamMode='normal';
 const body=' {"destination":'+JSON.stringify(destination)+',"events":[]} ',signature=createHmac('sha256','synthetic-secret').update(body).digest('base64');
 for(const content of [body,body.trim()]){outbound=[];const r=await worker.dispatchFetch(origin+'/api/line/webhook',{method:'POST',headers:{'x-line-signature':signature},body:content});assert.equal(r.status,content===body?200:401);assert.equal(outbound.length,0);checks++;}
 const report={passed:true,checks,runtime:'actual local workerd',realProviderRequests:0,realDatabaseConnections:0,realCredentialsUsed:false,syntheticSqlPort:true,scope:'final combined-only composition, independent lanes, per-preparation quota reads, authenticated read-only readiness and webhook; SQL semantics not established'};await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
}finally{if(worker)await worker.dispose();await rm(temporary,{recursive:true,force:true});}
