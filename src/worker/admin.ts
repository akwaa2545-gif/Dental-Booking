import {z} from 'zod';
import type {Session} from '../shared/contracts';
import {isISODate} from '../shared/calendar';
import {DatabaseError,type Database} from './db';
import {json,readJson} from './http';

const reason=z.string().trim().min(1).max(500);
const decisionBody=z.object({version:z.number().int().min(1).max(2147483647),decision:z.enum(['approve','reject','complete','no_show','cancel']),reason}).strict();
const intakeBody=z.object({intake:z.enum(['open','paused','closed']),reason}).strict();
const filters=z.object({date:z.string().refine(isISODate).nullable(),status:z.enum(['pending','approved','rejected','cancelled','completed','no_show']).nullable()}).strict();

/** Composable routes: makeApp verifies session, live admin grant and mutation
 * Origin/CSRF before entry. SQL repeats live authority and locks atomically. */
export async function handleAdminRequest(request:Request,session:Session,db:Database):Promise<Response|null>{
 const url=new URL(request.url);
 const list=request.method==='GET'&&url.pathname==='/api/admin/appointments';
 const decision=request.method==='POST'?/^\/api\/admin\/appointments\/([^/]+)\/decision$/.exec(url.pathname):null;
 const intake=request.method==='PUT'?/^\/api\/admin\/dates\/([^/]+)$/.exec(url.pathname):null;
 if(!list&&!decision&&!intake)return null;

 if(list){
  if([...url.searchParams.keys()].some(key=>!['date','status'].includes(key))||['date','status'].some(key=>url.searchParams.getAll(key).length>1))throw new DatabaseError('VALIDATION');
  const parsed=filters.safeParse({date:url.searchParams.get('date'),status:url.searchParams.get('status')});
  if(!parsed.success)throw new DatabaseError('VALIDATION');
  return json(await db.adminAppointments(session.accountId,parsed.data.date,parsed.data.status));
 }
 if(url.search)throw new DatabaseError('VALIDATION');
 const body=await readJson(request);
 if(decision){
  const id=z.uuid().safeParse(decision[1]);
  const parsed=decisionBody.safeParse(body);
  if(!id.success||!parsed.success)throw new DatabaseError('VALIDATION');
  const {version,decision:action,reason}=parsed.data;
  return json(await db.decide(session.accountId,id.data,version,action,reason));
 }
 const date=intake![1];
 const parsed=intakeBody.safeParse(body);
 if(!isISODate(date)||!parsed.success)throw new DatabaseError('VALIDATION');
 return json(await db.setIntake(session.accountId,date,parsed.data.intake,parsed.data.reason));
}
