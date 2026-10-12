// @vitest-environment node
import {describe,expect,it} from 'vitest';
import {createLineVerifier,exchangeLineCode} from '../../src/worker/auth/line';
import {DatabaseError} from '../../src/worker/db';

const now=()=>new Date('2026-10-07T23:00:00Z');
const claims={iss:'https://access.line.me',aud:'synthetic-channel',sub:'U11111111111111111111111111111111',exp:1791417600,iat:1791414000};
const options={channelId:'synthetic-channel',provider:'synthetic-provider',now};
function responseFetch(value:unknown,status=200){
  const requests:Request[]=[];
  const fetcher:typeof fetch=async(input,init)=>{
    requests.push(new Request(input,init));
    return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
  };
  return {fetcher,requests};
}

describe('LINE ID token verification',()=>{
  it('uses the authoritative verification response and only returns namespaced identity',async()=>{
    const {fetcher,requests}=responseFetch({...claims,provider:'forged-provider',role:'admin',name:'PRIVATE_PROFILE',email:'PRIVATE_EMAIL'});
    const identity=await createLineVerifier({...options,fetch:fetcher}).verify('synthetic.raw.id-token');
    expect(identity).toEqual({provider:'synthetic-provider',subject:'U11111111111111111111111111111111',expiresAt:'2026-10-08T00:00:00.000Z'});
    expect(requests).toHaveLength(1);
    const request=requests[0];
    expect(request.url).toBe('https://api.line.me/oauth2/v2.1/verify');
    expect(request.method).toBe('POST');
    expect(request.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(new URLSearchParams(await request.text()))).toEqual({id_token:'synthetic.raw.id-token',client_id:'synthetic-channel'});
    expect(request.redirect).toBe('manual');
    expect(request.cache).toBe('no-store');
    expect(request.credentials).toBe('omit');
  });

  it('sends and checks the server-held nonce for browser login',async()=>{
    const {fetcher,requests}=responseFetch({...claims,nonce:'synthetic-nonce'});
    await expect(createLineVerifier({...options,fetch:fetcher}).verify('synthetic-token','synthetic-nonce')).resolves.toMatchObject({subject:claims.sub});
    expect(new URLSearchParams(await requests[0].text()).get('nonce')).toBe('synthetic-nonce');
  });

  it.each([
    ['wrong issuer',{iss:'https://evil.example'}],['wrong channel',{aud:'other-channel'}],
    ['array audience',{aud:['synthetic-channel']}],['missing subject',{sub:undefined}],
    ['empty subject',{sub:''}],['whitespace subject',{sub:' '}],['object subject',{sub:{id:claims.sub}}],
    ['expired token',{exp:1791413999}],['expiry boundary',{exp:1791414000}],
    ['string expiry',{exp:'1791417600'}],['fractional expiry',{exp:1791417600.5}],
    ['unrepresentable expiry',{exp:Number.MAX_SAFE_INTEGER}],['missing expiry',{exp:undefined}],
  ])('fails closed for %s',async(_name,patch)=>{
    const {fetcher}=responseFetch({...claims,...patch});
    await expect(createLineVerifier({...options,now:()=>new Date('2026-10-07T23:00:00Z'),fetch:fetcher}).verify('synthetic-token')).rejects.toEqual(new DatabaseError('UNAUTHENTICATED'));
  });

  it.each([undefined,'wrong-nonce'])('rejects a missing or mismatching returned nonce (%s)',async nonce=>{
    const {fetcher}=responseFetch({...claims,nonce});
    await expect(createLineVerifier({...options,fetch:fetcher}).verify('synthetic-token','expected-nonce')).rejects.toEqual(new DatabaseError('UNAUTHENTICATED'));
  });

  it.each([null,[],true])('rejects a non-object verification result',async body=>{
    const {fetcher}=responseFetch(body);
    await expect(createLineVerifier({...options,fetch:fetcher}).verify('synthetic-token')).rejects.toEqual(new DatabaseError('UNAUTHENTICATED'));
  });

  it.each([400,401,403])('rejects a provider-declined token (%s) without exposing its response',async status=>{
    const {fetcher}=responseFetch({error_description:'PRIVATE_TOKEN'},status);
    await expect(createLineVerifier({...options,fetch:fetcher}).verify('forged.jwt.token')).rejects.toEqual(new DatabaseError('UNAUTHENTICATED'));
  });

  it.each([302,429,500,503])('fails closed when the provider is unavailable (%s)',async status=>{
    const {fetcher}=responseFetch({error_description:'PRIVATE_TOKEN'},status);
    await expect(createLineVerifier({...options,fetch:fetcher}).verify('synthetic-token')).rejects.toEqual(new DatabaseError('UNAVAILABLE'));
  });

  it('sanitizes transport failures and never falls back to a decoded token',async()=>{
    const fetcher:typeof fetch=async()=>{throw new Error('PRIVATE_TOKEN_CREDENTIAL');};
    await expect(createLineVerifier({...options,fetch:fetcher}).verify('eyJhbGciOiJub25lIn0.eyJzdWIiOiJhZG1pbiJ9.')).rejects.toEqual(new DatabaseError('UNAVAILABLE'));
  });

  it('sanitizes malformed upstream JSON',async()=>{
    const fetcher:typeof fetch=async()=>new Response('PRIVATE_NON_JSON');
    await expect(createLineVerifier({...options,fetch:fetcher}).verify('synthetic-token')).rejects.toEqual(new DatabaseError('UNAVAILABLE'));
  });

  it('bounds the verification response even without Content-Length',async()=>{
    const {fetcher}=responseFetch({...claims,name:'x'.repeat(100_000)});
    await expect(createLineVerifier({...options,fetch:fetcher}).verify('synthetic-token')).rejects.toEqual(new DatabaseError('UNAVAILABLE'));
  });

  it.each(['',' ', 'x'.repeat(20_000)])('rejects empty or oversized token input before any provider request',async token=>{
    const {fetcher,requests}=responseFetch(claims);
    await expect(createLineVerifier({...options,fetch:fetcher}).verify(token)).rejects.toEqual(new DatabaseError('UNAUTHENTICATED'));
    expect(requests).toHaveLength(0);
  });

  it('does not let an explicitly empty expected nonce disable nonce checks',async()=>{
    const {fetcher,requests}=responseFetch(claims);
    await expect(createLineVerifier({...options,fetch:fetcher}).verify('synthetic-token','')).rejects.toEqual(new DatabaseError('UNAUTHENTICATED'));
    expect(requests).toHaveLength(0);
  });

  it.each([{channelId:''},{provider:''}])('refuses missing server configuration',bad=>{
    expect(()=>createLineVerifier({...options,...bad})).toThrow(new DatabaseError('UNAVAILABLE'));
  });
});

const exchange={channelId:'synthetic-channel',channelSecret:'synthetic-secret',redirectUri:'https://booking.example/api/auth/line/callback',code:'synthetic-code',codeVerifier:'a'.repeat(43)};
describe('LINE authorization-code exchange',()=>{
  it('posts the exact redirect URI and PKCE verifier, returning only the raw ID token',async()=>{
    const {fetcher,requests}=responseFetch({access_token:'PRIVATE_ACCESS_TOKEN',refresh_token:'PRIVATE_REFRESH_TOKEN',id_token:'synthetic-id-token',expires_in:3600,token_type:'Bearer',scope:'openid'});
    expect(await exchangeLineCode({...exchange,fetch:fetcher})).toBe('synthetic-id-token');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe('https://api.line.me/oauth2/v2.1/token');
    expect(requests[0].method).toBe('POST');
    expect(requests[0].redirect).toBe('manual');
    expect(Object.fromEntries(new URLSearchParams(await requests[0].text()))).toEqual({grant_type:'authorization_code',client_id:'synthetic-channel',client_secret:'synthetic-secret',redirect_uri:'https://booking.example/api/auth/line/callback',code:'synthetic-code',code_verifier:'a'.repeat(43)});
  });

  it.each([undefined,'',12])('requires an ID token in the token response',async idToken=>{
    const {fetcher}=responseFetch({access_token:'PRIVATE_ACCESS_TOKEN',id_token:idToken});
    await expect(exchangeLineCode({...exchange,fetch:fetcher})).rejects.toEqual(new DatabaseError('UNAUTHENTICATED'));
  });

  it('rejects a provider-declined PKCE exchange without exposing the code or secret',async()=>{
    const {fetcher}=responseFetch({error:'invalid_grant',error_description:'PRIVATE_CODE'},400);
    await expect(exchangeLineCode({...exchange,fetch:fetcher})).rejects.toEqual(new DatabaseError('UNAUTHENTICATED'));
  });

  it.each(['short','a'.repeat(129),'!'.repeat(43)])('rejects malformed PKCE verifiers before transmission',async codeVerifier=>{
    const {fetcher,requests}=responseFetch({id_token:'synthetic-token'});
    await expect(exchangeLineCode({...exchange,codeVerifier,fetch:fetcher})).rejects.toEqual(new DatabaseError('UNAUTHENTICATED'));
    expect(requests).toHaveLength(0);
  });

  it('returns a sanitized unavailable error on a failed token exchange',async()=>{
    const fetcher:typeof fetch=async()=>{throw new Error('PRIVATE_SECRET');};
    await expect(exchangeLineCode({...exchange,fetch:fetcher})).rejects.toEqual(new DatabaseError('UNAVAILABLE'));
  });
});
