import {z} from 'zod';
import type {Session} from '../shared/contracts';
import {parsePatient} from '../shared/validation';
import {DatabaseError,type Database} from './db';
import {json,readJson} from './http';

/** Called only after the composed application has verified the session and CSRF. */
export async function handlePatientRequest(request:Request,session:Session,db:Database):Promise<Response|null>{
 const url=new URL(request.url);
 const collection=url.pathname==='/api/patients';
 const update=request.method==='PATCH'?/^\/api\/patients\/([^/]+)$/.exec(url.pathname):null;
 if(!(collection&&['GET','POST'].includes(request.method))&&!update)return null;
 if(url.search)throw new DatabaseError('VALIDATION');
 if(collection&&request.method==='GET')return json(await db.listPatients(session.accountId));
 let input;
 let version:number|undefined;
 let id:string|undefined;
 const body=await readJson(request);
 try{
  if(update){
   id=z.uuid().parse(update[1]);
   const envelope=z.object({version:z.number().int().min(1).max(2147483647)}).passthrough().parse(body);
   const{version:requestedVersion,...fields}=envelope;
   version=requestedVersion;
   input=parsePatient(fields);
  }else input=parsePatient(body);
 }catch{throw new DatabaseError('VALIDATION');}
 return update?json(await db.updatePatient(session.accountId,id!,version!,input)):json(await db.createPatient(session.accountId,input),201);
}
