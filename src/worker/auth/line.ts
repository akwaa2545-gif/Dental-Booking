import {DatabaseError} from '../db';

export type LineIdentity={provider:string;subject:string;expiresAt:string};
export interface LineIdentityVerifier {
  verify(idToken:string,expectedNonce?:string):Promise<LineIdentity>;
}
type LineVerifierOptions={channelId:string;provider:string;now:()=>Date;fetch?:typeof fetch};
type LineCodeOptions={channelId:string;channelSecret:string;redirectUri:string;code:string;codeVerifier:string;fetch?:typeof fetch};

const maxTokenLength=16_384;
const maxResponseBytes=65_536;

function nonempty(value:unknown,max:number):value is string{
  return typeof value==='string'&&value.length<=max&&value.trim().length>0;
}
function object(value:unknown):value is Record<string,unknown>{
  return value!==null&&typeof value==='object'&&!Array.isArray(value);
}

/** Read a bounded provider response; never retain or propagate raw error bodies. */
async function providerJson(response:Response):Promise<unknown>{
  if(!response.body)throw new DatabaseError('UNAVAILABLE');
  const reader=response.body.getReader();
  const chunks:Uint8Array[]=[];
  let length=0;
  try{
    for(;;){
      const {done,value}=await reader.read();
      if(done)break;
      length+=value.byteLength;
      if(length>maxResponseBytes){
        await reader.cancel();
        throw new DatabaseError('UNAVAILABLE');
      }
      chunks.push(value);
    }
  }finally{reader.releaseLock();}
  const bytes=new Uint8Array(length);
  let offset=0;
  for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as unknown;
}

async function postLine(endpoint:'verify'|'token',body:URLSearchParams,fetcher:typeof fetch):Promise<unknown>{
  try{
    const response=await fetcher(`https://api.line.me/oauth2/v2.1/${endpoint}`,{
      method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body,
      // Workerd does not implement redirect:error. Manual mode plus the exact
      // 200-status check below rejects redirects without forwarding tokens/secrets.
      redirect:'manual',cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(10_000),
    });
    if(response.status!==200){
      throw new DatabaseError([400,401,403].includes(response.status)?'UNAUTHENTICATED':'UNAVAILABLE');
    }
    return await providerJson(response);
  }catch(error){
    if(error instanceof DatabaseError&&(error.code==='UNAUTHENTICATED'||error.code==='UNAVAILABLE'))throw error;
    throw new DatabaseError('UNAVAILABLE');
  }
}

/** LINE's verification endpoint verifies the signature; decoded client claims are never used.
 * https://developers.line.biz/en/reference/line-login/#verify-id-token
 */
export function createLineVerifier(options:LineVerifierOptions):LineIdentityVerifier{
  if(!nonempty(options.channelId,255)||!nonempty(options.provider,255))throw new DatabaseError('UNAVAILABLE');
  const {channelId,provider,now}=options;
  return {
    async verify(idToken,expectedNonce){
      if(!nonempty(idToken,maxTokenLength)||(expectedNonce!==undefined&&!nonempty(expectedNonce,255))){
        throw new DatabaseError('UNAUTHENTICATED');
      }
      const body=new URLSearchParams({id_token:idToken,client_id:channelId});
      if(expectedNonce!==undefined)body.set('nonce',expectedNonce);
      const claims=await postLine('verify',body,options.fetch??fetch);
      let time:number;
      try{time=now().getTime();}catch{throw new DatabaseError('UNAVAILABLE');}
      if(!Number.isFinite(time))throw new DatabaseError('UNAVAILABLE');
      if(!object(claims)||claims.iss!=='https://access.line.me'||claims.aud!==channelId||
        !nonempty(claims.sub,255)||typeof claims.exp!=='number'||!Number.isSafeInteger(claims.exp)||
        claims.exp*1000<=time||!Number.isFinite(new Date(claims.exp*1000).getTime())||
        (expectedNonce!==undefined&&claims.nonce!==expectedNonce)){
        throw new DatabaseError('UNAUTHENTICATED');
      }
      // The provider namespace is trusted configuration, never a token/profile claim.
      return {provider,subject:claims.sub,expiresAt:new Date(claims.exp*1000).toISOString()};
    },
  };
}

/** Returns an unverified raw ID token: the caller must verify it with the stored nonce.
 * https://developers.line.biz/en/reference/line-login/#issue-access-token
 */
export async function exchangeLineCode(options:LineCodeOptions):Promise<string>{
  if(!nonempty(options.channelId,255)||!nonempty(options.channelSecret,1024)||!nonempty(options.redirectUri,2048)){
    throw new DatabaseError('UNAVAILABLE');
  }
  if(!nonempty(options.code,4096)||!/^[-A-Za-z0-9._~]{43,128}$/.test(options.codeVerifier)){
    throw new DatabaseError('UNAUTHENTICATED');
  }
  const body=new URLSearchParams({
    grant_type:'authorization_code',client_id:options.channelId,client_secret:options.channelSecret,
    redirect_uri:options.redirectUri,code:options.code,code_verifier:options.codeVerifier,
  });
  const result=await postLine('token',body,options.fetch??fetch);
  if(!object(result)||!nonempty(result.id_token,maxTokenLength))throw new DatabaseError('UNAUTHENTICATED');
  return result.id_token;
}
