export async function withTwoClients<T extends{end():Promise<unknown>},R>(create:()=>Promise<T>,work:(clients:[T,T])=>Promise<R>):Promise<R>{
 const clients:T[]=[];let result!:R;let failed=false,failure:unknown;
 try{clients.push(await create());clients.push(await create());result=await work([clients[0],clients[1]]);}
 catch(error){failed=true;failure=error;}
 const cleanup=await Promise.allSettled(clients.map(client=>Promise.resolve().then(()=>client.end())));
 if(failed)throw failure;
 if(cleanup.some(r=>r.status==='rejected'))throw new Error('Database client cleanup failed');
 return result;
}
