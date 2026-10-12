import {z} from 'zod';
import {DatabaseError} from '../db';
import {json} from '../http';
export type BotInfoOptions={enabled?:boolean;token?:string;expectedBasicId?:string;fetcher?:typeof fetch};
const basicId=z.string().regex(/^@[A-Za-z0-9_.-]{1,100}$/);
const identity=z.object({userId:z.string().regex(/^U[0-9a-f]{32}$/),basicId});
/** Read-only setup diagnostic. Caller must resolve session and fresh SQL admin grant.
 * No arbitrary URL, recipient, secret echo, provider body or message operation.
 */
export async function handleBotInfoRequest(request:Request,options:BotInfoOptions={}):Promise<Response|null>{
 const url=new URL(request.url);
 if(url.pathname!=='/api/admin/line/bot-info')return null;
 if(request.method!=='GET')return new Response(null,{status:405,headers:{Allow:'GET','Cache-Control':'no-store'}});
 if(url.search)throw new DatabaseError('VALIDATION');
 if(options.enabled!==true||!options.token?.trim()||!basicId.safeParse(options.expectedBasicId).success)throw new DatabaseError('UNAVAILABLE');
 const controller=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new DatabaseError('UNAVAILABLE'));},5000);});
  const operation=async()=>{
   const response=await(options.fetcher??fetch)('https://api.line.me/v2/bot/info',{method:'GET',redirect:'manual',headers:{Authorization:`Bearer ${options.token}`},signal:controller.signal});
   if(response.status!==200){void response.body?.cancel().catch(()=>{});throw new DatabaseError('UNAVAILABLE');}
   reader=response.body?.getReader();if(!reader)throw new DatabaseError('UNAVAILABLE');
   const chunks:Uint8Array[]=[];let length=0;
   for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>8192)throw new DatabaseError('UNAVAILABLE');chunks.push(value);}
   const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
   const info=identity.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)));
   if(info.basicId!==options.expectedBasicId)throw new DatabaseError('UNAVAILABLE');
   return json({botUserId:info.userId,basicId:info.basicId});
  };
  return await Promise.race([operation(),timeout]);
 }catch{throw new DatabaseError('UNAVAILABLE');}
 finally{clearTimeout(timer);controller.abort();void reader?.cancel().catch(()=>{});}
}
