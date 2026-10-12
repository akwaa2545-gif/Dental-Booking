import {enforceRequestLimits,secureResponse} from './security';
import {DatabaseError} from './db';
import {handleAuthRequest} from './auth/routes';
import {handleBookingRequest} from './bookings';
import {handlePatientRequest} from './patients';
import {handleAdminRequest} from './admin';
import {handleAdminManagementRequest} from './admin-management/routes';
import {handleManualApprovalRequest} from './notifications/manual-approval';
import {handleBotInfoRequest} from './notifications/bot-info';
import {handleNotificationReadinessRequest} from './notifications/readiness';
import {handleNotificationWebhook} from './notifications/webhook';
import {errorResponse,json,requireAdmin,requireCsrf,requireSession,requireOrigin,type AppDeps} from './http';
/** Server composition seam; no mock adapter or browser-supplied identity is selected here. */
export function makeApp(deps:AppDeps){
 const origin=new URL(deps.appOrigin);if(origin.protocol!=='https:'||origin.origin!==deps.appOrigin)throw new Error('Authentication requires exact HTTPS app origin');
 async function dispatch(request:Request):Promise<Response>{
  const url=new URL(request.url);if(url.origin!==deps.appOrigin)throw new DatabaseError('FORBIDDEN');
  if(deps.notificationWebhook){const webhook=await handleNotificationWebhook(request,deps.notificationWebhook);if(webhook)return webhook;}
  if(request.method==='POST'&&url.pathname==='/api/auth/liff')requireOrigin(request,deps);
  await enforceRequestLimits(request,null,deps.requestLimits);
  const auth=await handleAuthRequest(request,deps);if(auth)return auth;
  if(request.method==='GET'&&url.pathname==='/api/availability')return (await handleBookingRequest(request,null,deps.db))!;
  const session=await requireSession(request,deps);
  if(!['GET','HEAD','OPTIONS'].includes(request.method)){requireCsrf(request,session,deps);await enforceRequestLimits(request,session,deps.requestLimits);}
  if(url.pathname.startsWith('/api/admin/'))await requireAdmin(session,deps.db);
  return await handleAdminManagementRequest(request,session,deps.adminManagement,deps.appOrigin)??await handleManualApprovalRequest(request,session.accountId,deps.manualApproval)??await handleBotInfoRequest(request,deps.botInfo)??await handleNotificationReadinessRequest(request,deps.notificationReadiness)??await handleAdminRequest(request,session,deps.db)??await handlePatientRequest(request,session,deps.db)??await handleBookingRequest(request,session,deps.db)??json({error:{code:'NOT_FOUND',correlationId:crypto.randomUUID()}},404);
 }
 return{async fetch(request:Request):Promise<Response>{try{return secureResponse(await dispatch(request));}catch(error){return secureResponse(errorResponse(error));}}};
}
