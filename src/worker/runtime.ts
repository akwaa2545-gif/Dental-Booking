import {createRequestLimitStore,secureResponse as secure} from './security';
import {Client} from 'pg';
import {readLiffConfig,readAuthConfig} from './config';
import {createDatabase,DatabaseError,type Database,type QueryPort} from './db';
import {createAdminManagementStore} from './admin-management/db';
import {createSessionStore} from './auth/session';
import {createOAuthStore} from './auth/oauth-store';
import {createLineVerifier} from './auth/line';
import {errorResponse} from './http';
import {makeApp} from './index';
import {dispatchCombinedPatient,runCombinedNotificationTick} from './notifications/combined';
import {createCombinedPatientDatabase} from './notifications/combined-db';
import {createLineTransport} from './notifications/line';
import {handleNotificationWebhook} from './notifications/webhook';
import {createAdminNotificationDatabase} from './admin-notifications/db';
import {runAdminNotificationTick} from './admin-notifications/scheduled';
import {readAdminQuota} from './admin-notifications/quota';
import {ADMIN_MANAGE_ORIGIN} from './admin-notifications/payload';

export type StaticAssets = Readonly<Record<string,{readonly body:string;readonly contentType:string}>>;
/** Capability port kept optional so an unbound deployment is closed, never mocked. */
export type RuntimeEnv = {
 APP_MODE?:string; APP_STAGE?:string; AUTH_MODE?:string; MESSAGING_MODE?:string; APP_ORIGIN?:string;
 RATE_LIMIT_KEY_SECRET?:string;
 LINE_CHANNEL_ID?:string; LINE_PROVIDER_ID?:string; LINE_CHANNEL_SECRET?:string;
 LINE_WEBHOOK_ENABLED?:string; LINE_MESSAGING_CHANNEL_SECRET?:string; LINE_MESSAGING_DESTINATION?:string;
 LINE_MANUAL_APPROVAL_ENABLED?:string;
 LINE_BOT_INFO_ENABLED?:string; LINE_MESSAGING_BASIC_ID?:string;
 NOTIFICATION_TEST_ENABLED?:string; NOTIFICATION_TEST_EVENT_ID?:string; NOTIFICATION_TEST_OWNER_ID?:string; NOTIFICATION_TEST_FREE_MESSAGE_LIMIT?:string;
 COMBINED_NOTIFICATIONS_ENABLED?:string; NOTIFICATION_READINESS_ENABLED?:string;
 ADMIN_BOOKING_NOTIFICATIONS_ENABLED?:string;
 NOTIFICATION_DISPATCH_ENABLED?:string; LINE_MESSAGING_ACCESS_TOKEN?:string;
 DENTAL_DB?:{connectionString:string};
};
/** Minimal Worker execution context; absence leaves cron as the recovery path. */
export type RuntimeExecutionContext = {waitUntil(promise:Promise<unknown>):void};
export interface RequestClient extends QueryPort {connect():Promise<unknown>;end():Promise<unknown>;on(event:'error',listener:(error:Error)=>void):unknown}
function assetResponse(request:Request,assets:StaticAssets){
 const path=new URL(request.url).pathname;
 if(!['GET','HEAD'].includes(request.method))return new Response(null,{status:405,headers:{Allow:'GET, HEAD','Cache-Control':'no-store'}});
 const asset=Object.hasOwn(assets,path)?assets[path]:(['/','/booking','/appointments','/admin','/contact','/admin-invitation','/admin/administrators'].includes(path)||/^\/appointments\/[0-9a-f-]{36}$/i.test(path))?assets['/index.html']:undefined;
 if(!asset)return new Response(null,{status:404,headers:{'Cache-Control':'no-store'}});
 return new Response(request.method==='HEAD'?null:asset.body,{headers:{'Content-Type':asset.contentType,'Cache-Control':path.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-store'}});
}
export function createRuntime(options:{assets:StaticAssets;clientFactory?:(connectionString:string)=>RequestClient;fetch?:typeof fetch;now?:()=>Date}){
 async function runNotifications(env:RuntimeEnv,lane?:'patient'|'admin'):Promise<void>{
  // Candidate 013 revokes legacy general/restricted entry points. There is one
  // activation path; unsupported old flags never select another sending lane.
  if(env.COMBINED_NOTIFICATIONS_ENABLED!=='true'||env.APP_STAGE!=='synthetic-staging'||env.MESSAGING_MODE!=='disabled'||env.APP_ORIGIN!==ADMIN_MANAGE_ORIGIN||[env.NOTIFICATION_DISPATCH_ENABLED,env.ADMIN_BOOKING_NOTIFICATIONS_ENABLED,env.NOTIFICATION_TEST_ENABLED,env.LINE_MANUAL_APPROVAL_ENABLED].includes('true')||!env.LINE_MESSAGING_ACCESS_TOKEN?.trim()||!/^@[A-Za-z0-9._-]{1,100}$/.test(env.LINE_MESSAGING_BASIC_ID??'')||!/^U[0-9a-f]{32}$/.test(env.LINE_MESSAGING_DESTINATION??''))return;
  let client:RequestClient|undefined;
  try{
   if(env.APP_MODE!=='production'||!env.DENTAL_DB?.connectionString)throw new DatabaseError('UNAVAILABLE');
   const config=readLiffConfig(env);
   client=(options.clientFactory??(connectionString=>new Client({connectionString,connectionTimeoutMillis:5000,query_timeout:10000,statement_timeout:10000})))(env.DENTAL_DB.connectionString);
   let databaseFailed=false;
   client.on('error',()=>{databaseFailed=true;});
   await client.connect();
   if(databaseFailed)throw new DatabaseError('UNAVAILABLE');
   const connectedClient=client;
   const port:QueryPort={query(text,values){if(databaseFailed)return Promise.reject(new DatabaseError('UNAVAILABLE'));return connectedClient.query(text,values);}};
   const transport=createLineTransport({enabled:true,token:env.LINE_MESSAGING_ACCESS_TOKEN,fetcher:options.fetch});
   // Each sender reads a fresh verified observation only after its own claim,
   // immediately before preparation. Never cache one quota snapshot per tick.
   const quotaReader=()=>readAdminQuota({token:env.LINE_MESSAGING_ACCESS_TOKEN!,expectedBasicId:env.LINE_MESSAGING_BASIC_ID!,destination:env.LINE_MESSAGING_DESTINATION!,fetcher:options.fetch});
   const patientTick=()=>dispatchCombinedPatient({db:createCombinedPatientDatabase(port),transport,manageOrigin:config.appOrigin,expectedProvider:config.provider,workerId:crypto.randomUUID(),quotaReader});
   const adminTick=()=>runAdminNotificationTick({enabled:true,db:createAdminNotificationDatabase(port),transport,manageOrigin:config.appOrigin,expectedProvider:config.provider,workerId:crypto.randomUUID(),quotaReader});
   if(lane==='patient')await patientTick();
   else if(lane==='admin')await adminTick();
   else await runCombinedNotificationTick({enabled:true,patientTick,adminTick});
  }catch{throw new DatabaseError('UNAVAILABLE');}
  finally{if(client){try{await client.end();}catch{/* Cleanup never replays an accepted send. */}}}
 }
 function nudge(env:RuntimeEnv,context:RuntimeExecutionContext|undefined,lane:'patient'|'admin'):void{
  try{
   if(typeof context?.waitUntil!=='function')return;
   // Only a registered task may start. Registration failure cannot launch an
   // orphaned send or change the already committed business response.
   let registered=false;
   const task=Promise.resolve().then(async()=>{if(registered)await runNotifications(env,lane);}).catch(()=>{});
   context.waitUntil(task);
   registered=true;
  }catch{/* Cron remains the fallback; never retry a committed mutation here. */}
 }
 return {async fetch(request:Request,env:RuntimeEnv,context?:RuntimeExecutionContext):Promise<Response>{
  const path=new URL(request.url).pathname;
  if(path!=='/api'&&!path.startsWith('/api/'))return secure(assetResponse(request,options.assets));
  let client:RequestClient|undefined;
  try{
   // No production mock mode, implicit environment, global session store or DB fallback.
   if(env.APP_MODE!=='production'||!['disabled','line'].includes(env.MESSAGING_MODE??'')||!env.DENTAL_DB?.connectionString)throw new DatabaseError('UNAVAILABLE');
   const config=readLiffConfig(env);
   if(new URL(request.url).origin!==config.appOrigin)throw new DatabaseError('FORBIDDEN');
   const webhookPath=path==='/api/line/webhook';
   if(webhookPath&&(env.LINE_WEBHOOK_ENABLED!=='true'||!env.LINE_MESSAGING_CHANNEL_SECRET?.trim()||!/^U[0-9a-f]{32}$/.test(env.LINE_MESSAGING_DESTINATION??'')))throw new DatabaseError('UNAVAILABLE');
   if(webhookPath&&request.method!=='POST')return secure(new Response(null,{status:405,headers:{Allow:'POST','Cache-Control':'no-store'}}));
   if(webhookPath){
    // Defer PostgreSQL until the entire raw-body-authenticated batch is validated.
    let webhookDb:ReturnType<typeof createDatabase>|undefined;
    const db={async recordReachability(provider:string,subject:string,eventId:string,eventAt:string,reachable:boolean){
     if(!webhookDb){
      client=(options.clientFactory??(connectionString=>new Client({connectionString,connectionTimeoutMillis:5000,query_timeout:10000,statement_timeout:10000})))(env.DENTAL_DB!.connectionString);
      let failed=false;client.on('error',()=>{failed=true;});
      await client.connect();if(failed)throw new DatabaseError('UNAVAILABLE');
      const connected=client;
      webhookDb=createDatabase({query(text,values){if(failed)return Promise.reject(new DatabaseError('UNAVAILABLE'));return connected.query(text,values);}});
     }
     await webhookDb.recordReachability(provider,subject,eventId,eventAt,reachable);
    }};
    return secure((await handleNotificationWebhook(request,{db,channelSecret:env.LINE_MESSAGING_CHANNEL_SECRET!,destination:env.LINE_MESSAGING_DESTINATION!,provider:config.provider}))!);
   }
   const line=env.LINE_CHANNEL_SECRET?readAuthConfig(env):config;
   client=(options.clientFactory??(connectionString=>new Client({connectionString,connectionTimeoutMillis:5000,query_timeout:10000,statement_timeout:10000})))(env.DENTAL_DB.connectionString);
   // pg emits socket errors independently of query promises; never leave them uncaught.
   let databaseFailed=false;
   client.on('error',()=>{databaseFailed=true;});
   await client.connect();
   if(databaseFailed)throw new DatabaseError('UNAVAILABLE');
   const connectedClient=client;
   const port:QueryPort={query(text,values){
    if(databaseFailed)return Promise.reject(new DatabaseError('UNAVAILABLE'));
    return connectedClient.query(text,values);
   }};
   const now=options.now??(()=>new Date());
   const database=createDatabase(port);
   // The SQL operation has committed before it resolves. Each best-effort
   // nudge opens its own client and claims the lane's oldest eligible work.
   const db:Database={...database,
    async reserve(...args){const result=await database.reserve(...args);nudge(env,context,'admin');return result;},
    async decide(...args){const result=await database.decide(...args);if(args[3]==='approve'&&result?.status==='approved')nudge(env,context,'patient');return result;},
   };
   const app=makeApp({adminManagement:createAdminManagementStore(port),requestLimits:{store:createRequestLimitStore(port),keySecret:env.RATE_LIMIT_KEY_SECRET},notificationReadiness:{enabled:env.NOTIFICATION_READINESS_ENABLED==='true'&&env.APP_STAGE==='synthetic-staging'&&env.MESSAGING_MODE==='disabled'&&config.appOrigin===ADMIN_MANAGE_ORIGIN,token:env.LINE_MESSAGING_ACCESS_TOKEN,expectedBasicId:env.LINE_MESSAGING_BASIC_ID,destination:env.LINE_MESSAGING_DESTINATION,fetcher:options.fetch},botInfo:{enabled:env.LINE_BOT_INFO_ENABLED==='true',token:env.LINE_MESSAGING_ACCESS_TOKEN,expectedBasicId:env.LINE_MESSAGING_BASIC_ID,fetcher:options.fetch},db,sessions:createSessionStore(port,now),oauth:createOAuthStore(port),line,verifier:createLineVerifier({...config,now,fetch:options.fetch}),appOrigin:config.appOrigin,now,authDiagnostics:env.APP_STAGE==='synthetic-staging'?'synthetic-staging':undefined});
   return secure(await app.fetch(request));
  }catch(error){return secure(errorResponse(error));}
  finally{if(client){try{await client.end();}catch{/* Never retry a possibly committed operation because cleanup failed. */}}}
 },scheduled(_controller:unknown,env:RuntimeEnv):Promise<void>{return runNotifications(env);}};
}
