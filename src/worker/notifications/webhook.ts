import {z} from 'zod';
import {verifyLineWebhook} from '../auth/webhook';
import {DatabaseError} from '../db';
import {errorResponse,json} from '../http';

export interface NotificationWebhookDeps {
  channelSecret:string;
  destination:string;
  provider:string;
  db:{recordReachability(provider:string,subject:string,eventId:string,eventAt:string,reachable:boolean):Promise<void>};
}

const lineUserId=z.string().regex(/^U[0-9a-f]{32}$/);
const envelopeSchema=z.object({destination:lineUserId,events:z.array(z.unknown()).max(100)}).strict();
const eventTypeSchema=z.object({type:z.string().min(1).max(100)}).passthrough();
const reachabilityEventSchema=z.object({
  type:z.enum(['follow','unfollow']),
  source:z.object({type:z.literal('user'),userId:lineUserId}).strict(),
  timestamp:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  // LINE defines webhookEventId as a ULID; retain it verbatim for durable replay checks.
  webhookEventId:z.string().regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
  deliveryContext:z.object({isRedelivery:z.boolean()}).strict(),
  mode:z.enum(['active','standby']).optional(),
  replyToken:z.string().min(1).max(2048).optional(),
  follow:z.object({isUnblocked:z.boolean()}).strict().optional(),
}).strict();
// Permit bounded clock skew, never far-future events that could poison ordering.
// Old authenticated events have no age cutoff: SQL rejects stale/replayed events.
const maxFutureSkewMs=5*60*1000;

/**
 * Authentication and schema validation precede every mutation. Only the SQL
 * reachability operation can persist reachability; this route has no account,
 * role, session or message-sending capability. SQL owns replay/order protection.
 * https://developers.line.biz/en/reference/messaging-api/#common-properties
 */
export async function handleNotificationWebhook(request:Request,deps:NotificationWebhookDeps):Promise<Response|null>{
  const url=new URL(request.url);
  if(url.pathname!=='/api/line/webhook'||request.method!=='POST')return null;
  try{
    // Preserve the raw body for HMAC verification; do not parse or inspect it first.
    const payload=await verifyLineWebhook(request,deps.channelSecret);
    if(!lineUserId.safeParse(deps.destination).success||typeof deps.provider!=='string'||
      !/^line:[A-Za-z0-9_-]{1,100}$/.test(deps.provider))throw new DatabaseError('UNAVAILABLE');
    if(url.search)throw new DatabaseError('VALIDATION');
    const envelope=envelopeSchema.safeParse(payload);
    if(!envelope.success)throw new DatabaseError('VALIDATION');
    if(envelope.data.destination!==deps.destination)throw new DatabaseError('UNAUTHENTICATED');
    const receivedAt=Date.now();
    const events: z.infer<typeof reachabilityEventSchema>[]=[];
    // Validate the entire batch first, so malformed later events cannot cause
    // earlier writes. Unrelated typed events are ignored without retaining data.
    for(const rawEvent of envelope.data.events){
      const type=eventTypeSchema.safeParse(rawEvent);
      if(!type.success)throw new DatabaseError('VALIDATION');
      if(type.data.type!=='follow'&&type.data.type!=='unfollow')continue;
      const event=reachabilityEventSchema.safeParse(rawEvent);
      if(!event.success||event.data.timestamp>receivedAt+maxFutureSkewMs)throw new DatabaseError('VALIDATION');
      events.push(event.data);
    }
    try{
      for(const event of events){
        await deps.db.recordReachability(deps.provider,event.source.userId,event.webhookEventId,
          new Date(event.timestamp).toISOString(),event.type==='follow');
      }
    }catch{
      // Return non-2xx so LINE can retry. Previously recorded events are SQL-idempotent.
      throw new DatabaseError('UNAVAILABLE');
    }
    return json({received:true});
  }catch(error){return errorResponse(error);}
}
