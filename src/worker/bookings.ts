import {z} from 'zod';
import type {ApiError,ErrorCode,Session} from '../shared/contracts';
import {parseBooking} from '../shared/validation';
import {DatabaseError,type Database} from './db';
import {readJson} from './http';

const errorStatus:Record<ErrorCode,number>={
  VALIDATION:400,UNAUTHENTICATED:401,FORBIDDEN:403,NOT_FOUND:404,
  FULL:409,INELIGIBLE_DATE:409,INTAKE_CLOSED:409,DUPLICATE:409,
  VERSION_CONFLICT:409,IDEMPOTENCY_CONFLICT:409,INVALID_TRANSITION:409,
  CUTOFF_PASSED:409,UNRESOLVED_BOOKINGS:409,RATE_LIMITED:429,UNAVAILABLE:503,
};

function json(value:unknown,status=200):Response{
  return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
}

function exactQuery(url:URL,keys:string[]):void{
  if([...url.searchParams.keys()].some(key=>!keys.includes(key))||keys.some(key=>url.searchParams.getAll(key).length!==1)){
    throw new DatabaseError('VALIDATION');
  }
}

function uuid(value:unknown):string{
  const parsed=z.uuid().safeParse(value);
  if(!parsed.success)throw new DatabaseError('VALIDATION');
  return parsed.data;
}

/**
 * Composable Task 4 routes, not a standalone authentication boundary.
 * The Task 5 application must resolve a verified session and enforce Origin/CSRF
 * for mutations before calling this handler. No identity comes from the request.
 */
export async function handleBookingRequest(request:Request,session:Session|null,db:Database):Promise<Response|null>{
  const url=new URL(request.url);
  const availability=request.method==='GET'&&url.pathname==='/api/availability';
  const reserve=request.method==='POST'&&url.pathname==='/api/appointments';
  const list=request.method==='GET'&&url.pathname==='/api/appointments';
  const cancel=request.method==='POST'?/^\/api\/appointments\/([^/]+)\/cancel$/.exec(url.pathname):null;
  const lookup=request.method==='GET'?/^\/api\/(appointments|submissions)\/([^/]+)$/.exec(url.pathname):null;
  if(!availability&&!reserve&&!list&&!lookup&&!cancel)return null;

  try{
    if(availability){
      exactQuery(url,['from','to']);
      const days=await db.availability(url.searchParams.get('from')!,url.searchParams.get('to')!);
      // Public availability deliberately excludes counts and any private fields.
      return json(days.map(({date,state})=>({date,state})));
    }
    if(!session)throw new DatabaseError('UNAUTHENTICATED');
    exactQuery(url,[]);
    const actor=session.accountId;
    if(cancel){
      const id=uuid(cancel[1]);
      const parsed=z.object({version:z.number().int().min(1).max(2147483647)}).strict().safeParse(await readJson(request));
      if(!parsed.success)throw new DatabaseError('VALIDATION');
      return json(await db.cancel(actor,id,parsed.data.version));
    }
    if(reserve){
      const key=uuid(request.headers.get('Idempotency-Key'));
      let input;
      try{input=parseBooking(await readJson(request));}catch{throw new DatabaseError('VALIDATION');}
      // A replay returns the same successful representation; SQL owns atomicity.
      return json(await db.reserve(actor,key,input));
    }
    if(list)return json(await db.listAppointments(actor));
    const id=uuid(lookup![2]);
    return json(lookup![1]==='submissions'?await db.submission(actor,id):await db.getAppointment(actor,id));
  }catch(error){
    const code=error instanceof DatabaseError?error.code:'UNAVAILABLE';
    const body:ApiError={error:{code,correlationId:crypto.randomUUID()}};
    return json(body,errorStatus[code]);
  }
}
