import {enforceRequestLimits} from '../security';
import {z} from 'zod';
import {DatabaseError} from '../db';
import {AuthUnavailableError,cookie,json,OAUTH_COOKIE,SESSION_COOKIE,readJson,requireCsrf,requireOrigin,requireSession,setCookie,type AppDeps} from '../http';
import {randomToken,hashToken} from './session';
import {exchangeLineCode} from './line';
const returnPaths=new Set(['/','/appointments','/booking','/admin-invitation']);
function exactQuery(url:URL,allowed:string[]){if([...url.searchParams.keys()].some(k=>!allowed.includes(k)||url.searchParams.getAll(k).length!==1))throw new DatabaseError('VALIDATION');}
function authFailure(error:unknown,stage:'A10'|'A11',deps:AppDeps):never{
 if(deps.authDiagnostics==='synthetic-staging'&&(!(error instanceof DatabaseError)||error.code==='UNAVAILABLE'))throw new AuthUnavailableError(stage);
 throw error;
}
async function establish(request:Request,idToken:string,deps:AppDeps,nonce?:string){
 let identity:Awaited<ReturnType<AppDeps['verifier']['verify']>>;
 try{identity=await deps.verifier.verify(idToken,nonce);}catch(error){return authFailure(error,'A10',deps);}
 try{
  const prior=cookie(request,SESSION_COOKIE);if(prior)await deps.sessions.revoke(prior);
  return await deps.sessions.create(identity,7200);
 }catch(error){return authFailure(error,'A11',deps);}
}
export async function handleAuthRequest(request:Request,deps:AppDeps):Promise<Response|null>{
 const url=new URL(request.url);const path=url.pathname;
 if(request.method==='GET'&&path==='/api/session'){exactQuery(url,[]);return json(await requireSession(request,deps));}
 if(request.method==='POST'&&path==='/api/auth/liff'){
  exactQuery(url,[]);requireOrigin(request,deps);const parsed=z.object({idToken:z.string().min(1).max(12000)}).strict().safeParse(await readJson(request));if(!parsed.success)throw new DatabaseError('VALIDATION');
  const result=await establish(request,parsed.data.idToken,deps);const response=json(result.session);response.headers.set('Set-Cookie',setCookie(SESSION_COOKIE,result.token,Math.max(0,Math.floor((Date.parse(result.session.expiresAt)-deps.now().getTime())/1000))));return response;
 }
 if(request.method==='POST'&&path==='/api/logout'){exactQuery(url,[]);const session=await requireSession(request,deps);requireCsrf(request,session,deps);await enforceRequestLimits(request,session,deps.requestLimits);const parsed=z.object({}).strict().safeParse(await readJson(request));if(!parsed.success)throw new DatabaseError('VALIDATION');await deps.sessions.revoke(cookie(request,SESSION_COOKIE)!);const response=json(null,204);response.headers.set('Set-Cookie',setCookie(SESSION_COOKIE,'',0));return response;}
 if(request.method==='GET'&&path==='/api/auth/line/start'){
  if(!deps.line.channelSecret)throw new DatabaseError('UNAVAILABLE');
  exactQuery(url,['returnTo']);const returnPath=url.searchParams.get('returnTo')??'/appointments';if(!returnPaths.has(returnPath))throw new DatabaseError('VALIDATION');
  const state=randomToken(),binding=randomToken(),nonce=randomToken(),codeVerifier=randomToken();
  await deps.oauth.save({stateHash:await hashToken(state),bindingHash:await hashToken(binding),nonce,codeVerifier,returnPath,expiresAt:new Date(deps.now().getTime()+600000).toISOString()});
  const auth=new URL('https://access.line.me/oauth2/v2.1/authorize');const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(codeVerifier));const challenge=btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  auth.search=new URLSearchParams({response_type:'code',client_id:deps.line.channelId,redirect_uri:deps.appOrigin+'/api/auth/line/callback',scope:'openid',state,nonce,code_challenge:challenge,code_challenge_method:'S256'}).toString();
  return new Response(null,{status:302,headers:{Location:auth.href,'Set-Cookie':setCookie(OAUTH_COOKIE,binding,600),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});
 }
 if(request.method==='GET'&&path==='/api/auth/line/callback'){
  if(!deps.line.channelSecret)throw new DatabaseError('UNAVAILABLE');
  exactQuery(url,['state','code','error','error_description']);const state=url.searchParams.get('state'),binding=cookie(request,OAUTH_COOKIE);if(!state||!/^[A-Za-z0-9_-]{43}$/.test(state)||!binding)throw new DatabaseError('UNAUTHENTICATED');
  const pending=await deps.oauth.consume(await hashToken(state),await hashToken(binding));if(!pending||!Number.isFinite(Date.parse(pending.expiresAt))||Date.parse(pending.expiresAt)<=deps.now().getTime()||!returnPaths.has(pending.returnPath))throw new DatabaseError('UNAUTHENTICATED');
  const code=url.searchParams.get('code');if(url.searchParams.has('error')||!code||code.length>2048)throw new DatabaseError('UNAUTHENTICATED');
  const idToken=await(deps.exchangeCode??exchangeLineCode)({channelId:deps.line.channelId,channelSecret:deps.line.channelSecret,redirectUri:deps.appOrigin+'/api/auth/line/callback',code,codeVerifier:pending.codeVerifier});
  const result=await establish(request,idToken,deps,pending.nonce);const response=new Response(null,{status:303,headers:{Location:pending.returnPath,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'}});response.headers.append('Set-Cookie',setCookie(SESSION_COOKIE,result.token,Math.max(0,Math.floor((Date.parse(result.session.expiresAt)-deps.now().getTime())/1000))));response.headers.append('Set-Cookie',setCookie(OAUTH_COOKIE,'',0));return response;
 }
 return null;
}
