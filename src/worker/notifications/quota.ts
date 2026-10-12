import {DatabaseError} from '../db';
/** Fixed read-only quota endpoints; bounded headers and body, no provider diagnostics. */
export async function quotaRead(endpoint:'quota'|'quota/consumption',token:string,fetcher:typeof fetch):Promise<unknown>{
 const controller=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;let timer:ReturnType<typeof setTimeout>|undefined;
 try{
  const timeout=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new DatabaseError('UNAVAILABLE'));},5000);});
  const operation=async()=>{
   const r=await fetcher('https://api.line.me/v2/bot/message/'+endpoint,{method:'GET',redirect:'manual',headers:{Authorization:`Bearer ${token}`},signal:controller.signal});
   if(r.status!==200){void r.body?.cancel().catch(()=>{});throw new DatabaseError('UNAVAILABLE');}
   reader=r.body?.getReader();if(!reader)throw new DatabaseError('UNAVAILABLE');
   const chunks:Uint8Array[]=[];let length=0;for(;;){const {value,done}=await reader.read();if(done)break;length+=value.byteLength;if(length>2048)throw new DatabaseError('UNAVAILABLE');chunks.push(value);}
   const bytes=new Uint8Array(length);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
   return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
  };return await Promise.race([operation(),timeout]);
 }catch{throw new DatabaseError('UNAVAILABLE');}finally{clearTimeout(timer);controller.abort();void reader?.cancel().catch(()=>{});}
}
